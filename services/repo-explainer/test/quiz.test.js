import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuiz, validateQuestion } from "../src/quiz.js";

const validQuiz = {
  questions: [
    {
      question: "Where is JWT verification handled?",
      options: ["src/server.js", "src/middleware/auth.js", "src/routes/todos.js", "src/db/index.js"],
      correct_index: 1,
    },
    {
      question: "Which DB driver does TodoAPI use?",
      options: ["pg", "mysql2", "better-sqlite3", "mongodb"],
      correct_index: 2,
    },
    {
      question: "Which routes require authentication?",
      options: ["/auth only", "/todos only", "/auth and /todos", "none"],
      correct_index: 1,
    },
    {
      question: "What runs before todo route handlers?",
      options: ["rate limiter only", "requireAuth only", "both rate limiter and requireAuth", "nothing"],
      correct_index: 2,
    },
  ],
};

test("validateQuestion accepts a well-formed question", () => {
  const r = validateQuestion(validQuiz.questions[0], 0);
  assert.equal(r.ok, true);
  assert.equal(r.question.correct_index, 1);
  assert.equal(r.question.options.length, 4);
});

test("validateQuestion rejects wrong option count", () => {
  const r = validateQuestion(
    { question: "Q?", options: ["a", "b"], correct_index: 0 },
    0
  );
  assert.equal(r.ok, false);
});

test("validateQuestion rejects out-of-range correct_index", () => {
  const r = validateQuestion(
    { question: "Q?", options: ["a", "b", "c", "d"], correct_index: 4 },
    0
  );
  assert.equal(r.ok, false);
});

test("parseQuiz accepts valid JSON string", () => {
  const out = parseQuiz(JSON.stringify(validQuiz));
  assert.equal(out.questions.length, 4);
});

test("parseQuiz tolerates code fences", () => {
  const fenced = "```json\n" + JSON.stringify(validQuiz) + "\n```";
  assert.equal(parseQuiz(fenced).questions.length, 4);
});

test("parseQuiz rejects wrong question count", () => {
  const tooFew = { questions: validQuiz.questions.slice(0, 2) };
  assert.throws(() => parseQuiz(JSON.stringify(tooFew)), /exactly 4 questions/);
});

test("parseQuiz rejects malformed JSON", () => {
  assert.throws(() => parseQuiz("not json"));
});
