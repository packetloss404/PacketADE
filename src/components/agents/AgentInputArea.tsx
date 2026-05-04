import { useRef, useEffect, useState, useMemo, useCallback } from "react";
import {
  Monitor,
  Mic,
  Zap,
  FolderOpen,
  Folder,
  Server,
  Check,
  Bot,
  MessageCircle,
  Hand,
  Layers,
  User,
  GitBranch,
  Send,
  Loader2,
  AlertCircle,
  RefreshCw,
  LogIn,
  X,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  useAgentTaskStore,
  repoDisplayName,
  apiAgentProvider,
} from "@/stores/agentTaskStore";
import { useGitHubStore } from "@/stores/githubStore";
import { useProjectHistoryStore } from "@/stores/projectHistoryStore";
import { useSshTargetStore } from "@/stores/sshTargetStore";
import { useProfileStore } from "@/stores/profileStore";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { AuthBadge, type AuthStatus } from "@/components/ui/AuthBadge";
import { FileMentionPopover } from "./FileMentionPopover";
import { SshConnectModal } from "./SshConnectModal";
import type { AgentCli } from "@/stores/agentTaskStore";
import {
  API_PROVIDERS,
  getProviderForAgent,
  getModelSpeed,
  MODEL_SPEED_LABEL,
} from "@/lib/api-models";
import {
  getProviderAuthStatus,
  listOllamaModels,
  type ImageAttachment,
  type OllamaModel,
  type ProviderAuthStatus,
} from "@/lib/tauri";
import {
  isSshUri,
  makeSshUri,
  parseSshTargetId,
  type SshTarget,
} from "@/types/ssh";

/** Cursor-style launch modes. */
export type AgentMode = "agent" | "ask" | "manual" | "plan";

const MODE_META: Record<AgentMode, { label: string; description: string; icon: React.ComponentType<{ size?: number; className?: string }>; color: string }> = {
  agent: {
    label: "Agent",
    description: "Full tools — read, write, run commands",
    icon: Bot,
    color: "text-accent-green",
  },
  ask: {
    label: "Ask",
    description: "Read-only — no edits or commands",
    icon: MessageCircle,
    color: "text-accent-blue",
  },
  manual: {
    label: "Manual",
    description: "Every risky tool requires your approval",
    icon: Hand,
    color: "text-accent-amber",
  },
  plan: {
    label: "Plan",
    description: "Produce a structured plan first, then execute",
    icon: Layers,
    color: "text-accent-purple",
  },
};

const MODE_ORDER: AgentMode[] = ["agent", "ask", "manual", "plan"];

/**
 * Provider dropdown grouping. Only includes `api-*` agents (PTY CLI agents
 * like `claude-code` / `codex` are handled elsewhere). The subscription
 * providers (`api-claude-oauth`, `api-openai-codex`) are fully wired via
 * the sidecar and share this dropdown with the key-based API providers.
 */
const PROVIDER_GROUPS: { label: string; agents: AgentCli[] }[] = [
  { label: "Anthropic", agents: ["api-claude-oauth" as AgentCli, "api-claude"] },
  { label: "OpenAI", agents: ["api-openai-codex" as AgentCli, "api-openai"] },
  { label: "Other", agents: ["api-openrouter", "api-minimax", "api-ollama"] },
];

type AuthEntry = ProviderAuthStatus | "loading";

interface AgentInputAreaProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  selectedAgent: AgentCli;
  onAgentChange: (agent: AgentCli) => void;
  /** Called when the user submits. Staged image attachments (drag-drop /
   * paste) are passed through; an empty array if none. */
  onLaunch: (attachments: ImageAttachment[]) => void;
  selectedModel: string;
  onModelChange: (model: string) => void;
  agentMode?: AgentMode;
  onAgentModeChange?: (mode: AgentMode) => void;
  selectedProfileId?: string;
  onProfileChange?: (id: string) => void;
  /** T3.F: when true, handleLaunch creates a git worktree at
   * `<projectPath>/.pkt-worktrees/<convId>` and points the conversation at
   * it. Local projects only (SSH still uses the remote path verbatim). */
  worktreeEnabled?: boolean;
  onWorktreeChange?: (enabled: boolean) => void;
}

/**
 * Read a File / Blob into a base64 string suitable for ImageAttachment.
 * Strips the `data:<mime>;base64,` prefix that FileReader.readAsDataURL
 * always prepends so the wire payload is just the encoded bytes.
 */
function fileToImageAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("FileReader returned non-string result"));
        return;
      }
      // Format: data:<mime>;base64,<data>
      const commaIdx = result.indexOf(",");
      const data_base64 = commaIdx >= 0 ? result.slice(commaIdx + 1) : result;
      resolve({
        media_type: file.type || "image/png",
        data_base64,
      });
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

/** Hard cap to keep payloads sane — Anthropic accepts ~5MB per image. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

interface MentionState {
  active: boolean;
  query: string;
  // @-sign position in the textarea value (character index)
  atIndex: number;
  highlightedIndex: number;
}

const INITIAL_MENTION_STATE: MentionState = {
  active: false,
  query: "",
  atIndex: -1,
  highlightedIndex: 0,
};

export function AgentInputArea({
  textareaRef,
  selectedAgent,
  onAgentChange,
  onLaunch,
  selectedModel,
  onModelChange,
  agentMode = "agent",
  onAgentModeChange,
  selectedProfileId,
  onProfileChange,
  worktreeEnabled = false,
  onWorktreeChange,
}: AgentInputAreaProps) {
  const profiles = useProfileStore((s) => s.profiles);
  const defaultProfileId = useProfileStore((s) => s.defaultProfileId);
  const setDefaultProfile = useProfileStore((s) => s.setDefaultProfile);
  const activeProfileId = selectedProfileId ?? defaultProfileId;
  const activeProfile =
    profiles.find((p) => p.id === activeProfileId) ?? profiles[0];
  const agentInputText = useAgentTaskStore((s) => s.agentInputText);
  const setAgentInputText = useAgentTaskStore((s) => s.setAgentInputText);
  const selectedRepo = useAgentTaskStore((s) => s.selectedRepo);
  const setSelectedRepo = useAgentTaskStore((s) => s.setSelectedRepo);
  const repos = useGitHubStore((s) => s.repos);
  const projectHistory = useProjectHistoryStore((s) => s.projects);
  const recordOpenProject = useProjectHistoryStore((s) => s.recordOpen);
  const sshTargets = useSshTargetStore((s) => s.targets);
  const touchSshTarget = useSshTargetStore((s) => s.touchTarget);

  const [sshModalOpen, setSshModalOpen] = useState(false);

  // Staged image attachments (from drag-drop or clipboard paste) that will be
  // sent with the next launch. Cleared after onLaunch fires successfully.
  // Keeps both the wire-shape attachment and a transient preview URL so the
  // chip can render a thumbnail without re-decoding the base64.
  type StagedAttachment = {
    id: string;
    name: string;
    sizeBytes: number;
    attachment: ImageAttachment;
    previewUrl: string;
  };
  const [staged, setStaged] = useState<StagedAttachment[]>([]);
  const [dragActive, setDragActive] = useState(false);

  const addFiles = useCallback(async (files: File[]) => {
    const next: StagedAttachment[] = [];
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      if (file.size > MAX_IMAGE_BYTES) {
        console.warn(`Skipping ${file.name}: ${file.size} bytes > 5MB cap`);
        continue;
      }
      try {
        const attachment = await fileToImageAttachment(file);
        next.push({
          id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: file.name || "pasted-image",
          sizeBytes: file.size,
          attachment,
          previewUrl: URL.createObjectURL(file),
        });
      } catch (err) {
        console.warn("Failed to read attachment:", err);
      }
    }
    if (next.length > 0) {
      setStaged((prev) => [...prev, ...next]);
    }
  }, []);

  const removeStaged = useCallback((id: string) => {
    setStaged((prev) => {
      const dropped = prev.find((s) => s.id === id);
      if (dropped) URL.revokeObjectURL(dropped.previewUrl);
      return prev.filter((s) => s.id !== id);
    });
  }, []);

  // Cleanup object URLs on unmount.
  useEffect(() => {
    return () => {
      for (const s of staged) URL.revokeObjectURL(s.previewUrl);
    };
    // We deliberately don't react to `staged` here — the per-removal cleanup
    // happens inside `removeStaged` and on launch. This is the unmount sweep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === "file") {
          const f = item.getAsFile();
          if (f && f.type.startsWith("image/")) files.push(f);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        void addFiles(files);
      }
    },
    [addFiles],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragActive(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) void addFiles(files);
    },
    [addFiles],
  );

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!dragActive) setDragActive(true);
  }, [dragActive]);

  const handleDragLeave = useCallback(() => {
    setDragActive(false);
  }, []);

  const submitWithAttachments = useCallback(() => {
    const toSend = staged.map((s) => s.attachment);
    onLaunch(toSend);
    // Clear staged + free preview URLs after launching.
    for (const s of staged) URL.revokeObjectURL(s.previewUrl);
    setStaged([]);
  }, [onLaunch, staged]);

  const { isListening, transcript, startListening, stopListening, isSupported } =
    useVoiceInput();
  const prevTranscriptRef = useRef("");

  // Append voice transcript to input
  useEffect(() => {
    if (transcript && transcript !== prevTranscriptRef.current) {
      prevTranscriptRef.current = transcript;
      const current = useAgentTaskStore.getState().agentInputText;
      setAgentInputText(current + transcript);
    }
  }, [transcript, setAgentInputText]);

  type RecentItem =
    | { kind: "local"; path: string; ts: number }
    | { kind: "ssh"; target: SshTarget; ts: number };

  const recentItems: RecentItem[] = useMemo(() => {
    const localSeen = new Set<string>();
    const local: RecentItem[] = [];
    for (const p of projectHistory) {
      if (!p.path || localSeen.has(p.path)) continue;
      localSeen.add(p.path);
      local.push({ kind: "local", path: p.path, ts: p.lastOpened });
    }
    const ssh: RecentItem[] = sshTargets.map((t) => ({
      kind: "ssh",
      target: t,
      ts: t.lastUsed ?? t.createdAt,
    }));
    return [...local, ...ssh].sort((a, b) => b.ts - a.ts);
  }, [projectHistory, sshTargets]);

  const currentDisplayName = useMemo(() => {
    if (!selectedRepo) return "Select a project";
    if (isSshUri(selectedRepo)) {
      const id = parseSshTargetId(selectedRepo);
      const target = id ? sshTargets.find((t) => t.id === id) : undefined;
      return target ? target.name : "SSH target";
    }
    return repoDisplayName(selectedRepo, repos);
  }, [selectedRepo, repos, sshTargets]);

  const mentionProjectPath =
    selectedRepo && !isSshUri(selectedRepo) ? selectedRepo : "";

  const handleBrowse = useCallback(async () => {
    try {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked === "string" && picked) {
        setSelectedRepo(picked);
        recordOpenProject(picked);
      }
    } catch (err) {
      console.warn("Folder picker failed:", err);
    }
  }, [setSelectedRepo, recordOpenProject]);

  const handleSelectLocal = useCallback(
    (path: string) => {
      setSelectedRepo(path);
    },
    [setSelectedRepo],
  );

  const handleSelectSsh = useCallback(
    (targetId: string) => {
      setSelectedRepo(makeSshUri(targetId));
      touchSshTarget(targetId);
    },
    [setSelectedRepo, touchSshTarget],
  );

  const handleSshConnected = useCallback(
    (target: SshTarget) => {
      setSelectedRepo(makeSshUri(target.id));
      setSshModalOpen(false);
    },
    [setSelectedRepo],
  );

  // ─── @ file-mention state ─────────────────────────────────────────────
  const [mentionState, setMentionState] = useState<MentionState>(
    INITIAL_MENTION_STATE,
  );
  // Items are owned by the popover; we track the currently-rendered list
  // here via a ref so ArrowUp/Down/Enter can read them synchronously.
  const mentionItemsRef = useRef<string[]>([]);

  const closeMention = useCallback(() => {
    setMentionState(INITIAL_MENTION_STATE);
    mentionItemsRef.current = [];
  }, []);

  /**
   * Given the current text value and caret index, detect whether the caret
   * is inside an @-mention token (i.e. there's an '@' preceded by start-of-
   * input or whitespace, with no whitespace/newline between it and the caret).
   */
  function detectMention(
    value: string,
    caret: number,
  ): { atIndex: number; query: string } | null {
    // Scan backward from the caret looking for '@'.
    for (let i = caret - 1; i >= 0; i--) {
      const ch = value[i];
      if (ch === "@") {
        const prev = i === 0 ? "" : value[i - 1];
        if (i === 0 || /\s/.test(prev)) {
          return { atIndex: i, query: value.slice(i + 1, caret) };
        }
        return null;
      }
      if (/\s/.test(ch)) return null;
    }
    return null;
  }

  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setAgentInputText(value);
      const caret = e.target.selectionStart ?? value.length;
      const hit = detectMention(value, caret);
      if (hit) {
        setMentionState((prev) => ({
          active: true,
          query: hit.query,
          atIndex: hit.atIndex,
          // Reset highlight when the query changes.
          highlightedIndex:
            prev.active && prev.query === hit.query ? prev.highlightedIndex : 0,
        }));
      } else if (mentionState.active) {
        closeMention();
      }
    },
    [setAgentInputText, mentionState.active, closeMention],
  );

  const handleMentionItemsChange = useCallback((paths: string[]) => {
    mentionItemsRef.current = paths;
    setMentionState((prev) => {
      if (!prev.active) return prev;
      if (prev.highlightedIndex >= paths.length) {
        return { ...prev, highlightedIndex: 0 };
      }
      return prev;
    });
  }, []);

  const insertMentionPath = useCallback(
    (path: string) => {
      setMentionState((prev) => {
        const before = agentInputText.slice(0, prev.atIndex);
        const caret =
          textareaRef.current?.selectionStart ?? agentInputText.length;
        const after = agentInputText.slice(caret);
        const inserted = `@${path} `;
        const next = `${before}${inserted}${after}`;
        setAgentInputText(next);
        // Re-focus textarea and place caret right after the inserted chunk.
        const newCaret = before.length + inserted.length;
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (el) {
            el.focus();
            el.setSelectionRange(newCaret, newCaret);
          }
        });
        mentionItemsRef.current = [];
        return INITIAL_MENTION_STATE;
      });
    },
    [agentInputText, setAgentInputText, textareaRef],
  );

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // If mention popover is open, intercept navigation keys first.
    if (mentionState.active) {
      const items = mentionItemsRef.current;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionState((prev) => ({
          ...prev,
          highlightedIndex:
            items.length === 0 ? 0 : (prev.highlightedIndex + 1) % items.length,
        }));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionState((prev) => ({
          ...prev,
          highlightedIndex:
            items.length === 0
              ? 0
              : (prev.highlightedIndex - 1 + items.length) % items.length,
        }));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (items.length > 0) {
          e.preventDefault();
          const pick = items[mentionState.highlightedIndex] ?? items[0];
          insertMentionPath(pick);
          return;
        }
        // If no items, just close the popover and let Enter submit below.
        closeMention();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeMention();
        return;
      }
    }

    if (e.ctrlKey && e.key === "Enter") {
      e.preventDefault();
      if (launchReady) submitWithAttachments();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (launchReady) submitWithAttachments();
    }
  }

  // ─── Provider auth status polling ────────────────────────────────────
  const [authStatus, setAuthStatus] = useState<Record<string, AuthEntry>>({});

  const groupAgents = useMemo<AgentCli[]>(
    () => PROVIDER_GROUPS.flatMap((g) => g.agents),
    [],
  );

  const refreshAuthStatuses = useCallback(() => {
    // Mark everything as loading, then fetch each in parallel.
    setAuthStatus((prev) => {
      const next: Record<string, AuthEntry> = { ...prev };
      for (const a of groupAgents) next[a] = "loading";
      return next;
    });
    for (const agent of groupAgents) {
      const provider = apiAgentProvider(agent);
      getProviderAuthStatus(provider)
        .then((res) => {
          setAuthStatus((prev) => ({ ...prev, [agent]: res }));
        })
        .catch((err) => {
          // On failure, show as service_down with the error hint — better
          // than leaving the row stuck in a spinner.
          console.warn(`getProviderAuthStatus(${provider}) failed`, err);
          setAuthStatus((prev) => ({
            ...prev,
            [agent]: { status: "service_down", hint: "Status unavailable" },
          }));
        });
    }
  }, [groupAgents]);

  // Initial load on mount.
  useEffect(() => {
    refreshAuthStatuses();
  }, [refreshAuthStatuses]);

  // Live updates: the Rust side watches the claude/codex credential dirs
  // and emits `provider-auth:changed` whenever they mutate. Apply the
  // payload directly so we avoid a round-trip RPC on every login.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    listen<{ provider: string; status: ProviderAuthStatus }>(
      "provider-auth:changed",
      (event) => {
        const { provider, status } = event.payload;
        // Map the provider id back onto the agent(s) it governs. Today
        // there's exactly one agent per OAuth provider, but the lookup is
        // written defensively in case that changes.
        const affected = groupAgents.filter(
          (agent) => apiAgentProvider(agent) === provider,
        );
        if (affected.length === 0) return;
        setAuthStatus((prev) => {
          const next = { ...prev };
          for (const agent of affected) next[agent] = status;
          return next;
        });
      },
    )
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((err) => {
        console.warn("listen(provider-auth:changed) failed", err);
      });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [groupAgents]);

  // ─── Ollama installed-models fetch ───────────────────────────────────
  type OllamaModelsState = OllamaModel[] | "loading" | { error: string };
  const [ollamaModels, setOllamaModels] =
    useState<OllamaModelsState>("loading");

  const refreshOllamaModels = useCallback(() => {
    setOllamaModels("loading");
    listOllamaModels()
      .then((models) => {
        setOllamaModels(models);
      })
      .catch((e: unknown) => {
        const message =
          e instanceof Error
            ? e.message
            : typeof e === "string"
              ? e
              : "Ollama not reachable";
        setOllamaModels({ error: message || "Ollama not reachable" });
      });
  }, []);

  // Fetch on mount and whenever the user switches to the Ollama provider.
  useEffect(() => {
    if (selectedAgent === "api-ollama") {
      refreshOllamaModels();
    }
  }, [selectedAgent, refreshOllamaModels]);

  const selectedAuth = authStatus[selectedAgent];
  const selectedAuthStatus: AuthStatus =
    selectedAuth === "loading" || !selectedAuth
      ? "loading"
      : selectedAuth.status;
  const launchReady = selectedAuthStatus === "ready";
  const launchLabel =
    selectedAuthStatus === "coming_soon" ? "Coming soon" : "Launch";
  // Which provider (if any) needs an interactive login to become ready.
  // Returns "claude" / "codex" / null so the button + tooltip below can
  // branch on a single value and dispatch the right event.
  const needsLogin: "claude" | "codex" | null =
    selectedAuthStatus === "login_required"
      ? selectedAgent === "api-claude-oauth"
        ? "claude"
        : selectedAgent === "api-openai-codex"
          ? "codex"
          : null
      : null;

  const handleOpenLogin = useCallback(() => {
    if (needsLogin === "claude") {
      window.dispatchEvent(new CustomEvent("packetade:open-claude-login"));
    } else if (needsLogin === "codex") {
      window.dispatchEvent(new CustomEvent("packetade:open-codex-login"));
    }
  }, [needsLogin]);

  const loginTooltip =
    needsLogin === "codex"
      ? "Log in to ChatGPT to continue"
      : "Log in to Claude to continue";

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-8">
      <div className="w-full max-w-[600px]">
        {/* Repo selector */}
        <div className="mb-3">
          <Dropdown
            trigger={
              <span
                className={`flex items-center gap-1.5 ${
                  selectedRepo ? "text-text-primary" : "text-text-muted"
                }`}
              >
                {selectedRepo && isSshUri(selectedRepo) ? (
                  <Server size={12} className="text-accent-green" />
                ) : (
                  <Monitor size={12} className="text-text-muted" />
                )}
                {currentDisplayName}
              </span>
            }
          >
            {recentItems.length > 0 && (
              <div className="px-3 pt-1 pb-0.5 text-[9px] uppercase tracking-wider text-text-muted">
                Recents
              </div>
            )}
            {recentItems.map((item) =>
              item.kind === "local" ? (
                <DropdownItem
                  key={`local:${item.path}`}
                  onClick={() => handleSelectLocal(item.path)}
                >
                  <RecentRow
                    icon={<Folder size={12} className="text-text-muted" />}
                    label={repoDisplayName(item.path, repos)}
                    selected={selectedRepo === item.path}
                  />
                </DropdownItem>
              ) : (
                <DropdownItem
                  key={`ssh:${item.target.id}`}
                  onClick={() => handleSelectSsh(item.target.id)}
                >
                  <RecentRow
                    icon={<Server size={12} className="text-accent-green" />}
                    label={item.target.name}
                    selected={selectedRepo === makeSshUri(item.target.id)}
                  />
                </DropdownItem>
              ),
            )}

            {recentItems.length > 0 && (
              <div className="my-1 border-t border-bg-border" />
            )}

            <DropdownItem onClick={handleBrowse}>
              <span className="flex items-center gap-1.5 text-text-secondary">
                <FolderOpen size={12} />
                Open Folder
              </span>
            </DropdownItem>
            <DropdownItem onClick={() => setSshModalOpen(true)}>
              <span className="flex items-center gap-1.5 text-text-secondary">
                <Server size={12} />
                Connect SSH
              </span>
            </DropdownItem>
          </Dropdown>
        </div>

        {/* Input box */}
        <div
          className={`relative border rounded-lg bg-bg-primary transition-colors ${
            dragActive
              ? "border-accent-green ring-2 ring-accent-green/30"
              : "border-bg-border"
          }`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          {/* @ file-mention popover (positioned above the textarea) */}
          <div className="relative">
            <FileMentionPopover
              visible={mentionState.active && !!mentionProjectPath}
              projectPath={mentionProjectPath}
              query={mentionState.query}
              highlightedIndex={mentionState.highlightedIndex}
              onSelect={insertMentionPath}
              onItemsChange={handleMentionItemsChange}
            />
          </div>

          {/* Staged attachment chips (drag-drop or pasted images). */}
          {staged.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-2">
              {staged.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center gap-1.5 pl-1 pr-1.5 py-0.5 rounded border border-bg-border bg-bg-secondary text-[10px] text-text-secondary"
                  title={`${s.name} · ${(s.sizeBytes / 1024).toFixed(1)} KB`}
                >
                  <img
                    src={s.previewUrl}
                    alt=""
                    className="w-5 h-5 rounded object-cover"
                  />
                  <span className="truncate max-w-[140px]">{s.name}</span>
                  <button
                    type="button"
                    onClick={() => removeStaged(s.id)}
                    className="p-0.5 rounded hover:bg-bg-hover text-text-muted hover:text-accent-red"
                    title="Remove"
                  >
                    <X size={9} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={agentInputText}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onBlur={() => {
              // Delay so onMouseDown selection in the popover can still fire.
              setTimeout(() => closeMention(), 120);
            }}
            placeholder="What would you like to work on?  (drag-drop or paste images)"
            rows={4}
            className="w-full bg-transparent px-4 py-3 text-xs text-text-primary placeholder:text-text-muted focus:outline-none resize-none"
          />

          {/* Action row inside the input box */}
          <div className="flex items-center justify-between px-3 py-2 border-t border-bg-border/50">
            <div className="flex items-center gap-2">
              {/* Mode selector — Cursor-style Agent / Ask / Manual / Plan */}
              <Dropdown
                trigger={
                  <span className="text-text-secondary flex items-center gap-1">
                    {(() => {
                      const m = MODE_META[agentMode];
                      const Icon = m.icon;
                      return (
                        <>
                          <Icon size={10} className={m.color} />
                          {m.label}
                        </>
                      );
                    })()}
                  </span>
                }
              >
                {MODE_ORDER.map((m) => {
                  const meta = MODE_META[m];
                  const Icon = meta.icon;
                  return (
                    <DropdownItem
                      key={m}
                      onClick={() => onAgentModeChange?.(m)}
                    >
                      <span className="flex items-center gap-1.5">
                        <Icon size={10} className={meta.color} />
                        <span className={agentMode === m ? "text-accent-green" : ""}>
                          {meta.label}
                        </span>
                        <span className="text-text-muted text-[9px] ml-1">
                          {meta.description}
                        </span>
                      </span>
                    </DropdownItem>
                  );
                })}
              </Dropdown>

              {/* Profile selector — picks system prompt + tool whitelist for
                  the new conversation. The selected profile is also persisted
                  as the launch default for the next session. */}
              <Dropdown
                searchable
                searchPlaceholder="Search profiles…"
                trigger={
                  <span
                    className="text-text-secondary flex items-center gap-1"
                    title={
                      activeProfile
                        ? `Profile: ${activeProfile.name} — ${activeProfile.description}`
                        : "Pick an agent profile"
                    }
                  >
                    <User size={10} className="text-accent-blue" />
                    {activeProfile?.name ?? "Default"}
                  </span>
                }
              >
                {profiles.map((p) => (
                  <DropdownItem
                    key={p.id}
                    onClick={() => {
                      onProfileChange?.(p.id);
                      setDefaultProfile(p.id);
                    }}
                  >
                    <span className="flex items-center gap-1.5">
                      <User
                        size={10}
                        className={
                          p.isBuiltin ? "text-accent-blue" : "text-accent-purple"
                        }
                      />
                      <span
                        className={
                          activeProfileId === p.id ? "text-accent-green" : ""
                        }
                      >
                        {p.name}
                      </span>
                      <span className="text-text-muted text-[9px] ml-1 truncate max-w-[200px]">
                        {p.description}
                      </span>
                    </span>
                  </DropdownItem>
                ))}
              </Dropdown>

              {/* Worktree toggle — when on, the conversation runs inside a
                  fresh git worktree at .pkt-worktrees/<convId>. Local-only;
                  SSH targets ignore the flag (they have their own remote
                  worktree workflow via Flights). */}
              {selectedRepo && !isSshUri(selectedRepo) && (
                <button
                  type="button"
                  onClick={() => onWorktreeChange?.(!worktreeEnabled)}
                  title={
                    worktreeEnabled
                      ? "Worktree ON — conversation runs on a fresh branch in .pkt-worktrees/"
                      : "Worktree OFF — conversation edits the project tree directly"
                  }
                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] transition-colors ${
                    worktreeEnabled
                      ? "border-accent-purple/40 text-accent-purple bg-accent-purple/10"
                      : "border-bg-border text-text-muted hover:text-text-primary"
                  }`}
                >
                  <GitBranch size={10} />
                  Worktree
                </button>
              )}

              {/* Provider selector (grouped, with auth-status badges) */}
              <Dropdown
                searchable
                searchPlaceholder="Search providers…"
                trigger={
                  <span
                    className="text-text-secondary flex items-center gap-1"
                    // Refresh auth statuses when the user opens the dropdown.
                    // onMouseDown fires before Dropdown's click-toggle, so the
                    // fetch is already in flight by the time the menu renders.
                    onMouseDown={refreshAuthStatuses}
                  >
                    <Zap size={10} className="text-accent-amber" />
                    {getProviderForAgent(selectedAgent)?.name ??
                      "Select Provider"}
                    <AuthBadge
                      status={selectedAuthStatus}
                      hint={
                        selectedAuth && selectedAuth !== "loading"
                          ? selectedAuth.hint
                          : ""
                      }
                      className="ml-1"
                    />
                    {needsLogin && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleOpenLogin();
                        }}
                        onMouseDown={(e) => {
                          // Stop propagation here too so opening the
                          // dropdown's click-toggle doesn't also fire.
                          e.stopPropagation();
                        }}
                        className="ml-1 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-accent-amber hover:bg-accent-amber/10 transition-colors"
                        title={loginTooltip}
                      >
                        <LogIn size={10} />
                        Log in
                      </button>
                    )}
                  </span>
                }
              >
                {PROVIDER_GROUPS.map((group, gi) => {
                  // Build the list of renderable rows for this group — skip
                  // agents that don't exist in API_PROVIDERS (e.g. while the
                  // parallel OAuth/Codex entries haven't landed yet).
                  const rows = group.agents
                    .map((agent) => ({
                      agent,
                      info: getProviderForAgent(agent),
                    }))
                    .filter(
                      (r): r is { agent: AgentCli; info: NonNullable<typeof r.info> } =>
                        !!r.info,
                    );
                  if (rows.length === 0) return null;
                  return (
                    <div key={group.label}>
                      {gi > 0 && (
                        <div className="my-1 border-t border-bg-border" />
                      )}
                      <div className="text-[9px] uppercase tracking-wide text-text-muted px-2 py-1">
                        {group.label}
                      </div>
                      {rows.map(({ agent, info }) => {
                        const entry = authStatus[agent];
                        const status: AuthStatus =
                          entry === "loading" || !entry ? "loading" : entry.status;
                        const hint =
                          entry && entry !== "loading" ? entry.hint : "";
                        const dim = status !== "ready";
                        return (
                          <DropdownItem
                            key={agent}
                            onClick={() => {
                              onAgentChange(agent);
                              onModelChange(info.models[0]?.value ?? "");
                            }}
                          >
                            <span
                              className={`flex items-center justify-between gap-2 ${dim ? "opacity-50" : ""}`}
                            >
                              <span className="flex items-center gap-1.5">
                                <Zap size={10} className="text-accent-amber" />
                                {info.name}
                              </span>
                              <AuthBadge status={status} hint={hint} />
                            </span>
                          </DropdownItem>
                        );
                      })}
                    </div>
                  );
                })}
              </Dropdown>

              {/* Model selector */}
              {(() => {
                const provider = API_PROVIDERS.find(
                  (p) => p.agentCli === selectedAgent,
                );
                if (!provider) return null;

                const isOllama = selectedAgent === "api-ollama";

                // Trigger label. When in Ollama mode the label swaps to the
                // live-fetched model name (just the `name` string, there is
                // no separate display label for Ollama installs).
                let triggerLabel: string;
                if (isOllama) {
                  if (Array.isArray(ollamaModels)) {
                    const match = ollamaModels.find(
                      (m) => m.name === selectedModel,
                    );
                    triggerLabel =
                      match?.name ??
                      selectedModel ??
                      ollamaModels[0]?.name ??
                      "Select model";
                  } else if (ollamaModels === "loading") {
                    triggerLabel = selectedModel || "Loading models…";
                  } else {
                    triggerLabel = selectedModel || "Ollama unreachable";
                  }
                } else {
                  const currentModel =
                    provider.models.find((m) => m.value === selectedModel) ??
                    provider.models[0];
                  triggerLabel = currentModel?.label ?? "Select model";
                }

                const speed = getModelSpeed(selectedModel);
                const speedClass =
                  speed === "fast"
                    ? "text-accent-green bg-accent-green/10"
                    : speed === "thorough"
                      ? "text-accent-purple bg-accent-purple/10"
                      : "text-accent-blue bg-accent-blue/10";

                return (
                  <Dropdown
                    searchable
                    searchPlaceholder="Search models…"
                    trigger={
                      <span className="flex items-center gap-1.5 text-text-muted text-[10px]">
                        <span>{triggerLabel}</span>
                        <span
                          className={`px-1 py-px rounded text-[9px] font-medium ${speedClass}`}
                          title={`${MODEL_SPEED_LABEL[speed]} mode (heuristic)`}
                        >
                          {MODEL_SPEED_LABEL[speed]}
                        </span>
                      </span>
                    }
                  >
                    {isOllama ? (
                      <>
                        {/* Refresh header — Ollama-specific. */}
                        <div className="flex items-center justify-between px-2 py-1 text-[9px] uppercase tracking-wide text-text-muted">
                          <span>Installed models</span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              refreshOllamaModels();
                            }}
                            className="p-0.5 rounded hover:bg-bg-hover text-text-muted hover:text-text-secondary transition-colors"
                            title="Refresh installed Ollama models"
                          >
                            <RefreshCw size={10} />
                          </button>
                        </div>
                        {ollamaModels === "loading" ? (
                          <DropdownItem
                            onClick={() => {
                              /* disabled */
                            }}
                          >
                            <span className="flex items-center gap-1.5 text-text-muted opacity-60">
                              <Loader2
                                size={10}
                                className="animate-spin"
                              />
                              Loading models…
                            </span>
                          </DropdownItem>
                        ) : !Array.isArray(ollamaModels) ? (
                          <>
                            <DropdownItem
                              onClick={() => {
                                /* disabled */
                              }}
                            >
                              <span className="flex items-center gap-1.5 text-accent-red opacity-80">
                                <AlertCircle size={10} />
                                {ollamaModels.error}
                              </span>
                            </DropdownItem>
                            <DropdownItem
                              onClick={() => refreshOllamaModels()}
                            >
                              <span className="flex items-center gap-1.5 text-text-secondary">
                                <RefreshCw size={10} />
                                Retry
                              </span>
                            </DropdownItem>
                          </>
                        ) : ollamaModels.length === 0 ? (
                          <DropdownItem
                            onClick={() => {
                              /* disabled */
                            }}
                          >
                            <span className="text-text-muted opacity-70 text-[10px]">
                              No models installed. Run{" "}
                              <code className="text-text-secondary">
                                ollama pull &lt;model&gt;
                              </code>{" "}
                              in a terminal.
                            </span>
                          </DropdownItem>
                        ) : (
                          ollamaModels.map((m) => (
                            <DropdownItem
                              key={m.name}
                              onClick={() => onModelChange(m.name)}
                            >
                              <span className="flex items-center justify-between gap-2 w-full">
                                <span className="truncate">{m.name}</span>
                                {typeof m.size === "number" && (
                                  <span className="text-text-muted text-[9px] shrink-0">
                                    {(m.size / 1e9).toFixed(1)} GB
                                  </span>
                                )}
                              </span>
                            </DropdownItem>
                          ))
                        )}
                      </>
                    ) : (
                      provider.models.map((m) => (
                        <DropdownItem
                          key={m.value}
                          onClick={() => onModelChange(m.value)}
                        >
                          {m.label}
                        </DropdownItem>
                      ))
                    )}
                  </Dropdown>
                );
              })()}
            </div>

            <div className="flex items-center gap-1">
              {/* Mic button */}
              {isSupported && (
                <button
                  onClick={isListening ? stopListening : startListening}
                  className={`p-1.5 rounded-full transition-colors ${
                    isListening
                      ? "bg-accent-green/20 text-accent-green animate-pulse"
                      : "text-text-muted hover:text-text-secondary"
                  }`}
                  title={isListening ? "Stop listening" : "Voice input"}
                >
                  <Mic size={14} />
                </button>
              )}

              {/* Launch button — gated on provider auth status */}
              <button
                onClick={() => {
                  if (launchReady) submitWithAttachments();
                }}
                disabled={!launchReady}
                title={
                  launchReady
                    ? "Launch (Enter)"
                    : needsLogin
                      ? loginTooltip
                      : selectedAuth && selectedAuth !== "loading"
                        ? selectedAuth.hint || launchLabel
                        : launchLabel
                }
                className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                  launchReady
                    ? "bg-accent-green/20 text-accent-green hover:bg-accent-green/30"
                    : "bg-bg-hover text-text-muted cursor-not-allowed"
                }`}
              >
                <Send size={10} />
                {launchLabel}
              </button>
            </div>
          </div>
        </div>

        <p className="text-[9px] text-text-muted mt-2 text-center">
          Enter to send &middot; Shift+Enter for newline &middot; Ctrl+N for new
          agent &middot; @ to mention a file &middot; drag/paste images
        </p>
      </div>

      {sshModalOpen && (
        <SshConnectModal
          onClose={() => setSshModalOpen(false)}
          onConnected={handleSshConnected}
        />
      )}
    </div>
  );
}

function RecentRow({
  icon,
  label,
  selected,
}: {
  icon: React.ReactNode;
  label: string;
  selected: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-1.5 min-w-0">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      {selected && <Check size={12} className="text-accent-green shrink-0" />}
    </div>
  );
}
