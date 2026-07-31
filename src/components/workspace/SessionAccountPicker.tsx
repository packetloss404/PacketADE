import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, UserRound } from "lucide-react";
import { useAppStore } from "@/stores/appStore";
import { useCliAccountStore } from "@/stores/cliAccountStore";
import type { CliAccountCli } from "@/types/cliAccount";

/** Caption for the "no account" option — the pre-multi-account behaviour. */
export const AMBIENT_LABEL = "Default login";

interface SessionAccountPickerProps {
  /** Only `claude-code` / `codex` have a vendor config-dir env var. */
  cli: CliAccountCli;
  /**
   * The project path the session will launch in. Drives the sticky default,
   * and is re-read live so a modal whose path changes mid-edit re-resolves.
   */
  projectPath: string;
  /**
   * The caller's explicit selection, or `undefined` to follow the resolved
   * sticky default. `null` is an explicit "use the ambient login".
   */
  value: string | null | undefined;
  onChange: (accountId: string | null) => void;
  /** `chip` is the compact Add-Session-row affordance; `field` is a form row. */
  variant: "chip" | "field";
  /**
   * Field-variant caption. Rendered INSIDE this component so a zero-account
   * install shows no orphaned label above a control that never appeared.
   */
  label?: string;
  disabled?: boolean;
}

/**
 * Multi-account CLI support — the session-creation account selector.
 *
 * Renders nothing when the user has no accounts registered for this CLI, so a
 * zero-config install sees exactly the UI it saw before multi-account existed.
 */
export function SessionAccountPicker({
  cli,
  projectPath,
  value,
  onChange,
  variant,
  label,
  disabled,
}: SessionAccountPickerProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  /**
   * The chip lives inside the picker's `overflow-y-auto` session list, which
   * would clip an absolutely-positioned menu. Anchoring it with `fixed`
   * coordinates taken from the button escapes the clip.
   */
  const [chipAnchor, setChipAnchor] = useState<{ top: number; right: number } | null>(
    null,
  );
  const openSettings = useAppStore((state) => state.openSettings);

  // Subscribe to the stable array and narrow in a memo — selecting a filtered
  // array directly would mint a new reference on every store read.
  const allAccounts = useCliAccountStore((state) => state.accounts);
  const accounts = useMemo(
    () => allAccounts.filter((account) => account.cli === cli),
    [allAccounts, cli],
  );
  // Primitive result, so this stays a safe zustand selector while still
  // re-running whenever the sticky map changes.
  const sticky = useCliAccountStore((state) =>
    projectPath.trim() ? state.defaultFor(projectPath.trim(), cli) : null,
  );

  const resolvedId = useMemo(() => {
    const candidate = value !== undefined ? value : sticky;
    if (!candidate) return null;
    // A sticky default (or a stale caller value) pointing at a deleted account
    // must degrade to ambient, never to a bogus config dir.
    return accounts.some((account) => account.id === candidate) ? candidate : null;
  }, [value, sticky, accounts]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (accounts.length === 0) return null;

  const resolvedLabel =
    accounts.find((account) => account.id === resolvedId)?.label ?? AMBIENT_LABEL;

  const select = (accountId: string | null) => {
    onChange(accountId);
    setOpen(false);
  };

  const menu = open && (
    <div
      className={`z-50 mt-1 min-w-[200px] rounded-md border border-bg-border bg-bg-elevated py-1 shadow-xl ${
        variant === "chip" ? "fixed" : "absolute left-0 top-full w-full"
      }`}
      style={
        variant === "chip" && chipAnchor
          ? { top: chipAnchor.top, right: chipAnchor.right }
          : undefined
      }
      role="listbox"
    >
      <button
        type="button"
        role="option"
        aria-selected={resolvedId === null}
        onClick={() => select(null)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
      >
        <span className="flex-1 truncate">{AMBIENT_LABEL}</span>
        {resolvedId === null && <Check size={10} className="shrink-0 text-accent-green" />}
      </button>
      {accounts.map((account) => (
        <button
          key={account.id}
          type="button"
          role="option"
          aria-selected={resolvedId === account.id}
          onClick={() => select(account.id)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <span className="flex-1 truncate" title={account.email ?? account.configDir}>
            {account.label}
          </span>
          {resolvedId === account.id && (
            <Check size={10} className="shrink-0 text-accent-green" />
          )}
        </button>
      ))}
      <div className="my-1 border-t border-bg-border" />
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          openSettings({ section: "cli-clients", cliId: cli });
        }}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-meta text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
      >
        Manage accounts…
      </button>
    </div>
  );

  if (variant === "chip") {
    return (
      <div className="relative shrink-0" ref={anchorRef}>
        <button
          ref={buttonRef}
          type="button"
          disabled={disabled}
          onClick={(event) => {
            // The row behind the chip is the one-click "add with the resolved
            // default" path — opening the chip must not also add a pane.
            event.stopPropagation();
            const rect = buttonRef.current?.getBoundingClientRect();
            if (rect) {
              setChipAnchor({
                top: rect.bottom,
                right: Math.max(0, window.innerWidth - rect.right),
              });
            }
            setOpen((prev) => !prev);
          }}
          title={`Account for this ${cli} session — click to switch before adding`}
          className={`inline-flex max-w-[130px] items-center gap-1 rounded border px-1.5 py-0.5 text-meta transition-colors ${
            resolvedId
              ? "border-accent-green/30 bg-accent-green/10 text-accent-green"
              : "border-bg-border text-text-muted hover:text-text-secondary"
          } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
        >
          <UserRound size={9} className="shrink-0" />
          <span className="truncate">{resolvedLabel}</span>
          <ChevronDown size={9} className="shrink-0" />
        </button>
        {menu}
      </div>
    );
  }

  return (
    <div ref={anchorRef}>
      {label && (
        <label className="mb-1.5 block text-meta uppercase tracking-wider text-text-muted">
          {label}
        </label>
      )}
      <div className="relative">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((prev) => !prev)}
          className="flex w-full items-center gap-2 rounded border border-bg-border bg-bg-primary px-3 py-1.5 text-left text-ui transition-colors hover:border-text-muted/30"
        >
          <UserRound
            size={11}
            className={resolvedId ? "text-accent-green" : "text-text-muted"}
          />
          <span className="flex-1 truncate text-text-primary">{resolvedLabel}</span>
          <ChevronDown
            size={10}
            className={`shrink-0 text-text-muted transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
        {menu}
      </div>
    </div>
  );
}
