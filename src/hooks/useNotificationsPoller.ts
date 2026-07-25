import { useEffect, useRef } from "react";
import { useGitHubStore } from "@/stores/githubStore";
import {
  shouldPollNotifications,
  NOTIFICATIONS_POLL_INTERVAL_MS,
} from "@/lib/notificationPoll";

/**
 * GP2: keep the notifications inbox (and its unread badge) live with a
 * conservative, visibility-aware background poll. Polls immediately on mount,
 * then no more often than `intervalMs`, pausing while the app is hidden and
 * catching up the moment it becomes visible again. Resets on host change.
 */
export function useNotificationsPoller(intervalMs = NOTIFICATIONS_POLL_INTERVAL_MS) {
  const isConnected = useGitHubStore((s) => s.isConnected);
  const fetchNotifications = useGitHubStore((s) => s.fetchNotifications);
  const activeConnectionId = useGitHubStore((s) => s.activeConnectionId);
  const lastPolledRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isConnected) return;
    lastPolledRef.current = null; // host changed — allow an immediate refetch

    const maybePoll = () => {
      const now = Date.now();
      const visible =
        typeof document === "undefined" || document.visibilityState === "visible";
      if (
        shouldPollNotifications({
          connected: isConnected,
          visible,
          lastPolledAt: lastPolledRef.current,
          now,
          intervalMs,
        })
      ) {
        lastPolledRef.current = now;
        void fetchNotifications();
      }
    };

    maybePoll();
    // Check more often than the interval so a visibility change is caught
    // promptly; the staleness gate keeps actual fetches at `intervalMs`.
    const id = setInterval(maybePoll, Math.min(intervalMs, 30_000));
    const onVisibility = () => {
      if (document.visibilityState === "visible") maybePoll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [isConnected, activeConnectionId, fetchNotifications, intervalMs]);
}
