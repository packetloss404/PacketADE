/**
 * Attempt-target routing for launches the user did not configure by hand.
 *
 * ## Why this exists (WI-1 of `dev/oauth-removal-plan.md`)
 *
 * GitHub → AI Investigation → **Draft patch** used to build its attempt target
 * inline with `agentConfigId: "api-claude-oauth"` / `provider: "claude-oauth"`
 * hardcoded. That spent the user's Claude *subscription* on a full agentic
 * worktree run they never picked a provider for — the same class of exposure as
 * the four Rust auxiliary features, just on the frontend.
 *
 * Automatic launches now resolve through the routing settings' workflow roles
 * (Settings → AI Provider Routing), falling back to the same default a manual
 * Flight launch offers. Subscription-OAuth agents are refused outright: a user
 * can still pick one deliberately in the provider picker, but nothing PacketADE
 * routes on their behalf may select one.
 */

import { API_PROVIDERS, getDefaultModel } from "@/lib/api-models";
import { useRoutingStore } from "@/stores/routingStore";
import { apiAgentProvider, type AgentCli } from "@/stores/agentTaskStore";
import type { AttemptTargetSpec } from "@/lib/tauri";
import type { TaskType } from "@/types/flight";

/**
 * Agents whose credentials come from a Claude.ai / ChatGPT subscription login.
 * Never valid as an automatically-resolved target.
 */
export const SUBSCRIPTION_OAUTH_AGENTS: ReadonlySet<string> = new Set([
  "api-claude-oauth",
  "api-openai-codex",
]);

/**
 * Fallback executor for an automatic launch. Matches `MultiTargetPicker`'s
 * `defaultAgent`, so an auto-launched attempt looks exactly like the one the
 * user would get by opening the launch modal and pressing go.
 */
export const DEFAULT_ATTEMPT_AGENT: AgentCli = "api-claude";

/** Flight attempts run through `start_api_agent_session`, so the executor must
 * be an API agent — a PTY CLI agent id (`claude-code`, `codex`, …) cannot back
 * an attempt. */
function isUsableAttemptAgent(agentConfigId: string): boolean {
  if (SUBSCRIPTION_OAUTH_AGENTS.has(agentConfigId)) return false;
  return API_PROVIDERS.some((p) => p.agentCli === agentConfigId);
}

/**
 * Pick the executor for an automatic launch of `taskType`.
 *
 * Honours a routing-settings pin when it names a usable API agent; otherwise
 * falls back to [`DEFAULT_ATTEMPT_AGENT`]. A pin naming a PTY CLI agent (which
 * cannot execute an attempt) or a subscription-OAuth agent is ignored rather
 * than obeyed — silently launching on the wrong credentials is the failure
 * mode this whole change exists to remove.
 */
export function resolveAttemptExecutor(route: {
  agentConfigId: string;
  model?: string;
}): { agentConfigId: AgentCli; model: string } {
  const agentConfigId = isUsableAttemptAgent(route.agentConfigId)
    ? (route.agentConfigId as AgentCli)
    : DEFAULT_ATTEMPT_AGENT;

  // A model pinned for a different agent must not leak across; only keep it
  // when the pinned agent survived.
  const pinnedModel =
    agentConfigId === route.agentConfigId && route.model?.trim() ? route.model.trim() : "";

  return {
    agentConfigId,
    model: pinnedModel || getDefaultModel(agentConfigId),
  };
}

/** Build a local worktree attempt target for an automatic launch. */
export function localAttemptTargetFromRoute(
  route: { agentConfigId: string; model?: string },
  basePath: string,
  baseBranch = "main",
): AttemptTargetSpec {
  const executor = resolveAttemptExecutor(route);
  return {
    kind: "local",
    basePath,
    baseBranch,
    agentConfigId: executor.agentConfigId,
    // The canonical backend provider id, via the same map `agentTaskStore` uses
    // when it starts an API conversation. Deliberately NOT the naive
    // `replace(/^api-/, "")` that `pickedToSpec` in LaunchAsyncFlightModal
    // does — that yields `"claude"` for `api-claude`, which is not a
    // `get_provider` id. Mis-mapping a provider is how requests end up billed
    // to the wrong credentials, so this path uses the authoritative map.
    provider: apiAgentProvider(executor.agentConfigId),
    model: executor.model,
  };
}

/** Read the live routing settings and build a local attempt target. */
export function resolveLocalAttemptTarget(
  taskType: TaskType,
  basePath: string,
  baseBranch = "main",
): AttemptTargetSpec {
  const route = useRoutingStore.getState().resolveForTask(taskType);
  return localAttemptTargetFromRoute(route, basePath, baseBranch);
}
