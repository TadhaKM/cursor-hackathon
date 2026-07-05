import type { Persona, PipelineResult } from "./api";

export interface WalkthroughEntry {
  id: string;
  savedAt: number;
  repoUrl: string;
  persona: Persona;
  result: PipelineResult;
}

const HISTORY_KEY = "repo-to-video:walkthrough-history";
const MAX_ENTRIES = 8;

export function loadHistory(): WalkthroughEntry[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as WalkthroughEntry[];
  } catch {
    return [];
  }
}

export function saveWalkthrough(
  repoUrl: string,
  persona: Persona,
  result: PipelineResult
): WalkthroughEntry {
  const entry: WalkthroughEntry = {
    id: crypto.randomUUID(),
    savedAt: Date.now(),
    repoUrl,
    persona,
    result,
  };
  const current = loadHistory().filter((e) => e.repoUrl !== repoUrl);
  const next = [entry, ...current].slice(0, MAX_ENTRIES);
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    // localStorage unavailable — history just won't persist
  }
  return entry;
}

export function findById(id: string): WalkthroughEntry | undefined {
  return loadHistory().find((e) => e.id === id);
}

export function shareUrl(id: string): string {
  const base = window.location.origin + window.location.pathname;
  return `${base}#walk/${id}`;
}

export function formatExportMarkdown(result: PipelineResult): string {
  const lines = [
    `# Architecture Summary — ${result.repo}`,
    "",
    result.architectureSummary,
    "",
    "## Narration Script",
    "",
  ];
  for (const s of result.sections) {
    lines.push(`### ${s.title}`, "", s.script, "");
  }
  return lines.join("\n");
}

export function downloadMarkdown(result: PipelineResult) {
  const content = formatExportMarkdown(result);
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${result.repo.replace(/\//g, "-")}-architecture.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
