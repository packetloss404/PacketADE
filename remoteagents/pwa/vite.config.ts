import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  css: {
    // Keep the standalone PWA independent from PacketBench desktop's parent
    // Tailwind/PostCSS pipeline.
    postcss: { plugins: [] },
  },
  server: {
    port: 1430,
    strictPort: true,
  },
});
