/**
 * PDF preview using PDF.js — renders the compiled PDF locally (no network) and
 * supports zoom, fit-width, SyncTeX forward highlighting, and Ctrl/Cmd+click
 * for SyncTeX inverse search back into the editor. The scroll position is
 * preserved across recompiles, matching Overleaf's preview behaviour.
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { renderParamsFor } from "./hidpi";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfHandle {
  /** Draw a transient marker at a source-mapped PDF location and scroll to it. */
  highlight(page: number, x: number, y: number): void;
}

interface PdfViewProps {
  url: string | null;
  /**
   * Called on Ctrl/Cmd+click with the clicked page and coordinates in
   * SyncTeX's convention: PDF points measured from the page's TOP-left.
   */
  onInverse?(page: number, x: number, y: number): void;
}

const PdfView = forwardRef<PdfHandle, PdfViewProps>(function PdfView({ url, onInverse }, ref) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pagesRef = useRef<HTMLDivElement | null>(null);
  const wrappers = useRef<HTMLDivElement[]>([]);
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1.25);
  const [error, setError] = useState<string | null>(null);
  const docRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const renderToken = useRef(0);
  const savedScroll = useRef(0);
  const hadDoc = useRef(false);
  const [renderNonce, setRenderNonce] = useState(0);
  // Read through a ref so the (expensive) page-render effect does NOT depend
  // on the callback's identity — App recreates it every render, and re-running
  // the effect would wipe and repaint every page on any unrelated state change.
  const onInverseRef = useRef(onInverse);
  onInverseRef.current = onInverse;

  useImperativeHandle(ref, () => ({
    highlight(page: number, x: number, y: number) {
      const wrapper = wrappers.current[page - 1];
      if (!wrapper) return;
      let marker = wrapper.querySelector<HTMLDivElement>(".pdf-marker");
      if (!marker) {
        marker = document.createElement("div");
        marker.className = "pdf-marker";
        wrapper.appendChild(marker);
      }
      // synctex coordinates are big-points from the top-left; scale to CSS px.
      marker.style.left = `${x * scale - 4}px`;
      marker.style.top = `${y * scale - 14}px`;
      marker.classList.remove("flash");
      void marker.offsetWidth; // restart the animation
      marker.classList.add("flash");
      marker.scrollIntoView({ behavior: "smooth", block: "center" });
    },
  }));

  // (Re)load the document when the URL changes.
  useEffect(() => {
    if (!url) {
      setNumPages(0);
      docRef.current = null;
      hadDoc.current = false;
      return;
    }
    let cancelled = false;
    setError(null);
    // Remember where the reader was: on a recompile we restore this offset so
    // the preview does not jump back to page 1 (Overleaf behaviour).
    savedScroll.current = hadDoc.current ? (scrollRef.current?.scrollTop ?? 0) : 0;
    const task = pdfjsLib.getDocument({ url });
    task.promise
      .then((doc) => {
        if (cancelled) return;
        docRef.current?.destroy();
        docRef.current = doc;
        hadDoc.current = true;
        wrappers.current = [];
        setNumPages(doc.numPages);
        // Re-render even if the page count is unchanged.
        renderToken.current++;
        setRenderNonce((n) => n + 1);
      })
      .catch((e) => !cancelled && setError(String(e?.message ?? e)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // Render all pages whenever the doc or zoom changes.
  useEffect(() => {
    const doc = docRef.current;
    const host = pagesRef.current;
    if (!doc || !host || numPages === 0) return;
    const token = ++renderToken.current;
    const keepScroll = savedScroll.current || scrollRef.current?.scrollTop || 0;
    host.innerHTML = "";
    wrappers.current = [];

    (async () => {
      for (let n = 1; n <= doc.numPages; n++) {
        if (token !== renderToken.current) return; // superseded
        const page = await doc.getPage(n);
        const viewport = page.getViewport({ scale });
        // Page height in PDF points, for converting clicks to top-origin
        // coordinates (synctex's convention) from PDF.js's bottom-origin.
        const pageHeightPt = page.view[3] - page.view[1];
        const wrapper = document.createElement("div");
        wrapper.className = "pdf-page";
        wrapper.style.width = `${viewport.width}px`;
        wrapper.style.height = `${viewport.height}px`;
        // The text layer positions glyphs at scale-1 sizes multiplied by this
        // CSS variable — required for selection to line up at every zoom.
        wrapper.style.setProperty("--scale-factor", String(viewport.scale));
        const canvas = document.createElement("canvas");
        // Render at device resolution (Retina et al.) but display at CSS size,
        // otherwise the browser upscales a 1× bitmap and text looks soft.
        const hidpi = renderParamsFor(viewport.width, viewport.height, window.devicePixelRatio || 1);
        canvas.width = hidpi.canvasWidth;
        canvas.height = hidpi.canvasHeight;
        canvas.style.width = `${hidpi.cssWidth}px`;
        canvas.style.height = `${hidpi.cssHeight}px`;
        const ctx = canvas.getContext("2d");
        wrapper.appendChild(canvas);
        host.appendChild(wrapper);
        wrappers.current[n - 1] = wrapper;

        wrapper.addEventListener("click", (ev) => {
          if (!(ev.ctrlKey || ev.metaKey) || !onInverseRef.current) return;
          const rect = canvas.getBoundingClientRect();
          const [px, py] = viewport.convertToPdfPoint(ev.clientX - rect.left, ev.clientY - rect.top);
          // Flip to top-origin for synctex (PDF user space is bottom-origin).
          onInverseRef.current(n, Math.round(px), Math.round(pageHeightPt - py));
        });

        if (ctx) await page.render({ canvasContext: ctx, viewport, transform: hidpi.transform }).promise;

        // Selectable-text overlay: invisible spans positioned exactly over the
        // painted glyphs, so browser selection/copy works on the preview.
        if (token === renderToken.current) {
          const textLayerDiv = document.createElement("div");
          textLayerDiv.className = "textLayer";
          wrapper.appendChild(textLayerDiv);
          try {
            await new pdfjsLib.TextLayer({
              textContentSource: page.streamTextContent(),
              container: textLayerDiv,
              viewport,
            }).render();
          } catch {
            /* selection is progressive enhancement — canvas is already drawn */
          }
        }

        if (n === 1 && keepScroll && scrollRef.current) {
          scrollRef.current.scrollTop = keepScroll;
        }
      }
      // All pages laid out — restore precisely, then forget the saved offset.
      if (keepScroll && scrollRef.current && token === renderToken.current) {
        scrollRef.current.scrollTop = keepScroll;
      }
      savedScroll.current = 0;
    })();
  }, [numPages, scale, renderNonce]);

  const fitWidth = async () => {
    const doc = docRef.current;
    const holder = scrollRef.current;
    if (!doc || !holder) return;
    const page = await doc.getPage(1);
    const width = page.getViewport({ scale: 1 }).width;
    setScale(Math.max(0.4, (holder.clientWidth - 36) / width));
  };

  const zoomLabel = useMemo(() => `${Math.round(scale * 100)}%`, [scale]);

  return (
    <div className="pdfview">
      <div className="pdf-toolbar">
        <button onClick={() => setScale((s) => Math.max(0.5, s - 0.1))} title="Zoom out">−</button>
        <span className="zoom">{zoomLabel}</span>
        <button onClick={() => setScale((s) => Math.min(3, s + 0.1))} title="Zoom in">+</button>
        <button onClick={fitWidth} title="Fit page width">Fit</button>
        {url && (
          <a className="pdf-download" href={url} download="output.pdf" title="Download the compiled PDF">
            ⤓ Download
          </a>
        )}
        <span className="muted pdf-hint">{numPages ? `${numPages} pages · ⌘/Ctrl+click = jump to source` : ""}</span>
      </div>
      <div className="pdf-scroll" ref={scrollRef}>
        {error && <div className="pdf-empty">Could not load PDF: {error}</div>}
        {!url && !error && <div className="pdf-empty">Compile to see the PDF preview.</div>}
        <div className="pdf-pages" ref={pagesRef} />
      </div>
    </div>
  );
});

export default PdfView;
