// Full-pipeline smoke test — hits the real Gemini API.
// Usage: GEMINI_API_KEY=AIza... node scripts/smoke.js [path-to-ingestion.json]
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config } from "../src/config.js";
import { explainRepo } from "../src/explain.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  if (!config.apiKey) {
    console.error("GEMINI_API_KEY is not set. Add it to .env or export it, then rerun.");
    process.exit(1);
  }

  const file = process.argv[2]
    ? resolve(process.cwd(), process.argv[2])
    : resolve(__dirname, "../examples/sample-ingestion.json");

  const payload = JSON.parse(await readFile(file, "utf8"));
  console.log(`Using ingestion: ${file}`);
  console.log(`Model: ${config.model}  Persona: ${payload.persona ?? "(none)"}\n`);

  const t0 = Date.now();
  const result = await explainRepo(payload);
  console.log(`Done in ${Date.now() - t0}ms\n`);

  console.log("===== ARCHITECTURE SUMMARY =====\n");
  console.log(result.architecture_summary);

  console.log("\n\n===== NARRATION SCRIPT =====\n");
  for (const s of result.narration_script.sections) {
    console.log(`--- ${s.title} (${s.word_count} words, ${s.char_count} chars) ---`);
    console.log(s.script);
    console.log();
  }

  console.log("\n===== MERMAID DIAGRAM =====\n");
  console.log(result.mermaid_diagram ?? "(diagram generation failed / returned null)");
}

main().catch((err) => {
  console.error("\nSmoke test failed:", err.message);
  process.exit(1);
});
