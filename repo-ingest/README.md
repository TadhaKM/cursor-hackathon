# repo-ingest

A small standalone HTTP service that ingests a public GitHub repository and
returns a compact, **token-budgeted** JSON summary suitable for feeding into an
LLM. It pulls the file tree, README, key entry-point files, recent commits, and
recent merged PRs via the GitHub REST API, then trims everything to stay under
~15,000 tokens (~60,000 characters).

Built with **Node.js + Express + [@octokit/rest]**.

## Endpoints

### `POST /ingest`

Request body:

```json
{ "repo_url": "https://github.com/owner/repo" }
```

`repo_url` accepts a full GitHub URL (with or without `.git` / trailing slash)
or the `owner/repo` shorthand.

### `GET /health`

Returns `{ "status": "ok", "authenticated": true|false, "cache_size": N }`.

---

## Setup

```bash
cd repo-ingest
npm install
cp .env.example .env          # then edit .env and paste your GITHUB_TOKEN
npm start                     # or: npm run dev  (auto-reload)
```

The server listens on `PORT` (default `3000`).

### Getting and setting a `GITHUB_TOKEN`

Without a token you are limited to **60 requests/hour**; with one you get
**5,000 requests/hour** (and access to private repos the token can read). A
single `/ingest` call makes several API requests, so a token is strongly
recommended.

1. Go to **https://github.com/settings/tokens**.
2. Create a token:
   - **Fine-grained** (recommended): *Generate new token* → grant
     *Repository access* → *Public Repositories (read-only)*. No extra
     permissions are needed for public repos. To ingest a **private** repo,
     give the token access to that repo with **Contents: Read-only**.
   - **Classic**: *Generate new token (classic)*. For public repos you can
     leave **all scopes unchecked**; for private repos check **`repo`**.
3. Copy the token (`ghp_…` / `github_pat_…`).
4. Set it as an environment variable. Either put it in `.env`:

   ```bash
   # repo-ingest/.env
   GITHUB_TOKEN=ghp_your_token_here
   ```

   …or export it in your shell:

   ```bash
   # macOS / Linux / Git Bash
   export GITHUB_TOKEN=ghp_your_token_here

   # Windows PowerShell
   $env:GITHUB_TOKEN = "ghp_your_token_here"
   ```

Verify it's picked up: `GET /health` should report `"authenticated": true`.

---

## Test it locally

Start the server (`npm start`), then in another terminal:

```bash
curl -X POST http://localhost:3000/ingest \
  -H "Content-Type: application/json" \
  -d '{"repo_url": "https://github.com/sindresorhus/slugify"}'
```

Health check:

```bash
curl http://localhost:3000/health
```

A bundled smoke test hits a small, medium, and large repo and prints output
sizes; an offline unit test covers URL parsing and error translation:

```bash
node test.js          # requires the server running (set BASE_URL if not :3111)
node test-errors.js   # no network / no server needed
```

---

## Successful response shape

The first six fields match the required shape exactly. `recent_prs`, `meta`,
and `cached` are **extra** fields — `recent_prs` holds the 5 most recent merged
PRs (title + description), `meta` is diagnostic info, and `cached` indicates
whether the response came from the in-memory cache.

Below is a **real, trimmed** response for
`https://github.com/sindresorhus/slugify` (long strings elided with `…[snipped]`
for readability — in an actual response they are full text up to the budget):

```json
{
  "repo_url": "https://github.com/sindresorhus/slugify",
  "file_tree": ".editorconfig\n.gitattributes\n.github/security.md\n.github/workflows/main.yml\n.gitignore\n.npmrc\nindex.d.ts\nindex.js\nlicense\noverridable-replacements.js\npackage.json\nreadme.md\ntest.js",
  "readme": "# slugify\n\n> Slugify a string\n\nUseful for URLs, filenames, and IDs. …[snipped]",
  "key_files": [
    {
      "path": "index.js",
      "content": "import escapeStringRegexp from 'escape-string-regexp'; …[snipped]"
    }
  ],
  "recent_commits": [
    { "message": "3.0.0", "date": "2025-09-11T12:11:41Z" },
    { "message": "Add `transliterate` option", "date": "2025-09-11T10:20:39Z" },
    { "message": "Add `locale` option", "date": "2025-09-11T10:00:34Z" }
  ],
  "package_manifest": "{\n\t\"name\": \"@sindresorhus/slugify\",\n\t\"version\": \"3.0.0\", …[snipped]",

  "recent_prs": [
    {
      "title": "Perform contraction/possession replacement before main pattern replacement",
      "description": "This aims to fix #72 by performing the replacement …",
      "merged_at": "2023-05-17T11:12:50Z"
    }
  ],
  "meta": {
    "owner": "sindresorhus",
    "repo": "slugify",
    "default_branch": "main",
    "files_indexed": 13,
    "tree_truncated": false,
    "approx_chars": 11100
  },
  "cached": false
}
```

---

## What gets fetched

- **File tree** — recursive git tree, excluding `node_modules`, `.git`, `dist`,
  `build` (and `.next`, `out`, `vendor`, `__pycache__`, `venv`, `coverage`, …)
  plus binary files (images, fonts, archives, media, compiled artifacts).
- **README** — raw content of the repo's README.
- **Key files** — the package manifest (`package.json` → `requirements.txt` →
  `pyproject.toml`), common entry points (`main.py`, `app.py`, `index.js/ts`,
  and their `src/` variants), top-level source files in `/src` or `/app`, and —
  for **monorepos** — one entry point per sub-package under `packages/*`,
  `apps/*`, `libs/*`, `services/*`, `modules/*` (up to 8). Long key files are
  collapsed to their **first 50 + last 50 lines** with a
  `[...truncated N lines...]` marker, so exports at the bottom of a file are
  kept.
- **Recent commits** — the 10 most recent commit messages + dates.
- **Recent PRs** — the 5 most recent *merged* pull requests (title + description).

## Trimming / token budget

Total output is capped at ~60,000 characters. Budget is allocated in priority
order and leftover budget cascades down:

**README → package manifest → entry-point files → file tree → commit messages.**

- Oversized files/strings are truncated with a trailing `[truncated]` marker.
- For very large repos, the **file tree is depth-collapsed** before any raw
  truncation: deep directories become a single summary line such as
  `packages/react-dom/… (223 more files)`, so the tree stays legible instead of
  being cut off alphabetically. Depth is reduced (4 → 3 → 2 levels) until the
  tree fits its budget.

Measured output sizes (with the trimming above):

| Repo                                   | Files indexed | Response size |
| -------------------------------------- | ------------- | ------------- |
| `sindresorhus/slugify` (small)         | 13            | ~14,300 chars |
| `gothinkster/node-express-...` (medium)| 64            | ~8,500 chars  |
| `facebook/react` (large)               | 7,158         | ~25,600 chars |

## Error handling

Errors return a JSON body `{ "error": "...", "code": "..." }` with an
appropriate HTTP status. Rate-limit responses additionally include
`rate_limit_reset` (ISO 8601) and `rate_limit_reset_epoch`.

| Situation                              | Status | `code`         |
| -------------------------------------- | ------ | -------------- |
| Missing/invalid/malformed `repo_url`   | 400    | `INVALID_URL`  |
| Repo exists but is empty (no files)    | 400    | `EMPTY_REPO`   |
| Repo not found / private (no access)   | 404    | `NOT_FOUND`    |
| GitHub rate limit hit (403/429)        | 429    | `RATE_LIMITED` |
| Forbidden (token lacks access)         | 403    | `FORBIDDEN`    |
| Bad/missing token                      | 401    | `UNAUTHORIZED` |
| Other GitHub API failure               | 502    | `API_ERROR`    |

Example rate-limit response body:

```json
{
  "error": "GitHub API rate limit exceeded. Limit resets at 2026-07-05T10:22:54.000Z. Set a GITHUB_TOKEN to raise the limit to 5000 requests/hour.",
  "code": "RATE_LIMITED",
  "rate_limit_reset": "2026-07-05T10:22:54.000Z",
  "rate_limit_reset_epoch": 1751710974
}
```

## Caching

An in-memory TTL cache keyed by `repo_url` (default **10-minute** TTL, 100
entries, rough LRU eviction) prevents re-processing the same repo from burning
API calls during demo/testing. The second call for a repo returns in a few
milliseconds. The server logs `[cache MISS]` / `[cache HIT]` per request, and
responses carry `"cached": true|false`. Tune via `CACHE_TTL_MS` and
`CACHE_MAX_ENTRIES`.

## Known limitations

- **Very large monorepos lose file-tree detail.** Repos like `facebook/react`
  (7k+ files) have their deeper directories collapsed into
  `dir/… (N more files)` summaries to fit the budget, so individual deep file
  paths are not listed. Top-level structure and counts are preserved.
- **`key_files` favors conventional layouts.** It looks for standard entry
  points (`index.js/ts`, `main.py`, `app.py`, manifests), top-level `/src` or
  `/app` source files, and one entry point per workspace package in monorepos
  (`packages/*`, `apps/*`, …). Projects that keep their entry point somewhere
  non-standard (e.g. a custom build layout, or `source/` instead of `src/`) may
  still return an empty `key_files`.
- **Only *merged* PRs** are returned (up to 5), scanned from the 30 most
  recently-updated closed PRs. Repos with many stale closed PRs could surface
  fewer than 5 merged ones.
- **The cache is in-memory and per-process.** It is not shared across instances
  and is cleared on restart. Fine for a single Render web service; not a
  distributed cache.
- **Unauthenticated rate limit is low (60/hr).** Without `GITHUB_TOKEN` a
  handful of large-repo ingests can exhaust the quota. Set a token.
- **Token budget is character-based** (~60k chars ≈ 15k tokens), an
  approximation — exact token counts vary by tokenizer.

---

## Deploy on Render

This repo includes a `render.yaml` blueprint. Either:

1. **Blueprint**: point Render at this directory and it will read `render.yaml`.
2. **Manual**: create a new **Web Service**, set the root directory to
   `repo-ingest`, build command `npm install`, start command `npm start`.

In both cases, add a `GITHUB_TOKEN` environment variable in the Render
dashboard (it is marked `sync: false` so it is never committed). Render sets
`PORT` automatically.

[@octokit/rest]: https://github.com/octokit/rest.js
