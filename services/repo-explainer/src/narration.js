import { SECTION_CHAR_HARDCAP, SECTION_WORD_BOUNDS } from "./prompts.js";

/**
 * Decide whether a section is outside the acceptable word range.
 * @returns {"shorten" | "lengthen" | null}
 */
export function classifySectionLength(wordCount, languageCode = "en") {
  const bounds = lengthBoundsFor(languageCode);
  if (wordCount > bounds.max) return "shorten";
  if (wordCount < bounds.min) return "lengthen";
  return null;
}

// CJK scripts are counted by characters rather than space-delimited words.
function lengthBoundsFor(languageCode) {
  if (languageCode === "zh") {
    return { min: 100, max: 250 };
  }
  return SECTION_WORD_BOUNDS;
}

// Recompute derived counts for a section after its script changes.
export function withCounts(section, languageCode = "en") {
  const script = capScript(section.script ?? "", languageCode);
  return {
    title: String(section.title ?? "").trim() || "Section",
    script,
    word_count: countWords(script, languageCode),
    char_count: script.length,
  };
}

/**
 * Count spoken length. Latin scripts use word tokens; CJK counts ideographs
 * (each ~one spoken syllable) plus any embedded Latin tokens.
 */
export function countWords(str, languageCode = "en") {
  const text = String(str);
  const cjk = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? [];
  const latin = text.match(/\b[\w'-]+\b/g) ?? [];
  if (languageCode === "zh" || (cjk.length > 0 && cjk.length >= latin.length)) {
    return cjk.length + latin.length;
  }
  // Devanagari (Hindi) and other scripts: whitespace-delimited tokens.
  if (languageCode === "hi" || /[\u0900-\u097f]/.test(text)) {
    const tokens = text.trim().split(/\s+/).filter(Boolean);
    return tokens.length || latin.length;
  }
  return latin.length;
}

// Trim a script to the hard character cap at a sentence boundary so HeyGen
// never receives an oversized script.
export function capScript(script, languageCode = "en") {
  const clean = String(script).replace(/\s+/g, " ").trim();
  if (clean.length <= SECTION_CHAR_HARDCAP) return clean;

  const slice = clean.slice(0, SECTION_CHAR_HARDCAP);
  const stops =
    languageCode === "zh"
      ? [slice.lastIndexOf("。"), slice.lastIndexOf("！"), slice.lastIndexOf("？")]
      : [
          slice.lastIndexOf(". "),
          slice.lastIndexOf("! "),
          slice.lastIndexOf("? "),
        ];
  const lastStop = Math.max(...stops);
  if (lastStop > SECTION_CHAR_HARDCAP * 0.5) {
    return slice.slice(0, lastStop + 1).trim();
  }
  return `${slice.trim()}…`;
}

/**
 * Parses the narration model output (JSON) into a normalized, HeyGen-safe shape.
 * Accepts stray code fences and a bare array as fallbacks.
 * @returns {{ sections: {title:string, script:string, word_count:number, char_count:number}[] }}
 */
export function parseNarration(raw, languageCode = "en") {
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
      const script = capScript(s?.script ?? s?.text ?? "", languageCode);
      return {
        title: String(s?.title ?? s?.name ?? `Section ${i + 1}`).trim(),
        script,
        word_count: countWords(script, languageCode),
        char_count: script.length,
      };
    })
    .filter((s) => s.script.length > 0);

  if (sections.length === 0) {
    throw new Error("narration JSON contained only empty sections");
  }

  return { sections };
}
