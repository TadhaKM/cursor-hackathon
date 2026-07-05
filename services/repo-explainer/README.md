# repo-explainer

"Person 2" of the repo → onboarding-video pipeline.

Takes the **ingestion output** (file tree, README, key files, recent commits,
package manifest) and calls the **Alibaba Qwen Model Studio** API
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
cp .env.example .env      # then paste your QWEN_API_KEY
npm start                 # boots on http://localhost:8787
```

Environment variables (see `.env.example`):

| Var               | Default                                                        | Notes                                   |
| ----------------- | ------------------------------------------------------------- | --------------------------------------- |
| `QWEN_API_KEY`    | —                                                             | **Required.** Model Studio / DashScope. |
| `QWEN_BASE_URL`   | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`      | Intl endpoint. CN drops the `-intl`.    |
| `QWEN_MODEL`      | `qwen-max`                                                    | `qwen-plus` is faster/cheaper.          |
| `QWEN_TIMEOUT_MS` | `30000`                                                       | Per call (3 sequential calls).          |
| `QWEN_MAX_RETRIES`| `1`                                                          | Retries per call (2 attempts total).    |
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
  "meta": { "persona": "new_grad", "model": "qwen-max", "elapsed_ms": 12873, "section_count": 4 }
}
```

Query/body flags:

- `?diagram=false` (or `"include_diagram": false` in the body) skips the mermaid
  call — handy while iterating on narration.

### `POST /chat` (stretch: RAG chat)

Ask questions about the repo. The service chunks `key_files`, retrieves the most
relevant chunks with a dependency-free TF-IDF keyword score, and answers with
Qwen — grounded in the actual code.

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
  "meta": { "model": "qwen-max" }
}
```

### `GET /health`

Returns `{ ok, service, model, apiKeyConfigured }`.

## How it works

Three sequential Qwen chat-completions calls (`src/explain.js`):

1. `buildArchitectureMessages` → architecture summary.
2. `buildNarrationMessages` → narration JSON. Parsed and each section is capped
   to a HeyGen-safe length.
3. `buildMermaidMessages` → mermaid. Output is validated (`src/mermaid.js`); if
   it isn't parseable, it retries **once** with a stricter prompt, and falls
   back to `null` rather than failing the whole request.

Each call has a 30s timeout and one retry (`src/qwenClient.js`).

### Personas

- **`new_grad`** — leans into *why* patterns exist and defines jargon.
- **`senior_engineer`** — skips the basics and flags what's *nonstandard* or
  worth noting.
- Omitted — a balanced default.

### HeyGen length limits

HeyGen caps a single avatar script at **5,000 characters** (~3 min). Sections
target **150–200 words** (~60–90s, the sweet spot for pacing) and are hard-capped
at 1,400 characters at a sentence boundary, so no section can overflow HeyGen.

## Testing

```bash
node --test                 # offline unit tests (no API key needed)
npm run smoke               # full pipeline against real Qwen (needs QWEN_API_KEY)
npm run smoke -- path/to/ingestion.json
```

There's a ready-made fixture at `examples/sample-ingestion.json`.
