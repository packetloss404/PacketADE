import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { collectLiveWork, type LiveWorkSummary } from "@/lib/liveWork";

/**
 * UX-09: intercept the main window's close request and confirm before killing
 * live work.
 *
 * Mechanism: Tauri v2 emits `tauri://close-requested` and — because a JS
 * listener is registered — the Rust side calls `prevent_close()` for us, so
 * nothing dies until this handler decides. `onCloseRequested` awaits the
 * handler and destroys the window itself unless `preventDefault()` was called;
 * we always prevent, then own the outcome:
 *
 *   - no live work  → `destroy()` immediately, no prompt, no perceptible delay
 *   - live work     → surface the summary; `confirm()` destroys, `cancel()`
 *                     drops the request and the window stays up
 *
 * `destroy()` (not `close()`) is what actually tears the window down —
 * `close()` would re-emit close-requested and loop back into this handler.
 *
 * Outside Tauri (vitest, `vite dev` in a plain browser) registration rejects
 * and is swallowed; the app simply has no close interception there.
 */
export interface CloseConfirmController {
  /** Non-null while a close request is parked awaiting the user. */
  pending: LiveWorkSummary | null;
  /** Keep the window open and forget the request. */
  cancel: () => void;
  /** Destroy the window, killing everything in `pending`. */
  confirm: () => void;
}

export function useCloseConfirm(): CloseConfirmController {
  const [pending, setPending] = useState<LiveWorkSummary | null>(null);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    const register = async () => {
      const appWindow = getCurrentWindow();
      return appWindow.onCloseRequested(async (event) => {
        // Always take ownership: the decision needs an async store/backend
        // read, and letting the default run would close mid-check.
        event.preventDefault();
        const summary = await collectLiveWork();
        if (summary.total === 0) {
          await appWindow.destroy();
          return;
        }
        setPending(summary);
      });
    };

    register()
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((err) => console.warn("[useCloseConfirm.register] failed:", err));

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const cancel = useCallback(() => setPending(null), []);

  const confirm = useCallback(() => {
    // Keep the confirmation visible until Tauri accepts the destroy command.
    // A missing/invalid capability must not make the dialog disappear while
    // leaving the window alive, which looks exactly like a dead button.
    void Promise.resolve(getCurrentWindow().destroy())
      .then(() => setPending(null))
      .catch((err) => console.warn("[useCloseConfirm.destroy] failed:", err));
  }, []);

  return { pending, cancel, confirm };
}
