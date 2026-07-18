/**
 * OffLeaf backend entry point.
 *
 * A Fastify server bound to 127.0.0.1 that:
 *   - serves the built client (when client/dist exists) as an SPA,
 *   - exposes the REST + WebSocket API defined in @offleaf/shared,
 *   - drives latexmk / texcount / synctex against the local TeX distribution.
 *
 * Multiple project folders can be open at once: every endpoint takes an
 * optional `p` (project id) parameter, and each browser tab pins itself to one
 * project via the `?p=` URL query. No `p` means the folder the server was
 * started with, so single-project use needs no ids at all.
 *
 * There is no cloud and no cross-origin traffic: the UI and API share an origin.
 */
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type {
  ClientMessage,
  CompileRequest,
  ProjectInfo,
  ProjectsListing,
  SelectionCountResult,
} from "@offleaf/shared";
import { DEFAULT_ENGINE } from "@offleaf/shared";
import {
  PORT,
  projectRoot,
  clientDist,
  detectTexDistribution,
  safeResolve,
  initDefaultProject,
  registerProject,
  listProjects,
  recentProjects,
} from "./config.js";
import * as files from "./services/files.js";
import { CompileService } from "./services/compile.js";
import { forward, inverse } from "./services/synctex.js";
import { documentCount, selectionCount } from "./services/wordcount.js";
import { extractNarration } from "./services/narration.js";
import { WsHub } from "./ws.js";

initDefaultProject();

const app = Fastify({ logger: false });
const hub = new WsHub();
const compiler = new CompileService();

await app.register(fastifyWebsocket);

/** The `p` (project id) param from a query or JSON body; "" = boot project. */
function pidOf(req: { query?: unknown; body?: unknown }): string {
  const q = (req.query as { p?: string } | undefined)?.p;
  const b = (req.body as { p?: string } | undefined)?.p;
  return q || b || "";
}

/** Find the main .tex file: prefer main.tex, else the first file with \documentclass. */
async function detectMainFile(projectId: string): Promise<string> {
  const root = projectRoot(projectId);
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const texFiles = entries.filter((e) => e.isFile() && e.name.endsWith(".tex")).map((e) => e.name);
  if (texFiles.includes("main.tex")) return "main.tex";
  for (const name of texFiles) {
    const content = await fsp.readFile(path.join(root, name), "utf8").catch(() => "");
    if (/\\documentclass/.test(content)) return name;
  }
  return texFiles[0] ?? "main.tex";
}

// --------------------------------------------------------------------------
// Project registry + files
// --------------------------------------------------------------------------

app.get("/api/project", async (req): Promise<ProjectInfo> => {
  const p = pidOf(req);
  const tree = await files.listTree(p);
  return {
    id: p,
    root: projectRoot(p),
    name: tree.name,
    mainFile: await detectMainFile(p),
    engine: DEFAULT_ENGINE,
    texDistribution: detectTexDistribution(),
    tree,
  };
});

app.get("/api/projects", async (): Promise<ProjectsListing> => {
  return { open: listProjects(), recent: recentProjects() };
});

app.post("/api/projects/open", async (req, reply) => {
  const { path: dir } = req.body as { path?: string };
  if (!dir || typeof dir !== "string") {
    reply.code(400);
    return { error: "Body must be { path: \"/absolute/or/~/folder\" }" };
  }
  try {
    const { id, root } = registerProject(dir);
    return { id, root, name: path.basename(root) };
  } catch (e) {
    reply.code(400);
    return { error: String((e as Error).message ?? e) };
  }
});

app.get("/api/file", async (req) => {
  const { path: p } = req.query as { path: string };
  return files.readFile(p, pidOf(req));
});

app.put("/api/file", async (req) => {
  const { path: p, content } = req.body as { path: string; content: string };
  await files.writeFile(p, content, pidOf(req));
  return { ok: true };
});

app.post("/api/file", async (req) => {
  const { path: p, content } = req.body as { path: string; content?: string };
  await files.createFile(p, content ?? "", pidOf(req));
  return { ok: true };
});

app.delete("/api/file", async (req) => {
  const { path: p } = req.query as { path: string };
  await files.deleteFile(p, pidOf(req));
  return { ok: true };
});

app.post("/api/rename", async (req) => {
  const { from, to } = req.body as { from: string; to: string };
  await files.rename(from, to, pidOf(req));
  return { ok: true };
});

// --------------------------------------------------------------------------
// Compile
// --------------------------------------------------------------------------

app.post("/api/compile", async (req) => {
  const body = req.body as CompileRequest;
  const jobId = compiler.start(body, (msg) => hub.broadcast(msg), pidOf(req));
  return { jobId };
});

app.post("/api/compile/stop", async (req) => {
  const { jobId } = req.body as { jobId: string };
  return { stopped: compiler.stop(jobId) };
});

app.get("/api/pdf", async (req, reply) => {
  const { jobId } = req.query as { jobId?: string };
  const abs = compiler.pdfAbsFor(jobId, pidOf(req));
  if (!abs || !fs.existsSync(abs)) {
    reply.code(404);
    return { error: "No compiled PDF available" };
  }
  reply.header("Content-Type", "application/pdf");
  reply.header("Cache-Control", "no-store");
  return reply.send(fs.createReadStream(abs));
});

// --------------------------------------------------------------------------
// SyncTeX
// --------------------------------------------------------------------------

app.get("/api/synctex/forward", async (req) => {
  const { file, line, col } = req.query as { file: string; line: string; col?: string };
  const p = pidOf(req);
  const pdfRel = compiler.pdfRelFor(undefined, p);
  if (!pdfRel) return null;
  return forward(file, Number(line), Number(col ?? 0), pdfRel, p);
});

app.get("/api/synctex/inverse", async (req) => {
  const { page, x, y } = req.query as { page: string; x: string; y: string };
  const p = pidOf(req);
  const pdfRel = compiler.pdfRelFor(undefined, p);
  if (!pdfRel) return null;
  return inverse(Number(page), Number(x), Number(y), pdfRel, p);
});

// --------------------------------------------------------------------------
// Word count + TTS extraction
// --------------------------------------------------------------------------

app.post("/api/wordcount", async (req): Promise<unknown> => {
  const body = req.body as { path?: string; text?: string; mode: "doc" | "section" | "selection" };
  if (body.mode === "selection") {
    const res: SelectionCountResult = selectionCount(body.text ?? "");
    return res;
  }
  const pid = pidOf(req);
  const p = body.path ?? (await detectMainFile(pid));
  const source = await fsp.readFile(safeResolve(p, pid), "utf8").catch(() => "");
  return documentCount(p, source, pid);
});

app.get("/api/tts/extract", async (req) => {
  const { path: p } = req.query as { path?: string };
  const pid = pidOf(req);
  const main = p ?? (await detectMainFile(pid));
  const source = await fsp.readFile(safeResolve(main, pid), "utf8").catch(() => "");
  return extractNarration(source);
});

// --------------------------------------------------------------------------
// WebSocket
// --------------------------------------------------------------------------

app.get("/ws", { websocket: true }, (socket) => {
  hub.add(socket);
  socket.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString()) as ClientMessage;
      if (msg.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
    } catch {
      /* ignore malformed client messages */
    }
  });
});

// --------------------------------------------------------------------------
// Static client (SPA) — only when a production build exists
// --------------------------------------------------------------------------

const dist = clientDist();
if (fs.existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist, prefix: "/" });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api") || req.url.startsWith("/ws")) {
      reply.code(404).send({ error: "Not found" });
    } else {
      reply.sendFile("index.html");
    }
  });
}

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

const address = await app.listen({ host: "127.0.0.1", port: PORT });
console.log(`\n  OffLeaf backend running`);
console.log(`  Project : ${projectRoot()}`);
console.log(`  TeX     : ${detectTexDistribution()}`);
console.log(`  URL     : ${address}`);
console.log(
  fs.existsSync(dist)
    ? `  Serving the built UI. Open ${address} in your browser.\n`
    : `  API only (no client build yet). Run the client dev server with \`npm run dev:client\`.\n`,
);
