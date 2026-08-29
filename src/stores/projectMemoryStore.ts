import { create } from "zustand";
import {
  archiveProjectMemory,
  createProjectMemory,
  listProjectMemory,
  updateProjectMemory,
  watchProjectMemory,
} from "@/lib/tauri";
import type {
  CreateProjectMemoryInput,
  ProjectMemoryNote,
  ProjectMemorySnapshot,
  UpdateProjectMemoryInput,
} from "@/types/project-memory";

const EMPTY_SNAPSHOT: ProjectMemorySnapshot = {
  schemaVersion: 1,
  directory: ".agents/memory",
  notes: [],
  warnings: [],
  revision: "",
};

/**
 * How long after a PacketBench-initiated write we treat an inbound watcher
 * event as our own echo rather than someone else's edit.
 *
 * The clock is re-armed *after* the write returns, not only before it: a large
 * note on a slow disk could take longer than the window to land, so the echo
 * arrived after expiry and the pane accused the user of an external edit they
 * had just made themselves.
 */
const OWN_WRITE_WINDOW_MS = 1_500;

interface ProjectMemoryStore {
  projectPath: string | null;
  snapshot: ProjectMemorySnapshot;
  loading: boolean;
  error: string | null;
  /** Live-refresh watcher failed; notes still loaded, refresh is manual. */
  watchError: string | null;
  changedExternally: boolean;
  ownWriteUntil: number;
  /**
   * Monotonic id of the newest `load` call. A watcher storm starts several
   * overlapping listings; without a generation check an older response could
   * land last and overwrite a newer snapshot (a lost update). Also used to
   * discard a watch failure from a superseded load.
   */
  loadSequence: number;
  /**
   * Set when an event arrives while a listing for the same project is already
   * in flight. The in-flight load re-runs once on completion instead of every
   * event fanning out into its own full directory read.
   */
  reloadQueued: boolean;
  /**
   * A listing is outstanding. Kept separate from `loading`, which now drives
   * only the first-paint spinner: a background refresh must not blank a list
   * the user is reading, but it still has to suppress duplicate reloads.
   */
  inFlight: boolean;
  load: (projectPath: string, external?: boolean) => Promise<void>;
  createNote: (
    input: CreateProjectMemoryInput,
  ) => Promise<ProjectMemoryNote | null>;
  updateNote: (
    input: UpdateProjectMemoryInput,
  ) => Promise<ProjectMemoryNote | null>;
  archiveNote: (
    id: string,
    expectedRevision: string,
  ) => Promise<ProjectMemoryNote | null>;
  clearError: () => void;
  acknowledgeExternalChange: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useProjectMemoryStore = create<ProjectMemoryStore>((set, get) => ({
  projectPath: null,
  snapshot: EMPTY_SNAPSHOT,
  loading: false,
  error: null,
  watchError: null,
  changedExternally: false,
  ownWriteUntil: 0,
  loadSequence: 0,
  reloadQueued: false,
  inFlight: false,

  load: async (projectPath, external = false) => {
    const previous = get();
    const effectiveExternal = external && Date.now() > previous.ownWriteUntil;

    // Coalesce watcher-driven reloads. A single editor save produces several
    // filesystem events, and a bulk operation (git checkout, a sync client)
    // produces hundreds; each one used to start its own full directory listing
    // over a directory that may hold thousands of notes. Fold them into one
    // trailing re-read.
    //
    // Only *external* loads are folded. A load that follows one of our own
    // writes must actually observe that write before its caller returns.
    if (external && previous.inFlight && previous.projectPath === projectPath) {
      set({
        reloadQueued: true,
        changedExternally: effectiveExternal || previous.changedExternally,
      });
      return;
    }

    const sequence = previous.loadSequence + 1;
    // Show the spinner only when there is nothing to show instead. A refresh of
    // an already-populated project used to blank the list on every watcher
    // event, so an external editor autosaving mid-edit made the pane flicker.
    const isInitial =
      previous.projectPath !== projectPath || previous.snapshot.revision === "";
    set({
      projectPath,
      loadSequence: sequence,
      inFlight: true,
      reloadQueued: false,
      loading: isInitial,
      // An external refresh must not silently swallow the error banner the user
      // is still reading - typically a save conflict they have to act on. Only
      // a user- or write-initiated load clears it.
      error: external ? previous.error : null,
      watchError: null,
      changedExternally: effectiveExternal || previous.changedExternally,
    });
    try {
      // List FIRST. The watcher only buys live refresh, and it can legitimately
      // fail (network drive, exhausted inotify handles, permission-denied
      // mkdir). Awaiting it ahead of the list meant any such failure blanked a
      // perfectly readable set of notes.
      const snapshot = await listProjectMemory(projectPath);
      // Discard superseded responses. Checking only the project path let a slow
      // listing of *this* project land after a newer one had already applied,
      // rolling the pane back to pre-edit content - a lost update.
      if (get().loadSequence !== sequence) return;
      set({ snapshot, loading: false });

      void watchProjectMemory(projectPath).catch((error) => {
        // Same generation guard: a rejection from a superseded load must not
        // raise a watch error over a watcher that has since been re-armed.
        if (get().loadSequence !== sequence) return;
        // Degrade to manual refresh rather than hiding the notes.
        set({ watchError: errorMessage(error) });
      });
    } catch (error) {
      if (get().loadSequence !== sequence) return;
      set({ loading: false, error: errorMessage(error) });
    } finally {
      if (get().loadSequence === sequence) {
        set({ inFlight: false, loading: false });
        if (get().reloadQueued) {
          set({ reloadQueued: false });
          await get().load(projectPath, true);
        }
      }
    }
  },

  createNote: async (input) => {
    const projectPath = get().projectPath;
    if (!projectPath) return null;
    try {
      set({ ownWriteUntil: Date.now() + OWN_WRITE_WINDOW_MS });
      const note = await createProjectMemory(projectPath, input);
      // Re-arm from the moment the write actually landed. Arming only up front
      // meant a slow write (large note, network share, antivirus scan) outlived
      // its own window, so the watcher echo of our own save was reported to the
      // user as an external edit.
      set({ ownWriteUntil: Date.now() + OWN_WRITE_WINDOW_MS });
      await get().load(projectPath);
      return note;
    } catch (error) {
      set({ error: errorMessage(error) });
      return null;
    }
  },

  updateNote: async (input) => {
    const projectPath = get().projectPath;
    if (!projectPath) return null;
    try {
      set({ ownWriteUntil: Date.now() + OWN_WRITE_WINDOW_MS });
      const note = await updateProjectMemory(projectPath, input);
      set({ ownWriteUntil: Date.now() + OWN_WRITE_WINDOW_MS });
      await get().load(projectPath);
      set({ changedExternally: false });
      return note;
    } catch (error) {
      set({ error: errorMessage(error) });
      return null;
    }
  },

  archiveNote: async (id, expectedRevision) => {
    const projectPath = get().projectPath;
    if (!projectPath) return null;
    try {
      set({ ownWriteUntil: Date.now() + OWN_WRITE_WINDOW_MS });
      const note = await archiveProjectMemory(projectPath, id, expectedRevision);
      set({ ownWriteUntil: Date.now() + OWN_WRITE_WINDOW_MS });
      await get().load(projectPath);
      return note;
    } catch (error) {
      set({ error: errorMessage(error) });
      return null;
    }
  },

  clearError: () => set({ error: null }),
  acknowledgeExternalChange: () => set({ changedExternally: false }),
}));
