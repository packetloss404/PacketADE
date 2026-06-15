import { useState } from "react";
import {
  Check,
  Eye,
  EyeOff,
  Github,
  GitMerge,
  LogOut,
  RefreshCw,
  ShieldAlert,
  X,
} from "lucide-react";
import {
  useGitHubStore,
  type GitHubMergeStrategy,
} from "@/stores/githubStore";

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
