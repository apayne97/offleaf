/**
 * End-to-end backend smoke test (run with `tsx test/compile.test.ts`).
 *
 * Compiles the base-package fixture with the real latexmk toolchain and checks
 * that a PDF (and, when synctex is present, a .synctex.gz) is produced, that
 * word counting works, and that the LaTeX-aware selection counter is correct.
 * Guards the synctex/texcount assertions so it still passes on a minimal TeX
 * install that lacks those helpers.
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.OFFLEAF_PROJECT = path.join(here, "fixture");

// Register the fixture as the boot project (index.ts does this at startup).
const { initDefaultProject, safeResolve } = await import("../src/config.js");
initDefaultProject();

const { CompileService } = await import("../src/services/compile.js");
const { documentCount, selectionCount } = await import("../src/services/wordcount.js");
const { extractNarration } = await import("../src/services/narration.js");

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
}

async function main() {
  const compiler = new CompileService();
  const result = await new Promise<any>((resolve) => {
    compiler.start({ mainFile: "paper.tex", engine: "pdflatex", cleanBuild: true }, (msg) => {
      if (msg.type === "compile:done") resolve(msg.result);
    });
  });

  console.log("\n--- compile ---");
  check("compile succeeded", result.success === true);
  check("PDF produced", !!result.pdfUrl);
  const pdfAbs = path.join(process.env.OFFLEAF_PROJECT!, ".build", "paper.pdf");
  check("PDF file exists on disk", fs.existsSync(pdfAbs));

  const synctexAbs = path.join(process.env.OFFLEAF_PROJECT!, ".build", "paper.synctex.gz");
  if (fs.existsSync(synctexAbs)) {
    check("synctexReady flag set", result.synctexReady === true);
  } else {
    console.log("SKIP  synctex not produced by this TeX install");
  }

  // Mirrors /api/pdf/export's logic: copy the build output next to the
  // .tex source, confined to the project root via safeResolve.
  console.log("\n--- pdf export (download-to-source-folder) ---");
  const destRel = "paper.tex".replace(/\.tex$/i, ".pdf");
  const destAbs = safeResolve(destRel);
  if (fs.existsSync(destAbs)) fs.unlinkSync(destAbs);
  fs.copyFileSync(pdfAbs, destAbs);
  check("export lands next to the .tex source, same basename", fs.existsSync(destAbs));
  check("exported PDF matches the compiled build output",
    fs.readFileSync(destAbs).equals(fs.readFileSync(pdfAbs)));
  fs.unlinkSync(destAbs);

  console.log("\n--- word count ---");
  const source = fs.readFileSync(path.join(process.env.OFFLEAF_PROJECT!, "paper.tex"), "utf8");
  const wc = await documentCount("paper.tex", source);
  check(`document has sections (engine=${wc.engine})`, wc.sections.length >= 2);
  check("document has non-zero words", wc.total.wordsInText > 0);

  const sel = selectionCount("\\textbf{hello} world $x^2$");
  check("selection counts markup-stripped words (=2)", sel.words === 2);

  console.log("\n--- narration (TTS) ---");
  const narration = extractNarration(source);
  check("narration produced segments", narration.segments.length > 0);
  check(
    "narration includes a heading",
    narration.segments.some((s) => s.kind === "heading"),
  );

  console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
