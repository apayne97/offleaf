/// <reference types="vite/client" />

// Vite's client types provide module declarations for asset imports such as
// `import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url"` and for CSS
// side-effect imports like `import "katex/dist/katex.min.css"`. Referencing them
// here keeps the whole client strictly typed without any extra ambient shims.
