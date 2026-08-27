import "@/lib/run-storage-migration"; // MUST stay the first import — see that file
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { MonitorApp } from "@/components/monitor/MonitorApp";
import { isMonitorBoot } from "@/lib/monitorWindows";
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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isMonitorBoot() ? <MonitorApp /> : <App />}</React.StrictMode>,
);
