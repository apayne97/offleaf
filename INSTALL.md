# Installing OffLeaf

One-time setup. After this, everything works fully offline — see
[USAGE.md](./USAGE.md) for day-to-day running.

## 1. Prerequisites

### Node.js 20 or newer

```bash
# macOS (Homebrew)
brew install node
node --version   # should print v20.x or newer
```

### A TeX distribution (for compiling and word counts)

macOS options, biggest to smallest:

```bash
brew install --cask mactex        # full MacTeX (~5 GB) — everything included
brew install --cask basictex      # minimal (~100 MB) — add packages as needed
```

OffLeaf uses `latexmk`, `pdflatex`/`xelatex`/`lualatex`, `bibtex`/`biber`,
`synctex`, and `texcount` — all included in full MacTeX. With BasicTeX, add
the extras once:

```bash
sudo tlmgr update --self
sudo tlmgr install latexmk texcount
```

After installing, open a **new terminal** so the TeX binaries are on your PATH
(`which latexmk` should print a path). If OffLeaf's toolbar says
"unknown" for the TeX distribution, PATH is the first thing to check.

### Text-to-speech

Nothing to install — Read Aloud uses your operating system's built-in voices
through the browser. To get much nicer voices than the default, download them
in **System Settings → Accessibility → Spoken Content → System Voice →
Manage Voices…** (pick ones labelled "Enhanced" or "Premium", or Siri voices).
They appear in OffLeaf's voice picker automatically.

## 2. Install OffLeaf itself

```bash
cd offleaf     # this repository
npm install                          # installs all workspaces
npm run build                        # builds shared types, client UI, server
```

That's it. `npm start` now serves the whole IDE at http://localhost:3000
(see [USAGE.md](./USAGE.md)).

## 3. Apple Silicon (M1/M2/M3/M4) notes

OffLeaf works on ARM Macs **without any code changes**, because:

- the app itself (server + UI) is pure JavaScript/TypeScript;
- the only platform-specific pieces (`esbuild`, `rollup` build binaries) are
  chosen automatically **at install time** for your CPU;
- MacTeX/TeX Live ships universal binaries (the install directory is literally
  `universal-darwin`, containing x86_64 + arm64 in each executable);
- text-to-speech uses macOS voices, which are native on Apple Silicon.

The one rule: **do a clean install on the ARM machine — never copy
`node_modules` from an Intel Mac.** The build binaries inside it are
CPU-specific.

```bash
# on the Apple Silicon laptop
git clone <this-repo> && cd offleaf   # or copy WITHOUT node_modules
rm -rf node_modules */node_modules packages/*/node_modules  # if they came along anyway
npm install
npm run build
npm start
```

Install Node via Homebrew on the ARM machine (it lives in `/opt/homebrew`
there instead of `/usr/local` — irrelevant to OffLeaf, just be aware for PATH).

## 4. Verify the installation

```bash
npm test
```

This runs the full suite — 93 checks: backend unit tests (path security, log
and word-count parsing), HTTP API integration tests, a real end-to-end latexmk
compile of a bundled fixture (PDF, SyncTeX, word counts, TTS extraction), and
the client-side parser tests. Every line should say PASS.
