/**
 * Shared helper for the "swallow but log" error pattern.
 *
 * The codebase previously had ~30 `.catch(() => {})` and bare `catch {}`
 * sites that hid real failures (persistence errors, API cleanup failures,
 * Tauri listener subscribe rejections, audio-device probes, etc.). Silent
 * swallowing is acceptable in two narrow cases: (a) the failure mode is
 * inherently expected (e.g. killing an already-dead PTY) — those keep a
 * `.catch(() => {})` with a one-line comment explaining why; (b) the
 * failure is unexpected but non-fatal — those route through `logSwallowed`
 * so the error lands in the console with a stable label instead of
 * vanishing.
 *
 * Usage:
 *
 *   saveWorkspacesSlice(workspaces).catch(logSwallowed("workspaceStore.save"));
 *
 * The label should identify the call site (store + action, hook + event,
 * component + effect). Future telemetry hooks can be wired here in one
 * place.
 */
export function logSwallowed(label: string): (err: unknown) => void {
  return (err) => {
    console.warn(`[${label}] swallowed error:`, err);
  };
}
