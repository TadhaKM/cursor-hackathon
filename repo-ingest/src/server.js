import "dotenv/config";
import express from "express";
import { ingestRepo, GitHubError } from "./ingest.js";
import { getDiff } from "./diff.js";
import { TTLCache } from "./cache.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

// Permissive CORS so the frontend (Person 3's UI) can call this service
// directly from the browser, matching the pipeline contract.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const cache = new TTLCache({
  ttlMs: Number(process.env.CACHE_TTL_MS) || 10 * 60 * 1000,
  maxEntries: Number(process.env.CACHE_MAX_ENTRIES) || 100,
});

// Map GitHubError codes to HTTP status codes.
const CODE_TO_STATUS = {
  INVALID_URL: 400,
  EMPTY_REPO: 400,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  FORBIDDEN: 403,
  UNAUTHORIZED: 401,
  API_ERROR: 502,
  INVALID_REFS: 400,
  EMPTY_DIFF: 400,
};

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    authenticated: Boolean(process.env.GITHUB_TOKEN),
    cache_size: cache.store.size,
  });
});

// Shared ingest handler used by both the POST and GET routes.
async function handleIngest(repoUrl, res) {
  if (!repoUrl || typeof repoUrl !== "string") {
    return res.status(400).json({
      error: "Missing or invalid repo URL.",
      code: "INVALID_URL",
    });
  }

  const cacheKey = repoUrl.trim();
  const cached = cache.get(cacheKey);
  if (cached) {
    console.log(`[cache HIT]  ${cacheKey} (serving cached response)`);
    return res.json({ ...cached, cached: true });
  }

  try {
    console.log(`[cache MISS] ${cacheKey} (fetching fresh from GitHub)`);
    const result = await ingestRepo(repoUrl);
    cache.set(cacheKey, result);
    return res.json({ ...result, cached: false });
  } catch (err) {
    if (err instanceof GitHubError) {
      const status = CODE_TO_STATUS[err.code] || 502;
      const body = { error: err.message, code: err.code };
      // Surface any structured extras (e.g. rate_limit_reset).
      if (err.details && Object.keys(err.details).length > 0) {
        Object.assign(body, err.details);
      }
      return res.status(status).json(body);
    }
    console.error("Unexpected error during ingest:", err);
    return res.status(500).json({
      error: "Internal server error while ingesting repository.",
      code: "INTERNAL_ERROR",
    });
  }
}

// Native contract: POST /ingest { repo_url }
app.post("/ingest", (req, res) => {
  const repoUrl = (req.body || {}).repo_url;
  return handleIngest(repoUrl, res);
});

// Pipeline contract (root README / Person 2 & the frontend):
//   GET /repo-summary-input?url=https://github.com/owner/repo
// Returns the identical ingestion JSON so the explainer/frontend can consume it.
app.get("/repo-summary-input", (req, res) => {
  const repoUrl = req.query.url || req.query.repo_url;
  return handleIngest(repoUrl, res);
});

// Diff mode: POST /diff { repo_url, base_ref, head_ref }
// Returns a trimmed diff (changed files + patches, prioritized by size) for
// repo-explainer's diff-narration endpoint to consume, instead of a full
// repo snapshot.
app.post("/diff", async (req, res) => {
  const { repo_url: repoUrl, base_ref: baseRef, head_ref: headRef } = req.body || {};

  const cacheKey = `diff:${repoUrl}:${baseRef}...${headRef}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    console.log(`[cache HIT]  ${cacheKey}`);
    return res.json({ ...cached, cached: true });
  }

  try {
    console.log(`[cache MISS] ${cacheKey} (fetching diff from GitHub)`);
    const result = await getDiff(repoUrl, baseRef, headRef);
    cache.set(cacheKey, result);
    return res.json({ ...result, cached: false });
  } catch (err) {
    if (err instanceof GitHubError) {
      const status = CODE_TO_STATUS[err.code] || 502;
      const body = { error: err.message, code: err.code };
      if (err.details && Object.keys(err.details).length > 0) {
        Object.assign(body, err.details);
      }
      return res.status(status).json(body);
    }
    console.error("Unexpected error during diff:", err);
    return res.status(500).json({
      error: "Internal server error while fetching diff.",
      code: "INTERNAL_ERROR",
    });
  }
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`repo-ingest listening on port ${port}`);
  if (!process.env.GITHUB_TOKEN) {
    console.warn(
      "Warning: GITHUB_TOKEN is not set. You will be limited to 60 unauthenticated requests/hour."
    );
  }
});

export { app };
