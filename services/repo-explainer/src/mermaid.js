// Lightweight Mermaid validation.
//
// Fully rendering Mermaid requires a browser DOM, which is far too heavy for a
// hackathon backend. Instead we do a structural sanity check that catches the
// failure modes an LLM actually produces: markdown fences, prose preambles,
// missing diagram declarations, and unbalanced brackets. Good enough to gate
// the "retry with a stricter prompt" flow the spec asks for.

const VALID_HEADERS = [
  "graph",
  "flowchart",
  "sequenceDiagram",
  "classDiagram",
  "stateDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "journey",
  "gantt",
  "mindmap",
];

/**
 * Strips ```mermaid / ``` fences and leading/trailing prose that models
 * sometimes add despite instructions.
 */
export function cleanMermaid(raw) {
  if (typeof raw !== "string") return "";
  let text = raw.trim();

  // Remove surrounding code fences (```mermaid ... ``` or ``` ... ```).
  const fenceMatch = text.match(/```(?:mermaid)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  } else {
    text = text.replace(/```/g, "").trim();
  }

  // Drop any leading lines before the first valid diagram declaration.
  const lines = text.split("\n");
  const startIdx = lines.findIndex((line) =>
    VALID_HEADERS.some((h) => line.trim().toLowerCase().startsWith(h.toLowerCase()))
  );
  if (startIdx > 0) {
    text = lines.slice(startIdx).join("\n").trim();
  }

  return text;
}

function isBalanced(text) {
  const pairs = { "(": ")", "[": "]", "{": "}" };
  const closers = { ")": "(", "]": "[", "}": "{" };
  const stack = [];
  for (const ch of text) {
    if (pairs[ch]) {
      stack.push(ch);
    } else if (closers[ch]) {
      if (stack.pop() !== closers[ch]) return false;
    }
  }
  return stack.length === 0;
}

/**
 * Validates cleaned mermaid text.
 * @returns {{ ok: boolean, diagram: string, error?: string }}
 */
export function validateMermaid(raw) {
  const diagram = cleanMermaid(raw);

  if (!diagram) {
    return { ok: false, diagram, error: "empty diagram" };
  }

  const firstLine = diagram.split("\n")[0].trim().toLowerCase();
  const hasHeader = VALID_HEADERS.some((h) =>
    firstLine.startsWith(h.toLowerCase())
  );
  if (!hasHeader) {
    return {
      ok: false,
      diagram,
      error: `missing valid diagram declaration (got "${diagram.split("\n")[0].slice(0, 40)}")`,
    };
  }

  const bodyLines = diagram
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean);

  if (bodyLines.length === 0) {
    return { ok: false, diagram, error: "diagram has a header but no body" };
  }

  if (!isBalanced(diagram)) {
    return { ok: false, diagram, error: "unbalanced brackets/parentheses" };
  }

  // Flowchart-style diagrams should contain at least one edge or node def.
  const isFlow = firstLine.startsWith("graph") || firstLine.startsWith("flowchart");
  if (isFlow) {
    const hasEdge = /-{1,3}>|---|===|--/.test(diagram);
    const hasNode = /\[[^\]]+\]|\([^)]+\)|\{[^}]+\}/.test(diagram);
    if (!hasEdge && !hasNode) {
      return { ok: false, diagram, error: "flowchart has no edges or nodes" };
    }
  }

  // Reject obvious leftover markdown/prose lines.
  if (/^(#{1,6}\s|\*\s|- \w+:)/m.test(diagram)) {
    return { ok: false, diagram, error: "contains markdown/prose lines" };
  }

  return { ok: true, diagram };
}
