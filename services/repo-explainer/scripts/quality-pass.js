// Narration quality pass — runs /explain against every fixture in examples/,
// prints each section, and flags the three failure modes from the spec.
// Usage: GEMINI_API_KEY=AIza... node scripts/quality-pass.js
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { config } from "../src/config.js";
import { explainRepo } from "../src/explain.js";
import { SECTION_WORD_BOUNDS } from "../src/prompts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = resolve(__dirname, "../examples");

// Doc-like phrasings that make narration sound read-aloud instead of spoken.
const DOC_SMELLS = [
  /this (module|directory|folder|section|file) contains/i,
  /the following (components|files|functions|modules)/i,
  /is responsible for/i,
  /this section (will )?(cover|describe|explain)s?/i,
  /in this (section|chapter)/i,
];

function fileNames(payload) {
  const tree = payload.file_tree ?? [];
  const names = new Set();
  for (const entry of tree) {
    const p = typeof entry === "string" ? entry : entry?.path ?? "";
    for (const part of p.split("/")) if (part) names.add(part.toLowerCase());
  }
  return names;
}

function analyze(sections, payload) {
  const names = fileNames(payload);
  const problems = [];
  const lengths = sections.map((s) => s.word_count);

  for (const s of sections) {
    const smell = DOC_SMELLS.find((re) => re.test(s.script));
    if (smell) problems.push(`"${s.title}": doc-like phrasing (${smell})`);
    if (s.word_count < SECTION_WORD_BOUNDS.min || s.word_count > SECTION_WORD_BOUNDS.max) {
      problems.push(`"${s.title}": ${s.word_count} words, outside ${SECTION_WORD_BOUNDS.min}-${SECTION_WORD_BOUNDS.max}`);
    }
  }

  // Generic check: does at least half the sections mention a real file name?
  const mentioning = sections.filter((s) =>
    [...names].some((n) => n.length > 3 && s.script.toLowerCase().includes(n))
  ).length;
  if (mentioning < Math.ceil(sections.length / 2)) {
    problems.push(`only ${mentioning}/${sections.length} sections reference real file names (too generic)`);
  }

  // Length spread check.
  const spread = Math.max(...lengths) - Math.min(...lengths);
  if (spread > 150) problems.push(`length spread ${spread} words (min ${Math.min(...lengths)}, max ${Math.max(...lengths)})`);

  return problems;
}

async function main() {
  if (!config.apiKey) {
    console.error("GEMINI_API_KEY is not set. Export it, then rerun.");
    process.exit(1);
  }

  const files = (await readdir(EXAMPLES)).filter((f) => f.endsWith(".json"));
  let totalProblems = 0;

  for (const file of files) {
    const payload = JSON.parse(await readFile(join(EXAMPLES, file), "utf8"));
    console.log(`\n${"=".repeat(70)}\nFIXTURE: ${file}  (persona: ${payload.persona ?? "none"})\n${"=".repeat(70)}`);

    let result;
    try {
      result = await explainRepo(payload);
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
      totalProblems++;
      continue;
    }

    for (const s of result.narration_script.sections) {
      console.log(`\n--- ${s.title} (${s.word_count} words) ---`);
      console.log(s.script);
    }

    const problems = analyze(result.narration_script.sections, payload);
    console.log(`\n>>> QUALITY: ${problems.length ? "ISSUES" : "clean"}`);
    for (const p of problems) console.log(`    - ${p}`);
    totalProblems += problems.length;
  }

  console.log(`\n${"=".repeat(70)}\nTOTAL ISSUES ACROSS FIXTURES: ${totalProblems}`);
  process.exit(totalProblems > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error("quality-pass failed:", err.message);
  process.exit(1);
});
