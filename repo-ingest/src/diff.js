import { createClient, parseRepoUrl, getCompare, GitHubError } from "./github.js";

// Diffs are a narrower ask than a full ingest — one changed file's patch,
// not a whole repo's context — so a smaller budget than ingest.js's 60k
// still leaves plenty of room for Qwen to reason about what changed.
const CHAR_BUDGET = 40_000;
// Cap file count regardless of budget: a 200-file diff dominated by a
// generated lockfile shouldn't crowd out the files that actually matter.
const MAX_FILES = 20;

function truncate(text, limit) {
  if (text == null) return "";
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(0, limit)) + "\n\n[truncated]";
}

/**
 * Fetch and trim the diff between two refs for narration. Mirrors
 * ingest.js's shape (repo_url in, trimmed JSON out) so repo-explainer's
 * diff-narration endpoint can consume it the same way it consumes
 * ingestRepo()'s output.
 */
export async function getDiff(repoUrl, baseRef, headRef) {
  if (!baseRef || typeof baseRef !== "string" || !headRef || typeof headRef !== "string") {
    throw new GitHubError("base_ref and head_ref are both required and must be strings.", {
      status: 400,
      code: "INVALID_REFS",
    });
  }

  const { owner, repo } = parseRepoUrl(repoUrl);
  const octokit = createClient();
  const compare = await getCompare(octokit, { owner, repo, base: baseRef, head: headRef });

  if (compare.files.length === 0) {
    throw new GitHubError(`No differences found between '${baseRef}' and '${headRef}'.`, {
      status: 400,
      code: "EMPTY_DIFF",
    });
  }

  // Prioritize files with the most changes (additions + deletions) — a
  // one-line typo fix elsewhere shouldn't crowd out the file that actually
  // carries the meaningful change.
  const sortedFiles = [...compare.files].sort((a, b) => b.changes - a.changes);
  const candidates = sortedFiles.slice(0, MAX_FILES);

  let remaining = CHAR_BUDGET;
  const files = [];
  for (const f of candidates) {
    if (remaining <= 0) break;
    const perFileCap = Math.max(500, Math.floor(remaining / candidates.length));
    const patch = truncate(f.patch || "[binary or too large to diff — no patch available]", Math.min(perFileCap, remaining));
    files.push({
      path: f.path,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch,
    });
    remaining -= patch.length;
  }

  return {
    repo_url: repoUrl,
    base_ref: baseRef,
    head_ref: headRef,
    total_commits: compare.total_commits,
    commits: compare.commits.slice(0, 10),
    files,
    meta: {
      owner,
      repo,
      total_files_changed: compare.files.length,
      files_included: files.length,
      truncated: compare.files.length > files.length,
    },
  };
}

export { GitHubError };
