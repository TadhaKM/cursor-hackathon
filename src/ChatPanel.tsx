import { useEffect, useRef, useState } from "react";
import { askQuestion, chatMode, type IngestResult } from "./api";

interface QaTurn {
  question: string;
  answer: string;
  sources: string[];
}

interface ChatPanelProps {
  ingestion: IngestResult;
  placeholder: string;
  compact?: boolean;
  examples?: string[];
  hint?: string;
}

export function ChatPanel({
  ingestion,
  placeholder,
  compact = false,
  examples = [],
  hint,
}: ChatPanelProps) {
  const [turns, setTurns] = useState<QaTurn[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, loading]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  async function submit(text: string) {
    const question = text.trim();
    if (!question || loading) return;

    setInput("");
    setError("");
    setLoading(true);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const { answer, sources } = await askQuestion(ingestion, question, controller.signal);
      setTurns((prev) => [...prev, { question, answer, sources }]);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Something went wrong");
      setInput(question);
    } finally {
      setLoading(false);
    }
  }

  const mode = chatMode();

  return (
    <div className={`chat-panel ${compact ? "chat-panel-compact" : ""}`}>
      {hint && <p className="chat-hint">{hint}</p>}

      {examples.length > 0 && turns.length === 0 && (
        <div className="chat-examples">
          {examples.map((example) => (
            <button
              key={example}
              type="button"
              className="chat-example"
              onClick={() => submit(example)}
              disabled={loading}
            >
              {example}
            </button>
          ))}
        </div>
      )}

      {turns.length > 0 && (
        <div className="chat-messages" ref={scrollRef}>
          {turns.map((turn, i) => (
            <div key={i} className="chat-turn">
              <div className="chat-bubble chat-bubble-user">{turn.question}</div>
              <div className="chat-bubble chat-bubble-assistant">
                {turn.answer}
                {turn.sources.length > 0 && (
                  <div className="chat-sources">
                    {turn.sources.map((s) => (
                      <span className="chat-source" key={s}>
                        {s}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          {loading && <div className="chat-bubble chat-bubble-assistant chat-typing">Thinking…</div>}
        </div>
      )}

      {error && <p className="chat-error">{error}</p>}

      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
      >
        <input
          className="chat-input chat-input-active"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={placeholder}
          disabled={loading}
          aria-label="Chat message"
        />
        <button type="submit" className="chat-send" disabled={loading || !input.trim()}>
          Send
        </button>
      </form>

      <p className="chat-mode">
        {mode === "live" ? "● Qwen via repo-explainer" : "○ mock chat — set VITE_EXPLAIN_URL to enable"}
      </p>
    </div>
  );
}
