/**
 * Unit tests for the client-side LaTeX parser that powers the Visual view,
 * visual↔code sync, and Read-Aloud. Pure TypeScript (no DOM), so it runs
 * under tsx like the server tests: `tsx test/parse.test.ts`.
 */
import { parseLatexBlocks, blockNearLine, blockIndexFromLine, spokenText, stripLatex } from "../src/visual/parse";

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
}

const SOURCE = `\\documentclass{article}
\\title{A Test Manuscript}
\\author{Sukrit Singh}
\\begin{document}
\\maketitle
\\begin{abstract}
This is the abstract sentence.
\\end{abstract}
\\section{Introduction}
First sentence of the intro. Second sentence with $x^2$ math!
\\begin{equation}
E = mc^2
\\end{equation}
\\begin{itemize}
\\item First bullet point here.
\\item Second bullet point here.
\\end{itemize}
\\begin{enumerate}
\\item Numbered one.
\\end{enumerate}
\\subsection{Details}
A detail sentence.
\\end{document}`;

const { blocks } = parseLatexBlocks(SOURCE);
const kinds = blocks.map((b) => b.kind);

// --- structure -------------------------------------------------------------
console.log("--- block structure ---");
check("title block extracted from preamble",
  blocks[0].kind === "title" && blocks[0].raw === "A Test Manuscript");
check("author block follows", blocks[1].kind === "author" && /Sukrit/.test(blocks[1].raw));
check("abstract becomes a heading (no leaked 'abstract' text)",
  blocks.some((b) => b.kind === "subheading" && b.raw === "Abstract") &&
  !blocks.some((b) => b.kind === "paragraph" && /^abstract/i.test(b.raw)));
check("section heading parsed",
  blocks.some((b) => b.kind === "heading" && b.raw === "Introduction"));
check("subsection parsed",
  blocks.some((b) => b.kind === "subheading" && b.raw === "Details"));
check("paragraph split into sentences",
  blocks.filter((b) => b.kind === "paragraph" && /sentence/.test(b.raw)).length >= 3);
check("display math becomes a math block with env",
  blocks.some((b) => b.kind === "math" && b.env === "equation" && /mc\^2/.test(b.raw)));
check("itemize items parsed as unordered items",
  blocks.filter((b) => b.kind === "item" && b.ordered === false).length === 2);
check("enumerate items parsed as ordered items",
  blocks.filter((b) => b.kind === "item" && b.ordered === true).length === 1);
check("seg ids are unique and ordered",
  new Set(blocks.map((b) => b.seg)).size === blocks.length);

// --- source-line mapping ----------------------------------------------------
console.log("--- line mapping (visual<->code sync) ---");
const intro = blocks.find((b) => b.kind === "heading" && b.raw === "Introduction")!;
check("\\section{Introduction} maps to line 9", intro.line === 9);
const firstSentence = blocks.find((b) => b.kind === "paragraph" && /^First sentence/.test(b.raw))!;
check("intro paragraph maps to line 10", firstSentence.line === 10);
const eq = blocks.find((b) => b.kind === "math")!;
check("equation maps to its \\begin line", eq.line === 11);
check("blockNearLine(10) → a block on line 10", blockNearLine(blocks, 10)?.line === 10);
check("blockNearLine before any block → first mapped block",
  blockNearLine(blocks, 1) !== null);
check("blockIndexFromLine matches nearLine",
  blocks[blockIndexFromLine(blocks, 10)].seg === blockNearLine(blocks, 10)?.seg);

// --- spoken text (Read-Aloud) ------------------------------------------------
console.log("--- spoken text ---");
check("math block: skip mode says nothing", spokenText(eq, "skip") === "");
check("math block: sayEquation mode", spokenText(eq, "sayEquation") === "equation.");
check("math block: naive mode verbalises", /mc|to the/.test(spokenText(eq, "naive")));
const mathy = blocks.find((b) => /Second sentence/.test(b.raw))!;
check("inline math skipped in skip mode", !/x|\^|2/.test(spokenText(mathy, "skip")));
check("inline math becomes '(expression)' in sayEquation mode",
  /expression/.test(spokenText(mathy, "sayEquation")));
check("stripLatex keeps words, drops commands",
  stripLatex("\\emph{key} finding \\citep{x}") === "key finding");

console.log(`\n${failures === 0 ? "ALL PARSE TESTS PASSED" : failures + " PARSE CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
