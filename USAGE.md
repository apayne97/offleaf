# Running OffLeaf

Assumes installation is done ([INSTALL.md](./INSTALL.md)).

## Start the IDE

```bash
cd offleaf
npm start
# → open http://localhost:3000
```

With no arguments this reopens whatever project you had open most recently
(the same list the 📂 Open… dialog's "Recent" section uses); with no history
yet, it falls back to the bundled `sample/` manuscript. The server binds to
127.0.0.1 only — nothing is reachable from the network.

## Working directories: opening YOUR paper

A "project" is just a folder on disk containing your `.tex`/`.bib` files.
There are three ways to point OffLeaf at one:

### 1. From the UI (recommended) — the 📂 Open… button

Click **📂 Open…** in the toolbar, type a folder path (e.g.
`~/papers/my-manuscript` — `~` works), and hit **Open in new tab**. The folder
opens in its **own browser tab**, pinned to it by the `?p=<id>` in the URL.
Recently opened folders are listed in the same dialog for one-click reopening.

You can have several tabs on several folders at once against the one backend —
compiles, word counts, and PDFs are fully independent per tab.

### 2. At launch, as an argument

```bash
npm start -- ~/papers/my-manuscript
# or equivalently
node server/dist/index.js ~/papers/my-manuscript
```

### 3. Via an environment variable

```bash
OFFLEAF_PROJECT=~/papers/my-manuscript npm start
```

Methods 2 and 3 set the *default* project (the one a bare
http://localhost:3000 shows); the 📂 Open… dialog can still open more folders
in more tabs on top of that.

Everything you edit is saved directly into the folder — it stays a normal
LaTeX project you can also open in Overleaf, VS Code, or git.

**Main file detection:** OffLeaf compiles `main.tex` if present, otherwise the
first `.tex` file containing `\documentclass`.

## The three panes

```
[ file tree   | Code ⇄ Visual | PDF preview ]
[ outline     |               |             ]
```

The **Outline** panel (below the file tree) lists every \section /
\subsection / \subsubsection in the open file. Click one to jump the editor
there; the section your cursor is in stays highlighted.

- The **PDF is always on the right** and updates in place after every
  compile (scroll position preserved). Text in the preview is **selectable**
  — drag to highlight, ⌘C to copy, at any zoom.
- The middle pane toggles between **Code** (CodeMirror editor) and **Visual**
  (rendered, read-only view with live KaTeX math) via the toolbar toggle.
  In Visual, click any paragraph/heading to jump the editor to that source
  line; the Visual view follows your editor cursor with a dashed outline.

## Compiling

| Action | How |
|---|---|
| Save & compile | **⌘S** or **⌘↵** (or the ▶ Recompile button) |
| Clean rebuild | ⟳ From scratch (clears aux files first) |
| Stop a stuck compile | ⏹ Stop (appears while compiling) |
| Switch engine | toolbar dropdown: pdfLaTeX (default, Overleaf's default) / XeLaTeX / LuaLaTeX |

Errors/warnings appear in the log panel (click one to jump to the line) and as
red/yellow markers in the editor gutter. The exact recipe is Overleaf's:
`latexmk -pdf -interaction=nonstopmode -file-line-error -synctex=1 -outdir=.build`.
Build artifacts live in `.build/` inside your project; the source tree stays clean.

## SyncTeX (jumping between code and PDF)

- **Code → PDF:** put the cursor somewhere, press **⟶ PDF** in the toolbar.
- **PDF → code:** **⌘-click** (or Ctrl-click) anywhere in the PDF.

## Word counts

- Status bar always shows the document word count (via `texcount`).
- **Select text** → the status bar switches to a live, LaTeX-aware count of
  just the selection.
- **Words** button → panel with the full texcount breakdown (text/headers/
  captions/math) **and per-section counts**.

## Read Aloud (text-to-speech)

Click **🔊 Read Aloud**. Controls:

| Setting | What it does |
|---|---|
| Voice | Any OS voice; offline ("local") voices shown by default |
| Show all voices | Also lists network voices (marked "(online)") |
| 🔈 Preview voice | Speaks one sample sentence with current settings |
| Speed | 0.5×–2× |
| Pitch | 0.5–1.5 |
| Volume | 0–100% |
| Math | Skip equations / say "equation" / read naively |
| Follow along in the editor | Scrolls the source with the narration |

Playback: ▶ Play (from the top), ▶ From cursor, ⏮/⏭ sentence skip,
pause/resume/stop. Double-click any sentence in the Visual view to start
reading from there. The sentence being spoken is highlighted karaoke-style.
Settings persist between sessions.

**Better voices:** quality comes from macOS, not OffLeaf. Download
Enhanced/Premium/Siri voices under System Settings → Accessibility → Spoken
Content → System Voice → Manage Voices… — they show up in the picker
automatically. (The default "Samantha" is macOS's compact built-in voice;
the Enhanced/Premium downloads of e.g. Ava, Zoe, or Siri voices sound far
more natural.)

## Keyboard shortcuts (editor)

| Keys | Action |
|---|---|
| ⌘S / ⌘↵ | Save & compile |
| ⌘/ | Toggle `%` comment |
| ⌘B / ⌘I | `\textbf{…}` / `\textit{…}` around selection |
| ⌘F | Find / replace |
| Type `\begin{…` | Environment completion auto-inserts `\end{…}` |
| Type `\figure`, `\table`, `\equation`, `\itemize` | Snippet templates |

## Other daily-use notes

- **Autosave**: edits save to disk 0.6 s after you stop typing.
- **Theme**: ☾/☀ toggles dark/light (editor included).
- **Download PDF**: button in the PDF toolbar.
- Stop the server with Ctrl-C in its terminal; restart any time — state lives
  in your project folder and `~/.config/offleaf/` (recent projects list).
