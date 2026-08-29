import { useEffect, useRef, useState } from "react";
import {
  Check,
  Eye,
  EyeOff,
  Github,
  GitMerge,
  LogOut,
  Plus,
  RefreshCw,
  Server,
  ShieldAlert,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import {
  useGitHubStore,
  type GitHubMergeStrategy,
} from "@/stores/githubStore";
import { ConfirmDeleteModal } from "@/components/ui/ConfirmDeleteModal";
import { HostIcon } from "@/components/HostIcon";
import { hostLabel } from "@/lib/git-hosts";
import { GitHostSetupWizard } from "@/components/gitHost/GitHostSetupWizard";
import {
  githubDeviceFlowStart,
  githubDeviceFlowPoll,
  githubOauthConfigured,
} from "@/lib/tauri";
import { deviceFlowNextDelayMs, deviceFlowIsTerminal } from "@/lib/deviceFlow";

/**
 * v0.8: Settings → GitHub card.
 *
 * Centralises the GitHub-related toggles that used to be hardcoded or
 * sprinkled across other surfaces:
 *  - PAT rotation / disconnect (mirrors the inline flow in `GitHubView`'s
 *    connect screen, so users don't have to log out to swap tokens).
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
  const connect = useGitHubStore((s) => s.connect);
  const disconnect = useGitHubStore((s) => s.disconnect);
  const clearError = useGitHubStore((s) => s.clearError);

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

  const [showTokenInput, setShowTokenInput] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [showToken, setShowToken] = useState(false);

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

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  async function handleSaveToken() {
    const trimmed = tokenInput.trim();
    if (!trimmed) return;
    await connect(trimmed);
    setTokenInput("");
    setShowToken(false);
    setShowTokenInput(false);
  }

  function handleCancelToken() {
    setTokenInput("");
    setShowToken(false);
    setShowTokenInput(false);
    clearError();
  }

  async function handleDisconnect() {
    await disconnect();
  }

  // GP3: GitHub OAuth device-flow. Falls back gracefully (a clear error) when no
  // OAuth app client id is configured — PAT paste still works.
  const initializeAuth = useGitHubStore((s) => s.initializeAuth);
  const [deviceInfo, setDeviceInfo] = useState<{ userCode: string; verificationUri: string } | null>(
    null,
  );
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  // Only expose the device-flow button when an OAuth app client id is baked/env
  // configured — otherwise start() always errors and the button is dead on arrival.
  const [deviceFlowAvailable, setDeviceFlowAvailable] = useState(false);
  // Guards the hand-rolled poll loop: flips false on unmount so we stop polling
  // GitHub (up to ~15 min) and never setState on an unmounted component.
  const deviceMountedRef = useRef(true);

  useEffect(() => {
    deviceMountedRef.current = true;
    void githubOauthConfigured()
      .then((ok) => {
        if (deviceMountedRef.current) setDeviceFlowAvailable(ok);
      })
      .catch(() => {
        /* leave button hidden on probe failure */
      });
    return () => {
      deviceMountedRef.current = false;
    };
  }, []);

  async function handleDeviceAuth() {
    setDeviceBusy(true);
    setDeviceError(null);
    try {
      const start = await githubDeviceFlowStart();
      if (!deviceMountedRef.current) return;
      setDeviceInfo({ userCode: start.userCode, verificationUri: start.verificationUri });
      let delay = Math.max(start.interval, 1) * 1000;
      const deadline = Date.now() + start.expiresIn * 1000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, delay));
        if (!deviceMountedRef.current) return; // unmounted mid-wait → stop polling
        const poll = await githubDeviceFlowPoll(start.deviceCode);
        if (!deviceMountedRef.current) return;
        delay = deviceFlowNextDelayMs(poll.status, delay);
        if (poll.status === "authorized") {
          await initializeAuth();
          if (!deviceMountedRef.current) return;
          setDeviceInfo(null);
          setShowTokenInput(false);
          return;
        }
        if (deviceFlowIsTerminal(poll.status)) {
          setDeviceError(poll.message ?? "Authorization failed");
          setDeviceInfo(null);
          return;
        }
      }
      setDeviceError("Device code expired — try again.");
      setDeviceInfo(null);
    } catch (e) {
      if (deviceMountedRef.current) {
        setDeviceError(e instanceof Error ? e.message : String(e));
        setDeviceInfo(null);
      }
    } finally {
      if (deviceMountedRef.current) setDeviceBusy(false);
    }
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
                  Personal access token (stored in OS keyring)
                </div>
              </>
            ) : (
              <>
                <div className="text-[11px] font-medium text-text-muted">
                  Not connected
                </div>
                <div className="text-[10px] text-text-muted">
                  Add a GitHub PAT with repo scope to enable Issues, PRs, and
                  AI review.
                </div>
              </>
            )}
          </div>
        </div>

        {!showTokenInput && (
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <button
              type="button"
              onClick={() => setWizard({ descriptorId: "github" })}
              className="inline-flex items-center gap-1 px-2 py-1 text-[10px] text-accent-green hover:bg-accent-green/10 rounded transition-colors"
            >
              <Wand2 size={10} />
              Guided setup
            </button>
            <button
              type="button"
              onClick={() => {
                setShowTokenInput(true);
                setTokenInput("");
                setShowToken(false);
                clearError();
              }}
              disabled={isLoading}
              className="inline-flex items-center gap-1 px-2 py-1 text-[10px] text-accent-green hover:bg-accent-green/10 rounded transition-colors disabled:opacity-50"
            >
              <RefreshCw size={10} />
              {isConnected ? "Rotate" : "Connect"}
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
        )}
      </div>

      {showTokenInput && (
        <div className="mb-4">
          <div className="flex items-center gap-1.5">
            <div className="relative flex-1">
              <input
                type={showToken ? "text" : "password"}
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="ghp_xxxxxxxxxxxx"
                className="w-full bg-bg-primary border border-bg-border rounded px-2 py-1 pr-7 text-[11px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleSaveToken();
                  if (e.key === "Escape") handleCancelToken();
                }}
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowToken((v) => !v)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary"
              >
                {showToken ? <EyeOff size={10} /> : <Eye size={10} />}
              </button>
            </div>
            <button
              type="button"
              onClick={() => void handleSaveToken()}
              disabled={isLoading || !tokenInput.trim()}
              className="p-1 text-accent-green hover:bg-accent-green/10 rounded disabled:opacity-50"
            >
              <Check size={11} />
            </button>
            <button
              type="button"
              onClick={handleCancelToken}
              className="p-1 text-text-muted hover:text-text-primary"
            >
              <X size={11} />
            </button>
          </div>
          {error && (
            <p className="text-[10px] text-accent-red mt-1.5">{error}</p>
          )}

          {/* GP3: device-flow alternative to pasting a PAT (only when an OAuth
              app client id is configured — otherwise it would always error) */}
          {deviceFlowAvailable && (
          <div className="mt-2 border-t border-bg-border pt-2">
            {deviceInfo ? (
              <div className="text-[10px] text-text-secondary">
                Enter code{" "}
                <span className="font-mono font-semibold text-text-primary">
                  {deviceInfo.userCode}
                </span>{" "}
                at{" "}
                <a
                  href={deviceInfo.verificationUri}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent-green underline"
                >
                  {deviceInfo.verificationUri}
                </a>
                <span className="ml-1.5 text-text-muted">· waiting for authorization…</span>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => void handleDeviceAuth()}
                disabled={deviceBusy}
                className="inline-flex items-center gap-1 text-[10px] text-accent-green hover:text-accent-green/80 disabled:opacity-50"
              >
                <Github size={10} />
                {deviceBusy ? "Starting…" : "Or authorize with GitHub (device flow)"}
              </button>
            )}
            {deviceError && (
              <p className="text-[10px] text-accent-red mt-1">{deviceError}</p>
            )}
          </div>
          )}
        </div>
      )}

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
            To change a host&apos;s token, remove it and add it again — the wizard
            verifies the new credential before anything reaches the keyring.
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
