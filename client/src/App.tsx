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
  FsBrowseResult,
  ServerMessage,
} from "@offleaf/shared";
import { api, OffLeafSocket } from "./api";
import SplitPane from "./components/SplitPane";
import FileTree from "./components/FileTree";
import Outline from "./components/Outline";
import DocTabs from "./components/DocTabs";
import Editor, { type EditorHandle, type EditorDiagnostic } from "./editor/Editor";
import PdfView, { type PdfHandle } from "./preview/PdfView";
import VisualView from "./visual/VisualView";
import ReadAloud, { type ReadAloudHandle } from "./tts/ReadAloud";
import { WordCountBar, WordCountPanel } from "./wordcount/WordCount";
import { parseLatexBlocks, blockNearLine, stripLatex, type Block } from "./visual/parse";
import { harvestKeys } from "./editor/latex";

type Status = CompileState | "idle";

/** Basename without the .tex extension, e.g. "si_figures.tex" -> "si_figures". */
const baseNoExt = (file: string): string => file.replace(/\.tex$/, "");

/**
 * One PDF preview tab = one compiled document. Each tracks its own compile
 * state/log/PDF independently, so switching tabs shows the last thing that
 * document compiled to without needing to recompile it.
 */
interface DocTab {
  file: string;
  label: string;
  status: Status;
  logs: LogEntry[];
  pdfUrl: string | null;
  jobId: string | null;
  /** This document's own word count (texcount runs on source, not the PDF —
   *  independent of whether it's been compiled yet). */
  docCount: (WordCountResult & { engine: string }) | null;
}

export default function App() {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [activePath, setActivePath] = useState("");
  const [content, setContent] = useState("");
  const [engine, setEngine] = useState<LatexEngine>("pdflatex");
  const [tabs, setTabs] = useState<DocTab[]>([]);
  const [activeTab, setActiveTab] = useState(0);
  const activeDoc = tabs[activeTab] as DocTab | undefined;
  const status: Status = activeDoc?.status ?? "idle";
  const logs: LogEntry[] = activeDoc?.logs ?? [];
  const pdfUrl: string | null = activeDoc?.pdfUrl ?? null;
  const docCount = activeDoc?.docCount ?? null;
  /** What the middle pane shows; the PDF stays on the right regardless. */
  const [leftView, setLeftView] = useState<"code" | "visual">("code");
  const [showReadAloud, setShowReadAloud] = useState(false);
  const [showWordPanel, setShowWordPanel] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [showOpen, setShowOpen] = useState(false);
  const [openPath, setOpenPath] = useState("");
  const [openError, setOpenError] = useState("");
  const [projList, setProjList] = useState<ProjectsListing | null>(null);
  const [browse, setBrowse] = useState<FsBrowseResult | null>(null);
  const [browseError, setBrowseError] = useState("");
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
  const tabsRef = useRef<DocTab[]>([]);
  tabsRef.current = tabs;
  const activeTabRef = useRef(0);
  activeTabRef.current = activeTab;

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
      setTabs([
        {
          file: proj.mainFile,
          label: baseNoExt(proj.mainFile),
          status: "idle",
          logs: [],
          pdfUrl: null,
          jobId: null,
          docCount: null,
        },
      ]);
      setActiveTab(0);
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
    if (msg.type !== "compile:status" && msg.type !== "compile:log" && msg.type !== "compile:done") return;
    // Every compile message carries its jobId; route it to whichever tab
    // started that job (it may not be the currently active one).
    const jobId = msg.type === "compile:done" ? msg.result.jobId : msg.jobId;
    const idx = tabsRef.current.findIndex((t) => t.jobId === jobId);
    if (idx === -1) return;
    if (msg.type === "compile:status") {
      setTabs((prev) => prev.map((t, i) => (i === idx ? { ...t, status: msg.state } : t)));
    } else if (msg.type === "compile:log") {
      setTabs((prev) =>
        prev.map((t, i) => (i === idx ? { ...t, logs: [...t.logs.slice(-500), msg.entry] } : t)),
      );
    } else if (msg.type === "compile:done") {
      setTabs((prev) =>
        prev.map((t, i) =>
          i === idx
            ? {
                ...t,
                status: msg.result.state,
                logs: [...msg.result.errors, ...msg.result.warnings],
                // jobId stays set after the compile finishes (not just while
                // running) — it's how the Download button knows which build to
                // export, and a later recompile overwrites it with the new job's
                // id regardless.
                pdfUrl: msg.result.pdfUrl ?? t.pdfUrl,
              }
            : t,
        ),
      );
      // Collapse the log panel automatically on a clean compile of the tab
      // you're actually looking at (a background tab finishing shouldn't).
      if (idx === activeTabRef.current && msg.result.errors.length === 0 && msg.result.warnings.length === 0) {
        setShowLogs(false);
      }
      // Refresh word count for whichever document just finished compiling
      // (not necessarily the active tab — a background tab can finish too).
      const doneFile = tabsRef.current[idx]?.file;
      if (doneFile) refreshDocCount(doneFile);
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

  /** Word count is per-document (independent of compilation) — refresh
   *  whichever tab matches `file`, so a background tab's count doesn't
   *  clobber the one you're currently looking at. */
  function refreshDocCount(file: string) {
    api.wordcountDoc(file)
      .then((r) => setTabs((prev) => prev.map((t) => (t.file === file ? { ...t, docCount: r } : t))))
      .catch(() => setTabs((prev) => prev.map((t) => (t.file === file ? { ...t, docCount: null } : t))));
  }

  const onEditorChange = (value: string) => {
    setContent(value);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      if (activePath) {
        api.saveFile(activePath, value)
          .then(() => {
            // Refresh the ACTIVE tab's count, not just activePath's own file:
            // editing an \input'd subfile (e.g. abstract.tex) changes the
            // enclosing document's total, not a count for abstract.tex itself.
            const activeFile = tabsRef.current[activeTabRef.current]?.file;
            if (activeFile) refreshDocCount(activeFile);
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
    const tab = tabs[activeTab];
    if (!project || !tab || tab.status === "running" || tab.status === "queued") return;
    if (activePath) await api.saveFile(activePath, content).catch(() => {});
    setTabs((prev) => prev.map((t, i) => (i === activeTab ? { ...t, logs: [], status: "queued" } : t)));
    setShowLogs(true);
    try {
      const { jobId } = await api.compile({ mainFile: tab.file, engine, cleanBuild });
      setTabs((prev) => prev.map((t, i) => (i === activeTab ? { ...t, jobId } : t)));
    } catch (e) {
      setTabs((prev) =>
        prev.map((t, i) =>
          i === activeTab ? { ...t, status: "error", logs: [{ severity: "error", message: String(e) }] } : t,
        ),
      );
    }
  };

  const stopCompile = () => {
    const jobId = tabs[activeTab]?.jobId;
    if (jobId) api.stopCompile(jobId).catch(() => {});
  };

  const addTab = (file: string) => {
    setTabs((prev) => [
      ...prev,
      { file, label: baseNoExt(file), status: "idle" as Status, logs: [], pdfUrl: null, jobId: null, docCount: null },
    ]);
    setActiveTab(tabs.length);
    // Word count doesn't need a compile — texcount runs on source directly.
    refreshDocCount(file);
  };

  const closeTab = (i: number) => {
    if (tabs.length <= 1) return;
    setTabs((prev) => prev.filter((_, idx) => idx !== i));
    setActiveTab((prev) => {
      if (i < prev) return prev - 1;
      if (i === prev) return Math.min(prev, tabs.length - 2);
      return prev;
    });
  };

  const forwardSync = async () => {
    if (!project) return;
    const tab = tabs[activeTab];
    const res = await api.syncForward(
      activePath || project.mainFile,
      cursor.line,
      cursor.col,
      tab ? baseNoExt(tab.file) : undefined,
    );
    if (res) pdfRef.current?.highlight(res.page, res.x, res.y);
  };

  const inverseSync = async (page: number, x: number, y: number) => {
    const tab = tabs[activeTab];
    const res = await api.syncInverse(page, x, y, tab ? baseNoExt(tab.file) : undefined);
    if (!res) return;
    setLeftView("code");
    if (res.file !== activePath) await openFile(res.file).catch(() => {});
    // Allow the editor doc to update before scrolling.
    setTimeout(() => editorRef.current?.scrollToLine(res.line), 50);
  };

  /** Copies the active tab's compiled PDF next to its .tex source; returns the saved path. */
  const exportPdf = async (): Promise<string> => {
    const tab = tabs[activeTab];
    if (!tab?.jobId) throw new Error("No compiled PDF to save yet");
    const { path } = await api.exportPdf(tab.jobId, tab.file);
    return path;
  };

  // ---- open-folder dialog ----
  const showOpenDialog = async () => {
    setOpenError("");
    setShowOpen(true);
    api.listProjects().then(setProjList).catch(() => setProjList(null));
    void loadBrowse(browse?.dir);
  };

  /** Load the folder picker's listing for `dir` (undefined = home directory). */
  const loadBrowse = async (dir?: string) => {
    setBrowseError("");
    try {
      setBrowse(await api.browseFs(dir));
    } catch (e) {
      setBrowseError(String((e as Error).message ?? e));
    }
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
    const tabFile = tabs[activeTab]?.file;
    return logs
      .filter((l) => l.line !== undefined && (l.file ? l.file === activePath : activePath === tabFile))
      .map((l) => ({
        line: l.line as number,
        severity: l.severity === "error" ? "error" as const : "warning" as const,
        message: l.message,
      }));
  }, [logs, activePath, tabs, activeTab]);

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
        <button
          className="primary"
          onClick={() => recompile(false)}
          disabled={compiling}
          title={`Save & compile ${activeDoc?.label ?? ""} (⌘S / ⌘↵)`}
        >
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
                  <DocTabs
                    tabs={tabs.map((t) => ({ file: t.file, label: t.label, status: t.status }))}
                    activeIndex={activeTab}
                    addable={(project?.documents ?? []).filter((d) => !tabs.some((t) => t.file === d))}
                    onSelect={setActiveTab}
                    onClose={closeTab}
                    onAdd={addTab}
                  />
                  {/* Remount per tab: a stale-doc bug otherwise leaves the
                      previous tab's rendered pages on screen when switching
                      to a tab with no PDF yet. Each tab gets its own
                      independent zoom/scroll state as a side effect, which
                      is arguably more correct than sharing one. */}
                  <PdfView
                    key={activeDoc?.file ?? "none"}
                    ref={pdfRef}
                    url={pdfUrl}
                    onInverse={inverseSync}
                    onExport={exportPdf}
                  />
                </div>
              }
            />
          }
        />

        {/* right-docked panels */}
        {(showReadAloud || showWordPanel) && (
          <aside className="rightdock">
            {showWordPanel && (
              <WordCountPanel result={docCount} label={activeDoc?.label} onClose={() => setShowWordPanel(false)} />
            )}
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
              Each folder opens in its own browser tab. Browse to it below, or type a path;{" "}
              <code>~</code> expands to your home directory.
            </p>

            <div className="browse-bar">
              <button
                className="link"
                onClick={() => browse?.parent && void loadBrowse(browse.parent)}
                disabled={!browse?.parent}
                title="Go up one folder"
              >
                ⬆ Up
              </button>
              <button className="link" onClick={() => void loadBrowse()} title="Jump to your home folder">
                🏠 Home
              </button>
              <span className="browse-path" title={browse?.dir}>{browse?.dir ?? "…"}</span>
              <button
                className="primary"
                disabled={!browse}
                onClick={() => browse && void openFolder(browse.dir)}
                title="Open the folder shown above"
              >
                Open this folder
              </button>
            </div>
            {browseError && <div className="modal-error">{browseError}</div>}
            <div className="browse-list">
              {browse && browse.entries.length === 0 && (
                <div className="muted browse-empty">No subfolders here.</div>
              )}
              {browse?.entries
                .filter((e) => !openPath.trim() || e.name.toLowerCase().includes(openPath.trim().toLowerCase()))
                .map((e) => (
                  <button
                    key={e.name}
                    className="modal-item"
                    onClick={() => void loadBrowse(`${browse.dir.replace(/\/$/, "")}/${e.name}`)}
                    title={e.hasTex ? "Contains .tex files" : undefined}
                  >
                    📁 {e.name}
                    {e.hasTex && <span className="tex-flag">tex</span>}
                  </button>
                ))}
            </div>

            <div className="modal-sub">Or open by path</div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (openPath.trim()) void openFolder(openPath.trim());
              }}
            >
              <div className="modal-row">
                <input
                  type="text"
                  placeholder="~/papers/my-manuscript (also filters the list above)"
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
        <WordCountBar doc={docCount} selection={selCount} label={activeDoc?.label} />
        <div className="spacer" />
        <button className="link" onClick={() => setShowLogs((v) => !v)}>
          {errorCount ? `${errorCount} errors` : "log"}
        </button>
        <span className="cursor">Ln {cursor.line}, Col {cursor.col}</span>
      </footer>
    </div>
  );
}
