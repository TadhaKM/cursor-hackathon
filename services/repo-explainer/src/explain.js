import { chat } from "./geminiClient.js";
import { normalizeIngestion, renderContext, hasUsableContent } from "./ingestion.js";
import {
  buildArchitectureMessages,
  buildNarrationMessages,
  buildMermaidMessages,
  buildSectionResizeMessages,
  normalizePersona,
  SECTION_WORD_BOUNDS,
} from "./prompts.js";
import { validateMermaid } from "./mermaid.js";
import {
  parseNarration,
  classifySectionLength,
  withCounts,
  extractFirstJsonValue,
} from "./narration.js";

// For each section outside the acceptable word range, make ONE targeted resize
// call. If it's still out of range afterwards, keep it and log a warning rather
// than failing the whole request.
export async function refineSectionLengths(sections, persona, chatFn = chat) {
  const refined = [];
  for (const section of sections) {
    const direction = classifySectionLength(section.word_count);
    if (!direction) {
      refined.push(section);
      continue;
    }

    const verb = direction === "shorten" ? "shorten" : "lengthen";
    try {
      const msgs = buildSectionResizeMessages(section, verb, persona);
      const raw = await chatFn({
        ...msgs,
        json: true,
        temperature: 0.5,
        label: `narration-resize:${verb}`,
      });
      const stripped = stripFences(raw);
      let parsed;
      try {
        parsed = JSON.parse(stripped);
      } catch {
        const candidate = extractFirstJsonValue(stripped);
        if (!candidate) throw new Error("resize response was not valid JSON");
        parsed = JSON.parse(candidate);
      }
      const next = withCounts({
        title: parsed.title ?? section.title,
        script: parsed.script ?? section.script,
      });

      if (classifySectionLength(next.word_count)) {
        console.warn(
          `[narration] section "${next.title}" still ${next.word_count} words ` +
            `after resize (want ${SECTION_WORD_BOUNDS.min}-${SECTION_WORD_BOUNDS.max}); keeping as-is.`
        );
      }
      refined.push(next);
    } catch (err) {
      console.warn(
        `[narration] resize of section "${section.title}" failed (${err.message}); keeping original.`
      );
      refined.push(section);
    }
  }
  return refined;
}

function stripFences(text) {
  const s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fence ? fence[1].trim() : s;
}

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
 * -> mermaid diagram (three sequential Gemini calls).
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
    err.kind = "bad_request";
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

  // 2) Narration script (retries once via geminiClient; parse can also fail).
  const narrMsgs = buildNarrationMessages(architectureSummary, persona);
  const narrationRaw = await chat({
    ...narrMsgs,
    json: true,
    temperature: 0.6,
    label: "narration",
  });
  const narrationScript = parseNarration(narrationRaw);
  // Enforce per-section word bounds with one targeted resize retry each.
  narrationScript.sections = await refineSectionLengths(
    narrationScript.sections,
    persona
  );

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
