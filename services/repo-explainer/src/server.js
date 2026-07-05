import express from "express";
import cors from "cors";
import { config, assertApiKey } from "./config.js";
import { explainRepo } from "./explain.js";
import { answerQuestion } from "./rag.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "repo-explainer",
    model: config.model,
    apiKeyConfigured: Boolean(config.apiKey),
  });
});

app.post("/explain", async (req, res) => {
  try {
    assertApiKey();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res
      .status(400)
      .json({ error: "Request body must be a JSON object with the ingestion fields." });
  }

  const includeDiagram =
    req.query.diagram !== "false" && body.include_diagram !== false;

  const started = Date.now();
  try {
    const result = await explainRepo(body, { includeDiagram });
    res.json({
      architecture_summary: result.architecture_summary,
      narration_script: result.narration_script,
      mermaid_diagram: result.mermaid_diagram,
      meta: {
        persona: result.persona,
        model: config.model,
        elapsed_ms: Date.now() - started,
        section_count: result.narration_script.sections.length,
      },
    });
  } catch (err) {
    const status = err.statusCode ?? 502;
    console.error(`[/explain] ${err.message}`);
    res.status(status).json({ error: err.message });
  }
});

// Stretch feature: RAG chat over the ingested key files.
// Body: { ...ingestion, question: string }
app.post("/chat", async (req, res) => {
  try {
    assertApiKey();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res
      .status(400)
      .json({ error: "Request body must be a JSON object with ingestion fields and a 'question'." });
  }

  try {
    const { answer, sources } = await answerQuestion(body, body.question);
    res.json({ answer, sources, meta: { model: config.model } });
  } catch (err) {
    const status = err.statusCode ?? 502;
    console.error(`[/chat] ${err.message}`);
    res.status(status).json({ error: err.message });
  }
});

// Only start listening when run directly (not when imported by tests).
const isMain =
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
  app.listen(config.port, () => {
    console.log(`repo-explainer listening on http://localhost:${config.port}`);
    console.log(`  model:   ${config.model}`);
    console.log(`  baseURL: ${config.baseUrl}`);
    if (!config.apiKey) {
      console.warn("  WARNING: QWEN_API_KEY is not set — /explain will 500 until it is.");
    }
  });
}

export { app };
