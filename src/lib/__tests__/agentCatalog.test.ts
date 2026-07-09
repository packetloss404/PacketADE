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
 * can filter Codex postures.
 */
describe("agent-catalog merged registry", () => {
  it("exposes every API provider as a Chat agent with a face + default model", () => {
    // Claude (OAuth + API), Codex ChatGPT, OpenAI(+Agents), OpenRouter, MiniMax, Ollama.
    const faces = CHAT_AGENTS.map((c) => c.face);
    expect(faces).toContain("Claude OAuth");
    expect(faces).toContain("Claude API");
    expect(faces).toContain("Codex ChatGPT");
    expect(faces).toContain("Ollama");
    for (const c of CHAT_AGENTS) {
      expect(c.section).toBe("chat");
      expect(c.defaultModel.length).toBeGreaterThan(0);
      expect(c.models.length).toBeGreaterThan(0);
    }
  });

  it("carries the P1-S4 Codex honesty flag (supportsApprovals=false only for Codex)", () => {
    const codex = getChatAgent("api-openai-codex");
    expect(codex?.supportsApprovals).toBe(false);
    // Every other chat provider is approval-capable.
    for (const c of CHAT_AGENTS) {
      if (c.agentCli === "api-openai-codex") continue;
      expect(c.supportsApprovals).toBe(true);
    }
  });

  it("marks local-only runtimes (Ollama) as SSH-incapable", () => {
    expect(getChatAgent("api-ollama")?.supportsSsh).toBe(false);
    expect(getChatAgent("api-claude")?.supportsSsh).toBe(true);
  });

  it("exposes the six Terminal slots with catalog faces, ending in a bare Terminal", () => {
    const slots = TERMINAL_AGENTS.map((t) => t.slot);
    expect(slots).toEqual([
      "claude-code",
      "codex",
      "gemini",
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
