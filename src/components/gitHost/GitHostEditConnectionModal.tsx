// Edit an EXISTING git-host connection: rotate its token, rename it, or both.
//
// Why this is not the setup wizard. The wizard's job is "which host, at what
// address, with what credential" — four steps, three of which are already
// answered for a connection that exists. Worse, its last step *adds* a
// connection: `git_host_add_connection` mints a fresh id, so re-running the
// wizard against a host you already have produces a second connection rather
// than rotating the first. That is precisely the gap this modal closes, so it
// could not be closed by reopening the wizard.
//
// What it does reuse is everything that matters for correctness: the same
// descriptor (`descriptorForKind`), the same probe, the same nine verdicts
// (`verdictFor`), and the same `ScopeList` / `VerdictCard` presentation. A
// rotating user reads the identical diagnosis a first-time user reads.
//
// SECURITY (see also `lib/gitHostProbe.ts`):
//  * The token lives in one piece of component state. It reaches exactly two
//    backend calls — the non-persisting probe, and `gitHostUpdateConnection`,
//    which probes again in Rust before it writes — and is wiped on unmount, on
//    cancelling the rotation, and immediately after a successful save.
//  * `type="password"`, `autoComplete="off"`, no reveal toggle.
//  * No message rendered here is built from the token: verdicts come from
//    `verdictFor` (given the probe result only) and save failures come from
//    Rust, which builds them from the outcome class alone.
//  * The frontend verdict is advisory. The authority that a bad credential
//    never displaces a good one is the Rust-side probe inside the update
//    command — which is why this modal cannot skip validation by not calling
//    one.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { KeyRound, Loader2, Lock, Pencil } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { HostIcon } from "@/components/HostIcon";
import { GITHUB_CONNECTION_ID, hostLabel } from "@/lib/git-hosts";
import { probeGitHostCredential } from "@/lib/gitHostProbe";
import { descriptorForKind, verdictFor, type WizardVerdict } from "@/lib/gitHostWizard";
import { FieldError, ScopeList, VerdictCard } from "@/components/gitHost/GitHostVerdict";
import type { GitHostConnectionInfo, GitHostConnectionUpdate } from "@/lib/tauri";
import { APP_NAME } from "@/lib/brand";

interface GitHostEditConnectionModalProps {
  connection: GitHostConnectionInfo;
  /** Persists the edit. The token, when present, goes no further than here. */
  onSave: (id: string, update: GitHostConnectionUpdate) => Promise<void>;
  onClose: () => void;
}

export function GitHostEditConnectionModal({
  connection,
  onSave,
  onClose,
}: GitHostEditConnectionModalProps) {
  const descriptor = descriptorForKind(connection.kind);
  // The GitHub connection is seeded implicitly on every launch and is excluded
  // from `git-hosts.json`, so a renamed label would silently revert at restart.
  // The backend refuses it; say so here rather than offering a dead field.
  const labelEditable = connection.id !== GITHUB_CONNECTION_ID;

  const [label, setLabel] = useState(connection.label);
  const [rotating, setRotating] = useState(false);
  // The credential. Component state only — never a store, never persisted.
  const [token, setToken] = useState("");

  const [verifying, setVerifying] = useState(false);
  const [verdict, setVerdict] = useState<WizardVerdict | null>(null);
  const [probeEndpoint, setProbeEndpoint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      setToken("");
    };
  }, []);

  const fieldId = useId();
  const labelFieldId = `${fieldId}-label`;
  const tokenFieldId = `${fieldId}-token`;

  const trimmedLabel = label.trim();
  const labelChanged = labelEditable && trimmedLabel !== connection.label;
  const labelValid = trimmedLabel.length > 0;

  function cancelRotation() {
    setRotating(false);
    setToken("");
    setVerdict(null);
    setProbeEndpoint(null);
    setError(null);
  }

  const runVerification = useCallback(async () => {
    if (!descriptor) return;
    setVerifying(true);
    setVerdict(null);
    setError(null);
    try {
      const result = await probeGitHostCredential(connection.baseUrl, descriptor.probe, token);
      if (!mountedRef.current) return;
      setProbeEndpoint(result.endpoint);
      setVerdict(verdictFor(descriptor, result));
    } catch (e) {
      if (!mountedRef.current) return;
      // Argument-level rejection from the probe command (unencodable token,
      // malformed descriptor path). Rust never puts the token in these.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setVerifying(false);
    }
  }, [descriptor, connection.baseUrl, token]);

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const update: GitHostConnectionUpdate = {
        // Asserted, never changed: the backend refuses the whole update if
        // either has drifted from what it has stored.
        kind: connection.kind,
        baseUrl: connection.baseUrl,
      };
      if (labelChanged) update.label = trimmedLabel;
      if (rotating && token.trim() && descriptor) {
        update.token = token;
        update.probe = {
          apiPrefix: descriptor.probe.apiPrefix,
          identityPath: descriptor.probe.identityPath,
          authScheme: descriptor.probe.authScheme,
          accept: descriptor.probe.accept ?? null,
          scopeHeader: descriptor.probe.scopeHeader ?? null,
          scopePath: descriptor.probe.scopePath ?? null,
          scopeField: descriptor.probe.scopeField ?? null,
          loginFields: descriptor.probe.loginFields,
        };
      }
      await onSave(connection.id, update);
      setToken("");
      if (!mountedRef.current) return;
      onClose();
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  // A rotation may only be saved on a green (or explicitly saveable) verdict,
  // and the verdict is cleared whenever the token changes — so a verdict can
  // never authorise a credential it was not run against.
  const canSave = rotating
    ? Boolean(verdict?.canSave) && !verifying && (!labelChanged || labelValid)
    : labelChanged && labelValid;

  const footer = (
    <div className="flex items-center justify-between gap-3">
      <span className="inline-flex items-center gap-1 text-[10px] text-text-muted">
        <Lock size={10} />
        Tokens are stored in the OS keyring.
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="rounded px-2.5 py-1 text-[11px] text-text-muted transition-colors hover:text-text-primary disabled:opacity-40"
        >
          Cancel
        </button>
        {rotating && !verdict && (
          <button
            type="button"
            onClick={() => void runVerification()}
            disabled={!token.trim() || verifying}
            className="rounded border border-accent-green/30 bg-accent-green/15 px-3 py-1 text-[11px] font-medium text-accent-green transition-colors hover:bg-accent-green/25 disabled:opacity-40"
          >
            {verifying ? "Checking…" : "Verify token"}
          </button>
        )}
        {rotating && verdict && (
          <button
            type="button"
            onClick={() => void runVerification()}
            disabled={verifying || saving}
            className="rounded px-2.5 py-1 text-[11px] text-text-muted transition-colors hover:text-text-primary disabled:opacity-40"
          >
            Verify again
          </button>
        )}
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!canSave || saving}
          className="rounded border border-accent-green/30 bg-accent-green/15 px-3 py-1 text-[11px] font-medium text-accent-green transition-colors hover:bg-accent-green/25 disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
  );

  return (
    <Modal
      onClose={saving ? () => {} : onClose}
      closeDisabled={saving}
      title={`Edit ${connection.label}`}
      icon={<Pencil size={14} className="text-accent-green" />}
      width="w-[520px] max-w-[94vw]"
      footer={footer}
    >
      <div className="flex flex-col gap-3 px-5 py-4">
        {/* Identity — deliberately read-only. */}
        <div className="rounded border border-bg-border bg-bg-primary px-3 py-2.5">
          <div className="flex items-center gap-2">
            <HostIcon kind={connection.kind} size={12} className="shrink-0 text-text-muted" />
            <span className="text-[11px] text-text-primary">{hostLabel(connection.kind)}</span>
          </div>
          <div className="mt-1 break-all font-mono text-[10px] text-text-secondary">
            {connection.baseUrl}
          </div>
          <p className="mt-1.5 text-[10px] leading-snug text-text-muted">
            The host and its address cannot be changed here — a different address is a different
            connection, with its own token. Add a host instead.
          </p>
        </div>

        {/* Display name */}
        {labelEditable ? (
          <div>
            <label
              htmlFor={labelFieldId}
              className="mb-1 block text-[11px] font-medium text-text-secondary"
            >
              Display name
            </label>
            <input
              id={labelFieldId}
              type="text"
              autoComplete="off"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-full rounded border border-bg-border bg-bg-primary px-2 py-1.5 text-[11px] text-text-primary outline-none placeholder:text-text-muted focus:border-accent-green"
            />
            {!labelValid && <div className="mt-1"><FieldError message="Display name cannot be empty." /></div>}
          </div>
        ) : (
          <p className="text-[10px] leading-snug text-text-muted">
            The built-in GitHub connection&apos;s name is fixed; only its token can be changed here.
          </p>
        )}

        {/* Token */}
        {!rotating && (
          <div className="flex items-center justify-between gap-2 rounded border border-bg-border bg-bg-primary px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-[11px] text-text-primary">
                {connection.hasToken ? "Access token stored" : "No token stored"}
              </div>
              <p className="mt-0.5 text-[10px] leading-snug text-text-muted">
                {connection.hasToken
                  ? "Renaming does not touch it. Replace it when it expires or is revoked — the current one keeps working unless the new one verifies."
                  : "This connection has no working credential. Add one to use it."}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setRotating(true);
                setError(null);
              }}
              disabled={!descriptor}
              className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[10px] text-accent-green transition-colors hover:bg-accent-green/10 disabled:opacity-40"
            >
              <KeyRound size={10} />
              {connection.hasToken ? "Replace token" : "Add token"}
            </button>
          </div>
        )}

        {rotating && descriptor && (
          <div className="flex flex-col gap-3">
            <ScopeList descriptor={descriptor} origin={connection.baseUrl} />
            <div>
              <label
                htmlFor={tokenFieldId}
                className="mb-1 block text-[11px] font-medium text-text-secondary"
              >
                New {descriptor.tokenLabel.toLowerCase()}
              </label>
              <input
                id={tokenFieldId}
                type="password"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-1p-ignore="true"
                data-lpignore="true"
                value={token}
                onChange={(e) => {
                  setToken(e.target.value);
                  // A verdict belongs to the token it was run against.
                  setVerdict(null);
                  setProbeEndpoint(null);
                }}
                placeholder={descriptor.tokenPlaceholder}
                aria-describedby={`${tokenFieldId}-help`}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && token.trim() && !verifying) void runVerification();
                }}
                className="w-full rounded border border-bg-border bg-bg-primary px-2 py-1.5 text-[11px] text-text-primary outline-none placeholder:text-text-muted focus:border-accent-green"
                autoFocus
              />
              <p
                id={`${tokenFieldId}-help`}
                className="mt-1 flex items-start gap-1.5 text-[10px] text-text-muted"
              >
                <Lock size={10} className="mt-0.5 flex-shrink-0" />
                Checked against {hostLabel(connection.kind)} before it replaces the stored one. If it
                does not work, nothing changes and the current token keeps working.
              </p>
              <button
                type="button"
                onClick={cancelRotation}
                className="mt-1 text-[10px] text-text-muted underline-offset-2 hover:text-text-primary hover:underline"
              >
                Keep the current token
              </button>
            </div>

            {verifying && (
              <div role="status" className="flex items-center gap-2 text-[11px] text-text-secondary">
                <Loader2 size={12} className="animate-spin" />
                Checking {connection.baseUrl}…
              </div>
            )}
            {!verifying && verdict && <VerdictCard verdict={verdict} endpoint={probeEndpoint} />}
          </div>
        )}

        {rotating && !descriptor && (
          <FieldError message={`${APP_NAME} does not know how to verify a token for this host kind, so it will not replace the working one.`} />
        )}

        {error && <FieldError message={error} />}
      </div>
    </Modal>
  );
}
