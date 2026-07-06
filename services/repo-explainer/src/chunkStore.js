// In-memory store of retrieval chunks, keyed by repo_url. Populated by /explain
// and read by /chat. A rough LRU cap bounds memory; for a hackathon a single
// process with a handful of repos is plenty (swap for Redis/a vector DB later).

const MAX_REPOS = 50;

/** @type {Map<string, { chunks: object[], at: number }>} */
const store = new Map();

export function setChunks(repoUrl, chunks) {
  if (!repoUrl) return;
  // Refresh recency for a rough LRU.
  store.delete(repoUrl);
  store.set(repoUrl, { chunks, at: Date.now() });
  while (store.size > MAX_REPOS) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }
}

export function getChunks(repoUrl) {
  const entry = store.get(repoUrl);
  return entry ? entry.chunks : null;
}

export function hasChunks(repoUrl) {
  return store.has(repoUrl);
}

// Exposed for tests.
export function _clear() {
  store.clear();
}
