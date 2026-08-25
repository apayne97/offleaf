/**
 * Tab strip above the PDF preview — one tab per compiled document (the main
 * file, plus optionally others added via the "+" picker, e.g. a paper that
 * separately compiles si_figures.tex). Clicking a tab switches which
 * document's PDF the preview shows; each tab remembers its own last compile
 * result independently, so switching tabs doesn't require recompiling.
 */
import { useEffect, useRef, useState } from "react";
import type { CompileState } from "@offleaf/shared";

export interface DocTabInfo {
  file: string;
  label: string;
  status: CompileState | "idle";
}

interface DocTabsProps {
  tabs: DocTabInfo[];
  activeIndex: number;
  /** Project documents not already open as a tab, offered in the "+" menu. */
  addable: string[];
  onSelect(index: number): void;
  onClose(index: number): void;
  onAdd(file: string): void;
}

export default function DocTabs({ tabs, activeIndex, addable, onSelect, onClose, onAdd }: DocTabsProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);

  return (
    <div className="doctabs" ref={rootRef}>
      {tabs.map((t, i) => (
        <button
          key={t.file}
          className={`doctab ${i === activeIndex ? "on" : ""}`}
          onClick={() => onSelect(i)}
          title={t.file}
        >
          <span className={`doctab-dot ${t.status}`} />
          {t.label}
          {tabs.length > 1 && (
            <span
              className="doctab-close"
              onClick={(e) => {
                e.stopPropagation();
                onClose(i);
              }}
              title="Close tab"
            >
              ×
            </span>
          )}
        </button>
      ))}
      {addable.length > 0 && (
        <div className="doctab-add">
          <button onClick={() => setMenuOpen((v) => !v)} title="Add a PDF tab for another document">
            + Add
          </button>
          {menuOpen && (
            <div className="doctab-menu">
              {addable.map((f) => (
                <button
                  key={f}
                  className="doctab-menu-item"
                  onClick={() => {
                    onAdd(f);
                    setMenuOpen(false);
                  }}
                >
                  {f}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
