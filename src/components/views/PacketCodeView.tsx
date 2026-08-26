/**
 * The `packetcode` shell route — the Agents experience scoped to the
 * PacketCode ACP engine.
 *
 * Deliberately a THIN composition of `AgentsView` rather than a fork: the
 * sidebar, chat pane, inspector, composer and onboarding are the same surfaces
 * and must stay the same surfaces. Pinning the provider is what this route
 * does; `AgentsView` derives everything else from that pin — including the
 * sidebar's engine-session directory, which is shown here because this is the
 * ACP-scoped route and hidden on the general Agents route where a list of
 * packetcode-engine sessions would be noise.
 *
 * Known limitation: the conversation sidebar still lists every conversation,
 * and the composer's provider dropdown still offers every provider — both live
 * in `components/agents/**` and take no filter prop today. Narrowing them is a
 * follow-up in that directory, not here.
 *
 * Known gap (backend): the engine directory is READ-ONLY. Resuming one of
 * those sessions needs ACP `session/load`, and `acp::load_session_on` is not
 * exposed as a Tauri command — `start_api_agent_session`'s ACP branch always
 * calls `session/new` and takes no engine session id. Until that command
 * exists the sidebar lists and renames engine sessions and says plainly that
 * it cannot open them, rather than offering a control that does nothing.
 *
 * The engine gate wraps that composition rather than living inside
 * `AgentsView`: the `packetcode` binary is this route's dependency alone, and
 * the general Agents route must never be blocked because a provider nobody
 * selected happens not to be installed. When the engine is ready the gate
 * renders `AgentsView` directly, with no wrapper element of its own.
 */
import { API_PROVIDERS } from "@/lib/api-models";
import { AgentsView } from "@/components/views/AgentsView";
import { PacketCodeEngineGate } from "@/components/agents/PacketCodeEngineGate";
import type { AgentCli } from "@/stores/agentTaskStore";

/** The ACP provider this route is scoped to. */
const PACKETCODE_AGENT: AgentCli = "api-packetcode";

/**
 * Seeded default model, read from the catalog rather than duplicated — the ACP
 * engine enumerates its live models over `_packetcode/models/list`, so the
 * catalog row is only ever a first-render seed.
 */
const PACKETCODE_MODEL =
  API_PROVIDERS.find((provider) => provider.agentCli === PACKETCODE_AGENT)?.models[0]?.value ?? "";

export function PacketCodeView() {
  return (
    <PacketCodeEngineGate>
      <AgentsView pinnedAgent={PACKETCODE_AGENT} pinnedModel={PACKETCODE_MODEL} />
    </PacketCodeEngineGate>
  );
}
