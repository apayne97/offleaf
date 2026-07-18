# OffLeaf — Offline LaTeX IDE
## Design Specification v1.0

**Author:** Prepared for Sukrit Singh
**Date:** 2026-07-11
**Codename:** OffLeaf (Overleaf, but offline)
**Status:** Approved for build (assumptions listed in §12)

---

## 1. Goal & one-line summary

A local-first, offline LaTeX IDE that recreates the parts of Overleaf you rely on for
writing and editing manuscripts — a CodeMirror-based source editor, side-by-side PDF
preview, Overleaf-matching compile defaults, per-section/per-selection word counts, a
"visual" rich-text view, and Word-style text-to-speech — while running entirely on your
own machine with no internet dependency.

The UI runs in the browser. A small local backend (a "terminal backend" you launch from a
shell) drives the LaTeX toolchain and file system. You open `http://localhost:3000`, edit,
hit compile, and see the PDF — on a plane, in a basement, anywhere, with no Overleaf
account and no network.

---

## 2. Why this architecture (and not a pure web app or an Electron clone)

There are three viable ways to build an offline LaTeX editor. This section states the
choice and the reasoning, because the choice cascades into every later decision.

**Chosen: Browser frontend + local Node backend that shells out to a real TeX distribution.**
This is precisely how Overleaf itself is structured (browser CodeMirror 6 front end; server
runs `latexmk` on a TeX Live install), so "the same settings and defaults Overleaf uses"
becomes *literally the same programs with the same flags*, not an approximation. It also
means math-heavy manuscripts, BibTeX/biber bibliographies, journal document classes
(`revtex4-2`, `elsarticle`, `iopart`, etc.), `\input`/`\include` multi-file projects, and
`siunitx`/`mhchem` — the things a biophysics manuscript actually needs — all just work,
because you are running the genuine engine.

**Considered alternative A — pure in-browser WASM compile (SwiftLaTeX / BusyTeX / Tectonic-WASM).**
Engines like [SwiftLaTeX](https://www.swiftlatex.com/) compile pdfTeX/XeTeX to WebAssembly
and run ~2× slower than native but fully client-side, and projects like
[TeXlyre](https://github.com/TeXlyre/texlyre) already ship a local-first browser editor on
this stack. This is attractive for zero-install and phone/tablet use, but (i) the package
set is a curated subset, so exotic journal classes can be missing; (ii) first-use package
fetching needs the network to warm a cache; (iii) SyncTeX and shell-escape support are more
limited. **Decision:** support a WASM engine as an *optional, pluggable* compiler for the
zero-install case, but make the native `latexmk` path the default for full parity.

**Considered alternative B — Electron/Tauri desktop app.** A packaged desktop binary is nicer
to launch, but it is strictly a packaging concern on top of the same frontend+backend split.
**Decision:** build the browser+backend core first; a Tauri wrapper is a later milestone
(§11) that reuses 100% of this code.

---

## 3. Language & technology choice (Requirement #2)

**Everything in TypeScript, one language across the stack.**

| Layer | Choice | Why |
|---|---|---|
| Editor | **CodeMirror 6** | The exact editor Overleaf migrated to — same keybindings model, LaTeX language support, mobile behavior, and extension API ([Overleaf's announcement](https://www.overleaf.com/blog/towards-the-future-a-new-source-editor)). |
| Frontend framework | **React + Vite** | Fast dev server/HMR, trivial static build for offline serving, huge ecosystem for split-pane/PDF components. |
| PDF preview | **PDF.js** (`pdfjs-dist`) | Mozilla's renderer; the de-facto standard, renders locally, exposes text/coordinate layers needed for SyncTeX and TTS highlighting. |
| Backend | **Node.js + Fastify** | Same language as the frontend (shared TypeScript types for the API contract), excellent child-process and streaming support to drive `latexmk`, first-class WebSocket. |
| Live channel | **WebSocket (`ws`)** | Streams compile logs and status to the UI the way Overleaf streams its build output. |
| LaTeX engine (default) | **`latexmk` on TeX Live / MacTeX** | Overleaf's own build driver; running it locally gives byte-for-byte the same defaults. |
| LaTeX engine (portable) | **Tectonic** (optional) | [Self-contained, embeddable engine](https://github.com/tectonic-typesetting/tectonic); auto-fetches packages then caches for offline, ideal for "on the go" without a full TeX install. |
| Word count | **`texcount`** (ships with TeX Live) | The standard LaTeX-aware counter; `-sub` yields [per-section subcounts](https://docs.overleaf.com/writing-and-editing/using-word-count). |
| TTS | **Web Speech API `SpeechSynthesis`** | Built into the browser, uses local OS voices (`localService: true`) so it works offline, and its [`boundary` event](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisUtterance/boundary_event) drives word-by-word highlighting like Word's Read Aloud. |

**Why TypeScript over a Python (FastAPI) backend:** the frontend *must* be JS/TS (browser),
and the backend is mostly process-orchestration and file I/O — not numerical code — so a
second language buys nothing and costs a serialization boundary. One language means the
request/response and WebSocket message shapes live in a single shared `packages/shared`
module, imported by both sides, so the API can't silently drift.

---

## 4. System architecture

```
┌───────────────────────────────────────────────────────────────┐
│  Browser (http://localhost:3000)                               │
│                                                                │
│  ┌───────────┐  ┌────────────────┐  ┌──────────────────────┐  │
│  │ File tree │  │  Editor pane   │  │   Preview pane       │  │
│  │           │  │  ┌──────────┐  │  │  ┌────────────────┐  │  │
│  │ project/  │  │  │CodeMirror│  │  │  │ PDF.js (PDF)   │  │  │
│  │  main.tex │  │  │   6      │  │  │  │      —or—      │  │  │
│  │  refs.bib │  │  │ (source) │  │  │  │ Visual view    │  │  │
│  │  figs/    │  │  └──────────┘  │  │  └────────────────┘  │  │
│  └───────────┘  │  Visual toggle │  │  SyncTeX ↔ Word count│  │
│                 └────────────────┘  └──────────────────────┘  │
│         │                │                     │              │
└─────────┼────────────────┼─────────────────────┼──────────────┘
          │ REST (files)   │ WebSocket (compile)  │ REST (pdf/count)
┌─────────┼────────────────┼─────────────────────┼──────────────┐
│  Local Node/Fastify backend  (you launch: `offleaf ./my-paper`)│
│                                                                │
│  FileService   CompileService   CountService   SyncTeXService  │
│      │              │                │              │          │
│   fs (project)   latexmk│tectonic  texcount     .synctex.gz    │
│      │              │                                          │
│      └──────────────┴──────► local TeX Live / MacTeX ◄─────────┘
└───────────────────────────────────────────────────────────────┘
```

**Runtime model.** A single command (`offleaf ./path-to-project` or `npm run dev`) starts
the backend, which serves the built frontend as static files *and* exposes the API on the
same origin — so there is no CORS and no cloud. The backend's "project root" is a plain
folder on disk; every file operation is confined to it (path-traversal guarded).

---

## 5. Feature specification

### 5.1 Overleaf-like editing (Requirement #4.1) — **P0**
- CodeMirror 6 with LaTeX syntax highlighting, bracket matching, autocompletion of
  commands/environments/`\ref`/`\cite` keys (from parsed `.bib`), and snippets.
- Multi-file projects with a file tree; `\input`/`\include`/`\subfile` aware.
- Autosave to disk (debounced) + explicit save; local undo history.
- Keymap presets: Default, Vim, Emacs (CodeMirror 6 built-ins), matching Overleaf's options.
- Find/replace, go-to-line, comment toggling, wrap-at-column, spellcheck (browser-native).

### 5.2 Overleaf-matching compile settings & defaults (Requirement #4.2) — **P0**
- **Default compiler: pdfLaTeX via `latexmk`**, matching Overleaf's default.
- Selectable engines: pdfLaTeX, XeLaTeX, LuaLaTeX (Overleaf's set), driven through `latexmk`
  `-pdf`/`-xelatex`/`-lualatex`.
- Overleaf-equivalent flags baked into the default invocation:
  `latexmk -pdf -interaction=nonstopmode -file-line-error -synctex=1 -halt-on-error=0`
  (nonstop, file:line errors, SyncTeX on — the same behavior Overleaf exposes).
- Bibliography: automatic BibTeX/biber selection via `latexmk` (detects `\bibliography` vs
  `biblatex`), multi-pass until references/labels converge — again, `latexmk`'s job.
- A generated `latexmkrc` mirroring Overleaf's helper rules (glossaries, nomenclature,
  `-shell-escape` opt-in, output to a `.build/` dir). Users can override with their own
  `latexmkrc` in the project, exactly like Overleaf's [`latexmkrc` support](https://docs.overleaf.com/managing-projects-and-files/the-latexmkrc-file).
- TeX Live version is whatever is installed locally; the UI surfaces it (Overleaf pins
  [TeX Live 2025](https://www.overleaf.com/blog/tex-live-2025-is-now-available); we display
  the local equivalent so behavior is predictable).
- "Recompile", "Recompile from scratch" (clean aux), and stop-compile controls.
- Structured error/warning panel parsed from the log (file, line, message) with
  click-to-jump into the editor — the Overleaf log experience.

### 5.3 Compilation + PDF preview alongside code (Requirement #4.3) — **P0**
- Split layout: **source left, PDF right** (resizable, collapsible, swappable).
- PDF.js continuous scroll, zoom/fit, page nav, text selection, in-PDF search.
- **SyncTeX both directions:** ⌘-click in the editor jumps to the PDF location; ⌘-click in
  the PDF jumps to the source line (parsed from the `-synctex=1` output).
- Compile-on-save (debounced) or manual; live log streamed over WebSocket with a progress
  state (queued → running → success/error).

### 5.4 Visual view beside code view (Requirement #4.4) — **P1**
A "Visual" mode presenting a rendered, semi-WYSIWYG view of the manuscript next to the
source, analogous to Overleaf's Visual Editor / a LyX-style rich view.
- **Approach:** parse the LaTeX (unified/`unified-latex` AST) and render a styled HTML
  representation — headings, emphasis, lists, figures (as placeholders/thumbnails), tables,
  and **math rendered with KaTeX/MathJax**. Source ↔ visual selections are position-mapped
  via the AST so clicking in one scrolls the other.
- **Scope is explicit (see §12 limitations):** this is a *readable structural preview with
  live math*, not a full round-trip WYSIWYG editor. Editing happens in source; the visual
  view is primarily for reading/navigating and for the TTS reading order. A later milestone
  can add lightweight inline editing of plain-text runs.

### 5.5 Word counts — document, section, and selection (Requirement #4.5) — **P0**
- **Whole-document & per-section counts** via `texcount -sub -brief` on the real source
  (LaTeX-aware: ignores commands, separates body vs. headers vs. captions vs. display math),
  shown in a panel and refreshed on compile/save.
- **Selection count (the headline feature):** highlight any text in the editor or visual
  view and get a live count of words/characters for *just that selection*, with LaTeX markup
  stripped so `\textbf{foo}` counts as one word. Implemented client-side for instant feedback
  and reconciled against `texcount` for accuracy.
- Counts broken out as: words in text, words in headers, words in captions, number of
  display-math instances, floats — the `texcount` breakdown.

### 5.6 Text-to-speech / "Read Aloud" (Requirement #5) — **P1**
A Word-style Read Aloud panel that speaks the manuscript and highlights along.
- Uses `SpeechSynthesis`; filters `getVoices()` to `localService === true` so it is fully
  offline; voice, rate, and pitch pickers.
- **Reading source is the "visual"/extracted plain text**, not raw LaTeX — the AST from §5.4
  is linearized into clean prose (drop preamble, expand `\section` to spoken headings,
  read figure captions, skip or verbalize math per a toggle: "skip equations" /
  "say 'equation'" / naive TeX-to-speech).
- **Karaoke highlighting** via the `boundary` event: the current word/sentence is highlighted
  in the visual view as it is spoken, and the view auto-scrolls.
- Controls: play/pause/stop, skip sentence/section, "read from cursor", "read selection".
- Optional export of the extracted narration text.

### 5.7 Supporting features — **P1/P2**
- Project open/close/switch; recent projects; "New from template" (article, REVTeX, Elsevier,
  beamer, thesis).
- Git-optional: if the project folder is a git repo, show status and allow commit (P2).
- Settings persisted locally (editor theme, keymap, compiler, auto-compile, TTS voice).
- Export: the compiled PDF and a `.zip` of the project.
- Dark/light themes matching a VS Code look.

---

## 6. API & WebSocket contract (shared TypeScript types)

REST (all under `/api`, same-origin):
- `GET  /api/project` → project tree + metadata (main file, engine, TeX Live version).
- `GET  /api/file?path=` → file contents. `PUT /api/file` → save. `POST /api/file` → create.
  `DELETE /api/file`. `POST /api/rename`.
- `POST /api/compile` `{ engine, mainFile, cleanBuild }` → `{ jobId }`.
- `GET  /api/pdf?jobId=` → compiled PDF bytes (streamed).
- `GET  /api/synctex/forward?file=&line=&col=` → `{ page, x, y }`.
- `GET  /api/synctex/inverse?page=&x=&y=` → `{ file, line }`.
- `POST /api/wordcount` `{ path | text, mode: 'doc'|'section'|'selection' }` → counts.
- `GET  /api/tts/extract?path=` → linearized narration text + source position map.

WebSocket `/ws`:
- server → client: `{type:'compile:status', jobId, state}`, `{type:'compile:log', line}`,
  `{type:'compile:done', success, errors[], warnings[], pdfUrl, synctexReady}`,
  `{type:'file:changed', path}` (external edits / watcher).

All message and payload shapes are defined once in `packages/shared/src/protocol.ts` and
imported by both server and client.

---

## 7. Data & project model

A project is just a directory. No database. State that must persist (settings, recent
projects, per-project compiler choice) lives in a small JSON file under the OS config dir
(`~/.config/offleaf/`) and an optional `.offleaf.json` inside the project. This keeps
everything portable, inspectable, and git-friendly — a manuscript folder remains a normal
LaTeX project you could also open in Overleaf or VS Code.

---

## 8. Offline strategy (the whole point)

- Frontend is built to static assets and served by the backend — **no CDN at runtime**.
  PDF.js, KaTeX fonts, and all JS are bundled locally.
- Default compile path uses the **local** TeX distribution — no network.
- TTS uses **local OS voices** (filtered by `localService`).
- Optional Tectonic engine caches packages after first use for genuinely install-free offline
  work; the WASM engine (future) needs a one-time online cache warm, then runs offline.
- The only thing that needs the internet is *first-time installation* of Node deps and (if
  chosen) a TeX distribution — documented in the README as prerequisites.

---

## 9. Security & safety

- Backend binds to `127.0.0.1` only; not exposed to the network.
- Every file path is resolved and confined to the project root (path-traversal rejection).
- `-shell-escape` is **off by default** (it lets `.tex` run arbitrary shell commands) and is
  an explicit per-project opt-in with a warning — mirroring Overleaf's cautious default.
- Compile jobs run with a timeout and are killable; output is confined to `.build/`.

---

## 10. Repository layout

```
offline-latex-editor/
├── DESIGN_SPEC.md            ← this file
├── README.md                 ← quickstart, prerequisites
├── package.json              ← npm workspaces root
├── packages/
│   └── shared/               ← shared TS types (API + WS protocol)
├── server/                   ← Fastify backend
│   ├── src/
│   │   ├── index.ts          ← server bootstrap + static serving
│   │   ├── services/
│   │   │   ├── files.ts      ← project FS CRUD (sandboxed)
│   │   │   ├── compile.ts    ← latexmk/tectonic driver + log parse
│   │   │   ├── synctex.ts    ← forward/inverse search
│   │   │   └── wordcount.ts  ← texcount wrapper + selection counter
│   │   └── ws.ts             ← WebSocket hub
│   └── test/                 ← compiles the sample project end-to-end
├── client/                   ← React + Vite frontend
│   ├── src/
│   │   ├── App.tsx           ← three-pane layout
│   │   ├── editor/           ← CodeMirror 6 setup + LaTeX lang
│   │   ├── preview/          ← PDF.js viewer + SyncTeX glue
│   │   ├── visual/           ← AST → HTML + KaTeX rich view
│   │   ├── tts/              ← SpeechSynthesis read-aloud
│   │   └── wordcount/        ← selection + section count UI
│   └── vite.config.ts
└── sample/                   ← a real math-heavy manuscript for testing
    ├── main.tex
    └── refs.bib
```

---

## 11. Milestones

- **M0 — Scaffold & contract (this session):** monorepo, shared protocol, sample project.
- **M1 — Compile core (this session):** backend compiles the sample via `latexmk` with
  Overleaf flags; PDF served; word counts via `texcount`; verified in-sandbox.
- **M2 — Editor + preview (this session):** CodeMirror 6 editor, PDF.js side-by-side,
  compile button + streamed log, selection word count. Client builds cleanly.
- **M3 — SyncTeX + section counts + polish:** both-direction sync, section count panel,
  error panel with jump-to-line, settings.
- **M4 — Visual view:** AST render with KaTeX, source↔visual mapping.
- **M5 — TTS Read Aloud:** extraction, offline voices, karaoke highlighting.
- **M6 — Packaging:** Tauri/Electron wrapper, `offleaf` CLI, optional Tectonic/WASM engine.

M0–M2 are targeted for this build session; M3–M6 are structured so each is an isolated,
addable module.

---

## 12. Assumptions, limitations, and workarounds

Per your working style, stated explicitly.

**Assumptions**
1. **A local TeX distribution exists** (MacTeX/TeX Live) on the machine that runs the
   backend, providing `latexmk`, `pdflatex`, `biber`, and `texcount`. *Why it matters:* the
   default compile path depends on it. *Workaround:* ship the pluggable **Tectonic** engine
   (self-contained) and document a WASM fallback for machines without TeX Live.
2. **"On the go" means a laptop, not a phone,** for the default path (a full TeX install on a
   phone is impractical). *Why it matters:* it justifies the native-engine default.
   *Workaround:* the WASM engine (M6) is the phone/tablet story; the frontend already runs in
   mobile browsers thanks to CodeMirror 6.
3. **Single-user, single-machine, no real-time collaboration.** *Why it matters:* it removes
   Overleaf's hardest subsystem (OT/CRDT sync) and lets us stay database-free. *Workaround:*
   git integration (M-later) covers versioning; CRDT collab is out of scope by design.
4. **The visual view is a structural + math preview, not full round-trip WYSIWYG.** *Why it
   matters:* true bidirectional WYSIWYG LaTeX is a multi-year problem (LyX, Overleaf's Visual
   Editor both constrain it). *Workaround:* editing stays in source; the visual view targets
   reading, navigation, and TTS order, which is what Requirement #4.4 and #5 actually need.

**Limitations & why they may bite**
- **`texcount` vs. client-side selection count can disagree** on tricky macros; the
  client count is a fast estimate and `texcount` is the source of truth — the UI labels which
  is which so a manuscript word count reported to a journal is always the `texcount` figure.
- **SyncTeX accuracy degrades** with heavy macro expansion or `\input` nesting; this is
  inherent to SyncTeX, not our bug. We surface a "closest match" and never hard-fail.
- **TTS voice quality/coverage varies by OS.** macOS local voices are good and offline;
  some platforms expose only cloud voices (which we exclude for offline correctness), so the
  voice list can be short on non-mac systems — documented, with a note to install OS voices.
- **Math-to-speech is naive** ("skip" or "say equation" by default). Full spoken math
  (MathML → SSML) is a research problem; a later milestone can integrate a MathML narrator.
- **Engine parity is "same programs," not "same versions"** unless the local TeX Live matches
  Overleaf's pinned year. We display the local version so differences are never silent.

---

## 13. Success criteria

1. Launch backend, open browser, edit `sample/main.tex`, hit compile, see the PDF beside the
   source — offline. ✅ testable this session.
2. Highlight a paragraph → correct word count for the selection. ✅
3. Section-by-section word counts match `texcount -sub`. ✅
4. ⌘-click source ↔ PDF jumps to the right place (SyncTeX). (M3)
5. Toggle Visual view → headings/math render; toggle Read Aloud → it speaks offline and
   highlights along. (M4–M5)

---

*Primary sources cited inline: Overleaf on [CodeMirror 6](https://www.overleaf.com/blog/towards-the-future-a-new-source-editor),
[choosing a compiler](https://www.overleaf.com/learn/latex/Choosing_a_LaTeX_Compiler),
[TeX Live 2025](https://www.overleaf.com/blog/tex-live-2025-is-now-available),
[latexmkrc](https://docs.overleaf.com/managing-projects-and-files/the-latexmkrc-file),
[word count](https://docs.overleaf.com/writing-and-editing/using-word-count);
[Tectonic](https://github.com/tectonic-typesetting/tectonic);
[SwiftLaTeX](https://www.swiftlatex.com/) & [TeXlyre](https://github.com/TeXlyre/texlyre);
[Web Speech `boundary` event](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisUtterance/boundary_event).*
