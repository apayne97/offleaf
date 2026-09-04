/**
 * Ground-truth word-count test (run with `tsx test/wordcount.test.ts`).
 *
 * The rest of the suite only checks that parseTexcount() correctly reads a
 * hand-typed *fake* texcount transcript (unit.test.ts), or that a real
 * compile produces a non-zero count (compile.test.ts) — neither ever
 * confirms the numbers are actually right. This file does: GROUND_TRUTH.tex
 * below has every word hand-counted (see the comment above it), and both
 * counting engines — the real `texcount` binary (via documentCount(), the
 * same call the server makes) and the dependency-free JS fallback used when
 * texcount isn't installed — are asserted against those exact numbers, not
 * just "non-zero" or "roughly right". The texcount-dependent checks are
 * skipped (not failed) on a TeX install that lacks it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// registerProject() below writes to the recent-projects list — keep the
// throwaway fixture dirs this file creates out of the real machine's
// ~/.config/offleaf/recent.json.
process.env.OFFLEAF_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "offleaf-config-"));

const { documentCount, jsFallbackCount } = await import("../src/services/wordcount.js");
const { registerProject, hasCommand } = await import("../src/config.js");

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}

/**
 * Every field below was hand-counted from the source text, independent of
 * what any tool reports — this is the actual ground truth, not a captured
 * "whatever the tool said" snapshot:
 *
 *  Section "Introduction Overview" (2 header words: Introduction, Overview):
 *   "This is a short introduction paragraph with exactly ten words total
 *    here now."                                                  -> 13 words
 *   "Here is a second paragraph containing exactly eight more
 *    words indeed."                                              -> 11 words
 *   "Inline math like [$x^2+y^2=z^2$ removed] appears here in
 *    this sentence okay."                                         -> 9 words
 *   section body total: 13 + 11 + 9                              -> 33 words
 *   caption "A simple figure caption with six words."             -> 7 words
 *   one \begin{figure} (1 float), one inline $...$ (1), one
 *   \begin{equation} (1 display math, "E = mc^2" is NOT prose)
 *
 *  Section "Conclusion" (1 header word):
 *   "Short final section with five words only."                   -> 7 words
 *
 *  Totals: text 33+7=40, headers 2+1=3, captions 7, headers-count 2,
 *          floats 1, math inline 1, math display 1.
 */
const GROUND_TRUTH_TEX = `\\documentclass{article}
\\begin{document}

\\section{Introduction Overview}
This is a short introduction paragraph with exactly ten words total here now.

Here is a second paragraph containing exactly eight more words indeed.

\\begin{figure}
\\caption{A simple figure caption with six words.}
\\end{figure}

Inline math like $x^2 + y^2 = z^2$ appears here in this sentence okay.

\\begin{equation}
E = mc^2
\\end{equation}

\\section{Conclusion}
Short final section with five words only.

\\end{document}
`;

const EXPECTED = {
  wordsInText: 40,
  wordsInHeaders: 3,
  wordsInCaptions: 7,
  headers: 2,
  floats: 1,
  mathInline: 1,
  mathDisplay: 1,
};
const EXPECTED_SECTIONS = [
  { title: "Introduction Overview", words: 33 },
  { title: "Conclusion", words: 7 },
];

async function main() {
  console.log("--- JS fallback engine vs hand-counted ground truth ---");
  const fb = jsFallbackCount(GROUND_TRUTH_TEX);
  for (const [key, expected] of Object.entries(EXPECTED)) {
    check(`fallback ${key} = ${expected}`, fb.total[key as keyof typeof EXPECTED] === expected, `got ${fb.total[key as keyof typeof EXPECTED]}`);
  }
  check(
    "fallback section words match",
    EXPECTED_SECTIONS.every(
      (s, i) => fb.sections[i]?.title === s.title && fb.sections[i]?.words === s.words,
    ),
    JSON.stringify(fb.sections),
  );

  console.log("\n--- texcount engine vs hand-counted ground truth ---");
  if (!hasCommand("texcount")) {
    console.log("SKIP  texcount not installed on this machine");
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offleaf-wc-"));
    const file = "ground_truth.tex";
    fs.writeFileSync(path.join(dir, file), GROUND_TRUTH_TEX);
    try {
      const { id } = registerProject(dir);
      const tc = await documentCount(file, GROUND_TRUTH_TEX, id);
      check("engine is texcount, not js-fallback", tc.engine === "texcount");
      for (const [key, expected] of Object.entries(EXPECTED)) {
        check(`texcount ${key} = ${expected}`, tc.total[key as keyof typeof EXPECTED] === expected, `got ${tc.total[key as keyof typeof EXPECTED]}`);
      }
      check(
        "texcount section words match",
        EXPECTED_SECTIONS.every(
          (s, i) => tc.sections[i]?.title === s.title && tc.sections[i]?.words === s.words,
        ),
        JSON.stringify(tc.sections),
      );
      check(
        "the two engines agree exactly on this fixture",
        JSON.stringify(tc.total) === JSON.stringify(fb.total),
        `texcount=${JSON.stringify(tc.total)} fallback=${JSON.stringify(fb.total)}`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log("\n--- front-matter labelling: \\begin{abstract} -> \"Abstract\" ---");
  // Hand count: "This abstract has exactly seven words total." = 7 words;
  // "Body text here with a few words." = 7 words.
  const ABSTRACT_TEX = `\\documentclass{article}
\\begin{document}

\\begin{abstract}
This abstract has exactly seven words total.
\\end{abstract}

\\section{Introduction}
Body text here with a few words.

\\end{document}
`;
  const fbAbs = jsFallbackCount(ABSTRACT_TEX);
  check(
    "fallback labels front matter 'Abstract' when \\begin{abstract} is present",
    fbAbs.sections[0]?.title === "Abstract" && fbAbs.sections[0]?.words === 7,
    JSON.stringify(fbAbs.sections),
  );
  if (hasCommand("texcount")) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offleaf-wc-abs-"));
    const file = "abstract_test.tex";
    fs.writeFileSync(path.join(dir, file), ABSTRACT_TEX);
    try {
      const { id } = registerProject(dir);
      const tcAbs = await documentCount(file, ABSTRACT_TEX, id);
      check(
        "texcount labels front matter 'Abstract' when \\begin{abstract} is present",
        tcAbs.sections[0]?.title === "Abstract" && tcAbs.sections[0]?.words === 7,
        JSON.stringify(tcAbs.sections),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } else {
    console.log("SKIP  texcount not installed on this machine");
  }
  // Front matter with no \begin{abstract} must NOT be mislabelled "Abstract".
  const NO_ABSTRACT_TEX = `\\documentclass{article}
\\begin{document}

Some preamble remark with no abstract environment here at all.

\\section{Introduction}
Body text.

\\end{document}
`;
  const fbNoAbs = jsFallbackCount(NO_ABSTRACT_TEX);
  check(
    "front matter without \\begin{abstract} stays generically labelled",
    fbNoAbs.sections[0]?.title === "Front matter",
    JSON.stringify(fbNoAbs.sections),
  );

  console.log("\n--- all-captions document (0 body words) must still use texcount, not silently downgrade ---");
  // A document that is nothing but a caption legitimately has "Words in
  // text: 0" and (with only one heading) no Subcounts block at all — this
  // is texcount succeeding, not failing to parse. Modeled on a real SI
  // figures file that is 100% \begin{figure}...\caption{...}\end{figure}.
  const ALL_CAPTIONS_TEX = `\\documentclass{article}
\\begin{document}

\\section{Figures}

\\begin{figure}
\\caption{The only words in this document live in this caption right here.}
\\end{figure}

\\end{document}
`;
  if (hasCommand("texcount")) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offleaf-wc-cap-"));
    const file = "all_captions.tex";
    fs.writeFileSync(path.join(dir, file), ALL_CAPTIONS_TEX);
    try {
      const { id } = registerProject(dir);
      const tcCap = await documentCount(file, ALL_CAPTIONS_TEX, id);
      check(
        "an all-captions document still reports engine=texcount (not js-fallback)",
        tcCap.engine === "texcount",
        `got engine=${tcCap.engine}`,
      );
      check("wordsInText is genuinely 0", tcCap.total.wordsInText === 0);
      check("caption words counted correctly", tcCap.total.wordsInCaptions === 12, `got ${tcCap.total.wordsInCaptions}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } else {
    console.log("SKIP  texcount not installed on this machine");
  }

  console.log(`\n${failures === 0 ? "ALL WORDCOUNT GROUND-TRUTH CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
