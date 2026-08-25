/**
 * CompileService — drives `latexmk` with the same defaults Overleaf uses.
 *
 * The base flags (nonstop interaction, file:line:error, SyncTeX) live in
 * @offleaf/shared so the client can display exactly what will run. `latexmk`
 * itself handles the BibTeX/biber passes and re-runs until labels converge, so
 * we do not reimplement multi-pass logic — that is the whole point of matching
 * Overleaf's toolchain rather than approximating it.
 */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import type {
  CompileRequest,
  CompileResult,
  CompileState,
  LatexEngine,
  LogEntry,
  ServerMessage,
} from "@offleaf/shared";
import { LATEXMK_BASE_FLAGS, engineFlag } from "@offleaf/shared";
import { projectRoot, safeResolve, BUILD_DIR, toRelative } from "../config.js";

const execFileAsync = promisify(execFile);
const COMPILE_TIMEOUT_MS = 120_000;

interface Job {
  jobId: string;
  /** Registry id of the project this job compiles ("" = boot project). */
  projectId: string;
  mainFile: string;
  baseName: string;
  state: CompileState;
  proc?: ReturnType<typeof spawn>;
  rawLog: string;
  startedAt: number;
  result?: CompileResult;
}

type Emit = (msg: ServerMessage) => void;

export class CompileService {
  private jobs = new Map<string, Job>();
  /** Most recently produced PDF per project, used by /api/pdf and SyncTeX. */
  private latest = new Map<string, { jobId: string; baseName: string }>();

  /** Project-relative path to the PDF for a job (or a project's latest). */
  pdfRelFor(jobId?: string, projectId = ""): string | null {
    const base = jobId
      ? this.jobs.get(jobId)?.baseName
      : this.latest.get(projectId)?.baseName;
    if (!base) return null;
    return `${BUILD_DIR}/${base}.pdf`;
  }

  /** The project a job belongs to (needed to resolve its PDF path). */
  projectFor(jobId: string): string | undefined {
    return this.jobs.get(jobId)?.projectId;
  }

  pdfAbsFor(jobId?: string, projectId = ""): string | null {
    const pid = jobId ? this.jobs.get(jobId)?.projectId ?? projectId : projectId;
    const rel = this.pdfRelFor(jobId, pid);
    return rel ? safeResolve(rel, pid) : null;
  }

  stop(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (job?.proc && job.state === "running") {
      killTree(job.proc);
      job.state = "stopped";
      return true;
    }
    return false;
  }

  /**
   * Kick off a compile. Returns the jobId immediately; progress and the final
   * result are delivered through `emit` (compile:status / compile:log /
   * compile:done). Runs latexmk in the project root.
   */
  start(req: CompileRequest, emit: Emit, projectId = ""): string {
    const jobId = randomUUID();
    const mainFile = req.mainFile;
    const baseName = path.basename(mainFile, path.extname(mainFile));
    const job: Job = {
      jobId,
      projectId,
      mainFile,
      baseName,
      state: "queued",
      rawLog: "",
      startedAt: Date.now(),
    };
    this.jobs.set(jobId, job);
    emit({ type: "compile:status", jobId, state: "queued", projectId });
    // Fire and forget — the heavy work happens off the request path.
    void this.run(job, req, emit);
    return jobId;
  }

  private async run(job: Job, req: CompileRequest, emit: Emit): Promise<void> {
    const cwd = projectRoot(job.projectId);

    if (req.cleanBuild) {
      try {
        await execFileAsync(
          "latexmk",
          ["-C", `-outdir=${BUILD_DIR}`, job.mainFile],
          { cwd, timeout: 30000 },
        );
      } catch {
        /* a failed clean is non-fatal */
      }
    }

    job.state = "running";
    emit({ type: "compile:status", jobId: job.jobId, state: "running", projectId: job.projectId });

    await precompileExternalDocuments(cwd, job, req.engine, emit);

    const args = [
      engineFlag(req.engine),
      ...LATEXMK_BASE_FLAGS,
      `-outdir=${BUILD_DIR}`,
      ...(req.shellEscape ? ["-shell-escape"] : []),
      job.mainFile,
    ];

    // Own process group so stop/timeout can kill latexmk AND its pdflatex/
    // bibtex children (killing just latexmk leaves the engine running).
    const proc = spawn("latexmk", args, { cwd, detached: process.platform !== "win32" });
    job.proc = proc;

    const timer = setTimeout(() => {
      if (job.state === "running") {
        killTree(proc, "SIGKILL");
        job.state = "error";
      }
    }, COMPILE_TIMEOUT_MS);

    let buffer = "";
    const onData = (chunk: Buffer) => {
      job.rawLog += chunk.toString();
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const entry = classifyLine(line);
        if (entry) emit({ type: "compile:log", jobId: job.jobId, entry, projectId: job.projectId });
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);

    const exitCode: number = await new Promise((resolve) => {
      proc.on("close", (code) => resolve(code ?? 1));
      proc.on("error", () => resolve(127));
    });
    clearTimeout(timer);

    const pdfRel = `${BUILD_DIR}/${job.baseName}.pdf`;
    const pdfAbs = safeResolve(pdfRel, job.projectId);
    const synctexAbs = safeResolve(`${BUILD_DIR}/${job.baseName}.synctex.gz`, job.projectId);
    const pdfExists = fs.existsSync(pdfAbs);
    // `job.state` can be mutated to "stopped"/"error" by the timeout closure,
    // which TS's control-flow analysis cannot see — read it through a widened
    // local so these comparisons are not flagged as unintentional.
    const wasStopped = (job.state as CompileState) === "stopped";
    const success = exitCode === 0 && pdfExists && !wasStopped;

    // Parse diagnostics from the final pdflatex pass's .log file when it
    // exists: latexmk's stdout accumulates EVERY pass, so intermediate
    // "undefined citation / rerun" warnings that the last pass resolved would
    // otherwise linger in the panel. Fall back to stdout (e.g. latexmk itself
    // failed before producing a log).
    let logText = job.rawLog;
    try {
      const logAbs = safeResolve(`${BUILD_DIR}/${job.baseName}.log`, job.projectId);
      if (fs.existsSync(logAbs)) logText = fs.readFileSync(logAbs, "utf8");
    } catch {
      /* keep stdout */
    }
    const { errors, warnings } = parseLog(logText);
    if (exitCode !== 0 && errors.length === 0 && !wasStopped) {
      const tail = job.rawLog.trim().split("\n").slice(-4).join(" ");
      errors.push({
        severity: "error",
        message: `latexmk exited with code ${exitCode}: ${tail.slice(0, 400)}`,
      });
    }
    if (!wasStopped) job.state = success ? "success" : "error";
    if (pdfExists) this.latest.set(job.projectId, { jobId: job.jobId, baseName: job.baseName });

    const result: CompileResult = {
      jobId: job.jobId,
      success,
      state: job.state,
      errors,
      warnings,
      pdfUrl: pdfExists ? `/api/pdf?jobId=${job.jobId}` : undefined,
      synctexReady: fs.existsSync(synctexAbs),
      durationMs: Date.now() - job.startedAt,
    };
    job.result = result;
    emit({ type: "compile:status", jobId: job.jobId, state: job.state, projectId: job.projectId });
    emit({ type: "compile:done", result, projectId: job.projectId });
  }
}

const EXTERNALDOCUMENT_RE = /\\externaldocument(?:\[[^\]]*\])?\{([^}]+)\}/g;

/**
 * Multi-document papers (e.g. a main manuscript with `\externaldocument{si}`
 * from the `xr-hyper` package) need the referenced document's .aux file to
 * exist before the main file is compiled, so cross-references into it
 * resolve instead of coming out as "??". latexmk only builds the file it's
 * pointed at, so we scan the main file for `\externaldocument` and run one
 * plain engine pass (matching how xr-hyper itself just needs a fresh .aux,
 * not a full latexmk build) on each referenced document first, right in the
 * project root where xr-hyper's search path will find the .aux.
 */
async function precompileExternalDocuments(
  cwd: string,
  job: Job,
  engine: LatexEngine,
  emit: Emit,
): Promise<void> {
  let src: string;
  try {
    src = fs.readFileSync(safeResolve(job.mainFile, job.projectId), "utf8");
  } catch {
    return;
  }

  const names = new Set<string>();
  for (const m of src.matchAll(EXTERNALDOCUMENT_RE)) {
    const name = m[1].trim().endsWith(".tex") ? m[1].trim() : `${m[1].trim()}.tex`;
    if (name !== job.mainFile) names.add(name);
  }

  for (const name of names) {
    let abs: string;
    try {
      abs = safeResolve(name, job.projectId);
    } catch {
      continue;
    }
    if (!fs.existsSync(abs)) continue;

    emit({
      type: "compile:log",
      jobId: job.jobId,
      entry: { severity: "info", message: `Pre-compiling ${name} (required by \\externaldocument)…` },
      projectId: job.projectId,
    });
    try {
      await execFileAsync(engine, ["-interaction=nonstopmode", "-file-line-error", name], {
        cwd,
        timeout: 60_000,
      });
    } catch {
      emit({
        type: "compile:log",
        jobId: job.jobId,
        entry: {
          severity: "warning",
          message: `Pre-compile of ${name} failed; cross-references into it may be unresolved.`,
        },
        projectId: job.projectId,
      });
    }
  }
}

/** Kill a spawned process and (on POSIX) its whole process group. */
function killTree(proc: ReturnType<typeof spawn>, signal: NodeJS.Signals = "SIGTERM"): void {
  if (proc.pid == null) return;
  try {
    if (process.platform !== "win32") process.kill(-proc.pid, signal);
    else proc.kill(signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/** Turn a single raw log line into a streamed LogEntry (or null if noise). */
function classifyLine(line: string): LogEntry | null {
  const fle = line.match(/^(.+?):(\d+):\s*(.*)$/);
  if (fle && /error|undefined|missing|fatal/i.test(fle[3])) {
    return { severity: "error", file: normFile(fle[1]), line: Number(fle[2]), message: fle[3], raw: line };
  }
  if (/^!/.test(line)) {
    return { severity: "error", message: line.replace(/^!\s*/, ""), raw: line };
  }
  if (/^(LaTeX|Package \w+|Class \w+) Warning:/.test(line)) {
    return { severity: "warning", message: line, raw: line };
  }
  return null;
}

/** Full-log parse for the final error/warning lists (deduplicated). */
export function parseLog(log: string): { errors: LogEntry[]; warnings: LogEntry[] } {
  const errors: LogEntry[] = [];
  const warnings: LogEntry[] = [];
  const seen = new Set<string>();
  for (const line of log.split("\n")) {
    const e = classifyLine(line);
    if (!e) {
      const of = line.match(/^(Overfull|Underfull) \\([hv])box/);
      if (of) {
        const key = `w:${line}`;
        if (!seen.has(key)) {
          seen.add(key);
          warnings.push({ severity: "warning", message: line, raw: line });
        }
      }
      continue;
    }
    const key = `${e.severity}:${e.file ?? ""}:${e.line ?? ""}:${e.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (e.severity === "error") errors.push(e);
    else warnings.push(e);
  }
  return { errors, warnings };
}

function normFile(f: string): string {
  const cleaned = f.replace(/^\.\//, "");
  if (path.isAbsolute(cleaned)) {
    try {
      return toRelative(cleaned);
    } catch {
      return cleaned;
    }
  }
  return cleaned;
}
