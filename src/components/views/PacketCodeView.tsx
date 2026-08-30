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
 * Adopting an engine session binds it to a new conversation and resumes it
 * through ACP `session/load`. The replay is deliberately not rendered: the
 * api-agent contract carries no user-turn event, so a replayed transcript
 * would show every assistant turn with every prompt missing. The adopted
 * conversation opens with a notice saying so, and the engine still holds the
 * full history as the model's context.
 *
 * The engine gate wraps that composition rather than living inside
 * `AgentsView`: the `packetcode` binary is this route's dependency alone, and
 * the general Agents route must never be blocked because a provider nobody
 * selected happens not to be installed. When the engine is ready the gate
 * renders `AgentsView` directly, with no wrapper element of its own.
 */
import { AgentsView } from "@/components/views/AgentsView";
import { PacketCodeEngineGate } from "@/components/agents/PacketCodeEngineGate";
import type { AgentCli } from "@/stores/agentTaskStore";

/** The ACP provider this route is scoped to. */
const PACKETCODE_AGENT: AgentCli = "api-packetcode";

/**
 * No seeded model, deliberately.
 *
 * This used to be `catalog.models[0].value`, which seeded whatever id happened
 * to sit first in the ACP catalog row. That row's ids were a guess at the
 * user's `~/.packetcode/config.toml`, and on an engine with no Anthropic
 * provider the seed went to OpenAI and returned `-32603 ... status 404: The
 * model claude-opus-4-8 does not exist`. The row now carries no models at all
 * (see `api-models.ts`), so this lookup would yield `""` regardless — it is
 * dropped rather than left looking load-bearing.
 *
 * An empty model is the correct request: `acp::routing` maps it to `None` and
 * the engine uses its own configured default, which is the only model we can
 * be sure exists. `stampEngineCapabilities` then replaces the picker's rows
 * with the engine's real list from `_packetcode/models/list`.
 */
const PACKETCODE_MODEL = "";

export function PacketCodeView() {
  return (
    <PacketCodeEngineGate>
      <AgentsView pinnedAgent={PACKETCODE_AGENT} pinnedModel={PACKETCODE_MODEL} />
    </PacketCodeEngineGate>
  );
}
