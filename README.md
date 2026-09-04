# OffLeaf — an offline, local-first LaTeX IDE

An Overleaf/VS Code-style LaTeX editor that runs **entirely on your machine, offline**.
The UI runs in your browser; a small local backend drives the real LaTeX toolchain
(`latexmk` on your TeX distribution) so compiling behaves exactly like Overleaf — because
it uses the same programs and defaults, not an approximation.

**→ [INSTALL.md](./INSTALL.md) — one-time setup (Node, MacTeX, Apple Silicon notes)**
**→ [USAGE.md](./USAGE.md) — running it, opening your own folders, shortcuts, TTS settings**

## Documentation map — start here

| If you want to… | Read |
|---|---|
| **Set it up for the first time** (assumes nothing, copy-paste commands) | [GETTING_STARTED.md](./GETTING_STARTED.md) |
| Install details, prerequisites, Apple Silicon notes | [INSTALL.md](./INSTALL.md) |
| **Create your first paper**, step by step, from the included template | [EXAMPLE.md](./EXAMPLE.md) |
| Every feature and setting, day-to-day reference | [USAGE.md](./USAGE.md) |
| Understand how it works inside / extend the code | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| The original design rationale and API contract | [DESIGN_SPEC.md](./DESIGN_SPEC.md) |

Tired and just want it running? `npm install && npm run build && npm start` →
http://localhost:3000. Verify anything ever with `npm test` (93 checks).

---

## What you get

- **Overleaf-like source editor** — CodeMirror 6 (the same editor Overleaf uses): LaTeX
  highlighting, autocompletion of commands/environments and your own `\ref`/`\cite` keys,
  search, folding, Vim/Emacs-capable keymaps, autosave.
- **Overleaf-matching compile defaults** — pdfLaTeX via `latexmk` by default (also XeLaTeX /
  LuaLaTeX), with `-interaction=nonstopmode -file-line-error -synctex=1`; `latexmk` handles
  BibTeX/biber and multi-pass reruns. A structured error/warning panel jumps to the offending
  line.
- **PDF preview always beside the code** — PDF.js renders locally on the right; zoom,
  fit-width, multi-page scroll, download; scroll position survives recompiles. The middle
  pane toggles **Code ⇄ Visual** so the PDF never leaves the screen.
- **Multiple projects in browser tabs** — 📂 Open… launches any folder in its own tab
  (`?p=<id>`); compiles and counts are independent per tab. See USAGE.md.
- **SyncTeX both ways** — ⟶ PDF button jumps from the cursor to the PDF; ⌘/Ctrl-click in the
  PDF jumps back to the source line.
- **Visual view** — a styled, semi-WYSIWYG reading view with live math (KaTeX) in the middle
  pane, position-mapped to the source (click a block to jump to its line).
- **Word counts** — whole-document and **per-section** counts via `texcount`, plus an instant,
  LaTeX-aware **count of any text you highlight** in the status bar.
- **Read Aloud (text-to-speech)** — Word-style narration using your OS's offline voices, with
  karaoke-style sentence highlighting, editor follow-along, read-from-cursor, and full
  settings (voice picker + preview, speed, pitch, volume, math handling — persisted).

---

## Prerequisites

- **Node.js 20+** (for the app itself).
- **A TeX distribution** for real compilation and word counts:
  - macOS: **MacTeX** (`brew install --cask mactex`) or the smaller **BasicTeX**.
  - This provides `latexmk`, `pdflatex`/`xelatex`/`lualatex`, `bibtex`/`biber`, `synctex`,
    and `texcount`. If `texcount` is missing, word counts fall back to a built-in estimator.
- **Text-to-speech** needs no install — it uses your operating system's built-in voices
  (fully offline on macOS).

> This repository may contain `node_modules`/`dist` produced by an automated Linux build.
> On your Mac, do a clean install first:
> ```bash
> rm -rf node_modules */node_modules **/dist
> ```

---

## Quick start

```bash
# from the repo root
npm install          # installs all workspaces (shared, server, client)
npm run build:shared # compile the shared types once
npm run dev          # starts the backend + Vite dev server together
```

Then open the printed URL (the Vite dev server, http://localhost:5173). The dev server
proxies `/api` and `/ws` to the backend on port 3000.

**Point it at your paper** (full details in [USAGE.md](./USAGE.md)): the backend opens the
bundled `sample/` project by default. Either use the **📂 Open…** toolbar button to open any
folder in a new browser tab, or launch the backend against a folder directly:

```bash
# build the client once, then serve everything from the backend on :3000
npm run build
npm start -- /path/to/your/paper          # CLI argument…
OFFLEAF_PROJECT=/path/to/your/paper npm start   # …or env var
# open http://localhost:3000
```

Anything you edit is saved straight to that folder — it stays a normal LaTeX project you can
also open in Overleaf or VS Code.

---

## Running it as an app (optional, macOS)

Two independent pieces, mix and match:

- **A standalone window, no browser chrome.** The page ships a web manifest + icon
  (`client/public/`), so it's installable like any other web app: open http://localhost:3000,
  then Chrome/Edge → ⋮ menu → *Cast, save, and share* → *Install page as app…*. You get a Dock
  icon and its own window, launchable from Spotlight/Raycast/Dock like a native app.
- **A launcher you can double-click** instead of typing `npm start` in a terminal. It starts
  the backend if it isn't already running, waits for it to come up, then opens it — see
  `deploy/OffLeaf.applescript` (comment at the top has the one-line `osacompile` build command
  and where to put the result). There's no always-on background service — the backend only
  runs while you're actually using it (or until you quit/restart your Mac), unlike the always-on
  setup used for the `todo` app.

---

## How the requested features map to the code

| You asked for | Where it lives |
|---|---|
| Overleaf-like editing | `client/src/editor/` (CodeMirror 6 + LaTeX language/completion) |
| Same compile settings/defaults as Overleaf | `server/src/services/compile.ts` + `packages/shared` (`LATEXMK_BASE_FLAGS`) |
| Compilation + PDF preview beside code | `client/src/preview/PdfView.tsx`, `client/src/App.tsx` (split layout) |
| Visual view beside the code | `client/src/visual/` (parser + KaTeX rendering) |
| Word counts for sections & highlighted text | `server/src/services/wordcount.ts`, `client/src/wordcount/` |
| Text-to-speech read-aloud | `client/src/tts/ReadAloud.tsx` (Web Speech API, offline voices) |

---

## Repository layout

```
packages/shared/  shared TypeScript types = the API/WS contract (imported by both sides)
server/           Fastify backend: files, compile (latexmk), synctex, texcount, ws, tts
client/           React + Vite UI: editor, PDF, visual view, word count, read-aloud
sample/           a math + bibliography manuscript to try immediately
server/test/      an end-to-end compile test (npm run test -w server)
```

## Scripts

- `npm run dev` — backend + client dev servers with hot reload.
- `npm run build` — type-check + build the client, compile the server.
- `npm start` — run the built backend (serves the built UI on :3000).
- `npm test` — the full suite (93 checks): backend unit tests, HTTP API integration
  tests, a real end-to-end latexmk compile, and the client parser tests.
- `OFFLEAF_PROJECT=/path npm start` — open a specific project folder.

---

## Status & limitations (see DESIGN_SPEC §12)

This build covers M0–M5: editor, compile, PDF preview, word counts, SyncTeX both ways, the
visual view, and read-aloud, covered by a 93-check test suite (`npm test`: unit + HTTP API +
end-to-end latexmk compile + client parser tests, passing against TeX Live 2024).
Known scoping choices: the Visual view is a rich **reading** view (editing stays in source),
math-to-speech is basic, and full Overleaf version-pinning depends on your local TeX Live
version (surfaced in the toolbar). SyncTeX accuracy follows the usual SyncTeX caveats.

### Polish pass (2026-07-11), verified end-to-end in the browser

Fixes:
- **Per-section word counts** actually work now: `texcount` was invoked with `-brief -total`,
  both of which suppress the `Subcounts:` block, so the panel always said "No sections found".
  Now parsed from the full `texcount -sub=section -merge` output.
- **SyncTeX inverse search** (⌘-click in the PDF) landed on mirrored positions: PDF.js reports
  bottom-origin coordinates while `synctex edit` expects top-origin. The click's y is flipped.
- **Word count refreshed after compile** — the WebSocket handler captured the first render's
  null project (stale closure); it now routes through refs.
- **Compile log showed stale warnings** ("undefined citations" that the final pass resolved):
  diagnostics are now parsed from the final pass's `.log` file, not latexmk's accumulated stdout.
- **Visual view leaked environment names** ("abstract We illustrate…"); env delimiters are
  stripped, and the abstract gets a proper heading.
- **Editor followed only the dark theme**; it now switches with the app theme.
- **Stop compile** kills the whole latexmk process group (pdflatex/bibtex children included).

New polish:
- Compile errors/warnings appear as **gutter markers + squiggles** on the offending lines,
  and clicking a log entry opens the right file before jumping.
- Overleaf keybindings: **⌘S / ⌘↵ save-and-compile**, ⌘/ comment, ⌘B/⌘I bold/italic.
- `\begin{env}` completion **auto-inserts the matching `\end{env}`**; snippet completions for
  figure/table/equation/itemize/enumerate.
- PDF preview **preserves scroll position across recompiles**, has fit-width zoom and a
  **Download PDF** button; a **Stop** button appears while compiling.
- Visual view renders a **title/author block** and real bullet/numbered **lists**, and is
  position-mapped: **click any block to jump the editor to its source line**; the visual pane
  follows the editor cursor with a subtle outline.
- Read Aloud: **"Read from cursor"**, double-click a sentence to read from there, and a
  **"follow along in the editor"** toggle that scrolls the source with the narration.

### Layout & workflow update (2026-07-11, round 2)

- **PDF pinned to the right pane permanently**; the middle pane toggles Code ⇄ Visual —
  the preview is always in sight while editing either way.
- **Multi-project support**: 📂 Open… dialog (path input + recent folders) opens any
  directory in its own browser tab via `?p=<id>`; all API calls, compiles, PDFs, and
  word counts are scoped per project. CLI arg and `OFFLEAF_PROJECT` still set the default.
  Recent folders persist in `~/.config/offleaf/recent.json`.
- **Read Aloud settings**: voice preview button, volume, wider speed range, show-all-voices
  toggle, reset, and localStorage persistence — plus in-app guidance on installing better
  macOS voices.
- **Apple Silicon**: verified compatible with no code changes — all native pieces are
  install-time build tools (npm picks arm64 variants) and MacTeX binaries are universal.
  Just clean-install `node_modules` on the ARM machine (see INSTALL.md §3).
