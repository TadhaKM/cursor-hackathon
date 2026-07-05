import { chat } from "./llmClient.js";
import { normalizeIngestion } from "./ingestion.js";

// Lightweight, dependency-free RAG over the ingested key files.
//
// For a one-day hackathon a real vector store is overkill: we chunk the key
// files, score chunks against the question with a simple TF-IDF-ish keyword
// overlap, and feed the top matches to Gemini. Swappable for embeddings later.

const CHUNK_LINES = 40;
const CHUNK_OVERLAP = 8;
const TOP_K = 6;

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

/**
 * Split key files into overlapping line-based chunks.
 * @returns {{ id: string, path: string, text: string, tokens: string[] }[]}
 */
export function buildChunks(payload) {
  const norm = normalizeIngestion(payload);
  const chunks = [];
  for (const file of norm.keyFiles) {
    const lines = file.content.split("\n");
    if (lines.length <= CHUNK_LINES) {
      chunks.push(makeChunk(file.path, lines, 0));
      continue;
    }
    for (let start = 0; start < lines.length; start += CHUNK_LINES - CHUNK_OVERLAP) {
      const slice = lines.slice(start, start + CHUNK_LINES);
      chunks.push(makeChunk(file.path, slice, start));
      if (start + CHUNK_LINES >= lines.length) break;
    }
  }
  return chunks;
}

function makeChunk(path, lines, start) {
  const text = lines.join("\n");
  return {
    id: `${path}#${start + 1}`,
    path,
    text,
    tokens: tokenize(text),
  };
}

// Inverse document frequency across chunks, so common tokens count less.
function computeIdf(chunks) {
  const df = new Map();
  for (const c of chunks) {
    for (const t of new Set(c.tokens)) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }
  const n = chunks.length || 1;
  const idf = new Map();
  for (const [t, d] of df) idf.set(t, Math.log(1 + n / d));
  return idf;
}

export function retrieve(chunks, question, k = TOP_K) {
  if (chunks.length === 0) return [];
  const idf = computeIdf(chunks);
  const qTokens = new Set(tokenize(question));

  const scored = chunks.map((c) => {
    const tf = new Map();
    for (const t of c.tokens) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const t of qTokens) {
      if (tf.has(t)) score += tf.get(t) * (idf.get(t) || 0);
    }
    return { chunk: c, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((s) => s.chunk);
}

/**
 * Answer a question about the repo using retrieved key-file chunks.
 * @returns {Promise<{ answer: string, sources: string[] }>}
 */
export async function answerQuestion(payload, question) {
  if (!question || !String(question).trim()) {
    const err = new Error("A non-empty 'question' is required.");
    err.statusCode = 400;
    err.kind = "bad_request";
    throw err;
  }

  const chunks = buildChunks(payload);
  const top = retrieve(chunks, question);

  const contextBlock = top.length
    ? top.map((c) => `### ${c.id}\n${c.text}`).join("\n\n")
    : "(no matching code chunks found; answer from the README/manifest if possible)";

  const norm = normalizeIngestion(payload);
  const system = [
    "You are a helpful engineer answering questions about a specific codebase.",
    "Use ONLY the provided code excerpts, README, and manifest to answer.",
    "If the answer isn't in the provided context, say so plainly instead of guessing.",
    "Reference the file names your answer is based on. Be concise and concrete.",
  ].join("\n");

  const user = [
    `QUESTION: ${question}`,
    "",
    "README:",
    norm.readme || "(none)",
    "",
    "RELEVANT CODE EXCERPTS:",
    contextBlock,
  ].join("\n");

  const answer = await chat({ system, user, temperature: 0.3, label: "rag-chat" });

  return {
    answer,
    sources: top.map((c) => c.id),
  };
}
