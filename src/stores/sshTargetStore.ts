import { create } from "zustand";
import { loadFromStorage, saveToStorage, generateId } from "@/lib/storage";
import type { SshTarget } from "@/types/ssh";

const STORAGE_KEY = "packetcode:ssh-targets";

interface SshTargetStore {
  targets: SshTarget[];
  addTarget: (t: Omit<SshTarget, "id" | "createdAt" | "lastUsed">) => SshTarget;
  updateTarget: (id: string, patch: Partial<Omit<SshTarget, "id" | "createdAt">>) => void;
  removeTarget: (id: string) => void;
  touchTarget: (id: string) => void;
  getTarget: (id: string) => SshTarget | undefined;
}

function load(): SshTarget[] {
  return loadFromStorage<SshTarget[]>(STORAGE_KEY, []);
}

function persist(targets: SshTarget[]) {
  saveToStorage(STORAGE_KEY, targets);
}

export const useSshTargetStore = create<SshTargetStore>((set, get) => ({
  targets: load(),

  addTarget: (partial) => {
    const now = Date.now();
    const target: SshTarget = {
      id: generateId("ssh"),
      createdAt: now,
      lastUsed: null,
      ...partial,
    };
    set((s) => {
      const targets = [target, ...s.targets];
      persist(targets);
      return { targets };
    });
    return target;
  },

  updateTarget: (id, patch) => {
    set((s) => {
      const targets = s.targets.map((t) => (t.id === id ? { ...t, ...patch } : t));
      persist(targets);
      return { targets };
    });
  },

  removeTarget: (id) => {
    set((s) => {
      const targets = s.targets.filter((t) => t.id !== id);
      persist(targets);
      return { targets };
    });
  },

  touchTarget: (id) => {
    set((s) => {
      const targets = s.targets.map((t) =>
        t.id === id ? { ...t, lastUsed: Date.now() } : t,
      );
      persist(targets);
      return { targets };
    });
  },

  getTarget: (id) => get().targets.find((t) => t.id === id),
}));
