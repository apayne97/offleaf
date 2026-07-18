/**
 * CodeMirror 6 source editor — the same editor family Overleaf uses. Exposes an
 * imperative handle so the PDF pane can scroll the editor to a line (SyncTeX
 * inverse search), and reports selection + cursor changes up to <App/> for the
 * live word count. Compile diagnostics from the log panel surface here as
 * squiggles + gutter markers, and the usual Overleaf keys work:
 *   Cmd/Ctrl+S or Cmd/Ctrl+Enter  save & recompile
 *   Cmd/Ctrl+/                    toggle % comment
 *   Cmd/Ctrl+B / Cmd/Ctrl+I       \textbf{} / \textit{} around the selection
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorState, Compartment, EditorSelection } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import {
  bracketMatching,
  indentOnInput,
  foldGutter,
  foldKeymap,
  syntaxHighlighting,
  defaultHighlightStyle,
} from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { setDiagnostics, lintGutter, type Diagnostic } from "@codemirror/lint";
import { oneDark } from "@codemirror/theme-one-dark";
import { latexSupport, latexAutocomplete } from "./latex";

export interface EditorHandle {
  scrollToLine(line: number): void;
  /** Scroll a line into view WITHOUT moving the cursor or taking focus
   * (used by Read-Aloud follow-along so it never interrupts typing). */
  revealLine(line: number): void;
  getSelectionText(): string;
}

export interface EditorDiagnostic {
  line: number;
  severity: "error" | "warning";
  message: string;
}

interface EditorProps {
  path: string;
  content: string;
  theme: "dark" | "light";
  diagnostics: EditorDiagnostic[];
  onChange(value: string): void;
  onSelectionChange(selectedText: string): void;
  onCursorChange(line: number, col: number): void;
  onRequestCompile(): void;
  getKeys(): { labels: string[]; cites: string[] };
}

/** Wrap the current selection (or word) in \cmd{...}. */
function wrapCommand(cmd: string) {
  return (view: EditorView): boolean => {
    const changes = view.state.changeByRange((range) => {
      const text = view.state.sliceDoc(range.from, range.to);
      const insert = `\\${cmd}{${text}}`;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: text
          ? EditorSelection.range(range.from, range.from + insert.length)
          : EditorSelection.cursor(range.from + cmd.length + 2),
      };
    });
    view.dispatch(changes);
    return true;
  };
}

const lightTheme = [
  EditorView.theme({}, { dark: false }),
  syntaxHighlighting(defaultHighlightStyle),
];

const Editor = forwardRef<EditorHandle, EditorProps>(function Editor(props, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const currentPath = useRef<string>(props.path);
  const themeCompartment = useRef(new Compartment());
  const diagnosticsRef = useRef<EditorDiagnostic[]>([]);

  useImperativeHandle(ref, () => ({
    scrollToLine(line: number) {
      const view = viewRef.current;
      if (!view) return;
      const clamped = Math.max(1, Math.min(line, view.state.doc.lines));
      const l = view.state.doc.line(clamped);
      view.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: "center" }) });
      view.focus();
    },
    revealLine(line: number) {
      const view = viewRef.current;
      if (!view) return;
      const clamped = Math.max(1, Math.min(line, view.state.doc.lines));
      const l = view.state.doc.line(clamped);
      view.dispatch({ effects: EditorView.scrollIntoView(l.from, { y: "center" }) });
    },
    getSelectionText() {
      const view = viewRef.current;
      if (!view) return "";
      const { from, to } = view.state.selection.main;
      return view.state.sliceDoc(from, to);
    },
  }));

  // Create the editor once.
  useEffect(() => {
    if (!hostRef.current) return;
    const updateListener = EditorView.updateListener.of((update) => {
      const p = propsRef.current;
      if (update.docChanged) {
        p.onChange(update.state.doc.toString());
      }
      if (update.selectionSet || update.docChanged) {
        const sel = update.state.selection.main;
        p.onSelectionChange(update.state.sliceDoc(sel.from, sel.to));
        const line = update.state.doc.lineAt(sel.head);
        p.onCursorChange(line.number, sel.head - line.from + 1);
      }
    });

    const state = EditorState.create({
      doc: props.content,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        history(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightSelectionMatches(),
        latexSupport(),
        latexAutocomplete(() => propsRef.current.getKeys()),
        lintGutter(),
        EditorView.lineWrapping,
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              propsRef.current.onRequestCompile();
              return true;
            },
          },
          {
            key: "Mod-Enter",
            preventDefault: true,
            run: () => {
              propsRef.current.onRequestCompile();
              return true;
            },
          },
          { key: "Mod-/", run: toggleComment },
          { key: "Mod-b", preventDefault: true, run: wrapCommand("textbf") },
          { key: "Mod-i", preventDefault: true, run: wrapCommand("textit") },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        themeCompartment.current.of(props.theme === "dark" ? oneDark : lightTheme),
        updateListener,
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Theme switch (Overleaf's editor follows the app theme; so does ours).
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeCompartment.current.reconfigure(props.theme === "dark" ? oneDark : lightTheme),
    });
  }, [props.theme]);

  // Push compile diagnostics straight into the lint state (gutter + squiggle).
  useEffect(() => {
    diagnosticsRef.current = props.diagnostics;
    const view = viewRef.current;
    if (!view) return;
    const out: Diagnostic[] = [];
    for (const d of props.diagnostics) {
      if (d.line < 1 || d.line > view.state.doc.lines) continue;
      const l = view.state.doc.line(d.line);
      out.push({ from: l.from, to: l.to, severity: d.severity, message: d.message });
    }
    view.dispatch(setDiagnostics(view.state, out));
  }, [props.diagnostics]);

  // When a different file is opened, replace the document (without clobbering
  // edits to the same file — we only reset when the path actually changes).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (currentPath.current !== props.path) {
      currentPath.current = props.path;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: props.content },
        selection: { anchor: 0 },
      });
    }
  }, [props.path, props.content]);

  return <div className="cm-host" ref={hostRef} />;
});

export default Editor;
