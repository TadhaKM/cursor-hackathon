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
    caption: section.caption ? String(section.caption).trim() : null,
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

/**
 * Parses the narration model output (JSON) into a normalized, HeyGen-safe shape.
 * Accepts stray code fences and a bare array as fallbacks.
 * @returns {{ sections: {title:string, script:string, caption:string|null, word_count:number, char_count:number}[] }}
 */
export function parseNarration(raw) {
  let text = String(raw).trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      parsed = JSON.parse(text.slice(start, end + 1));
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
        caption: s?.caption ? String(s.caption).trim() : null,
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
