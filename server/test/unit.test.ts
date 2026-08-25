/**
 * Unit tests for the backend's pure logic — no LaTeX toolchain needed, so
 * these run anywhere in under a second. Run with `tsx test/unit.test.ts`.
 *
 * Covers: the path-traversal guard (the security boundary), the project
 * registry, latexmk log parsing, texcount output parsing, LaTeX stripping /
 * selection counting, and narration extraction.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.OFFLEAF_PROJECT = path.join(here, "fixture");

const { initDefaultProject, safeResolve, registerProject, projectRoot, listProjects } =
  await import("../src/config.js");
initDefaultProject();

const { parseLog } = await import("../src/services/compile.js");
const { parseTexcount, stripLatex, selectionCount } = await import("../src/services/wordcount.js");
const { extractNarration } = await import("../src/services/narration.js");

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
}
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
console.log("--- safeResolve (path-traversal guard) ---");
const fixtureRoot = projectRoot();
check("resolves a plain relative path inside the root",
  safeResolve("paper.tex") === path.join(fixtureRoot, "paper.tex"));
check("resolves nested paths",
  safeResolve("figs/plot.png") === path.join(fixtureRoot, "figs/plot.png"));
check("strips leading slashes instead of treating them as absolute",
  safeResolve("/paper.tex") === path.join(fixtureRoot, "paper.tex"));
check("rejects ../ traversal", throws(() => safeResolve("../../../../etc/passwd")));
check("rejects sneaky nested traversal", throws(() => safeResolve("figs/../../outside.txt")));
check("allows the root itself", safeResolve(".") === fixtureRoot);

// ---------------------------------------------------------------------------
console.log("--- project registry ---");
const again = registerProject(fixtureRoot);
const viaTilde = registerProject(fixtureRoot); // same dir → same id, no dupes
check("same directory always maps to the same id", again.id === viaTilde.id);
check("registered project resolves through projectRoot(id)",
  projectRoot(again.id) === fixtureRoot);
check("bad directory is rejected", throws(() => registerProject("/no/such/dir/anywhere")));
check("a file (not a dir) is rejected",
  throws(() => registerProject(path.join(fixtureRoot, "paper.tex"))));
check("listProjects includes the boot project as default",
  listProjects().some((p) => p.isDefault && p.root === fixtureRoot));

// ---------------------------------------------------------------------------
console.log("--- latexmk/pdflatex log parsing ---");
const sampleLog = [
  "This is pdfTeX, Version 3.141592653",
  "./main.tex:12: Undefined control sequence.",
  "l.12 \\thisisnotacommand",
  "! Emergency stop.",
  "LaTeX Warning: Reference `eq:missing' on page 1 undefined on input line 47.",
  "Package natbib Warning: Citation `foo99' on page 2 undefined on input line 3.",
  "Overfull \\hbox (12.3pt too wide) in paragraph at lines 30--31",
  "./main.tex:12: Undefined control sequence.", // duplicate → deduped
].join("\n");
const parsed = parseLog(sampleLog);
check("finds the file:line error with its location",
  parsed.errors.some((e) => e.file === "main.tex" && e.line === 12));
check("finds bang-prefixed errors", parsed.errors.some((e) => /Emergency stop/.test(e.message)));
check("deduplicates repeated errors",
  parsed.errors.filter((e) => /Undefined control sequence/.test(e.message)).length === 1);
check("classifies LaTeX warnings", parsed.warnings.some((w) => /eq:missing/.test(w.message)));
check("classifies package warnings", parsed.warnings.some((w) => /natbib/.test(w.message)));
check("classifies overfull boxes as warnings",
  parsed.warnings.some((w) => /Overfull/.test(w.message)));

// ---------------------------------------------------------------------------
console.log("--- texcount output parsing ---");
const texcountOut = `File: main.tex
Encoding: ascii
Words in text: 188
Words in headers: 14
Words outside text (captions, etc.): 3
Number of headers: 7
Number of floats/tables/figures: 1
Number of math inlines: 14
Number of math displayed: 2
Subcounts:
  text+headers+captions (#headers/#floats/#inlines/#displayed)
  46+7+0 (2/0/0/0) _top_
  40+1+0 (1/0/7/1) Section: Introduction
  45+1+0 (1/0/7/1) Section: Theory
  12+2+0 (1/0/0/0) Subsection: Umbrella sampling
  16+1+0 (1/0/0/0) Section: Conclusion
`;
const wc = parseTexcount(texcountOut);
check("total words parsed", wc.total.wordsInText === 188);
check("headers/captions/math totals parsed",
  wc.total.wordsInHeaders === 14 && wc.total.wordsInCaptions === 3 &&
  wc.total.mathInline === 14 && wc.total.mathDisplay === 2 && wc.total.floats === 1);
check("per-section rows parsed, plus front matter", wc.sections.length === 5);
check("_top_ surfaced as Front matter, listed first",
  wc.sections[0].title === "Front matter" && wc.sections[0].words === 46);
check("section words parsed", wc.sections[1].title === "Introduction" && wc.sections[1].words === 40);
check("subsections indented as outline",
  wc.sections.some((s) => s.title === "  Umbrella sampling"));

// ---------------------------------------------------------------------------
console.log("--- LaTeX stripping / selection counting ---");
check("keeps formatting-command text", stripLatex("\\textbf{bold} plain") === "bold plain");
check("drops labels and citations",
  stripLatex("text \\label{sec:x} more \\citep{key123}") === "text more");
check("drops math", stripLatex("before $x^2 + y$ after") === "before after");
check("drops env delimiters, keeps body",
  stripLatex("\\begin{abstract}Words here\\end{abstract}") === "Words here");
const sel = selectionCount("\\textbf{hello} world $x^2$ \\cite{ref}");
check("selection counts 2 words for markup-heavy snippet", sel.words === 2);

// ---------------------------------------------------------------------------
console.log("--- narration (TTS) extraction ---");
const doc = `\\documentclass{article}
\\begin{document}
\\section{Introduction}
First sentence here. Second sentence follows!
\\begin{equation} E = mc^2 \\end{equation}
\\caption{A figure caption.}
\\end{document}`;
const narration = extractNarration(doc);
const kinds = narration.segments.map((s) => s.kind);
check("emits a heading segment", kinds.includes("heading"));
check("splits paragraph into sentences",
  narration.segments.filter((s) => s.kind === "paragraph").length === 2);
check("emits math as its own segment kind", kinds.includes("math"));
check("emits captions", kinds.includes("caption"));
check("heading carries a source line",
  (narration.segments.find((s) => s.kind === "heading")?.sourceLine ?? 0) === 3);

console.log(`\n${failures === 0 ? "ALL UNIT TESTS PASSED" : failures + " UNIT CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
