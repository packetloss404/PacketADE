/**
 * Pure classification of a `list_provider_models` rejection.
 *
 * DELIBERATELY NOT IN `lib/tauri.ts`. That module is the IPC surface, and 103
 * test files stub it with `vi.mock("@/lib/tauri", ...)`; 92 of them replace it
 * wholesale rather than spreading `importOriginal`. Anything pure that lives
 * there is therefore stubbed away by accident in most of the suite — which is
 * exactly what happened here, and to `ptyExitSucceeded` before it: the tests
 * kept passing while an unhandled rejection was swallowed on every render.
 *
 * There is no IPC in this file, so mocking the transport cannot reach it.
 */
/**
 * Failure classes from {@link listProviderModels}, which the UI should render
 * differently:
 *
 * - `no-key` / `not-configured` — the user has not connected this provider
 *   yet. Expected and benign; prompt to configure, do not show an error state.
 * - `unauthorized` — a key WAS sent and the provider rejected it. This is the
 *   earliest cheap signal that a stored keyring secret went stale; surface it
 *   loudly and point at Settings > API Keys.
 * - `network` — connect failure, timeout, other non-2xx, or an unparseable
 *   body. Transient; offer a retry.
 * - `credential-store` — the OS keyring itself failed, distinct from "no key".
 * - `unsupported` — the provider has no live catalog (e.g. `api-packetcode`).
 */
export type LiveModelErrorKind =
  | "no-key"
  | "not-configured"
  | "unauthorized"
  | "network"
  | "credential-store"
  | "unsupported";

export type LiveModelError = {
  kind: LiveModelErrorKind;
  /** Human-readable text, already free of the machine tag. */
  message: string;
};

const LIVE_MODEL_ERROR_KINDS: readonly LiveModelErrorKind[] = [
  "no-key",
  "not-configured",
  "unauthorized",
  "network",
  "credential-store",
  "unsupported",
];

/**
 * Split the `"<kind>: <message>"` string the Rust command rejects with into its
 * two halves. Anything unrecognised (a panic string, a Tauri transport error)
 * degrades to `network`, which is the retryable class.
 */
export function parseLiveModelError(error: unknown): LiveModelError {
  const raw =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : String(error);
  const separator = raw.indexOf(": ");
  if (separator > 0) {
    const tag = raw.slice(0, separator);
    const match = LIVE_MODEL_ERROR_KINDS.find((kind) => kind === tag);
    if (match) {
      return { kind: match, message: raw.slice(separator + 2) };
    }
  }
  return { kind: "network", message: raw };
}

/** True for the "not connected yet" classes, which are not failures. */
export function isLiveModelSetupError(error: LiveModelError): boolean {
  return error.kind === "no-key" || error.kind === "not-configured";
}
