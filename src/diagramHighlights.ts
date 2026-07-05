import type { DiagramHighlight, ExplainSection } from "./api";

interface MermaidNode {
  id: string;
  label: string;
}

const NODE_RE =
  /(\w+)\s*(?:\[([^\]]+)\]|\(([^)]+)\)|\{([^}]+)\}|>\[([^\]]+)\]|"([^"]+)")/g;

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 2);
}

export function parseMermaidNodes(mermaid: string): MermaidNode[] {
  const nodes: MermaidNode[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = NODE_RE.exec(mermaid)) !== null) {
    const id = match[1];
    const label = match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? id;
    if (!seen.has(id)) {
      seen.add(id);
      nodes.push({ id, label: label.trim() });
    }
  }

  return nodes;
}

function scoreMatch(sectionTitle: string, label: string): number {
  const titleTokens = new Set(tokenize(sectionTitle));
  const labelTokens = tokenize(label);
  let score = 0;
  for (const t of labelTokens) {
    if (titleTokens.has(t)) score += 2;
    if (sectionTitle.toLowerCase().includes(t)) score += 1;
  }
  if (sectionTitle.toLowerCase().includes(label.toLowerCase())) score += 3;
  if (label.toLowerCase().includes(sectionTitle.toLowerCase())) score += 3;
  return score;
}

function bestNodeForSection(section: ExplainSection, nodes: MermaidNode[]): MermaidNode | null {
  if (nodes.length === 0) return null;

  let best: MermaidNode | null = null;
  let bestScore = 0;

  for (const node of nodes) {
    const score = scoreMatch(section.title, node.label);
    if (score > bestScore) {
      bestScore = score;
      best = node;
    }
  }

  return bestScore > 0 ? best : nodes[0] ?? null;
}

/**
 * Use backend-provided highlights when present; otherwise derive from section
 * titles matched against mermaid node labels.
 */
export function resolveDiagramHighlights(
  sections: ExplainSection[],
  mermaidDiagram: string | null,
  provided?: DiagramHighlight[]
): DiagramHighlight[] {
  if (provided && provided.length > 0) return provided;
  if (!mermaidDiagram) return [];

  const nodes = parseMermaidNodes(mermaidDiagram);
  const highlights: DiagramHighlight[] = [];

  for (let section_index = 0; section_index < sections.length; section_index++) {
    const section = sections[section_index];
    const node = bestNodeForSection(section, nodes);
    if (!node) continue;
    highlights.push({
      section_index,
      node_id: node.id,
      caption: section.title,
    });
  }

  return highlights;
}
