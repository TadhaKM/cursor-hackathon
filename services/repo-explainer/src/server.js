import express from "express";
import cors from "cors";
import { config, assertApiKey } from "./config.js";
import { explainRepo } from "./explain.js";
import { explainDiff } from "./diffExplain.js";
import { answerQuestion } from "./rag.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Catch malformed JSON bodies from express.json() and return a clean 400
// instead of letting a SyntaxError bubble up as an HTML stack trace.
app.use((err, _req, res, next) => {
  if (err && (err.type === "entity.parse.failed" || err instanceof SyntaxError)) {
    return res.status(400).json({
      error: "Malformed JSON in request body.",
      kind: "bad_request",
    });
  }
  if (err && err.type === "entity.too.large") {
    return res
      .status(413)
      .json({ error: "Request body too large.", kind: "bad_request" });
  }
  return next(err);
});

// Turns any error into a clean JSON response with a sensible status code.
function sendError(res, route, err) {
  const status = err?.statusCode ?? 502;
  const kind = err?.kind ?? "upstream";
  console.error(`[${route}] (${status}/${kind}) ${err?.message ?? err}`);
  res.status(status).json({ error: err?.message ?? "Unexpected error", kind });
}

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
    return res.status(500).json({ error: err.message, kind: "config" });
  }

  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({
      error: "Request body must be a JSON object with the ingestion fields.",
      kind: "bad_request",
    });
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
    sendError(res, "/explain", err);
  }
});

// Diff mode: narrate what changed between two refs instead of a full repo
// snapshot. Body: repo-ingest's POST /diff response, optionally + persona.
app.post("/explain-diff", async (req, res) => {
  try {
    assertApiKey();
  } catch (err) {
    return res.status(500).json({ error: err.message, kind: "config" });
  }

  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({
      error: "Request body must be a JSON object with the diff fields (files, commits, base_ref, head_ref).",
      kind: "bad_request",
    });
  }

  const started = Date.now();
  try {
    const result = await explainDiff(body, { persona: body.persona });
    res.json({
      narration_script: result.narration_script,
      meta: {
        persona: result.persona,
        model: config.model,
        elapsed_ms: Date.now() - started,
        base_ref: body.base_ref,
        head_ref: body.head_ref,
      },
    });
  } catch (err) {
    sendError(res, "/explain-diff", err);
  }
});

// Stretch feature: RAG chat over the ingested key files.
// Body: { ...ingestion, question: string }
app.post("/chat", async (req, res) => {
  try {
    assertApiKey();
  } catch (err) {
    return res.status(500).json({ error: err.message, kind: "config" });
  }

  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({
      error: "Request body must be a JSON object with ingestion fields and a 'question'.",
      kind: "bad_request",
    });
  }

  try {
    const { answer, sources } = await answerQuestion(body, body.question);
    res.json({ answer, sources, meta: { model: config.model } });
  } catch (err) {
    sendError(res, "/chat", err);
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
