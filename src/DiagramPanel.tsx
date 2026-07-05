import { useEffect, useRef, useState } from "react";
import type { DiagramHighlight } from "./api";

const KROKI_SVG_URL = "https://kroki.io/mermaid/svg";

interface DiagramPanelProps {
  mermaidDiagram: string | null;
  diagramImageUrl: string | null;
  activeSection: number;
  highlights: DiagramHighlight[];
}

export function DiagramPanel({
  mermaidDiagram,
  diagramImageUrl,
  activeSection,
  highlights,
}: DiagramPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svgMarkup, setSvgMarkup] = useState<string | null>(null);
  const [svgError, setSvgError] = useState(false);
  const [captionPos, setCaptionPos] = useState<{ x: number; y: number } | null>(null);

  const activeHighlight = highlights.find((h) => h.section_index === activeSection);

  useEffect(() => {
    if (!mermaidDiagram) {
      setSvgMarkup(null);
      setSvgError(false);
      return;
    }

    let cancelled = false;
    setSvgError(false);

    fetch(KROKI_SVG_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: mermaidDiagram,
    })
      .then((res) => {
        if (!res.ok) throw new Error(`Kroki SVG failed (${res.status})`);
        return res.text();
      })
      .then((svg) => {
        if (!cancelled) setSvgMarkup(svg);
      })
      .catch(() => {
        if (!cancelled) {
          setSvgError(true);
          setSvgMarkup(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [mermaidDiagram]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !svgMarkup) return;

    const svg = container.querySelector("svg");
    if (!svg) return;

    container.querySelectorAll(".diagram-highlight-active").forEach((el) => {
      el.classList.remove("diagram-highlight-active");
    });

    if (!activeHighlight) {
      setCaptionPos(null);
      return;
    }

    const nodeId = activeHighlight.node_id;
    const candidates = [
      ...container.querySelectorAll(`[id*="${nodeId}"]`),
      ...container.querySelectorAll(`g[id^="flowchart-${nodeId}"]`),
      ...container.querySelectorAll(`g[id*="-${nodeId}-"]`),
    ];

    let target: Element | null = candidates[0] ?? null;

    if (!target) {
      const labels = container.querySelectorAll("text, tspan, .nodeLabel, p");
      const caption = activeHighlight.caption?.toLowerCase() ?? "";
      for (const label of labels) {
        if (label.textContent && caption && label.textContent.toLowerCase().includes(caption)) {
          target = label.closest("g") ?? label;
          break;
        }
      }
    }

    if (!target) {
      setCaptionPos(null);
      return;
    }

    const highlightEl = target.closest("g") ?? target;
    highlightEl.classList.add("diagram-highlight-active");

    const containerRect = container.getBoundingClientRect();
    const nodeRect = highlightEl.getBoundingClientRect();
    setCaptionPos({
      x: nodeRect.left - containerRect.left + nodeRect.width / 2,
      y: nodeRect.top - containerRect.top - 8,
    });
  }, [svgMarkup, activeHighlight, activeSection]);

  if (!mermaidDiagram && !diagramImageUrl) return null;

  if (svgMarkup) {
    return (
      <div className="diagram-panel" ref={containerRef}>
        <div
          className="diagram-svg-wrap"
          dangerouslySetInnerHTML={{ __html: svgMarkup }}
          aria-label="Architecture diagram"
        />
        {activeHighlight?.caption && captionPos && (
          <div
            className="diagram-caption"
            style={{ left: captionPos.x, top: captionPos.y }}
          >
            {activeHighlight.caption}
          </div>
        )}
      </div>
    );
  }

  if (diagramImageUrl && !svgError) {
    return (
      <img className="diagram-image" src={diagramImageUrl} alt="Architecture diagram" />
    );
  }

  if (diagramImageUrl) {
    return (
      <img className="diagram-image" src={diagramImageUrl} alt="Architecture diagram" />
    );
  }

  return null;
}
