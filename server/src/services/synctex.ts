/**
 * SyncTeXService — forward (source -> PDF) and inverse (PDF -> source) search
 * using the `synctex` CLI against the `.synctex.gz` produced by `-synctex=1`.
 *
 * Both directions fail soft: if synctex is missing or the query does not
 * resolve, they return null rather than throwing, so the UI degrades to "no
 * jump available" instead of erroring.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SyncForwardResult, SyncInverseResult } from "@offleaf/shared";
import { projectRoot, hasCommand, toRelative } from "../config.js";

const execFileAsync = promisify(execFile);

function field(output: string, key: string): string | undefined {
  const m = output.match(new RegExp(`^${key}:(.*)$`, "m"));
  return m ? m[1].trim() : undefined;
}

/**
 * Forward search: given a source location, return the page and coordinates in
 * the PDF. `pdfRel` is the project-relative path to the compiled PDF, e.g.
 * ".build/main.pdf".
 */
export async function forward(
  fileRel: string,
  line: number,
  column: number,
  pdfRel: string,
  projectId?: string,
): Promise<SyncForwardResult | null> {
  if (!hasCommand("synctex")) return null;
  try {
    const { stdout } = await execFileAsync(
      "synctex",
      ["view", "-i", `${line}:${Math.max(column, 0)}:${fileRel}`, "-o", pdfRel],
      { cwd: projectRoot(projectId), timeout: 10000 },
    );
    const page = field(stdout, "Page");
    const x = field(stdout, "x");
    const y = field(stdout, "y");
    if (!page || x === undefined || y === undefined) return null;
    return {
      page: Number(page),
      x: Number(x),
      y: Number(y),
      height: Number(field(stdout, "H") ?? 0) || undefined,
      width: Number(field(stdout, "W") ?? 0) || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Inverse search: given a PDF page + coordinates, return the source file+line.
 */
export async function inverse(
  page: number,
  x: number,
  y: number,
  pdfRel: string,
  projectId?: string,
): Promise<SyncInverseResult | null> {
  if (!hasCommand("synctex")) return null;
  try {
    const { stdout } = await execFileAsync(
      "synctex",
      ["edit", "-o", `${page}:${x}:${y}:${pdfRel}`],
      { cwd: projectRoot(projectId), timeout: 10000 },
    );
    const input = field(stdout, "Input");
    const line = field(stdout, "Line");
    if (!input || !line) return null;
    return {
      file: toRelative(input, projectId),
      line: Number(line),
      column: Number(field(stdout, "Column") ?? -1) || undefined,
    };
  } catch {
    return null;
  }
}
