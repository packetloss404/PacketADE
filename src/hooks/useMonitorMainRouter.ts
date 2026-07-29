import { useEffect } from "react";
import { installMonitorMainRouter } from "@/lib/monitorWindows";

export function useMonitorMainRouter() {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void installMonitorMainRouter().then((cleanup) => {
      if (cancelled) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
