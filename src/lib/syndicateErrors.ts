import type { SyndicateGrantStatus } from "@/types/syndicate";

/**
 * Typed controller failures.
 *
 * `CONTROLLER_PROTOCOL_V1` answers a rejected RPC with
 * `error: {code, retryable, correlationId}`. PacketADE used to flatten that
 * into a sentence and then re-derive the verdict with message regexes, which
 * is how `DEVICE_UNAUTHORIZED` — the code a Host returns for a grant that has
 * passed its 30-day expiry — became a permanent 5-second reconnect loop
 * against a grant that can never succeed again. The native layer now forwards
 * the typed fields verbatim and everything downstream branches on them.
 *
 * `code`/`retryable` are absent for failures that never reached a Host
 * (validation, tunnels, sockets). Absence means "no Host verdict" and must
 * never be read as "not retryable".
 */
export class SyndicateControllerError extends Error {
  /**
   * Brand, so recognition never depends on class identity. `instanceof` is
   * wrong here: this error crosses a native boundary and is re-created from a
   * plain object, and any second copy of this module (test module reset, HMR)
   * would silently stop matching — turning a fatal Host verdict back into an
   * unbounded retry, which is exactly the bug this file exists to fix.
   */
  readonly isSyndicateControllerError = true as const;
  readonly code?: string;
  readonly retryable?: boolean;
  readonly correlationId?: string;

  constructor(
    message: string,
    detail: { code?: string; retryable?: boolean; correlationId?: string } = {},
  ) {
    super(message);
    this.name = "SyndicateControllerError";
    this.code = detail.code;
    this.retryable = detail.retryable;
    this.correlationId = detail.correlationId;
  }
}

export function isSyndicateControllerError(value: unknown): value is SyndicateControllerError {
  return (
    value instanceof Error &&
    (value as Partial<SyndicateControllerError>).isSyndicateControllerError === true
  );
}

/**
 * Normalize a Tauri rejection into an `Error`.
 *
 * Native Syndicate commands reject with a serialized `SyndicateCommandError`
 * object rather than a string, so every existing `catch` that reads
 * `error.message` keeps working only if the payload is rehydrated here. This
 * is the single place that knows the native error shape.
 */
export function toSyndicateError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (value && typeof value === "object") {
    const raw = value as Record<string, unknown>;
    if (typeof raw.message === "string") {
      return new SyndicateControllerError(raw.message, {
        code: typeof raw.code === "string" ? raw.code : undefined,
        retryable: typeof raw.retryable === "boolean" ? raw.retryable : undefined,
        correlationId: typeof raw.correlationId === "string" ? raw.correlationId : undefined,
      });
    }
  }
  return new Error(String(value));
}

/**
 * Host codes that mean this device grant is dead. Both are terminal: the
 * remedy is re-pairing, never retrying.
 *
 * A Host returns `DEVICE_UNAUTHORIZED` when the device row is not active *or*
 * `grant_expires_at` has passed, and `DEVICE_REVOKED` only for an explicitly
 * revoked device (`apps/host/src/controller-auth.ts:536-537`). Since revocation
 * has its own code, `DEVICE_UNAUTHORIZED` on a device we believe is paired is
 * the 30-day expiry cliff. `GRANT_EXPIRED` is PacketADE's own code for a relay
 * grant it can see has expired without asking the Host.
 */
const DEAD_GRANT_CODES: Readonly<
  Record<string, Extract<SyndicateGrantStatus, "revoked" | "expired">>
> = {
  DEVICE_REVOKED: "revoked",
  DEVICE_UNAUTHORIZED: "expired",
  GRANT_EXPIRED: "expired",
  DEVICE_EXPIRED: "expired",
};

/**
 * Whether retrying this request could ever succeed.
 *
 * The Host's typed `retryable` is authoritative when present. It is `false`
 * for every terminal auth verdict — `DEVICE_UNAUTHORIZED`, `DEVICE_REVOKED`,
 * `MACHINE_MISMATCH`, `INVALID_SIGNATURE`, `AUTH_REPLAY`, `REQUEST_EXPIRED`,
 * `SCOPE_DENIED` — so a reconnect loop no longer needs to enumerate codes.
 * Without a verdict the failure is local (socket, timeout, tunnel) and stays
 * retryable, which is what preserves ordinary reconnect behaviour.
 */
export function isFatalSyndicateError(error: unknown): boolean {
  return isSyndicateControllerError(error) && error.retryable === false;
}

/** The grant state a failure proves, if it proves one. */
export function grantStatusFromSyndicateError(error: unknown): "revoked" | "expired" | undefined {
  if (isSyndicateControllerError(error) && error.code) {
    return DEAD_GRANT_CODES[error.code];
  }
  return undefined;
}
