import React from "react";
import ReactDOM from "react-dom/client";
// Must run BEFORE App is imported, because stores read localStorage at module
// init time and we need the packetcode:* → packetade:* keys in place first.
import { migrateIssuesMissionToFlight, migrateLegacyStorage } from "@/lib/storage-migration";
migrateLegacyStorage();
// Then canonicalize the legacy `missionId` flight link on persisted issues
// (runs after the prefix copy above so `packetade:issues` is in place).
migrateIssuesMissionToFlight();

import App from "./App";
import { MonitorApp } from "@/components/monitor/MonitorApp";
import { isMonitorBoot } from "@/lib/monitorWindows";
import "./index.css";

// Global error handlers — catch unhandled errors and promise rejections
window.addEventListener("unhandledrejection", (event) => {
  console.error("[PacketADE] Unhandled promise rejection:", event.reason);
});

window.addEventListener("error", (event) => {
  console.error(
    "[PacketADE] Unhandled error:",
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
