import { create } from "zustand";
import { storageKey } from "@/lib/brand";

export type WorkspaceAgentsDogfoodEvent =
  | "agent_started_agents"
  | "conversation_opened_agents"
  | "workspace_delegated_agents"
  | "agent_opened_workspace_project"
  // Schema-v1 history only. No production path records this after WA4.
  | "agent_opened_alongside_workspace"
  | "agent_attached_terminal"
  | "agent_packetcode_handoff"
  | "agent_opened_git_ending"
  | "agent_linked_flight"
  | "flight_attempt_opened_workspace"
  | "agent_monitor_opened"
  | "flight_monitor_opened"
  | "compatibility_pane_loaded"
  | "compatibility_pane_load_failed";

export const WORKSPACE_AGENTS_DOGFOOD_EVENTS: WorkspaceAgentsDogfoodEvent[] = [
  "agent_started_agents",
  "conversation_opened_agents",
  "workspace_delegated_agents",
  "agent_opened_workspace_project",
  "agent_opened_alongside_workspace",
  "agent_attached_terminal",
  "agent_packetcode_handoff",
  "agent_opened_git_ending",
  "agent_linked_flight",
  "flight_attempt_opened_workspace",
  "agent_monitor_opened",
  "flight_monitor_opened",
  "compatibility_pane_loaded",
  "compatibility_pane_load_failed",
];

export interface WorkspaceAgentsDogfoodEvidence {
  schemaVersion: 1;
  startedAt: number;
  updatedAt: number;
  counters: Record<WorkspaceAgentsDogfoodEvent, number>;
  attention: {
    samples: number;
    totalResponseMs: number;
    maxResponseMs: number;
  };
  displayTopology: {
    samples: number;
    singleDisplaySamples: number;
    multiDisplaySamples: number;
    maxDisplayCount: number;
  };
  visibility: {
    samples: number;
    maxSimultaneousConversations: number;
  };
  migration: {
    audits: number;
    conversationPanes: number;
    missingConversationReferences: number;
    orphanConversationWrappers: number;
  };
}

interface WorkspaceAgentsDogfoodStore {
  evidence: WorkspaceAgentsDogfoodEvidence;
  record: (event: WorkspaceAgentsDogfoodEvent) => void;
  recordAttentionResponse: (responseMs: number) => void;
  recordDisplayTopology: (displayCount: number) => void;
  recordVisibleConversations: (count: number) => void;
  recordMigrationAudit: (input: {
    conversationPanes: number;
    missingConversationReferences: number;
    orphanConversationWrappers: number;
  }) => void;
  reset: () => void;
}

const STORAGE_KEY = storageKey("workspace-agents-dogfood-v1");
const eventSet = new Set<string>(WORKSPACE_AGENTS_DOGFOOD_EVENTS);

function emptyCounters(): Record<WorkspaceAgentsDogfoodEvent, number> {
  return Object.fromEntries(WORKSPACE_AGENTS_DOGFOOD_EVENTS.map((event) => [event, 0])) as Record<
    WorkspaceAgentsDogfoodEvent,
    number
  >;
}

function emptyEvidence(now = Date.now()): WorkspaceAgentsDogfoodEvidence {
  return {
    schemaVersion: 1,
    startedAt: now,
    updatedAt: now,
    counters: emptyCounters(),
    attention: { samples: 0, totalResponseMs: 0, maxResponseMs: 0 },
    displayTopology: {
      samples: 0,
      singleDisplaySamples: 0,
      multiDisplaySamples: 0,
      maxDisplayCount: 0,
    },
    visibility: { samples: 0, maxSimultaneousConversations: 0 },
    migration: {
      audits: 0,
      conversationPanes: 0,
      missingConversationReferences: 0,
      orphanConversationWrappers: 0,
    },
  };
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER)
    : 0;
}

function normalizeEvidence(raw: unknown): WorkspaceAgentsDogfoodEvidence {
  if (!raw || typeof raw !== "object") return emptyEvidence();
  const value = raw as Partial<WorkspaceAgentsDogfoodEvidence>;
  const now = Date.now();
  const counters = emptyCounters();
  if (value.counters && typeof value.counters === "object") {
    for (const [key, count] of Object.entries(value.counters)) {
      if (eventSet.has(key)) {
        counters[key as WorkspaceAgentsDogfoodEvent] = finiteNonNegative(count);
      }
    }
  }
  return {
    schemaVersion: 1,
    startedAt: finiteNonNegative(value.startedAt) || now,
    updatedAt: finiteNonNegative(value.updatedAt) || now,
    counters,
    attention: {
      samples: finiteNonNegative(value.attention?.samples),
      totalResponseMs: finiteNonNegative(value.attention?.totalResponseMs),
      maxResponseMs: finiteNonNegative(value.attention?.maxResponseMs),
    },
    displayTopology: {
      samples: finiteNonNegative(value.displayTopology?.samples),
      singleDisplaySamples: finiteNonNegative(value.displayTopology?.singleDisplaySamples),
      multiDisplaySamples: finiteNonNegative(value.displayTopology?.multiDisplaySamples),
      maxDisplayCount: finiteNonNegative(value.displayTopology?.maxDisplayCount),
    },
    visibility: {
      samples: finiteNonNegative(value.visibility?.samples),
      maxSimultaneousConversations: finiteNonNegative(
        value.visibility?.maxSimultaneousConversations,
      ),
    },
    migration: {
      audits: finiteNonNegative(value.migration?.audits),
      conversationPanes: finiteNonNegative(value.migration?.conversationPanes),
      missingConversationReferences: finiteNonNegative(
        value.migration?.missingConversationReferences,
      ),
      orphanConversationWrappers: finiteNonNegative(value.migration?.orphanConversationWrappers),
    },
  };
}

function loadEvidence(): WorkspaceAgentsDogfoodEvidence {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeEvidence(JSON.parse(raw)) : emptyEvidence();
  } catch {
    return emptyEvidence();
  }
}

function saveEvidence(evidence: WorkspaceAgentsDogfoodEvidence): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(evidence));
  } catch {
    // Local evidence is best-effort and never blocks a product action.
  }
}

function increment(value: number, amount = 1): number {
  return Math.min(value + amount, Number.MAX_SAFE_INTEGER);
}

function updateEvidence(
  set: (
    partial:
      | Partial<WorkspaceAgentsDogfoodStore>
      | ((state: WorkspaceAgentsDogfoodStore) => Partial<WorkspaceAgentsDogfoodStore>),
  ) => void,
  mutate: (current: WorkspaceAgentsDogfoodEvidence) => WorkspaceAgentsDogfoodEvidence,
): void {
  set((state) => {
    const evidence = mutate(state.evidence);
    saveEvidence(evidence);
    return { evidence };
  });
}

export const useWorkspaceAgentsDogfoodStore = create<WorkspaceAgentsDogfoodStore>((set) => ({
  evidence: loadEvidence(),
  record: (event) =>
    updateEvidence(set, (current) => ({
      ...current,
      updatedAt: Date.now(),
      counters: {
        ...current.counters,
        [event]: increment(current.counters[event]),
      },
    })),
  recordAttentionResponse: (responseMs) => {
    const bounded = finiteNonNegative(responseMs);
    updateEvidence(set, (current) => ({
      ...current,
      updatedAt: Date.now(),
      attention: {
        samples: increment(current.attention.samples),
        totalResponseMs: increment(current.attention.totalResponseMs, bounded),
        maxResponseMs: Math.max(current.attention.maxResponseMs, bounded),
      },
    }));
  },
  recordDisplayTopology: (displayCount) => {
    const bounded = finiteNonNegative(displayCount);
    if (bounded === 0) return;
    updateEvidence(set, (current) => ({
      ...current,
      updatedAt: Date.now(),
      displayTopology: {
        samples: increment(current.displayTopology.samples),
        singleDisplaySamples: increment(
          current.displayTopology.singleDisplaySamples,
          bounded === 1 ? 1 : 0,
        ),
        multiDisplaySamples: increment(
          current.displayTopology.multiDisplaySamples,
          bounded > 1 ? 1 : 0,
        ),
        maxDisplayCount: Math.max(current.displayTopology.maxDisplayCount, bounded),
      },
    }));
  },
  recordVisibleConversations: (count) => {
    const bounded = finiteNonNegative(count);
    updateEvidence(set, (current) => ({
      ...current,
      updatedAt: Date.now(),
      visibility: {
        samples: increment(current.visibility.samples),
        maxSimultaneousConversations: Math.max(
          current.visibility.maxSimultaneousConversations,
          bounded,
        ),
      },
    }));
  },
  recordMigrationAudit: (input) =>
    updateEvidence(set, (current) => ({
      ...current,
      updatedAt: Date.now(),
      migration: {
        audits: increment(current.migration.audits),
        conversationPanes: increment(
          current.migration.conversationPanes,
          finiteNonNegative(input.conversationPanes),
        ),
        missingConversationReferences: increment(
          current.migration.missingConversationReferences,
          finiteNonNegative(input.missingConversationReferences),
        ),
        orphanConversationWrappers: increment(
          current.migration.orphanConversationWrappers,
          finiteNonNegative(input.orphanConversationWrappers),
        ),
      },
    })),
  reset: () => {
    const evidence = emptyEvidence();
    saveEvidence(evidence);
    set({ evidence });
    attentionStartedAt.clear();
    observedCompatibilityPaneIds.clear();
  },
}));

const attentionStartedAt = new Map<string, number>();
const observedCompatibilityPaneIds = new Set<string>();

export function recordWorkspaceAgentsEvent(event: WorkspaceAgentsDogfoodEvent): void {
  useWorkspaceAgentsDogfoodStore.getState().record(event);
}

export function markWorkspaceAgentsAttentionStarted(
  conversationId: string,
  now = Date.now(),
): void {
  if (!attentionStartedAt.has(conversationId)) {
    attentionStartedAt.set(conversationId, now);
  }
}

export function recordConversationOpenedInAgents(conversationId: string, now = Date.now()): void {
  recordWorkspaceAgentsEvent("conversation_opened_agents");
  const startedAt = attentionStartedAt.get(conversationId);
  if (startedAt === undefined) return;
  attentionStartedAt.delete(conversationId);
  useWorkspaceAgentsDogfoodStore.getState().recordAttentionResponse(Math.max(0, now - startedAt));
}

export function recordCompatibilityPaneLoaded(paneId: string, conversationFound: boolean): void {
  if (observedCompatibilityPaneIds.has(paneId)) return;
  observedCompatibilityPaneIds.add(paneId);
  recordWorkspaceAgentsEvent(
    conversationFound ? "compatibility_pane_loaded" : "compatibility_pane_load_failed",
  );
}

export async function sampleWorkspaceAgentsDisplayTopology(): Promise<void> {
  try {
    const { availableMonitors } = await import("@tauri-apps/api/window");
    const monitors = await availableMonitors();
    useWorkspaceAgentsDogfoodStore.getState().recordDisplayTopology(monitors.length);
  } catch {
    // Capability may be unavailable in tests/web preview; no synthetic sample.
  }
}

export function serializeWorkspaceAgentsDogfoodEvidence(): string {
  return JSON.stringify(useWorkspaceAgentsDogfoodStore.getState().evidence, null, 2);
}
