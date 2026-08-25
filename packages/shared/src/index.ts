/**
 * @offleaf/shared — the single source of truth for the OffLeaf API and
 * WebSocket protocol. Imported by both `server` and `client` so the contract
 * cannot silently drift between the two sides.
 */

// ----------------------------------------------------------------------------
// Project & files
// ----------------------------------------------------------------------------

export type LatexEngine = "pdflatex" | "xelatex" | "lualatex";

export interface FileNode {
  /** Path relative to the project root, POSIX separators, e.g. "sections/intro.tex". */
  path: string;
  name: string;
  type: "file" | "dir";
  /** Present for dirs. */
  children?: FileNode[];
  /** Bytes, present for files. */
  size?: number;
}

export interface ProjectInfo {
  /** Registry id of this project ("" = the project the server booted with). */
  id: string;
  root: string; // absolute path on the host (display only)
  name: string;
  mainFile: string; // e.g. "main.tex"
  engine: LatexEngine;
  /** Local TeX distribution banner, e.g. "TeX Live 2025" or "unknown". */
  texDistribution: string;
  tree: FileNode;
  /**
   * Root-level .tex files that look like standalone documents (main.tex by
   * convention, or anything with \documentclass) — candidates for the PDF
   * preview's "+" add-tab picker, e.g. a main manuscript plus si_figures.tex.
   */
  documents: string[];
}

export interface FileContents {
  path: string;
  content: string;
  /** True for binary files (images, pdf); content will be base64. */
  binary?: boolean;
}

// ----------------------------------------------------------------------------
// Compilation
// ----------------------------------------------------------------------------

export interface CompileRequest {
  mainFile: string;
  engine: LatexEngine;
  cleanBuild?: boolean;
  shellEscape?: boolean;
}

export interface CompileResponse {
  jobId: string;
}

export type CompileState = "queued" | "running" | "success" | "error" | "stopped";

export type LogSeverity = "error" | "warning" | "info";

export interface LogEntry {
  severity: LogSeverity;
  /** Relative file path if the log line carried one (file:line:error format). */
  file?: string;
  line?: number;
  message: string;
  raw?: string;
}

export interface CompileResult {
  jobId: string;
  success: boolean;
  state: CompileState;
  errors: LogEntry[];
  warnings: LogEntry[];
  /** URL to fetch the produced PDF, e.g. "/api/pdf?jobId=abc". */
  pdfUrl?: string;
  synctexReady: boolean;
  durationMs: number;
}

// ----------------------------------------------------------------------------
// SyncTeX
// ----------------------------------------------------------------------------

export interface SyncForwardResult {
  page: number; // 1-based
  x: number; // pts from left
  y: number; // pts from top
  height?: number;
  width?: number;
}

export interface SyncInverseResult {
  file: string; // relative path
  line: number; // 1-based
  column?: number;
}

// ----------------------------------------------------------------------------
// Word count
// ----------------------------------------------------------------------------

export interface WordCountBreakdown {
  wordsInText: number;
  wordsInHeaders: number;
  wordsInCaptions: number;
  headers: number;
  floats: number;
  mathInline: number;
  mathDisplay: number;
}

export interface SectionCount {
  title: string;
  words: number; // words in text within this (sub)section
}

export interface WordCountResult {
  /** texcount-derived totals for the whole document (source of truth). */
  total: WordCountBreakdown;
  /** Per-section subcounts from `texcount -sub`. */
  sections: SectionCount[];
}

export interface SelectionCountRequest {
  /** Raw LaTeX text of the current selection. */
  text: string;
}

export interface SelectionCountResult {
  words: number;
  characters: number;
  charactersNoSpaces: number;
  /** True when computed client-side estimate; texcount total is authoritative. */
  estimate: boolean;
}

// ----------------------------------------------------------------------------
// TTS extraction
// ----------------------------------------------------------------------------

export type MathReadMode = "skip" | "sayEquation" | "naive";

export interface NarrationSegment {
  /** Clean spoken text for this segment (a sentence or heading). */
  text: string;
  kind: "heading" | "paragraph" | "caption" | "math";
  /** Character offset back into the source main file, when resolvable. */
  sourceLine?: number;
}

export interface NarrationDocument {
  segments: NarrationSegment[];
}

// ----------------------------------------------------------------------------
// WebSocket messages (server -> client unless noted)
// ----------------------------------------------------------------------------

export type ServerMessage =
  | { type: "compile:status"; jobId: string; state: CompileState; projectId?: string }
  | { type: "compile:log"; jobId: string; entry: LogEntry; projectId?: string }
  | { type: "compile:done"; result: CompileResult; projectId?: string }
  | { type: "file:changed"; path: string; projectId?: string };

export type ClientMessage =
  | { type: "subscribe"; jobId: string }
  | { type: "ping" };

// ----------------------------------------------------------------------------
// Project registry (multiple open folders)
// ----------------------------------------------------------------------------

/** One entry in the backend's project registry. */
export interface ProjectRef {
  id: string;
  root: string;
  name: string;
  isDefault: boolean;
}

export interface ProjectsListing {
  /** Folders registered in this server process (openable right now). */
  open: ProjectRef[];
  /** Recently opened folders from previous sessions (absolute paths). */
  recent: string[];
}

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

export const DEFAULT_ENGINE: LatexEngine = "pdflatex";

/**
 * The base latexmk flags OffLeaf uses, chosen to mirror Overleaf's defaults:
 * nonstop interaction, file:line:error format, and SyncTeX enabled.
 * The engine-selection flag (-pdf / -xelatex / -lualatex) is appended by the
 * compile service based on the chosen engine.
 */
export const LATEXMK_BASE_FLAGS = [
  "-interaction=nonstopmode",
  "-file-line-error",
  "-synctex=1",
] as const;

export function engineFlag(engine: LatexEngine): string {
  switch (engine) {
    case "pdflatex":
      return "-pdf";
    case "xelatex":
      return "-xelatex";
    case "lualatex":
      return "-lualatex";
  }
}
