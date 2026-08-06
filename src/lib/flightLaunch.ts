/**
 * Pure helpers for the parallel-attempt launch modal. They live here rather
 * than in `LaunchAsyncFlightModal.tsx` so the component file exports only its
 * component (react-refresh) and so the wording is testable on its own.
 */

/**
 * The publish-as-draft-PR checkbox's starting value. A flight that has already
 * recorded a preference keeps it; only a brand-new flight falls back to the
 * Settings → GitHub default.
 *
 * This used to read the global default unconditionally while
 * `createOrUpdateFlight` wrote the checkbox back to the flight, so re-opening
 * the modal to add an attempt silently rewrote the flight's publish setting —
 * and `asyncFlightStore.setAttemptStatus` then skipped the accept-time publish.
 */
export function resolveInitialPublishAsPrs(
  existingFlight: { publishAttemptsAsPrs?: boolean } | null | undefined,
  defaultPublishAttemptsAsPrs: boolean,
): boolean {
  return existingFlight?.publishAttemptsAsPrs ?? defaultPublishAttemptsAsPrs;
}

/**
 * What to tell the user when a multi-target launch rejects partway.
 * Provisioning is sequential, so earlier targets can already be live and
 * burning tokens by the time a later one fails — `asyncFlightStore.launchAsync`
 * recovers and reattaches them, and this is the only place that says so.
 */
export function summarizeLaunchOutcome(
  launched: number,
  total: number,
  message: string,
): { text: string; partial: boolean } {
  if (launched <= 0) return { text: message, partial: false };
  const noun = launched === 1 ? "agent is" : "agents are";
  return {
    text: `${launched} of ${total} ${noun} running — the rest failed to launch: ${message}`,
    partial: true,
  };
}
