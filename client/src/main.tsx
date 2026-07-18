import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

// OffLeaf boots as a single-page app. The backend serves this bundle as static
// assets on the same origin, so there is never a cross-origin request at runtime.
const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("OffLeaf: #root element is missing from index.html");
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
