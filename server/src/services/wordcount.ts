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
const FRONT_MATTER_LABEL = "Front matter";

/**
 * Best-effort label for content that sits before the first \section/\chapter
 * — most commonly the abstract. Falls back to the generic label when nothing
 * recognizable is found there, since front matter just as easily could be a
 * title block, a TOC, or other material with no single good name.
 */
function frontMatterLabel(headText: string): string {
  if (/\\begin\{abstract\}/.test(headText)) return "Abstract";
  return FRONT_MATTER_LABEL;
}

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

  // Anything before the first \section (title, authors, abstract, ...)
  // texcount buckets as "_top_" — its words are already folded into the
  // total above, but the subRe loop above never matches this line (no
  // Chapter/Section/... label), so they'd otherwise vanish from the
  // per-section breakdown the panel shows, looking like an undercount
  // (e.g. an \input{abstract} abstract read as "missing").
  const topM = stdout.match(/^\s*(\d+)\+(\d+)\+(\d+)\s*\(\d+\/\d+\/\d+\/\d+\)\s*_top_\s*$/m);
  if (topM && Number(topM[1]) > 0) {
    // Real labelling (e.g. "Abstract") happens in documentCount(), which has
    // the source text to inspect; parseTexcount only sees texcount's stdout.
    sections.unshift({ title: FRONT_MATTER_LABEL, words: Number(topM[1]) });
  }
  return { total, sections };
}

const DISPLAY_MATH_ENVS = "equation|align|gather|multline|eqnarray";
const FLOAT_ENVS = "figure|table";

/**
 * Find every `openRe` match (a command up to and including its opening `{`,
 * e.g. `\caption{`) and remove its whole braced argument, nesting-aware —
 * plain `[^{}]*` regex capture cannot do this, and real captions almost
 * always nest (`\caption{\textbf{Title.} more text}`), so a naive regex
 * either mis-truncates the capture or fails to match at all. Returns the
 * body with every matched argument excised (replaced with a space) and the
 * total word count of everything that was removed.
 */
function extractBraceArgs(body: string, openRe: RegExp): { body: string; words: number } {
  let words = 0;
  let result = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(body)) !== null) {
    const openIdx = m.index + m[0].length - 1; // position of the '{' itself
    let depth = 0;
    let closeIdx = -1;
    for (let i = openIdx; i < body.length; i++) {
      if (body[i] === "{") depth++;
      else if (body[i] === "}" && --depth === 0) {
        closeIdx = i;
        break;
      }
    }
    if (closeIdx === -1) break; // unbalanced braces — leave the remainder alone
    words += countWords(body.slice(openIdx + 1, closeIdx));
    result += body.slice(last, m.index) + " ";
    last = closeIdx + 1;
    openRe.lastIndex = closeIdx + 1;
  }
  result += body.slice(last);
  return { body: result, words };
}

/** JS fallback: crude but useful section split when texcount is unavailable. */
export function jsFallbackCount(source: string): WordCountResult {
  // Body only.
  let body = source.replace(/^[\s\S]*?\\begin\{document\}/, "").replace(/\\end\{document\}[\s\S]*$/, "");

  // Tally math/floats against the untouched body first (the stripping below
  // removes the very markers these count).
  const mathInline = (body.match(/\$[^$]+\$/g) ?? []).length;
  const mathDisplayEnvRe = new RegExp(`\\\\begin\\{(?:${DISPLAY_MATH_ENVS})\\*?\\}`, "g");
  const mathDisplay = (body.match(/\\\[[\s\S]*?\\\]/g) ?? []).length + (body.match(mathDisplayEnvRe) ?? []).length;
  const floats = (body.match(new RegExp(`\\\\begin\\{(?:${FLOAT_ENVS})\\*?\\}`, "g")) ?? []).length;

  // Captions aren't prose in the surrounding body — pull their words out into
  // their own bucket (matching texcount's schema) instead of letting them
  // inflate wordsInText / a section's count.
  const { body: bodyNoCaptions, words: wordsInCaptions } = extractBraceArgs(body, /\\caption\*?\s*(?:\[[^\]]*\])?\s*\{/g);
  body = bodyNoCaptions;

  // Display-math environment bodies (e.g. "E = mc^2") are not words either —
  // unlike $...$ and \[...\], stripLatex's generic begin/end handling would
  // otherwise keep this content and count it as prose.
  body = body.replace(new RegExp(`\\\\begin\\{(${DISPLAY_MATH_ENVS})\\*?\\}[\\s\\S]*?\\\\end\\{\\1\\*?\\}`, "g"), " ");

  const sectionRe = /\\(section|subsection|subsubsection|chapter)\*?\s*\{([^}]*)\}/g;
  const sections: SectionCount[] = [];
  // matchStart bounds the PREVIOUS section's content (must stop before this
  // section's own \section{...} command starts); contentStart is where THIS
  // section's own content begins (must skip past its own command, so its
  // title isn't double-counted as body words — it's already in wordsInHeaders).
  const marks: { title: string; matchStart: number; contentStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = sectionRe.exec(body)) !== null) {
    marks.push({ title: m[2], matchStart: m.index, contentStart: m.index + m[0].length });
  }
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].contentStart;
    const end = i + 1 < marks.length ? marks[i + 1].matchStart : body.length;
    sections.push({ title: marks[i].title, words: countWords(body.slice(start, end)) });
  }
  // Content before the first heading (title, authors, abstract, ...) — same
  // idea as parseTexcount's "_top_" handling above, kept in sync so both
  // engines surface it the same way instead of one silently dropping it.
  const preFirstHeading = body.slice(0, marks.length > 0 ? marks[0].matchStart : body.length);
  const frontMatterWords = countWords(preFirstHeading);
  if (frontMatterWords > 0) {
    sections.unshift({ title: frontMatterLabel(preFirstHeading), words: frontMatterWords });
  }
  const headers = marks.length;
  // The whole-document total must not count heading titles as body words
  // either (matchStart..contentStart per mark, above, only fixed this for
  // individual sections) — strip every heading command out first.
  const bodyForTotal = body.replace(/\\(section|subsection|subsubsection|chapter)\*?\s*\{[^}]*\}/g, " ");
  const total: WordCountBreakdown = {
    ...EMPTY_BREAKDOWN,
    wordsInText: countWords(bodyForTotal),
    wordsInHeaders: marks.reduce((n, mk) => n + countWords(mk.title), 0),
    wordsInCaptions,
    headers,
    floats,
    mathInline,
    mathDisplay,
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
      // Fall back only when texcount's output wasn't in the shape we expect
      // (e.g. a version with a different format) — NOT just because the
      // numbers happen to be zero. A document that's all figures/captions
      // (an SI figures file, say) legitimately has "Words in text: 0" and no
      // Subcounts block (only one heading); that is texcount succeeding, not
      // failing, and the old `wordsInText > 0 || sections.length > 0` check
      // would wrongly discard it and silently downgrade to the JS estimate.
      if (/^Words in text:\s*\d+/m.test(stdout)) {
        if (parsed.sections[0]?.title === FRONT_MATTER_LABEL) {
          const firstHeadingIdx = source.search(/\\(section|chapter)\*?\s*\{/);
          const head = firstHeadingIdx === -1 ? source : source.slice(0, firstHeadingIdx);
          parsed.sections[0] = { ...parsed.sections[0], title: frontMatterLabel(head) };
        }
        return { ...parsed, engine: "texcount" };
      }
    } catch {
      /* fall through to JS fallback */
    }
  }
  return { ...jsFallbackCount(source), engine: "js-fallback" };
}
