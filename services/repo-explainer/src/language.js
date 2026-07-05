// Supported narration languages. Codes are BCP-47-ish (ISO 639-1).
// `name` is the full language name passed into LLM prompts.

export const LANGUAGES = {
  en: { code: "en", name: "English" },
  es: { code: "es", name: "Spanish" },
  zh: { code: "zh", name: "Chinese" },
  hi: { code: "hi", name: "Hindi" },
};

export const DEFAULT_LANGUAGE = "en";

/**
 * Normalize a language code from the request body.
 * Accepts "es", "ES", "es-ES", etc. — uses the primary subtag.
 * @returns {{ code: string, name: string }}
 */
export function normalizeLanguage(input) {
  if (input == null || input === "") {
    return LANGUAGES[DEFAULT_LANGUAGE];
  }
  if (typeof input !== "string") {
    const err = new Error(
      `Invalid language. Supported codes: ${Object.keys(LANGUAGES).join(", ")}.`
    );
    err.statusCode = 400;
    err.kind = "bad_request";
    throw err;
  }

  const primary = input.trim().toLowerCase().split(/[-_]/)[0];
  const lang = LANGUAGES[primary];
  if (!lang) {
    const err = new Error(
      `Unsupported language "${input}". Supported codes: ${Object.keys(LANGUAGES).join(", ")}.`
    );
    err.statusCode = 400;
    err.kind = "bad_request";
    throw err;
  }
  return lang;
}

export function languageGuidance(lang) {
  if (!lang || lang.code === DEFAULT_LANGUAGE) return "";
  return [
    `LANGUAGE: Write the entire narration script in ${lang.name}.`,
    "Keep it natural and conversational in that language — not a literal translation from English.",
    `Adapt idioms, greetings, and phrasing so it sounds native to a ${lang.name} speaker.`,
    "Section titles should also be in ${lang.name}.",
    "Technical file and folder names (like server.js, auth.js) may stay as-is since engineers say them that way.",
  ].join(" ");
}
