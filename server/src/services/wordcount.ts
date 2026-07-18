/**
 * WordCountService.
 *
 * Two responsibilities:
 *   1. Document / per-section counts. Uses `texcount` (the standard LaTeX-aware
 *      counter that ships with TeX Live) when available — it correctly ignores
 *      markup and separates body text from headers, captions, and math. When
 *      texcount is absent, a dependency-free JS fallback keeps the feature
 *      working (labelled as an estimate).
 *   2. Selection count — instant, LaTeX-aware count of an arbitrary snippet the
 *      user has highlighted (the headline feature in the spec).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  SectionCount,
  SelectionCountResult,
  WordCountBreakdown,
  WordCountResult,
} from "@offleaf/shared";
import { projectRoot, hasCommand } from "../config.js";

const execFileAsync = promisify(execFile);

const EMPTY_BREAKDOWN: WordCountBreakdown = {
  wordsInText: 0,
  wordsInHeaders: 0,
  wordsInCaptions: 0,
  headers: 0,
  floats: 0,
  mathInline: 0,
  mathDisplay: 0,
};

/**
 * Strip LaTeX markup down to readable words. Used by the selection counter and
 * the JS fallback. Intentionally conservative: it keeps the textual arguments
 * of formatting commands (so \textbf{foo} -> foo) but drops control sequences,
 * math, comments, and environment delimiters.
 */
export function stripLatex(input: string): string {
  let s = input;
  // Remove comments (unescaped %).
  s = s.replace(/(^|[^\\])%.*$/gm, "$1");
  // Drop commands whose arguments are labels/refs/citations/metadata — these
  // must never be read aloud or counted as words (e.g. \label{sec:intro}).
  s = s.replace(
    /\\(?:label|ref|eqref|pageref|autoref|cite[a-zA-Z]*|nocite|input|include|usepackage|documentclass|bibliography|bibliographystyle|includegraphics|hypersetup|newcommand|renewcommand|def|setlength)\*?\s*(?:\[[^\]]*\])?\s*(?:\{[^{}]*\})?/gi,
    " ",
  );
  // Remove display and inline math entirely.
  s = s.replace(/\$\$[\s\S]*?\$\$/g, " ");
  s = s.replace(/\\\[[\s\S]*?\\\]/g, " ");
  s = s.replace(/\$[^$]*\$/g, " ");
  s = s.replace(/\\\([\s\S]*?\\\)/g, " ");
  // Drop \begin{...}/\end{...} delimiters (keep inner text).
  s = s.replace(/\\(begin|end)\s*\{[^}]*\}(\[[^\]]*\])?/g, " ");
  // Commands with a braced argument we want to keep the text of: \textbf{x} -> x
  s = s.replace(/\\[a-zA-Z@]+\*?\s*(\[[^\]]*\])?\s*\{([^{}]*)\}/g, " $2 ");
  // Any remaining control sequences.
  s = s.replace(/\\[a-zA-Z@]+\*?/g, " ");
  s = s.replace(/\\[^a-zA-Z]/g, " ");
  // Leftover braces / alignment / line breaks.
  s = s.replace(/[{}~^&]/g, " ");
  s = s.replace(/\\\\/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

function countWords(text: string): number {
  const clean = stripLatex(text);
  if (!clean) return 0;
  return clean.split(/\s+/).filter(Boolean).length;
}

/** Instant, LaTeX-aware count of a highlighted snippet. */
export function selectionCount(text: string): SelectionCountResult {
  const clean = stripLatex(text);
  const words = clean ? clean.split(/\s+/).filter(Boolean).length : 0;
  const characters = clean.length;
  const charactersNoSpaces = clean.replace(/\s/g, "").length;
  return { words, characters, charactersNoSpaces, estimate: true };
}

/**
 * Parse full (non-brief) `texcount -sub=section -merge` output. The totals come
 * from the labelled lines:
 *   Words in text: 188
 *   Words in headers: 14
 *   ...
 * and the per-section rows from the "Subcounts:" block, e.g.:
 *   40+1+0 (1/0/7/1) Section: Introduction
 * meaning text+headers+captions (#headers/#floats/#inlines/#displays).
 * NB: `-brief` and `-total` both suppress the Subcounts block, so neither flag
 * can be used here (verified against texcount 3.2 / TeX Live 2024).
 */
export function parseTexcount(stdout: string): WordCountResult {
  const sections: SectionCount[] = [];
  const total: WordCountBreakdown = { ...EMPTY_BREAKDOWN };

  const grab = (re: RegExp): number => {
    const m = stdout.match(re);
    return m ? Number(m[1]) : 0;
  };
  total.wordsInText = grab(/^Words in text:\s*(\d+)/m);
  total.wordsInHeaders = grab(/^Words in headers:\s*(\d+)/m);
  total.wordsInCaptions = grab(/^Words outside text[^:]*:\s*(\d+)/m);
  total.headers = grab(/^Number of headers:\s*(\d+)/m);
  total.floats = grab(/^Number of floats[^:]*:\s*(\d+)/m);
  total.mathInline = grab(/^Number of math inlines:\s*(\d+)/m);
  total.mathDisplay = grab(/^Number of math displayed:\s*(\d+)/m);

  const subRe = /^\s*(\d+)\+(\d+)\+(\d+)\s*\(\d+\/\d+\/\d+\/\d+\)\s*(Chapter|Section|Subsection|Subsubsection|Paragraph):\s*(.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = subRe.exec(stdout)) !== null) {
    const words = Number(m[1]);
    const kind = m[4];
    const title = m[5].trim();
    // Indent nested levels so the panel reads like an outline.
    const prefix = kind === "Subsection" ? "  " : kind === "Subsubsection" ? "    " : "";
    sections.push({ title: prefix + (title || kind), words });
  }
  return { total, sections };
}

/** JS fallback: crude but useful section split when texcount is unavailable. */
function jsFallbackCount(source: string): WordCountResult {
  // Body only.
  const body = source.replace(/^[\s\S]*?\\begin\{document\}/, "").replace(/\\end\{document\}[\s\S]*$/, "");
  const sectionRe = /\\(section|subsection|subsubsection|chapter)\*?\s*\{([^}]*)\}/g;
  const sections: SectionCount[] = [];
  const marks: { title: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = sectionRe.exec(body)) !== null) {
    marks.push({ title: m[2], index: m.index });
  }
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : body.length;
    sections.push({ title: marks[i].title, words: countWords(body.slice(start, end)) });
  }
  const headers = marks.length;
  const total: WordCountBreakdown = {
    ...EMPTY_BREAKDOWN,
    wordsInText: countWords(body),
    wordsInHeaders: marks.reduce((n, mk) => n + countWords(mk.title), 0),
    headers,
    mathInline: (body.match(/\$[^$]+\$/g) ?? []).length,
    mathDisplay:
      (body.match(/\\\[[\s\S]*?\\\]/g) ?? []).length +
      (body.match(/\\begin\{(equation|align|gather|multline)\*?\}/g) ?? []).length,
  };
  return { total, sections };
}

/**
 * Whole-document + per-section counts. `mainRelPath` is project-relative; the
 * caller also supplies the raw source for the fallback path.
 */
export async function documentCount(
  mainRelPath: string,
  source: string,
  projectId?: string,
): Promise<WordCountResult & { engine: "texcount" | "js-fallback" }> {
  if (hasCommand("texcount")) {
    try {
      const { stdout } = await execFileAsync(
        "texcount",
        ["-sub=section", "-merge", "-utf8", mainRelPath],
        { cwd: projectRoot(projectId), timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
      );
      const parsed = parseTexcount(stdout);
      // If texcount produced nothing parseable, fall back.
      if (parsed.total.wordsInText > 0 || parsed.sections.length > 0) {
        return { ...parsed, engine: "texcount" };
      }
    } catch {
      /* fall through to JS fallback */
    }
  }
  return { ...jsFallbackCount(source), engine: "js-fallback" };
}
