import { describe, expect, it, vi } from "vitest";
import { slashCommandHandlers } from "@/components/agents/composer/slashCommandHandlers";
import type { SlashCommandContext } from "@/components/agents/composer/slashCommandHandlers";
import type { AgentConversation } from "@/types/agent-conversation";

/**
 * M1(b): `/new` must not double-inject memory. The source conversation's
 * `systemPromptOverride` is the FULLY BAKED prompt — memory brief + AGENTS.md
 * were prepended once when it was created. If `/new` forwarded that baked
 * string while also inheriting `memoryContextEnabled`, createApiConversation
 * would prepend a second brief and (unconditionally) a second AGENTS.md. The
 * fix passes `systemPromptOverride: null` and lets createApiConversation
 * rebuild exactly one of each from the inherited flag.
 */

const flush = () => new Promise((r) => setTimeout(r, 0));

type CreateOpts = Parameters<SlashCommandContext["createApiConversation"]>[0];
const makeCreateMock = () =>
  vi.fn(async (_opts: CreateOpts) => "conv-new");

function makeContext(
  conv: Partial<AgentConversation>,
  createApiConversation: SlashCommandContext["createApiConversation"],
): SlashCommandContext {
  const conversation = {
    id: "conv-old",
    mode: "api",
    model: "claude-opus-4-8",
    agent: "api-claude",
    projectPath: "/tmp/project",
    permissionMode: "auto",
    approveWrites: false,
    ...conv,
  } as AgentConversation;
  return {
    conversationId: conversation.id,
    conversation,
    setPlanMode: vi.fn(),
    createApiConversation,
    selectConversation: vi.fn(),
    setActiveView: vi.fn(),
  };
}

describe("slashCommandHandlers /new", () => {
  it("does NOT forward the baked systemPromptOverride, but DOES inherit the memory flag (single-injection)", async () => {
    const createApiConversation = makeCreateMock();
    // The old conversation's prompt already contains a baked brief + AGENTS.md.
    const bakedPrompt =
      "## Project guidance (from AGENTS.md cascade)\n\n(agents md)\n\n---\n\n" +
      "MEMORY BRIEF TEXT\n\n---\n\nprofile prompt";

    const ctx = makeContext(
      {
        systemPromptOverride: bakedPrompt,
        memoryContextEnabled: true,
        planMode: false,
      },
      createApiConversation,
    );

    slashCommandHandlers.new(ctx);
    await flush();

    expect(createApiConversation).toHaveBeenCalledTimes(1);
    const arg = createApiConversation.mock.calls[0][0];
    // The baked prompt must NOT be re-passed — that's what caused the double.
    expect(arg.systemPromptOverride).toBeNull();
    expect(arg.systemPromptOverride).not.toBe(bakedPrompt);
    // The flag still rides along so createApiConversation composes ONE fresh
    // brief for the new session.
    expect(arg.memoryContextEnabled).toBe(true);
  });

  it("still inherits a memory-off conversation as memory-off", async () => {
    const createApiConversation = makeCreateMock();
    const ctx = makeContext(
      { systemPromptOverride: "baked", memoryContextEnabled: false },
      createApiConversation,
    );

    slashCommandHandlers.new(ctx);
    await flush();

    const arg = createApiConversation.mock.calls[0][0];
    expect(arg.systemPromptOverride).toBeNull();
    expect(arg.memoryContextEnabled).toBe(false);
  });
});
