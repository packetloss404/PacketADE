/**
 * The multi-account safeguard that catches a mis-pick.
 *
 * Two tiles running the same CLI under two different logins are otherwise
 * pixel-identical, so every pane bound to an explicit CLI account carries a
 * stable, color-coded chip (headers) or dot (dense strips). Panes with no
 * account run the ambient login — today's exact behaviour — and deliberately
 * render NOTHING new, so the chip's presence is itself the signal.
 */
import { useCliAccountStore } from "@/stores/cliAccountStore";
import { accountLabel } from "@/lib/sessionAccountDefaults";
import { getAccountColor } from "@/lib/accountColors";

interface AccountChipProps {
  /** Null/undefined = ambient login ⇒ renders nothing. */
  accountId?: string | null;
  /** Optional label override; otherwise resolved from the account store. */
  label?: string;
  /** Appended to the tooltip — e.g. the macOS "couldn't verify" caveat the
   *  auth probe returns as `unknown`. */
  caveat?: string;
  /** Extra classes for the outer pill. */
  className?: string;
}

/**
 * Reactive label for an account id.
 *
 * The shared `accountLabel` helper is a one-shot `getState()` read, which is
 * right for its imperative callers but wrong for a chip: accounts hydrate
 * asynchronously from the persisted backend slice and can be renamed, and a
 * chip that resolved once would sit on a stale name. So subscribe to the one
 * label we care about, and fall back to the shared helper for the vocabulary
 * (deleted account ⇒ "Unknown account") so the wording lives in one place.
 */
function useAccountLabel(accountId?: string | null): string | null {
  const live = useCliAccountStore((s) =>
    accountId ? s.accounts.find((a) => a.id === accountId)?.label : undefined,
  );
  if (!accountId) return null;
  return live ?? accountLabel(accountId);
}

/** Labelled pill — for header rows with room for text. */
export function AccountChip({ accountId, label, caveat, className = "" }: AccountChipProps) {
  const resolved = useAccountLabel(accountId);
  if (!accountId) return null;
  const text = label ?? resolved ?? "Unknown account";
  const c = getAccountColor(accountId);
  return (
    <span
      data-testid="account-chip"
      data-account-id={accountId}
      title={caveat ? `CLI account: ${text} — ${caveat}` : `CLI account: ${text}`}
      className={`flex min-w-0 shrink items-center gap-1 rounded-full border px-1.5 py-0.5 text-meta font-medium ${c.text} ${c.bg} ${c.border} ${className}`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${c.text} bg-current`} />
      <span className="truncate">{text}</span>
    </span>
  );
}

/** Bare dot — for dense strips (tab bars, badge rows) with no room for text. */
export function AccountDot({ accountId, label, className = "" }: AccountChipProps) {
  const resolved = useAccountLabel(accountId);
  if (!accountId) return null;
  const text = label ?? resolved ?? "Unknown account";
  const c = getAccountColor(accountId);
  return (
    <span
      data-testid="account-dot"
      data-account-id={accountId}
      title={`CLI account: ${text}`}
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${c.text} bg-current ${className}`}
    />
  );
}
