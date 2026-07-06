import { chat } from "./geminiClient.js";
import { buildDiffNarrationMessages, normalizePersona } from "./prompts.js";
import { withCounts } from "./narration.js";
import { refineSectionLengths } from "./explain.js";

function stripFences(text) {
  const s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fence ? fence[1].trim() : s;
}

/**
 * Diff mode: narrate what changed between two refs as a single section,
 * instead of running the full multi-section explainRepo() pipeline. Reuses
 * refineSectionLengths() from explain.js so the same word-bound enforcement
 * (and HeyGen-safe truncation via withCounts/capScript) applies here too —
 * the output is video-renderer-ready with zero changes on that side.
 *
 * @param {object} diffPayload repo-ingest's POST /diff response.
 * @param {object} [opts]
 * @param {string} [opts.persona]
 * @returns {Promise<{ narration_script: {sections: any[]}, persona: string|null }>}
 */
export async function explainDiff(diffPayload = {}, opts = {}) {
  const persona = normalizePersona(opts.persona);

  if (!Array.isArray(diffPayload.files) || diffPayload.files.length === 0) {
    const err = new Error(
      "Diff payload had no changed files to narrate (expected a non-empty 'files' array)."
    );
    err.statusCode = 400;
    err.kind = "bad_request";
    throw err;
  }

  const msgs = buildDiffNarrationMessages(diffPayload);
  const raw = await chat({
    ...msgs,
    json: true,
    temperature: 0.6,
    label: "diff-narration",
  });

  let parsed;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    throw new Error("diff-narration response was not valid JSON");
  }

  const section = withCounts({
    title: parsed.title || "What Changed",
    script: parsed.script || "",
  });

  if (!section.script) {
    throw new Error("diff-narration response had an empty script");
  }

  // Reuse the exact same resize-retry logic the main pipeline uses to keep
  // sections inside SECTION_WORD_BOUNDS.
  const [refined] = await refineSectionLengths([section], persona);

  return {
    narration_script: { sections: [refined] },
    persona,
  };
}
