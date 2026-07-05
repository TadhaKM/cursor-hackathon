import {
  createClient,
  parseRepoUrl,
  getRepo,
  getTree,
  getReadme,
  getFileContent,
  getRecentCommits,
  getRecentMergedPRs,
  GitHubError,
} from "./github.js";

// Rough budget: ~15,000 tokens ≈ 60,000 characters of text content.
const CHAR_BUDGET = 60_000;

// Per-section caps so no single section can starve the others. These are
// applied in priority order; leftover budget cascades down.
const SECTION_CAPS = {
  readme: 20_000,
  packageManifest: 8_000,
  keyFiles: 20_000,
  fileTree: 10_000,
  commits: 4_000,
};

// Candidate entry-point / manifest files, in priority order.
const MANIFEST_FILES = ["package.json", "requirements.txt", "pyproject.toml"];
const ENTRY_POINT_FILES = [
  "main.py",
  "app.py",
  "index.js",
  "index.ts",
  "src/index.js",
  "src/index.ts",
  "src/main.py",
  "src/app.py",
];

function truncate(text, limit) {
  if (text == null) return "";
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(0, limit)) + "\n\n[truncated]";
}

/**
 * For files longer than maxLines, keep the first headLines and last tailLines
 * with a marker in between. Entry-point files often declare their public
 * exports at the bottom, so preserving the tail keeps that context.
 *
 * When maxChars is given and the head+tail excerpt still exceeds it, the head
 * and tail are trimmed proportionally (keeping the *end* of the tail) so the
 * exports at the bottom survive a tight per-file budget rather than being
 * chopped off.
 */
function truncateByLines(
  text,
  { maxLines = 300, headLines = 50, tailLines = 50, maxChars = Infinity } = {}
) {
  if (text == null) return "";
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return text.length <= maxChars ? text : truncate(text, maxChars);
  }
  let head = lines.slice(0, headLines).join("\n");
  let tail = lines.slice(-tailLines).join("\n");
  const omitted = lines.length - headLines - tailLines;
  const marker = `\n\n[...truncated ${omitted} lines...]\n\n`;
  const budget = maxChars - marker.length;
  if (Number.isFinite(budget) && head.length + tail.length > budget) {
    const half = Math.max(0, Math.floor(budget / 2));
    if (head.length > half) head = head.slice(0, half);
    if (tail.length > half) tail = tail.slice(tail.length - half); // keep end
  }
  return `${head}${marker}${tail}`;
}

/**
 * Build a compact text representation of the file tree.
 *
 * When maxDepth is finite, paths deeper than maxDepth are collapsed into a
 * per-directory summary line ("src/foo/… (N more files)") so that very large
 * monorepos still yield a legible tree instead of an alphabetically-truncated
 * slice.
 */
function renderFileTree(entries, maxDepth = Infinity) {
  const lines = new Set();
  const collapsed = new Map(); // prefix -> count of files below it

  for (const e of entries) {
    const parts = e.path.split("/");
    if (parts.length <= maxDepth) {
      lines.add(e.path);
    } else {
      const prefix = parts.slice(0, maxDepth).join("/");
      collapsed.set(prefix, (collapsed.get(prefix) || 0) + 1);
    }
  }

  const out = [...lines];
  for (const [prefix, count] of collapsed) {
    out.push(`${prefix}/… (${count} more files)`);
  }
  return out.sort().join("\n");
}

/**
 * Render the tree, reducing depth until it fits within `cap` characters.
 */
function renderFileTreeWithinCap(entries, cap) {
  let text = renderFileTree(entries);
  if (text.length <= cap) return text;
  for (const depth of [4, 3, 2]) {
    text = renderFileTree(entries, depth);
    if (text.length <= cap) return text;
  }
  return text; // still oversized; takeBudget() will hard-truncate as a backstop
}

/**
 * Pick top-level files inside /src or /app to include as key files.
 */
function collectSrcAppTopLevel(entries) {
  const picks = [];
  for (const e of entries) {
    const parts = e.path.split("/");
    if (
      parts.length === 2 &&
      (parts[0] === "src" || parts[0] === "app") &&
      e.path.match(/\.(js|ts|jsx|tsx|py|go|rb|java|rs|mjs|cjs)$/i)
    ) {
      picks.push(e.path);
    }
  }
  return picks;
}

// Workspace directories that typically hold sub-packages in a monorepo.
const WORKSPACE_DIRS = ["packages", "apps", "libs", "services", "modules"];

/**
 * For monorepos, pick one entry-point file per sub-package under a workspace
 * directory (packages/*, apps/*, …). Without this, repos like facebook/react
 * return an empty key_files because their entry points live in
 * packages/<name>/src/index.js rather than at the repo root.
 */
function collectMonorepoEntryPoints(entries, entryPaths, limit = 8) {
  const pkgRoots = new Set();
  const groupRe = new RegExp(`^(${WORKSPACE_DIRS.join("|")})/[^/]+`);
  for (const e of entries) {
    const m = e.path.match(groupRe);
    if (m) pkgRoots.add(m[0]); // e.g. "packages/react-dom"
  }

  const picks = [];
  for (const root of [...pkgRoots].sort()) {
    if (picks.length >= limit) break;
    // Prefer a conventional entry point within the package.
    const candidates = [
      `${root}/src/index.ts`,
      `${root}/src/index.js`,
      `${root}/index.ts`,
      `${root}/index.js`,
      `${root}/src/main.py`,
      `${root}/main.py`,
      `${root}/src/app.py`,
      `${root}/app.py`,
      `${root}/mod.rs`,
      `${root}/src/lib.rs`,
    ];
    const found = candidates.find((c) => entryPaths.has(c));
    if (found) picks.push(found);
  }
  return picks;
}

/**
 * Orchestrate all GitHub reads and assemble the trimmed response payload.
 */
export async function ingestRepo(repoUrl) {
  const { owner, repo } = parseRepoUrl(repoUrl);
  const octokit = createClient();

  const repoData = await getRepo(octokit, { owner, repo });
  const branch = repoData.default_branch;

  if (!branch || repoData.size === 0) {
    throw new GitHubError(
      `Repository '${owner}/${repo}' is empty (no files to ingest).`,
      { status: 400, code: "EMPTY_REPO" }
    );
  }

  // Fetch everything we can in parallel. Individual helpers swallow their own
  // "not found" cases, so a missing README or PR list won't fail the request.
  const [treeResult, readmeRaw, commits, prs] = await Promise.all([
    getTree(octokit, { owner, repo, branch }),
    getReadme(octokit, { owner, repo }),
    getRecentCommits(octokit, { owner, repo, count: 10 }),
    getRecentMergedPRs(octokit, { owner, repo, count: 5 }),
  ]);

  const entries = treeResult.entries;
  const entryPaths = new Set(entries.map((e) => e.path));

  // Decide which key files exist and are worth fetching.
  const manifestPath = MANIFEST_FILES.find((p) => entryPaths.has(p)) || null;
  const entryPointPaths = ENTRY_POINT_FILES.filter((p) => entryPaths.has(p));
  const srcAppPaths = collectSrcAppTopLevel(entries);
  // Fall back to per-package entry points for monorepos when the root-level
  // conventions turn up little.
  const monorepoPaths = collectMonorepoEntryPoints(entries, entryPaths);

  const keyFilePaths = [
    ...new Set([...entryPointPaths, ...srcAppPaths, ...monorepoPaths]),
  ].slice(0, 12);

  // Fetch manifest + key file contents in parallel.
  const [manifestContent, ...keyFileContents] = await Promise.all([
    manifestPath
      ? getFileContent(octokit, { owner, repo, path: manifestPath })
      : Promise.resolve(null),
    ...keyFilePaths.map((path) =>
      getFileContent(octokit, { owner, repo, path })
    ),
  ]);

  const keyFilesRaw = keyFilePaths
    .map((path, i) => ({ path, content: keyFileContents[i] }))
    .filter((f) => f.content != null && f.content.trim().length > 0);

  // ---- Trim everything to the character budget, in priority order ----
  // Priority: README > package manifest > entry point files > file tree > commits.
  let remaining = CHAR_BUDGET;

  const takeBudget = (text, sectionCap) => {
    if (!text) return "";
    const cap = Math.min(sectionCap, remaining);
    const out = truncate(text, cap);
    remaining -= out.length;
    if (remaining < 0) remaining = 0;
    return out;
  };

  const readme = takeBudget(readmeRaw, SECTION_CAPS.readme);
  const packageManifest = takeBudget(
    manifestContent || "",
    SECTION_CAPS.packageManifest
  );

  // Key files: distribute the key-file cap across the files we have.
  const keyFiles = [];
  let keyFilesRemaining = Math.min(SECTION_CAPS.keyFiles, remaining);
  for (const f of keyFilesRaw) {
    if (keyFilesRemaining <= 0) break;
    const perFileCap = Math.max(
      1_000,
      Math.floor(keyFilesRemaining / keyFilesRaw.length)
    );
    // Collapse very long files to head+tail (keeps exports at the bottom),
    // bounded by the per-file character budget so the tail survives.
    const content = truncateByLines(f.content, {
      maxLines: 300,
      headLines: 50,
      tailLines: 50,
      maxChars: Math.min(perFileCap, keyFilesRemaining),
    });
    keyFiles.push({ path: f.path, content });
    keyFilesRemaining -= content.length;
    remaining -= content.length;
    if (remaining < 0) remaining = 0;
  }

  // File tree — depth-collapse to fit the section cap, then hard-truncate as
  // a final backstop.
  const fileTreeCap = Math.min(SECTION_CAPS.fileTree, remaining);
  let fileTree = renderFileTreeWithinCap(entries, fileTreeCap);
  if (treeResult.truncated) {
    fileTree += "\n[truncated: repository tree exceeded GitHub's limit]";
  }
  fileTree = takeBudget(fileTree, SECTION_CAPS.fileTree);

  // Commits: trim messages to fit whatever budget remains.
  const commitsBudget = Math.min(SECTION_CAPS.commits, remaining);
  const recent_commits = [];
  let commitRemaining = commitsBudget;
  for (const c of commits) {
    if (commitRemaining <= 0) break;
    // Keep only the first line of long commit messages to save space.
    const firstLine = (c.message || "").split("\n")[0];
    const message = truncate(firstLine, Math.min(500, commitRemaining));
    recent_commits.push({ message, date: c.date });
    commitRemaining -= message.length;
  }

  return {
    repo_url: repoUrl,
    file_tree: fileTree,
    readme,
    key_files: keyFiles,
    recent_commits,
    package_manifest: packageManifest,
    // Extra fields beyond the required shape (the spec asks us to fetch PRs).
    recent_prs: prs,
    meta: {
      owner,
      repo,
      default_branch: branch,
      files_indexed: entries.length,
      tree_truncated: treeResult.truncated,
      approx_chars: CHAR_BUDGET - remaining,
    },
  };
}

// Exported for unit testing.
export { GitHubError, truncateByLines, collectMonorepoEntryPoints };
