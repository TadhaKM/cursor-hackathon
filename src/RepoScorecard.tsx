import type { IngestResult } from "./api";

export type BadgeCategory = "language" | "framework" | "status";

export interface ScorecardBadge {
  label: string;
  category: BadgeCategory;
  tone: "positive" | "neutral" | "info";
}

const EXT_LANG: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  py: "Python",
  go: "Go",
  rs: "Rust",
  java: "Java",
  rb: "Ruby",
  php: "PHP",
  cs: "C#",
  swift: "Swift",
  kt: "Kotlin",
  vue: "Vue",
  svelte: "Svelte",
};

const MANIFEST_FRAMEWORKS: { pattern: RegExp; label: string }[] = [
  { pattern: /"react"/i, label: "React" },
  { pattern: /"next"/i, label: "Next.js" },
  { pattern: /"vue"/i, label: "Vue" },
  { pattern: /"svelte"/i, label: "Svelte" },
  { pattern: /"express"/i, label: "Express" },
  { pattern: /"fastapi"/i, label: "FastAPI" },
  { pattern: /"flask"/i, label: "Flask" },
  { pattern: /"django"/i, label: "Django" },
  { pattern: /"@nestjs/i, label: "NestJS" },
  { pattern: /"vite"/i, label: "Vite" },
];

function collectExtensions(fileTree: string): Set<string> {
  const exts = new Set<string>();
  for (const line of fileTree.split("\n")) {
    const match = line.trim().match(/\.([a-z0-9]+)$/i);
    if (match) exts.add(match[1].toLowerCase());
  }
  return exts;
}

function detectLanguages(fileTree: string): string[] {
  const langs = new Set<string>();
  for (const ext of collectExtensions(fileTree)) {
    const lang = EXT_LANG[ext];
    if (lang) langs.add(lang);
  }
  return [...langs];
}

function detectFrameworks(manifest: string, fileTree: string): string[] {
  const frameworks = new Set<string>();
  for (const { pattern, label } of MANIFEST_FRAMEWORKS) {
    if (pattern.test(manifest)) frameworks.add(label);
  }
  if (/\.vue$/im.test(fileTree)) frameworks.add("Vue");
  if (/\.svelte$/im.test(fileTree)) frameworks.add("Svelte");
  return [...frameworks];
}

function hasTests(fileTree: string): boolean {
  return /(?:^|\/)tests?(?:\/|$)|(?:^|\/)__tests__(?:\/|$)|(?:^|\/)spec(?:\/|$)|\.test\.|\.spec\./im.test(
    fileTree
  );
}

function hasCi(fileTree: string): boolean {
  return /\.github\/workflows\//i.test(fileTree);
}

function daysSince(dateStr: string): number | null {
  const parsed = Date.parse(dateStr);
  if (Number.isNaN(parsed)) return null;
  return Math.floor((Date.now() - parsed) / 86_400_000);
}

export function computeScorecard(ingestion: IngestResult): ScorecardBadge[] {
  const badges: ScorecardBadge[] = [];
  const { file_tree, package_manifest, recent_commits } = ingestion;

  for (const lang of detectLanguages(file_tree)) {
    badges.push({ label: lang, category: "language", tone: "info" });
  }

  for (const fw of detectFrameworks(package_manifest, file_tree)) {
    badges.push({ label: fw, category: "framework", tone: "info" });
  }

  if (badges.length === 0) {
    badges.push({ label: "Stack unknown", category: "language", tone: "neutral" });
  }

  const lastCommit = recent_commits[0]?.date;
  if (lastCommit) {
    const days = daysSince(lastCommit);
    if (days !== null && days <= 30) {
      badges.push({ label: "Actively maintained", category: "status", tone: "positive" });
    }
  }

  badges.push({
    label: hasTests(file_tree) ? "Has tests" : "No tests detected",
    category: "status",
    tone: "neutral",
  });

  if (hasCi(file_tree)) {
    badges.push({ label: "CI configured", category: "status", tone: "positive" });
  }

  return badges;
}

function badgeClass(badge: ScorecardBadge): string {
  const parts = ["scorecard-badge", `scorecard-badge-${badge.category}`];
  if (badge.tone === "positive") parts.push("scorecard-badge-positive");
  if (badge.tone === "neutral") parts.push("scorecard-badge-neutral");
  return parts.join(" ");
}

export function RepoScorecard({ badges }: { badges: ScorecardBadge[] }) {
  if (badges.length === 0) return null;

  return (
    <div className="repo-scorecard" aria-label="Repository scorecard">
      {badges.map((badge) => (
        <span className={badgeClass(badge)} key={badge.label}>
          {badge.label}
        </span>
      ))}
    </div>
  );
}
