import { chat } from "./qwenClient.js";
import { normalizeIngestion, renderContext, hasUsableContent } from "./ingestion.js";
import {
  buildArchitectureMessages,
  buildNarrationMessages,
  buildMermaidMessages,
  normalizePersona,
} from "./prompts.js";
import { validateMermaid } from "./mermaid.js";
import { parseNarration } from "./narration.js";

async function generateMermaid(context, architectureSummary) {
  // First attempt.
  let raw;
  try {
    const msgs = buildMermaidMessages(context, architectureSummary, { strict: false });
    raw = await chat({ ...msgs, temperature: 0.2, label: "mermaid" });
  } catch (err) {
    console.warn(`[mermaid] first attempt errored: ${err.message}`);
  }

  if (raw) {
    const first = validateMermaid(raw);
    if (first.ok) return first.diagram;
    console.warn(`[mermaid] first attempt invalid: ${first.error}. Retrying strict.`);
  }

  // Strict retry.
  try {
    const strictMsgs = buildMermaidMessages(context, architectureSummary, { strict: true });
    const strictRaw = await chat({ ...strictMsgs, temperature: 0, label: "mermaid-strict" });
    const second = validateMermaid(strictRaw);
    if (second.ok) return second.diagram;
    console.warn(`[mermaid] strict retry invalid: ${second.error}. Returning null.`);
  } catch (err) {
    console.warn(`[mermaid] strict retry errored: ${err.message}`);
  }

  return null;
}

/**
 * Runs the full explanation pipeline: architecture summary -> narration script
 * -> mermaid diagram (three sequential Qwen calls).
 *
 * @param {object} payload Ingestion JSON, optionally with a `persona` field.
 * @param {object} [opts]
 * @param {boolean} [opts.includeDiagram=true] Set false to skip the mermaid call.
 * @returns {Promise<{ architecture_summary: string, narration_script: {sections: any[]}, mermaid_diagram: string|null, persona: string|null }>}
 */
export async function explainRepo(payload = {}, opts = {}) {
  const { includeDiagram = true } = opts;
  const persona = normalizePersona(payload.persona);

  const norm = normalizeIngestion(payload);
  if (!hasUsableContent(norm)) {
    const err = new Error(
      "Ingestion payload had no usable content (file_tree, readme, key_files, recent_commits, or package_manifest required)."
    );
    err.statusCode = 400;
    throw err;
  }

  const context = renderContext(norm);

  // 1) Architecture summary.
  const archMsgs = buildArchitectureMessages(context, persona);
  const architectureSummary = await chat({
    ...archMsgs,
    temperature: 0.4,
    label: "architecture",
  });

  // 2) Narration script (retries once via qwenClient; parse can also fail).
  const narrMsgs = buildNarrationMessages(architectureSummary, persona);
  const narrationRaw = await chat({
    ...narrMsgs,
    json: true,
    temperature: 0.6,
    label: "narration",
  });
  const narrationScript = parseNarration(narrationRaw);

  // 3) Mermaid diagram (best-effort; may be null).
  const mermaidDiagram = includeDiagram
    ? await generateMermaid(context, architectureSummary)
    : null;

  return {
    architecture_summary: architectureSummary,
    narration_script: narrationScript,
    mermaid_diagram: mermaidDiagram,
    persona,
  };
}
