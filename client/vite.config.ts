import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The client is served by the local backend in production, and proxies API/WS
// calls to it during development so everything stays same-origin and offline.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/ws": { target: "ws://127.0.0.1:3000", ws: true },
    },
  },
  build: {
    outDir: "dist",
    // PDF.js ships a worker that must be emitted as a separate chunk.
    target: "es2022",
  },
});
