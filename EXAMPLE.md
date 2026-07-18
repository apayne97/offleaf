# Worked Example: a new paper from zero to compiled PDF

Follow along literally; the whole thing takes about three minutes. It uses the
starter template in [`templates/article/`](./templates/article/) — a clean
`main.tex` + `refs.bib` pair with sensible packages, one equation, a citation,
and commented-out figure boilerplate.

## 1. Create the paper folder from the template

In Terminal:

```bash
mkdir -p ~/papers
cp -r /path/to/offleaf/templates/article ~/papers/demo-paper
```

You now have:

```
~/papers/demo-paper/
├── main.tex    ← the manuscript (title, abstract, 4 sections)
└── refs.bib    ← one placeholder reference
```

## 2. Start OffLeaf (if it isn't already running)

```bash
cd /path/to/offleaf
npm start
```

Open http://localhost:3000 in your browser.

## 3. Open the folder

Click **📂 Open…** in the toolbar, type:

```
~/papers/demo-paper
```

and press **Open in new tab**. A new tab appears with `demo-paper` in the
toolbar, `main.tex` open, and an empty PDF pane.

## 4. First compile

Press **⌘S**. After a few seconds the status pill turns **success** and the
PDF appears on the right: title, abstract, numbered equation, and a References
section with the placeholder citation. The log panel auto-hides because the
compile is clean.

## 5. Make it yours (a guided edit)

1. On line 12, change `Your Title Here` to a real title. Watch the **Visual**
   toggle — the rendered view shows your title as a centered heading.
2. Press **⌘S** again. The PDF updates in place, keeping your scroll position.
3. Select the abstract paragraph with the mouse → the status bar shows a live
   word count for just that selection.
4. Click **Words** → per-section counts (Introduction / Methods / Results /
   Discussion), straight from `texcount`.
5. Type `\fig` on an empty line and accept the `figure` completion — a full
   figure block with `\includegraphics`, `\caption`, and `\label` is inserted
   with tab-stops. (Undo with ⌘Z if you don't want it yet.)
6. Add a reference: open `refs.bib` from the file list, duplicate the entry,
   change the key to `smith2025`. Back in `main.tex`, type `\citep{` — both
   keys are offered in the autocomplete.
7. **⌘-click** anywhere in the PDF — the editor jumps to the matching source
   line. Cursor somewhere interesting → **⟶ PDF** jumps the other way.
8. Click **🔊 Read Aloud → ▶ Play** and listen to the abstract while the
   spoken sentence highlights in the Visual view and the editor follows along.

## 6. Where things live afterwards

- Your writing: `~/papers/demo-paper/main.tex` and `refs.bib` — plain files,
  autosaved as you type. `git init` the folder if you want history; upload it
  to Overleaf someday if you want — it's a completely ordinary LaTeX project.
- The output: `~/papers/demo-paper/.build/main.pdf` (also the ⤓ Download
  button in the PDF toolbar). The `.build/` folder is disposable — "⟳ From
  scratch" recreates it.

## Reusing the template

Every new paper is just:

```bash
cp -r /path/to/offleaf/templates/article ~/papers/NEW-NAME
```

then 📂 Open… → `~/papers/NEW-NAME`. Add your own variants (a REVTeX
skeleton, a thesis chapter, a beamer deck) next to `templates/article/` and
copy whichever fits.
