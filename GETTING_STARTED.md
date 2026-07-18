# Getting Started with OffLeaf (the zero-assumed-knowledge guide)

This is the "just tell me what to type" version. It assumes nothing except a
Mac and a Terminal. Every step says what to type, and what you should see if
it worked. (Deeper docs: [INSTALL.md](./INSTALL.md) for install details,
[USAGE.md](./USAGE.md) for every feature, [EXAMPLE.md](./EXAMPLE.md) for a
worked example, [ARCHITECTURE.md](./ARCHITECTURE.md) for how it works inside.)

**What OffLeaf is:** Overleaf, but running entirely on your own computer with
no internet. You edit LaTeX in a browser window; a small program on your Mac
does the compiling with a real TeX installation.

---

## Part 1 — One-time setup (~10 minutes, needs internet ONCE)

Open **Terminal** (press ⌘-Space, type `terminal`, press Enter). Paste each
command and press Enter.

### Step 1. Check for Node.js

```bash
node --version
```

- **See something like `v20.1.0` or higher?** → Skip to Step 2.
- **See `command not found` or a version below 20?** → Install it:
  ```bash
  brew install node
  ```
  (If `brew` is also not found, install Homebrew first from https://brew.sh —
  one copy-paste command — then rerun `brew install node`.)

### Step 2. Check for LaTeX

```bash
latexmk --version
```

- **See a version line?** → Skip to Step 3.
- **See `command not found`?** → Install MacTeX (this is the big one, ~5 GB,
  grab a coffee):
  ```bash
  brew install --cask mactex
  ```
  Then **close Terminal completely and open a new one** (this matters — the
  new tools aren't visible to old windows), and check `latexmk --version`
  works now.

### Step 3. Install OffLeaf

```bash
cd /path/to/offleaf    # wherever this folder lives
npm install
npm run build
```

`npm install` prints a lot; that's normal. It should end without the word
"error".

### Step 4. Make sure everything works

```bash
npm test
```

This runs 93 automated checks, including a real LaTeX compile. The last line
should say **ALL HIDPI TESTS PASSED** and every line should start with PASS.
If so: you're done installing. Everything from here on works offline.

---

## Part 2 — Daily use (this is all you need to remember)

### Start OffLeaf

```bash
cd /path/to/offleaf
npm start
```

You'll see:

```
  OffLeaf backend running
  Project : .../sample
  TeX     : TeX Live 2024
  URL     : http://127.0.0.1:3000
```

Open **http://localhost:3000** in your browser. That's the IDE.

### Stop OffLeaf

Go to the Terminal window where it's running and press **Ctrl-C**. (Closing
the browser tab does NOT stop it; closing the Terminal does.)

### Open YOUR paper (instead of the sample)

Click the **📂 Open…** button in the toolbar, type the folder where your
`.tex` files live (for example `~/papers/my-manuscript`), press
**Open in new tab**. Done — that tab now edits that folder. Recent folders
are listed in the same dialog so next time it's one click.

Starting a paper from nothing? See [EXAMPLE.md](./EXAMPLE.md) — it walks
through creating one from the included template in two commands.

### The screen, left to right

1. **File list** — click a file to open it.
2. **Middle pane** — your LaTeX source. The `Code / Visual` toggle (top right)
   switches it to a formatted, read-only view of the text.
3. **PDF** — always visible on the right. Updates when you compile.

### The five things you'll actually do

| I want to… | Do this |
|---|---|
| Compile and see the PDF | Press **⌘S** (or click ▶ Recompile) |
| Fix an error | It's listed in the log panel at the bottom — click it to jump to the line |
| Count words | Bottom bar shows the total; select text for a selection count; **Words** button for per-section |
| Jump between code and PDF | **⌘-click** in the PDF → source line; **⟶ PDF** button → PDF spot |
| Have it read to me | **🔊 Read Aloud** → ▶ Play (or "From cursor"). Voice/speed/volume are in the panel |

That's genuinely it. Everything else is discoverable from the toolbar.

---

## When something goes wrong

| Symptom | Fix |
|---|---|
| `command not found: npm` or `node` | Node isn't installed or Terminal is old — Step 1, then open a NEW Terminal |
| Toolbar says TeX "unknown" / compile fails instantly | LaTeX isn't on the PATH — Step 2, new Terminal, restart `npm start` |
| Browser says "can't connect to localhost:3000" | The backend isn't running — run `npm start` |
| "Port 3000 already in use" | OffLeaf (or something else) is already running. Find it: `lsof -i :3000` — or run on another port: `OFFLEAF_PORT=3100 npm start` |
| Compile hangs | Click ⏹ Stop, check the log panel for the error |
| PDF pane empty | You haven't compiled yet in this session — press ⌘S |
| Word count says "estimate" | `texcount` is missing (BasicTeX users): `sudo tlmgr install texcount` |
| Read Aloud voice sounds robotic | That's macOS's compact voice. Download a better one: System Settings → Accessibility → Spoken Content → System Voice → Manage Voices… → pick an "Enhanced"/"Premium"/Siri voice |
| Moving to a new (Apple Silicon) Mac | Copy the folder WITHOUT `node_modules`, then `npm install && npm run build` there ([INSTALL.md §3](./INSTALL.md)) |
