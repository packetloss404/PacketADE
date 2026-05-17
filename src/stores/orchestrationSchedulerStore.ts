import { create } from "zustand";
import { orchestrationTick } from "@/lib/tauri";
import { useFlightStore } from "@/stores/flightStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useOrchestrationStateStore, type RunningTask } from "@/stores/orchestrationStateStore";
import type { WorkspaceAgentSlot } from "@/types/workspace";
import { logSwallowed } from "@/lib/logSwallowed";

/**
 * Scheduler half of the original `orchestrationStore`. Owns the dispatch
 * loop: a 1s `setInterval` that drains `orchestrationTick()` (the Rust
 * scheduler's request queue) into the state store's `runningTasks` map by
 * spawning a workspace pane and stamping orchestration metadata onto it.
 *
 * Kept separate from `orchestrationStateStore` so the per-task state map
 * stays a pure data surface — components and tests that only care about
 * `runningTasks` / settings don't have to mock the loop, and the loop's
 * `setInterval` handle stops poisoning state-store snapshots.
 *
 * Cross-store wiring: the state store's `launchFlight` / `resumeFlight`
 * call this store's `startLoop()`; this store reads `runningTasks` and
 * `maxParallelSessions` from the state store inside `tick()` and writes
 * new entries back via `useOrchestrationStateStore.setState`.
 */

interface SchedulerState {
  /** Whether the scheduling loop is running */
  loopRunning: boolean;

  tick: () => Promise<void>;
  startLoop: () => void;
  stopLoop: () => void;
}

let loopInterval: ReturnType<typeof setInterval> | null = null;

export const useOrchestrationSchedulerStore = create<SchedulerState>((set, get) => ({
  loopRunning: false,

  tick: async () => {
    const stateStore = useOrchestrationStateStore.getState();
    const currentRunning = stateStore.runningTasks.size;
    const available = stateStore.maxParallelSessions - currentRunning;
    if (available <= 0) return;

    const flightStore = useFlightStore.getState();
    const requests = await orchestrationTick().catch(() => []);

    for (const request of requests.slice(0, available)) {
      const flight = flightStore.flights.find((entry) => entry.id === request.flightId);
      const milestone = flight?.milestones.find((entry) => entry.id === request.milestoneId);
      const task = milestone?.tasks.find((entry) => entry.id === request.taskId);
      if (
        !flight ||
        !milestone ||
        !task ||
        useOrchestrationStateStore.getState().runningTasks.has(task.id)
      ) {
        continue;
      }

      // Check for file ownership collisions before launching
      const collisions = flightStore.checkFileCollisions(
        request.flightId,
        request.milestoneId,
        request.taskId,
      );
      if (collisions.length > 0) {
        console.warn(
          `[orchestration] File collision detected for task "${task.title}": ${collisions.join(", ")}. Blocking task.`,
        );
        flightStore.setTaskBlocked(
          request.flightId,
          request.milestoneId,
          request.taskId,
          `File ownership collision: ${collisions.join("; ")}`,
        );
        flightStore.addCoordinationEvent(request.flightId, {
          flightId: request.flightId,
          type: "collision_warning",
          taskId: request.taskId,
          taskTitle: task.title,
          agentId: task.agentConfigId,
          summary: `Task "${task.title}" blocked due to file collisions: ${collisions.join(", ")}`,
        });
        continue;
      }

      // Track B: spawn the task pane inside the flight's workspace.
      // `ensureFlightWorkspace` lazily creates the workspace on the first
      // task spawn and is idempotent for subsequent spawns.
      const workspaceId = flightStore.ensureFlightWorkspace(request.flightId);
      if (!workspaceId) {
        console.warn(
          `[orchestration] ensureFlightWorkspace returned null for flight ${request.flightId}; skipping task ${request.taskId}.`,
        );
        continue;
      }

      // Map the task's agentConfigId onto a WorkspaceAgentSlot. Unknown
      // ids collapse to "terminal" — the actual command/args are forced
      // via `overrideCommand`/`overrideArgs` below, so the slot is just
      // a render-time hint for pane styling.
      const KNOWN_SLOTS: readonly WorkspaceAgentSlot[] = [
        "claude-code",
        "codex",
        "gemini",
        "opencode",
        "packetcode",
        "terminal",
      ];
      const slot: WorkspaceAgentSlot = (KNOWN_SLOTS as readonly string[]).includes(
        request.agentConfigId,
      )
        ? (request.agentConfigId as WorkspaceAgentSlot)
        : "terminal";

      const paneId = useWorkspaceStore.getState().addPane(workspaceId, slot);
      if (!paneId) {
        console.warn(
          `[orchestration] workspaceStore.addPane returned null for workspace ${workspaceId} (deleted?); skipping task ${request.taskId}.`,
        );
        continue;
      }

      // Stamp the orchestration metadata onto the pane so WorkspacePane
      // can resolve the right command/args/prompt and useTerminalSession
      // can wire `attachSessionToTask` once the PTY spawns.
      try {
        useWorkspaceStore.getState().updatePane(workspaceId, paneId, {
          taskId: request.taskId,
          flightId: request.flightId,
          agentConfigId: request.agentConfigId,
          initialPrompt: request.prompt,
          overrideCommand: request.command,
          overrideArgs: request.args,
        });
      } catch (err) {
        logSwallowed("orchestration.updatePane")(err);
      }

      useOrchestrationStateStore.setState((s) => {
        const runningTasks = new Map(s.runningTasks);
        const entry: RunningTask = {
          taskId: request.taskId,
          milestoneId: request.milestoneId,
          flightId: request.flightId,
          paneId,
          sessionId: null,
          agentConfigId: request.agentConfigId,
          startedAt: Date.now(),
          command: request.command,
          args: request.args,
          prompt: request.prompt,
          projectPath: request.projectPath,
        };
        runningTasks.set(request.taskId, entry);
        return { runningTasks };
      });
    }
  },

  startLoop: () => {
    if (loopInterval) return;
    set({ loopRunning: true });
    loopInterval = setInterval(() => {
      void get().tick();

      // Stop loop if no active flights
      const state = useOrchestrationStateStore.getState();
      if (state.activeFlightIds.size === 0 && state.runningTasks.size === 0) {
        get().stopLoop();
      }
    }, 1000);
    // Run immediately
    void get().tick();
  },

  stopLoop: () => {
    if (loopInterval) {
      clearInterval(loopInterval);
      loopInterval = null;
    }
    set({ loopRunning: false });
  },
}));
