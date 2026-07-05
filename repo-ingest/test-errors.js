/**
 * Offline unit tests for the error-handling and trimming logic.
 *
 * These do not touch the network — they drive the real code paths with a
 * fake Octokit client and synthetic inputs, so error responses (400/404/429)
 * can be verified deterministically without burning GitHub API quota.
 *
 * Usage: node test-errors.js
 */

import assert from "node:assert";
import {
  parseRepoUrl,
  isExcludedPath,
  getRepo,
  GitHubError,
} from "./src/github.js";
import {
  truncateByLines,
  collectMonorepoEntryPoints,
} from "./src/ingest.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    console.log(`  ❌ ${name}\n     ${err.message}`);
    process.exitCode = 1;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    console.log(`  ❌ ${name}\n     ${err.message}`);
    process.exitCode = 1;
  }
}

// Build a fake Octokit whose repos.get() throws a given HTTP error.
function fakeOctokitThrowing(status, headers = {}, message = "") {
  const err = new Error(message || `HTTP ${status}`);
  err.status = status;
  err.response = { headers };
  return { repos: { get: async () => { throw err; } } };
}

console.log("\nURL parsing");
test("full URL parses to owner/repo", () => {
  assert.deepEqual(parseRepoUrl("https://github.com/octocat/Hello-World"), {
    owner: "octocat",
    repo: "Hello-World",
  });
});
test("URL with .git and trailing slash is normalized", () => {
  assert.deepEqual(parseRepoUrl("https://github.com/a/b.git/"), {
    owner: "a",
    repo: "b",
  });
});
test("owner/repo shorthand works", () => {
  assert.deepEqual(parseRepoUrl("a/b"), { owner: "a", repo: "b" });
});
test("malformed URL throws INVALID_URL", () => {
  assert.throws(() => parseRepoUrl("not a url"), (e) => e.code === "INVALID_URL");
});
test("non-github host throws INVALID_URL", () => {
  assert.throws(
    () => parseRepoUrl("https://gitlab.com/a/b"),
    (e) => e.code === "INVALID_URL"
  );
});
test("missing repo segment throws INVALID_URL", () => {
  assert.throws(
    () => parseRepoUrl("https://github.com/octocat"),
    (e) => e.code === "INVALID_URL"
  );
});
test("junk that looks like shorthand is rejected (not sent to API)", () => {
  assert.throws(() => parseRepoUrl("ht!tp://bad"), (e) => e.code === "INVALID_URL");
  assert.throws(() => parseRepoUrl("foo bar/baz"), (e) => e.code === "INVALID_URL");
});

console.log("\nExclusion rules");
test("node_modules is excluded", () => {
  assert.equal(isExcludedPath("node_modules/foo/index.js"), true);
});
test("dist/build/.git excluded", () => {
  assert.equal(isExcludedPath("dist/bundle.js"), true);
  assert.equal(isExcludedPath("build/out.js"), true);
  assert.equal(isExcludedPath(".git/config"), true);
});
test("binary files excluded", () => {
  assert.equal(isExcludedPath("assets/logo.png"), true);
  assert.equal(isExcludedPath("fonts/x.woff2"), true);
});
test("normal source files kept", () => {
  assert.equal(isExcludedPath("src/index.js"), false);
  assert.equal(isExcludedPath("README.md"), false);
});

console.log("\nError translation (mocked GitHub)");
await testAsync("404 -> NOT_FOUND (private/missing repo)", async () => {
  const octo = fakeOctokitThrowing(404);
  await assert.rejects(
    getRepo(octo, { owner: "a", repo: "b" }),
    (e) => e instanceof GitHubError && e.code === "NOT_FOUND" && e.status === 404
  );
});
await testAsync("403 + x-ratelimit-remaining:0 -> RATE_LIMITED with reset", async () => {
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const octo = fakeOctokitThrowing(403, {
    "x-ratelimit-remaining": "0",
    "x-ratelimit-reset": String(reset),
  });
  await assert.rejects(getRepo(octo, { owner: "a", repo: "b" }), (e) => {
    assert.ok(e instanceof GitHubError);
    assert.equal(e.code, "RATE_LIMITED");
    assert.equal(e.details.rate_limit_reset_epoch, reset);
    assert.match(e.details.rate_limit_reset, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(e.message, /rate limit/i);
    return true;
  });
});
await testAsync("403 without rate-limit header -> FORBIDDEN", async () => {
  const octo = fakeOctokitThrowing(403, { "x-ratelimit-remaining": "42" });
  await assert.rejects(
    getRepo(octo, { owner: "a", repo: "b" }),
    (e) => e.code === "FORBIDDEN"
  );
});
await testAsync("401 -> UNAUTHORIZED", async () => {
  const octo = fakeOctokitThrowing(401);
  await assert.rejects(
    getRepo(octo, { owner: "a", repo: "b" }),
    (e) => e.code === "UNAUTHORIZED"
  );
});

console.log("\nHead/tail truncation");
test("short files pass through unchanged", () => {
  const t = "a\nb\nc";
  assert.equal(truncateByLines(t, { maxLines: 300 }), t);
});
test("long files keep head + tail with marker", () => {
  const lines = Array.from({ length: 400 }, (_, i) => `line${i}`);
  const out = truncateByLines(lines.join("\n"), {
    maxLines: 300,
    headLines: 50,
    tailLines: 50,
  });
  const outLines = out.split("\n");
  assert.equal(outLines[0], "line0");
  assert.equal(outLines[49], "line49");
  assert.ok(out.includes("[...truncated 300 lines...]"));
  assert.equal(outLines[outLines.length - 1], "line399"); // tail preserved
});

console.log("\nMonorepo entry points");
test("picks one entry point per workspace package", () => {
  const paths = [
    "packages/core/src/index.ts",
    "packages/core/package.json",
    "packages/ui/index.js",
    "apps/web/src/main.py",
    "README.md",
  ];
  const entries = paths.map((p) => ({ path: p }));
  const picks = collectMonorepoEntryPoints(entries, new Set(paths));
  assert.deepEqual(picks.sort(), [
    "apps/web/src/main.py",
    "packages/core/src/index.ts",
    "packages/ui/index.js",
  ]);
});
test("non-monorepo repos yield no monorepo picks", () => {
  const paths = ["src/index.js", "package.json"];
  const picks = collectMonorepoEntryPoints(
    paths.map((p) => ({ path: p })),
    new Set(paths)
  );
  assert.deepEqual(picks, []);
});

console.log(`\n${passed} checks passed\n`);
