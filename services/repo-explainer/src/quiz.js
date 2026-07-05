import { chat } from "./llmClient.js";

export const QUIZ_QUESTION_COUNT = 4;
export const QUIZ_OPTION_COUNT = 4;

function stripFences(text) {
  const s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fence ? fence[1].trim() : s;
}

function parseJson(raw) {
  const text = stripFences(raw);
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error("quiz response was not valid JSON");
  }
}

/**
 * Validate a single quiz question object.
 * @returns {{ ok: boolean, error?: string, question?: object }}
 */
export function validateQuestion(q, index = 0) {
  const label = `question ${index + 1}`;
  if (!q || typeof q !== "object") {
    return { ok: false, error: `${label}: not an object` };
  }
  const question = String(q.question ?? q.text ?? "").trim();
  if (!question) {
    return { ok: false, error: `${label}: missing question text` };
  }

  const options = q.options ?? q.choices;
  if (!Array.isArray(options) || options.length !== QUIZ_OPTION_COUNT) {
    return {
      ok: false,
      error: `${label}: must have exactly ${QUIZ_OPTION_COUNT} options`,
    };
  }
  const normalizedOptions = options.map((o) => String(o ?? "").trim());
  if (normalizedOptions.some((o) => !o)) {
    return { ok: false, error: `${label}: options must be non-empty strings` };
  }

  const correctIndex = q.correct_index ?? q.correctIndex ?? q.answer_index;
  if (
    typeof correctIndex !== "number" ||
    !Number.isInteger(correctIndex) ||
    correctIndex < 0 ||
    correctIndex > QUIZ_OPTION_COUNT - 1
  ) {
    return {
      ok: false,
      error: `${label}: correct_index must be an integer 0-${QUIZ_OPTION_COUNT - 1}`,
    };
  }

  return {
    ok: true,
    question: {
      question,
      options: normalizedOptions,
      correct_index: correctIndex,
    },
  };
}

/**
 * Parse and validate quiz JSON from the model.
 * @returns {{ questions: { question: string, options: string[], correct_index: number }[] }}
 */
export function parseQuiz(raw) {
  const parsed = parseJson(raw);
  const rawQuestions = Array.isArray(parsed) ? parsed : parsed?.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    throw new Error("quiz JSON did not contain a non-empty 'questions' array");
  }

  const questions = [];
  for (let i = 0; i < rawQuestions.length; i++) {
    const result = validateQuestion(rawQuestions[i], i);
    if (!result.ok) throw new Error(result.error);
    questions.push(result.question);
  }

  if (questions.length !== QUIZ_QUESTION_COUNT) {
    throw new Error(
      `quiz must contain exactly ${QUIZ_QUESTION_COUNT} questions (got ${questions.length})`
    );
  }

  return { questions };
}

export function buildQuizMessages(architectureSummary, { strict = false } = {}) {
  const system = [
    "You write multiple-choice comprehension checks for a codebase architecture summary.",
    `Based on the summary, write exactly ${QUIZ_QUESTION_COUNT} multiple-choice questions testing whether someone actually understood this codebase's structure.`,
    "Each question must have exactly 4 options and one correct answer.",
    "Reference specific real details from the summary — file names, modules, request flow, tech choices, commit/PR context if mentioned. Not generic software trivia.",
    "Make wrong options plausible but clearly incorrect to someone who read the summary carefully.",
    "",
    'Output ONLY valid JSON in exactly this shape, with no surrounding prose or code fences:',
    '{ "questions": [ { "question": string, "options": [string, string, string, string], "correct_index": number } ] }',
    "correct_index is 0-based (0 = first option).",
  ];

  if (strict) {
    system.push(
      "",
      "STRICT MODE — the previous attempt was malformed. Follow EXACTLY:",
      `- Return exactly ${QUIZ_QUESTION_COUNT} questions.`,
      `- Each question has exactly ${QUIZ_OPTION_COUNT} options.`,
      "- correct_index must be 0, 1, 2, or 3.",
      "- Output ONLY raw JSON. No markdown fences. No explanation before or after."
    );
  }

  const user = [
    "Write the quiz for this architecture summary:",
    "",
    architectureSummary,
  ].join("\n");

  return { system: system.join("\n"), user };
}

/**
 * Generate a comprehension quiz from an architecture summary.
 * @param {string} architectureSummary
 * @returns {Promise<{ questions: object[] }>}
 */
export async function generateQuiz(architectureSummary) {
  const summary = String(architectureSummary ?? "").trim();
  if (!summary) {
    const err = new Error("architecture_summary is required and must be non-empty.");
    err.statusCode = 400;
    err.kind = "bad_request";
    throw err;
  }

  let lastError;
  for (const strict of [false, true]) {
    try {
      const msgs = buildQuizMessages(summary, { strict });
      const raw = await chat({
        ...msgs,
        json: true,
        temperature: strict ? 0.2 : 0.5,
        label: strict ? "quiz-strict" : "quiz",
      });
      return parseQuiz(raw);
    } catch (err) {
      lastError = err;
      if (strict) break;
      console.warn(`[quiz] first attempt invalid: ${err.message}. Retrying strict.`);
    }
  }

  const err = new Error(`Failed to generate a valid quiz: ${lastError?.message ?? lastError}`);
  err.statusCode = 502;
  err.kind = "upstream";
  throw err;
}
