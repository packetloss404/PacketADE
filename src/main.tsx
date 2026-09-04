import React from "react";
import ReactDOM from "react-dom/client";
import { bootPersistedStorage } from "@/lib/storage-boot";
import "./index.css";

// Global error handlers — catch unhandled errors and promise rejections
window.addEventListener("unhandledrejection", (event) => {
  console.error("[PacketBench] Unhandled promise rejection:", event.reason);
});

window.addEventListener("error", (event) => {
  console.error(
    "[PacketBench] Unhandled error:",
    event.message,
    "at",
    event.filename,
    ":",
    event.lineno,
  );
});

/**
 * Boot in two phases.
 *
 * Phase 1 repairs `localStorage` — restoring it from the durable Rust-side
 * mirror when a bundle-identifier change has left this origin empty, then
 * running the legacy prefix migrations. Phase 2 pulls in the React tree.
 *
 * The `import()` calls below MUST stay dynamic. Every store hydrates from
 * `localStorage` at module-evaluation time, and ESM hoists static imports, so
 * a statically imported `App` would evaluate its whole store graph before this
 * function body ever ran. See `@/lib/storage-boot` for the full ordering
 * argument.
 */
async function boot() {
  await bootPersistedStorage();

  const [{ default: App }, { MonitorApp }, { isMonitorBoot }] = await Promise.all([
    import("./App"),
    import("@/components/monitor/MonitorApp"),
    import("@/lib/monitorWindows"),
  ]);

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>{isMonitorBoot() ? <MonitorApp /> : <App />}</React.StrictMode>,
  );
}

void boot();
