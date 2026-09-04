/**
 * Runtime configuration, the project registry, and the path-traversal guard.
 *
 * OffLeaf treats directories on disk as "projects". One project is opened at
 * boot (CLI arg / env var / bundled sample) and becomes the default; more can
 * be registered at runtime through POST /api/projects/open, each identified by
 * a short stable id so several browser tabs can work on different folders
 * against the same backend. Every file operation resolves through
 * `safeResolve`, which confines it to its project's root.
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const thisFile = fileURLToPath(import.meta.url);
// src/config.ts (dev via tsx) or dist/config.js (built) -> parent is server/src|dist,
// so one level up is the `server` package and two levels up is the repo root.
const serverDir = path.resolve(path.dirname(thisFile), "..");
const repoRoot = path.resolve(serverDir, "..");

/** The compiled/aux output directory, relative to the project root. */
export const BUILD_DIR = ".build";

/** Port the local backend binds to (127.0.0.1 only). */
export const PORT = Number(process.env.OFFLEAF_PORT ?? 3000);

/** Where recent-project state lives (survives restarts). Overridable so tests
 *  don't pollute the real machine's recent-projects list. */
const CONFIG_DIR = process.env.OFFLEAF_CONFIG_DIR ?? path.join(os.homedir(), ".config", "offleaf");
const RECENT_FILE = path.join(CONFIG_DIR, "recent.json");

// ---------------------------------------------------------------------------
// Project registry
// ---------------------------------------------------------------------------

/** id -> absolute project root. Populated at boot and via /api/projects/open. */
const projects = new Map<string, string>();
let defaultId = "";

/** Short, stable id for a directory (same folder ⇒ same id across restarts). */
function idFor(absRoot: string): string {
  return createHash("sha1").update(absRoot).digest("hex").slice(0, 8);
}

/**
 * Validate + register a directory as an openable project. Returns its id.
 * Throws with a readable message when the path is unusable.
 */
export function registerProject(dir: string): { id: string; root: string } {
  const abs = path.resolve(dir.replace(/^~(?=$|\/)/, os.homedir()));
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new Error(`No such directory: ${abs}`);
  }
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${abs}`);
  const id = idFor(abs);
  projects.set(id, abs);
  rememberRecent(abs);
  return { id, root: abs };
}

/** All registered projects (this process) — id, root, display name. */
export function listProjects(): { id: string; root: string; name: string; isDefault: boolean }[] {
  return [...projects.entries()].map(([id, root]) => ({
    id,
    root,
    name: path.basename(root),
    isDefault: id === defaultId,
  }));
}

/** Recently opened roots from previous sessions (for the Open dialog). */
export function recentProjects(): string[] {
  try {
    const arr = JSON.parse(fs.readFileSync(RECENT_FILE, "utf8")) as string[];
    return arr.filter((p) => typeof p === "string" && fs.existsSync(p));
  } catch {
    return [];
  }
}

function rememberRecent(absRoot: string): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const list = [absRoot, ...recentProjects().filter((p) => p !== absRoot)].slice(0, 12);
    fs.writeFileSync(RECENT_FILE, JSON.stringify(list, null, 2));
  } catch {
    /* recents are a convenience, never fatal */
  }
}

/**
 * Priority chain for the boot project: CLI arg > OFFLEAF_PROJECT > most
 * recently opened project > bundled sample. Pulled out as a pure function
 * (recent defaults to the real recentProjects() list) so the priority order
 * is unit-testable without touching argv/env/disk.
 */
export function resolveDefaultProject(
  argv2: string | undefined,
  envVar: string | undefined,
  recent: string[] = recentProjects(),
): string {
  return argv2 ?? envVar ?? recent[0] ?? path.join(repoRoot, "sample");
}

/** Register the boot project (see resolveDefaultProject for the priority order). */
export function initDefaultProject(): void {
  const chosen = resolveDefaultProject(process.argv[2], process.env.OFFLEAF_PROJECT);
  const { id } = registerProject(chosen);
  defaultId = id;
}

/**
 * Absolute root for a project id; an empty/undefined id means the boot
 * project, so old single-project clients keep working unchanged.
 */
export function projectRoot(projectId?: string): string {
  const id = projectId || defaultId;
  const root = projects.get(id);
  if (!root) throw new Error(`Unknown project id: ${projectId}`);
  return root;
}

/** Absolute path to the client build output (served statically when present). */
export function clientDist(): string {
  return path.join(repoRoot, "client", "dist");
}

/**
 * Resolve a project-relative path to an absolute one, rejecting anything that
 * escapes the project root (e.g. "../../etc/passwd"). This is the security
 * boundary for the whole file API.
 */
export function safeResolve(relPath: string, projectId?: string): string {
  const root = projectRoot(projectId);
  const normalized = path
    .normalize(relPath)
    .replace(/^([/\\])+/, ""); // strip leading slashes so it stays relative
  const abs = path.resolve(root, normalized);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) {
    throw new Error(`Path escapes project root: ${relPath}`);
  }
  return abs;
}

/** Convert an absolute path back to a POSIX-style project-relative path. */
export function toRelative(abs: string, projectId?: string): string {
  return path.relative(projectRoot(projectId), abs).split(path.sep).join("/");
}

/**
 * Best-effort banner describing the local TeX distribution, e.g.
 * "TeX Live 2025" or "MiKTeX 24.x". Returns "unknown" if pdflatex is absent.
 */
export function detectTexDistribution(): string {
  try {
    const out = execFileSync("pdflatex", ["--version"], {
      encoding: "utf8",
      timeout: 5000,
    });
    const first = out.split("\n")[0]?.trim() ?? "";
    const tl = first.match(/TeX Live (\d{4})/);
    if (tl) return `TeX Live ${tl[1]}`;
    const mik = first.match(/MiKTeX[^\s]*\s?([\d.]+)?/i);
    if (mik) return `MiKTeX ${mik[1] ?? ""}`.trim();
    return first || "unknown";
  } catch {
    return "unknown";
  }
}

/** True if an executable is resolvable on PATH. */
export function hasCommand(cmd: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [cmd], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}
