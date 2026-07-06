// End-to-end test against Person 1's REAL ingestion endpoint.
//
// Pending until Person 1's /ingest is live. Once it is, set INGEST_URL and run:
//   INGEST_URL=http://localhost:8000/repo-summary-input \
//   GEMINI_API_KEY=sk-... \
//   node scripts/from-ingest.js https://github.com/owner/repo
//
// It fetches real ingestion output, feeds it straight into explainRepo, and
// prints the narration so we can confirm quality holds on real repos, not mocks.
import { config } from "../src/config.js";
import { explainRepo } from "../src/explain.js";

const INGEST_URL = process.env.INGEST_URL;

async function fetchIngestion(repoUrl) {
  if (!INGEST_URL) {
    throw new Error(
      "INGEST_URL is not set. Point it at Person 1's ingestion endpoint " +
        "(e.g. http://localhost:8000/repo-summary-input) once it's ready."
    );
  }
  // Person 1's contract (per the root README) is GET /repo-summary-input?url=...
  const url = new URL(INGEST_URL);
  url.searchParams.set("url", repoUrl);

  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Ingestion endpoint returned ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function main() {
  const repoUrl = process.argv[2];
  if (!repoUrl) {
    console.error("Usage: node scripts/from-ingest.js <repo-url>");
    process.exit(1);
  }
  if (!config.apiKey) {
    console.error("GEMINI_API_KEY is not set.");
    process.exit(1);
  }

  const persona = process.env.PERSONA;
  console.log(`Fetching ingestion for ${repoUrl} ...`);
  const ingestion = await fetchIngestion(repoUrl);
  if (persona) ingestion.persona = persona;

  const result = await explainRepo(ingestion);

  console.log("\n===== NARRATION SCRIPT =====\n");
  for (const s of result.narration_script.sections) {
    console.log(`--- ${s.title} (${s.word_count} words) ---`);
    console.log(s.script);
    console.log();
  }
  console.log("===== MERMAID =====\n");
  console.log(result.mermaid_diagram ?? "(none)");
}

main().catch((err) => {
  console.error("\nfrom-ingest failed:", err.message);
  process.exit(1);
});
