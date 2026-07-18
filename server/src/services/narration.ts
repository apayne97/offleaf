/**
 * Narration extraction for the Read-Aloud (TTS) feature.
 *
 * Converts LaTeX source into an ordered list of clean, speakable segments:
 * headings, paragraphs (split into sentences so highlighting is granular),
 * and captions. Math is emitted as its own segment kind so the client can
 * decide whether to skip it, say "equation", or read it naively.
 *
 * This is deliberately a readable linearisation, not a full LaTeX interpreter —
 * enough to listen to a manuscript end to end, which is the spec's goal.
 */
import type { NarrationDocument, NarrationSegment } from "@offleaf/shared";
import { stripLatex } from "./wordcount.js";

function splitSentences(text: string): string[] {
  const clean = stripLatex(text);
  if (!clean) return [];
  // Split on sentence-ending punctuation followed by whitespace + capital/paren.
  return clean
    .split(/(?<=[.!?])\s+(?=[A-Z(\\"'“])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function extractNarration(source: string): NarrationDocument {
  const segments: NarrationSegment[] = [];
  // Body only.
  const docMatch = source.match(/\\begin\{document\}([\s\S]*?)\\end\{document\}/);
  const body = docMatch ? docMatch[1] : source;
  // Precompute line numbers by scanning offsets in the ORIGINAL source.
  const preambleLines = docMatch
    ? source.slice(0, docMatch.index ?? 0).split("\n").length
    : 1;

  // Tokenise the body into a linear stream we can walk.
  // We handle: \section-like headings, \caption{...}, math environments,
  // inline/display math, and everything else as paragraph text.
  const headingRe = /\\(chapter|section|subsection|subsubsection|paragraph)\*?\s*\{([^}]*)\}/g;
  const captionRe = /\\caption\s*\{([^}]*)\}/g;
  const displayMathRe = /\\begin\{(equation|align|gather|multline|eqnarray)\*?\}[\s\S]*?\\end\{\1\*?\}|\\\[[\s\S]*?\\\]/g;

  interface Marker {
    index: number;
    kind: NarrationSegment["kind"];
    text: string;
    length: number;
  }
  const markers: Marker[] = [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(body)) !== null) {
    markers.push({ index: m.index, kind: "heading", text: m[2], length: m[0].length });
  }
  while ((m = captionRe.exec(body)) !== null) {
    markers.push({ index: m.index, kind: "caption", text: m[1], length: m[0].length });
  }
  while ((m = displayMathRe.exec(body)) !== null) {
    markers.push({ index: m.index, kind: "math", text: m[0], length: m[0].length });
  }
  markers.sort((a, b) => a.index - b.index);

  const lineAt = (offset: number): number =>
    preambleLines + body.slice(0, offset).split("\n").length - 1;

  let cursor = 0;
  const emitParagraphs = (chunk: string, baseOffset: number) => {
    // Split the plain-text chunk into paragraphs on blank lines, then sentences.
    const paras = chunk.split(/\n\s*\n/);
    let local = 0;
    for (const para of paras) {
      for (const sentence of splitSentences(para)) {
        segments.push({ text: sentence, kind: "paragraph", sourceLine: lineAt(baseOffset + local) });
      }
      local += para.length + 2;
    }
  };

  for (const marker of markers) {
    if (marker.index > cursor) {
      emitParagraphs(body.slice(cursor, marker.index), cursor);
    }
    if (marker.kind === "heading") {
      const t = stripLatex(marker.text);
      if (t) segments.push({ text: t, kind: "heading", sourceLine: lineAt(marker.index) });
    } else if (marker.kind === "caption") {
      const t = stripLatex(marker.text);
      if (t) segments.push({ text: t, kind: "caption", sourceLine: lineAt(marker.index) });
    } else {
      segments.push({ text: marker.text, kind: "math", sourceLine: lineAt(marker.index) });
    }
    cursor = marker.index + marker.length;
  }
  if (cursor < body.length) emitParagraphs(body.slice(cursor), cursor);

  return { segments };
}
