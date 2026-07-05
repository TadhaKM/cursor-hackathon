/**
 * Dead-simple in-memory TTL cache keyed by repo_url. Good enough for
 * demo/testing so repeated ingests of the same repo don't burn API calls.
 */
export class TTLCache {
  constructor({ ttlMs = 10 * 60 * 1000, maxEntries = 100 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.store = new Map();
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    // Refresh recency for a rough LRU.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    // Evict oldest entries beyond the cap.
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      this.store.delete(oldest);
    }
  }

  has(key) {
    return this.get(key) !== undefined;
  }
}
