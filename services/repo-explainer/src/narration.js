import { SECTION_CHAR_HARDCAP, SECTION_WORD_BOUNDS } from "./prompts.js";

/**
 * Decide whether a section is outside the acceptable word range.
 * @returns {"shorten" | "lengthen" | null}
 */
export function classifySectionLength(wordCount) {
  if (wordCount > SECTION_WORD_BOUNDS.max) return "shorten";
  if (wordCount < SECTION_WORD_BOUNDS.min) return "lengthen";
  return null;
}

// Recompute derived counts for a section after its script changes.
export function withCounts(section) {
  const script = capScript(section.script ?? "");
  return {
    title: String(section.title ?? "").trim() || "Section",
    script,
    word_count: countWords(script),
    char_count: script.length,
  };
}

export function countWords(str) {
  return (String(str).match(/\b[\w'-]+\b/g) || []).length;
}

// Trim a script to the hard character cap at a sentence boundary so HeyGen
// never receives an oversized script.
export function capScript(script) {
  const clean = String(script).replace(/\s+/g, " ").trim();
  if (clean.length <= SECTION_CHAR_HARDCAP) return clean;

  const slice = clean.slice(0, SECTION_CHAR_HARDCAP);
  const lastStop = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? ")
  );
  if (lastStop > SECTION_CHAR_HARDCAP * 0.5) {
    return slice.slice(0, lastStop + 1).trim();
  }
  return `${slice.trim()}…`;
}

// Extract the first *complete, balanced* JSON object or array from a string,
// ignoring any prose or extra values the model tacks on afterwards. String
// contents (and escaped quotes) are skipped so braces inside strings don't
// throw off the depth count.
export function extractFirstJsonValue(text) {
  const objIdx = text.indexOf("{");
  const arrIdx = text.indexOf("[");
  let start = -1;
  if (objIdx === -1) start = arrIdx;
  else if (arrIdx === -1) start = objIdx;
  else start = Math.min(objIdx, arrIdx);
  if (start === -1) return null;

  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // never balanced
}

/**
 * Parses the narration model output (JSON) into a normalized, HeyGen-safe shape.
 * Accepts stray code fences, trailing prose, and a bare array as fallbacks.
 * @returns {{ sections: {title:string, script:string, word_count:number, char_count:number}[] }}
 */
export function parseNarration(raw) {
  let text = String(raw).trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const candidate = extractFirstJsonValue(text);
    if (candidate) {
      parsed = JSON.parse(candidate);
    } else {
      throw new Error("narration response was not valid JSON");
    }
  }

  const rawSections = Array.isArray(parsed) ? parsed : parsed?.sections;
  if (!Array.isArray(rawSections) || rawSections.length === 0) {
    throw new Error("narration JSON did not contain a non-empty 'sections' array");
  }

  const sections = rawSections
    .map((s, i) => {
      const script = capScript(s?.script ?? s?.text ?? "");
      return {
        title: String(s?.title ?? s?.name ?? `Section ${i + 1}`).trim(),
        script,
        word_count: countWords(script),
        char_count: script.length,
      };
    })
    .filter((s) => s.script.length > 0);

  if (sections.length === 0) {
    throw new Error("narration JSON contained only empty sections");
  }

  return { sections };
}
