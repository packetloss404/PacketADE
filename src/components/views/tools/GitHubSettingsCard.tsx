import { useEffect, useState } from "react";
import {
  Github,
  GitMerge,
  LogOut,
  Pencil,
  Plus,
  Server,
  ShieldAlert,
  Trash2,
  Wand2,
} from "lucide-react";
import {
  useGitHubStore,
  type GitHubMergeStrategy,
} from "@/stores/githubStore";
import { ConfirmDeleteModal } from "@/components/ui/ConfirmDeleteModal";
import { HostIcon } from "@/components/HostIcon";
import { hostLabel } from "@/lib/git-hosts";
import { GitHostSetupWizard } from "@/components/gitHost/GitHostSetupWizard";
import { GitHostEditConnectionModal } from "@/components/gitHost/GitHostEditConnectionModal";
import type { GitHostConnectionInfo } from "@/lib/tauri";

/**
 * v0.8: Settings → GitHub card.
 *
 * Connecting a host is NOT done here. This card used to carry its own inline
 * form — a token field, plus a "or authorize with GitHub (device flow)" link
 * that only appeared once you had opened that field. That made two connect
 * paths with different powers: the guided wizard validated the credential and
 * checked its scopes but only accepted a pasted token, while the inline form
 * was the only route to browser authorisation and checked nothing. Whichever
 * one a user found, they gave something up. Both credential kinds now live in
 * `GitHostSetupWizard`, and this card links to it.
 *
 * What remains here are the GitHub-related toggles that used to be hardcoded or
 * sprinkled across other surfaces:
 *  - Disconnect, and the entry point to connect/reconnect.
 *  - Default merge strategy (was hardcoded `"squash"` in `PRActionBar`).
 *  - "Require confirmation" gate for destructive PR actions in
 *    `PRActionBar` (merge / close / convert-to-draft).
 *  - Default "Open as draft" check in `PRModal`.
 *  - Default "Publish attempts as draft PRs" check in
 *    `LaunchAsyncFlightModal` (async Flight launcher).
 */
export function GitHubSettingsCard() {
  const isConnected = useGitHubStore((s) => s.isConnected);
  const authenticatedUser = useGitHubStore((s) => s.authenticatedUser);
  const isLoading = useGitHubStore((s) => s.isLoading);
  const error = useGitHubStore((s) => s.error);
  const disconnect = useGitHubStore((s) => s.disconnect);

  const defaultMergeStrategy = useGitHubStore((s) => s.defaultMergeStrategy);
  const requireMergeConfirmation = useGitHubStore(
    (s) => s.requireMergeConfirmation,
  );
  const defaultDraftPrs = useGitHubStore((s) => s.defaultDraftPrs);
  const defaultPublishAttemptsAsPrs = useGitHubStore(
    (s) => s.defaultPublishAttemptsAsPrs,
  );
  const setDefaultMergeStrategy = useGitHubStore(
    (s) => s.setDefaultMergeStrategy,
  );
  const setRequireMergeConfirmation = useGitHubStore(
    (s) => s.setRequireMergeConfirmation,
  );
  const setDefaultDraftPrs = useGitHubStore((s) => s.setDefaultDraftPrs);
  const setDefaultPublishAttemptsAsPrs = useGitHubStore(
    (s) => s.setDefaultPublishAttemptsAsPrs,
  );

  // Every git-host connection other than the built-in GitHub singleton.
  //
  // FAULT this fixes: this list was filtered to `c.kind === "gitea"` and the
  // section was titled "Self-hosted (Gitea / Forgejo)". Once GitLab became a
  // first-class kind — addable through the very wizard this card opens — a
  // saved GitLab connection was filtered out of the only surface that lists
  // connections. It could not be seen, and since Remove is the per-row trash
  // button, it could not be removed either: a token sitting in the OS keyring
  // with no reachable control. The filter is now "not the built-in GitHub
  // connection", which is the actual rule, so the next kind appears here the
  // day it becomes addable rather than the day someone remembers this line.
  const connections = useGitHubStore((s) => s.connections);
  const activeConnectionId = useGitHubStore((s) => s.activeConnectionId);
  const loadConnections = useGitHubStore((s) => s.loadConnections);
  const setActiveConnection = useGitHubStore((s) => s.setActiveConnection);
  const removeGitHostConnection = useGitHubStore((s) => s.removeGitHostConnection);
  const updateGitHostConnection = useGitHubStore((s) => s.updateGitHostConnection);
  const additionalConnections = connections.filter((c) => c.kind !== "github");

  // The inline "paste a URL + a token and hope" form was replaced by the
  // guided wizard, which validates the credential before anything is written.
  // An undefined `descriptorId` opens the wizard on its own host picker —
  // the only route to GitLab (and to the explained GitHub Enterprise
  // dead-end) from this card, now that more than one self-hosted kind exists.
  const [wizard, setWizard] = useState<{ descriptorId?: string } | null>(null);
  const [pendingHostRemoval, setPendingHostRemoval] = useState<{
    id: string;
    label: string;
    baseUrl: string;
  } | null>(null);
  // Rotate a token / rename a host in place. Before this existed the card's own
  // help text told users to remove the connection and add it back, which meant
  // routinely dropping the only working credential to replace an expiring one.
  const [editingConnection, setEditingConnection] = useState<GitHostConnectionInfo | null>(null);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  async function handleDisconnect() {
    await disconnect();
  }

  return (
    <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
      <h3 className="text-xs font-semibold text-text-primary mb-3 flex items-center gap-2">
        <Github size={12} className="text-text-primary" />
        GitHub
      </h3>

      {/* Connection status */}
      <div className="flex items-center justify-between gap-3 bg-bg-primary border border-bg-border rounded-lg px-3 py-2.5 mb-4">
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className={`w-2 h-2 rounded-full flex-shrink-0 ${
              isConnected ? "bg-accent-green" : "bg-text-muted/30"
            }`}
          />
          <div className="min-w-0">
            {isConnected ? (
              <>
                <div className="text-[11px] font-medium text-accent-green truncate">
                  Connected to {authenticatedUser?.login ?? "user"}
                </div>
                <div className="text-[10px] text-text-muted">
                  Credential stored in the OS keyring
                </div>
              </>
            ) : (
              <>
                <div className="text-[11px] font-medium text-text-muted">
                  Not connected
                </div>
                <div className="text-[10px] text-text-muted">
                  Sign in with GitHub, or add a token with repo scope, to enable
                  Issues, PRs, and AI review.
                </div>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          {/* One button, one flow. It offers browser sign-in and token paste,
              checks whichever you use, and replaces the credential in place —
              so it is the reconnect/rotate route as well as the first-time one. */}
          <button
            type="button"
            onClick={() => setWizard({ descriptorId: "github" })}
            disabled={isLoading}
            className="inline-flex items-center gap-1 px-2 py-1 text-[10px] text-accent-green hover:bg-accent-green/10 rounded transition-colors disabled:opacity-50"
          >
            <Wand2 size={10} />
            {isConnected ? "Reconnect" : "Connect"}
          </button>
          {isConnected && (
            <button
              type="button"
              onClick={handleDisconnect}
              disabled={isLoading}
              className="inline-flex items-center gap-1 px-2 py-1 text-[10px] text-text-muted hover:text-accent-red hover:bg-accent-red/10 rounded transition-colors disabled:opacity-50"
            >
              <LogOut size={10} />
              Disconnect
            </button>
          )}
        </div>
      </div>

      {error && <p className="text-[10px] text-accent-red mb-4 -mt-2">{error}</p>}

      <div className="space-y-4">
        {/* Default merge strategy */}
        <div>
          <div className="text-[10px] text-text-muted uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
            <GitMerge size={10} className="text-text-muted" />
            Default merge strategy
          </div>
          <div className="inline-flex rounded-md border border-bg-border overflow-hidden">
            {(
              [
                { value: "merge", label: "Merge" },
                { value: "squash", label: "Squash" },
                { value: "rebase", label: "Rebase" },
              ] as Array<{ value: GitHubMergeStrategy; label: string }>
            ).map((option) => {
              const isActive = defaultMergeStrategy === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setDefaultMergeStrategy(option.value)}
                  className={`px-2.5 py-1 text-[11px] transition-colors ${
                    isActive
                      ? "bg-accent-green/15 text-accent-green"
                      : "text-text-secondary hover:text-text-primary hover:bg-bg-hover"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <p className="text-[10px] text-text-muted leading-snug mt-1.5">
            Pre-selects the merge method in the PR action bar. You can still
            change it per-PR before confirming.
          </p>
        </div>

        {/* Destructive-action confirmation */}
        <div className="space-y-1.5">
          <Toggle
            icon={ShieldAlert}
            label="Require confirmation for destructive actions"
            checked={requireMergeConfirmation}
            onChange={setRequireMergeConfirmation}
          />
          <p className="text-[10px] text-text-muted leading-snug">
            Show a confirm step before merging, closing, or converting PRs.
          </p>
        </div>

        {/* Draft default */}
        <div className="space-y-1.5">
          <Toggle
            icon={Github}
            label="Default new PRs to draft"
            checked={defaultDraftPrs}
            onChange={setDefaultDraftPrs}
          />
          <p className="text-[10px] text-text-muted leading-snug">
            Pre-checks the &quot;Open as draft&quot; box in the New PR modal.
          </p>
        </div>

        {/* Async flight publish default */}
        <div className="space-y-1.5">
          <Toggle
            icon={Github}
            label="Publish Flight attempts as draft PRs by default"
            checked={defaultPublishAttemptsAsPrs}
            onChange={setDefaultPublishAttemptsAsPrs}
          />
          <p className="text-[10px] text-text-muted leading-snug">
            When launching a new async Flight, pre-check the &quot;Publish
            attempts as draft PRs&quot; option.
          </p>
        </div>
      </div>

      {/* GitLab, Gitea/Forgejo, and whatever else the wizard can add. */}
      <div className="mt-4 pt-4 border-t border-bg-border">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-[11px] font-semibold text-text-primary flex items-center gap-2">
            <Server size={12} className="text-text-muted" />
            Other git hosts
          </h4>
          <button
            type="button"
            onClick={() => setWizard({})}
            className="inline-flex items-center gap-1 text-[11px] text-accent-green hover:text-accent-green/80"
          >
            <Plus size={11} />
            Add host
          </button>
        </div>

        {additionalConnections.length === 0 && (
          <p className="text-[10px] text-text-muted leading-snug">
            Connect GitLab (gitlab.com or self-hosted) or an on-prem Gitea /
            Forgejo instance. Each workspace uses the host its{" "}
            <code className="text-text-secondary">origin</code> remote belongs
            to. &quot;Add host&quot; asks which host you are connecting before it
            asks for anything else.
          </p>
        )}

        {additionalConnections.length > 0 && (
          <div className="flex flex-col gap-1.5 mb-2">
            {additionalConnections.map((c) => {
              const isActive = c.id === activeConnectionId;
              return (
                <div
                  key={c.id}
                  className="flex items-center justify-between gap-2 rounded border border-bg-border bg-bg-primary px-2.5 py-1.5"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    {/* Per-kind mark. A GitLab row must not wear the GitHub
                        octocat, which is exactly what the old shared ternary
                        in HostIcon did to it. */}
                    <HostIcon kind={c.kind} size={12} className="shrink-0 text-text-muted" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] text-text-primary truncate">{c.label}</span>
                        <span className="shrink-0 rounded bg-bg-elevated px-1 py-0.5 text-[9px] text-text-muted">
                          {hostLabel(c.kind)}
                        </span>
                      </div>
                      <div className="text-[10px] text-text-muted truncate font-mono">
                        {c.baseUrl}
                        {!c.hasToken && (
                          <span className="text-accent-amber ml-1.5">· no token</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {isActive ? (
                      <span
                        className="rounded bg-accent-green/15 px-1.5 py-0.5 text-[9px] text-accent-green"
                        title="The Git pane is currently targeting this host"
                      >
                        Active
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setActiveConnection(c.id)}
                        title={`Point the Git pane at ${c.label}`}
                        aria-label={`Use ${c.label}`}
                        className="rounded px-1.5 py-0.5 text-[9px] text-text-muted hover:bg-bg-hover hover:text-text-secondary"
                      >
                        Use
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setEditingConnection(c)}
                      title={`Edit ${c.label}`}
                      aria-label={`Edit ${c.label}`}
                      className="text-text-muted hover:text-text-primary p-1 rounded"
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setPendingHostRemoval({ id: c.id, label: c.label, baseUrl: c.baseUrl })
                      }
                      title={`Remove ${c.label}`}
                      aria-label={`Remove ${c.label}`}
                      className="text-text-muted hover:text-accent-red p-1 rounded"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {additionalConnections.length > 0 && (
          <p className="text-[10px] text-text-muted leading-snug">
            Opening a workspace re-resolves the host from that repository&apos;s{" "}
            <code className="text-text-secondary">origin</code> remote, so
            &quot;Use&quot; is an override that holds until you switch workspace.
            Edit renames a host or replaces an expiring token in place — the new
            credential is checked against the host first, and the current one
            keeps working unless it passes.
          </p>
        )}
      </div>

      {wizard && (
        <GitHostSetupWizard
          initialDescriptorId={wizard.descriptorId}
          // Re-read on close: the wizard writes through its descriptor's own
          // `save`, not through this card's store action, so without this the
          // list stayed stale until the next mount.
          onClose={() => {
            setWizard(null);
            void loadConnections();
          }}
        />
      )}

      {editingConnection && (
        <GitHostEditConnectionModal
          connection={editingConnection}
          onSave={updateGitHostConnection}
          onClose={() => setEditingConnection(null)}
        />
      )}

      {pendingHostRemoval && (
        <ConfirmDeleteModal
          title="Remove git host?"
          entityName={`${pendingHostRemoval.label} (${pendingHostRemoval.baseUrl})`}
          description="is disconnected and its stored token is removed. Repo browsing and PR actions against this host stop working."
          confirmLabel="Remove host"
          onConfirm={() => {
            void removeGitHostConnection(pendingHostRemoval.id);
            setPendingHostRemoval(null);
          }}
          onClose={() => setPendingHostRemoval(null)}
        />
      )}
    </div>
  );
}

function Toggle({
  icon: Icon,
  label,
  checked,
  onChange,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 cursor-pointer group">
      <span className="flex items-center gap-2 text-[11px] text-text-secondary group-hover:text-text-primary transition-colors">
        <Icon size={11} className="text-text-muted" />
        {label}
      </span>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative w-7 h-4 rounded-full transition-colors flex-shrink-0 ${
          checked ? "bg-accent-green" : "bg-bg-elevated"
        }`}
        aria-pressed={checked}
      >
        <span
          className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
            checked ? "translate-x-3.5" : "translate-x-0.5"
          }`}
        />
      </button>
    </label>
  );
}
