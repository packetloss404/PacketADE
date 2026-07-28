import { useEffect, useState } from "react";
import { AlertTriangle, GitBranch, ShieldAlert, Tag } from "lucide-react";
import { validateAutonomyPolicy } from "@/lib/autonomyPolicy";
import {
  DEFAULT_AUTO_COMMIT_TRAILER_FORMAT,
  useOrchestrationSettingsStore,
} from "@/stores/orchestrationSettingsStore";
import type { AutonomyPolicy } from "@/types/flight";

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

function PolicyToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-[11px] text-text-secondary">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="accent-accent-amber"
      />
    </label>
  );
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
  const autonomyDefaultMode = useOrchestrationSettingsStore((s) => s.autonomyDefaultMode);
  const autonomyDefaultPolicy = useOrchestrationSettingsStore((s) => s.autonomyDefaultPolicy);
  const setAutonomyDefault = useOrchestrationSettingsStore((s) => s.setAutonomyDefault);
  const [policyDraft, setPolicyDraft] = useState<AutonomyPolicy>(autonomyDefaultPolicy);
  const [modeDraft, setModeDraft] = useState<"assisted" | "yolo">(autonomyDefaultMode);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const policyErrors = validateAutonomyPolicy(policyDraft);

  useEffect(() => {
    setPolicyDraft(autonomyDefaultPolicy);
    setModeDraft(autonomyDefaultMode);
  }, [autonomyDefaultMode, autonomyDefaultPolicy]);

  function patchPolicy(patch: Partial<AutonomyPolicy>) {
    setPolicyDraft((current) => ({ ...current, ...patch }));
    setSaveMessage(null);
  }

  function saveAutonomyDefault() {
    try {
      setAutonomyDefault(modeDraft, policyDraft);
      setSaveMessage("Saved. Existing Flights keep their current policy snapshot.");
    } catch (error) {
      setSaveMessage(error instanceof Error ? error.message : String(error));
    }
  }

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

        <div className="border-accent-amber/30 bg-accent-amber/5 mt-4 rounded border p-3">
          <div className="flex items-start gap-2">
            <ShieldAlert size={12} className="mt-0.5 shrink-0 text-accent-amber" />
            <div>
              <div className="text-[11px] font-medium text-text-primary">
                YOLO / bounded autonomy default
              </div>
              <p className="mt-0.5 text-[10px] leading-snug text-text-muted">
                This controls only Flights that explicitly choose “Use Settings default.”
                Reviewer failures, integration conflicts, final base-branch landing, credentials,
                and work outside the allowlists still stop for you.
              </p>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setModeDraft("assisted")}
              className={`rounded border px-2 py-1 text-[10px] ${
                modeDraft === "assisted"
                  ? "border-accent-green/40 bg-accent-green/10 text-accent-green"
                  : "border-bg-border text-text-muted"
              }`}
            >
              Assisted default
            </button>
            <button
              type="button"
              onClick={() => setModeDraft("yolo")}
              className={`rounded border px-2 py-1 text-[10px] ${
                modeDraft === "yolo"
                  ? "border-accent-amber/40 bg-accent-amber/10 text-accent-amber"
                  : "border-bg-border text-text-muted"
              }`}
            >
              YOLO default
            </button>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
            <PolicyToggle
              label="Auto-recover failed attempts"
              checked={policyDraft.autoRecovery}
              onChange={(autoRecovery) => patchPolicy({ autoRecovery })}
            />
            <PolicyToggle
              label="Auto-remediate reviewer findings"
              checked={policyDraft.autoReviewRemediation}
              onChange={(autoReviewRemediation) => patchPolicy({ autoReviewRemediation })}
            />
            <PolicyToggle
              label="Auto-run cooperative task graph"
              checked={policyDraft.autoRunTaskGraph}
              onChange={(autoRunTaskGraph) => patchPolicy({ autoRunTaskGraph })}
            />
            <PolicyToggle
              label="Allow unattended in-project tools"
              checked={policyDraft.toolPosture === "allow_in_project"}
              onChange={(enabled) =>
                patchPolicy({
                  toolPosture: enabled ? "allow_in_project" : "approval_gated",
                })
              }
            />
            <PolicyToggle
              label="Allow configured draft-PR publishing"
              checked={policyDraft.allowDraftPrPublishing}
              onChange={(allowDraftPrPublishing) => patchPolicy({ allowDraftPrPublishing })}
            />
          </div>

          <div className="mt-3 grid grid-cols-5 gap-2">
            {[
              ["Cost $", "maxTotalCost", policyDraft.maxTotalCost],
              ["Minutes", "maxDurationMinutes", policyDraft.maxDurationMinutes],
              ["Retries", "maxRetriesPerTask", policyDraft.maxRetriesPerTask],
              ["Reviews", "maxReviewRounds", policyDraft.maxReviewRounds],
              ["Agents", "maxConcurrentAgents", policyDraft.maxConcurrentAgents],
            ].map(([label, key, value]) => (
              <label key={String(key)} className="text-[9px] uppercase tracking-wide text-text-muted">
                {String(label)}
                <input
                  type="number"
                  min={key === "maxRetriesPerTask" || key === "maxReviewRounds" ? 0 : 1}
                  step={key === "maxTotalCost" ? 0.5 : 1}
                  value={Number(value)}
                  onChange={(event) =>
                    patchPolicy({ [String(key)]: Number(event.target.value) })
                  }
                  className="mt-1 w-full rounded border border-bg-border bg-bg-primary px-1.5 py-1 text-[10px] text-text-primary outline-none"
                />
              </label>
            ))}
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <label className="text-[9px] uppercase tracking-wide text-text-muted">
              Allowed project roots — one per line
              <textarea
                rows={3}
                value={policyDraft.allowedRoots.join("\n")}
                onChange={(event) =>
                  patchPolicy({
                    allowedRoots: event.target.value
                      .split("\n")
                      .map((value) => value.trim())
                      .filter(Boolean),
                  })
                }
                className="mt-1 w-full resize-none rounded border border-bg-border bg-bg-primary px-2 py-1 text-[10px] normal-case text-text-primary outline-none"
              />
            </label>
            <label className="text-[9px] uppercase tracking-wide text-text-muted">
              Allowed targets — local or server IDs
              <textarea
                rows={3}
                value={policyDraft.allowedTargets.join("\n")}
                onChange={(event) =>
                  patchPolicy({
                    allowedTargets: event.target.value
                      .split("\n")
                      .map((value) => value.trim())
                      .filter(Boolean),
                  })
                }
                className="mt-1 w-full resize-none rounded border border-bg-border bg-bg-primary px-2 py-1 text-[10px] normal-case text-text-primary outline-none"
              />
            </label>
          </div>

          {modeDraft === "yolo" && policyErrors.length > 0 && (
            <div className="mt-2 flex items-start gap-1.5 text-[10px] text-accent-amber">
              <AlertTriangle size={10} className="mt-px shrink-0" />
              {policyErrors[0]}
            </div>
          )}
          {saveMessage && <p className="mt-2 text-[10px] text-text-muted">{saveMessage}</p>}
          <button
            type="button"
            disabled={modeDraft === "yolo" && policyErrors.length > 0}
            onClick={saveAutonomyDefault}
            className="border-accent-amber/40 bg-accent-amber/10 mt-3 rounded border px-2.5 py-1 text-[10px] font-medium text-accent-amber disabled:cursor-not-allowed disabled:opacity-40"
          >
            Save autonomy default
          </button>
        </div>
      </div>
    </div>
  );
}
