/**
 * HTTP API integration test — boots the real Fastify server (tsx, port 3799)
 * against the bundled fixture project and exercises the REST surface end to
 * end: project info, file CRUD round-trip, the path-traversal rejection,
 * multi-project open/scoping, word counts, and the PDF 404 path.
 * No LaTeX compile is run here (compile.test.ts covers that), so this stays
 * fast. Run with `tsx test/api.test.ts`.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, "..");
const fixture = path.join(here, "fixture");
const sample = path.resolve(serverDir, "..", "sample");
const PORT = 3799;
const BASE = `http://127.0.0.1:${PORT}`;
// POST /api/projects/open below writes to the recent-projects list — keep
// that off the real machine's ~/.config/offleaf/recent.json.
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "offleaf-config-"));

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
}

// Boot the real server as a child process.
const child = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["tsx", "src/index.ts"],
  {
    cwd: serverDir,
    env: { ...process.env, OFFLEAF_PORT: String(PORT), OFFLEAF_PROJECT: fixture, OFFLEAF_CONFIG_DIR: configDir },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let serverOutput = "";
child.stdout.on("data", (c: Buffer) => (serverOutput += c.toString()));
child.stderr.on("data", (c: Buffer) => (serverOutput += c.toString()));

async function waitForServer(timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/project`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server did not come up on :${PORT}.\n--- server output ---\n${serverOutput}`);
}

async function main() {
  await waitForServer();

  // --- project info -------------------------------------------------------
  const proj = (await (await fetch(`${BASE}/api/project`)).json()) as {
    name: string; mainFile: string; id: string; tree: { children: { name: string }[] };
  };
  check("GET /api/project returns the boot project", proj.name === "fixture");
  check("main file auto-detected", proj.mainFile === "paper.tex");
  check("file tree lists the sources",
    proj.tree.children.some((c) => c.name === "paper.tex") &&
    proj.tree.children.some((c) => c.name === "refs.bib"));

  // --- file read + write round-trip ---------------------------------------
  const file = (await (await fetch(`${BASE}/api/file?path=paper.tex`)).json()) as { content: string };
  check("GET /api/file returns LaTeX source", /\\documentclass/.test(file.content));

  const scratchRel = "api-test-scratch.txt";
  const putRes = await fetch(`${BASE}/api/file`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: scratchRel, content: "round trip ✓" }),
  });
  const readBack = (await (await fetch(`${BASE}/api/file?path=${scratchRel}`)).json()) as { content: string };
  check("PUT /api/file writes and reads back", putRes.ok && readBack.content === "round trip ✓");
  const delRes = await fetch(`${BASE}/api/file?path=${scratchRel}`, { method: "DELETE" });
  check("DELETE /api/file removes it",
    delRes.ok && !fs.existsSync(path.join(fixture, scratchRel)));

  // --- the security boundary ----------------------------------------------
  const evil = await fetch(`${BASE}/api/file?path=${encodeURIComponent("../../../../etc/passwd")}`);
  check("path traversal is rejected", !evil.ok);
  const evilWrite = await fetch(`${BASE}/api/file`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "../outside.txt", content: "nope" }),
  });
  check("traversal writes are rejected", !evilWrite.ok);
  check("nothing escaped onto disk", !fs.existsSync(path.resolve(fixture, "..", "outside.txt")));

  // --- multi-project registry ----------------------------------------------
  const opened = (await (
    await fetch(`${BASE}/api/projects/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: sample }),
    })
  ).json()) as { id: string; name: string };
  check("POST /api/projects/open registers a second folder", opened.name === "sample" && !!opened.id);

  const proj2 = (await (
    await fetch(`${BASE}/api/project?p=${opened.id}`)
  ).json()) as { name: string; mainFile: string };
  check("GET /api/project?p=<id> is scoped to that folder",
    proj2.name === "sample" && proj2.mainFile === "main.tex");

  const listing = (await (await fetch(`${BASE}/api/projects`)).json()) as {
    open: { name: string; isDefault: boolean }[];
  };
  check("GET /api/projects lists both, fixture as default",
    listing.open.length >= 2 &&
    listing.open.some((p) => p.name === "fixture" && p.isDefault) &&
    listing.open.some((p) => p.name === "sample" && !p.isDefault));

  const badOpen = await fetch(`${BASE}/api/projects/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "/no/such/dir" }),
  });
  check("opening a nonexistent folder returns 400", badOpen.status === 400);

  // --- word count ----------------------------------------------------------
  const selCount = (await (
    await fetch(`${BASE}/api/wordcount`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "selection", text: "\\textbf{hello} world $x^2$" }),
    })
  ).json()) as { words: number };
  check("selection word count is LaTeX-aware (=2)", selCount.words === 2);

  const docCount = (await (
    await fetch(`${BASE}/api/wordcount`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "section", path: "paper.tex" }),
    })
  ).json()) as { total: { wordsInText: number } };
  check("document word count returns totals", docCount.total.wordsInText > 0);

  // --- PDF before any compile ----------------------------------------------
  const pdf404 = await fetch(`${BASE}/api/pdf`);
  check("GET /api/pdf 404s before any compile in this process", pdf404.status === 404);

  // --- TTS extraction --------------------------------------------------------
  const narration = (await (
    await fetch(`${BASE}/api/tts/extract?path=paper.tex`)
  ).json()) as { segments: { kind: string }[] };
  check("TTS extraction returns segments", narration.segments.length > 0);
}

main()
  .catch((err) => {
    console.error("API test crashed:", err);
    failures++;
  })
  .finally(() => {
    child.kill("SIGTERM");
    console.log(`\n${failures === 0 ? "ALL API TESTS PASSED" : failures + " API CHECK(S) FAILED"}`);
    process.exit(failures === 0 ? 0 : 1);
  });
