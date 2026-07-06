import { Octokit } from "@octokit/rest";

/**
 * A thin wrapper around Octokit that exposes exactly the calls repo-ingest
 * needs, and normalizes GitHub error responses into typed errors that the
 * HTTP layer can translate into clean messages.
 */

export class GitHubError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.code = code;
    // Optional structured extras surfaced in the HTTP error body
    // (e.g. rate_limit_reset).
    this.details = details || {};
  }
}

// File extensions we treat as binary / non-text and therefore skip.
const BINARY_EXTENSIONS = new Set([
  // images
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "tiff", "svg",
  // fonts
  "woff", "woff2", "ttf", "otf", "eot",
  // archives
  "zip", "tar", "gz", "tgz", "rar", "7z", "bz2", "xz",
  // media
  "mp3", "mp4", "mov", "avi", "mkv", "wav", "flac", "webm", "ogg",
  // docs / binaries
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "exe", "dll", "so", "dylib", "bin", "o", "a", "class", "jar",
  "wasm", "node", "pyc", "pyd",
  // data blobs
  "db", "sqlite", "sqlite3", "lock",
]);

// Directory names to exclude anywhere in a path.
const EXCLUDED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out",
  "vendor", "__pycache__", ".venv", "venv", "coverage", ".cache",
]);

export function isExcludedPath(path) {
  const parts = path.split("/");
  for (const part of parts) {
    if (EXCLUDED_DIRS.has(part)) return true;
  }
  const ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "";
  if (ext && BINARY_EXTENSIONS.has(ext)) return true;
  return false;
}

/**
 * Parse an owner/repo pair out of a GitHub URL (or "owner/repo" shorthand).
 * Throws GitHubError with code INVALID_URL when it can't.
 */
export function parseRepoUrl(repoUrl) {
  if (!repoUrl || typeof repoUrl !== "string") {
    throw new GitHubError("repo_url is required and must be a string.", {
      code: "INVALID_URL",
    });
  }

  let owner;
  let repo;

  let trimmed = repoUrl.trim();

  // Accept scheme-less URLs like "github.com/owner/repo" or
  // "www.github.com/owner/repo" (a dotted host before the first slash, with no
  // scheme) by assuming https. Plain "owner/repo" shorthand has no dot, so it's
  // left for the shorthand path below.
  if (
    !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) &&
    /^[^/\s]+\.[^/\s]+\//.test(trimmed)
  ) {
    trimmed = "https://" + trimmed;
  }

  // Try to parse as a full URL first.
  try {
    const url = new URL(trimmed);
    if (!/github\.com$/i.test(url.hostname)) {
      throw new GitHubError(`Not a github.com URL: ${trimmed}`, {
        code: "INVALID_URL",
      });
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 2) {
      throw new GitHubError(`Could not find owner/repo in URL: ${trimmed}`, {
        code: "INVALID_URL",
      });
    }
    [owner, repo] = segments;
  } catch (err) {
    if (err instanceof GitHubError) throw err;
    // Not a URL — try "owner/repo" shorthand.
    const segments = trimmed.split("/").filter(Boolean);
    if (segments.length !== 2) {
      throw new GitHubError(`Invalid repo_url: ${trimmed}`, {
        code: "INVALID_URL",
      });
    }
    [owner, repo] = segments;
  }

  repo = repo.replace(/\.git$/i, "");

  if (!owner || !repo) {
    throw new GitHubError(`Invalid repo_url: ${trimmed}`, {
      code: "INVALID_URL",
    });
  }

  // Validate against GitHub's allowed characters so junk input is rejected as
  // 400 up front instead of being sent to the API as a doomed lookup.
  // Owner: alphanumerics and single hyphens, max 39 chars, no leading hyphen.
  // Repo: alphanumerics, hyphen, underscore, dot.
  const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
  const REPO_RE = /^[A-Za-z0-9._-]+$/;
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) {
    throw new GitHubError(
      `Invalid repo_url: '${trimmed}' does not resolve to a valid owner/repo.`,
      { code: "INVALID_URL" }
    );
  }

  return { owner, repo };
}

export function createClient() {
  const token = process.env.GITHUB_TOKEN;
  return new Octokit(token ? { auth: token } : {});
}

/**
 * Translate an Octokit error into a GitHubError with a friendly message.
 */
function translateError(err, { owner, repo }) {
  const status = err?.status;
  const slug = `${owner}/${repo}`;

  if (status === 404) {
    return new GitHubError(
      `Repository '${slug}' was not found. It may be private, renamed, or misspelled. ` +
        `If it is private, ensure GITHUB_TOKEN has access to it.`,
      { status, code: "NOT_FOUND" }
    );
  }

  if (status === 403 || status === 429) {
    // Distinguish rate limiting from other forbidden responses.
    const remaining = err?.response?.headers?.["x-ratelimit-remaining"];
    const isRateLimited =
      remaining === "0" ||
      /rate limit/i.test(err?.message || "") ||
      status === 429;
    if (isRateLimited) {
      const reset = err?.response?.headers?.["x-ratelimit-reset"];
      const resetIso = reset
        ? new Date(Number(reset) * 1000).toISOString()
        : null;
      const resetHint = resetIso ? ` Limit resets at ${resetIso}.` : "";
      return new GitHubError(
        `GitHub API rate limit exceeded.${resetHint} ` +
          `Set a GITHUB_TOKEN to raise the limit to 5000 requests/hour.`,
        {
          status,
          code: "RATE_LIMITED",
          details: {
            rate_limit_reset: resetIso,
            rate_limit_reset_epoch: reset ? Number(reset) : null,
          },
        }
      );
    }
    return new GitHubError(
      `Access to '${slug}' is forbidden. Check that GITHUB_TOKEN has permission to read it.`,
      { status, code: "FORBIDDEN" }
    );
  }

  if (status === 401) {
    return new GitHubError(
      `GitHub authentication failed. The GITHUB_TOKEN is missing or invalid.`,
      { status, code: "UNAUTHORIZED" }
    );
  }

  return new GitHubError(
    `GitHub API error while accessing '${slug}': ${err?.message || "unknown error"}`,
    { status, code: "API_ERROR" }
  );
}

export async function getRepo(octokit, { owner, repo }) {
  try {
    const { data } = await octokit.repos.get({ owner, repo });
    return data;
  } catch (err) {
    throw translateError(err, { owner, repo });
  }
}

/**
 * Fetch the recursive git tree for a branch. Returns an array of
 * { path, type, size } for blobs only, with excluded paths removed.
 */
export async function getTree(octokit, { owner, repo, branch }) {
  try {
    const { data } = await octokit.git.getTree({
      owner,
      repo,
      tree_sha: branch,
      recursive: "true",
    });
    const blobs = (data.tree || []).filter(
      (node) => node.type === "blob" && !isExcludedPath(node.path)
    );
    return { entries: blobs, truncated: Boolean(data.truncated) };
  } catch (err) {
    throw translateError(err, { owner, repo });
  }
}

export async function getReadme(octokit, { owner, repo }) {
  try {
    const { data } = await octokit.repos.getReadme({
      owner,
      repo,
      mediaType: { format: "raw" },
    });
    // With format: raw, data is the raw string content.
    return typeof data === "string" ? data : "";
  } catch (err) {
    if (err?.status === 404) return ""; // No README is not fatal.
    throw translateError(err, { owner, repo });
  }
}

/**
 * Fetch a single file's decoded text content. Returns null if the file does
 * not exist or is too large / not text.
 */
export async function getFileContent(octokit, { owner, repo, path }) {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path });
    if (Array.isArray(data)) return null; // It's a directory.
    if (data.type !== "file") return null;
    if (!data.content) return null; // Too large; GitHub omits inline content.
    const decoded = Buffer.from(data.content, "base64").toString("utf-8");
    return decoded;
  } catch (err) {
    if (err?.status === 404) return null;
    if (err?.status === 403) throw translateError(err, { owner, repo });
    return null;
  }
}

export async function getRecentCommits(octokit, { owner, repo, count = 10 }) {
  try {
    const { data } = await octokit.repos.listCommits({
      owner,
      repo,
      per_page: count,
    });
    return data.map((c) => ({
      message: c.commit?.message || "",
      date: c.commit?.author?.date || c.commit?.committer?.date || "",
    }));
  } catch (err) {
    if (err?.status === 409) return []; // Empty repository.
    throw translateError(err, { owner, repo });
  }
}

/**
 * Fetch the diff between two refs (branches, tags, or commit SHAs) via
 * GitHub's compare API. Returns the raw comparison — file-level trimming
 * happens in diff.js, matching how ingest.js trims getTree()'s raw output.
 */
export async function getCompare(octokit, { owner, repo, base, head }) {
  try {
    const { data } = await octokit.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${base}...${head}`,
    });
    return {
      ahead_by: data.ahead_by,
      behind_by: data.behind_by,
      total_commits: data.total_commits,
      commits: (data.commits || []).map((c) => ({
        message: c.commit?.message || "",
        date: c.commit?.author?.date || c.commit?.committer?.date || "",
      })),
      files: (data.files || []).map((f) => ({
        path: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        patch: f.patch || null, // null for binary/too-large files
      })),
    };
  } catch (err) {
    if (err?.status === 404) {
      throw new GitHubError(
        `Could not compare '${base}...${head}' on '${owner}/${repo}' — check that both refs exist.`,
        { status: 404, code: "NOT_FOUND" }
      );
    }
    throw translateError(err, { owner, repo });
  }
}

export async function getRecentMergedPRs(octokit, { owner, repo, count = 5 }) {
  try {
    const { data } = await octokit.pulls.list({
      owner,
      repo,
      state: "closed",
      sort: "updated",
      direction: "desc",
      per_page: 30,
    });
    return data
      .filter((pr) => pr.merged_at)
      .slice(0, count)
      .map((pr) => ({
        title: pr.title || "",
        description: pr.body || "",
        merged_at: pr.merged_at,
      }));
  } catch (err) {
    if (err?.status === 404) return []; // PRs disabled / none.
    return [];
  }
}
