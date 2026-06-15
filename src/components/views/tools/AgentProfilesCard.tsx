import { useState } from "react";
import {
  User,
  Plus,
  Copy,
  Trash2,
  Edit3,
  Check,
  X,
  Star,
} from "lucide-react";
import { useProfileStore } from "@/stores/profileStore";
import type { AgentProfile } from "@/types/profiles";
import type { PermissionMode } from "@/types/agent-conversation";
import { CardHeader } from "./CardHeader";

const PERMISSION_MODES: PermissionMode[] = [
  "auto",
  "ask_for_risky",
  "allow_all",
  "deny_all",
];

const PERMISSION_LABELS: Record<PermissionMode, string> = {
  auto: "Auto",
  ask_for_risky: "Ask risky",
  allow_all: "Allow all",
  deny_all: "Deny risky",
};

/** Drives the inline create / clone-edit drawer at the bottom of the card. */
type DraftMode =
  | { kind: "create" }
  | { kind: "edit"; profileId: string };

interface DraftState {
  mode: DraftMode;
  name: string;
  description: string;
  systemPrompt: string;
  /** UI representation of `allowedTools`: comma-separated tool names. Empty
   * string means "all tools" (= null in the underlying type). */
  allowedToolsCsv: string;
  memoryContextEnabled: boolean;
  permissionMode: PermissionMode;
  planMode: boolean;
  /** B9: when non-empty, every launch with this profile uses this exact
   * model id, ignoring the launcher's dropdown. Empty string = no pin
   * (= null in the underlying type). */
  pinnedModel: string;
}

function emptyDraft(mode: DraftMode): DraftState {
  return {
    mode,
    name: "",
    description: "",
    systemPrompt: "",
    allowedToolsCsv: "",
    memoryContextEnabled: false,
    permissionMode: "auto",
    planMode: false,
    pinnedModel: "",
  };
}

function profileToDraft(p: AgentProfile): DraftState {
  return {
    mode: { kind: "edit", profileId: p.id },
    name: p.name,
    description: p.description,
    systemPrompt: p.systemPrompt,
    allowedToolsCsv: (p.allowedTools ?? []).join(", "),
    memoryContextEnabled: p.memoryContextEnabled,
    permissionMode: p.permissionMode,
    planMode: p.planMode,
    pinnedModel: p.pinnedModel ?? "",
  };
}

function csvToTools(csv: string): string[] | null {
  const tools = csv
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return tools.length > 0 ? tools : null;
}

/**
 * Settings card for managing reusable agent profiles. Built-in profiles are
 * read-only but cloneable; user profiles can be edited or deleted in place.
 * Backed by `useProfileStore`; the AgentInputArea profile dropdown reads
 * from the same store so changes here surface immediately at launch time.
 */
export function AgentProfilesCard() {
  const profiles = useProfileStore((s) => s.profiles);
  const defaultProfileId = useProfileStore((s) => s.defaultProfileId);
  const setDefaultProfile = useProfileStore((s) => s.setDefaultProfile);
  const addProfile = useProfileStore((s) => s.addProfile);
  const updateProfile = useProfileStore((s) => s.updateProfile);
  const deleteProfile = useProfileStore((s) => s.deleteProfile);
  const cloneProfile = useProfileStore((s) => s.cloneProfile);

  const [draft, setDraft] = useState<DraftState | null>(null);

  function startCreate() {
    setDraft(emptyDraft({ kind: "create" }));
  }

  function startEdit(p: AgentProfile) {
    setDraft(profileToDraft(p));
  }

  function cancel() {
    setDraft(null);
  }

  function save() {
    if (!draft) return;
    const trimmedName = draft.name.trim();
    if (!trimmedName) return;
    const trimmedPin = draft.pinnedModel.trim();
    const payload = {
      name: trimmedName,
      description: draft.description.trim(),
      systemPrompt: draft.systemPrompt,
      allowedTools: csvToTools(draft.allowedToolsCsv),
      memoryContextEnabled: draft.memoryContextEnabled,
      permissionMode: draft.permissionMode,
      planMode: draft.planMode,
      pinnedModel: trimmedPin.length > 0 ? trimmedPin : null,
    };
    if (draft.mode.kind === "create") {
      addProfile(payload);
    } else {
      updateProfile(draft.mode.profileId, payload);
    }
    setDraft(null);
  }

  function handleClone(p: AgentProfile) {
    const newId = cloneProfile(p.id);
    if (newId) {
      const cloned = useProfileStore.getState().getProfile(newId);
      if (cloned) startEdit(cloned);
    }
  }

  function confirmDelete(p: AgentProfile) {
    if (p.isBuiltin) return;
    if (
      window.confirm(`Delete profile "${p.name}"? This cannot be undone.`)
    ) {
      deleteProfile(p.id);
    }
  }

  return (
    <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
      <CardHeader
        icon={User}
        iconColor="text-accent-blue"
        title="Agent Profiles"
        action={
          <button
            type="button"
            onClick={startCreate}
            className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-bg-border text-text-secondary hover:border-accent-green/40 hover:text-accent-green transition-colors"
          >
            <Plus size={11} /> New profile
          </button>
        }
      />

      <p className="text-[10px] text-text-muted mb-3">
        Profiles bundle a system prompt, tool whitelist, and posture defaults.
        Pick one in the Agents launcher to start a conversation with that
        persona. Built-ins are read-only but you can clone any to edit.
      </p>

      <div className="flex flex-col gap-2">
        {profiles.map((p) => {
          const isDefault = p.id === defaultProfileId;
          return (
            <div
              key={p.id}
              className="flex items-start gap-2.5 p-2.5 bg-bg-primary border border-bg-border rounded-md"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[11.5px] font-semibold text-text-primary">
                    {p.name}
                  </span>
                  {p.isBuiltin && (
                    <span className="text-[9px] px-1 py-px rounded bg-accent-blue/15 text-accent-blue">
                      built-in
                    </span>
                  )}
                  {isDefault && (
                    <span className="text-[9px] px-1 py-px rounded bg-accent-green/15 text-accent-green inline-flex items-center gap-1">
                      <Star size={9} /> default
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-text-muted mt-0.5">
                  {p.description || "No description"}
                </div>
                <div className="text-[10px] text-text-faint mt-1 flex items-center gap-2 flex-wrap">
                  <span title="Permission mode">
                    {PERMISSION_LABELS[p.permissionMode]}
                  </span>
                  <span>·</span>
                  <span>{p.planMode ? "plan-mode" : "build-mode"}</span>
                  <span>·</span>
                  <span title="Memory context">
                    memory {p.memoryContextEnabled ? "on" : "off"}
                  </span>
                  <span>·</span>
                  <span title="Allowed tools">
                    {p.allowedTools && p.allowedTools.length > 0
                      ? `${p.allowedTools.length} tools`
                      : "all tools"}
                  </span>
                  {p.pinnedModel && (
                    <>
                      <span>·</span>
                      <span
                        className="text-accent-amber font-mono"
                        title={`Pinned to model "${p.pinnedModel}" — launcher selection ignored`}
                      >
                        📌 {p.pinnedModel}
                      </span>
                    </>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-0.5 flex-shrink-0">
                {!isDefault && (
                  <button
                    type="button"
                    onClick={() => setDefaultProfile(p.id)}
                    className="p-1 text-text-faint hover:text-accent-green rounded"
                    title="Set as launch default"
                  >
                    <Star size={11} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handleClone(p)}
                  className="p-1 text-text-faint hover:text-accent-blue rounded"
                  title="Clone into a new editable profile"
                >
                  <Copy size={11} />
                </button>
                {!p.isBuiltin && (
                  <>
                    <button
                      type="button"
                      onClick={() => startEdit(p)}
                      className="p-1 text-text-faint hover:text-accent-blue rounded"
                      title="Edit"
                    >
                      <Edit3 size={11} />
                    </button>
                    <button
                      type="button"
                      onClick={() => confirmDelete(p)}
                      className="p-1 text-text-faint hover:text-accent-red rounded"
                      title="Delete"
                    >
                      <Trash2 size={11} />
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {draft && (
        <div className="mt-3 p-3 border border-accent-blue/40 rounded-md bg-bg-primary">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-semibold text-text-primary">
              {draft.mode.kind === "create" ? "New profile" : "Edit profile"}
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={save}
                disabled={!draft.name.trim()}
                className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-accent-green/40 text-accent-green hover:bg-accent-green/10 disabled:opacity-40"
              >
                <Check size={11} /> Save
              </button>
              <button
                type="button"
                onClick={cancel}
                className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-bg-border text-text-secondary hover:bg-bg-hover"
              >
                <X size={11} /> Cancel
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 mb-2">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-text-muted">Name</span>
              <input
                type="text"
                value={draft.name}
                onChange={(e) =>
                  setDraft({ ...draft, name: e.target.value })
                }
                placeholder="Reviewer (strict)"
                className="bg-bg-secondary border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary focus:outline-none focus:border-accent-blue/60"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-text-muted">
                Description
              </span>
              <input
                type="text"
                value={draft.description}
                onChange={(e) =>
                  setDraft({ ...draft, description: e.target.value })
                }
                placeholder="One-line summary"
                className="bg-bg-secondary border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary focus:outline-none focus:border-accent-blue/60"
              />
            </label>
          </div>

          <label className="flex flex-col gap-1 mb-2">
            <span className="text-[10px] text-text-muted">System prompt</span>
            <textarea
              value={draft.systemPrompt}
              onChange={(e) =>
                setDraft({ ...draft, systemPrompt: e.target.value })
              }
              rows={5}
              placeholder="You are a code reviewer. Read the diff and..."
              className="bg-bg-secondary border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary focus:outline-none focus:border-accent-blue/60 font-mono"
            />
          </label>

          <label className="flex flex-col gap-1 mb-2">
            <span className="text-[10px] text-text-muted">
              Allowed tools (comma-separated; empty = all tools)
            </span>
            <input
              type="text"
              value={draft.allowedToolsCsv}
              onChange={(e) =>
                setDraft({ ...draft, allowedToolsCsv: e.target.value })
              }
              placeholder="read_file, list_directory, grep"
              className="bg-bg-secondary border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary focus:outline-none focus:border-accent-blue/60 font-mono"
            />
          </label>

          {/* B9 — Pinned model. When set, every launch with this profile
              uses this exact id, ignoring the launcher's dropdown. Useful
              for sticking with a known-good older model after a vendor
              regression (e.g. pin `claude-sonnet-4-6` if 4-7 is flaky). */}
          <label className="flex flex-col gap-1 mb-2">
            <span className="text-[10px] text-text-muted">
              Pinned model (empty = use launcher selection)
            </span>
            <input
              type="text"
              value={draft.pinnedModel}
              onChange={(e) =>
                setDraft({ ...draft, pinnedModel: e.target.value })
              }
              placeholder="claude-sonnet-4-6, gpt-4o, o4-mini, …"
              className="bg-bg-secondary border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary focus:outline-none focus:border-accent-blue/60 font-mono"
            />
            <span className="text-[9.5px] text-text-faint">
              Future provider auto-upgrades won't silently switch this profile
              away from a model you trust.
            </span>
          </label>

          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-1.5 text-[11px] text-text-secondary">
              <span>Permission mode:</span>
              <select
                value={draft.permissionMode}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    permissionMode: e.target.value as PermissionMode,
                  })
                }
                className="bg-bg-secondary border border-bg-border rounded text-[10px] px-1 py-0.5 text-text-secondary"
              >
                {PERMISSION_MODES.map((m) => (
                  <option key={m} value={m}>
                    {PERMISSION_LABELS[m]}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-1.5 text-[11px] text-text-secondary">
              <input
                type="checkbox"
                checked={draft.planMode}
                onChange={(e) =>
                  setDraft({ ...draft, planMode: e.target.checked })
                }
              />
              <span>Plan mode</span>
            </label>

            <label className="flex items-center gap-1.5 text-[11px] text-text-secondary">
              <input
                type="checkbox"
                checked={draft.memoryContextEnabled}
                onChange={(e) =>
                  setDraft({ ...draft, memoryContextEnabled: e.target.checked })
                }
              />
              <span>Inject project memory</span>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
