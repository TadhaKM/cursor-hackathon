// Offline unit tests for the pure helpers (no API key required).
// Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateMermaid, cleanMermaid } from "../src/mermaid.js";
import {
  normalizeIngestion,
  renderContext,
  hasUsableContent,
} from "../src/ingestion.js";
import { normalizePersona, SECTION_CHAR_HARDCAP } from "../src/prompts.js";
import { parseNarration, capScript, countWords } from "../src/narration.js";
import { buildChunks, retrieve } from "../src/rag.js";

test("cleanMermaid strips code fences and prose preamble", () => {
  const raw = "Here you go:\n```mermaid\ngraph TD\n  A[App] --> B[DB]\n```";
  assert.equal(cleanMermaid(raw), "graph TD\n  A[App] --> B[DB]");
});

test("validateMermaid accepts a valid flowchart", () => {
  const r = validateMermaid("graph TD\n  A[API] --> B[DB]\n  A --> C[Auth]");
  assert.equal(r.ok, true);
});

test("validateMermaid rejects prose without a header", () => {
  const r = validateMermaid("This project has an API layer and a database.");
  assert.equal(r.ok, false);
});

test("validateMermaid rejects unbalanced brackets", () => {
  const r = validateMermaid("graph TD\n  A[API --> B[DB]");
  assert.equal(r.ok, false);
});

test("validateMermaid rejects header-only diagram", () => {
  const r = validateMermaid("graph TD");
  assert.equal(r.ok, false);
});

test("normalizeIngestion handles array file tree and object key_files map", () => {
  const norm = normalizeIngestion({
    file_tree: ["src/a.js", { path: "src/b.js" }],
    readme: "hello",
    key_files: { "src/a.js": "console.log(1)" },
    recent_commits: [{ sha: "abcdef1234", author: "X", message: "init" }],
    package_manifest: { name: "demo" },
  });
  assert.match(norm.fileTree, /src\/a\.js/);
  assert.match(norm.fileTree, /src\/b\.js/);
  assert.equal(norm.keyFiles.length, 1);
  assert.equal(norm.keyFiles[0].path, "src/a.js");
  assert.equal(norm.commits.length, 1);
  assert.match(norm.commits[0], /init/);
  assert.equal(hasUsableContent(norm), true);
});

test("renderContext includes all sections", () => {
  const ctx = renderContext(normalizeIngestion({ readme: "hi" }));
  assert.match(ctx, /## FILE TREE/);
  assert.match(ctx, /## README/);
  assert.match(ctx, /## KEY FILES/);
  assert.match(ctx, /## RECENT COMMITS/);
});

test("hasUsableContent is false for empty payload", () => {
  assert.equal(hasUsableContent(normalizeIngestion({})), false);
});

test("normalizePersona validates values", () => {
  assert.equal(normalizePersona("new_grad"), "new_grad");
  assert.equal(normalizePersona("SENIOR_ENGINEER"), "senior_engineer");
  assert.equal(normalizePersona("wizard"), null);
  assert.equal(normalizePersona(undefined), null);
});

test("parseNarration reads a well-formed sections object", () => {
  const raw = JSON.stringify({
    sections: [
      { title: "Overview", script: "Welcome aboard. Here's the gist." },
      { title: "The API", script: "So the API layer lives in server.js." },
    ],
  });
  const out = parseNarration(raw);
  assert.equal(out.sections.length, 2);
  assert.equal(out.sections[0].title, "Overview");
  assert.ok(out.sections[0].word_count > 0);
  assert.ok(out.sections[0].char_count > 0);
});

test("parseNarration tolerates code fences and a bare array", () => {
  const fenced = "```json\n{\"sections\":[{\"title\":\"A\",\"script\":\"Hi there.\"}]}\n```";
  assert.equal(parseNarration(fenced).sections.length, 1);
  const bare = "[{\"title\":\"A\",\"script\":\"Hi there.\"}]";
  assert.equal(parseNarration(bare).sections.length, 1);
});

test("parseNarration throws on non-JSON / empty sections", () => {
  assert.throws(() => parseNarration("not json at all"));
  assert.throws(() => parseNarration(JSON.stringify({ sections: [] })));
});

test("capScript enforces the HeyGen hard cap at a sentence boundary", () => {
  const long = ("This is a sentence. ").repeat(200); // ~4000 chars
  const capped = capScript(long);
  assert.ok(capped.length <= SECTION_CHAR_HARDCAP);
  assert.ok(capped.endsWith("."));
});

test("countWords counts words with contractions", () => {
  assert.equal(countWords("It's a well-structured app."), 4);
});

test("buildChunks + retrieve surfaces the most relevant key file", () => {
  const payload = {
    key_files: [
      { path: "src/auth.js", content: "function verifyJwtToken(token) { return jwt.verify(token); }" },
      { path: "src/db.js", content: "const db = new Database('todos.db'); export default db;" },
    ],
  };
  const chunks = buildChunks(payload);
  assert.ok(chunks.length >= 2);
  const hits = retrieve(chunks, "how does jwt token verification work?");
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].path, "src/auth.js");
});

test("retrieve returns empty when nothing matches", () => {
  const chunks = buildChunks({
    key_files: [{ path: "a.js", content: "export const x = 1;" }],
  });
  assert.deepEqual(retrieve(chunks, "zzzznomatch quxblah"), []);
});
