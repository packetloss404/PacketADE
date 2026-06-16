import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Pin Vite's dynamic-import preload helper to the always-loaded
          // vendor-react chunk. It's a virtual module (not under node_modules),
          // so without this it falls through to default placement and rollup
          // may park it inside a heavy lazy chunk (e.g. vendor-markdown) — the
          // entry then statically imports that whole chunk just for the helper,
          // dragging it onto the cold-start critical path. A dedicated
          // dependency-free chunk avoids any cross-chunk cycle.
          if (id.includes("vite/preload-helper")) {
            return "vendor-helpers";
          }
          if (!id.includes("node_modules")) {
            return undefined;
          }
          if (
            id.includes("@xterm/") ||
            id.includes("node-pty") ||
            id.includes("xterm")
          ) {
            return "vendor-xterm";
          }
          if (
            id.includes("react-markdown") ||
            id.includes("remark-gfm") ||
            id.includes("react-syntax-highlighter") ||
            id.includes("hast") ||
            id.includes("mdast") ||
            id.includes("micromark") ||
            id.includes("unist") ||
            id.includes("vfile")
          ) {
            return "vendor-markdown";
          }
          if (id.includes("react-mosaic-component")) {
            return "vendor-mosaic";
          }
          if (id.includes("lucide-react")) {
            return "vendor-icons";
          }
          if (
            id.includes("/react/") ||
            id.includes("/react-dom/") ||
            id.includes("scheduler")
          ) {
            return "vendor-react";
          }
          if (id.includes("zustand")) {
            return "vendor-state";
          }
          if (id.includes("@tauri-apps/")) {
            return "vendor-tauri";
          }
          return undefined;
        },
      },
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
