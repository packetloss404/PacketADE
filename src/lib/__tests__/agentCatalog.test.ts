import { describe, expect, it } from "vitest";
import {
  CHAT_AGENTS,
  TERMINAL_AGENTS,
  getChatAgent,
} from "@/lib/agent-catalog";
import { liveModelSource, providerEnumeratesLive } from "@/lib/liveModels";

/**
 * Merged agent catalog (P3-S4). The registry is a thin read-layer join of
 * `api-models.ts` (Chat agents) and the CLI slots (Terminals) under the ruled
 * capability flags — it must not drop or duplicate either source of truth, and
 * it must carry the P1-S4 `supportsApprovals` flag so the draft tile / picker
 * can filter postures for any adapter that cannot pause for approval.
 */
describe("agent-catalog merged registry", () => {
  it("exposes every API provider as a Chat agent with a face + default model", () => {
    // Claude Agent SDK + Claude API, OpenAI(+Agents), OpenRouter, MiniMax,
    // Ollama, Custom endpoint.
    const faces = CHAT_AGENTS.map((c) => c.face);
    expect(faces).toContain("Claude Agent SDK");
    expect(faces).toContain("Claude API");
    expect(faces).toContain("Ollama");
    expect(faces).toContain("Custom endpoint");
    for (const c of CHAT_AGENTS) {
      expect(c.section).toBe("chat");
      // A row must be usable — but "usable" is no longer the same as "ships
      // with models".
      //
      // This assertion used to be "every row except `api-custom` and
      // `api-packetcode` carries static models", with those two exempted by
      // name. That list was one of four hardcoded exemption lists that had
      // drifted apart, and it encoded the wrong rule: what makes a model-less
      // row legitimate is not its identity, it is that SOMETHING ELSE owns its
      // list and can produce one at runtime. `api-custom`'s list is a manual
      // one in Settings; `api-packetcode`'s comes from the engine's own
      // `_packetcode/models/list`, since which models exist depends on the
      // user's `~/.packetcode/config.toml` and seeding ids here would be a
      // guess at another program's configuration (a wrong guess reached the
      // engine and 404'd on whichever provider it resolved to).
      //
      // Re-expressed against the registry. Note that "is registered as
      // live-enumerating" alone is NOT enough to excuse an empty row — every
      // catalog row is registered now, so that reading would make this
      // assertion vacuous. The rule that actually holds is about WHO owns the
      // list:
      //
      //   needsKey  → PacketBench holds the credential and knows the vendor's
      //               public catalog. It MUST ship those rows: they are what a
      //               user with no API key yet, or a first launch before any
      //               enumeration has landed, sees. An empty picker there is
      //               the exact failure the live seam exists to prevent.
      //   !needsKey → the list is a property of the user's own environment
      //               (their Ollama daemon, their custom endpoint's config,
      //               their `~/.packetcode/config.toml`). We cannot know it,
      //               and guessing is worse than empty.
      const source = liveModelSource(c.agentCli);
      expect(providerEnumeratesLive(c.agentCli), c.agentCli).toBe(true);
      if (!source?.needsKey) continue;
      expect(c.defaultModel.length, c.agentCli).toBeGreaterThan(0);
      expect(c.models.length, c.agentCli).toBeGreaterThan(0);
    }
    // Named explicitly so a future edit cannot satisfy the loop above by
    // flipping a keyed row to `needsKey: false` and emptying it.
    for (const agentCli of ["api-claude", "api-claude-oauth", "api-openai", "api-openrouter"] as const) {
      expect(getChatAgent(agentCli)?.models.length, agentCli).toBeGreaterThan(0);
    }
  });

  it("drops the retired Codex row and leaves every live provider approval-capable", () => {
    // `api-openai-codex` (Codex `exec` on a ChatGPT subscription) was removed
    // in 2026-07 — it must not resolve to a catalog entry at all, or the
    // picker would keep offering it.
    expect(getChatAgent("api-openai-codex")).toBeUndefined();
    // It was the only row that set supportsApprovals=false. Every surviving
    // provider can service a per-tool approval round-trip.
    for (const c of CHAT_AGENTS) {
      expect(c.supportsApprovals).toBe(true);
    }
  });

  it("marks local-only runtimes (Ollama, PacketCode ACP) as SSH-incapable", () => {
    expect(getChatAgent("api-ollama")?.supportsSsh).toBe(false);
    // The ACP engine is a local child process, not an endpoint the remote
    // sidecar could reach.
    expect(getChatAgent("api-packetcode")?.supportsSsh).toBe(false);
    expect(getChatAgent("api-claude")?.supportsSsh).toBe(true);
  });

  it("keeps the Agent SDK row SSH-capable (routes through the remote sidecar)", () => {
    // The sidecar providers run over SSH via the remote sidecar (the whole
    // sidecar runs on the host). Only the locally-spawned runtimes are
    // local-only — a regression here would silently hide a provider from
    // remote workspaces.
    const LOCAL_ONLY = new Set(["api-ollama", "api-packetcode"]);
    expect(getChatAgent("api-claude-oauth")?.supportsSsh).toBe(true);
    expect(getChatAgent("api-openai-agents")?.supportsSsh).toBe(true);
    for (const c of CHAT_AGENTS) {
      expect(c.supportsSsh).toBe(!LOCAL_ONLY.has(c.agentCli));
    }
  });

  it("exposes the five Terminal slots with catalog faces, ending in a bare Terminal", () => {
    const slots = TERMINAL_AGENTS.map((t) => t.slot);
    expect(slots).toEqual([
      "claude-code",
      "codex",
      "opencode",
      "packetcode",
      "terminal",
    ]);
    const bySlot = Object.fromEntries(TERMINAL_AGENTS.map((t) => [t.slot, t.face]));
    // The same vendor appears in both sections; the Terminal face is the CLI
    // name so search disambiguates ("Claude Code" vs the Chat "Claude" faces).
    expect(bySlot["claude-code"]).toBe("Claude Code");
    expect(bySlot["codex"]).toBe("Codex CLI");
    expect(bySlot["terminal"]).toBe("Terminal");
  });
});
