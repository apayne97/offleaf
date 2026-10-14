/**
 * ProjectWatcher — notices edits made outside the browser (another editor, or
 * Claude writing the .tex file) and tells connected clients via `file:changed`.
 *
 * One recursive fs.watch per project, started lazily. Events are debounced per
 * path (editors often write a file as several events). OffLeaf's own autosaves
 * are reported too; the client tells them apart by comparing content.
 */
import fs from "node:fs";
import path from "node:path";
import type { FSWatcher } from "node:fs";
import type { ServerMessage } from "@offleaf/shared";
import { projectRoot, BUILD_DIR } from "../config.js";

const DEBOUNCE_MS = 100;
const IGNORED = new Set([BUILD_DIR, "node_modules", ".git"]);

/** True for build output, VCS internals and dotfiles (editor swap/temp files). */
export function isIgnoredPath(rel: string): boolean {
  return rel.split(/[\\/]/).some((seg) => IGNORED.has(seg) || seg.startsWith("."));
}

export class ProjectWatcher {
  private watchers = new Map<string, FSWatcher>();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private emit: (msg: ServerMessage) => void) {}

  /** Start watching a project (no-op if already watching). `projectId` is echoed back on messages. */
  ensure(projectId: string): void {
    if (this.watchers.has(projectId)) return;
    let w: FSWatcher;
    try {
      w = fs.watch(projectRoot(projectId), { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const rel = filename.toString().split(path.sep).join("/");
        if (isIgnoredPath(rel)) return;
        const key = `${projectId}\0${rel}`;
        clearTimeout(this.timers.get(key));
        this.timers.set(
          key,
          setTimeout(() => {
            this.timers.delete(key);
            this.emit({ type: "file:changed", path: rel, projectId });
          }, DEBOUNCE_MS),
        );
      });
    } catch {
      return; // watching is a convenience; never fatal
    }
    w.on("error", () => this.watchers.delete(projectId));
    this.watchers.set(projectId, w);
  }

  close(): void {
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
