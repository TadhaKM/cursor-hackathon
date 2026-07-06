// RAG over a processed repo: chunk the ingested content, rank chunks against a
// question with BM25 (no external service, no embeddings), and answer with the
// LLM grounded in the retrieved excerpts. Chunks are built during /explain and
// stored in chunkStore.js keyed by repo_url; /chat reads them back.

import { normalizeIngestion } from "./ingestion.js";
import { getChunks } from "./chunkStore.js";
import { chatComplete, ChatError } from "./chatLlm.js";

// ~4 chars/token is a good enough estimate for budgeting passages.
const CHARS_PER_TOKEN = 4;
const MIN_CHUNK_TOKENS = 300;
const MAX_CHUNK_TOKENS = 500;
const TOP_K = 5;
const MAX_HISTORY_TURNS = 6;

const estTokens = (text) => Math.ceil(text.length / CHARS_PER_TOKEN);

// A line that starts a new logical unit (function/class/component/export/…) —
// a good place to break a code passage.
const BOUNDARY_RE =
  /^\s*(export\s+)?(default\s+)?(async\s+)?(function|class|def|interface|type|enum|struct|func|module|namespace|public|private|protected|const|let|var)\b/i;

const HEADER_RE = /^#{1,6}\s/;

const STOPWORDS = new Set(
  ("the a an and or of to in is are be for on with as at by from this that it its into " +
    "how what where why when does do can i you we they will would should could what's how's")
    .split(" ")
);

function tokenize(text) {
  return (String(text).toLowerCase().match(/[a-z0-9_]+/g) || []).filter(
    (t) => t.length > 1 && !STOPWORDS.has(t)
  );
}

// Split source code into ~300-500 token passages, preferring to break on
// function/class/export boundaries and hard-capping oversized runs.
function chunkCode(content) {
  const lines = content.split("\n");
  const passages = [];
  let cur = [];
  let curTokens = 0;

  const flush = () => {
    if (cur.join("\n").trim()) passages.push(cur.join("\n"));
    cur = [];
    curTokens = 0;
  };

  for (const line of lines) {
    // Start a fresh passage at a boundary once the current one is big enough.
    if (BOUNDARY_RE.test(line) && curTokens >= MIN_CHUNK_TOKENS) flush();
    cur.push(line);
    curTokens += estTokens(line) + 1;
    if (curTokens >= MAX_CHUNK_TOKENS) flush(); // hard cap
  }
  flush();
  return passages;
}

// Split a README into one passage per markdown section (header + body).
function chunkReadme(readme) {
  const lines = readme.split("\n");
  const sections = [];
  let cur = [];
  for (const line of lines) {
    if (HEADER_RE.test(line) && cur.join("\n").trim()) {
      sections.push(cur.join("\n"));
      cur = [];
    }
    cur.push(line);
  }
  if (cur.join("\n").trim()) sections.push(cur.join("\n"));
  return sections;
}

/**
 * Build retrieval chunks from an ingestion payload.
 * @returns {{ repo_url: string, path: string, content: string, chunk_index: number }[]}
 */
export function buildChunks(payload) {
  const norm = normalizeIngestion(payload);
  const repo_url = payload?.repo_url ?? payload?.repoUrl ?? "";
  const chunks = [];
  let idx = 0;
  const add = (path, content) => {
    if (content && content.trim())
      chunks.push({ repo_url, path, content, chunk_index: idx++ });
  };

  // File tree as one searchable chunk — answers "where is X located" questions.
  add("(file tree)", norm.fileTree);
  // README split by header.
  for (const section of chunkReadme(norm.readme || "")) add("README", section);
  // Key files split on code boundaries.
  for (const file of norm.keyFiles) {
    for (const passage of chunkCode(file.content)) add(file.path, passage);
  }
  return chunks;
}

/**
 * BM25 ranking of chunks against a question. Returns the top-k chunks.
 */
export function retrieve(chunks, question, k = TOP_K) {
  if (!chunks || chunks.length === 0) return [];
  const rawQ = [...new Set(tokenize(question))];
  if (rawQ.length === 0) return [];

  // Include the file path in a chunk's searchable tokens so path-y questions
  // ("where is auth") can match on file names, not just file contents.
  const docs = chunks.map((c) => tokenize(`${c.path} ${c.content}`));
  const N = docs.length;
  const df = new Map();
  for (const doc of docs) {
    for (const t of new Set(doc)) df.set(t, (df.get(t) || 0) + 1);
  }

  // Prefix-expand the query against the corpus vocabulary so "authentication"
  // matches "auth"/"authenticate", etc. (a cheap stand-in for stemming).
  const vocab = df;
  const qTokens = new Set(rawQ);
  for (const qt of rawQ) {
    if (qt.length < 4) continue;
    for (const vt of vocab.keys()) {
      if (vt.length >= 4 && vt !== qt && (vt.startsWith(qt) || qt.startsWith(vt))) {
        qTokens.add(vt);
      }
    }
  }
  const avgdl = docs.reduce((s, d) => s + d.length, 0) / N || 1;
  const idf = (t) => {
    const n = df.get(t) || 0;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  };

  const k1 = 1.5;
  const b = 0.75;
  const scored = chunks.map((c, i) => {
    const doc = docs[i];
    const dl = doc.length;
    const tf = new Map();
    for (const t of doc) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const t of qTokens) {
      const f = tf.get(t);
      if (!f) continue;
      score += idf(t) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * dl) / avgdl)));
    }
    return { chunk: c, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((s) => s.chunk);
}

const SYSTEM_PROMPT = [
  "You are answering questions about a specific codebase for a new team member who just watched an onboarding video about it.",
  "Use ONLY the code excerpts provided below to answer — do not invent details that aren't shown.",
  "If the excerpts don't contain enough information, say so honestly and suggest what part of the repo to look at directly, rather than guessing.",
  "Reference specific file paths when relevant.",
  "Keep answers to 2-4 sentences unless the question genuinely requires more detail.",
].join(" ");

function formatHistory(history) {
  if (!Array.isArray(history) || history.length === 0) return "";
  const turns = history
    .filter((h) => h && (h.role === "user" || h.role === "assistant") && h.content)
    .slice(-MAX_HISTORY_TURNS)
    .map((h) => `${h.role === "user" ? "User" : "Assistant"}: ${String(h.content).trim()}`);
  return turns.length ? `CONVERSATION SO FAR:\n${turns.join("\n")}\n\n` : "";
}

/**
 * Answer a question about a previously-processed repo.
 * @param {{ repo_url: string, question: string, history?: {role,content}[] }} params
 * @returns {Promise<{ answer: string, sources: string[], model: string }>}
 */
export async function answerQuestion({ repo_url, question, history }) {
  if (!question || !String(question).trim()) {
    throw new ChatError("A non-empty 'question' is required.", {
      statusCode: 400,
      kind: "bad_request",
    });
  }
  if (!repo_url || !String(repo_url).trim()) {
    throw new ChatError("A 'repo_url' is required.", {
      statusCode: 400,
      kind: "bad_request",
    });
  }

  const chunks = getChunks(repo_url);
  if (!chunks || chunks.length === 0) {
    throw new ChatError(
      "This repo hasn't been processed yet. Run /explain first.",
      { statusCode: 404, kind: "not_found" }
    );
  }

  const top = retrieve(chunks, question, TOP_K);

  const contextBlock = top.length
    ? top
        .map((c) => `--- ${c.path} (chunk ${c.chunk_index}) ---\n${c.content}`)
        .join("\n\n")
    : "(no relevant code excerpts were found for this question)";

  const noContextNote = top.length
    ? ""
    : "\nNote: no relevant excerpts were found. Say you couldn't find relevant " +
      "context in the retrieved code and suggest where in the repo to look, " +
      "rather than guessing.";

  const user = [
    formatHistory(history) + `QUESTION: ${String(question).trim()}`,
    "",
    "CODE EXCERPTS:",
    contextBlock,
    noContextNote,
  ].join("\n");

  const { answer, model } = await chatComplete([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: user },
  ]);

  // Sources = the distinct file paths behind the retrieved excerpts, so they
  // line up with what the answer can cite.
  const sources = [...new Set(top.map((c) => c.path))];

  return { answer, sources, model };
}
