/**
 * Project file tree. Renders the FileNode structure from /api/project and calls
 * back when a file is opened. Directories collapse/expand; the active file is
 * highlighted.
 */
import { useState } from "react";
import type { FileNode } from "@offleaf/shared";

function icon(node: FileNode): string {
  if (node.type === "dir") return "📁";
  if (node.name.endsWith(".tex")) return "📄";
  if (node.name.endsWith(".bib")) return "📚";
  if (/\.(png|jpg|jpeg|pdf|eps|gif)$/i.test(node.name)) return "🖼️";
  return "📄";
}

function Node({
  node,
  depth,
  activePath,
  onOpen,
}: {
  node: FileNode;
  depth: number;
  activePath: string;
  onOpen(path: string): void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const pad = { paddingLeft: 8 + depth * 12 };

  if (node.type === "dir") {
    return (
      <div>
        <div className="tree-row" style={pad} onClick={() => setOpen((o) => !o)}>
          <span className="tree-caret">{open ? "▾" : "▸"}</span>
          <span className="tree-icon">{icon(node)}</span>
          <span className="tree-name">{node.name || "project"}</span>
        </div>
        {open && node.children?.map((c) => (
          <Node key={c.path} node={c} depth={depth + 1} activePath={activePath} onOpen={onOpen} />
        ))}
      </div>
    );
  }
  return (
    <div
      className={`tree-row tree-file${activePath === node.path ? " active" : ""}`}
      style={pad}
      onClick={() => onOpen(node.path)}
    >
      <span className="tree-icon">{icon(node)}</span>
      <span className="tree-name">{node.name}</span>
    </div>
  );
}

export default function FileTree({
  root,
  activePath,
  onOpen,
}: {
  root: FileNode | null;
  activePath: string;
  onOpen(path: string): void;
}) {
  return (
    <div className="filetree">
      <div className="panel-title">Files</div>
      {root ? (
        (root.children ?? []).map((c) => (
          <Node key={c.path} node={c} depth={0} activePath={activePath} onOpen={onOpen} />
        ))
      ) : (
        <div className="muted" style={{ padding: 8 }}>Loading…</div>
      )}
    </div>
  );
}
