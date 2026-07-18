/**
 * FileService — sandboxed CRUD over the project directory.
 *
 * All paths are project-relative (POSIX separators) and pass through
 * `safeResolve` so nothing outside the project root is ever touched.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { FileContents, FileNode } from "@offleaf/shared";
import { projectRoot, safeResolve, BUILD_DIR } from "../config.js";

/** Directories/patterns never shown in the file tree. */
const IGNORED = new Set([BUILD_DIR, "node_modules", ".git", ".offleaf.json"]);

/** Extensions treated as binary (returned as base64). */
const BINARY_EXT = new Set([
  ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".eps",
  ".tif", ".tiff", ".ico", ".zip", ".otf", ".ttf", ".woff", ".woff2",
]);

function isBinary(p: string): boolean {
  return BINARY_EXT.has(path.extname(p).toLowerCase());
}

async function walk(absDir: string, relDir: string): Promise<FileNode[]> {
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  const nodes: FileNode[] = [];
  for (const e of entries) {
    if (IGNORED.has(e.name) || e.name.startsWith(".")) continue;
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    const abs = path.join(absDir, e.name);
    if (e.isDirectory()) {
      nodes.push({ path: rel, name: e.name, type: "dir", children: await walk(abs, rel) });
    } else {
      let size = 0;
      try {
        size = (await fs.stat(abs)).size;
      } catch {
        /* ignore */
      }
      nodes.push({ path: rel, name: e.name, type: "file", size });
    }
  }
  // Directories first, then files, each alphabetical.
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

export async function listTree(projectId?: string): Promise<FileNode> {
  const root = projectRoot(projectId);
  return {
    path: "",
    name: path.basename(root),
    type: "dir",
    children: await walk(root, ""),
  };
}

export async function readFile(relPath: string, projectId?: string): Promise<FileContents> {
  const abs = safeResolve(relPath, projectId);
  if (isBinary(relPath)) {
    const buf = await fs.readFile(abs);
    return { path: relPath, content: buf.toString("base64"), binary: true };
  }
  const content = await fs.readFile(abs, "utf8");
  return { path: relPath, content };
}

export async function writeFile(relPath: string, content: string, projectId?: string): Promise<void> {
  const abs = safeResolve(relPath, projectId);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

export async function createFile(relPath: string, content = "", projectId?: string): Promise<void> {
  const abs = safeResolve(relPath, projectId);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  // Fail if it already exists to avoid clobbering.
  await fs.writeFile(abs, content, { encoding: "utf8", flag: "wx" });
}

export async function deleteFile(relPath: string, projectId?: string): Promise<void> {
  const abs = safeResolve(relPath, projectId);
  await fs.rm(abs, { recursive: true, force: true });
}

export async function rename(from: string, to: string, projectId?: string): Promise<void> {
  const absFrom = safeResolve(from, projectId);
  const absTo = safeResolve(to, projectId);
  await fs.mkdir(path.dirname(absTo), { recursive: true });
  await fs.rename(absFrom, absTo);
}
