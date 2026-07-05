/**
 * Smoke test for repo-ingest.
 *
 * Calls POST /ingest against a small, medium, and large repo and prints the
 * output size (in characters) for each, with a per-section breakdown so we can
 * see how the trimming budget is being spent.
 *
 * Usage:
 *   node test.js                 # uses BASE_URL or http://localhost:3111
 *   BASE_URL=http://host node test.js
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:3111";
const BUDGET = 60_000; // ~15k tokens

const REPOS = [
  { label: "small  (<20 files)", url: "https://github.com/sindresorhus/slugify" },
  {
    label: "medium (50-200 files)",
    url: "https://github.com/gothinkster/node-express-realworld-example-app",
  },
  { label: "large  (500+ files)", url: "https://github.com/facebook/react" },
];

function jsonSize(obj) {
  return JSON.stringify(obj).length;
}

function sectionSizes(r) {
  const keyFilesChars = (r.key_files || []).reduce(
    (n, f) => n + (f.content ? f.content.length : 0),
    0
  );
  const commitsChars = (r.recent_commits || []).reduce(
    (n, c) => n + (c.message ? c.message.length : 0),
    0
  );
  return {
    readme: (r.readme || "").length,
    package_manifest: (r.package_manifest || "").length,
    key_files: keyFilesChars,
    file_tree: (r.file_tree || "").length,
    commits: commitsChars,
  };
}

async function ingest(url) {
  const res = await fetch(`${BASE_URL}/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo_url: url }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

async function main() {
  console.log(`\nTesting repo-ingest at ${BASE_URL}`);
  console.log(`Budget: ~${BUDGET.toLocaleString()} chars\n`);
  console.log("=".repeat(78));

  for (const { label, url } of REPOS) {
    const t0 = Date.now();
    let result;
    try {
      result = await ingest(url);
    } catch (err) {
      console.log(`\n${label}\n  ${url}\n  REQUEST FAILED: ${err.message}`);
      continue;
    }
    const ms = Date.now() - t0;

    if (result.status !== 200) {
      console.log(`\n${label}\n  ${url}`);
      console.log(
        `  HTTP ${result.status}  ERROR: ${result.body.error || JSON.stringify(result.body)}`
      );
      continue;
    }

    const r = result.body;
    const total = jsonSize(r);
    const sizes = sectionSizes(r);
    const withinBudget = total <= BUDGET * 1.05; // allow small JSON overhead

    console.log(`\n${label}`);
    console.log(`  ${url}`);
    console.log(
      `  HTTP ${result.status}  ${ms}ms  cached=${r.cached}  files_indexed=${r.meta?.files_indexed}  tree_truncated=${r.meta?.tree_truncated}`
    );
    console.log(`  TOTAL RESPONSE: ${total.toLocaleString()} chars` +
      `  ${withinBudget ? "✅ within budget" : "❌ OVER BUDGET"}`);
    console.log(`  breakdown:`);
    for (const [k, v] of Object.entries(sizes)) {
      console.log(`    ${pad(k, 18)} ${v.toLocaleString()} chars`);
    }
    console.log(
      `    ${pad("key_files count", 18)} ${(r.key_files || []).length}`
    );
    console.log(
      `    ${pad("commits count", 18)} ${(r.recent_commits || []).length}`
    );
  }
  console.log("\n" + "=".repeat(78) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
