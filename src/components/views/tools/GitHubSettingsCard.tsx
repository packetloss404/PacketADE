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
  X,
} from "lucide-react";
import {
  useGitHubStore,
  type GitHubMergeStrategy,
} from "@/stores/githubStore";
import { normalizeGiteaBaseUrl } from "@/lib/git-hosts";
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

  // G2: Gitea/Forgejo self-hosted connections.
  const connections = useGitHubStore((s) => s.connections);
  const loadConnections = useGitHubStore((s) => s.loadConnections);
  const addGiteaHost = useGitHubStore((s) => s.addGiteaHost);
  const removeGitHostConnection = useGitHubStore((s) => s.removeGitHostConnection);
  const giteaConnections = connections.filter((c) => c.kind === "gitea");

  const [giteaOpen, setGiteaOpen] = useState(false);
  const [giteaUrl, setGiteaUrl] = useState("");
  const [giteaLabel, setGiteaLabel] = useState("");
  const [giteaToken, setGiteaToken] = useState("");
  const [giteaError, setGiteaError] = useState<string | null>(null);
  const [giteaBusy, setGiteaBusy] = useState(false);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  async function handleAddGitea() {
    const normalized = normalizeGiteaBaseUrl(giteaUrl);
    if ("error" in normalized) {
      setGiteaError(normalized.error);
      return;
    }
    if (!giteaToken.trim()) {
      setGiteaError("Access token is required");
      return;
    }
    setGiteaBusy(true);
    setGiteaError(null);
    try {
      await addGiteaHost(normalized.value, giteaLabel.trim(), giteaToken.trim());
      setGiteaUrl("");
      setGiteaLabel("");
      setGiteaToken("");
      setGiteaOpen(false);
    } catch (e) {
      setGiteaError(String(e));
    } finally {
      setGiteaBusy(false);
    }
  }

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

      {/* G2: self-hosted Gitea / Forgejo connections */}
      <div className="mt-4 pt-4 border-t border-bg-border">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-[11px] font-semibold text-text-primary flex items-center gap-2">
            <Server size={12} className="text-text-muted" />
            Self-hosted (Gitea / Forgejo)
          </h4>
          {!giteaOpen && (
            <button
              type="button"
              onClick={() => setGiteaOpen(true)}
              className="inline-flex items-center gap-1 text-[11px] text-accent-green hover:text-accent-green/80"
            >
              <Plus size={11} />
              Add host
            </button>
          )}
        </div>

        {giteaConnections.length === 0 && !giteaOpen && (
          <p className="text-[10px] text-text-muted leading-snug">
            Connect an on-prem Gitea or Forgejo instance. Each workspace uses the
            host its <code className="text-text-secondary">origin</code> remote
            belongs to.
          </p>
        )}

        {giteaConnections.length > 0 && (
          <div className="flex flex-col gap-1.5 mb-2">
            {giteaConnections.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between gap-2 rounded border border-bg-border bg-bg-primary px-2.5 py-1.5"
              >
                <div className="min-w-0">
                  <div className="text-[11px] text-text-primary truncate">{c.label}</div>
                  <div className="text-[10px] text-text-muted truncate font-mono">
                    {c.baseUrl}
                    {!c.hasToken && (
                      <span className="text-accent-amber ml-1.5">· no token</span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void removeGitHostConnection(c.id)}
                  title="Remove host"
                  className="text-text-muted hover:text-accent-red p-1 rounded"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        {giteaOpen && (
          <div className="flex flex-col gap-2 rounded border border-bg-border bg-bg-primary p-2.5">
            <input
              type="text"
              value={giteaUrl}
              onChange={(e) => setGiteaUrl(e.target.value)}
              placeholder="https://git.example.com"
              className="w-full rounded border border-bg-border bg-bg-secondary px-2 py-1.5 text-[11px] text-text-primary outline-none focus:border-accent-green/50"
            />
            <input
              type="text"
              value={giteaLabel}
              onChange={(e) => setGiteaLabel(e.target.value)}
              placeholder="Label (optional)"
              className="w-full rounded border border-bg-border bg-bg-secondary px-2 py-1.5 text-[11px] text-text-primary outline-none focus:border-accent-green/50"
            />
            <input
              type="password"
              value={giteaToken}
              onChange={(e) => setGiteaToken(e.target.value)}
              placeholder="Access token"
              className="w-full rounded border border-bg-border bg-bg-secondary px-2 py-1.5 text-[11px] text-text-primary outline-none focus:border-accent-green/50"
            />
            {giteaError && (
              <p className="text-[10px] text-accent-red leading-snug">{giteaError}</p>
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={giteaBusy}
                onClick={handleAddGitea}
                className="inline-flex items-center gap-1 rounded bg-accent-green/20 px-2.5 py-1 text-[11px] font-medium text-accent-green hover:bg-accent-green/30 disabled:opacity-40"
              >
                {giteaBusy ? "Adding…" : "Add host"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setGiteaOpen(false);
                  setGiteaError(null);
                }}
                className="text-[11px] text-text-muted hover:text-text-secondary"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
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
