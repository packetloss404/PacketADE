import { useNotificationStore } from "@/stores/notificationStore";

// Per-session debounce tracking (5s window)
const lastNotificationTime: Record<string, number> = {};
const DEBOUNCE_MS = 5000;

function shouldNotify(sessionId: string): boolean {
  const prefs = useNotificationStore.getState();
  if (!prefs.enabled) return false;
  if (prefs.onlyWhenUnfocused && document.hasFocus()) return false;

  const now = Date.now();
  const last = lastNotificationTime[sessionId] ?? 0;
  if (now - last < DEBOUNCE_MS) return false;

  lastNotificationTime[sessionId] = now;
  return true;
}

async function ensurePermission(): Promise<boolean> {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  const result = await Notification.requestPermission();
  return result === "granted";
}

export async function notifyApprovalNeeded(
  sessionId: string,
  sessionName: string
) {
  if (!useNotificationStore.getState().onApprovalNeeded) return;
  if (!shouldNotify(sessionId)) return;
  if (!(await ensurePermission())) return;

  new Notification("Approval Needed", {
    body: `${sessionName} is waiting for your approval`,
    tag: `approval-${sessionId}`,
  });
}

export async function notifySessionComplete(
  sessionId: string,
  sessionName: string
) {
  if (!useNotificationStore.getState().onSessionComplete) return;
  if (!shouldNotify(sessionId)) return;
  if (!(await ensurePermission())) return;

  new Notification("Session Complete", {
    body: `${sessionName} has finished`,
    tag: `complete-${sessionId}`,
  });
}

export async function notifySessionError(
  sessionId: string,
  sessionName: string
) {
  if (!useNotificationStore.getState().onSessionError) return;
  if (!shouldNotify(sessionId)) return;
  if (!(await ensurePermission())) return;

  new Notification("Session Error", {
    body: `${sessionName} encountered an error`,
    tag: `error-${sessionId}`,
  });
}

export async function notifyTaskComplete(taskId: string, taskName: string) {
  if (!useNotificationStore.getState().onSessionComplete) return;
  if (!shouldNotify(`task-${taskId}`)) return;
  if (!(await ensurePermission())) return;

  new Notification("Task Complete", {
    body: `${taskName} has finished`,
    tag: `task-complete-${taskId}`,
  });
}

export async function notifyFlightFailed(flightName: string) {
  if (!useNotificationStore.getState().onSessionError) return;
  if (!shouldNotify(`flight-failed-${flightName}`)) return;
  if (!(await ensurePermission())) return;

  new Notification("Flight Failed", {
    body: `${flightName} has failed`,
    tag: `flight-failed-${flightName}`,
  });
}

export async function notifyAttemptCompleted(
  flightTitle: string,
  attemptLabel: string
): Promise<void> {
  if (document.visibilityState !== "hidden") return;
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;

  new Notification("Attempt ready", {
    body: `${flightTitle}: ${attemptLabel} finished — review in Flight Deck`,
    tag: `attempt-completed-${flightTitle}-${attemptLabel}`,
  });
}

export async function notifyAttemptFailed(
  flightTitle: string,
  attemptLabel: string,
  errorMsg?: string
): Promise<void> {
  if (document.visibilityState !== "hidden") return;
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;

  const body = errorMsg
    ? `${flightTitle}: ${attemptLabel} failed — ${errorMsg}`
    : `${flightTitle}: ${attemptLabel} failed`;
  new Notification("Attempt failed", {
    body,
    tag: `attempt-failed-${flightTitle}-${attemptLabel}`,
  });
}

export async function notifyConversationDone(convTitle: string): Promise<void> {
  if (document.visibilityState !== "hidden") return;
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;

  new Notification("Agent finished", {
    body: convTitle,
    tag: `conversation-done-${convTitle}`,
  });
}


export async function requestNotificationPermission(): Promise<boolean> {
  return ensurePermission();
}
