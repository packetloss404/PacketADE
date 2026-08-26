import { describe, expect, it } from "vitest";
import {
  CHAT_AGENTS,
  TERMINAL_AGENTS,
  getChatAgent,
} from "@/lib/agent-catalog";

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
      // LM2: `api-custom`'s models are a runtime-managed manual list
      // (Settings → Provider Endpoints), so its STATIC catalog row is
      // legitimately model-less. Every other row must carry models.
      if (c.agentCli === "api-custom") continue;
      expect(c.defaultModel.length).toBeGreaterThan(0);
      expect(c.models.length).toBeGreaterThan(0);
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
