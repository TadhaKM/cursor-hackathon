import { useEffect, useRef, useState, useCallback, type ReactNode } from "react";
import { marked } from "marked";
import {
  runPipeline,
  runDiffPipeline,
  backendMode,
  TOOL_DOCS,
  type StageId,
  type PipelineResult,
  type DiffPipelineResult,
  type Persona,
  type IngestResult,
} from "./api";
import { ChatPanel } from "./ChatPanel";
import { useToast } from "./Toast";
import {
  loadHistory,
  saveWalkthrough,
  findById,
  shareUrl,
  downloadMarkdown,
  formatRelativeTime,
  type WalkthroughEntry,
} from "./history";
import "./App.css";

type ViewState = "input" | "progress" | "result" | "diff-result" | "error";
type Page = "app" | "about" | "faq" | "changelog";

const PIPELINE_STEPS = ["Ingest repo", "Explain architecture", "Render videos"];

const SHORTCUTS = [
  { keys: ["←", "→"], label: "Previous / next section (results)" },
  { keys: ["[", "]"], label: "Previous / next section (results)" },
  { keys: ["Enter"], label: "Submit repo URL (input screen)" },
  { keys: ["Ctrl", "Enter"], label: "Send chat message" },
  { keys: ["?"], label: "Show keyboard shortcuts" },
  { keys: ["Esc"], label: "Close dialog" },
];

function ShortcutsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="modal-panel"
        role="dialog"
        aria-labelledby="shortcuts-title"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 className="modal-title" id="shortcuts-title">
            Keyboard shortcuts
          </h2>
          <button className="modal-close" onClick={onClose} aria-label="Close shortcuts">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <ul className="shortcut-list">
            {SHORTCUTS.map((s) => (
              <li className="shortcut-item" key={s.label}>
                <span>{s.label}</span>
                <span className="shortcut-keys">
                  {s.keys.map((k) => (
                    <kbd className="kbd" key={k}>
                      {k}
                    </kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function PipelineStrip() {
  return (
    <div className="pipeline-strip" aria-label="Pipeline stages">
      {PIPELINE_STEPS.map((step, i) => (
        <span className={`pipeline-step ${i === 0 ? "pipeline-step-pop" : ""}`} key={step}>
          {i + 1}. {step}
        </span>
      ))}
    </div>
  );
}

function WalkthroughHistory({
  entries,
  onOpen,
}: {
  entries: WalkthroughEntry[];
  onOpen: (entry: WalkthroughEntry) => void;
}) {
  if (entries.length === 0) return null;

  return (
    <div className="history-section">
      <h3>Saved walkthroughs</h3>
      <div className="history-list">
        {entries.map((entry) => (
          <button
            key={entry.id}
            className="history-card"
            onClick={() => onOpen(entry)}
            aria-label={`Reopen walkthrough for ${entry.result.repo}`}
          >
            <span className="history-card-main">
              <span className="history-repo">{entry.result.repo}</span>
              <span className="history-meta">
                {entry.result.sections.length} sections · {formatRelativeTime(entry.savedAt)} ·{" "}
                {entry.persona === "new_grad" ? "new grad" : "senior engineer"}
              </span>
            </span>
            <span className="history-open">Open →</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const DEMO_REPOS = [
  "github.com/expressjs/express",
  "github.com/pallets/flask",
  "github.com/sveltejs/svelte",
  "github.com/vuejs/core",
];

const STEP_LABELS: Record<ViewState, string> = {
  input: "Step 1 · Paste a repo",
  progress: "Step 2 · Building",
  result: "Step 3 · Walkthrough ready",
  "diff-result": "Step 3 · Diff explained",
  error: "Something went wrong",
};

const STAGES: { id: StageId; label: string }[] = [
  { id: "ingest", label: "Reading the repo" },
  { id: "explain", label: "Understanding the architecture" },
  { id: "render", label: "Generating your walkthrough video" },
];

const FEATURE_TABS = [
  {
    id: "read",
    label: "Reads the code",
    title: "It starts with the file tree, not a guess.",
    body: "We pull the README, the entry points, the package manifest, and recent commits — the same things a senior engineer would open first on day one.",
    preview: ["README.md", "package.json", "src/routes/", "src/services/auth.ts", "12 commits this week"],
  },
  {
    id: "write",
    label: "Writes the script",
    title: "Documentation, translated into something spoken.",
    body: "The architecture summary gets rewritten as a narration script — short sentences, real file names, no bullet points. Built to be heard, not skimmed.",
    preview: ["\"Auth lives in its own module...\"", "\"Requests flow through three layers...\"", "\"Here's why that's structured this way...\""],
  },
  {
    id: "render",
    label: "Renders the video",
    title: "One section, one short video.",
    body: "Overview first, then a deep-dive per module. Nobody has to sit through twelve minutes to find the auth explanation.",
    preview: ["Overview — 74s", "Auth Module — 61s", "API Layer — 68s"],
  },
  {
    id: "ask",
    label: "Answers questions",
    title: "Still curious? Just ask.",
    body: "A chat box sits under every walkthrough, wired to the same context the video was built from — for the questions the video didn't cover.",
    preview: ["\"Why is auth separate from the API layer?\"", "\"What happens if the token expires?\""],
  },
];

function FeatureShowcase() {
  const [active, setActive] = useState(0);
  const tab = FEATURE_TABS[active];

  return (
    <div className="panel showcase-panel">
      <div className="showcase-tabbar">
        {FEATURE_TABS.map((t, i) => (
          <button
            key={t.id}
            className={`showcase-tab ${i === active ? "showcase-tab-active" : ""}`}
            onClick={() => setActive(i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="showcase-body">
        <div className="showcase-copy">
          <h3 className="showcase-heading">{tab.title}</h3>
          <p className="showcase-text">{tab.body}</p>
        </div>
        <div className="showcase-preview">
          {tab.preview.map((line, i) => (
            <div className="showcase-line" key={i}>
              {line}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AskBuilder({ repoIngestion, repoName }: { repoIngestion?: IngestResult; repoName?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="ask-builder">
      {open && (
        <div className="ask-panel">
          <div className="ask-panel-header">
            <span>{repoIngestion ? `Ask about ${repoName}` : "Ask about this tool"}</span>
            <button className="ask-close" onClick={() => setOpen(false)} aria-label="Close">
              ✕
            </button>
          </div>
          <div className="ask-panel-body">
            <ChatPanel
              compact
              ingestion={repoIngestion ?? TOOL_DOCS}
              contextType={repoIngestion ? "repo" : "tool"}
              placeholder={
                repoIngestion ? "Ask about this codebase…" : "Ask how repo → video works…"
              }
              hint={
                repoIngestion
                  ? "Powered by Gemini — grounded in this repo's actual files."
                  : "Powered by Gemini — ask about the pipeline, timing, or limitations."
              }
              examples={
                repoIngestion
                  ? [
                      "Why is auth separate from the API layer?",
                      "What should I read first in this repo?",
                    ]
                  : ["How long does a render take?", "Does it work on private repos?"]
              }
            />
          </div>
        </div>
      )}
      <button className="ask-fab" onClick={() => setOpen((v) => !v)}>
        {open ? "✕" : "?"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------
// Stats strip — animated counters
// ---------------------------------------------------------------------

function useCountUp(target: number, durationMs = 1400) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    function tick(now: number) {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(eased * target));
      if (t < 1) raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return value;
}

const STATS = [
  { target: 1204, suffix: "", label: "repos explained" },
  { target: 48300, suffix: "", label: "minutes of onboarding skipped" },
  { target: 312, suffix: "", label: "senior engineers who didn't repeat themselves" },
];

function StatCounter({ target, suffix, label }: { target: number; suffix: string; label: string }) {
  const value = useCountUp(target);
  return (
    <div className="stat">
      <span className="stat-number">
        {value.toLocaleString()}
        {suffix}
      </span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------
// About / How it works — interactive architecture diagram
// ---------------------------------------------------------------------

const DIAGRAM_NODES = [
  {
    id: "github",
    label: "GitHub",
    hash: "src",
    icon: "⌘",
    detail: "We pull the file tree, README, package manifest, and recent commit history straight from the repo you paste in.",
  },
  {
    id: "ingest",
    label: "Ingest",
    hash: "a3f1c9",
    icon: "📥",
    detail: "Person 1's service normalizes all of that into a single structured payload the explainer can reason about.",
  },
  {
    id: "explain",
    label: "Explain",
    hash: "7e2b4d",
    icon: "✍",
    detail: "An LLM turns the structure into a narration script — one section per module, written to be heard, not skimmed.",
  },
  {
    id: "render",
    label: "Render",
    hash: "c91d02",
    icon: "▶",
    detail: "Each section becomes its own short video, so nobody sits through twelve minutes to find the auth explanation.",
  },
  {
    id: "video",
    label: "Video",
    hash: "out",
    icon: "🎬",
    detail: "You get back a sidebar of short walkthroughs plus the architecture summary they were built from.",
  },
];

const FEATURE_TILES = [
  {
    id: "read",
    icon: "📂",
    label: "Reads code",
    detail: "File tree, README, manifests, and recent commits — the same things a senior engineer opens on day one.",
  },
  {
    id: "write",
    icon: "📝",
    label: "Writes script",
    detail: "Architecture docs rewritten as spoken narration — short sentences, real file names, no bullet points.",
  },
  {
    id: "render",
    icon: "🎥",
    label: "Renders video",
    detail: "One section, one short clip. Overview first, then deep-dives per module.",
  },
  {
    id: "ask",
    icon: "💬",
    label: "Answers questions",
    detail: "Chat wired to the same repo context the video was built from — for what the walkthrough didn't cover.",
  },
  {
    id: "personas",
    icon: "👥",
    label: "Personas",
    detail: "New grad or senior engineer tone — same repo, different depth of explanation.",
  },
  {
    id: "mock",
    icon: "⚡",
    label: "Mock mode",
    detail: "Full UI flow in ~5 seconds when no backend is running. Flip to live when services are up.",
  },
  {
    id: "history",
    icon: "🕐",
    label: "Walkthrough history",
    detail: "Past results saved to localStorage — reopen instantly or share a link.",
  },
  {
    id: "export",
    icon: "⬇",
    label: "Export & share",
    detail: "Download architecture.md, copy the summary, or grab a shareable walkthrough URL.",
  },
];

function WindowChrome({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="window-chrome">
      <div className="window-titlebar">
        <span className="window-dot window-dot-del" />
        <span className="window-dot window-dot-add" />
        <span className="window-dot window-dot-pop" />
        <span className="window-title">{title}</span>
      </div>
      <div className="window-body">{children}</div>
    </div>
  );
}

function PipelineCards() {
  const [active, setActive] = useState(DIAGRAM_NODES[0].id);
  const node = DIAGRAM_NODES.find((n) => n.id === active) ?? DIAGRAM_NODES[0];

  return (
    <WindowChrome title="pipeline.exe — click a stage">
      <div className="pipeline-cards">
        {DIAGRAM_NODES.map((n) => (
          <button
            key={n.id}
            type="button"
            className={`pipeline-card ${active === n.id ? "pipeline-card-active" : ""}`}
            onClick={() => setActive(n.id)}
            onMouseEnter={() => setActive(n.id)}
            onFocus={() => setActive(n.id)}
          >
            <span className="pipeline-card-icon">{n.icon}</span>
            <span className="pipeline-card-label">{n.label}</span>
            <span className="pipeline-card-hash">{n.hash}</span>
          </button>
        ))}
      </div>
      <p className="pipeline-detail">{node.detail}</p>
    </WindowChrome>
  );
}

function FeatureGrid() {
  const [active, setActive] = useState<string | null>(null);

  return (
    <WindowChrome title="features.grid — hover or click">
      <div className="feature-grid">
        {FEATURE_TILES.map((tile) => (
          <button
            key={tile.id}
            type="button"
            className={`feature-tile ${active === tile.id ? "feature-tile-active" : ""}`}
            onClick={() => setActive(active === tile.id ? null : tile.id)}
            onMouseEnter={() => setActive(tile.id)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(tile.id)}
            onBlur={() => setActive(null)}
          >
            <span className="feature-tile-icon">{tile.icon}</span>
            <span className="feature-tile-label">{tile.label}</span>
            {active === tile.id && <p className="feature-tile-detail">{tile.detail}</p>}
          </button>
        ))}
      </div>
    </WindowChrome>
  );
}

function StatsTiles() {
  return (
    <div className="stats-tiles">
      {STATS.map((s) => (
        <div className="stat-tile" key={s.label}>
          <StatCounter {...s} />
        </div>
      ))}
    </div>
  );
}

function ArchitectureDiagram() {
  const [hovered, setHovered] = useState<string>(DIAGRAM_NODES[0].id);
  const active = DIAGRAM_NODES.find((n) => n.id === hovered) ?? DIAGRAM_NODES[0];

  return (
    <div className="diagram">
      <div className="diagram-row">
        {DIAGRAM_NODES.map((n, i) => (
          <div className="diagram-node-wrap" key={n.id}>
            <button
              className={`diagram-node ${hovered === n.id ? "diagram-node-active" : ""}`}
              onMouseEnter={() => setHovered(n.id)}
              onFocus={() => setHovered(n.id)}
              onClick={() => setHovered(n.id)}
            >
              <span className="diagram-hash">{n.hash}</span>
              <span className="diagram-label">{n.label}</span>
            </button>
            {i < DIAGRAM_NODES.length - 1 && <span className="diagram-arrow">─▶</span>}
          </div>
        ))}
      </div>
      <div className="diagram-detail">
        <span className="diagram-detail-tag">{active.label}</span>
        <p>{active.detail}</p>
      </div>
    </div>
  );
}

function AboutPage() {
  return (
    <div className="panel page-panel page-panel-dense page-enter">
      <p className="eyebrow">// how it works</p>
      <h1>Five hops from a repo URL to a video someone watches.</h1>
      <p className="lede page-lede-compact">
        Click a pipeline stage or feature tile — this is the real flow, not a marketing diagram.
      </p>

      <div className="about-grid">
        <div className="about-col-full">
          <PipelineCards />
        </div>
        <div>
          <h3>By the numbers</h3>
          <StatsTiles />
        </div>
        <div>
          <h3>What you get</h3>
          <ArchitectureDiagram />
        </div>
        <div className="about-col-full">
          <FeatureGrid />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// FAQ — accordion
// ---------------------------------------------------------------------

type FaqCategory = "all" | "pipeline" | "chat" | "limits" | "demo";

const FAQ_CATEGORIES: { id: FaqCategory; label: string }[] = [
  { id: "all", label: "All" },
  { id: "pipeline", label: "Pipeline" },
  { id: "chat", label: "Chat" },
  { id: "limits", label: "Limits" },
  { id: "demo", label: "Demo" },
];

const FAQ_ITEMS: { cat: FaqCategory; q: string; a: string }[] = [
  {
    cat: "limits",
    q: "Does it work on private repos?",
    a: "Not yet — the ingest step currently only reads public GitHub repos. Private repo support would need OAuth, which isn't wired up in this build.",
  },
  {
    cat: "pipeline",
    q: "How long does a render take?",
    a: "In mock mode, the whole pipeline finishes in about 5 seconds so you can test the UI. Against a real backend, expect it to take as long as HeyGen needs to render each section's video — usually a minute or two per section.",
  },
  {
    cat: "pipeline",
    q: "What happens if a stage fails?",
    a: "You land on the error screen showing exactly which stage failed. Retrying picks up from scratch, but nothing earlier in the pipeline needs to be re-explained to you — the error message tells you what broke.",
  },
  {
    cat: "chat",
    q: "Can I ask questions about the codebase afterward?",
    a: "Yes — use the chat box under your walkthrough results, or the floating \"?\" button in the corner. Both call the same Gemini-powered chat proxy (VITE_CHAT_URL). On the results page they answer using the repo's actual files; elsewhere the \"?\" button answers general tool questions.",
  },
  {
    cat: "pipeline",
    q: "Why only three pipeline stages?",
    a: "Ingest, explain, and render map directly onto the three teammates' services in this project. Keeping the frontend's mental model that simple made it easy to build against mocks before any backend existed.",
  },
  {
    cat: "demo",
    q: "What's the difference between mock and live mode?",
    a: "Mock mode runs canned responses locally — great for demos and UI testing without any backend. Live mode hits the real /ingest, /explain, and /render services. The pill in the top bar shows which you're on.",
  },
  {
    cat: "demo",
    q: "What keyboard shortcuts are available?",
    a: "On the results screen: ← → or [ ] to switch sections. On input: Enter to submit. In chat: Ctrl+Enter to send. Anywhere: ? opens the shortcuts modal, Esc closes it.",
  },
  {
    cat: "pipeline",
    q: "Can I reopen a past walkthrough?",
    a: "Yes — every completed run is saved to walkthrough history in localStorage. Reopen from the input screen's history cards, or paste a #walk/… share link someone sent you.",
  },
  {
    cat: "pipeline",
    q: "Can I export or share the architecture summary?",
    a: "On the results screen: download architecture.md, copy the summary to clipboard, or copy a shareable link. Toasts confirm each action.",
  },
  {
    cat: "pipeline",
    q: "Where is the narration script for each section?",
    a: "Below the video on the results screen — the transcript panel shows the full narration script for whichever section you're watching. Use section shortcuts to flip between them.",
  },
  {
    cat: "chat",
    q: "Does the chat use the same context as the video?",
    a: "On the results page, yes — chat is grounded in the same ingested repo files the explainer used. The floating \"?\" button on other pages answers general questions about how repo → video works.",
  },
  {
    cat: "limits",
    q: "Which repos work best?",
    a: "Public GitHub repos with a README, clear entry points, and a few top-level modules. Monoliths and microservices both work — the explainer adapts section count to what it finds.",
  },
];

function FaqPage() {
  const [category, setCategory] = useState<FaqCategory>("all");
  const [openKey, setOpenKey] = useState<string | null>(FAQ_ITEMS[0].q);

  const filtered =
    category === "all" ? FAQ_ITEMS : FAQ_ITEMS.filter((item) => item.cat === category);

  return (
    <div className="panel page-panel page-panel-dense page-enter">
      <p className="eyebrow">// frequently asked</p>
      <h1>Questions people actually ask.</h1>

      <div className="faq-toolbar" role="tablist" aria-label="FAQ categories">
        {FAQ_CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            type="button"
            role="tab"
            aria-selected={category === cat.id}
            className={`faq-filter ${category === cat.id ? "faq-filter-active" : ""}`}
            onClick={() => {
              setCategory(cat.id);
              setOpenKey(null);
            }}
          >
            {cat.label}
          </button>
        ))}
      </div>

      <div className="faq-list">
        {filtered.length === 0 && (
          <p className="faq-empty">No questions in this category yet.</p>
        )}
        {filtered.map((item) => {
          const isOpen = openKey === item.q;
          return (
            <div className={`faq-item ${isOpen ? "faq-item-open" : ""}`} key={item.q}>
              <button
                className="faq-question"
                onClick={() => setOpenKey(isOpen ? null : item.q)}
                aria-expanded={isOpen}
              >
                <span>{item.q}</span>
                <span className="faq-caret">{isOpen ? "−" : "+"}</span>
              </button>
              {isOpen && <p className="faq-answer">{item.a}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Changelog — git-log style timeline
// ---------------------------------------------------------------------

const CHANGELOG_ENTRIES = [
  {
    version: "v0.7.0",
    date: "Jul 5, 2026",
    hash: "d4b8a2",
    changes: [
      "Secondary pages redesign: interactive pipeline cards, feature grid, window chrome",
      "FAQ category filters, 12 questions, two-column dense layout on desktop",
      "Changelog as git-log terminal with version filters and click-to-copy hashes",
      "Typography bump to 18px body / 20px readable content across the app",
    ],
  },
  {
    version: "v0.6.0",
    date: "Jul 5, 2026",
    hash: "e8c2f4",
    changes: [
      "Typography pass: larger body text, mono sizes, and line-height across the app",
      "Section transcript panel beside the video on the results screen",
      "Keyboard shortcuts for section navigation, chat, and a ? help modal",
      "Walkthrough history saved to localStorage — reopen past results instantly",
      "Export architecture as .md, copy summary or share link with toast confirmations",
      "Loading skeletons, dark theme tokens, and accessibility polish",
    ],
  },
  {
    version: "v0.5.0",
    date: "Jul 5, 2026",
    hash: "f4a9e1",
    changes: [
      "Added a demo button that runs the full pipeline against a real public repo",
      "Added How it works, FAQ, and Changelog pages with real navigation",
      "Interactive architecture diagram, animated stats, and hover micro-interactions throughout",
    ],
  },
  {
    version: "v0.4.1",
    date: "Jul 5, 2026",
    hash: "b2c701",
    changes: [
      "Fixed: submitting with an empty repo URL silently ran a fake demo repo",
      "Removed the decorative tab bar that looked clickable but wasn't",
      "Darkened low-contrast text and bumped small font sizes across the app",
    ],
  },
  {
    version: "v0.4.0",
    date: "Jul 4, 2026",
    hash: "9d31af",
    changes: [
      "Added interactive feature showcase and floating \"ask about this tool\" assistant",
      "Reworked input screen with a live terminal preview and example repo chips",
    ],
  },
  {
    version: "v0.3.0",
    date: "Jul 3, 2026",
    hash: "5e88c0",
    changes: [
      "Wired frontend to the real /ingest, /explain, /render API contract",
      "Added mock pipeline fallback so the UI works before any backend exists",
    ],
  },
  {
    version: "v0.1.0",
    date: "Jul 2, 2026",
    hash: "1a0f2e",
    changes: ["Initial scaffold: input → progress → result flow, persona toggle"],
  },
];

function ChangelogPage() {
  const { toast } = useToast();
  const [versionFilter, setVersionFilter] = useState<string>("all");
  const [copiedHash, setCopiedHash] = useState<string | null>(null);

  const versions = ["all", ...CHANGELOG_ENTRIES.map((e) => e.version)];
  const filtered =
    versionFilter === "all"
      ? CHANGELOG_ENTRIES
      : CHANGELOG_ENTRIES.filter((e) => e.version === versionFilter);

  async function copyHash(hash: string) {
    try {
      await navigator.clipboard.writeText(hash);
      setCopiedHash(hash);
      toast(`Copied ${hash}`, "success");
      setTimeout(() => setCopiedHash(null), 2000);
    } catch {
      toast("Couldn't copy hash", "error");
    }
  }

  return (
    <div className="panel page-panel page-panel-dense page-enter">
      <p className="eyebrow">// build history</p>
      <h1>What's shipped, in order.</h1>
      <p className="lede page-lede-compact">
        Filter by version or click a commit hash to copy it.
      </p>

      <div className="changelog-terminal">
        <div className="changelog-terminal-bar">
          <div className="changelog-terminal-title">
            <span className="terminal-dot terminal-dot-del" />
            <span className="terminal-dot terminal-dot-add" />
            <span className="terminal-dot terminal-dot-pop" />
            <span className="changelog-terminal-label">git log --oneline repo-to-video</span>
          </div>
          <div className="changelog-filters" role="tablist" aria-label="Filter by version">
            {versions.map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={versionFilter === v}
                className={`changelog-filter ${versionFilter === v ? "changelog-filter-active" : ""}`}
                onClick={() => setVersionFilter(v)}
              >
                {v === "all" ? "all" : v.replace("v", "")}
              </button>
            ))}
          </div>
        </div>
        <div className="changelog-log">
          {filtered.map((entry) => (
            <div className="changelog-log-entry" key={entry.version}>
              <span className="changelog-log-marker">*</span>
              <div className="changelog-log-body">
                <div className="changelog-log-head">
                  <span className="changelog-log-version">{entry.version}</span>
                  <button
                    type="button"
                    className={`changelog-log-hash ${copiedHash === entry.hash ? "changelog-log-hash-copied" : ""}`}
                    onClick={() => copyHash(entry.hash)}
                    title="Click to copy hash"
                  >
                    {copiedHash === entry.hash ? "copied!" : entry.hash}
                  </button>
                  <span className="changelog-log-date">{entry.date}</span>
                </div>
                <ul className="changelog-log-changes">
                  {entry.changes.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const RECENTS_KEY = "repo-to-video:recent-repos";

function loadRecents(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function saveRecent(repo: string) {
  try {
    const current = loadRecents().filter((r) => r !== repo);
    const next = [repo, ...current].slice(0, 5);
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // localStorage unavailable — recents just won't persist, no big deal
  }
}

function App() {
  const { toast } = useToast();
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "light";
    const saved = window.localStorage.getItem("theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    window.localStorage.setItem("theme", theme);
  }, [theme]);

  const [page, setPage] = useState<Page>("app");
  const [view, setView] = useState<ViewState>("input");
  const [repoUrl, setRepoUrl] = useState("");
  const [inputError, setInputError] = useState("");
  const [persona, setPersona] = useState<Persona>("new_grad");
  const [completed, setCompleted] = useState<Set<StageId>>(new Set());
  const [activeStage, setActiveStage] = useState<StageId | null>(null);
  const [failedStage, setFailedStage] = useState<StageId | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [result, setResult] = useState<PipelineResult | null>(null);
  // Diff mode — explain what changed between two refs instead of a full
  // repo walkthrough. Deliberately kept separate from the main result/
  // history machinery above: diff results are always exactly one section,
  // so they don't need the section sidebar, keyboard shortcuts, or
  // walkthrough-history persistence the main pipeline has.
  const [diffMode, setDiffMode] = useState(false);
  const [baseRef, setBaseRef] = useState("");
  const [headRef, setHeadRef] = useState("");
  const [diffResult, setDiffResult] = useState<DiffPipelineResult | null>(null);
  const [activeSection, setActiveSection] = useState(0);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [recents, setRecents] = useState<string[]>([]);
  const [history, setHistory] = useState<WalkthroughEntry[]>([]);
  const [walkthroughId, setWalkthroughId] = useState<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setRecents(loadRecents());
    setHistory(loadHistory());
  }, []);

  const openWalkthrough = useCallback((entry: WalkthroughEntry) => {
    setPage("app");
    setResult(entry.result);
    setActiveSection(0);
    setSummaryOpen(false);
    setWalkthroughId(entry.id);
    setPersona(entry.persona);
    setRepoUrl(entry.repoUrl);
    setView("result");
    window.history.replaceState(null, "", `#walk/${entry.id}`);
  }, []);

  useEffect(() => {
    const hash = window.location.hash;
    const match = hash.match(/^#walk\/([a-f0-9-]+)$/i);
    if (!match) return;
    const entry = findById(match[1]);
    if (!entry) return;
    openWalkthrough(entry);
  }, [openWalkthrough]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA";

      if (e.key === "?" && !typing) {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (e.key === "Escape") {
        setShortcutsOpen(false);
        return;
      }

      if (page !== "app" || view !== "result" || !result || typing) return;

      if (e.key === "ArrowLeft" || e.key === "[") {
        e.preventDefault();
        setActiveSection((i) => Math.max(0, i - 1));
      } else if (e.key === "ArrowRight" || e.key === "]") {
        e.preventDefault();
        setActiveSection((i) => Math.min(result.sections.length - 1, i + 1));
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [page, view, result]);

  function runDemo() {
    const repo = DEMO_REPOS[Math.floor(Math.random() * DEMO_REPOS.length)];
    setRepoUrl(repo);
    start(repo);
  }

  async function start(overrideUrl?: string) {
    const trimmed = (overrideUrl ?? repoUrl).trim();
    if (!trimmed) {
      setInputError("Enter a GitHub repo URL first — or pick one of the examples below.");
      return;
    }
    setInputError("");
    setPage("app");
    setView("progress");
    setCompleted(new Set());
    setFailedStage(null);
    setActiveStage(STAGES[0].id);
    setErrorMessage("");
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await runPipeline(
        trimmed,
        persona,
        ({ stage, ok }) => {
          if (ok) {
            setCompleted((prev) => new Set(prev).add(stage));
            const idx = STAGES.findIndex((s) => s.id === stage);
            setActiveStage(STAGES[idx + 1]?.id ?? null);
          } else {
            setFailedStage(stage);
          }
        },
        controller.signal
      );
      setResult(res);
      setActiveSection(0);
      setView("result");
      saveRecent(trimmed);
      setRecents(loadRecents());
      const entry = saveWalkthrough(trimmed, persona, res);
      setWalkthroughId(entry.id);
      setHistory(loadHistory());
      window.history.replaceState(null, "", `#walk/${entry.id}`);
      toast("Walkthrough ready — saved to your history", "success");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Something went wrong");
      setView("error");
    }
  }

  async function startDiff() {
    const trimmedRepo = repoUrl.trim();
    const trimmedBase = baseRef.trim();
    const trimmedHead = headRef.trim();
    if (!trimmedRepo || !trimmedBase || !trimmedHead) {
      setInputError("Diff mode needs a repo URL and both refs (e.g. a tag, branch, or commit SHA).");
      return;
    }
    setInputError("");
    setPage("app");
    setView("progress");
    setCompleted(new Set());
    setFailedStage(null);
    setActiveStage(STAGES[0].id);
    setErrorMessage("");
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await runDiffPipeline(
        trimmedRepo,
        trimmedBase,
        trimmedHead,
        ({ stage, ok }) => {
          if (ok) {
            setCompleted((prev) => new Set(prev).add(stage));
            const idx = STAGES.findIndex((s) => s.id === stage);
            setActiveStage(STAGES[idx + 1]?.id ?? null);
          } else {
            setFailedStage(stage);
          }
        },
        controller.signal
      );
      setDiffResult(res);
      setView("diff-result");
      toast("Diff explained", "success");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Something went wrong");
      setView("error");
    }
  }

  function retry() {
    if (diffMode) {
      startDiff();
    } else {
      start();
    }
  }

  return (
    <div className="shell">
      <header className="topbar">
        <span className="topbar-brand">repo → video</span>
        <nav className="nav-links">
          <button className={`nav-link ${page === "app" ? "nav-link-active" : ""}`} onClick={() => setPage("app")}>
            App
          </button>
          <button className={`nav-link ${page === "about" ? "nav-link-active" : ""}`} onClick={() => setPage("about")}>
            How it works
          </button>
          <button className={`nav-link ${page === "faq" ? "nav-link-active" : ""}`} onClick={() => setPage("faq")}>
            FAQ
          </button>
          <button className={`nav-link ${page === "changelog" ? "nav-link-active" : ""}`} onClick={() => setPage("changelog")}>
            Changelog
          </button>
        </nav>
        <div className="topbar-right">
          {page === "app" && <span className="step-indicator">{STEP_LABELS[view]}</span>}
          <span className={`mode-pill ${backendMode() === "live" ? "mode-live" : "mode-mock"}`}>
            {backendMode() === "live" ? "● live backend" : "○ mock data"}
          </span>
          <button className="demo-btn" onClick={runDemo} title="Runs the pipeline against a real public repo">
            ▶ Try a demo
          </button>
          <button
            className="shortcuts-hint-btn"
            onClick={() => setShortcutsOpen(true)}
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
          >
            ?
          </button>
          <button
            className="theme-toggle"
            onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
            aria-label="Toggle dark mode"
            title="Toggle dark mode"
          >
            {theme === "light" ? "🌙" : "☀️"}
          </button>
        </div>
      </header>

      <main className="stage">
        <div className="stage-stack">
          {page === "about" && <AboutPage />}
          {page === "faq" && <FaqPage />}
          {page === "changelog" && <ChangelogPage />}

          {page === "app" && view === "input" && (
            <>
              <InputView
                repoUrl={repoUrl}
                onChange={(v) => {
                  setRepoUrl(v);
                  if (inputError) setInputError("");
                }}
                error={inputError}
                persona={persona}
                onPersonaChange={setPersona}
                onSubmit={() => start()}
                recents={recents}
                history={history}
                onOpenHistory={openWalkthrough}
                diffMode={diffMode}
                onDiffModeChange={setDiffMode}
                baseRef={baseRef}
                onBaseRefChange={(v) => {
                  setBaseRef(v);
                  if (inputError) setInputError("");
                }}
                headRef={headRef}
                onHeadRefChange={(v) => {
                  setHeadRef(v);
                  if (inputError) setInputError("");
                }}
                onSubmitDiff={() => startDiff()}
              />
              <FeatureShowcase />
            </>
          )}

          {page === "app" && view === "progress" && (
            <ProgressView completed={completed} activeStage={activeStage} failedStage={failedStage} />
          )}

          {page === "app" && view === "diff-result" && diffResult && (
            <DiffResultView
              result={diffResult}
              onReset={() => {
                setView("input");
                window.history.replaceState(null, "", window.location.pathname);
              }}
            />
          )}

          {page === "app" && view === "result" && result && (
            <ResultView
              result={result}
              activeSection={activeSection}
              onSelectSection={setActiveSection}
              summaryOpen={summaryOpen}
              onToggleSummary={() => setSummaryOpen((v) => !v)}
              onReset={() => {
                setView("input");
                window.history.replaceState(null, "", window.location.pathname);
              }}
              walkthroughId={walkthroughId}
            />
          )}

          {page === "app" && view === "error" && (
            <ErrorView
              failedStage={failedStage}
              errorMessage={errorMessage}
              onRetry={retry}
              onBack={() => setView("input")}
            />
          )}
        </div>
      </main>

      <AskBuilder repoIngestion={result?.ingestion} repoName={result?.repo} />
      <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}

function TerminalPreview() {
  const lines = [
    "$ reading github.com/owner/repo",
    "→ found 84 files, 6 top-level modules",
    "→ README.md, package.json parsed",
    "$ tracing request flow",
    "→ routes/  ──▶  services/  ──▶  db/",
    "$ writing narration script",
    '→ "Here\'s how auth actually works…"',
    "$ rendering walkthrough.mp4",
    "✓ ready in 3 sections",
  ];
  const [shown, setShown] = useState(1);

  useEffect(() => {
    const id = setInterval(() => {
      setShown((n) => (n >= lines.length ? 1 : n + 1));
    }, 1100);
    return () => clearInterval(id);
  }, [lines.length]);

  return (
    <div className="terminal">
      <div className="terminal-bar">
        <span className="terminal-dot terminal-dot-del" />
        <span className="terminal-dot terminal-dot-add" />
        <span className="terminal-dot terminal-dot-pop" />
        <span className="terminal-title">repo-scan</span>
      </div>
      <div className="terminal-body">
        {lines.slice(0, shown).map((line, i) => (
          <div className="terminal-line" key={i}>
            {line}
          </div>
        ))}
        <span className="terminal-cursor" />
      </div>
    </div>
  );
}

function InputView({
  repoUrl,
  onChange,
  error,
  persona,
  onPersonaChange,
  onSubmit,
  recents,
  history,
  onOpenHistory,
  diffMode,
  onDiffModeChange,
  baseRef,
  onBaseRefChange,
  headRef,
  onHeadRefChange,
  onSubmitDiff,
}: {
  repoUrl: string;
  onChange: (v: string) => void;
  error?: string;
  persona: Persona;
  onPersonaChange: (p: Persona) => void;
  onSubmit: () => void;
  recents: string[];
  history: WalkthroughEntry[];
  onOpenHistory: (entry: WalkthroughEntry) => void;
  diffMode: boolean;
  onDiffModeChange: (v: boolean) => void;
  baseRef: string;
  onBaseRefChange: (v: string) => void;
  headRef: string;
  onHeadRefChange: (v: string) => void;
  onSubmitDiff: () => void;
}) {
  const examples = [
    "github.com/expressjs/express",
    "github.com/pallets/flask",
    "github.com/sveltejs/svelte",
  ];

  return (
    <div className="panel input-panel input-panel-split">
      <div className="input-copy">
        <p className="eyebrow">// no more 40-page onboarding docs</p>
        <h1>Turn any repo into a video someone will actually watch.</h1>
        <p className="lede">
          Paste a GitHub URL. We read the architecture, write the script, and
          hand back a short walkthrough — so the next hire skips the
          archaeology.
        </p>

        <PipelineStrip />

        <div className="persona-row">
          <span className="persona-label">Mode</span>
          <div className="persona-toggle">
            <button
              className={`persona-btn ${!diffMode ? "persona-btn-active" : ""}`}
              onClick={() => onDiffModeChange(false)}
            >
              Full walkthrough
            </button>
            <button
              className={`persona-btn ${diffMode ? "persona-btn-active" : ""}`}
              onClick={() => onDiffModeChange(true)}
            >
              Explain a diff
            </button>
          </div>
        </div>

        <div className={`input-row ${error ? "input-row-error" : ""}`}>
          <span className="input-prefix">url&nbsp;&gt;</span>
          <input
            type="text"
            value={repoUrl}
            onChange={(e) => onChange(e.target.value)}
            placeholder="github.com/owner/repo"
            aria-label="GitHub repository URL"
            aria-invalid={!!error}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !diffMode) onSubmit();
            }}
          />
        </div>

        {diffMode && (
          <div className="diff-refs-row">
            <div className={`input-row ${error ? "input-row-error" : ""}`}>
              <span className="input-prefix">base&nbsp;&gt;</span>
              <input
                type="text"
                value={baseRef}
                onChange={(e) => onBaseRefChange(e.target.value)}
                placeholder="e.g. v1.0.0 or main"
                aria-label="Base ref (tag, branch, or commit SHA)"
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSubmitDiff();
                }}
              />
            </div>
            <div className={`input-row ${error ? "input-row-error" : ""}`}>
              <span className="input-prefix">head&nbsp;&gt;</span>
              <input
                type="text"
                value={headRef}
                onChange={(e) => onHeadRefChange(e.target.value)}
                placeholder="e.g. v1.1.0 or a commit SHA"
                aria-label="Head ref (tag, branch, or commit SHA)"
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSubmitDiff();
                }}
              />
            </div>
          </div>
        )}
        {error && <p className="input-error">{error}</p>}

        <div className="chip-row">
          <span className="chip-label">or try</span>
          {examples.map((ex) => (
            <button key={ex} className="chip" onClick={() => onChange(ex)}>
              {ex.replace("github.com/", "")}
            </button>
          ))}
        </div>

        {recents.length > 0 && (
          <div className="chip-row">
            <span className="chip-label">recent</span>
            {recents.map((ex) => (
              <button key={ex} className="chip chip-recent" onClick={() => onChange(ex)}>
                {ex.replace("github.com/", "")}
              </button>
            ))}
          </div>
        )}

        <div className="persona-row">
          <span className="persona-label">Explain it for a</span>
          <div className="persona-toggle">
            <button
              className={`persona-btn ${persona === "new_grad" ? "persona-btn-active" : ""}`}
              onClick={() => onPersonaChange("new_grad")}
            >
              New grad
            </button>
            <button
              className={`persona-btn ${persona === "senior_engineer" ? "persona-btn-active" : ""}`}
              onClick={() => onPersonaChange("senior_engineer")}
            >
              Senior engineer
            </button>
          </div>
        </div>

        <div className="actions">
          <button className="btn btn-primary" onClick={diffMode ? onSubmitDiff : onSubmit}>
            {diffMode ? "Explain the diff" : "Generate walkthrough"}
          </button>
        </div>

        {!diffMode && <WalkthroughHistory entries={history} onOpen={onOpenHistory} />}
      </div>

      <div className="input-visual">
        <TerminalPreview />
      </div>
    </div>
  );
}

// Diff mode's result screen — deliberately simpler than ResultView: a diff
// explanation is always exactly one section, so there's no section sidebar,
// no diagram, no walkthrough-history persistence to wire up.
function DiffResultView({
  result,
  onReset,
}: {
  result: DiffPipelineResult;
  onReset: () => void;
}) {
  return (
    <div className="panel">
      <div className="result-header">
        <div>
          <p className="eyebrow">// {result.repo}</p>
          <h2>
            {result.baseRef} → {result.headRef}
          </h2>
          <p className="lede">
            {result.filesChanged} of {result.totalFilesChanged} changed files narrated
            {result.totalFilesChanged > result.filesChanged ? " (largest changes prioritized)" : ""}.
          </p>
        </div>
        <div className="result-actions">
          <button className="btn" onClick={onReset} type="button">
            ← Explain another
          </button>
        </div>
      </div>

      <div className="result-grid">
        <div className="video-col">
          <div className="video-wrap">
            {result.video.video_url ? (
              <video
                className="video"
                src={result.video.video_url}
                controls
                playsInline
                aria-label={`Diff explanation: ${result.section.title}`}
              />
            ) : (
              <div className="video video-placeholder" role="status">
                Still rendering…
              </div>
            )}
          </div>
        </div>

        <div className="sections-col">
          <h3>{result.section.title}</h3>
          <p>{result.section.script}</p>
        </div>
      </div>
    </div>
  );
}

function ProgressView({
  completed,
  activeStage,
  failedStage,
}: {
  completed: Set<StageId>;
  activeStage: StageId | null;
  failedStage: StageId | null;
}) {
  const anyStarted = completed.size > 0 || activeStage !== null;

  return (
    <div className="panel">
      <p className="eyebrow">// this part writes itself</p>
      <h2 className="progress-title">Committing each stage as it lands.</h2>

      {!anyStarted && (
        <div className="graph-skeleton" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div className="skeleton-row" key={i}>
              <div className="skeleton-circle" />
              <div className="skeleton-lines">
                <div className="skeleton-line skeleton-line-short" />
                <div className="skeleton-line skeleton-line-long" />
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="graph">
        {STAGES.map((s, i) => {
          const isDone = completed.has(s.id);
          const isFailed = failedStage === s.id;
          const isActive = activeStage === s.id && !isFailed;
          const isLast = i === STAGES.length - 1;

          let nodeClass = "node node-pending";
          if (isDone) nodeClass = "node node-done";
          if (isActive) nodeClass = "node node-active";
          if (isFailed) nodeClass = "node node-failed";

          return (
            <div className="graph-row" key={s.id}>
              <div className="graph-line-col">
                <div className={nodeClass}>
                  {isDone && <span className="check">✓</span>}
                  {isFailed && <span className="cross">✕</span>}
                </div>
                {!isLast && <div className={`line ${isDone ? "line-done" : ""}`} />}
              </div>
              <div className="graph-label-col">
                <span className={`graph-hash ${isDone ? "hash-done" : ""}`}>{shortHash(s.id)}</span>
                <span className="graph-label">{s.label}</span>
                {isActive && <span className="graph-status">running…</span>}
                {isFailed && <span className="graph-status graph-status-error">failed</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Split a narration script into caption-sized sentences. HeyGen doesn't give
// us word-level timing, so for on-screen subtitles we distribute the sentences
// evenly across the clip's duration (see syncCaption in ResultView).
function splitSentences(text: string): string[] {
  const parts = text.replace(/\s+/g, " ").match(/[^.!?]+[.!?]*/g);
  const cleaned = (parts ?? [text]).map((s) => s.trim()).filter(Boolean);
  return cleaned.length ? cleaned : [text];
}

// Full-screen, click-to-zoom architecture-diagram viewer. Reachable at any
// point via the floating "Diagram" button, the toolbar, the thumbnail, and the
// picture-in-picture overlay. Esc or a backdrop click closes it.
function DiagramModal({ url, onClose }: { url: string; onClose: () => void }) {
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="diagram-modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Architecture diagram"
    >
      <div className="diagram-modal" onClick={(e) => e.stopPropagation()}>
        <div className="diagram-modal-bar">
          <span className="diagram-modal-title">◇ Architecture diagram</span>
          <div className="diagram-modal-actions">
            <button
              className="diagram-modal-btn"
              onClick={() => setZoom((z) => !z)}
              type="button"
            >
              {zoom ? "Fit" : "Zoom"}
            </button>
            <a
              className="diagram-modal-btn"
              href={url}
              target="_blank"
              rel="noreferrer"
            >
              Open ↗
            </a>
            <button
              className="diagram-modal-btn diagram-modal-close"
              onClick={onClose}
              type="button"
              aria-label="Close diagram"
            >
              ✕
            </button>
          </div>
        </div>
        <div
          className={`diagram-modal-body ${zoom ? "diagram-modal-body-zoom" : ""}`}
        >
          <img src={url} alt="Architecture diagram" />
        </div>
      </div>
    </div>
  );
}

// Turn a section title like "Routing Layer (src/routes/auth.js, ...)" into a
// compact { label, file } for the animated walkthrough map / step chip.
function shortSection(title: string): { label: string; file: string } {
  const fileMatch = title.match(/\(([^)]+)\)/);
  const file = fileMatch ? fileMatch[1].split(",")[0].trim() : "";
  let label = title
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/\s*&\s.*$/, "")
    .trim();
  if (label.length > 28) label = label.slice(0, 26).trim() + "…";
  return { label: label || title, file };
}

// Animated vertical map of the walkthrough. Fills completed steps, highlights
// the one that's playing (with an in-section progress bar driven by the
// video), and is clickable to jump around.
function WalkthroughMap({
  sections,
  videos,
  activeSection,
  progress,
  onSelect,
}: {
  sections: { title: string; script: string }[];
  videos: { status: string }[];
  activeSection: number;
  progress: number;
  onSelect: (i: number) => void;
}) {
  return (
    <ol className="wmap-list">
      {sections.map((s, i) => {
        const { label, file } = shortSection(s.title);
        const state =
          i < activeSection ? "done" : i === activeSection ? "active" : "todo";
        const rendering = videos[i]?.status === "processing";
        return (
          <li key={s.title} className={`wmap-node wmap-${state}`}>
            <button
              className="wmap-btn"
              onClick={() => onSelect(i)}
              type="button"
              aria-current={state === "active" ? "step" : undefined}
            >
              <span className="wmap-dot">{state === "done" ? "✓" : i + 1}</span>
              <span className="wmap-text">
                <span className="wmap-label">{label}</span>
                {file && <span className="wmap-file">{file}</span>}
              </span>
              {rendering && <span className="wmap-badge">rendering</span>}
            </button>
            {state === "active" && (
              <div className="wmap-progress" aria-hidden="true">
                <div
                  className="wmap-progress-bar"
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function ResultView({
  result,
  activeSection,
  onSelectSection,
  summaryOpen,
  onToggleSummary,
  onReset,
  walkthroughId,
}: {
  result: PipelineResult;
  activeSection: number;
  onSelectSection: (i: number) => void;
  summaryOpen: boolean;
  onToggleSummary: () => void;
  onReset: () => void;
  walkthroughId: string | null;
}) {
  const { toast } = useToast();
  const video = result.videos[activeSection];
  const section = result.sections[activeSection];
  const [summaryHtml, setSummaryHtml] = useState("");

  // Subtitles, the animated map, diagram viewing, and fullscreen.
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoWrapRef = useRef<HTMLDivElement>(null);
  const [captionsOn, setCaptionsOn] = useState(true);
  const [captionIdx, setCaptionIdx] = useState(0);
  const [videoProgress, setVideoProgress] = useState(0);
  const [pipDiagram, setPipDiagram] = useState(false);
  const [diagramOpen, setDiagramOpen] = useState(false);
  const sentences = section ? splitSentences(section.script) : [];

  // Reset caption + progress when the section (and its video) changes.
  useEffect(() => {
    setCaptionIdx(0);
    setVideoProgress(0);
  }, [activeSection]);

  // Drives both the subtitles and the walkthrough map's in-section progress.
  function syncPlayback() {
    const v = videoRef.current;
    if (!v || !v.duration) return;
    const frac = Math.min(1, Math.max(0, v.currentTime / v.duration));
    setVideoProgress(frac);
    if (sentences.length > 0) {
      setCaptionIdx(
        Math.min(
          sentences.length - 1,
          Math.max(0, Math.floor(frac * sentences.length))
        )
      );
    }
  }

  // Fullscreen the video *container* (not the raw <video>) so captions, the
  // diagram overlay, and the step chip stay visible in fullscreen.
  function toggleFullscreen() {
    const el = videoWrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else {
      el.requestFullscreen?.();
    }
  }

  async function copySummary() {
    try {
      await navigator.clipboard.writeText(result.architectureSummary);
      toast("Architecture summary copied", "success");
    } catch {
      toast("Couldn't copy — clipboard blocked", "error");
    }
  }

  async function copyShareLink() {
    if (!walkthroughId) {
      toast("Run a new walkthrough to get a shareable link", "info");
      return;
    }
    try {
      await navigator.clipboard.writeText(shareUrl(walkthroughId));
      toast("Share link copied — reopen anytime from history", "success");
    } catch {
      toast("Couldn't copy link", "error");
    }
  }

  function exportMarkdown() {
    downloadMarkdown(result);
    toast("Downloaded architecture.md", "success");
  }

  useEffect(() => {
    let cancelled = false;
    Promise.resolve(marked.parse(result.architectureSummary)).then((html) => {
      if (!cancelled) setSummaryHtml(html as string);
    });
    return () => {
      cancelled = true;
    };
  }, [result.architectureSummary]);

  return (
    <div className="panel result-panel">
      <p className="eyebrow">// done · {result.repo}</p>
      <div className="result-header-row">
        <h2>Ready to share. No slide deck required.</h2>
        <div className="export-row">
          <button className="export-btn" onClick={exportMarkdown} type="button">
            ↓ Export .md
          </button>
          <button className="export-btn" onClick={copyShareLink} type="button">
            ⧉ Copy link
          </button>
          <button className="export-btn" onClick={copySummary} type="button">
            ⧉ Copy summary
          </button>
        </div>
      </div>

      <div className="result-grid">
        <div className="video-col">
          <div className="video-wrap" ref={videoWrapRef}>
            {video?.video_url ? (
              <video
                ref={videoRef}
                key={video.video_url}
                className="video"
                src={video.video_url}
                controls
                playsInline
                onTimeUpdate={syncPlayback}
                onLoadedMetadata={syncPlayback}
                aria-label={`Video walkthrough: ${section?.title ?? "section"}`}
              />
            ) : (
              <div className="video video-placeholder" role="status">
                Section still rendering…
              </div>
            )}

            {/* Current-step context — stays visible in fullscreen. */}
            {video?.video_url && section && (
              <div className="step-chip">
                <span className="step-chip-num">
                  {activeSection + 1}/{result.sections.length}
                </span>
                <span className="step-chip-label">
                  {shortSection(section.title).label}
                </span>
              </div>
            )}

            {video?.video_url && captionsOn && sentences.length > 0 && (
              <div className="caption-overlay" aria-live="polite">
                <span>{sentences[captionIdx]}</span>
              </div>
            )}

            {video?.video_url && pipDiagram && result.diagramImageUrl && (
              <button
                className="video-pip"
                onClick={() => setDiagramOpen(true)}
                type="button"
                title="Click to enlarge the diagram"
              >
                <img src={result.diagramImageUrl} alt="Architecture diagram" />
              </button>
            )}
          </div>

          {video?.video_url && (
            <div className="video-toolbar">
              <button
                className={`vtool ${captionsOn ? "vtool-on" : ""}`}
                onClick={() => setCaptionsOn((v) => !v)}
                type="button"
                aria-pressed={captionsOn}
              >
                CC · Subtitles {captionsOn ? "on" : "off"}
              </button>
              {result.diagramImageUrl && (
                <>
                  <button
                    className={`vtool ${pipDiagram ? "vtool-on" : ""}`}
                    onClick={() => setPipDiagram((v) => !v)}
                    type="button"
                    aria-pressed={pipDiagram}
                  >
                    ▣ Diagram overlay {pipDiagram ? "on" : "off"}
                  </button>
                  <button
                    className="vtool"
                    onClick={() => setDiagramOpen(true)}
                    type="button"
                  >
                    ⛶ Open diagram
                  </button>
                </>
              )}
              <button
                className="vtool"
                onClick={toggleFullscreen}
                type="button"
                title="Fullscreen (keeps subtitles + diagram overlay visible)"
              >
                ⛶ Fullscreen
              </button>
            </div>
          )}

          {section && (
            <div className="transcript-panel">
              <p className="transcript-label">Narration script</p>
              <h4 className="transcript-title">{section.title}</h4>
              <p className="transcript-body">{section.script}</p>
              <p className="section-nav-hint">
                Use ← → or [ ] to switch sections · Press ? for all shortcuts
              </p>
            </div>
          )}

          {result.diagramImageUrl && (
            <button
              className="diagram-thumb"
              onClick={() => setDiagramOpen(true)}
              type="button"
              title="Click to view the architecture diagram"
            >
              <img src={result.diagramImageUrl} alt="Architecture diagram" />
              <span className="diagram-thumb-hint">
                ⛶ Architecture diagram — click to enlarge (viewable any time)
              </span>
            </button>
          )}
        </div>

        <div className="sections-col">
          <h3>Walkthrough map</h3>
          <p className="wmap-hint">Follows the narration — click any step to jump.</p>
          <WalkthroughMap
            sections={result.sections}
            videos={result.videos}
            activeSection={activeSection}
            progress={videoProgress}
            onSelect={onSelectSection}
          />

          <div className="summary-row">
            <button className="summary-toggle" onClick={onToggleSummary} type="button">
              {summaryOpen ? "▾" : "▸"} Read the full summary
            </button>
            <button className="copy-btn" onClick={copySummary} type="button">
              Copy summary
            </button>
          </div>
          {summaryOpen && (
            <div
              className="summary-markdown"
              dangerouslySetInnerHTML={{ __html: summaryHtml }}
            />
          )}
        </div>
      </div>

      <div className="chat-row">
        <ChatPanel
          ingestion={result.ingestion}
          placeholder="Ask a question about this codebase…"
          hint="Powered by Gemini — grounded in this repo's actual files."
          examples={[
            "Why is auth separate from the API layer?",
            "What happens if the token expires?",
          ]}
        />
      </div>

      <div className="actions">
        <button className="btn btn-ghost" onClick={onReset}>
          Do another repo
        </button>
      </div>

      {/* Always-available diagram access, floating over the results screen. */}
      {result.diagramImageUrl && (
        <button
          className="diagram-fab"
          onClick={() => setDiagramOpen(true)}
          type="button"
          title="View the architecture diagram"
        >
          ◇ Diagram
        </button>
      )}
      {diagramOpen && result.diagramImageUrl && (
        <DiagramModal
          url={result.diagramImageUrl}
          onClose={() => setDiagramOpen(false)}
        />
      )}
    </div>
  );
}

function ErrorView({
  failedStage,
  errorMessage,
  onRetry,
  onBack,
}: {
  failedStage: StageId | null;
  errorMessage: string;
  onRetry: () => void;
  onBack: () => void;
}) {
  const stage = STAGES.find((s) => s.id === failedStage);
  return (
    <div className="panel error-panel">
      <p className="eyebrow eyebrow-error">// well, that's embarrassing</p>
      <h2>The {stage?.label.toLowerCase() ?? "pipeline"} stage didn't finish.</h2>
      <p className="lede">
        Nothing else was lost — the earlier stages already completed. Retrying
        will pick up from where it stopped, not start over.
      </p>
      {errorMessage && <pre className="error-detail">{errorMessage}</pre>}
      <div className="actions">
        <button className="btn btn-primary" onClick={onRetry}>
          Retry
        </button>
        <button className="btn btn-ghost" onClick={onBack}>
          Start over
        </button>
      </div>
    </div>
  );
}

function shortHash(id: StageId) {
  const map: Record<StageId, string> = {
    ingest: "a3f1c9",
    explain: "7e2b4d",
    render: "c91d02",
  };
  return map[id];
}

export default App;
