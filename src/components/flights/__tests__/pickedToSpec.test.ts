/**
 * The MANUAL flight-launch path — user opens the launch modal, picks targets,
 * presses go — must hand the backend a routable provider id.
 *
 * It did not. `pickedToSpec` derived `provider` with
 * `p.agent.replace(/^api-/, "")`, so the DEFAULT executor `api-claude` became
 * `"claude"`. `flight_attempts.rs` forwards that string verbatim to
 * `start_api_agent_session`, whose in-process dispatch (`get_provider`) knows
 * Anthropic as `"anthropic"` — so every default manual launch failed, and
 * failed with the wrong story ("No API key configured for claude", pointing
 * the user at Settings → API Keys for a provider that does not exist).
 *
 * The fix routes through `attemptProviderFor`, the same map the chat path
 * uses. These pin it for both target kinds.
 */
import { describe, expect, it } from "vitest";
import { pickedToSpec } from "@/components/flights/pickedToSpec";
import type { PickedTarget } from "@/components/flights/MultiTargetPicker";
import { API_PROVIDERS } from "@/lib/api-models";
import { attemptProviderFor } from "@/lib/attemptRouting";
import type { ServerConfig } from "@/types/server";

const SERVER: ServerConfig = {
  id: "srv_1",
  name: "build box",
  host: "build.example.com",
  port: 22,
  username: "ian",
  authMethod: "key",
  keyPath: "/home/ian/.ssh/id_ed25519",
  hostFingerprint: "SHA256:abc",
  installedAgents: [],
};

function localPick(agent: string): PickedTarget {
  return {
    kind: "local",
    basePath: "/repo",
    baseBranch: "main",
    agent,
    model: "claude-opus-4-8",
  } as PickedTarget;
}

function sshPick(agent: string): PickedTarget {
  return {
    kind: "ssh",
    server: SERVER,
    basePath: "/srv/repo",
    baseBranch: "main",
    agent,
    model: "claude-opus-4-8",
  } as PickedTarget;
}

describe("pickedToSpec (manual flight launch)", () => {
  it("sends the backend 'anthropic' for the default api-claude executor", () => {
    // `api-claude` is `MultiTargetPicker`'s `defaultAgent`, so this is what a
    // user gets by opening the modal and pressing go without touching the
    // provider dropdown. THE regression: it must not be "claude".
    expect(pickedToSpec(localPick("api-claude")).provider).toBe("anthropic");
    expect(pickedToSpec(localPick("api-claude")).provider).not.toBe("claude");
  });

  it("sends the backend 'anthropic' for the default executor over SSH too", () => {
    expect(pickedToSpec(sshPick("api-claude")).provider).toBe("anthropic");
  });

  it("agrees with the shared map for every executor the picker offers", () => {
    for (const { agentCli } of API_PROVIDERS) {
      const expected = attemptProviderFor(agentCli);
      expect(pickedToSpec(localPick(agentCli)).provider).toBe(expected);
      expect(pickedToSpec(sshPick(agentCli)).provider).toBe(expected);
    }
  });

  it("still carries the agent config id through untouched", () => {
    // `agentConfigId` and `provider` are different namespaces; only the
    // latter is mapped.
    const spec = pickedToSpec(localPick("api-claude"));
    expect(spec.agentConfigId).toBe("api-claude");
  });
});
