/**
 * The one seam every Remote Agents code path must pass through.
 *
 * Why this exists
 * ---------------
 * `remoteAgentsSettingsStore` records what the *user asked for*. That is not
 * authorization. Before this module, the only thing standing between a Sprint 1
 * feature and a live remote surface was a boolean named `enabled` that defaulted
 * to `false` — so "Remote Agents remains disabled and fail-closed"
 * (`README.md`, `dev/remoteagents/README.md`) was true only because nothing
 * existed to enable. A single `if (settings.remoteAgents.enabled)` in new code
 * would have opened it, with none of the ratified pre-beta requirements met.
 *
 * So the user preference is now one of two conjuncts. The other is this
 * module's gate list, and it is the authority.
 *
 * Fail-closed properties, deliberately
 * ------------------------------------
 * - Every gate starts `met: false`. Flipping one is an edit to this file, in a
 *   diff, next to the requirement it claims to satisfy.
 * - {@link remoteAgentsGatesMet} requires a NON-EMPTY list where every entry is
 *   met. An empty array must never read as "nothing left to satisfy" — that is
 *   the classic `[].every()` fail-open.
 * - {@link assertRemoteAgentsEnabled} throws rather than returning a boolean, so
 *   a caller that forgets to check the result still cannot proceed.
 * - Nothing here reads an environment variable or a build flag. A gate cannot be
 *   opened by a launch argument, only by a commit.
 *
 * The gate list is not invented
 * -----------------------------
 * It is the "Private beta gate" from `dev/remoteagents/04-security.md:385-397`,
 * transcribed item for item. That list is the one the E2EE decision
 * (`dev/remoteagents/09-open-decisions.md:285`, resolved 2026-08-16 and
 * explicitly not softened at `:233`) ratified as a hard requirement before any
 * external beta. The later "Public beta gate" (`04-security.md:399-406`:
 * passkey/magic-link production auth, rate limits, abuse monitoring, push
 * notification controls, retention policy, security review) is intentionally
 * NOT encoded here — this gate governs whether the feature may run at all, not
 * whether it may be offered publicly. Add that tier when it becomes the
 * question.
 *
 * None of these are met in this repository today, and that is expected: there
 * is no network code here at all. The relay is a sibling repo
 * (`D:\projects\packetrelay`). This module's job is to make that state explicit
 * and enforceable instead of incidental.
 */

import { useRemoteAgentsSettingsStore } from "@/stores/remoteAgentsSettingsStore";

export interface RemoteAgentsGate {
  /** Stable identifier, safe to reference from a test or a tracking issue. */
  readonly id: string;
  /** The requirement, worded as `dev/remoteagents/04-security.md` words it. */
  readonly requirement: string;
  /**
   * Whether this repository actually satisfies it. Flip to `true` only in the
   * same change that implements the requirement, and say so in the commit.
   */
  readonly met: boolean;
}

/**
 * `dev/remoteagents/04-security.md:385-397`, the "Private beta gate", verbatim.
 */
export const REMOTE_AGENTS_PRIVATE_BETA_GATES: readonly RemoteAgentsGate[] = [
  { id: "real-account-auth", requirement: "real account auth", met: false },
  {
    id: "device-approval-revocation",
    requirement: "device approval/revocation",
    met: false,
  },
  {
    id: "object-level-authorization-tests",
    requirement: "object-level authorization tests",
    met: false,
  },
  {
    id: "websocket-origin-validation",
    requirement: "WebSocket origin validation",
    met: false,
  },
  { id: "audit-log", requirement: "audit log", met: false },
  {
    id: "payload-encryption",
    requirement: "payload encryption for agent/approval content",
    met: false,
  },
  {
    id: "e2ee-test-vectors",
    requirement: "E2EE test vectors pass in Rust and browser",
    met: false,
  },
  {
    id: "revocation-drops-socket",
    requirement: "revoked active device loses WebSocket within 5 seconds",
    met: false,
  },
  {
    id: "reject-allow-always",
    requirement: "mobile `allow_always` is rejected",
    met: false,
  },
  {
    id: "log-redaction",
    requirement: "cloud logs are scanned for prompt/tool content and pass redaction checks",
    met: false,
  },
  {
    id: "incident-kill-switch",
    requirement: "documented incident kill switch",
    met: false,
  },
] as const;

/** Every gate this repository does not yet satisfy. */
export function unmetRemoteAgentsGates(): RemoteAgentsGate[] {
  return REMOTE_AGENTS_PRIVATE_BETA_GATES.filter((gate) => !gate.met);
}

/**
 * Whether the ratified pre-beta requirements are all satisfied.
 *
 * The `length > 0` conjunct is load-bearing: `[].every(...)` is `true`, so an
 * emptied gate list would otherwise read as full authorization. If the list is
 * ever empty that is a mistake, and a mistake must not open the feature.
 */
export function remoteAgentsGatesMet(): boolean {
  return (
    REMOTE_AGENTS_PRIVATE_BETA_GATES.length > 0 &&
    REMOTE_AGENTS_PRIVATE_BETA_GATES.every((gate) => gate.met)
  );
}

/**
 * The only correct way to ask "may Remote Agents run right now?".
 *
 * User intent alone is never sufficient, and the gates alone are never
 * sufficient either — a user who has not opted in stays off.
 */
export function isRemoteAgentsEnabled(): boolean {
  if (!remoteAgentsGatesMet()) return false;
  return useRemoteAgentsSettingsStore.getState().requested.enabled;
}

/**
 * Reactive form of {@link isRemoteAgentsEnabled} for React render paths.
 *
 * Subscribes to the user preference. The gate list is a module constant, so it
 * cannot change without a reload and does not need to participate.
 */
export function useRemoteAgentsEnabled(): boolean {
  const requested = useRemoteAgentsSettingsStore((state) => state.requested.enabled);
  return remoteAgentsGatesMet() && requested;
}

/**
 * Refuse to proceed unless Remote Agents may run.
 *
 * Throwing rather than returning is the point: a caller who forgets to branch on
 * a boolean still cannot continue. Call this at the top of any function that
 * opens a socket, contacts the relay, registers a device, or exposes desktop
 * capability to a remote peer.
 *
 * @param callSite Identifies the guarded operation in the thrown message, e.g.
 *   `"relayClient.connect"`. Use the same label style as {@link logSwallowed}.
 */
export function assertRemoteAgentsEnabled(callSite: string): void {
  const unmet = unmetRemoteAgentsGates();
  if (unmet.length > 0) {
    throw new Error(
      `${callSite}: Remote Agents is gated off. ` +
        `${unmet.length} of ${REMOTE_AGENTS_PRIVATE_BETA_GATES.length} private-beta ` +
        `requirements are unmet (dev/remoteagents/04-security.md:385): ` +
        `${unmet.map((gate) => gate.id).join(", ")}. ` +
        `The user preference does not override this.`,
    );
  }
  if (!useRemoteAgentsSettingsStore.getState().requested.enabled) {
    throw new Error(`${callSite}: Remote Agents is not enabled by the user.`);
  }
}
