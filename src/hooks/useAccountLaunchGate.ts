/**
 * Multi-account REFUSE-TO-LAUNCH gate.
 *
 * A pane bound to an explicit `CliAccount` must start under THAT account's
 * login or not at all. Before the PTY is spawned we probe the account's own
 * config dir; if it is not authenticated we block the launch and tell the user
 * which account needs a login.
 *
 * Why blocking rather than a silent fallback: an unauthenticated
 * `CLAUDE_CONFIG_DIR` does not fail — `claude` happily walks the user through
 * a login, or (if the env were dropped) runs under whatever ambient login
 * exists. Either way private client work could end up billed to, logged under,
 * and rate-limited against the personal/OSS account with NO signal to the user.
 * That is the exact failure this feature exists to prevent, so the gate fails
 * CLOSED: unknown, errored, and missing-account states all block. We never
 * spawn with `{}` env and never fall back to the ambient login.
 *
 * Panes with NO account id are ambient: the gate short-circuits to `"ambient"`
 * before any IPC, so today's behaviour is bit-for-bit unchanged for them (no
 * probe, no event subscription, no blocking UI).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getProviderAuthStatusForDir, type ProviderAuthStatus } from "@/lib/tauri";
import { useCliAccountStore } from "@/stores/cliAccountStore";
import type { CliAccount } from "@/types/cliAccount";
import type { WorkspaceAgentSlot } from "@/types/workspace";

/** Slots that support multi-account binding, and how each maps onto the
 *  provider-auth vocabulary and its `login` binary. */
const SLOT_AUTH: Partial<
  Record<WorkspaceAgentSlot, { provider: string; loginCli: "claude" | "codex" }>
> = {
  "claude-code": { provider: "claude-oauth", loginCli: "claude" },
  codex: { provider: "openai-codex", loginCli: "codex" },
};

export function accountLoginCliForSlot(
  slot: WorkspaceAgentSlot,
): "claude" | "codex" | null {
  return SLOT_AUTH[slot]?.loginCli ?? null;
}

export type AccountLaunchGate =
  /** No explicit account (or a slot with no account support) — ambient login. */
  | { state: "ambient" }
  /** Probe in flight; the launch is held. */
  | { state: "probing"; label: string; account: CliAccount | null }
  /** Authenticated (or indeterminate-but-not-blocking) — the pane may spawn. */
  | { state: "ready"; label: string; account: CliAccount; caveat?: string }
  /** Not authenticated / unresolvable — the launch is refused. */
  | {
      state: "blocked";
      label: string;
      account: CliAccount | null;
      reason: string;
      loginCli: "claude" | "codex" | null;
    };

export interface UseAccountLaunchGateResult {
  gate: AccountLaunchGate;
  /** Re-run the probe (the "Check again" affordance, and post-login). */
  recheck: () => void;
}

export function useAccountLaunchGate(
  slot: WorkspaceAgentSlot,
  accountId: string | null | undefined,
): UseAccountLaunchGateResult {
  const auth = SLOT_AUTH[slot];
  // A bound pane is one with an explicit account on an account-capable slot.
  const bound = !!accountId && !!auth;

  const accounts = useCliAccountStore((s) => s.accounts);
  const account = accountId ? (accounts.find((a) => a.id === accountId) ?? null) : null;
  const configDir = account?.configDir ?? null;
  const label = account?.label ?? (accountId ? "Unknown account" : "");

  const [status, setStatus] = useState<ProviderAuthStatus | "loading" | "error">("loading");
  const [nonce, setNonce] = useState(0);
  const recheck = useCallback(() => setNonce((n) => n + 1), []);

  // Epoch guard so an older probe can never overwrite a newer one (a manual
  // recheck racing a `provider-auth:changed` refresh), and so a late
  // resolution after unmount is a no-op.
  const epochRef = useRef(0);

  useEffect(() => {
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: epoch counter bumped on cleanup to invalidate in-flight probes.
      epochRef.current++;
    };
  }, []);

  useEffect(() => {
    // Ambient panes never probe. This early return is what guarantees the
    // "no new IPC for existing users" property.
    if (!bound) return;
    if (!configDir) {
      // Account id present but the record is gone (deleted mid-session) — we
      // cannot build its env, so we must NOT launch. Blocking here is the
      // whole point; falling through to ambient would be the silent-fallback
      // bug this gate exists to prevent.
      setStatus("error");
      return;
    }
    const epoch = ++epochRef.current;
    setStatus("loading");
    getProviderAuthStatusForDir(auth!.provider, configDir)
      .then((res) => {
        if (epochRef.current !== epoch) return;
        setStatus(res);
      })
      .catch((err) => {
        if (epochRef.current !== epoch) return;
        // Fail CLOSED. A probe we could not complete is not evidence of a
        // healthy login.
        console.warn(
          `getProviderAuthStatusForDir(${auth!.provider}, ${configDir}) failed`,
          err,
        );
        setStatus("error");
      });
  }, [bound, auth, configDir, nonce]);

  // Re-probe when the auth watcher reports a credential change for this
  // account (or, defensively, an un-attributed change for our provider).
  useEffect(() => {
    if (!bound) return;
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    listen<{ provider: string; accountId?: string | null }>(
      "provider-auth:changed",
      (event) => {
        const payload = event.payload ?? ({} as { provider: string; accountId?: string | null });
        const matchesAccount = payload.accountId === accountId;
        const unattributedForOurProvider =
          (payload.accountId === undefined || payload.accountId === null) &&
          payload.provider === auth!.provider;
        if (matchesAccount || unattributedForOurProvider) recheck();
      },
    )
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((err) => {
        console.warn("listen(provider-auth:changed) failed", err);
      });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [bound, auth, accountId, recheck]);

  if (!bound) return { gate: { state: "ambient" }, recheck };

  const loginCli = auth!.loginCli;

  if (!account) {
    return {
      gate: {
        state: "blocked",
        label,
        account: null,
        reason:
          "This pane is bound to a CLI account that no longer exists. Pick an account or remove the pane — it will not fall back to your default login.",
        loginCli: null,
      },
      recheck,
    };
  }

  if (status === "loading") {
    return { gate: { state: "probing", label, account }, recheck };
  }

  if (status === "error") {
    return {
      gate: {
        state: "blocked",
        label,
        account,
        reason: `Could not verify the "${label}" login. Refusing to start rather than risk running under a different account.`,
        loginCli,
      },
      recheck,
    };
  }

  // `ready` already accounts for an expired access token that has a usable
  // refresh token — that parsing lives in the Rust probe and is reused
  // verbatim by the per-dir variant, so it stays launchable here.
  if (status.status === "ready") {
    return { gate: { state: "ready", label, account }, recheck };
  }

  // `unknown` = the probe could not prove either way (macOS Keychain, where
  // per-config-dir namespacing is unconfirmed upstream). Per the probe's own
  // contract this must NOT block a launch: the account env is still injected,
  // so there is no silent ambient fallback — only an unverifiable state. We
  // surface the caveat on the chip instead of refusing.
  if (status.status === "unknown") {
    return {
      gate: { state: "ready", label, account, caveat: status.hint },
      recheck,
    };
  }

  return {
    gate: {
      state: "blocked",
      label,
      account,
      reason: status.hint || `Not signed in to "${label}".`,
      loginCli,
    },
    recheck,
  };
}
