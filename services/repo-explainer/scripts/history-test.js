// Verify architecture summary grounds "why" in real commit/PR history.
// Usage: GEMINI_API_KEY=AIza... node scripts/history-test.js
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config } from "../src/config.js";
import { explainRepo } from "../src/explain.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RICH = resolve(__dirname, "../examples/rich-history.json");

// Phrases that MUST appear if the model used real history (from the fixture).
const EXPECTED_SIGNALS = [
  /better-sqlite3/i,
  /rate[- ]?limit|express-rate-limit/i,
  /middleware\/auth|auth\.js/i,
  /JWT|Bearer/i,
  /(#18|PR 18|pull request 18|extract JWT|middleware)/i,
];

function checkHistoryGrounding(summary, narrationSections) {
  const allText = [summary, ...narrationSections.map((s) => s.script)].join("\n");
  const hits = EXPECTED_SIGNALS.filter((re) => re.test(allText));
  const missing = EXPECTED_SIGNALS.length - hits.length;
  const genericSmells = [
    /over time, the team decided/i,
    /historically, this module was refactored for maintainability/i,
    /as the project evolved/i,
  ].filter((re) => re.test(allText));

  return { hits: hits.length, missing, genericSmells };
}

async function main() {
  if (!config.apiKey) {
    console.error("GEMINI_API_KEY is not set.");
    process.exit(1);
  }

  const payload = JSON.parse(await readFile(RICH, "utf8"));
  console.log("Running /explain on rich-history.json ...\n");

  const result = await explainRepo(payload, { includeDiagram: false });
  console.log(`rich_history flag: ${result.rich_history}\n`);

  console.log("===== ARCHITECTURE SUMMARY =====\n");
  console.log(result.architecture_summary);

  console.log("\n\n===== NARRATION (first section) =====\n");
  const first = result.narration_script.sections[0];
  console.log(`--- ${first.title} (${first.word_count} words) ---`);
  console.log(first.script);

  const { hits, missing, genericSmells } = checkHistoryGrounding(
    result.architecture_summary,
    result.narration_script.sections
  );

  console.log(`\n>>> HISTORY GROUNDING: ${hits}/${EXPECTED_SIGNALS.length} expected signals found`);
  if (genericSmells.length) {
    console.log(">>> WARNING: generic filler detected:");
    for (const re of genericSmells) console.log(`    - ${re}`);
  }

  if (hits < 3) {
    console.error("\nFAIL: summary/narration did not reference enough real commit/PR history.");
    process.exit(2);
  }
  console.log("\nPASS: output references concrete history from the fixture.");
}

main().catch((err) => {
  console.error("\nhistory-test failed:", err.message);
  process.exit(1);
});
