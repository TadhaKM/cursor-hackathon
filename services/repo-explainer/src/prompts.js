// Prompt builders. Kept in one place so the narration prompt (the demo-critical
// one) is easy to iterate on.

export const PERSONAS = ["new_grad", "senior_engineer"];

export function normalizePersona(persona) {
  if (typeof persona !== "string") return null;
  const p = persona.trim().toLowerCase();
  return PERSONAS.includes(p) ? p : null;
}

// Per-section spoken-word budget. HeyGen caps a single avatar script at 5,000
// characters (~3 min); ~150-200 words (~60-90s) reads best.
//   - TARGET is what we ask Gemini to hit.
//   - BOUNDS is the acceptable range we validate against; sections outside it
//     trigger one targeted resize retry.
export const SECTION_WORD_TARGET = { min: 150, max: 200 };
export const SECTION_WORD_BOUNDS = { min: 100, max: 250 };
// Char safety net for HeyGen. 250 words ~= 1,650 chars, so 1,800 leaves headroom
// for an acceptable section while still truncating truly runaway output.
export const SECTION_CHAR_HARDCAP = 1800;

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
    "You are writing what a friendly senior engineer would SAY out loud while walking a new hire through a codebase on their first day. This is a spoken video script, not documentation.",
    "",
    "VOICE AND STYLE (most important):",
    "- Write exactly how a person talks. Use contractions (it's, we're, you'll, that's). Keep sentences short and punchy.",
    "- NO markdown, NO headers, NO bullet points, NO lists, NO code blocks inside the script text. Just flowing spoken sentences.",
    "- Address the listener directly as \"you\" and use \"we\"/\"our\" for the team. It should feel warm and human.",
    "- BANNED phrasings (never write anything like these): \"This module contains...\", \"This directory contains the following files\", \"The following components...\", \"It is responsible for...\", \"This section will cover...\". These sound like docs being read aloud and will ruin the video.",
    "- Instead, narrate: e.g. \"So when a request comes in, it first hits server.js, which is basically the front door...\"",
    "",
    "CONTENT:",
    "- Be specific to THIS repo. Name real files and folders from the summary (like server.js, the routes folder, auth.js) and say what each actually does. Generic narration that could describe any project is a failure.",
    "- For each section explain WHAT the code does AND WHY it's built that way.",
    "- Do not invent files, behavior, or tech that isn't in the summary.",
    "",
    "STRUCTURE:",
    "- ALWAYS start with an \"Overview\" section, then one section per major module/folder.",
    `- Every section MUST be between ${SECTION_WORD_TARGET.min} and ${SECTION_WORD_TARGET.max} words (~60-90 seconds spoken). Never under ${SECTION_WORD_BOUNDS.min} or over ${SECTION_WORD_BOUNDS.max} words — a downstream text-to-video service rejects long scripts, and very short sections feel abrupt. Keep the sections roughly even in length.`,
    "- End the Overview with a natural transition sentence that leads into the first deep-dive section (e.g. \"Let's start with how requests actually get handled.\").",
    "- Before finishing, silently check each section's word count is in range and rewrite any that aren't.",
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

// Targeted resize for a single section that fell outside the word bounds.
export function buildSectionResizeMessages(section, direction, persona) {
  const { min, max } = SECTION_WORD_TARGET;
  const action =
    direction === "shorten"
      ? `It is too long. Rewrite it to be SHORTER — between ${min} and ${max} words — while keeping the most important, repo-specific points.`
      : `It is too short. Rewrite it to be LONGER — between ${min} and ${max} words — by adding more concrete detail about what the code does and why, referencing real file names. Do not pad with filler.`;

  const system = [
    "You revise a single spoken narration section for a codebase walkthrough video.",
    action,
    "Keep the same friendly, spoken style: contractions, short sentences, no markdown, no bullet points, no headers.",
    "Do not add files or behavior that weren't already implied by the section.",
    personaGuidance(persona),
    'Output ONLY valid JSON in exactly this shape, no code fences: { "title": string, "script": string }',
  ].join("\n");

  const user = [
    `SECTION TITLE: ${section.title}`,
    "",
    "CURRENT SCRIPT:",
    section.script,
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

// Diff mode: narrate what changed between two refs instead of a full repo
// snapshot. One section only (not a multi-section walkthrough), same
// spoken-style rules as the main narration prompt.
export function buildDiffNarrationMessages({ base_ref, head_ref, commits = [], files = [] }) {
  const system = [
    "You are a senior engineer explaining a code change to a teammate who's coming back to this codebase after time away. This is a spoken video script, not a changelog.",
    "",
    "VOICE AND STYLE (most important):",
    "- Write exactly how a person talks. Use contractions (it's, we're, you'll, that's). Keep sentences short and punchy.",
    "- NO markdown, NO headers, NO bullet points, NO lists, NO code blocks inside the script text. Just flowing spoken sentences.",
    "- Address the listener directly as \"you\".",
    "- BANNED phrasings: \"This diff contains...\", \"The following files were changed...\", \"This commit adds...\". These sound like a changelog being read aloud.",
    "",
    "CONTENT:",
    "- Focus on BEHAVIOR changes and why they likely matter to someone returning to this code — not line-by-line noise, and not every single file.",
    "- Reference actual changed file names.",
    "- If the diff is mostly mechanical (formatting, dependency bumps, generated files) say so plainly instead of inventing significance that isn't there.",
    "- Do not invent changes that aren't in the diff below.",
    "",
    `- The script MUST be between ${SECTION_WORD_TARGET.min} and ${SECTION_WORD_TARGET.max} words (~60-90 seconds spoken).`,
    "",
    'Output ONLY valid JSON in exactly this shape, no code fences: { "title": string, "script": string }',
  ].join("\n");

  const commitList = commits.length
    ? commits.map((c) => `- ${c.message.split("\n")[0]}`).join("\n")
    : "(no commit messages available)";

  const fileList = files
    .map((f) => `--- ${f.path} (${f.status}, +${f.additions}/-${f.deletions}) ---\n${f.patch}`)
    .join("\n\n");

  const user = [
    `Comparing ${base_ref} to ${head_ref}.`,
    "",
    "RECENT COMMIT MESSAGES:",
    commitList,
    "",
    "CHANGED FILES:",
    fileList,
  ].join("\n");

  return { system, user };
}
