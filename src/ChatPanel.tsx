import { useEffect, useRef, useState } from "react";
import {
  askQuestion,
  ChatHttpError,
  chatBackend,
  chatMode,
  type ChatBackendPreference,
  type IngestResult,
} from "./api";

interface QaTurn {
  question: string;
  answer: string;
  sources: string[];
}

interface ChatPanelProps {
  ingestion: IngestResult;
  placeholder: string;
  compact?: boolean;
  collapsible?: boolean;
  collapsibleLabel?: string;
  examples?: string[];
  hint?: string;
  contextType?: "repo" | "tool";
  backend?: ChatBackendPreference;
}

function friendlyChatError(err: unknown): string {
  if (err instanceof ChatHttpError) {
    if (err.status === 404) {
      return "Process a repo first to enable chat.";
    }
    return err.message;
  }
  if (err instanceof Error) {
    if (/failed to fetch|can't reach|network/i.test(err.message)) {
      return "Can't reach the chat service — check your connection or backend URL.";
    }
    return err.message;
  }
  return "Something went wrong";
}

export function ChatPanel({
  ingestion,
  placeholder,
  compact = false,
  collapsible = false,
  collapsibleLabel = "Ask a question about this codebase.",
  examples = [],
  hint,
  contextType = "repo",
  backend = "auto",
}: ChatPanelProps) {
  const [open, setOpen] = useState(!collapsible);
  const [turns, setTurns] = useState<QaTurn[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [activeSource, setActiveSource] = useState<string | null>(null);
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
      const history = turns.map((t) => ({ question: t.question, answer: t.answer }));
      const { answer, sources } = await askQuestion(
        ingestion,
        question,
        controller.signal,
        contextType,
        { history, backend }
      );
      setTurns((prev) => [...prev, { question, answer, sources }]);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(friendlyChatError(err));
      setInput(question);
    } finally {
      setLoading(false);
    }
  }

  const mode = chatMode();

  const panelBody = (
    <>
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
          {turns.map((turn, i) => {
            const isLatest = i === turns.length - 1;
            const enterClass = isLatest ? " chat-bubble-enter" : "";
            return (
              <div key={i} className="chat-turn">
                <div className={`chat-bubble chat-bubble-user${enterClass}`}>{turn.question}</div>
                <div className={`chat-bubble chat-bubble-assistant${enterClass}`}>
                  {turn.answer}
                  {turn.sources.length > 0 && (
                    <div className="chat-sources">
                      {turn.sources.map((s) => (
                        <button
                          type="button"
                          className={`chat-source ${activeSource === s ? "chat-source-active" : ""}`}
                          key={s}
                          title={s}
                          aria-label={`Source file: ${s}`}
                          onClick={() => setActiveSource((prev) => (prev === s ? null : s))}
                        >
                          {s.split("#")[0]}
                          {activeSource === s && (
                            <span className="chat-source-tooltip" role="tooltip">
                              {s}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {loading && (
            <div className="chat-bubble chat-bubble-assistant chat-typing chat-bubble-enter">
              Thinking…
            </div>
          )}
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
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              submit(input);
            }
          }}
        />
        <button type="submit" className="chat-send" disabled={loading || !input.trim()}>
          Send
        </button>
      </form>

      <p className="chat-mode">
        {mode === "live"
          ? backend === "explain" || (backend === "auto" && chatBackend() === "gemini-rag")
            ? "● Gemini (RAG)"
            : chatBackend() === "gemini"
              ? "● Gemini"
              : "● Gemini (RAG)"
          : "○ mock chat"}
      </p>
    </>
  );

  if (collapsible) {
    return (
      <div className={`chat-panel chat-panel-collapsible ${compact ? "chat-panel-compact" : ""}`}>
        <button
          type="button"
          className="chat-collapsible-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span className={`chat-collapsible-caret ${open ? "chat-collapsible-caret-open" : ""}`}>
            ▸
          </span>
          {collapsibleLabel}
        </button>
        <div className={`collapsible ${open ? "collapsible-open" : ""}`}>
          <div className="collapsible-inner chat-collapsible-body">{panelBody}</div>
        </div>
      </div>
    );
  }

  return (
    <div className={`chat-panel ${compact ? "chat-panel-compact" : ""}`}>{panelBody}</div>
  );
}
