/**
 * The "Visual" view: a styled, semi-WYSIWYG rendering of the manuscript with
 * live math (KaTeX). It is a reading/navigation surface (editing stays in the
 * source pane), and each sentence/heading carries a data-seg index so the
 * Read-Aloud feature can highlight along in karaoke style. Clicking any block
 * jumps the source editor to its line; double-click starts Read-Aloud there.
 */
import { useMemo, type RefObject } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import type { Block } from "./parse";

function escapeHtml(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Light inline formatting: keep bold/italic/code, render inline math, drop the rest. */
function formatText(t: string): string {
  let s = escapeHtml(t);
  s = s.replace(/\\(?:begin|end)\s*\{[^}]*\}(\[[^\]]*\])?/g, " "); // env delimiters carry no text
  s = s.replace(/\\(?:textbf|bf|mathbf)\{([^{}]*)\}/g, "<b>$1</b>");
  s = s.replace(/\\(?:textit|emph|it)\{([^{}]*)\}/g, "<i>$1</i>");
  s = s.replace(/\\texttt\{([^{}]*)\}/g, "<code>$1</code>");
  s = s.replace(/\\(?:cite|citep|citet)\{([^}]*)\}/g, "<span class='vf-cite'>[$1]</span>");
  s = s.replace(/\\(?:ref|eqref|pageref)\{([^}]*)\}/g, "<span class='vf-ref'>($1)</span>");
  s = s.replace(/~/g, " ");
  s = s.replace(/\\[a-zA-Z@]+\*?/g, " ");
  s = s.replace(/[{}]/g, "");
  return s;
}

function inlineHtml(raw: string): string {
  const parts = raw.split(/(\$[^$]*\$)/);
  return parts
    .map((p) => {
      if (p.length >= 2 && p.startsWith("$") && p.endsWith("$")) {
        try {
          return katex.renderToString(p.slice(1, -1), { throwOnError: false });
        } catch {
          return escapeHtml(p);
        }
      }
      return formatText(p);
    })
    .join("");
}

function displayMath(block: Block): string {
  const body = /^(align|gather|eqnarray|multline)/.test(block.env ?? "")
    ? `\\begin{aligned}${block.raw}\\end{aligned}`
    : block.raw;
  try {
    return katex.renderToString(body, { displayMode: true, throwOnError: false });
  } catch {
    return `<pre>${escapeHtml(block.raw)}</pre>`;
  }
}

interface VisualViewProps {
  blocks: Block[];
  activeSeg: number | null;
  /** Block the source-editor cursor is nearest to (subtle outline). */
  cursorSeg?: number | null;
  containerRef: RefObject<HTMLDivElement>;
  /** Single click: jump the editor to this block's source line. */
  onBlockClick?(block: Block): void;
  /** Double click: start Read-Aloud from this block. */
  onBlockDblClick?(block: Block): void;
}

export default function VisualView({
  blocks,
  activeSeg,
  cursorSeg = null,
  containerRef,
  onBlockClick,
  onBlockDblClick,
}: VisualViewProps) {
  const bySeg = useMemo(() => new Map(blocks.map((b) => [b.seg, b])), [blocks]);

  const segFromEvent = (e: React.MouseEvent): Block | null => {
    const el = (e.target as HTMLElement)?.closest("[data-seg]");
    if (!el) return null;
    const seg = Number(el.getAttribute("data-seg"));
    return bySeg.get(seg) ?? null;
  };

  const cls = (b: Block, base: string) =>
    `${base}${activeSeg === b.seg ? " speaking" : ""}${cursorSeg === b.seg ? " cursor-here" : ""}`;

  const out: React.ReactNode[] = [];
  let paraBuffer: Block[] = [];
  let listBuffer: Block[] = [];

  const flushPara = (key: string) => {
    if (paraBuffer.length === 0) return;
    out.push(
      <p key={key} className="vf-p">
        {paraBuffer.map((b) => (
          <span
            key={b.seg}
            data-seg={b.seg}
            className={cls(b, "vf-sent")}
            dangerouslySetInnerHTML={{ __html: inlineHtml(b.raw) + " " }}
          />
        ))}
      </p>,
    );
    paraBuffer = [];
  };

  const flushList = (key: string) => {
    if (listBuffer.length === 0) return;
    const ordered = listBuffer[0].ordered;
    const items = listBuffer.map((b) => (
      <li key={b.seg} data-seg={b.seg} className={cls(b, "vf-li")}
        dangerouslySetInnerHTML={{ __html: inlineHtml(b.raw) }} />
    ));
    out.push(ordered ? <ol key={key} className="vf-list">{items}</ol> : <ul key={key} className="vf-list">{items}</ul>);
    listBuffer = [];
  };

  blocks.forEach((b, i) => {
    if (b.kind === "paragraph") {
      flushList(`l-${i}`);
      paraBuffer.push(b);
      return;
    }
    if (b.kind === "item") {
      flushPara(`p-${i}`);
      listBuffer.push(b);
      return;
    }
    flushPara(`p-${i}`);
    flushList(`l-${i}`);
    if (b.kind === "title") {
      out.push(
        <h1 key={b.seg} data-seg={b.seg} className={cls(b, "vf-title")}
          dangerouslySetInnerHTML={{ __html: inlineHtml(b.raw) }} />,
      );
    } else if (b.kind === "author") {
      out.push(
        <div key={b.seg} data-seg={b.seg} className={cls(b, "vf-author")}
          dangerouslySetInnerHTML={{ __html: inlineHtml(b.raw.replace(/\\and\b/g, " · ")) }} />,
      );
    } else if (b.kind === "heading") {
      out.push(<h2 key={b.seg} data-seg={b.seg} className={cls(b, "vf-h1")}>{formatPlain(b.raw)}</h2>);
    } else if (b.kind === "subheading") {
      out.push(<h3 key={b.seg} data-seg={b.seg} className={cls(b, "vf-h2")}>{formatPlain(b.raw)}</h3>);
    } else if (b.kind === "subsubheading") {
      out.push(<h4 key={b.seg} data-seg={b.seg} className={cls(b, "vf-h3")}>{formatPlain(b.raw)}</h4>);
    } else if (b.kind === "caption") {
      out.push(
        <div key={b.seg} data-seg={b.seg} className={cls(b, "vf-caption")}>
          <b>Caption. </b>
          <span dangerouslySetInnerHTML={{ __html: inlineHtml(b.raw) }} />
        </div>,
      );
    } else if (b.kind === "math") {
      out.push(
        <div
          key={b.seg}
          data-seg={b.seg}
          className={cls(b, "vf-math")}
          dangerouslySetInnerHTML={{ __html: displayMath(b) }}
        />,
      );
    }
  });
  flushPara("p-tail");
  flushList("l-tail");

  return (
    <div
      className="visualview"
      ref={containerRef}
      onClick={(e) => {
        const b = segFromEvent(e);
        if (b) onBlockClick?.(b);
      }}
      onDoubleClick={(e) => {
        const b = segFromEvent(e);
        if (b) onBlockDblClick?.(b);
      }}
    >
      <div className="vf-page">{out.length ? out : <p className="muted">Nothing to render yet.</p>}</div>
    </div>
  );
}

function formatPlain(raw: string): string {
  // Headings rarely contain math; strip to plain text.
  return raw.replace(/\\[a-zA-Z@]+\*?/g, "").replace(/[{}]/g, "").trim();
}
