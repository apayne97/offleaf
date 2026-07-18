/**
 * OffLeaf top-level app: a VS Code / Overleaf-style three-pane IDE.
 *   [ file tree | Code ⇄ Visual (toggle) | PDF preview (always visible) ]
 * plus a toolbar (compile, engine, view toggle, open-folder), a status bar with
 * live word count and cursor position, and optional Read-Aloud + word-count
 * panels. A browser tab is pinned to one project folder (?p=<id>); the Open
 * dialog launches other folders in new tabs.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CompileState,
  LatexEngine,
  LogEntry,
  ProjectInfo,
  ProjectsListing,
  SelectionCountResult,
  WordCountResult,
  ServerMessage,
} from "@offleaf/shared";
import { api, OffLeafSocket } from "./api";
import SplitPane from "./components/SplitPane";
import FileTree from "./components/FileTree";
import Outline from "./components/Outline";
import Editor, { type EditorHandle, type EditorDiagnostic } from "./editor/Editor";
import PdfView, { type PdfHandle } from "./preview/PdfView";
import VisualView from "./visual/VisualView";
import ReadAloud, { type ReadAloudHandle } from "./tts/ReadAloud";
import { WordCountBar, WordCountPanel } from "./wordcount/WordCount";
import { parseLatexBlocks, blockNearLine, stripLatex, type Block } from "./visual/parse";
import { harvestKeys } from "./editor/latex";

type Status = CompileState | "idle";

export default function App() {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [activePath, setActivePath] = useState("");
  const [content, setContent] = useState("");
  const [engine, setEngine] = useState<LatexEngine>("pdflatex");
  const [status, setStatus] = useState<Status>("idle");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  /** What the middle pane shows; the PDF stays on the right regardless. */
  const [leftView, setLeftView] = useState<"code" | "visual">("code");
  const [showReadAloud, setShowReadAloud] = useState(false);
  const [showWordPanel, setShowWordPanel] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [showOpen, setShowOpen] = useState(false);
  const [openPath, setOpenPath] = useState("");
  const [openError, setOpenError] = useState("");
  const [projList, setProjList] = useState<ProjectsListing | null>(null);
  const [docCount, setDocCount] = useState<(WordCountResult & { engine: string }) | null>(null);
  const [selCount, setSelCount] = useState<SelectionCountResult | null>(null);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [activeSeg, setActiveSeg] = useState<number | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [keys, setKeys] = useState<{ labels: string[]; cites: string[] }>({ labels: [], cites: [] });

  const editorRef = useRef<EditorHandle | null>(null);
  const pdfRef = useRef<PdfHandle | null>(null);
  const visualContainerRef = useRef<HTMLDivElement>(null);
  const readAloudRef = useRef<ReadAloudHandle | null>(null);
  const socketRef = useRef<OffLeafSocket | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const selTimer = useRef<number | undefined>(undefined);
  const keysRef = useRef(keys);
  keysRef.current = keys;
  // Always-fresh mirrors for the websocket handler (registered once).
  const projectRef = useRef<ProjectInfo | null>(null);
  projectRef.current = project;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const jobRef = useRef<string | null>(null);

  const isTex = activePath.endsWith(".tex");
  const source = isTex ? content : "";
  const blocks = useMemo(() => parseLatexBlocks(source).blocks, [source]);

  // The manuscript's \title{...}, remembered from the main file so it stays
  // shown while other files (refs.bib, section files) are open. Falls back to
  // the folder name when the document has no \title.
  const [docTitle, setDocTitle] = useState<string | null>(null);
  useEffect(() => {
    if (!project || activePath !== project.mainFile) return;
    const t = blocks.find((b) => b.kind === "title");
    setDocTitle(t ? stripLatex(t.raw) || null : null);
  }, [blocks, activePath, project]);
  const displayTitle = docTitle ?? project?.name ?? "…";

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (project) document.title = `${displayTitle} — OffLeaf`;
  }, [project, displayTitle]);

  // ---- boot: load project, open main, connect websocket, harvest keys ----
  useEffect(() => {
    (async () => {
      const proj = await api.getProject();
      setProject(proj);
      setEngine(proj.engine);
      await openFile(proj.mainFile);
      refreshDocCount(proj.mainFile);
      harvestProjectKeys(proj);
    })().catch((e) => console.error("Failed to load project", e));

    const socket = new OffLeafSocket();
    socket.connect();
    // Route through a ref so the handler never sees stale state (the socket
    // outlives every render; a direct closure would pin the first render).
    socket.on((msg) => handlerRef.current(msg));
    socketRef.current = socket;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlerRef = useRef<(msg: ServerMessage) => void>(() => {});
  handlerRef.current = (msg: ServerMessage) => {
    if (msg.type === "compile:status") {
      setStatus(msg.state);
    } else if (msg.type === "compile:log") {
      setLogs((prev) => [...prev.slice(-500), msg.entry]);
    } else if (msg.type === "compile:done") {
      setStatus(msg.result.state);
      setLogs([...msg.result.errors, ...msg.result.warnings]);
      jobRef.current = null;
      if (msg.result.pdfUrl) setPdfUrl(msg.result.pdfUrl);
      // Collapse the log panel automatically on a clean compile.
      if (msg.result.errors.length === 0 && msg.result.warnings.length === 0) setShowLogs(false);
      const main = projectRef.current?.mainFile;
      if (main) refreshDocCount(main);
    }
  };

  async function harvestProjectKeys(proj: ProjectInfo) {
    const bibs: string[] = [];
    const texts: string[] = [];
    const walk = async (node: ProjectInfo["tree"]) => {
      for (const c of node.children ?? []) {
        if (c.type === "dir") await walk(c);
        else if (c.name.endsWith(".bib")) bibs.push((await api.getFile(c.path)).content);
        else if (c.name.endsWith(".tex")) texts.push((await api.getFile(c.path)).content);
      }
    };
    await walk(proj.tree);
    setKeys(harvestKeys(texts, bibs));
  }

  async function openFile(path: string) {
    const file = await api.getFile(path);
    if (file.binary) return; // images/pdfs aren't opened in the text editor
    setActivePath(path);
    setContent(file.content);
    setSelCount(null);
  }

  function refreshDocCount(mainFile: string) {
    api.wordcountDoc(mainFile).then(setDocCount).catch(() => setDocCount(null));
  }

  const onEditorChange = (value: string) => {
    setContent(value);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      if (activePath) {
        api.saveFile(activePath, value)
          .then(() => {
            const main = projectRef.current?.mainFile;
            if (main) refreshDocCount(main);
          })
          .catch(() => {});
      }
    }, 600);
  };

  const onSelectionChange = (text: string) => {
    window.clearTimeout(selTimer.current);
    if (!text.trim()) {
      setSelCount(null);
      return;
    }
    selTimer.current = window.setTimeout(() => {
      api.wordcountSelection(text).then(setSelCount).catch(() => {});
    }, 200);
  };

  const recompile = async (cleanBuild: boolean) => {
    if (!project || status === "running" || status === "queued") return;
    if (activePath) await api.saveFile(activePath, content).catch(() => {});
    setLogs([]);
    setStatus("queued");
    setShowLogs(true);
    try {
      const { jobId } = await api.compile({ mainFile: project.mainFile, engine, cleanBuild });
      jobRef.current = jobId;
    } catch (e) {
      setStatus("error");
      setLogs([{ severity: "error", message: String(e) }]);
    }
  };

  const stopCompile = () => {
    if (jobRef.current) api.stopCompile(jobRef.current).catch(() => {});
  };

  const forwardSync = async () => {
    if (!project) return;
    const res = await api.syncForward(activePath || project.mainFile, cursor.line, cursor.col);
    if (res) pdfRef.current?.highlight(res.page, res.x, res.y);
  };

  const inverseSync = async (page: number, x: number, y: number) => {
    const res = await api.syncInverse(page, x, y);
    if (!res) return;
    setLeftView("code");
    if (res.file !== activePath) await openFile(res.file).catch(() => {});
    // Allow the editor doc to update before scrolling.
    setTimeout(() => editorRef.current?.scrollToLine(res.line), 50);
  };

  // ---- open-folder dialog ----
  const showOpenDialog = async () => {
    setOpenError("");
    setShowOpen(true);
    api.listProjects().then(setProjList).catch(() => setProjList(null));
  };

  const openFolder = async (dir: string) => {
    setOpenError("");
    // Open the tab synchronously (still inside the click's user gesture) —
    // window.open after an await gets popup-blocked. Point it at the project
    // once the backend has registered the folder.
    const tab = window.open("", "_blank");
    try {
      const { id } = await api.openProject(dir);
      const url = `${location.origin}${location.pathname}?p=${encodeURIComponent(id)}`;
      if (tab) tab.location.href = url;
      else window.location.href = url; // popup blocked anyway → reuse this tab
      setShowOpen(false);
      setOpenPath("");
    } catch (e) {
      tab?.close();
      setOpenError(String((e as Error).message ?? e));
    }
  };

  // Compile diagnostics for the file open in the editor (gutter + squiggles).
  const diagnostics = useMemo<EditorDiagnostic[]>(() => {
    const main = project?.mainFile;
    return logs
      .filter((l) => l.line !== undefined && (l.file ? l.file === activePath : activePath === main))
      .map((l) => ({
        line: l.line as number,
        severity: l.severity === "error" ? "error" as const : "warning" as const,
        message: l.message,
      }));
  }, [logs, activePath, project]);

  const onLogClick = async (l: LogEntry) => {
    if (!l.line) return;
    setLeftView("code");
    if (l.file && l.file !== activePath) {
      await openFile(l.file).catch(() => {});
      setTimeout(() => editorRef.current?.scrollToLine(l.line as number), 50);
    } else {
      editorRef.current?.scrollToLine(l.line);
    }
  };

  const scrollVisualToSeg = (seg: number, center = true) => {
    const el = visualContainerRef.current?.querySelector<HTMLElement>(`[data-seg="${seg}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: center ? "center" : "nearest" });
  };

  // Visual pane follows the source cursor (Overleaf's visual/code sync).
  const cursorSeg = useMemo(() => {
    if (leftView !== "visual" || !isTex) return null;
    return blockNearLine(blocks, cursor.line)?.seg ?? null;
  }, [leftView, isTex, blocks, cursor.line]);
  useEffect(() => {
    // Do not fight Read-Aloud's own scrolling while it is speaking.
    if (cursorSeg !== null && activeSeg === null) scrollVisualToSeg(cursorSeg, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursorSeg]);

  const onActiveBlock = (block: Block | null, followEditor: boolean) => {
    setActiveSeg(block?.seg ?? null);
    if (block) {
      scrollVisualToSeg(block.seg);
      if (followEditor && block.line) editorRef.current?.revealLine(block.line);
    }
  };

  const errorCount = logs.filter((l) => l.severity === "error").length;
  const warnCount = logs.filter((l) => l.severity === "warning").length;
  const compiling = status === "running" || status === "queued";

  return (
    <div className="app">
      {/* ---------------- toolbar ---------------- */}
      <header className="toolbar">
        <div className="brand">OffLeaf</div>
        <div
          className="project-name"
          title={project ? `${project.name} — ${project.root}` : undefined}
        >
          {displayTitle}
        </div>
        <button onClick={showOpenDialog} title="Open another project folder in a new tab">📂 Open…</button>
        <button className="primary" onClick={() => recompile(false)} disabled={compiling} title="Save & compile (⌘S / ⌘↵)">
          {compiling ? "Compiling…" : "▶ Recompile"}
        </button>
        {compiling && (
          <button onClick={stopCompile} title="Stop the running compile">⏹ Stop</button>
        )}
        <button onClick={() => recompile(true)} disabled={compiling} title="Clear aux files and rebuild">
          ⟳ From scratch
        </button>
        <select value={engine} onChange={(e) => setEngine(e.target.value as LatexEngine)} title="LaTeX engine">
          <option value="pdflatex">pdfLaTeX</option>
          <option value="xelatex">XeLaTeX</option>
          <option value="lualatex">LuaLaTeX</option>
        </select>
        <button onClick={forwardSync} title="Jump from cursor to PDF (SyncTeX)">⟶ PDF</button>

        <div className="spacer" />

        <div className="view-toggle" title="What the middle pane shows (the PDF stays on the right)">
          <button className={leftView === "code" ? "on" : ""} onClick={() => setLeftView("code")}>Code</button>
          <button className={leftView === "visual" ? "on" : ""} onClick={() => setLeftView("visual")}>Visual</button>
        </div>
        <button className={showReadAloud ? "on" : ""} onClick={() => setShowReadAloud((v) => !v)}>🔊 Read Aloud</button>
        <button className={showWordPanel ? "on" : ""} onClick={() => setShowWordPanel((v) => !v)}>Words</button>
        <button onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))} title="Toggle theme">
          {theme === "dark" ? "☾" : "☀"}
        </button>
        <span className="tex-badge" title="Local TeX distribution">{project?.texDistribution}</span>
      </header>

      {/* ---------------- body ---------------- */}
      <div className="body">
        <SplitPane
          initial={220}
          min={140}
          max={420}
          first={
            <div className="sidebar-col">
              <FileTree root={project?.tree ?? null} activePath={activePath} onOpen={(p) => openFile(p)} />
              {isTex && (
                <Outline
                  blocks={blocks}
                  cursorLine={cursor.line}
                  onJump={(b) => {
                    if (!b.line) return;
                    editorRef.current?.scrollToLine(b.line);
                    // Keep the Visual pane in step when it is the one showing.
                    if (leftView === "visual") scrollVisualToSeg(b.seg);
                  }}
                />
              )}
            </div>
          }
          second={
            <SplitPane
              initial={640}
              min={280}
              max={1400}
              first={
                <div className="editor-col">
                  <div className="tab">
                    {activePath || "no file"}
                    {leftView === "visual" && <span className="muted"> · visual (read-only — switch to Code to edit)</span>}
                  </div>
                  {/* Both stay mounted so the editor keeps cursor/undo state
                      while the visual pane is showing. */}
                  <div className={leftView === "code" ? "fill" : "fill hidden"}>
                    <Editor
                      ref={editorRef}
                      path={activePath}
                      content={content}
                      theme={theme}
                      diagnostics={diagnostics}
                      onChange={onEditorChange}
                      onSelectionChange={onSelectionChange}
                      onCursorChange={(line, col) => setCursor({ line, col })}
                      onRequestCompile={() => void recompile(false)}
                      getKeys={() => keysRef.current}
                    />
                  </div>
                  <div className={leftView === "visual" ? "fill" : "fill hidden"}>
                    <VisualView
                      blocks={blocks}
                      activeSeg={activeSeg}
                      cursorSeg={cursorSeg}
                      containerRef={visualContainerRef}
                      onBlockClick={(b) => {
                        if (b.line) {
                          setLeftView("code");
                          setTimeout(() => editorRef.current?.scrollToLine(b.line as number), 30);
                        }
                      }}
                      onBlockDblClick={(b) => {
                        setShowReadAloud(true);
                        // Panel may need a tick to mount before it can play.
                        setTimeout(() => readAloudRef.current?.playFromSeg(b.seg), 60);
                      }}
                    />
                  </div>
                </div>
              }
              second={
                <div className="preview-col">
                  <PdfView ref={pdfRef} url={pdfUrl} onInverse={inverseSync} />
                </div>
              }
            />
          }
        />

        {/* right-docked panels */}
        {(showReadAloud || showWordPanel) && (
          <aside className="rightdock">
            {showWordPanel && <WordCountPanel result={docCount} onClose={() => setShowWordPanel(false)} />}
            {showReadAloud && (
              <ReadAloud
                ref={readAloudRef}
                blocks={blocks}
                getCursorLine={() => cursorRef.current.line}
                onActiveBlock={onActiveBlock}
                ensureVisual={() => setLeftView("visual")}
                onClose={() => setShowReadAloud(false)}
              />
            )}
          </aside>
        )}
      </div>

      {/* ---------------- open-folder dialog ---------------- */}
      {showOpen && (
        <div className="modal-backdrop" onClick={() => setShowOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="panel-title">
              Open project folder
              <button className="link" onClick={() => setShowOpen(false)}>close</button>
            </div>
            <p className="muted modal-hint">
              Each folder opens in its own browser tab. Paths are on the machine running the
              OffLeaf backend; <code>~</code> expands to your home directory.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (openPath.trim()) void openFolder(openPath.trim());
              }}
            >
              <div className="modal-row">
                <input
                  autoFocus
                  type="text"
                  placeholder="~/papers/my-manuscript"
                  value={openPath}
                  onChange={(e) => setOpenPath(e.target.value)}
                />
                <button className="primary" type="submit" disabled={!openPath.trim()}>Open in new tab</button>
              </div>
            </form>
            {openError && <div className="modal-error">{openError}</div>}
            {projList && projList.open.length > 0 && (
              <>
                <div className="modal-sub">Open in this server</div>
                {projList.open.map((pr) => (
                  <button key={pr.id} className="modal-item" onClick={() => void openFolder(pr.root)} title={pr.root}>
                    📁 {pr.name} <span className="muted">{pr.root}</span>
                  </button>
                ))}
              </>
            )}
            {projList && projList.recent.length > 0 && (
              <>
                <div className="modal-sub">Recent</div>
                {projList.recent.map((r) => (
                  <button key={r} className="modal-item" onClick={() => void openFolder(r)} title={r}>
                    🕘 <span className="muted">{r}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {/* ---------------- log panel ---------------- */}
      {showLogs && (
        <div className="logpanel">
          <div className="log-head">
            <span>Compile log — <b className={errorCount ? "err" : "ok"}>{errorCount} errors</b>, {warnCount} warnings</span>
            <button className="link" onClick={() => setShowLogs(false)}>hide</button>
          </div>
          <div className="log-body">
            {logs.length === 0 && <div className="muted">No messages.</div>}
            {logs.map((l, i) => (
              <div
                key={i}
                className={`log-line ${l.severity}${l.line ? " jumpable" : ""}`}
                onClick={() => void onLogClick(l)}
                title={l.line ? "Jump to source line" : undefined}
              >
                <span className="sev">{l.severity}</span>
                {l.file && <span className="loc">{l.file}:{l.line}</span>}
                <span className="msg">{l.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---------------- status bar ---------------- */}
      <footer className="statusbar">
        <span className={`pill ${status}`}>{status}</span>
        <WordCountBar doc={docCount} selection={selCount} />
        <div className="spacer" />
        <button className="link" onClick={() => setShowLogs((v) => !v)}>
          {errorCount ? `${errorCount} errors` : "log"}
        </button>
        <span className="cursor">Ln {cursor.line}, Col {cursor.col}</span>
      </footer>
    </div>
  );
}
