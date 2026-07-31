/**
 * The body a workspace tile shows INSTEAD of a terminal when its bound CLI
 * account is not authenticated.
 *
 * Rendering this in place of `TerminalPane` — rather than merely disabling
 * autoStart — is deliberate: while it is mounted there is no xterm, no
 * `useTerminalSession`, and no "Start session" control wired to a PTY, so
 * there is no code path that could spawn the CLI under the wrong login.
 */
import { KeyRound, Loader2, ShieldAlert } from "lucide-react";
import { getAccountColor } from "@/lib/accountColors";

interface AccountBlockedPaneProps {
  /** Account id — drives the identity color. */
  accountId: string;
  /** Human label, named verbatim in the message and the CTA. */
  label: string;
  /** Why the launch was refused. */
  reason: string;
  /** True while the probe is still in flight. */
  probing?: boolean;
  /** Absent when there is no CLI to log in with (e.g. deleted account). */
  onLogin?: () => void;
  onRecheck: () => void;
}

export function AccountBlockedPane({
  accountId,
  label,
  reason,
  probing = false,
  onLogin,
  onRecheck,
}: AccountBlockedPaneProps) {
  const c = getAccountColor(accountId);

  if (probing) {
    return (
      <div
        data-testid="account-gate-probing"
        className="flex flex-1 flex-col items-center justify-center gap-2 bg-bg-primary p-6 text-center"
      >
        <Loader2 size={18} className="animate-spin text-text-muted" />
        <div className="text-ui text-text-secondary">
          Checking the <span className={`font-medium ${c.text}`}>{label}</span> login…
        </div>
        <div className="max-w-[380px] text-meta text-text-muted">
          The session starts only after this account is confirmed signed in.
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="account-gate-blocked"
      className="flex flex-1 flex-col items-center justify-center gap-3 bg-bg-primary p-6 text-center"
    >
      <ShieldAlert size={20} className="text-accent-amber" />
      <div className="text-ui font-medium text-text-primary">
        Not signed in to <span className={c.text}>{label}</span>
      </div>
      <div className="max-w-[420px] text-meta leading-relaxed text-text-secondary">{reason}</div>
      <div className="max-w-[420px] text-meta leading-relaxed text-text-muted">
        This pane will not start under a different login.
      </div>
      <div className="mt-1 flex items-center gap-2">
        {onLogin && (
          <button
            onClick={onLogin}
            className={`flex items-center gap-1.5 rounded border px-2.5 py-1 text-ui font-medium transition-colors ${c.text} ${c.bg} ${c.border} hover:brightness-125`}
          >
            <KeyRound size={11} />
            Log in to {label}
          </button>
        )}
        <button
          onClick={onRecheck}
          className="rounded border border-bg-border bg-bg-secondary px-2.5 py-1 text-ui text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          Check again
        </button>
      </div>
    </div>
  );
}
