// Ad-hoc integration test for the RAG /chat feature (chunking + BM25 + Claude).
// Runs in-process so it doesn't depend on the Gemini /explain path succeeding.
// Usage: node scripts/chat-itest.mjs <ingestion.json>
import { readFile } from "node:fs/promises";
import { buildChunks, answerQuestion } from "../src/rag.js";
import { setChunks } from "../src/chunkStore.js";
import { activeChatModel } from "../src/chatLlm.js";

const path = process.argv[2];
const payload = JSON.parse(await readFile(path, "utf8"));
const repo_url = payload.repo_url || payload.repoUrl || "test://repo";
payload.repo_url = repo_url;

const chunks = buildChunks(payload);
setChunks(repo_url, chunks);
console.log(`chat model: ${activeChatModel()}`);
console.log(`built ${chunks.length} chunks for ${repo_url}`);
console.log(`paths: ${[...new Set(chunks.map((c) => c.path))].join(", ")}\n`);

const scenarios = [
  { label: "STRUCTURAL", question: "where is authentication / CORS origin handling implemented?" },
  { label: "WHAT-DOES-X-DO", question: "what does the main index file do?" },
  { label: "UNANSWERABLE", question: "does this project include a payment or billing system?" },
];

const history = [];
for (const s of scenarios) {
  const r = await answerQuestion({ repo_url, question: s.question, history });
  console.log(`### ${s.label}: ${s.question}`);
  console.log(`answer: ${r.answer}`);
  console.log(`sources: ${JSON.stringify(r.sources)}`);
  console.log(`model: ${r.model}\n`);
  history.push({ role: "user", content: s.question });
  history.push({ role: "assistant", content: r.answer });
}

// History-dependent follow-up (relies on the prior turn's topic).
const follow = { label: "HISTORY FOLLOW-UP", question: "what about how it's configured — where are its options set?" };
const rf = await answerQuestion({ repo_url, question: follow.question, history });
console.log(`### ${follow.label}: ${follow.question}`);
console.log(`answer: ${rf.answer}`);
console.log(`sources: ${JSON.stringify(rf.sources)}`);
console.log(`model: ${rf.model}`);
