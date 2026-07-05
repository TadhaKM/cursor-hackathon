// Sanity-check narration in non-English languages against the same mock repo.
// Usage: QWEN_API_KEY=sk-... node scripts/language-test.js
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config } from "../src/config.js";
import { explainRepo } from "../src/explain.js";
import { LANGUAGES } from "../src/language.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "../examples/sample-ingestion.json");

// Heuristics for "sounds machine-translated" — not perfect, but catches obvious fails.
const MACHINE_TRANSLATION_SMELLS = [
  /\bthe following\b/i,
  /\bis responsible for\b/i,
  /\bthis module contains\b/i,
  /\bin order to\b/i,
  /\bplease note that\b/i,
  /\bas mentioned above\b/i,
  /\brespectively\b/i,
];

const SPANISH_MARKERS = /\b(bienvenid[oa]|vamos|entonces|básicamente|aquí|nuestro|tu|te)\b/i;
const CHINESE_MARKERS = /[\u4e00-\u9fff]{4,}/;

function analyzeLanguageOutput(langCode, sections) {
  const issues = [];
  const allText = sections.map((s) => s.script).join(" ");

  if (langCode === "es" && !SPANISH_MARKERS.test(allText)) {
    issues.push("Spanish output lacks common conversational markers — may not be native Spanish");
  }
  if (langCode === "zh" && !CHINESE_MARKERS.test(allText)) {
    issues.push("Chinese output has too few CJK characters — may still be in English");
  }
  if (langCode !== "en") {
    for (const re of MACHINE_TRANSLATION_SMELLS) {
      if (re.test(allText)) issues.push(`possible doc-like / translated phrasing: ${re}`);
    }
  }

  return issues;
}

async function runLanguage(langCode) {
  const payload = JSON.parse(await readFile(FIXTURE, "utf8"));
  payload.language = langCode;
  delete payload.persona;

  const lang = LANGUAGES[langCode];
  console.log(`\n${"=".repeat(70)}\nLANGUAGE: ${lang.name} (${lang.code})\n${"=".repeat(70)}`);

  const t0 = Date.now();
  const result = await explainRepo(payload, { includeDiagram: false });
  console.log(`Done in ${Date.now() - t0}ms\n`);

  console.log("--- architecture_summary (should stay English) ---");
  console.log(result.architecture_summary.slice(0, 280) + "...\n");

  for (const s of result.narration_script.sections) {
    console.log(`--- ${s.title} (${s.word_count} words, ${s.char_count} chars) ---`);
    console.log(s.script);
    console.log();
  }

  const issues = analyzeLanguageOutput(langCode, result.narration_script.sections);
  console.log(`>>> SANITY: ${issues.length ? "ISSUES" : "clean"}`);
  for (const i of issues) console.log(`    - ${i}`);

  return issues.length;
}

async function main() {
  if (!config.apiKey) {
    console.error("QWEN_API_KEY is not set.");
    process.exit(1);
  }

  const langs = process.argv.slice(2);
  const toRun = langs.length ? langs : ["es", "zh"];
  let totalIssues = 0;

  for (const code of toRun) {
    if (!LANGUAGES[code]) {
      console.error(`Unknown language code: ${code}`);
      process.exit(1);
    }
    totalIssues += await runLanguage(code);
  }

  console.log(`\n${"=".repeat(70)}\nTOTAL ISSUES: ${totalIssues}`);
  process.exit(totalIssues > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error("\nlanguage-test failed:", err.message);
  process.exit(1);
});
