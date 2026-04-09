import { create } from "zustand";

export interface FlightRetrospective {
  id: string;
  flightId: string;
  flightTitle: string;
  summary: string;
  whatWorked: string[];
  whatFailed: string[];
  lessonsLearned: string[];
  suggestedImprovements: string[];
  tags: string[];
  createdAt: number;
}

const STORAGE_KEY = "packetcode:retrospectives";

function loadState(): FlightRetrospective[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}

function saveState(retrospectives: FlightRetrospective[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(retrospectives));
}

interface RetrospectiveStore {
  retrospectives: FlightRetrospective[];

  addRetrospective: (retro: Omit<FlightRetrospective, "id" | "createdAt">) => void;
  deleteRetrospective: (id: string) => void;
  getForFlight: (flightId: string) => FlightRetrospective | null;

  /** Get the most recent retrospectives as a formatted string for prompt injection. */
  getRetrospectiveContext: (limit?: number) => string;
}

export const useRetrospectiveStore = create<RetrospectiveStore>((set, get) => ({
  retrospectives: loadState(),

  addRetrospective: (input) => {
    const retro: FlightRetrospective = {
      ...input,
      id: `retro_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
    };
    set((s) => {
      const next = [...s.retrospectives, retro];
      saveState(next);
      return { retrospectives: next };
    });
  },

  deleteRetrospective: (id) => {
    set((s) => {
      const next = s.retrospectives.filter((r) => r.id !== id);
      saveState(next);
      return { retrospectives: next };
    });
  },

  getForFlight: (flightId) => {
    return get().retrospectives.find((r) => r.flightId === flightId) ?? null;
  },

  getRetrospectiveContext: (limit = 5) => {
    const retros = get().retrospectives
      .slice(-limit)
      .reverse();

    if (retros.length === 0) return "";

    return retros.map((r) => {
      const parts = [`Flight: "${r.flightTitle}"`];
      if (r.summary) parts.push(`Summary: ${r.summary}`);
      if (r.lessonsLearned.length > 0) {
        parts.push(`Lessons: ${r.lessonsLearned.join("; ")}`);
      }
      if (r.whatWorked.length > 0) {
        parts.push(`What worked: ${r.whatWorked.join("; ")}`);
      }
      if (r.whatFailed.length > 0) {
        parts.push(`What failed: ${r.whatFailed.join("; ")}`);
      }
      return parts.join("\n");
    }).join("\n---\n");
  },
}));
