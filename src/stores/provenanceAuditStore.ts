import { create } from "zustand";
import { storageKey } from "@/lib/brand";
import type { ProvenanceEnvelope } from "@/types/provenance";

export type TrustDecision =
  | "auto_allowed"
  | "prompted"
  | "user_allowed_once"
  | "user_allowed_session"
  | "user_denied"
  | "cancelled"
  | "profile_changed"
  | "diagnostic"
  | "catalog_installed";

export interface ProvenanceAuditEntry {
  id: string;
  timestamp: number;
  conversationId: string;
  toolId: string;
  action: string;
  target?: string;
  decision: TrustDecision;
  effectivePolicy: string;
  sourceChain: Array<{
    id: string;
    origin: ProvenanceEnvelope["origin"];
    authority: ProvenanceEnvelope["authority"];
    label: string;
    locator?: string;
  }>;
}

interface ProvenanceAuditSettings {
  retentionDays: 7 | 30;
  showSourceChips: boolean;
}

interface ProvenanceAuditState {
  entries: ProvenanceAuditEntry[];
  settings: ProvenanceAuditSettings;
  record: (entry: Omit<ProvenanceAuditEntry, "id" | "timestamp">) => void;
  setRetentionDays: (days: 7 | 30) => void;
  setShowSourceChips: (show: boolean) => void;
  clear: () => void;
  exportJson: () => string;
}

const STORAGE_KEY = storageKey("provenance-audit-v1");
const MAX_ENTRIES = 200;

type PersistedAudit = {
  entries?: ProvenanceAuditEntry[];
  settings?: Partial<ProvenanceAuditSettings>;
};

function redact(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{8,}\b/g, "[REDACTED]")
    .slice(0, 200);
}

function prune(
  entries: ProvenanceAuditEntry[],
  retentionDays: ProvenanceAuditSettings["retentionDays"],
): ProvenanceAuditEntry[] {
  const cutoff = Date.now() - retentionDays * 86_400_000;
  return entries.filter((entry) => entry.timestamp >= cutoff).slice(-MAX_ENTRIES);
}

export function normalizeProvenanceAuditSnapshot(
  parsed: PersistedAudit,
): Required<PersistedAudit> {
  const retentionDays = parsed.settings?.retentionDays === 30 ? 30 : 7;
  return {
    entries: prune(parsed.entries ?? [], retentionDays),
    settings: {
      retentionDays,
      showSourceChips: parsed.settings?.showSourceChips ?? true,
    },
  };
}

function loadPersisted(): Required<PersistedAudit> {
  try {
    if (typeof localStorage === "undefined") {
      return normalizeProvenanceAuditSnapshot({});
    }
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as PersistedAudit;
    return normalizeProvenanceAuditSnapshot(parsed);
  } catch {
    return normalizeProvenanceAuditSnapshot({});
  }
}

function persist(state: Pick<ProvenanceAuditState, "entries" | "settings">) {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ entries: state.entries, settings: state.settings }),
      );
    }
  } catch {
    // Audit storage is bounded and best-effort; permission enforcement does
    // not depend on localStorage availability.
  }
}

const initial = loadPersisted();

export const useProvenanceAuditStore = create<ProvenanceAuditState>((set, get) => ({
  entries: initial.entries,
  settings: initial.settings as ProvenanceAuditSettings,

  record: (entry) => {
    const now = Date.now();
    const safe: ProvenanceAuditEntry = {
      ...entry,
      id:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `audit-${now}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: now,
      action: redact(entry.action) ?? "unknown",
      target: redact(entry.target),
      sourceChain: entry.sourceChain.map((source) => ({
        id: source.id,
        origin: source.origin,
        authority: source.authority,
        label: redact(source.label) ?? "source",
        locator: redact(source.locator),
      })),
    };
    set((state) => {
      const entries = prune(
        [...state.entries, safe],
        state.settings.retentionDays,
      );
      persist({ entries, settings: state.settings });
      return { entries };
    });
  },

  setRetentionDays: (retentionDays) => {
    set((state) => {
      const entries = prune(state.entries, retentionDays);
      const settings = { ...state.settings, retentionDays };
      persist({ entries, settings });
      return { entries, settings };
    });
  },

  setShowSourceChips: (showSourceChips) => {
    set((state) => {
      const settings = { ...state.settings, showSourceChips };
      persist({ entries: state.entries, settings });
      return { settings };
    });
  },

  clear: () => {
    set((state) => {
      persist({ entries: [], settings: state.settings });
      return { entries: [] };
    });
  },

  exportJson: () =>
    JSON.stringify(
      {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        entries: get().entries,
      },
      null,
      2,
    ),
}));

export function auditSourceChain(sources: ProvenanceEnvelope[]) {
  return sources.map((source) => ({
    id: source.id,
    origin: source.origin,
    authority: source.authority,
    label: source.identity.label,
    locator: source.identity.locator,
  }));
}
