# repo-explainer

"Person 2" of the repo → onboarding-video pipeline.

Takes the **ingestion output** (file tree, README, key files, recent commits,
package manifest) and calls the **Google AI Studio (Gemini)** API
(OpenAI-compatible endpoint) to produce three things:

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
cp .env.example .env      # then paste your GEMINI_API_KEY
npm start                 # boots on http://localhost:8787
```

Environment variables (see `.env.example`):

| Var               | Default                                                        | Notes                                   |
| ----------------- | ------------------------------------------------------------- | --------------------------------------- |
| `GEMINI_API_KEY`    | —                                                             | **Required.** Model Studio / DashScope. |
| `GEMINI_BASE_URL`   | `https://generativelanguage.googleapis.com/v1beta/openai`      | Intl endpoint. CN drops the `-intl`.    |
| `GEMINI_MODEL`      | `gemini-2.5-flash`                                                    | `gemini-2.5-flash-lite` is faster/cheaper.          |
| `GEMINI_TIMEOUT_MS` | `30000`                                                       | Per call (3 sequential calls).          |
| `GEMINI_MAX_RETRIES`| `1`                                                          | Retries per call (2 attempts total).    |
| `PORT`            | `8787`                                                        | HTTP port.                              |

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
      { "title": "Overview", "script": "So, welcome aboard...", "word_count": 178, "char_count": 1043 },
      { "title": "The API layer", "script": "...", "word_count": 165, "char_count": 980 }
    ]
  },
  "mermaid_diagram": "graph TD\n  A[server.js] --> B[routes]",  // string | null
  "meta": { "persona": "new_grad", "model": "gemini-2.5-flash", "elapsed_ms": 12873, "section_count": 4 }
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
  "architecture_summary": "## Overview\nTodoAPI is a small REST service for managing todos behind JWT auth...\n\n## Modules\n- **src/server.js** wires Express, mounts `/auth` and a guarded `/todos`...\n- **src/middleware/auth.js** verifies the Bearer token...\n\n## Request flow\nA request hits `server.js`, passes through `requireAuth`, then the route...\n\n## Conventions\nES modules throughout; a single shared `better-sqlite3` handle in `src/db/index.js`.",
  "narration_script": {
    "sections": [
      {
        "title": "Overview",
        "script": "Hey, welcome to the team! Let me walk you through TodoAPI. It's a small REST service that lets people manage their to-do items, and everything's locked behind a login so your todos stay yours. The whole thing runs on Express, and it stores data in a lightweight SQLite file, so there's no big database to set up. The entry point is server.js, which wires everything together and decides which routes need a login. Auth lives under one folder, the todo endpoints under another, and there's a tiny database helper they both share. It's deliberately small, so you can hold the whole thing in your head. Let's start with how a request actually makes its way through the app.",
        "word_count": 118,
        "char_count": 690
      },
      {
        "title": "The entry point: server.js",
        "script": "So server.js is the front door. When the app boots, it spins up Express, turns on JSON parsing, and then mounts two groups of routes. Anything under slash-auth is open, because that's where you log in and get a token. Everything under slash-todos is wrapped in the requireAuth middleware first, so you can't touch anyone's todos without proving who you are. Keeping this wiring in one small file means you can glance at it and instantly see what's public and what's protected, which is exactly what you want on day one...",
        "word_count": 132,
        "char_count": 760
      }
    ]
  },
  "mermaid_diagram": "graph TD\n  A[server.js] --> B[auth routes]\n  A --> C[requireAuth]\n  C --> D[todo routes]\n  D --> E[db/index.js]\n  B --> E",
  "meta": { "persona": "new_grad", "model": "gemini-2.5-flash", "elapsed_ms": 14231, "section_count": 4 }
}
```

> The narration text above is representative of the tuned prompt's style;
> `word_count`/`char_count` are computed server-side and every section is kept
> within the validated 100–250 word range.

### `POST /chat` (stretch: RAG chat)

Ask questions about the repo. The service chunks `key_files`, retrieves the most
relevant chunks with a dependency-free TF-IDF keyword score, and answers with
Gemini — grounded in the actual code.

Body: the ingestion JSON plus a `question`.

```jsonc
{
  "key_files": [{ "path": "src/middleware/auth.js", "content": "..." }],
  "readme": "...",
  "question": "How does authentication work?"
}
```

Response:

```jsonc
{
  "answer": "Auth is JWT-based. src/middleware/auth.js reads the Bearer token...",
  "sources": ["src/middleware/auth.js#1"],
  "meta": { "model": "gemini-2.5-flash" }
}
```

### `GET /health`

Returns `{ ok, service, model, apiKeyConfigured }`.

## How it works

Three sequential Gemini chat-completions calls (`src/explain.js`):

1. `buildArchitectureMessages` → architecture summary.
2. `buildNarrationMessages` → narration JSON. Parsed, then **word-count
   validated**: any section outside 100–250 words gets **one targeted resize
   call** (shorten/lengthen to the 150–200 target). If it's still off after that,
   the section is kept and a warning is logged rather than failing the request.
   Every section is also hard-capped to a HeyGen-safe length.
3. `buildMermaidMessages` → mermaid. Output is validated (`src/mermaid.js`); if
   it isn't parseable, it retries **once** with a stricter prompt, and is
   **omitted** (`null`) rather than sending broken syntax downstream.

Each call has a 30s timeout and one retry (`src/geminiClient.js`).

## Errors

All failures return clean JSON — `{ "error": string, "kind": string }` — never a
stack trace or HTML.

| Situation                                   | Status | `kind`        |
| ------------------------------------------- | ------ | ------------- |
| Malformed JSON body / non-object / empty    | `400`  | `bad_request` |
| Ingestion had no usable content             | `400`  | `bad_request` |
| Body too large (>10mb)                      | `413`  | `bad_request` |
| `GEMINI_API_KEY` not set                      | `500`  | `config`      |
| Gemini auth error (bad key) — logged loudly   | `500`  | `auth`        |
| Gemini call timed out (>30s)                  | `504`  | `timeout`     |
| Other upstream Gemini failure                 | `502`  | `upstream`    |

The mermaid step never fails the request — an invalid diagram is returned as
`null`.

### Personas

- **`new_grad`** — leans into *why* patterns exist and defines jargon.
- **`senior_engineer`** — skips the basics and flags what's *nonstandard* or
  worth noting.
- Omitted — a balanced default.

### HeyGen length limits

HeyGen caps a single avatar script at **5,000 characters** (~3 min). Sections
target **150–200 words** (~60–90s, the sweet spot for pacing), are validated to
stay within **100–250 words** (with a targeted resize retry), and are hard-capped
at **1,800 characters** at a sentence boundary, so no section can overflow HeyGen.

## Testing

```bash
npm test                    # offline unit tests (no API key needed)
npm run smoke               # full pipeline against real Gemini (needs GEMINI_API_KEY)
npm run smoke -- path/to/ingestion.json
npm run quality             # narration quality pass over all fixtures (needs GEMINI_API_KEY)
```

Fixtures for the quality pass live in `examples/`:

- `sample-ingestion.json` — web app with JWT auth (Express + SQLite)
- `cli-tool.json` — an image-resizing CLI tool
- `data-pipeline.json` — a Kafka → Postgres ETL pipeline

`npm run quality` runs `/explain` against each and automatically flags the three
narration failure modes: doc-like phrasing ("this module contains…"), narration
that's too generic to reference real file names, and sections with a wildly
uneven word-count spread.

## Wiring to the real ingestion endpoint (Person 1)

Until Person 1's `/repo-summary-input` endpoint is live, everything runs off the
mock fixtures in `examples/`. Once it's ready, `scripts/from-ingest.js` fetches
real ingestion output and pipes it straight into the pipeline so we can confirm
narration quality holds on real repos:

```bash
INGEST_URL=http://localhost:8000/repo-summary-input \
GEMINI_API_KEY=sk-... \
node scripts/from-ingest.js https://github.com/owner/repo
```

Re-run the quality checks against a few real repos and tighten the narration
prompt (`src/prompts.js` → `buildNarrationMessages`) if any failure mode shows up.
