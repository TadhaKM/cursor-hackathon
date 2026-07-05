// Normalizes the ingestion payload (from "Person 1") into a compact, LLM-ready
// context block. The upstream shapes are intentionally loose, so every field is
// handled defensively and truncated to keep the prompt within a sane budget.

const LIMITS = {
  fileTreeChars: 6000,
  readmeChars: 8000,
  keyFileChars: 3500, // per file
  keyFilesTotalChars: 20000,
  commits: 25,
  manifestChars: 4000,
};

function truncate(text, max, note = "truncated") {
  if (typeof text !== "string") return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... [${note}, ${text.length - max} more chars]`;
}

function asString(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeFileTree(fileTree) {
  if (!fileTree) return "";
  if (Array.isArray(fileTree)) {
    // Array of path strings or {path} objects.
    const lines = fileTree.map((entry) => {
      if (typeof entry === "string") return entry;
      return entry?.path ?? entry?.name ?? asString(entry);
    });
    return truncate(lines.join("\n"), LIMITS.fileTreeChars, "file tree truncated");
  }
  return truncate(asString(fileTree), LIMITS.fileTreeChars, "file tree truncated");
}

function normalizeKeyFiles(keyFiles) {
  if (!keyFiles) return [];
  let entries = [];

  if (Array.isArray(keyFiles)) {
    entries = keyFiles.map((f) => {
      if (typeof f === "string") return { path: "(unnamed)", content: f };
      return {
        path: f?.path ?? f?.name ?? f?.file ?? "(unnamed)",
        content: asString(f?.content ?? f?.contents ?? f?.body ?? f),
      };
    });
  } else if (typeof keyFiles === "object") {
    // Map of path -> content.
    entries = Object.entries(keyFiles).map(([path, content]) => ({
      path,
      content: asString(content),
    }));
  }

  let budget = LIMITS.keyFilesTotalChars;
  const kept = [];
  for (const entry of entries) {
    if (budget <= 0) break;
    const perFileCap = Math.min(LIMITS.keyFileChars, budget);
    const content = truncate(entry.content, perFileCap, "file truncated");
    budget -= content.length;
    kept.push({ path: entry.path, content });
  }
  return kept;
}

function normalizeCommits(recentCommits) {
  if (!recentCommits) return [];
  const arr = Array.isArray(recentCommits) ? recentCommits : [recentCommits];
  return arr.slice(0, LIMITS.commits).map((c) => {
    if (typeof c === "string") return c;
    const msg = c?.message ?? c?.subject ?? c?.title ?? asString(c);
    const author = c?.author?.name ?? c?.author ?? c?.author_name;
    const sha = c?.sha ?? c?.hash ?? c?.id;
    const short = typeof sha === "string" ? sha.slice(0, 7) : "";
    return [short, author, String(msg).split("\n")[0]]
      .filter(Boolean)
      .join(" — ");
  });
}

/**
 * @param {object} payload Raw ingestion JSON.
 * @returns {{ fileTree: string, readme: string, keyFiles: {path,content}[], commits: string[], manifest: string }}
 */
export function normalizeIngestion(payload = {}) {
  const fileTree = normalizeFileTree(
    payload.file_tree ?? payload.fileTree ?? payload.tree
  );
  const readme = truncate(
    asString(payload.readme ?? payload.README ?? payload.readme_content),
    LIMITS.readmeChars,
    "readme truncated"
  );
  const keyFiles = normalizeKeyFiles(
    payload.key_files ?? payload.keyFiles ?? payload.files
  );
  const commits = normalizeCommits(
    payload.recent_commits ?? payload.recentCommits ?? payload.commits
  );
  const manifest = truncate(
    asString(payload.package_manifest ?? payload.packageManifest ?? payload.manifest),
    LIMITS.manifestChars,
    "manifest truncated"
  );

  return { fileTree, readme, keyFiles, commits, manifest };
}

/**
 * Renders the normalized ingestion into a single context string for prompts.
 */
export function renderContext(norm) {
  const parts = [];

  parts.push("## FILE TREE");
  parts.push(norm.fileTree || "(no file tree provided)");

  parts.push("\n## README");
  parts.push(norm.readme || "(no README provided)");

  parts.push("\n## PACKAGE / DEPENDENCY MANIFEST");
  parts.push(norm.manifest || "(no manifest provided)");

  parts.push("\n## KEY FILES");
  if (norm.keyFiles.length === 0) {
    parts.push("(no key files provided)");
  } else {
    for (const file of norm.keyFiles) {
      parts.push(`\n### ${file.path}`);
      parts.push("```");
      parts.push(file.content);
      parts.push("```");
    }
  }

  parts.push("\n## RECENT COMMITS");
  parts.push(norm.commits.length ? norm.commits.map((c) => `- ${c}`).join("\n") : "(no recent commits provided)");

  return parts.join("\n");
}

/**
 * True when there is at least some signal to explain.
 */
export function hasUsableContent(norm) {
  return Boolean(
    norm.fileTree ||
      norm.readme ||
      norm.keyFiles.length ||
      norm.commits.length ||
      norm.manifest
  );
}
