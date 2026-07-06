# repo-explainer

Stage 2 of the Redio pipeline.

Takes the **ingestion output** (file tree, README, key files, recent commits,
package manifest) and calls an LLM via **OpenRouter** (OpenAI-compatible) to
produce three things:

1. **Architecture summary** — a concrete markdown write-up of what the project
   is, its main modules, how requests flow, and notable conventions.
2. **Narration script** — the architecture summary rewritten as a friendly,
   *spoken* walkthrough, split into sections, ready to be read aloud by HeyGen.
   This is the demo-critical output.
3. **Mermaid diagram** (optional) — a flowchart of the main modules and how they
   depend on each other, validated before it's returned.

## Setup

```bash
cd services/repo-explainer
npm install
cp .env.example .env      # then paste your OPENROUTER_API_KEY
npm start                 # boots on http://localhost:8787
```

Environment variables (see `.env.example`):

| Var                     | Default                        | Notes                                                    |
| ----------------------- | ------------------------------ | -------------------------------------------------------- |
| `OPENROUTER_API_KEY`    | —                              | **Required.** Get one at https://openrouter.ai/keys      |
| `OPENROUTER_BASE_URL`   | `https://openrouter.ai/api/v1` | Any OpenAI-compatible endpoint works.                    |
| `OPENROUTER_MODEL`      | `google/gemini-2.5-flash`      | Any OpenRouter model id.                                 |
| `OPENROUTER_MAX_TOKENS` | `8000`                         | Completion cap — **required on OpenRouter's free tier**. |
| `OPENROUTER_TIMEOUT_MS` | `90000`                        | Per call (3 sequential calls).                           |
| `REFINE_NARRATION`      | `false`                        | Extra resize call per off-range section (see below).     |
| `PORT`                  | `8787`                         | HTTP port.                                               |

> The LLM client is provider-agnostic OpenAI-compatible, so the legacy
> `GEMINI_*` / `QWEN_*` env names still work as fallbacks. Point it at any
> provider by setting the base URL, model, and key.

## API

### `POST /explain`

Body: the ingestion JSON, optionally with a `persona` field.

```jsonc
{
  "file_tree": ["src/server.js", "src/routes/auth.js", "..."],
  "readme": "# TodoAPI ...",
  "key_files": [{ "path": "src/server.js", "content": "..." }],
  "recent_commits": [{ "sha": "a1b2c3d", "author": "Dana", "message": "Add auth" }],
  "package_manifest": { "name": "todo-api", "dependencies": { "express": "^4" } },
  "persona": "new_grad"            // optional: "new_grad" | "senior_engineer"
}
```

Field shapes are flexible: `file_tree` may be an array of paths or a string;
`key_files` may be an array of `{path, content}` or a `{path: content}` map;
`recent_commits` may be objects or plain strings. Both `snake_case` and
`camelCase` keys are accepted.

Response:

```jsonc
{
  "architecture_summary": "## Overview\n...",       // markdown
  "narration_script": {
    "sections": [
      { "title": "Overview", "script": "So, welcome aboard...", "caption": "...", "node_ids": ["server"], "word_count": 178, "char_count": 1043 },
      { "title": "The API layer", "script": "...", "word_count": 165, "char_count": 980 }
    ]
  },
  "mermaid_diagram": "graph TD\n  A[server.js] --> B[routes]",  // string | null
  "meta": { "persona": "new_grad", "model": "google/gemini-2.5-flash", "elapsed_ms": 12873, "section_count": 4 }
}
```

Query/body flags:

- `?diagram=false` (or `"include_diagram": false` in the body) skips the mermaid
  call — handy while iterating on narration.

#### Full worked example

Request (`examples/sample-ingestion.json`, a JWT-auth Express + SQLite API — see
the file for the complete body):

```bash
curl -X POST http://localhost:8787/explain \
  -H 'Content-Type: application/json' \
  --data @examples/sample-ingestion.json
```

Response (illustrative — section text abbreviated; shape is exact):

```jsonc
{
  "architecture_summary": "## Overview\nTodoAPI is a small REST service for managing todos behind JWT auth...\n\n## Modules\n- **src/server.js** wires Express, mounts `/auth` and a guarded `/todos`...",
  "narration_script": {
    "sections": [
      {
        "title": "Overview",
        "script": "Hey, welcome to the team! Let me walk you through TodoAPI. It's a small REST service that lets people manage their to-do items, and everything's locked behind a login so your todos stay yours...",
        "word_count": 118,
        "char_count": 690
      },
      {
        "title": "The entry point: server.js",
        "script": "So server.js is the front door. When the app boots, it spins up Express, turns on JSON parsing, and then mounts two groups of routes...",
        "word_count": 132,
        "char_count": 760
      }
    ]
  },
  "mermaid_diagram": "graph TD\n  A[server.js] --> B[auth routes]\n  A --> C[requireAuth]\n  C --> D[todo routes]\n  D --> E[db/index.js]\n  B --> E",
  "meta": { "persona": "new_grad", "model": "google/gemini-2.5-flash", "elapsed_ms": 14231, "section_count": 4 }
}
```

> The narration text above is representative of the tuned prompt's style;
> `word_count`/`char_count` are computed server-side.

### `POST /explain-diff`

Same as `/explain`, but narrates **what changed** between two refs instead of the
whole repo (paired with repo-ingest's `/diff`).

### `POST /chat` (RAG chat)

Ask follow-up questions about a repo **after** it's been through `/explain`.
`/explain` chunks the repo (code split on function/class/export boundaries,
README split by header, plus the file tree as one chunk) and stores those chunks
in memory keyed by `repo_url` (`src/chunkStore.js`). `/chat` ranks the chunks
against the question with **BM25** (no embeddings, no external call), takes the
top 5, and asks the LLM to answer **grounded only in those excerpts**.

Chat runs on **Anthropic Claude** (default `claude-sonnet-5`) when
`ANTHROPIC_API_KEY` is set; otherwise it falls back to OpenRouter
(`OPENROUTER_CHAT_MODEL`, default `openrouter/free`).

Body:

```jsonc
{
  "repo_url": "https://github.com/sindresorhus/slugify",   // required — must match a repo already /explain'd
  "question": "what does slugifyWithCounter do?",           // required
  "history": [                                              // optional — last few turns for follow-ups
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ]
}
```

Response:

```jsonc
{
  "answer": "slugifyWithCounter() returns a stateful slugify that appends -2, -3 … for duplicate inputs, and exposes reset() to clear the counter.",
  "sources": ["README", "index.js"],   // distinct file paths behind the retrieved chunks
  "meta": { "model": "claude-sonnet-5" }
}
```

**Errors / behavior**

| Situation                                        | Status | `kind`        |
| ------------------------------------------------ | ------ | ------------- |
| `repo_url` not yet processed (no chunks)         | `404`  | `not_found`   |
| Empty / missing `question` or `repo_url`         | `400`  | `bad_request` |
| Rate limited (429) after one backoff+retry       | `429`  | `rate_limit`  → "Chat is busy right now, try again in a moment." |
| Chat call exceeds the 20s cap                    | `504`  | `timeout`     |
| Zero relevant chunks retrieved                   | `200`  | model is told to say it couldn't find relevant context rather than guess |

Rate-limit handling: a single 429 is retried once after a ~1.5s backoff, then it
fails gracefully with the friendly "busy" message. On OpenRouter, if the primary
free model is unavailable it retries against `OPENROUTER_CHAT_FALLBACK_MODEL`.

**Known limitations:** the chunk store is in-memory (per process, ~50 repos LRU),
so restarting the service or asking a different instance requires re-running
`/explain`. Retrieval is keyword BM25 (with light prefix expansion), not semantic
embeddings, so purely conceptual questions with no shared vocabulary may miss.

### `GET /health`

Returns `{ ok, service, model, apiKeyConfigured }`.

## How it works

Three sequential chat-completions calls (`src/explain.js`):

1. `buildArchitectureMessages` → architecture summary.
2. `buildNarrationMessages` → narration JSON. Parsed, then optionally
   **word-count validated** (`REFINE_NARRATION=true`): any section outside
   100–250 words gets one targeted resize call. This is **off by default** to
   conserve rate-limited free-tier quota — every section is still hard-capped to
   a HeyGen-safe length regardless.
3. `buildMermaidMessages` → mermaid. Output is validated (`src/mermaid.js`); if
   it isn't parseable, it retries **once** with a stricter prompt, and is
   **omitted** (`null`) rather than sending broken syntax downstream.

Each call has a 90s timeout (`src/geminiClient.js`), plus dedicated retry budgets
for **429** (rate limit — waits for the quota bucket to refill) and **503**
(overload — exponential backoff).

## Errors

All failures return clean JSON — `{ "error": string, "kind": string }` — never a
stack trace or HTML.

| Situation                                    | Status | `kind`        |
| -------------------------------------------- | ------ | ------------- |
| Malformed JSON body / non-object / empty     | `400`  | `bad_request` |
| Ingestion had no usable content              | `400`  | `bad_request` |
| Body too large (>10mb)                       | `413`  | `bad_request` |
| No API key set                               | `500`  | `config`      |
| LLM auth error (bad key) — logged loudly     | `500`  | `auth`        |
| LLM call timed out                           | `504`  | `timeout`     |
| LLM rate limited (429)                       | `429`  | `rate_limit`  |
| Other upstream LLM failure                   | `502`  | `upstream`    |

The mermaid step never fails the request — an invalid diagram is returned as
`null`.

### Personas

- **`new_grad`** — leans into *why* patterns exist and defines jargon.
- **`senior_engineer`** — skips the basics and flags what's *nonstandard*.
- Omitted — a balanced default.

### HeyGen length limits

HeyGen caps a single avatar script at **5,000 characters** (~3 min). Sections
target **150–200 words** (~60–90s), and are hard-capped at **1,800 characters**
at a sentence boundary, so no section can overflow HeyGen.

## Testing

```bash
npm test                    # offline unit tests (no API key needed)
npm run smoke               # full pipeline against the real LLM (needs OPENROUTER_API_KEY)
npm run smoke -- path/to/ingestion.json
npm run quality             # narration quality pass over all fixtures (needs OPENROUTER_API_KEY)
```

Fixtures for the quality pass live in `examples/`:

- `sample-ingestion.json` — web app with JWT auth (Express + SQLite)
- `cli-tool.json` — an image-resizing CLI tool
- `data-pipeline.json` — a Kafka → Postgres ETL pipeline

`npm run quality` runs `/explain` against each and flags three narration failure
modes: doc-like phrasing ("this module contains…"), narration too generic to
reference real file names, and sections with a wildly uneven word-count spread.

## Running against the live ingestion service

`scripts/from-ingest.js` fetches real ingestion output from repo-ingest and pipes
it straight into the pipeline, so you can confirm narration quality holds on real
repos:

```bash
INGEST_URL=http://localhost:3000/repo-summary-input \
OPENROUTER_API_KEY=sk-or-... \
node scripts/from-ingest.js https://github.com/owner/repo
```
