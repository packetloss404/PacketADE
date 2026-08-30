// Binding for `git_host_probe_credential` — the non-persisting credential
// check the git-host setup wizard runs before anything is written to the OS
// keyring.
//
// Lives in its own module rather than `lib/tauri.ts` so the wizard's backend
// surface is reviewable in one place, and so the token's only two exits from
// the frontend are both visible here and in `gitHostWizard.ts`'s `save`:
//
//   1. `probeGitHostCredential` — one outbound request, never persisted.
//   2. the descriptor's `save` — an existing keyring-backed Tauri command.
//   3. `gitHostUpdateConnection` (`lib/tauri.ts`) — rotation on an EXISTING
//      connection, which re-runs (1) inside Rust before it writes, so a token
//      that does not work never displaces one that does.
//
// There is no fourth. The token is never returned by any of them, never placed
// in a store, and never interpolated into a message.
//
// A credential obtained by browser authorisation (GitHub's device flow) never
// enters the frontend at all: Rust parks it and hands back an opaque handle.
// `probePendingDeviceCredential` below is the same probe over that handle, so
// the two credential kinds reach the same `verdictFor` with the same evidence.

import { invoke } from "@tauri-apps/api/core";
import type { GitHostProbeSpec } from "@/lib/gitHostWizard";

export type GitHostProbeOutcome =
  | "ok"
  | "invalid_token"
  | "forbidden"
  | "rate_limited"
  | "not_a_host"
  | "unreachable"
  | "tls_error"
  | "server_error"
  | "unknown";

export interface GitHostProbeResult {
  outcome: GitHostProbeOutcome;
  status: number | null;
  login: string | null;
  avatarUrl: string | null;
  /** `null` means the host does not report grants — not "no scopes". */
  scopes: string[] | null;
  /** Host-derived explanation. Guaranteed token-free by the Rust side. */
  detail: string | null;
  /** The URL that was actually contacted. */
  endpoint: string;
}

/**
 * Validate a credential against a host without saving it anywhere.
 *
 * @param baseUrl normalised origin (no API suffix)
 * @param spec    the descriptor's probe spec — supplies every host-specific
 *                detail, so the Rust side has no per-host branches
 * @param token   used for exactly one request, then dropped
 */
export async function probeGitHostCredential(
  baseUrl: string,
  spec: GitHostProbeSpec,
  token: string,
): Promise<GitHostProbeResult> {
  return invoke<GitHostProbeResult>("git_host_probe_credential", {
    request: {
      baseUrl,
      apiPrefix: spec.apiPrefix,
      identityPath: spec.identityPath,
      authScheme: spec.authScheme,
      accept: spec.accept ?? null,
      scopeHeader: spec.scopeHeader ?? null,
      scopePath: spec.scopePath ?? null,
      scopeField: spec.scopeField ?? null,
      loginFields: spec.loginFields,
      token,
    },
  });
}

/** The descriptor's probe block, wire-shaped. No credential in it. */
export function probeSpecPayload(spec: GitHostProbeSpec) {
  return {
    apiPrefix: spec.apiPrefix,
    identityPath: spec.identityPath,
    authScheme: spec.authScheme,
    accept: spec.accept ?? null,
    scopeHeader: spec.scopeHeader ?? null,
    scopePath: spec.scopePath ?? null,
    scopeField: spec.scopeField ?? null,
    loginFields: spec.loginFields,
  };
}

/**
 * Validate a credential a browser authorisation just minted, which this
 * frontend has never seen and never will: Rust holds it, and `pendingId` is an
 * opaque handle to it. Same command family, same result type, same verdicts —
 * the only difference from {@link probeGitHostCredential} is who is holding the
 * secret, which is the whole point.
 *
 * The origin is NOT a parameter: Rust pins it to the host that minted the
 * credential, so nothing here can redirect it elsewhere.
 */
export async function probePendingDeviceCredential(
  pendingId: string,
  spec: GitHostProbeSpec,
): Promise<GitHostProbeResult> {
  return invoke<GitHostProbeResult>("github_device_flow_probe_pending", {
    pendingId,
    probe: probeSpecPayload(spec),
  });
}
