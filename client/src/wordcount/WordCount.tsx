/**
 * Word-count UI. Two pieces:
 *   - WordCountBar: the status-bar readout. Shows the live selection count when
 *     text is highlighted, otherwise the document total.
 *   - WordCountPanel: a collapsible breakdown with per-section counts, backed by
 *     texcount on the server (or a JS estimate when texcount is unavailable).
 */
import type { SelectionCountResult, WordCountResult } from "@offleaf/shared";

export function WordCountBar({
  doc,
  selection,
}: {
  doc: (WordCountResult & { engine: string }) | null;
  selection: SelectionCountResult | null;
}) {
  if (selection && selection.words > 0) {
    return (
      <span className="wc-bar">
        <b>Selection:</b> {selection.words} words · {selection.characters} chars
        {selection.charactersNoSpaces !== selection.characters
          ? ` (${selection.charactersNoSpaces} no spaces)`
          : ""}
      </span>
    );
  }
  if (doc) {
    return (
      <span className="wc-bar">
        <b>Document:</b> {doc.total.wordsInText} words
        <span className="muted"> · {doc.engine === "texcount" ? "texcount" : "estimate"}</span>
      </span>
    );
  }
  return <span className="wc-bar muted">Word count…</span>;
}

export function WordCountPanel({
  result,
  onClose,
}: {
  result: (WordCountResult & { engine: string }) | null;
  onClose(): void;
}) {
  return (
    <div className="wc-panel">
      <div className="panel-title">
        Word count
        <button className="link" onClick={onClose}>close</button>
      </div>
      {!result ? (
        <div className="muted" style={{ padding: 8 }}>Compile or save to compute counts.</div>
      ) : (
        <div className="wc-body">
          <div className="wc-total">
            <div><span className="k">Text</span><span className="v">{result.total.wordsInText}</span></div>
            <div><span className="k">Headers</span><span className="v">{result.total.wordsInHeaders}</span></div>
            <div><span className="k">Captions</span><span className="v">{result.total.wordsInCaptions}</span></div>
            <div><span className="k">Display math</span><span className="v">{result.total.mathDisplay}</span></div>
            <div><span className="k">Inline math</span><span className="v">{result.total.mathInline}</span></div>
            <div><span className="k">Floats</span><span className="v">{result.total.floats}</span></div>
          </div>
          <div className="wc-sections">
            <div className="wc-sub">Per section</div>
            {result.sections.length === 0 && <div className="muted">No sections found.</div>}
            {result.sections.map((s, i) => (
              <div className="wc-srow" key={i}>
                <span className="wc-title">{s.title}</span>
                <span className="wc-count">{s.words}</span>
              </div>
            ))}
          </div>
          <div className="muted wc-note">
            Source: {result.engine === "texcount" ? "texcount (authoritative)" : "built-in estimate — install TeX Live for texcount"}
          </div>
        </div>
      )}
    </div>
  );
}
