/**
 * LaTeX language support + autocompletion for the CodeMirror 6 editor.
 *
 * Highlighting uses the maintained `stex` stream mode from @codemirror/legacy-modes
 * (the same TeX/LaTeX grammar shipped with CodeMirror). Completion offers common
 * commands and environments, plus \ref/\cite keys harvested from the project.
 */
import { StreamLanguage } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import {
  autocompletion,
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export const latexLanguage = StreamLanguage.define(stex);

/** Language + language data (comment toggling with %) as one extension. */
export function latexSupport(): Extension {
  return [latexLanguage, latexLanguage.data.of({ commentTokens: { line: "%" } })];
}

const COMMANDS = [
  "section", "subsection", "subsubsection", "paragraph", "chapter",
  "textbf", "textit", "emph", "underline", "texttt", "textsc",
  "begin", "end", "item", "label", "ref", "eqref", "pageref", "cite", "citep", "citet",
  "footnote", "caption", "includegraphics", "usepackage", "documentclass",
  "frac", "sqrt", "sum", "int", "prod", "lim", "infty", "partial", "nabla",
  "alpha", "beta", "gamma", "delta", "epsilon", "theta", "lambda", "mu", "pi", "sigma", "omega",
  "left", "right", "mathrm", "mathbf", "mathcal", "text", "bibliography", "bibliographystyle",
];

const ENVIRONMENTS = [
  "equation", "align", "gather", "multline", "eqnarray",
  "itemize", "enumerate", "description",
  "figure", "table", "tabular", "center", "quote", "abstract",
  "theorem", "proof", "lemma", "definition", "matrix", "bmatrix", "pmatrix", "cases",
];

/**
 * Completing `\begin{env` inserts the matching `\end{env}` too (with the
 * cursor left on the blank line in between), like Overleaf's editor.
 */
function envCompletion(env: string): Completion {
  return {
    label: env,
    type: "class",
    apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
      // Swallow an auto-closed "}" right after the cursor, if present.
      const after = view.state.sliceDoc(to, to + 1);
      const end = after === "}" ? to + 1 : to;
      const line = view.state.doc.lineAt(from);
      const indent = /^\s*/.exec(line.text)?.[0] ?? "";
      const insert = `${env}}\n${indent}  \n${indent}\\end{${env}}`;
      const cursor = from + env.length + 2 + indent.length + 2;
      view.dispatch({
        changes: { from, to: end, insert },
        selection: { anchor: cursor },
      });
    },
  };
}

/**
 * Snippet-style completions for the boilerplate blocks used constantly.
 * NB: completion replaces the text AFTER the "\" the user already typed, so
 * each template deliberately omits the leading backslash of its first token.
 */
const SNIPPETS: Completion[] = [
  snippetCompletion("begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{${path}}\n  \\caption{${caption}}\n  \\label{fig:${label}}\n\\end{figure}", {
    label: "figure", detail: "figure block", type: "keyword",
  }),
  snippetCompletion("begin{table}[htbp]\n  \\centering\n  \\caption{${caption}}\n  \\label{tab:${label}}\n  \\begin{tabular}{${lcr}}\n    ${}\n  \\end{tabular}\n\\end{table}", {
    label: "table", detail: "table block", type: "keyword",
  }),
  snippetCompletion("begin{equation}\n  ${}\n  \\label{eq:${label}}\n\\end{equation}", {
    label: "equation", detail: "numbered equation", type: "keyword",
  }),
  snippetCompletion("begin{itemize}\n  \\item ${}\n\\end{itemize}", {
    label: "itemize", detail: "bullet list", type: "keyword",
  }),
  snippetCompletion("begin{enumerate}\n  \\item ${}\n\\end{enumerate}", {
    label: "enumerate", detail: "numbered list", type: "keyword",
  }),
];

/** Build a completion source that also knows this project's labels/citekeys. */
export function latexCompletions(getKeys: () => { labels: string[]; cites: string[] }) {
  return (context: CompletionContext): CompletionResult | null => {
    // \begin{...} / \end{...} -> environment names
    const envMatch = context.matchBefore(/\\(begin|end)\{[a-zA-Z*]*/);
    if (envMatch) {
      const isBegin = envMatch.text.startsWith("\\begin");
      const brace = envMatch.text.indexOf("{");
      const from = envMatch.from + brace + 1;
      return {
        from,
        options: ENVIRONMENTS.map((e) => (isBegin ? envCompletion(e) : { label: e, type: "class" as const })),
        validFor: /^[a-zA-Z*]*$/,
      };
    }
    // \ref{...}/\eqref{...} -> labels ; \cite{...} -> bib keys
    const refMatch = context.matchBefore(/\\(ref|eqref|pageref)\{[^}]*/);
    if (refMatch) {
      const from = refMatch.from + refMatch.text.indexOf("{") + 1;
      return { from, options: getKeys().labels.map((l) => ({ label: l, type: "variable" })), validFor: /^[^}]*$/ };
    }
    const citeMatch = context.matchBefore(/\\(cite|citep|citet)\{[^}]*/);
    if (citeMatch) {
      const from = citeMatch.from + citeMatch.text.indexOf("{") + 1;
      return { from, options: getKeys().cites.map((c) => ({ label: c, type: "variable" })), validFor: /^[^}]*$/ };
    }
    // \command — plain commands plus block snippets (\figure, \table, ...)
    const cmd = context.matchBefore(/\\[a-zA-Z]*/);
    if (cmd && (cmd.from < cmd.to || context.explicit)) {
      return {
        from: cmd.from + 1,
        options: [...COMMANDS.map((c) => ({ label: c, type: "keyword" as const })), ...SNIPPETS],
        validFor: /^[a-zA-Z]*$/,
      };
    }
    return null;
  };
}

/** Harvest \label{...} keys and .bib citation keys from open sources. */
export function harvestKeys(texSources: string[], bibSources: string[]): { labels: string[]; cites: string[] } {
  const labels = new Set<string>();
  const cites = new Set<string>();
  for (const src of texSources) {
    for (const m of src.matchAll(/\\label\{([^}]+)\}/g)) labels.add(m[1]);
  }
  for (const bib of bibSources) {
    for (const m of bib.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)) cites.add(m[1]);
  }
  return { labels: [...labels], cites: [...cites] };
}

export function latexAutocomplete(getKeys: () => { labels: string[]; cites: string[] }): Extension {
  return autocompletion({ override: [latexCompletions(getKeys)] });
}
