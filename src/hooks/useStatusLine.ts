import {
  readStatusLineStates,
  readCodexStatusLineStates,
  readGeminiStatusLineStates,
  readOpenCodeStatusLineStates,
} from "@/lib/tauri";
import {
  useStatusLineStore,
  useStatusLineForCwd,
  useCodexStatusLineStore,
  useCodexStatusLineForCwd,
  useGeminiStatusLineStore,
  useGeminiStatusLineForCwd,
  useOpenCodeStatusLineStore,
  useOpenCodeStatusLineForCwd,
} from "@/stores/statusLineStore";
import { useStatusLinePollerBase } from "@/hooks/useStatusLinePollerBase";

const POLL_INTERVAL_MS = 5000;

export function useStatusLinePoller() {
  const update = useStatusLineStore((s) => s.update);
  useStatusLinePollerBase({ read: readStatusLineStates, update, intervalMs: POLL_INTERVAL_MS });
}

export function useCodexStatusLinePoller() {
  const update = useCodexStatusLineStore((s) => s.update);
  useStatusLinePollerBase({ read: readCodexStatusLineStates, update, intervalMs: POLL_INTERVAL_MS });
}

export function useGeminiStatusLinePoller() {
  const update = useGeminiStatusLineStore((s) => s.update);
  useStatusLinePollerBase({ read: readGeminiStatusLineStates, update, intervalMs: POLL_INTERVAL_MS });
}

export function useOpenCodeStatusLinePoller() {
  const update = useOpenCodeStatusLineStore((s) => s.update);
  useStatusLinePollerBase({ read: readOpenCodeStatusLineStates, update, intervalMs: POLL_INTERVAL_MS });
}

export {
  useStatusLineForCwd,
  useCodexStatusLineForCwd,
  useGeminiStatusLineForCwd,
  useOpenCodeStatusLineForCwd,
};
