/**
 * Typed client for the OffLeaf backend. Every call is same-origin (the backend
 * serves this bundle in production and Vite proxies /api + /ws in dev), so
 * nothing here hardcodes a host.
 *
 * Multi-project: a browser tab is pinned to one project by the `?p=<id>` URL
 * query (no query = the folder the server booted with). Every request carries
 * that id, so several tabs can edit different folders against one backend.
 */
import type {
  ProjectInfo,
  ProjectsListing,
  FileContents,
  CompileRequest,
  WordCountResult,
  SelectionCountResult,
  SyncForwardResult,
  SyncInverseResult,
  NarrationDocument,
  FsBrowseResult,
  ServerMessage,
} from "@offleaf/shared";

/** The project id this tab is pinned to ("" = the server's boot project). */
export const PROJECT_ID = new URLSearchParams(window.location.search).get("p") ?? "";

const JSON_HEADERS = { "Content-Type": "application/json" };

/** Append this tab's project id to a GET/DELETE URL. */
function withP(url: string): string {
  if (!PROJECT_ID) return url;
  return `${url}${url.includes("?") ? "&" : "?"}p=${encodeURIComponent(PROJECT_ID)}`;
}

/** Add this tab's project id to a JSON body. */
function bodyP<T extends object>(body: T): string {
  return JSON.stringify(PROJECT_ID ? { ...body, p: PROJECT_ID } : body);
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      /* no JSON body */
    }
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

type Ok = { ok: boolean };

export const api = {
  getProject: (): Promise<ProjectInfo> => fetch(withP("/api/project")).then(json<ProjectInfo>),

  listProjects: (): Promise<ProjectsListing> => fetch("/api/projects").then(json<ProjectsListing>),

  openProject: (path: string): Promise<{ id: string; root: string; name: string }> =>
    fetch("/api/projects/open", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ path }),
    }).then(json<{ id: string; root: string; name: string }>),

  /** Lists subdirectories of `dir` for the Open dialog's folder picker; omit for home. */
  browseFs: (dir?: string): Promise<FsBrowseResult> =>
    fetch(dir ? `/api/fs/browse?dir=${encodeURIComponent(dir)}` : "/api/fs/browse").then(
      json<FsBrowseResult>,
    ),

  getFile: (path: string): Promise<FileContents> =>
    fetch(withP(`/api/file?path=${encodeURIComponent(path)}`)).then(json<FileContents>),

  saveFile: (path: string, content: string): Promise<Ok> =>
    fetch("/api/file", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: bodyP({ path, content }),
    }).then(json<Ok>),

  createFile: (path: string, content = ""): Promise<Ok> =>
    fetch("/api/file", {
      method: "POST",
      headers: JSON_HEADERS,
      body: bodyP({ path, content }),
    }).then(json<Ok>),

  deleteFile: (path: string): Promise<Ok> =>
    fetch(withP(`/api/file?path=${encodeURIComponent(path)}`), { method: "DELETE" }).then(json<Ok>),

  renameFile: (from: string, to: string): Promise<Ok> =>
    fetch("/api/rename", {
      method: "POST",
      headers: JSON_HEADERS,
      body: bodyP({ from, to }),
    }).then(json<Ok>),

  compile: (req: CompileRequest): Promise<{ jobId: string }> =>
    fetch("/api/compile", {
      method: "POST",
      headers: JSON_HEADERS,
      body: bodyP(req),
    }).then(json<{ jobId: string }>),

  stopCompile: (jobId: string): Promise<{ stopped: boolean }> =>
    fetch("/api/compile/stop", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ jobId }),
    }).then(json<{ stopped: boolean }>),

  pdfUrl: (jobId: string): string => withP(`/api/pdf?jobId=${encodeURIComponent(jobId)}`),

  /** Copies the compiled PDF next to `file` (its .tex source), same basename. */
  exportPdf: (jobId: string, file: string): Promise<{ path: string }> =>
    fetch("/api/pdf/export", {
      method: "POST",
      headers: JSON_HEADERS,
      body: bodyP({ jobId, file }),
    }).then(json<{ path: string }>),

  /**
   * SyncTeX both directions take an optional `doc` — the target document's
   * basename without extension (e.g. "si_figures") — so a project with
   * several standalone documents (a main file plus an SI figures file, say)
   * syncs against the PDF for the tab you're actually looking at, not
   * whichever document happened to compile most recently.
   */
  syncForward: (file: string, line: number, col: number, doc?: string): Promise<SyncForwardResult | null> =>
    fetch(
      withP(
        `/api/synctex/forward?file=${encodeURIComponent(file)}&line=${line}&col=${col}` +
          (doc ? `&doc=${encodeURIComponent(doc)}` : ""),
      ),
    ).then(json<SyncForwardResult | null>),

  syncInverse: (page: number, x: number, y: number, doc?: string): Promise<SyncInverseResult | null> =>
    fetch(
      withP(`/api/synctex/inverse?page=${page}&x=${x}&y=${y}` + (doc ? `&doc=${encodeURIComponent(doc)}` : "")),
    ).then(json<SyncInverseResult | null>),

  wordcountDoc: (path: string): Promise<WordCountResult & { engine: string }> =>
    fetch("/api/wordcount", {
      method: "POST",
      headers: JSON_HEADERS,
      body: bodyP({ path, mode: "section" }),
    }).then(json<WordCountResult & { engine: string }>),

  wordcountSelection: (text: string): Promise<SelectionCountResult> =>
    fetch("/api/wordcount", {
      method: "POST",
      headers: JSON_HEADERS,
      body: bodyP({ text, mode: "selection" }),
    }).then(json<SelectionCountResult>),

  ttsExtract: (path: string): Promise<NarrationDocument> =>
    fetch(withP(`/api/tts/extract?path=${encodeURIComponent(path)}`)).then(json<NarrationDocument>),
};

/** Thin wrapper over the compile WebSocket with add/remove listener semantics. */
export class OffLeafSocket {
  private ws: WebSocket | null = null;
  private handlers = new Set<(m: ServerMessage) => void>();

  connect(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as ServerMessage;
        // Events are broadcast to every tab; only surface this project's.
        if ("projectId" in msg && (msg.projectId ?? "") !== PROJECT_ID) return;
        this.handlers.forEach((h) => h(msg));
      } catch {
        /* ignore non-JSON frames (e.g. pong) */
      }
    };
    ws.onclose = () => {
      // Reconnect after a short delay so a backend restart is transparent.
      setTimeout(() => this.connect(), 1500);
    };
    this.ws = ws;
  }

  on(handler: (m: ServerMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}
