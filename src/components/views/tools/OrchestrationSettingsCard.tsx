import { GitBranch, Tag } from "lucide-react";
import {
  DEFAULT_AUTO_COMMIT_TRAILER_FORMAT,
  useOrchestrationSettingsStore,
} from "@/stores/orchestrationSettingsStore";

/** v0.8: render the auto-trailer preview using fixed sample values so
 * the user always sees a concrete substitution rather than the raw
 * placeholders. Mirrors the substitution done in
 * `core/worktree.rs::render_trailer_format`. */
const SAMPLE_FLIGHT_ID = "A1B2";
const SAMPLE_ATTEMPT_ID = "X1Y2";
const SAMPLE_FLIGHT_TITLE = "Refactor auth";

function renderTrailerPreview(format: string): string {
  return format
    .replace(/\{flightId\}/g, SAMPLE_FLIGHT_ID)
    .replace(/\{attemptId\}/g, SAMPLE_ATTEMPT_ID)
    .replace(/\{flightTitle\}/g, SAMPLE_FLIGHT_TITLE);
}

export function OrchestrationSettingsCard() {
  const autoCommitTrailerEnabled = useOrchestrationSettingsStore(
    (s) => s.autoCommitTrailerEnabled,
  );
  const autoCommitTrailerFormat = useOrchestrationSettingsStore(
    (s) => s.autoCommitTrailerFormat,
  );
  const setAutoCommitTrailerEnabled = useOrchestrationSettingsStore(
    (s) => s.setAutoCommitTrailerEnabled,
  );
  const setAutoCommitTrailerFormat = useOrchestrationSettingsStore(
    (s) => s.setAutoCommitTrailerFormat,
  );

  return (
    <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
      <h3 className="text-xs font-semibold text-text-primary mb-3 flex items-center gap-2">
        <GitBranch size={12} className="text-accent-blue" />
        Flights
      </h3>

      <div className="space-y-2">
        <div className="flex items-center gap-2 text-[10px] text-text-muted uppercase tracking-wider">
          <Tag size={10} className="text-accent-blue" />
          Auto-trailer on agent commits
        </div>

        <label className="flex items-center justify-between gap-3 cursor-pointer group">
          <div className="min-w-0">
            <div className="text-[11px] text-text-secondary group-hover:text-text-primary transition-colors">
              Append a trailer to every agent commit
            </div>
            <div className="text-[10px] text-text-muted leading-snug">
              Installs a `prepare-commit-msg` hook inside each flight worktree so
              commits identify the originating flight and attempt.
            </div>
          </div>
          <button
            type="button"
            onClick={() => setAutoCommitTrailerEnabled(!autoCommitTrailerEnabled)}
            className={`relative w-8 h-[18px] rounded-full transition-colors flex-shrink-0 ${
              autoCommitTrailerEnabled ? "bg-accent-green" : "bg-bg-elevated"
            }`}
            aria-pressed={autoCommitTrailerEnabled}
          >
            <span
              className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-transform ${
                autoCommitTrailerEnabled ? "left-[16px]" : "left-[2px]"
              }`}
            />
          </button>
        </label>

        <div className={autoCommitTrailerEnabled ? "" : "opacity-50 pointer-events-none"}>
          <label className="text-[10px] text-text-muted block mb-1 uppercase tracking-wider">
            Trailer format
          </label>
          <input
            type="text"
            value={autoCommitTrailerFormat}
            onChange={(e) => setAutoCommitTrailerFormat(e.target.value)}
            spellCheck={false}
            className="w-full bg-bg-primary border border-bg-border rounded px-2 py-1 text-[11px] font-mono text-text-primary focus:outline-none focus:border-accent-green"
          />
          <p className="text-[10px] text-text-muted mt-1 leading-snug">
            Available placeholders: <code>{`{flightId}`}</code>,{" "}
            <code>{`{attemptId}`}</code>, <code>{`{flightTitle}`}</code>. Leave
            default unless you have a specific format requirement.
          </p>
          <div className="mt-2 bg-bg-primary border border-bg-border rounded px-2 py-1.5">
            <div className="text-[10px] text-text-muted uppercase tracking-wider mb-1">
              Preview
            </div>
            <code className="text-[11px] text-accent-green break-all">
              {renderTrailerPreview(autoCommitTrailerFormat || DEFAULT_AUTO_COMMIT_TRAILER_FORMAT)}
            </code>
          </div>
        </div>
      </div>
    </div>
  );
}
