/**
 * Document outline — the manuscript's \section/\subsection/\subsubsection
 * structure, shown under the file tree. Click a heading to jump the editor
 * (and the Visual view) to that line; the section containing the cursor is
 * highlighted. Reuses the same parsed blocks (with source-line mapping) that
 * power the Visual view, so it costs nothing extra to compute.
 */
import type { Block } from "../visual/parse";

const HEADING_KINDS = new Set(["heading", "subheading", "subsubheading"]);

const depthOf = (kind: Block["kind"]): number =>
  kind === "heading" ? 0 : kind === "subheading" ? 1 : 2;

function plainTitle(raw: string): string {
  return raw.replace(/\\[a-zA-Z@]+\*?/g, "").replace(/[{}$]/g, "").replace(/\s+/g, " ").trim();
}

export default function Outline({
  blocks,
  cursorLine,
  onJump,
}: {
  blocks: Block[];
  /** Current 1-based editor cursor line (highlights the enclosing section). */
  cursorLine: number;
  onJump(block: Block): void;
}) {
  const headings = blocks.filter((b) => HEADING_KINDS.has(b.kind) && b.line !== undefined);

  // The heading the cursor currently sits under: last one at-or-before it.
  let activeSeg: number | null = null;
  for (const h of headings) {
    if ((h.line as number) <= cursorLine) activeSeg = h.seg;
  }

  return (
    <div className="outline">
      <div className="panel-title">Outline</div>
      {headings.length === 0 ? (
        <div className="muted outline-empty">No sections found.</div>
      ) : (
        headings.map((h) => (
          <div
            key={h.seg}
            className={`outline-row depth-${depthOf(h.kind)}${h.seg === activeSeg ? " active" : ""}`}
            title={`Jump to line ${h.line}`}
            onClick={() => onJump(h)}
          >
            {plainTitle(h.raw) || "(untitled)"}
          </div>
        ))
      )}
    </div>
  );
}
