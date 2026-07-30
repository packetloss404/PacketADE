import { useMemo, useState } from "react";
import {
  AlertTriangle,
  GitPullRequest,
  Route,
  Rocket,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { useAppStore } from "@/stores/appStore";
import { useFlightStore } from "@/stores/flightStore";
import {
  findAsyncLaunchPathCollisions,
  formatAsyncLaunchPathCollisionMessage,
  useAsyncFlightStore,
} from "@/stores/asyncFlightStore";
import { useGitHubStore } from "@/stores/githubStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useAgentTaskStore, type AgentCli } from "@/stores/agentTaskStore";
import { requestConversationSave } from "@/stores/agentConversationPersistence";
import { openConversationInAgents } from "@/stores/sessionGlue";
import {
  buildFlightPlanningSystemPrompt,
  FLIGHT_PLANNING_ALLOWED_TOOLS,
} from "@/lib/flightPlanning";
import { useMemoryStore } from "@/stores/memoryStore";
import { useOrchestrationSettingsStore } from "@/stores/orchestrationSettingsStore";
import { selectRecurringErrorHint } from "@/lib/recurringErrorHint";
import { MultiTargetPicker, type PickedTarget } from "./MultiTargetPicker";
import { type AttemptTargetSpec } from "@/lib/tauri";
import type {
  AutonomyFlightMode,
  AutonomyPolicy,
  AutonomyRuntime,
  FlightPriority,
} from "@/types/flight";
import { API_PROVIDERS, getDefaultModel } from "@/lib/api-models";
import { pathWithinAllowedRoots, validateAutonomyPolicy } from "@/lib/autonomyPolicy";

interface LaunchAsyncFlightModalProps {
  onClose: () => void;
  onLaunched?: (flightId: string) => void;
  // When set, launch attempts into this existing flight instead of minting a
  // new one (e.g. "Launch attempt" from an already-staged flight's detail
  // pane, or GitHub's "Plan flight" hand-off). The prompt/title fields are
  // pre-filled from the flight's objective/title but remain editable.
  flightId?: string;
}

function pickedToSpec(p: PickedTarget): AttemptTargetSpec {
  if (p.kind === "local") {
    return {
      kind: "local",
      basePath: p.basePath,
      baseBranch: p.baseBranch,
      agentConfigId: p.agent,
      provider: p.agent.replace(/^api-/, ""),
      model: p.model,
    };
  }
  return {
    kind: "ssh",
    // Phase 2: targetId is now the ServerConfig.id (was SshTarget.id).
    // The backend agent will be updated to call the field `serverId`
    // in the same PR — until then we keep the name for wire compat.
    targetId: p.server.id,
    host: p.server.host,
    port: p.server.port,
    user: p.server.username,
    keyPath: p.server.keyPath ?? null,
    authMethod: p.server.authMethod,
    hostFingerprint: p.server.hostFingerprint ?? null,
    basePath: p.basePath,
    baseBranch: p.baseBranch,
    agentConfigId: p.agent,
    provider: p.agent.replace(/^api-/, ""),
    model: p.model,
  };
}

export function LaunchAsyncFlightModal({
  onClose,
  onLaunched,
  flightId,
}: LaunchAsyncFlightModalProps) {
  const addFlight = useFlightStore((s) => s.addFlight);
  const updateFlight = useFlightStore((s) => s.updateFlight);
  const flushFlightPersistence = useFlightStore((s) => s.flushPersistence);
  const flights = useFlightStore((s) => s.flights);
  const launchAsync = useAsyncFlightStore((s) => s.launchAsync);
  const activeWorkspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId),
  );
  const projectPath = useLayoutStore((s) => s.projectPath);
  const setActiveView = useAppStore((s) => s.setActiveView);
  // v0.8: pre-check the publish toggle if the user opted into that default
  // via Settings → GitHub.
  const defaultPublishAttemptsAsPrs = useGitHubStore((s) => s.defaultPublishAttemptsAsPrs);
  const autonomyDefaultMode = useOrchestrationSettingsStore((s) => s.autonomyDefaultMode);
  const autonomyDefaultPolicy = useOrchestrationSettingsStore((s) => s.autonomyDefaultPolicy);

  const existingFlight = useMemo(
    () => (flightId ? (flights.find((f) => f.id === flightId) ?? null) : null),
    // flights is a fresh array each render but we only need the lookup to
    // re-run when the target id or flight count changes; the modal is
    // short-lived so staleness here is not a concern.
    [flightId, flights],
  );
  const planningConversationExists = useAgentTaskStore((state) =>
    existingFlight?.planningConversationId
      ? state.conversations.some((item) => item.id === existingFlight.planningConversationId)
      : false,
  );

  const [prompt, setPrompt] = useState(() => existingFlight?.objective ?? "");
  const [title, setTitle] = useState(() => existingFlight?.title ?? "");
  const [picked, setPicked] = useState<PickedTarget[]>([]);
  const [launching, setLaunching] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // v0.8-G: per-attempt draft-PR publish toggle. When enabled, the
  // asyncFlightStore pipeline pushes each attempt's branch and opens a
  // draft GitHub PR once it reaches a terminal state.
  const [publishAsPrs, setPublishAsPrs] = useState(defaultPublishAttemptsAsPrs);
  const [reviewerEnabled, setReviewerEnabled] = useState(
    existingFlight?.reviewGatePolicy?.enabled ?? false,
  );
  const [reviewerAgent, setReviewerAgent] = useState<AgentCli>(
    (existingFlight?.reviewGatePolicy?.reviewerAgentConfigId as AgentCli | undefined) ??
      "api-openai-codex",
  );
  const [reviewerModel, setReviewerModel] = useState(
    existingFlight?.reviewGatePolicy?.reviewerModel ?? getDefaultModel("api-openai-codex"),
  );
  const [acceptanceCriteria, setAcceptanceCriteria] = useState(
    existingFlight?.reviewGatePolicy?.acceptanceCriteria.join("\n") ?? "",
  );
  const [autonomyMode, setAutonomyMode] = useState<AutonomyFlightMode>(
    existingFlight?.autonomyMode ?? "assisted",
  );

  const promptShort = useMemo(
    () => (prompt.length > 60 ? prompt.slice(0, 57) + "…" : prompt),
    [prompt],
  );

  // M6: "this looks familiar" — warn when the prompt overlaps a known pitfall
  // pattern or a lesson that has recurred across prior flights.
  const memoryPatterns = useMemoryStore((s) => s.patterns);
  const memoryEvents = useMemoryStore((s) => s.events);
  const recurringHint = useMemo(
    () => selectRecurringErrorHint(prompt, memoryPatterns, memoryEvents),
    [prompt, memoryPatterns, memoryEvents],
  );

  const targetSpecs = useMemo(() => picked.map(pickedToSpec), [picked]);
  const launchCollisions = useMemo(
    () => findAsyncLaunchPathCollisions(existingFlight?.id ?? null, targetSpecs, flights),
    [existingFlight, flights, targetSpecs],
  );
  const collisionMessage = useMemo(
    () =>
      launchCollisions.length > 0 ? formatAsyncLaunchPathCollisionMessage(launchCollisions) : null,
    [launchCollisions],
  );

  // #8a: block launches that target SSH servers without a pinned host key.
  // Without a fingerprint the backend falls back to StrictHostKeyChecking=
  // accept-new (TOFU), which is MITM-able on first connect. Mirror the gate
  // in WorkspaceCreationModal (same `!server.hostFingerprint` falsy check —
  // hostFingerprint is `string | undefined`). The realistic trigger is
  // legacy-migrated servers that predate fingerprint capture. Local targets
  // stay launchable; only unpinned SSH picks block.
  const unpinnedTargets = useMemo(
    () => picked.filter((p) => p.kind === "ssh" && !p.server.hostFingerprint),
    [picked],
  );
  const unpinnedMessage = useMemo(() => {
    if (unpinnedTargets.length === 0) return null;
    const names = unpinnedTargets
      .map((p) => (p.kind === "ssh" ? p.server.name : p.label))
      .join(", ");
    return `Host key not verified for: ${names}. Verify on the Servers page before launching.`;
  }, [unpinnedTargets]);

  const reviewerProvider = API_PROVIDERS.find((provider) => provider.agentCli === reviewerAgent);
  const parsedAcceptanceCriteria = useMemo(
    () =>
      acceptanceCriteria
        .split("\n")
        .map((criterion) => criterion.trim())
        .filter(Boolean),
    [acceptanceCriteria],
  );
  const reviewerConfigurationError = useMemo(() => {
    if (!reviewerEnabled) return null;
    if (!reviewerProvider) return "Choose a supported API reviewer.";
    if (!reviewerProvider.models.some((model) => model.value === reviewerModel)) {
      return "Choose a model supported by the selected reviewer.";
    }
    if (parsedAcceptanceCriteria.length === 0) {
      return "Add at least one acceptance criterion for the independent reviewer.";
    }
    if (parsedAcceptanceCriteria.length > 40) {
      return "Reviewer Gate supports at most 40 acceptance criteria.";
    }
    return null;
  }, [parsedAcceptanceCriteria, reviewerEnabled, reviewerModel, reviewerProvider]);

  const explicitYoloPolicy = useMemo<AutonomyPolicy>(
    () => ({
      ...autonomyDefaultPolicy,
      autoReviewRemediation: autonomyDefaultPolicy.autoReviewRemediation && reviewerEnabled,
      autoRunTaskGraph:
        autonomyDefaultPolicy.autoRunTaskGraph &&
        existingFlight?.executionMode === "cooperative" &&
        reviewerEnabled,
      allowedRoots: Array.from(
        new Set([
          ...autonomyDefaultPolicy.allowedRoots,
          ...picked.map((target) => target.basePath),
          ...(existingFlight?.projectPath ? [existingFlight.projectPath] : []),
        ]),
      ),
      allowedTargets: Array.from(
        new Set([
          ...autonomyDefaultPolicy.allowedTargets,
          ...picked.map((target) => (target.kind === "ssh" ? target.server.id : "local")),
        ]),
      ),
      allowDraftPrPublishing: publishAsPrs,
    }),
    [
      autonomyDefaultPolicy,
      existingFlight?.executionMode,
      existingFlight?.projectPath,
      picked,
      publishAsPrs,
      reviewerEnabled,
    ],
  );
  const settingsPolicy = autonomyDefaultMode === "yolo" ? autonomyDefaultPolicy : undefined;
  const effectiveAutonomyPolicy =
    autonomyMode === "yolo"
      ? explicitYoloPolicy
      : autonomyMode === "settings_default"
        ? settingsPolicy
        : undefined;
  const autonomyConfigurationError = useMemo(() => {
    if (!effectiveAutonomyPolicy) return null;
    const baseError = validateAutonomyPolicy(effectiveAutonomyPolicy)[0];
    if (baseError) return baseError;
    for (const target of picked) {
      if (!pathWithinAllowedRoots(target.basePath, effectiveAutonomyPolicy.allowedRoots)) {
        return `${target.label} is outside the autonomy root allowlist.`;
      }
      const targetId = target.kind === "ssh" ? target.server.id : "local";
      if (!effectiveAutonomyPolicy.allowedTargets.includes(targetId)) {
        return `${target.label} is outside the autonomy target allowlist.`;
      }
    }
    if (
      effectiveAutonomyPolicy.autoRunTaskGraph &&
      existingFlight?.executionMode !== "cooperative"
    ) {
      return "Auto-run task graph requires a Cooperative Flight.";
    }
    if (effectiveAutonomyPolicy.autoRunTaskGraph && !reviewerEnabled) {
      return "Auto-run task graph requires the independent Reviewer Gate.";
    }
    return null;
  }, [effectiveAutonomyPolicy, existingFlight?.executionMode, picked, reviewerEnabled]);

  function handleOpenServersView() {
    setActiveView("tools");
    onClose();
  }

  const canLaunch =
    prompt.trim().length > 0 &&
    picked.length > 0 &&
    launchCollisions.length === 0 &&
    unpinnedTargets.length === 0 &&
    reviewerConfigurationError === null &&
    autonomyConfigurationError === null &&
    !launching &&
    !planning;

  const canOpenExistingPlan = Boolean(
    existingFlight?.planningConversationId && planningConversationExists,
  );
  const canPlan =
    !launching &&
    !planning &&
    (canOpenExistingPlan ||
      (prompt.trim().length > 0 && picked.length > 0 && unpinnedTargets.length === 0));

  function autonomyFields(starting: boolean): {
    autonomyMode: AutonomyFlightMode;
    autonomyPolicy?: AutonomyPolicy;
    autonomyRuntime?: AutonomyRuntime;
  } {
    if (!effectiveAutonomyPolicy) return { autonomyMode };
    const previous = existingFlight?.autonomyRuntime;
    const reusePrevious = previous && previous.status !== "stopped";
    return {
      autonomyMode,
      autonomyPolicy: {
        ...effectiveAutonomyPolicy,
        allowedRoots: [...effectiveAutonomyPolicy.allowedRoots],
        allowedTargets: [...effectiveAutonomyPolicy.allowedTargets],
      },
      autonomyRuntime: reusePrevious
        ? previous
        : {
            status: starting ? "running" : "idle",
            startedAt: starting ? Date.now() : undefined,
            actionHistory: [],
          },
    };
  }

  function createOrUpdateFlight(startingAutonomy = false) {
    if (existingFlight) {
      const updates = {
        title: title.trim() || existingFlight.title,
        objective: prompt.trim(),
        prompt: prompt.trim(),
        publishAttemptsAsPrs: publishAsPrs,
        reviewGatePolicy: reviewerEnabled
          ? {
              enabled: true,
              reviewerAgentConfigId: reviewerAgent,
              reviewerModel,
              acceptanceCriteria: parsedAcceptanceCriteria,
            }
          : undefined,
        ...autonomyFields(startingAutonomy),
      };
      updateFlight(existingFlight.id, updates);
      return { ...existingFlight, ...updates };
    }
    const primaryTarget = picked[0];
    const targetWorkspaceId =
      primaryTarget.kind === "local"
        ? primaryTarget.workspaceId
        : activeWorkspace?.serverId === primaryTarget.server.id
          ? activeWorkspace.id
          : null;
    return addFlight({
      title: title.trim() || promptShort || "Untitled flight",
      objective: prompt.trim(),
      priority: "medium" as FlightPriority,
      projectPath: primaryTarget.basePath || activeWorkspace?.projectPath || projectPath || "",
      workspaceId: targetWorkspaceId,
      issueIds: [],
      publishAttemptsAsPrs: publishAsPrs,
      reviewGatePolicy: reviewerEnabled
        ? {
            enabled: true,
            reviewerAgentConfigId: reviewerAgent,
            reviewerModel,
            acceptanceCriteria: parsedAcceptanceCriteria,
          }
        : undefined,
      ...autonomyFields(startingAutonomy),
    });
  }

  async function handlePlanFirst() {
    if (!canPlan) return;
    setPlanning(true);
    setError(null);
    try {
      const currentConversationId = existingFlight?.planningConversationId;
      if (
        currentConversationId &&
        useAgentTaskStore.getState().conversations.some((item) => item.id === currentConversationId)
      ) {
        openConversationInAgents(currentConversationId);
        onClose();
        return;
      }
      if (picked.length === 0) {
        setError("Select an agent to start a new planning conversation.");
        return;
      }

      const flight = createOrUpdateFlight(false);
      await flushFlightPersistence();
      const target = picked[0];
      const sshTarget =
        target.kind === "ssh"
          ? {
              serverId: target.server.id,
              name: target.server.name,
              host: target.server.host,
              port: target.server.port,
              user: target.server.username,
              remotePath: target.basePath,
              keyPath: target.server.keyPath ?? null,
              authMethod: target.server.authMethod,
              hostFingerprint: target.server.hostFingerprint ?? null,
            }
          : null;
      const conversationId = await useAgentTaskStore.getState().createApiConversation({
        agent: target.agent,
        projectPath: target.basePath,
        model: target.model,
        initialMessage: `Create an implementation-ready upfront plan for this Flight.\n\nObjective:\n${prompt.trim()}`,
        systemPromptOverride: buildFlightPlanningSystemPrompt(flight.id),
        planMode: false,
        sshTarget,
        allowedTools: FLIGHT_PLANNING_ALLOWED_TOOLS,
        enabledMcpServerIds: [],
        memoryContextEnabled: true,
        permissionMode: "deny_all",
        approveWrites: false,
      });

      useAgentTaskStore.setState((state) => ({
        conversations: state.conversations.map((conversation) =>
          conversation.id === conversationId
            ? { ...conversation, title: `Flight plan — ${flight.title}` }
            : conversation,
        ),
      }));
      requestConversationSave(conversationId);
      updateFlight(flight.id, {
        planningConversationId: conversationId,
        linkedSessionIds: Array.from(new Set([...flight.linkedSessionIds, conversationId])),
        prompt: prompt.trim(),
        status: "planning",
      });
      await flushFlightPersistence();
      onLaunched?.(flight.id);
      openConversationInAgents(conversationId);
      onClose();
    } catch (e) {
      setError(typeof e === "string" ? e : ((e as Error)?.message ?? "Planning failed"));
    } finally {
      setPlanning(false);
    }
  }

  async function handleLaunch() {
    if (!canLaunch) return;
    setLaunching(true);
    setError(null);
    try {
      if (collisionMessage) {
        setError(collisionMessage);
        return;
      }
      // When launching into an already-staged flight (e.g. from GitHub's
      // "Plan flight" hand-off or the Flights detail pane's empty-attempts
      // state), reuse it instead of minting a disconnected duplicate.
      const flight = createOrUpdateFlight(true);

      // The backend appends Attempts to the persisted Flight. Ensure the
      // create/update above has landed first; otherwise a fast launch can see
      // "Flight not found" or race a delayed stale whole-slice write.
      await flushFlightPersistence();

      await launchAsync(flight.id, prompt.trim(), targetSpecs);

      onLaunched?.(flight.id);
      onClose();
    } catch (e) {
      setError(typeof e === "string" ? e : ((e as Error)?.message ?? "Launch failed"));
    } finally {
      setLaunching(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.ctrlKey && e.key === "Enter") {
      e.preventDefault();
      void handleLaunch();
    }
  }

  const footer = (
    <div className="flex items-center justify-between">
      <span className="text-[10px] text-text-muted">
        Ctrl+Enter to launch · Each agent runs in its own git worktree
      </span>
      <div className="flex items-center gap-2">
        <button
          onClick={onClose}
          disabled={launching || planning}
          className="px-3 py-1.5 text-xs text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={() => void handlePlanFirst()}
          disabled={!canPlan}
          className="bg-accent-purple/10 border-accent-purple/30 hover:bg-accent-purple/20 flex items-center gap-1.5 rounded border px-3 py-1.5 text-xs font-medium text-accent-purple transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          title="Explore the repository and refine a structured plan in a normal agent conversation"
        >
          <Route size={11} />
          {planning ? "Starting plan…" : canOpenExistingPlan ? "Open plan" : "Plan first"}
        </button>
        <button
          onClick={() => void handleLaunch()}
          disabled={!canLaunch}
          className="bg-accent-green/15 border-accent-green/30 hover:bg-accent-green/25 flex items-center gap-1.5 rounded border px-4 py-1.5 text-xs font-medium text-accent-green transition-colors disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Rocket size={11} />
          Launch {picked.length || ""} {picked.length === 1 ? "agent" : "agents"}
        </button>
      </div>
    </div>
  );

  return (
    <Modal
      onClose={launching || planning ? () => {} : onClose}
      title={
        existingFlight
          ? `Launch attempt — ${existingFlight.title || "Untitled flight"}`
          : "Launch parallel agents"
      }
      icon={<Sparkles size={14} className="text-accent-green" />}
      width="w-[820px] max-w-[92vw]"
      footer={footer}
    >
      <div className="flex flex-col gap-4 px-5 py-4" onKeyDown={handleKeyDown}>
        {/* Prompt */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] font-medium text-text-secondary">Prompt</label>
          <textarea
            autoFocus
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should the agents work on? Each agent runs the same prompt independently."
            rows={4}
            className="focus:border-accent-green/50 w-full resize-none rounded border border-bg-border bg-bg-primary px-3 py-2 text-xs text-text-primary outline-none placeholder:text-text-muted"
          />
          {recurringHint && (
            <div className="border-accent-amber/40 bg-accent-amber/10 flex items-start gap-1.5 rounded border px-2.5 py-1.5 text-[11px] leading-snug text-accent-amber">
              <AlertTriangle size={12} className="mt-px shrink-0" />
              <span>
                <span className="font-medium">This looks familiar</span>
                {recurringHint.source === "failure" && recurringHint.occurrences
                  ? ` (hit in ${recurringHint.occurrences} prior flight${recurringHint.occurrences === 1 ? "" : "s"})`
                  : ""}
                : {recurringHint.text}
              </span>
            </div>
          )}
        </div>

        {/* Title (optional) */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] font-medium text-text-secondary">
            Title <span className="font-normal text-text-muted">(optional)</span>
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={promptShort || "Auto-generated from prompt"}
            className="focus:border-accent-green/50 w-full rounded border border-bg-border bg-bg-primary px-3 py-2 text-xs text-text-primary outline-none placeholder:text-text-muted"
          />
        </div>

        {/* Targets */}
        <MultiTargetPicker picked={picked} onChange={setPicked} />

        <div className="border-accent-purple/20 bg-accent-purple/5 rounded border px-3 py-2 text-[10px] leading-relaxed text-text-muted">
          <span className="font-medium text-text-secondary">Plan first</span> uses the first
          selected agent in a read-only conversation. Refine the plan there, apply it to this
          Flight, then configure and launch attempts when you are ready.
        </div>

        <div className="border-accent-amber/25 bg-accent-amber/5 rounded border px-3 py-2.5">
          <div className="flex items-start gap-2">
            <ShieldAlert size={12} className="mt-0.5 shrink-0 text-accent-amber" />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-medium text-text-secondary">
                Execution supervision
              </div>
              <div className="mt-2 grid grid-cols-3 gap-1">
                {(
                  [
                    ["assisted", "Assisted"],
                    ["settings_default", "Settings default"],
                    ["yolo", "YOLO"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setAutonomyMode(value)}
                    className={`rounded border px-2 py-1 text-[10px] ${
                      autonomyMode === value
                        ? value === "yolo"
                          ? "border-accent-amber/50 bg-accent-amber/15 text-accent-amber"
                          : "border-accent-green/40 bg-accent-green/10 text-accent-green"
                        : "border-bg-border text-text-muted"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {effectiveAutonomyPolicy ? (
                <div className="mt-2 text-[10px] leading-relaxed text-text-muted">
                  <span className="font-medium text-text-secondary">Effective bounds:</span> $
                  {effectiveAutonomyPolicy.maxTotalCost.toFixed(2)} ·{" "}
                  {effectiveAutonomyPolicy.maxDurationMinutes} min ·{" "}
                  {effectiveAutonomyPolicy.maxRetriesPerTask} retries/task ·{" "}
                  {effectiveAutonomyPolicy.maxReviewRounds} review rounds ·{" "}
                  {effectiveAutonomyPolicy.maxConcurrentAgents} agents. Enabled:{" "}
                  {[
                    effectiveAutonomyPolicy.autoRecovery && "recovery",
                    effectiveAutonomyPolicy.autoReviewRemediation && "review remediation",
                    effectiveAutonomyPolicy.autoRunTaskGraph && "task graph",
                    effectiveAutonomyPolicy.toolPosture === "allow_in_project" &&
                      "unattended in-project tools",
                  ]
                    .filter(Boolean)
                    .join(", ") || "limits only"}
                  .
                </div>
              ) : (
                <p className="mt-2 text-[10px] leading-relaxed text-text-muted">
                  {autonomyMode === "settings_default"
                    ? "Settings currently resolves this Flight to Assisted mode."
                    : "PacketADE detects and recommends; you launch, retry, accept, and integrate."}
                </p>
              )}
              {autonomyConfigurationError && (
                <p className="mt-1 text-[10px] text-accent-amber">{autonomyConfigurationError}</p>
              )}
            </div>
          </div>
        </div>

        {/* v0.8-G: publish attempts as draft PRs */}
        <label className="group flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            checked={publishAsPrs}
            onChange={(e) => setPublishAsPrs(e.target.checked)}
            className="mt-0.5 accent-accent-green"
          />
          <div className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-text-secondary group-hover:text-text-primary">
              <GitPullRequest size={11} className="text-accent-purple" />
              Publish attempts as draft PRs
            </span>
            <span className="text-[10px] leading-snug text-text-muted">
              After each attempt, push the branch and open a draft PR on GitHub. Lets you review
              attempts via your normal PR flow.
            </span>
          </div>
        </label>

        <div className="bg-bg-secondary/40 rounded border border-bg-border px-3 py-2.5">
          <label className="group flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              checked={reviewerEnabled}
              onChange={(event) => setReviewerEnabled(event.target.checked)}
              className="mt-0.5 accent-accent-green"
            />
            <div className="flex flex-col gap-0.5">
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-text-secondary group-hover:text-text-primary">
                <ShieldCheck size={11} className="text-accent-green" />
                Require an independent Reviewer Gate
              </span>
              <span className="text-[10px] leading-snug text-text-muted">
                When an attempt finishes, automatically run one read-only reviewer. This incurs
                model usage. Acceptance stays blocked until it passes or you record an override.
              </span>
            </div>
          </label>

          {reviewerEnabled && (
            <div className="mt-2.5 grid grid-cols-[180px_1fr] gap-2 border-t border-bg-border pt-2.5">
              <select
                aria-label="Reviewer agent"
                value={reviewerAgent}
                onChange={(event) => {
                  const agent = event.target.value as AgentCli;
                  setReviewerAgent(agent);
                  setReviewerModel(getDefaultModel(agent));
                }}
                className="focus:border-accent-green/40 rounded border border-bg-border bg-bg-primary px-2 py-1 text-[10px] text-text-secondary outline-none"
              >
                {API_PROVIDERS.map((provider) => (
                  <option key={provider.agentCli} value={provider.agentCli}>
                    {provider.name}
                  </option>
                ))}
              </select>
              <select
                aria-label="Reviewer model"
                value={reviewerModel}
                onChange={(event) => setReviewerModel(event.target.value)}
                className="focus:border-accent-green/40 rounded border border-bg-border bg-bg-primary px-2 py-1 text-[10px] text-text-secondary outline-none"
              >
                {reviewerProvider?.models.map((model) => (
                  <option key={model.value} value={model.value}>
                    {model.label}
                  </option>
                ))}
              </select>
              <textarea
                aria-label="Reviewer acceptance criteria"
                value={acceptanceCriteria}
                onChange={(event) => setAcceptanceCriteria(event.target.value)}
                rows={3}
                placeholder={"Acceptance criteria — one per line\nExample: pnpm test passes"}
                className="focus:border-accent-green/40 col-span-2 resize-none rounded border border-bg-border bg-bg-primary px-2 py-1.5 text-[10px] text-text-primary outline-none placeholder:text-text-muted"
              />
              {reviewerConfigurationError && (
                <span className="col-span-2 text-[10px] text-accent-amber">
                  {reviewerConfigurationError}
                </span>
              )}
            </div>
          )}
        </div>

        {unpinnedMessage && (
          <div className="bg-accent-amber/10 border-accent-amber/30 flex items-start gap-2 rounded border px-3 py-2 text-[11px] text-accent-amber">
            <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
            <div className="flex-1">
              <span>{unpinnedMessage}</span>
              <button
                type="button"
                onClick={handleOpenServersView}
                className="mt-1 block underline hover:text-accent-amber"
              >
                Open Servers settings →
              </button>
            </div>
          </div>
        )}

        {collisionMessage && (
          <div className="bg-accent-amber/10 border-accent-amber/30 whitespace-pre-wrap rounded border px-3 py-2 text-[11px] text-accent-amber">
            {collisionMessage}
          </div>
        )}

        {error && (
          <div className="bg-accent-red/10 border-accent-red/30 rounded border px-3 py-2 text-[11px] text-accent-red">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
