import { useRef, useState } from "react";
import {
  runPipeline,
  STAGES,
  type StageId,
  type PipelineResult,
} from "./mockApi";
import "./App.css";

type ViewState = "input" | "progress" | "result" | "error";

function App() {
  const [view, setView] = useState<ViewState>("input");
  const [repoUrl, setRepoUrl] = useState("");
  const [completed, setCompleted] = useState<Set<StageId>>(new Set());
  const [activeStage, setActiveStage] = useState<StageId | null>(null);
  const [failedStage, setFailedStage] = useState<StageId | null>(null);
  const [result, setResult] = useState<PipelineResult | null>(null);
  const forceFailRef = useRef<StageId | undefined>(undefined);

  async function start(forceFailAt?: StageId) {
    setView("progress");
    setCompleted(new Set());
    setFailedStage(null);
    setActiveStage(STAGES[0].id);
    forceFailRef.current = forceFailAt;

    try {
      const res = await runPipeline(
        repoUrl || "github.com/example/demo-repo",
        ({ stage, ok }) => {
          if (ok) {
            setCompleted((prev) => new Set(prev).add(stage));
            const idx = STAGES.findIndex((s) => s.id === stage);
            setActiveStage(STAGES[idx + 1]?.id ?? null);
          } else {
            setFailedStage(stage);
          }
        },
        forceFailAt
      );
      setResult(res);
      setView("result");
    } catch {
      setView("error");
    }
  }

  function retry() {
    // In the real pipeline this should re-trigger only the failed stage,
    // not the whole run. Mocked here as a full re-run without the forced failure.
    start(undefined);
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="tabs">
          <span className={`tab ${view === "input" ? "tab-active" : ""}`}>
            input.tsx
          </span>
          <span className={`tab ${view === "progress" ? "tab-active" : ""}`}>
            building.log
          </span>
          <span className={`tab ${view === "result" ? "tab-active" : ""}`}>
            walkthrough.mp4
          </span>
          <span className={`tab ${view === "error" ? "tab-active" : ""}`}>
            error.log
          </span>
        </div>
        <span className="topbar-brand">repo → video</span>
      </header>

      <main className="stage">
        {view === "input" && (
          <InputView
            repoUrl={repoUrl}
            onChange={setRepoUrl}
            onSubmit={() => start(undefined)}
            onDemoFail={() => start("render")}
          />
        )}

        {view === "progress" && (
          <ProgressView
            completed={completed}
            activeStage={activeStage}
            failedStage={failedStage}
          />
        )}

        {view === "result" && result && (
          <ResultView result={result} onReset={() => setView("input")} />
        )}

        {view === "error" && (
          <ErrorView failedStage={failedStage} onRetry={retry} onBack={() => setView("input")} />
        )}
      </main>
    </div>
  );
}

function InputView({
  repoUrl,
  onChange,
  onSubmit,
  onDemoFail,
}: {
  repoUrl: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onDemoFail: () => void;
}) {
  return (
    <div className="panel input-panel">
      <p className="eyebrow">// no more 40-page onboarding docs</p>
      <h1>Turn any repo into a video someone will actually watch.</h1>
      <p className="lede">
        Paste a GitHub URL. We read the architecture, write the script, and
        hand back a short walkthrough — so the next hire skips the
        archaeology.
      </p>

      <div className="input-row">
        <span className="input-prefix">url&nbsp;&gt;</span>
        <input
          type="text"
          value={repoUrl}
          onChange={(e) => onChange(e.target.value)}
          placeholder="github.com/owner/repo"
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit();
          }}
        />
      </div>

      <div className="actions">
        <button className="btn btn-primary" onClick={onSubmit}>
          Generate walkthrough
        </button>
        <button className="btn btn-ghost" onClick={onDemoFail} title="Demo control: simulate a failed render stage">
          Simulate failure
        </button>
      </div>
    </div>
  );
}

function ProgressView({
  completed,
  activeStage,
  failedStage,
}: {
  completed: Set<StageId>;
  activeStage: StageId | null;
  failedStage: StageId | null;
}) {
  return (
    <div className="panel">
      <p className="eyebrow">// this part writes itself</p>
      <h2 className="progress-title">Committing each stage as it lands.</h2>

      <div className="graph">
        {STAGES.map((s, i) => {
          const isDone = completed.has(s.id);
          const isFailed = failedStage === s.id;
          const isActive = activeStage === s.id && !isFailed;
          const isLast = i === STAGES.length - 1;

          let nodeClass = "node node-pending";
          if (isDone) nodeClass = "node node-done";
          if (isActive) nodeClass = "node node-active";
          if (isFailed) nodeClass = "node node-failed";

          return (
            <div className="graph-row" key={s.id}>
              <div className="graph-line-col">
                <div className={nodeClass}>
                  {isDone && <span className="check">✓</span>}
                  {isFailed && <span className="cross">✕</span>}
                </div>
                {!isLast && (
                  <div className={`line ${isDone ? "line-done" : ""}`} />
                )}
              </div>
              <div className="graph-label-col">
                <span className={`graph-hash ${isDone ? "hash-done" : ""}`}>
                  {shortHash(s.id)}
                </span>
                <span className="graph-label">{s.label}</span>
                {isActive && <span className="graph-status">running…</span>}
                {isFailed && <span className="graph-status graph-status-error">failed</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ResultView({
  result,
  onReset,
}: {
  result: PipelineResult;
  onReset: () => void;
}) {
  return (
    <div className="panel result-panel">
      <p className="eyebrow">// done · {result.repo}</p>
      <h2>Ready to share. No slide deck required.</h2>

      <div className="result-grid">
        <div className="video-col">
          <video className="video" src={result.videoUrl} controls playsInline />
        </div>
        <div className="summary-col">
          <h3>What changed / what matters</h3>
          <p className="summary-text">{result.summary}</p>
          <h3>Architecture</h3>
          <pre className="diagram-block">{result.diagram}</pre>
        </div>
      </div>

      <div className="actions">
        <button className="btn btn-ghost" onClick={onReset}>
          Do another repo
        </button>
      </div>
    </div>
  );
}

function ErrorView({
  failedStage,
  onRetry,
  onBack,
}: {
  failedStage: StageId | null;
  onRetry: () => void;
  onBack: () => void;
}) {
  const stage = STAGES.find((s) => s.id === failedStage);
  return (
    <div className="panel error-panel">
      <p className="eyebrow eyebrow-error">// well, that's embarrassing</p>
      <h2>The {stage?.label ?? "pipeline"} stage didn't finish.</h2>
      <p className="lede">
        Nothing else was lost — the earlier stages already completed. Retrying
        will pick up from where it stopped, not start over.
      </p>
      <div className="actions">
        <button className="btn btn-primary" onClick={onRetry}>
          Retry
        </button>
        <button className="btn btn-ghost" onClick={onBack}>
          Start over
        </button>
      </div>
    </div>
  );
}

function shortHash(id: StageId) {
  const map: Record<StageId, string> = {
    fetch: "a3f1c9",
    analyze: "7e2b4d",
    narrate: "f08a15",
    render: "c91d02",
  };
  return map[id];
}

export default App;
