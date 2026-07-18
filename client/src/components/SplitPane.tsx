/**
 * A minimal, dependency-free two-pane splitter with a draggable divider.
 * Horizontal = side-by-side (the code|preview layout); vertical = stacked.
 */
import { useCallback, useRef, useState, type ReactNode } from "react";

interface SplitPaneProps {
  direction?: "horizontal" | "vertical";
  initial?: number; // initial size of the first pane, in px
  min?: number;
  max?: number;
  first: ReactNode;
  second: ReactNode;
}

export default function SplitPane({
  direction = "horizontal",
  initial = 300,
  min = 120,
  max = 1200,
  first,
  second,
}: SplitPaneProps) {
  const [size, setSize] = useState(initial);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  const onMove = useCallback(
    (e: PointerEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const raw = direction === "horizontal" ? e.clientX - rect.left : e.clientY - rect.top;
      setSize(Math.max(min, Math.min(max, raw)));
    },
    [direction, min, max],
  );

  const stop = useCallback(() => {
    dragging.current = false;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", stop);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, [onMove]);

  const start = useCallback(() => {
    dragging.current = true;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    document.body.style.cursor = direction === "horizontal" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  }, [onMove, stop, direction]);

  const isH = direction === "horizontal";
  return (
    <div ref={containerRef} className={`split ${isH ? "split-h" : "split-v"}`}>
      <div className="split-pane" style={isH ? { width: size } : { height: size }}>
        {first}
      </div>
      <div className={`split-divider ${isH ? "divider-h" : "divider-v"}`} onPointerDown={start} />
      <div className="split-pane split-grow">{second}</div>
    </div>
  );
}
