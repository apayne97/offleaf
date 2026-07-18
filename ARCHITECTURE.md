# How OffLeaf Works

A plain-language tour of the moving parts, for future-you or anyone extending
the code. The formal spec is [DESIGN_SPEC.md](./DESIGN_SPEC.md); this file is
the "explain it to me" version.

## The one-paragraph version

OffLeaf is two programs. A **backend** (Node.js + Fastify, `server/`) runs on
your machine, owns your project folders, and shells out to your real TeX
installation (`latexmk`, `texcount`, `synctex`) — the same programs Overleaf
runs on its servers. A **frontend** (React + CodeMirror 6 + PDF.js + KaTeX,
`client/`) runs in your browser and talks to the backend over plain HTTP plus
one WebSocket for live compile progress. The backend serves the built
frontend, so one `npm start` gives you the whole IDE at `localhost:3000`, and
nothing ever touches the network.

```
Browser tab (?p=<project-id>)
│  React UI: file tree · CodeMirror editor ⇄ Visual view · PDF.js preview
│  Read-Aloud: browser speechSynthesis (macOS voices, offline)
│
├── HTTP  /api/…      files, compile, wordcount, synctex, projects
└── WS    /ws         compile:status / compile:log / compile:done
        │
   Node backend (127.0.0.1:3000 only)
        │  spawns, per request:
        ├── latexmk -pdf -interaction=nonstopmode -file-line-error -synctex=1
        ├── texcount -sub=section -merge        (word counts)
        └── synctex view / synctex edit          (code ↔ PDF mapping)
                → your TeX Live / MacTeX installation
```

## The pieces, one by one

### Projects and files (`server/src/config.ts`, `services/files.ts`)

A "project" is nothing but a directory. The backend keeps a registry
`id → folder` (id = first 8 hex chars of the folder path's SHA-1, so the same
folder always gets the same id). The folder given at launch is the *default*
project; the 📂 Open… dialog registers more via `POST /api/projects/open`.
Each browser tab pins itself to one project with the `?p=<id>` URL query, and
every API call carries that id — that's the whole multi-tab mechanism.
Recently opened folders persist in `~/.config/offleaf/recent.json`.

**Security boundary:** every path from the client goes through
`safeResolve()`, which resolves it against the project root and throws if the
result escapes it (`../../etc/passwd` → rejected). The server binds to
127.0.0.1 only. `-shell-escape` is off unless a request explicitly asks.

### Compiling (`services/compile.ts`)

`POST /api/compile` spawns latexmk with Overleaf's flag set, in its own
process group (so ⏹ Stop can kill pdflatex/bibtex children too, and a 120 s
timeout catches runaways). latexmk itself handles the bibtex/rerun dance.
Output goes to `.build/` inside the project so your sources stay clean.

Progress streams over the WebSocket. When the run ends, diagnostics are
parsed **from the final pass's `.log` file**, not latexmk's accumulated
stdout — intermediate passes always contain "undefined citation, rerun"
noise that the last pass resolves. Parsed errors carry `file:line` (thanks to
`-file-line-error`), which is what powers click-to-jump in the log panel and
the red gutter markers in the editor.

### The PDF pane (`client/src/preview/PdfView.tsx`)

Mozilla's PDF.js renders `.build/<main>.pdf` onto canvases — locally, no
plugin. Each page also gets a PDF.js **text layer**: invisible spans
positioned exactly over the painted glyphs (scaled via the `--scale-factor`
CSS variable), which is what makes text in the preview selectable/copyable at
any zoom. On recompile the component reloads the document but restores the
scroll offset, so the page you were proofreading stays put.

**SyncTeX, the subtle part:** `synctex` speaks coordinates measured from the
page's **top**-left in PDF points; PDF.js's `convertToPdfPoint` returns
**bottom**-origin coordinates. Forward search (code→PDF) uses synctex output
directly; inverse search (⌘-click) flips `y = pageHeight − y` before asking
`synctex edit`. If jumps ever land mirrored, this is the invariant to check.

### The Visual view (`client/src/visual/parse.ts`, `VisualView.tsx`)

A pragmatic LaTeX parser (regex-based, not a TeX engine) turns the source
into an ordered list of *blocks*: title/author, headings, sentences, list
items, captions, display math. Math renders with KaTeX; bold/italic/cites get
light HTML styling. Two properties make it more than a pretty printer:

- every block records the **source line** it came from, so clicking a block
  jumps the editor, the editor cursor highlights its block, and Read-Aloud
  can start "from cursor" and drive follow-along scrolling;
- every block has a stable **seg id**, which is what the karaoke highlight
  targets during speech.

It is deliberately a *reading* surface — editing stays in the code pane.
Known limit: package-specific macros KaTeX doesn't know (e.g. siunitx `\SI`)
show as-is in Visual while compiling fine in the real PDF.

### Word counts (`services/wordcount.ts`)

Document/per-section counts come from `texcount -sub=section -merge` (the
LaTeX-aware counter TeX Live ships; also what Overleaf uses). Hard-won flag
fact: `-brief` and `-total` each **suppress** the per-section `Subcounts:`
block, so the full output is parsed instead. Selection counts strip LaTeX
markup in-process for instant feedback (`\textbf{foo}` counts as one word,
math and `\cite` keys count as zero).

### Read Aloud (`client/src/tts/ReadAloud.tsx`)

Pure browser `speechSynthesis` — the voices are the operating system's, so
it's offline and costs nothing. The narration text is the Visual view's block
list run through `spokenText()`: headings announced, citations/labels
dropped, math handled per the chosen mode (skip / "equation" / naive
verbalization). The API exposes exactly four knobs — voice, rate, pitch,
volume — all surfaced in the panel and persisted in localStorage. Voice
*quality* is a macOS setting (download Enhanced/Premium/Siri voices in System
Settings); OffLeaf just lists whatever the OS provides.

### The shared contract (`packages/shared/`)

Every request/response shape and WebSocket message type lives in one
TypeScript module imported by both sides. If the server changes a payload and
the client isn't updated, the build fails — the API cannot silently drift.

## What runs when (lifecycle)

1. `npm start` → `server/dist/index.js` registers the boot project, starts
   Fastify on 127.0.0.1:3000, serves `client/dist/`.
2. Browser loads the UI → `GET /api/project(?p=…)` → file tree + main file →
   editor opens it; WebSocket connects.
3. You type → autosave PUTs the file 0.6 s after you pause → word count
   refreshes.
4. ⌘S → save, then `POST /api/compile` → WS streams status → on done the UI
   fetches the PDF, updates diagnostics, refreshes counts.

## The test suite (`npm test`)

| File | What it proves |
|---|---|
| `server/test/unit.test.ts` | Path-traversal guard, project registry, log parsing, texcount parsing, LaTeX stripping, narration extraction (32 checks, no TeX needed) |
| `server/test/api.test.ts` | Boots the real HTTP server and exercises the REST surface: file CRUD round-trip, traversal rejection, multi-project scoping, word counts (17 checks) |
| `server/test/compile.test.ts` | Full end-to-end compile of a fixture through real latexmk: PDF, SyncTeX file, counts, narration (9 checks) |
| `client/test/parse.test.ts` | The Visual-view parser: block structure, source-line mapping, spoken-text modes (22 checks) |
| `client/test/hidpi.test.ts` | Retina/HiDPI canvas sizing rules for the PDF viewer: 2x bitmaps, CSS pinning, ratio cap, fallbacks (13 checks) |

All five files run from the repo root with `npm test`; everything except
`compile.test.ts` passes even on a machine with no TeX installed.

## Repository map

```
packages/shared/   API + WebSocket types (the contract)
server/src/
  index.ts         HTTP routes + static serving + WS
  config.ts        project registry, safeResolve (security), TeX detection
  services/        compile.ts · files.ts · wordcount.ts · synctex.ts · narration.ts
server/test/       unit + api + compile tests, LaTeX fixture
client/src/
  App.tsx          layout, state, toolbar, open-folder dialog
  editor/          CodeMirror setup, LaTeX language, completions, keymaps
  preview/         PDF.js pane + SyncTeX glue
  visual/          LaTeX→blocks parser + KaTeX renderer
  tts/             Read-Aloud panel
  wordcount/       status-bar + panel UI
client/test/       parser tests
templates/article/ starter manuscript (copy per new paper — see EXAMPLE.md)
sample/            demo manuscript the server opens by default
```
