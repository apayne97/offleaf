/**
 * A pragmatic LaTeX parser for the "Visual" reading view and the Read-Aloud
 * feature. It converts source into an ordered list of Blocks: headings,
 * paragraph sentences (so highlighting is per-sentence), list items, captions,
 * and display math. Inline math inside paragraphs is preserved in `raw` so the
 * visual view can render it with KaTeX, while Read-Aloud decides how to speak
 * it. Every block carries the 1-based source line it came from, which powers
 * visual↔code cursor sync and "read from cursor".
 *
 * This is intentionally a subset renderer, not a TeX interpreter — enough to
 * read and listen to a manuscript, which is what the spec asks for.
 */

export type BlockKind =
  | "title"
  | "author"
  | "heading"
  | "subheading"
  | "subsubheading"
  | "paragraph"
  | "item"
  | "caption"
  | "math";

export interface Block {
  seg: number;
  kind: BlockKind;
  /** Raw LaTeX for the segment (paragraphs keep inline math; math keeps body). */
  raw: string;
  /** For math blocks: the environment name, if any (align, equation, ...). */
  env?: string;
  /** 1-based line in the source file this block starts on. */
  line?: number;
  /** For items: true when inside enumerate (numbered). */
  ordered?: boolean;
}

export interface ParsedDoc {
  blocks: Block[];
}

/** Strip LaTeX markup to readable words (client-side mirror of the server's). */
export function stripLatex(input: string): string {
  let s = input;
  s = s.replace(/(^|[^\\])%.*$/gm, "$1");
  // Drop reference/citation/metadata commands (with their args) so they are
  // never read aloud or counted, e.g. \label{sec:intro} or \citep{key}.
  s = s.replace(
    /\\(?:label|ref|eqref|pageref|autoref|cite[a-zA-Z]*|nocite|input|include|usepackage|documentclass|bibliography|bibliographystyle|includegraphics|hypersetup|newcommand|renewcommand|def|setlength)\*?\s*(?:\[[^\]]*\])?\s*(?:\{[^{}]*\})?/gi,
    " ",
  );
  s = s.replace(/\$\$[\s\S]*?\$\$/g, " ");
  s = s.replace(/\\\[[\s\S]*?\\\]/g, " ");
  s = s.replace(/\$[^$]*\$/g, " ");
  s = s.replace(/\\\([\s\S]*?\\\)/g, " ");
  s = s.replace(/\\(begin|end)\s*\{[^}]*\}(\[[^\]]*\])?/g, " ");
  s = s.replace(/\\[a-zA-Z@]+\*?\s*(\[[^\]]*\])?\s*\{([^{}]*)\}/g, " $2 ");
  s = s.replace(/\\[a-zA-Z@]+\*?/g, " ");
  s = s.replace(/\\[^a-zA-Z]/g, " ");
  s = s.replace(/[{}~^&]/g, " ");
  s = s.replace(/\\\\/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

const headingKind = (name: string): BlockKind => {
  switch (name) {
    case "chapter":
    case "section":
      return "heading";
    case "subsection":
      return "subheading";
    default:
      return "subsubheading";
  }
};

/** Sentence split that also reports each sentence's offset within `raw`. */
function splitSentencesWithOffsets(raw: string): { text: string; offset: number }[] {
  const out: { text: string; offset: number }[] = [];
  const re = /(?<=[.!?])\s+(?=[A-Z\\(])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const push = (text: string, offset: number) => {
    const trimmed = text.trim();
    if (trimmed && stripLatex(trimmed).length > 0) {
      out.push({ text: trimmed, offset: offset + (text.length - text.trimStart().length) });
    }
  };
  while ((m = re.exec(raw)) !== null) {
    push(raw.slice(last, m.index), last);
    last = re.lastIndex;
  }
  push(raw.slice(last), last);
  return out;
}

export function parseLatexBlocks(source: string): ParsedDoc {
  const blocks: Block[] = [];
  let seg = 0;

  // Line lookup: lineStarts[i] = offset of the first char of line i+1.
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") lineStarts.push(i + 1);
  }
  const lineAt = (srcOffset: number): number => {
    let lo = 0,
      hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= srcOffset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  // Title block from the preamble (rendered like \maketitle would).
  const grabArg = (cmd: string): { text: string; offset: number } | null => {
    const m = source.match(new RegExp(`\\\\${cmd}\\s*\\{((?:[^{}]|\\{[^{}]*\\})*)\\}`));
    return m && m.index !== undefined ? { text: m[1], offset: m.index } : null;
  };
  const title = grabArg("title");
  const author = grabArg("author");
  if (title && stripLatex(title.text)) {
    blocks.push({ seg: seg++, kind: "title", raw: title.text, line: lineAt(title.offset) });
  }
  if (author && stripLatex(author.text)) {
    blocks.push({ seg: seg++, kind: "author", raw: author.text, line: lineAt(author.offset) });
  }

  const docMatch = source.match(/\\begin\{document\}([\s\S]*?)\\end\{document\}/);
  const bodyStart = docMatch && docMatch.index !== undefined
    ? docMatch.index + "\\begin{document}".length
    : 0;
  let body = docMatch ? docMatch[1] : source;

  // Blank out comments and structural no-ops, PRESERVING length/offsets so
  // line numbers stay exact (replacements are space-padded).
  body = body.replace(/(^|[^\\])%.*$/gm, (full: string, lead: string) => lead + " ".repeat(full.length - lead.length));
  body = body.replace(/\\label\s*\{[^}]*\}/g, (full: string) => " ".repeat(full.length));
  body = body.replace(
    /\\(maketitle|tableofcontents|newpage|clearpage|bigskip|medskip|smallskip|centering|noindent)\b/g,
    (full: string) => " ".repeat(full.length),
  );

  const re =
    /\\(chapter|section|subsection|subsubsection|paragraph)\*?\s*\{([^}]*)\}|\\begin\{(equation|align|gather|multline|eqnarray)\*?\}([\s\S]*?)\\end\{\3\*?\}|\\\[([\s\S]*?)\\\]|\\caption\s*\{((?:[^{}]|\{[^{}]*\})*)\}|\\begin\{(abstract|itemize|enumerate|quote|quotation)\}|\\end\{(abstract|itemize|enumerate|quote|quotation)\}|\\item\b/g;

  // List/abstract state while walking linearly.
  const listStack: ("itemize" | "enumerate")[] = [];
  let pendingItem: { offset: number } | null = null;

  const emitText = (chunk: string, bodyOffset: number) => {
    // Everything between structural markers: paragraphs (blank-line separated)
    // or, when a \item is pending, the item's text.
    const paras = chunk.split(/\n\s*\n/);
    let local = 0;
    for (const para of paras) {
      for (const s of splitSentencesWithOffsets(para)) {
        const abs = bodyStart + bodyOffset + local + s.offset;
        if (pendingItem) {
          blocks.push({
            seg: seg++,
            kind: "item",
            raw: s.text,
            line: lineAt(abs),
            ordered: listStack[listStack.length - 1] === "enumerate",
          });
          pendingItem = null;
        } else if (listStack.length > 0) {
          // Continuation sentences of the current \item stay items visually.
          const prev = blocks[blocks.length - 1];
          if (prev && prev.kind === "item") {
            prev.raw += " " + s.text;
          } else {
            blocks.push({ seg: seg++, kind: "paragraph", raw: s.text, line: lineAt(abs) });
          }
        } else {
          blocks.push({ seg: seg++, kind: "paragraph", raw: s.text, line: lineAt(abs) });
        }
      }
      local += para.length + 2;
    }
  };

  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m.index > last) emitText(body.slice(last, m.index), last);
    const abs = bodyStart + m.index;
    if (m[1]) {
      blocks.push({ seg: seg++, kind: headingKind(m[1]), raw: m[2], line: lineAt(abs) });
    } else if (m[3]) {
      blocks.push({ seg: seg++, kind: "math", raw: m[4].trim(), env: m[3], line: lineAt(abs) });
    } else if (m[5] !== undefined) {
      blocks.push({ seg: seg++, kind: "math", raw: m[5].trim(), line: lineAt(abs) });
    } else if (m[6] !== undefined) {
      blocks.push({ seg: seg++, kind: "caption", raw: m[6], line: lineAt(abs) });
    } else if (m[7] !== undefined) {
      if (m[7] === "abstract") {
        blocks.push({ seg: seg++, kind: "subheading", raw: "Abstract", line: lineAt(abs) });
      } else if (m[7] === "itemize" || m[7] === "enumerate") {
        listStack.push(m[7]);
      }
    } else if (m[8] !== undefined) {
      if (m[8] === "itemize" || m[8] === "enumerate") listStack.pop();
      pendingItem = null;
    } else {
      // \item
      pendingItem = { offset: abs };
    }
    last = re.lastIndex;
  }
  if (last < body.length) emitText(body.slice(last), last);
  return { blocks };
}

/** The block whose source line is closest at-or-before `line` (for sync). */
export function blockNearLine(blocks: Block[], line: number): Block | null {
  let best: Block | null = null;
  for (const b of blocks) {
    if (b.line === undefined || b.kind === "title" || b.kind === "author") continue;
    if (b.line <= line && (!best || b.line >= (best.line ?? 0))) best = b;
  }
  return best ?? blocks.find((b) => b.line !== undefined) ?? null;
}

/** Index of the first block at-or-after `line` (for "read from cursor"). */
export function blockIndexFromLine(blocks: Block[], line: number): number {
  const near = blockNearLine(blocks, line);
  if (!near) return 0;
  return Math.max(0, blocks.findIndex((b) => b.seg === near.seg));
}

export type MathReadMode = "skip" | "sayEquation" | "naive";

/** Verbalise a math body naively (drop control words, read symbols loosely). */
function naiveMath(latex: string): string {
  return latex
    .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "$1 over $2")
    .replace(/\^\{?([^}\s]+)\}?/g, " to the $1")
    .replace(/_\{?([^}\s]+)\}?/g, " sub $1")
    .replace(/\\[a-zA-Z]+/g, (t) => " " + t.slice(1) + " ")
    .replace(/[{}\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The text Read-Aloud should speak for a block, given the math mode. */
export function spokenText(block: Block, mode: MathReadMode): string {
  if (block.kind === "math") {
    if (mode === "skip") return "";
    if (mode === "sayEquation") return "equation.";
    return naiveMath(block.raw);
  }
  // Paragraphs/headings/captions: strip, but honour math mode for inline math.
  let raw = block.raw;
  if (mode === "skip") {
    raw = raw.replace(/\$[^$]*\$/g, " ");
  } else if (mode === "sayEquation") {
    raw = raw.replace(/\$[^$]*\$/g, " (expression) ");
  } else {
    raw = raw.replace(/\$([^$]*)\$/g, (_, inner) => " " + naiveMath(inner) + " ");
  }
  return stripLatex(raw);
}
