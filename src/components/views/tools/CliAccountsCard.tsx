/**
 * Settings surface for named CLI logins (multi-account).
 *
 * Each row is a *pointer* at a config directory — `CLAUDE_CONFIG_DIR` for
 * Claude Code, `CODEX_HOME` for Codex — which is the whole mechanism. There
 * are no secrets on this screen, and deleting a row deletes the record, never
 * the directory or the login inside it.
 *
 * The "Log in" button performs no side effect of its own: it calls the
 * `onRequestLogin` prop and nothing else. `ToolsView` supplies that prop and
 * opens `AccountLoginModal`, which runs the interactive `claude login` /
 * `codex login` PTY against the row's config dir — so the button IS wired in
 * the app. The prop stays optional so the card renders standalone (in tests,
 * or any surface that has no login flow) with the button disabled.
 */
import { useEffect, useMemo, useState } from "react";
import { FolderOpen, KeyRound, LogIn, Pencil, Plus, Trash2, UserCog } from "lucide-react";
import { homeDir } from "@tauri-apps/api/path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDeleteModal } from "@/components/ui/ConfirmDeleteModal";
import { useCliAccountStore } from "@/stores/cliAccountStore";
import {
  suggestConfigDir,
  validateCliAccount,
  type CliAccountValidationResult,
} from "@/lib/cliAccountPaths";
import { relativeTime } from "@/lib/time";
import {
  CLI_ACCOUNT_CLIS,
  CLI_ACCOUNT_ENV_VAR,
  CLI_ACCOUNT_LABELS,
} from "@/types/cliAccount";
import type { CliAccount, CliAccountCli } from "@/types/cliAccount";
import { APP_NAME } from "@/lib/brand";

export interface CliAccountsCardProps {
  /**
   * SEAM for the interactive login flow. Called with the account whose
   * "Log in" button was pressed; this card performs no side effect of its
   * own. `ToolsView` wires it to `AccountLoginModal`, which runs a transient
   * PTY for `claude login` / `codex login` with
   * `CLI_ACCOUNT_ENV_VAR[account.cli]` set to `account.configDir`.
   * Left undefined the button still renders, disabled, so the row layout
   * does not shift on surfaces that have no login flow.
   */
  onRequestLogin?: (account: CliAccount) => void;
}

/** Resolve the user's home dir once; `""` until it lands (or if it fails). */
function useHomeDir(): string {
  const [home, setHome] = useState("");
  useEffect(() => {
    let cancelled = false;
    void homeDir()
      .then((dir) => {
        if (!cancelled) setHome(dir.replace(/[\\/]+$/, ""));
      })
      .catch(() => {
        // Non-fatal: without a home dir we lose the `~/.claude-x` suggestion
        // and the default-dir guard, but an absolute path typed by hand still
        // validates and saves.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return home;
}

export function CliAccountsCard({ onRequestLogin }: CliAccountsCardProps = {}) {
  const accounts = useCliAccountStore((s) => s.accounts);
  const addAccount = useCliAccountStore((s) => s.addAccount);
  const updateAccount = useCliAccountStore((s) => s.updateAccount);
  const deleteAccount = useCliAccountStore((s) => s.deleteAccount);
  const home = useHomeDir();

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<CliAccount | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CliAccount | null>(null);

  function openAdd() {
    setEditing(null);
    setShowForm(true);
  }

  function openEdit(account: CliAccount) {
    setEditing(account);
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditing(null);
  }

  function handleSubmit(input: Omit<CliAccount, "id" | "createdAt">) {
    if (editing) {
      updateAccount(editing.id, input);
    } else {
      addAccount(input);
    }
    closeForm();
  }

  function confirmDelete() {
    if (!pendingDelete) return;
    deleteAccount(pendingDelete.id);
    setPendingDelete(null);
  }

  return (
    <div className="rounded-lg border border-bg-border bg-bg-secondary p-4">
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-xs font-semibold text-text-primary">
          <UserCog size={12} className="text-accent-blue" />
          CLI Accounts
        </h3>
        <button
          onClick={openAdd}
          // Explicit accessible name: the modal's submit button also reads
          // "Add account", and two identically-named buttons is a real
          // ambiguity for screen readers, not just for tests.
          aria-label="Add CLI account"
          className="hover:bg-accent-green/10 flex items-center gap-1 rounded px-2 py-1 text-[11px] text-accent-green transition-colors"
        >
          <Plus size={11} />
          Add account
        </button>
      </div>
      <p className="mb-4 text-[11px] leading-relaxed text-text-muted">
        Run Claude Code and Codex under more than one login by pointing each at its own config
        directory ({CLI_ACCOUNT_ENV_VAR["claude-code"]} / {CLI_ACCOUNT_ENV_VAR.codex}). Sessions
        with no account selected keep using your normal login.
      </p>

      {accounts.length === 0 ? (
        <p className="py-6 text-center text-[10px] text-text-muted">
          No CLI accounts yet. Your existing login keeps working — add an account only when you
          need a second one.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-bg-border">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="bg-bg-primary text-left text-text-muted">
                <th className="px-3 py-2 font-medium">Account</th>
                <th className="px-3 py-2 font-medium">CLI</th>
                <th className="px-3 py-2 font-medium">Config directory</th>
                <th className="px-3 py-2 font-medium">Email</th>
                <th className="px-3 py-2 font-medium">Last used</th>
                <th className="w-24 px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr
                  key={account.id}
                  className="border-t border-bg-border transition-colors hover:bg-bg-hover"
                >
                  <td className="px-3 py-2 font-medium text-text-primary">{account.label}</td>
                  <td className="px-3 py-2">
                    <span className="bg-bg-elevated rounded px-1.5 py-0.5 text-[9px] text-text-secondary">
                      {CLI_ACCOUNT_LABELS[account.cli] ?? account.cli}
                    </span>
                  </td>
                  <td
                    className="max-w-[220px] truncate px-3 py-2 font-mono text-[10px] text-text-secondary"
                    title={account.configDir}
                  >
                    {account.configDir}
                  </td>
                  <td className="px-3 py-2 text-text-secondary">{account.email || "—"}</td>
                  <td className="px-3 py-2 text-text-muted">
                    {account.lastUsedAt ? relativeTime(account.lastUsedAt) : "Never"}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => onRequestLogin?.(account)}
                        disabled={!onRequestLogin}
                        className="hover:text-accent-green flex items-center gap-1 rounded p-1 text-text-muted transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                        title={`Log in to ${account.label}`}
                        aria-label={`Log in to ${account.label}`}
                      >
                        <LogIn size={10} />
                      </button>
                      <button
                        onClick={() => openEdit(account)}
                        className="p-1 text-text-muted transition-colors hover:text-accent-blue"
                        title={`Edit ${account.label}`}
                        aria-label={`Edit ${account.label}`}
                      >
                        <Pencil size={10} />
                      </button>
                      <button
                        onClick={() => setPendingDelete(account)}
                        className="p-1 text-text-muted transition-colors hover:text-accent-red"
                        title={`Delete ${account.label}`}
                        aria-label={`Delete ${account.label}`}
                      >
                        <Trash2 size={10} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <CliAccountFormModal
          initial={editing ?? undefined}
          home={home}
          existingAccounts={accounts}
          onSubmit={handleSubmit}
          onClose={closeForm}
        />
      )}

      {pendingDelete && (
        <ConfirmDeleteModal
          title="Delete CLI account?"
          entityName={`${pendingDelete.label} (${CLI_ACCOUNT_LABELS[pendingDelete.cli] ?? pendingDelete.cli})`}
          description={
            <>
              is removed from {APP_NAME}, along with any project that defaults to it. The config
              directory <span className="font-mono">{pendingDelete.configDir}</span> and the login
              inside it are left untouched on disk — re-add the account to use it again.
            </>
          }
          confirmLabel="Delete account"
          undoNote="Panes currently set to this account fall back to your normal login."
          onConfirm={confirmDelete}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

interface CliAccountFormModalProps {
  initial?: CliAccount;
  home: string;
  existingAccounts: CliAccount[];
  onSubmit: (input: Omit<CliAccount, "id" | "createdAt">) => void;
  onClose: () => void;
}

function CliAccountFormModal({
  initial,
  home,
  existingAccounts,
  onSubmit,
  onClose,
}: CliAccountFormModalProps) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [cli, setCli] = useState<CliAccountCli>(initial?.cli ?? "claude-code");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [configDir, setConfigDir] = useState(initial?.configDir ?? "");
  /** Until the user edits or picks a directory, the field follows the label. */
  const [configDirTouched, setConfigDirTouched] = useState(Boolean(initial));
  /** Errors stay hidden until the first submit, so a half-typed form is quiet. */
  const [submitted, setSubmitted] = useState(false);

  const suggestion = useMemo(
    () => (home ? suggestConfigDir(cli, label, home) : ""),
    [cli, home, label],
  );
  const effectiveConfigDir = configDirTouched ? configDir : suggestion;

  const validation: CliAccountValidationResult = useMemo(
    () =>
      validateCliAccount({
        label,
        cli,
        configDir: effectiveConfigDir,
        home,
        accounts: existingAccounts,
        editingId: initial?.id ?? null,
      }),
    [cli, effectiveConfigDir, existingAccounts, home, initial?.id, label],
  );
  const isValid = Object.keys(validation.errors).length === 0;

  async function handleBrowse() {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: "Choose a config directory for this account",
    });
    if (typeof picked === "string") {
      setConfigDirTouched(true);
      setConfigDir(picked);
    }
  }

  function handleSubmit() {
    setSubmitted(true);
    if (!isValid) return;
    onSubmit({
      label: label.trim(),
      cli,
      // Persist the resolved path so a stored `~` can never be handed to a
      // PTY env var, where nothing would expand it.
      configDir: validation.resolvedConfigDir,
      email: email.trim() || undefined,
    });
  }

  const showErrors = submitted;

  return (
    <Modal
      onClose={onClose}
      title={initial ? "Edit CLI account" : "Add CLI account"}
      icon={<KeyRound size={14} className="text-accent-blue" />}
      width="w-[520px]"
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-text-secondary transition-colors hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            className="border-accent-green/30 bg-accent-green/15 hover:bg-accent-green/25 rounded border px-4 py-1.5 text-xs font-medium text-accent-green transition-colors"
          >
            {initial ? "Save" : "Add account"}
          </button>
        </div>
      }
    >
      <div className="space-y-3 p-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="cli-account-label" className="text-[11px] font-medium text-text-secondary">
            Name
          </label>
          <input
            id="cli-account-label"
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Client work"
            className="focus:border-accent-green/50 rounded border border-bg-border bg-bg-primary px-3 py-2 text-xs text-text-primary outline-none"
          />
          {showErrors && validation.errors.label && (
            <p className="text-[10px] text-accent-red">{validation.errors.label}</p>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="cli-account-cli" className="text-[11px] font-medium text-text-secondary">
            CLI
          </label>
          <select
            id="cli-account-cli"
            value={cli}
            onChange={(e) => setCli(e.target.value as CliAccountCli)}
            className="focus:border-accent-green/50 rounded border border-bg-border bg-bg-primary px-3 py-2 text-xs text-text-primary outline-none"
          >
            {CLI_ACCOUNT_CLIS.map((option) => (
              <option key={option} value={option}>
                {CLI_ACCOUNT_LABELS[option]}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label
            htmlFor="cli-account-config-dir"
            className="text-[11px] font-medium text-text-secondary"
          >
            Config directory
          </label>
          <div className="flex items-center gap-2">
            <input
              id="cli-account-config-dir"
              type="text"
              value={effectiveConfigDir}
              onChange={(e) => {
                setConfigDirTouched(true);
                setConfigDir(e.target.value);
              }}
              placeholder={suggestion || "/home/you/.claude-work"}
              className="focus:border-accent-green/50 flex-1 rounded border border-bg-border bg-bg-primary px-3 py-2 font-mono text-[11px] text-text-primary outline-none"
            />
            <button
              type="button"
              onClick={handleBrowse}
              className="flex items-center gap-1 rounded border border-bg-border px-2 py-2 text-[11px] text-text-secondary transition-colors hover:bg-bg-hover"
            >
              <FolderOpen size={11} />
              Browse
            </button>
          </div>
          {showErrors && validation.errors.configDir && (
            <p className="text-[10px] text-accent-red">{validation.errors.configDir}</p>
          )}
          <p className="text-[10px] leading-relaxed text-text-muted">
            Sessions for this account run with{" "}
            <span className="font-mono">{CLI_ACCOUNT_ENV_VAR[cli]}</span> set to this path. The CLI
            creates the directory on first login and keeps everything — credentials, settings, MCP
            config, history — inside it.
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="cli-account-email" className="text-[11px] font-medium text-text-secondary">
            Email <span className="text-text-muted">(optional)</span>
          </label>
          <input
            id="cli-account-email"
            type="text"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="focus:border-accent-green/50 rounded border border-bg-border bg-bg-primary px-3 py-2 text-xs text-text-primary outline-none"
          />
          <p className="text-[10px] text-text-muted">
            Shown in the account list only. It is never used to sign in or to match an account.
          </p>
        </div>
      </div>
    </Modal>
  );
}
