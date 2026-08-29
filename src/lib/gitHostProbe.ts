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
//
// There is no third. The token is never returned by either call, never placed
// in a store, and never interpolated into a message.

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
