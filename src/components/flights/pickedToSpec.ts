import { attemptProviderFor } from "@/lib/attemptRouting";
import type { AttemptTargetSpec } from "@/lib/tauri";
import type { PickedTarget } from "./MultiTargetPicker";

/**
 * Build the backend attempt spec for one target the user picked by hand in
 * `LaunchAsyncFlightModal`.
 *
 * `provider` MUST come from `attemptProviderFor` — the same map the chat path
 * uses. It used to be `p.agent.replace(/^api-/, "")`, which silently handed
 * the backend `"claude"` for the DEFAULT `api-claude` executor: not a
 * `get_provider` id, so every manual launch on the default provider died in
 * `load_api_key` with "No API key configured for claude" — a message that
 * sent the user to Settings to fix a key for a provider that does not exist.
 *
 * Lives outside the modal so it is directly testable (and so the modal file
 * keeps exporting only components).
 */
export function pickedToSpec(p: PickedTarget): AttemptTargetSpec {
  if (p.kind === "local") {
    return {
      kind: "local",
      basePath: p.basePath,
      baseBranch: p.baseBranch,
      agentConfigId: p.agent,
      provider: attemptProviderFor(p.agent),
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
    provider: attemptProviderFor(p.agent),
    model: p.model,
  };
}
