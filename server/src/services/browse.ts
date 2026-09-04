/**
 * Filesystem browsing for the Open-folder dialog's folder picker. Unlike the
 * rest of the file API, this isn't scoped to a project root — it lists
 * arbitrary directories on the machine running the backend, which is safe
 * because the server only binds to 127.0.0.1 (see config.ts's safeResolve
 * for the project-scoped guard used everywhere else).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FsBrowseResult } from "@offleaf/shared";

/** Expand a leading `~` to the home directory, same convention as registerProject. */
function expandHome(p: string): string {
  return p.replace(/^~(?=$|\/)/, os.homedir());
}

/**
 * List the subdirectories of `dir` (default: the home directory), each
 * flagged with whether it directly contains a .tex file. Hidden (dotfile)
 * folders are excluded to keep the listing focused on real project folders.
 */
export async function browseDir(dir?: string): Promise<FsBrowseResult> {
  const abs = path.resolve(expandHome(dir?.trim() || os.homedir()));
  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    throw new Error(`Can't read directory: ${abs}`);
  }
  const subdirs = dirents
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));

  const entries = await Promise.all(
    subdirs.map(async (d) => {
      const full = path.join(abs, d.name);
      let hasTex = false;
      try {
        const inner = await fs.readdir(full, { withFileTypes: true });
        hasTex = inner.some((f) => f.isFile() && f.name.endsWith(".tex"));
      } catch {
        // Unreadable subfolder (permissions, broken symlink, …) — just don't flag it.
      }
      return { name: d.name, hasTex };
    }),
  );

  const parent = path.dirname(abs);
  return { dir: abs, parent: parent === abs ? null : parent, entries };
}
