// Prompt builders. Kept in one place so the narration prompt (the demo-critical
// one) is easy to iterate on.

export const PERSONAS = ["new_grad", "senior_engineer"];

export function normalizePersona(persona) {
  if (typeof persona !== "string") return null;
  const p = persona.trim().toLowerCase();
  return PERSONAS.includes(p) ? p : null;
}

// Per-section spoken-word budget. HeyGen caps a single avatar script at 5,000
// characters (~3 min); 150-200 words (~60-90s) reads best and keeps each
// section comfortably under the limit. ~200 words ~= 1,200 chars.
export const SECTION_WORD_TARGET = { min: 150, max: 200 };
export const SECTION_CHAR_HARDCAP = 1400;

function personaGuidance(persona) {
  if (persona === "new_grad") {
    return [
      "AUDIENCE: a new-grad engineer on their first job.",
      "Lean into the WHY. When you mention a pattern, layer, or convention, briefly explain why teams structure code this way and what problem it solves.",
      "Define jargon in passing. Assume solid CS fundamentals but little production experience.",
    ].join(" ");
  }
  if (persona === "senior_engineer") {
    return [
      "AUDIENCE: an experienced senior engineer.",
      "Assume they know standard patterns — don't explain what an MVC or a repository pattern is.",
      "Focus on what's NONSTANDARD, surprising, or worth flagging: unusual layering, custom abstractions, tech-debt hotspots, sharp edges, and where the important logic actually lives.",
    ].join(" ");
  }
  // Balanced default.
  return "AUDIENCE: a new team member with general software experience. Balance what the code does with why it's structured that way.";
}

export function buildArchitectureMessages(context, persona) {
  const system = [
    "You are a senior engineer explaining a codebase to a new team member.",
    "Given the file tree, README, and key files below, identify:",
    "(1) the overall purpose of the project,",
    "(2) the main architectural layers/modules and what each does,",
    "(3) how data/requests flow through the system,",
    "(4) any notable patterns or conventions used.",
    "Be concrete and reference actual file/folder names.",
    "Output in markdown with clear headers.",
    "",
    personaGuidance(persona),
  ].join("\n");

  const user = [
    "Here is the ingested repository context. Analyze it and produce the architecture summary described above.",
    "",
    context,
  ].join("\n");

  return { system, user };
}

export function buildNarrationMessages(architectureSummary, persona) {
  const system = [
    "You convert software architecture write-ups into friendly, spoken-style narration scripts for a video walkthrough aimed at a new hire's first day.",
    "",
    "RULES:",
    "- Write like you're talking, not writing documentation. Use contractions, short sentences. NO bullet points, NO markdown, NO headers, NO lists inside the script text.",
    "- Never say things like \"This directory contains the following files\". Explain what the code DOES and WHY it's structured that way, in plain conversational language.",
    `- Break it into sections. ALWAYS start with an "Overview" section (60-90 seconds when read aloud, ~${SECTION_WORD_TARGET.min}-${SECTION_WORD_TARGET.max} words), then one section per major module/folder (60-90 seconds each, ~${SECTION_WORD_TARGET.min}-${SECTION_WORD_TARGET.max} words).`,
    `- Keep EVERY section between ${SECTION_WORD_TARGET.min} and ${SECTION_WORD_TARGET.max} words. This is a hard requirement — a downstream text-to-video service rejects long scripts.`,
    "- Each section should explain WHAT the code does and WHY it's structured that way, referencing real file names naturally (say them the way a person would, e.g. \"the server dot js file\" is fine, or just \"server.js\").",
    "- End the Overview section with a natural transition sentence that leads into the first deep-dive section.",
    "- Do not invent files or behavior that isn't supported by the summary.",
    "",
    personaGuidance(persona),
    "",
    'Output ONLY valid JSON in exactly this shape, with no surrounding prose or code fences: { "sections": [ { "title": string, "script": string } ] }',
  ].join("\n");

  const user = [
    "Convert this architecture summary into the spoken narration script described above.",
    "",
    "ARCHITECTURE SUMMARY:",
    architectureSummary,
  ].join("\n");

  return { system, user };
}

export function buildMermaidMessages(context, architectureSummary, { strict = false } = {}) {
  const baseSystem = [
    "You generate Mermaid diagrams that show how the main modules of a codebase depend on or call each other.",
    "Given the file tree and architecture summary, produce a single Mermaid flowchart.",
    "Output ONLY valid mermaid syntax. No explanation, no prose, no markdown code fences.",
    "Start with a valid diagram declaration such as `graph TD` or `flowchart LR`.",
    "Use short, safe node ids (letters/numbers) with human-readable labels in brackets, e.g. A[API Layer].",
    "Show edges between modules with arrows, e.g. A --> B.",
  ];

  if (strict) {
    baseSystem.push(
      "",
      "STRICT MODE — the previous attempt was not parseable. Follow these EXACTLY:",
      "- The VERY FIRST characters of your output must be `graph TD`.",
      "- Every line after that is either a node definition or an edge.",
      "- Node labels: only letters, numbers, spaces, dots, dashes, and slashes inside the [ ] brackets. No parentheses, quotes, colons, or other punctuation in labels.",
      "- Use only `-->` for edges. No edge labels, no subgraphs, no styling, no comments.",
      "- Do NOT wrap the output in ``` fences. Output raw mermaid text only."
    );
  }

  const system = baseSystem.join("\n");
  const user = [
    "Generate the Mermaid diagram for this project.",
    "",
    "ARCHITECTURE SUMMARY:",
    architectureSummary,
    "",
    "FILE TREE / CONTEXT:",
    context,
  ].join("\n");

  return { system, user };
}
