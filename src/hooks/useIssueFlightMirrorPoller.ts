import { useEffect } from "react";
import { useIssueFlightMirrorStore } from "@/stores/issueFlightMirrorStore";

export function useIssueFlightMirrorPoller() {
  useEffect(() => {
    const sync = () => void useIssueFlightMirrorStore.getState().syncAll();
    const timer = window.setInterval(sync, 60_000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") sync();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
}
