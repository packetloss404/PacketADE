/**
 * D3 (audit finding P0-4) — Plan's plan handoff used to hard-code
 * `sshTarget: null`, silently converting a remote conversation into a LOCAL
 * executor session pointed at a path that only exists on the remote host.
 *
 * Contract now:
 *  - the handoff INHERITS the parent's SSH identity (rebuilt from the live
 *    ServerConfig, keeping the conversation's own remote path);
 *  - local conversations still hand off with `sshTarget: null`;
 *  - when the SSH server record is gone the remote identity cannot be
 *    rebuilt, so the button disables instead of quietly going local.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConversation } from "@/types/agent-conversation";
import type { ServerConfig } from "@/types/server";

const createApiConversationMock = vi.hoisted(() => vi.fn());
const selectConversationMock = vi.hoisted(() => vi.fn());
const setParentConversationMock = vi.hoisted(() => vi.fn());
const getProviderAuthStatusMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", () => ({
  getProviderAuthStatus: (...args: unknown[]) =>
    getProviderAuthStatusMock(...args),
  saveServersSlice: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

const taskStoreState = vi.hoisted(() => ({
  createApiConversation: (...args: unknown[]) =>
    createApiConversationMock(...args),
  selectConversation: (...args: unknown[]) => selectConversationMock(...args),
  setParentConversation: (...args: unknown[]) =>
    setParentConversationMock(...args),
}));
vi.mock("@/stores/agentTaskStore", () => ({
  useAgentTaskStore: (selector: (s: typeof taskStoreState) => unknown) =>
    selector(taskStoreState),
  // The handoff gates on the executor's CREDENTIAL. `api-openai-agents`
  // authenticates with the OpenAI API key, so the probe key is "openai".
  // Explicit map, never a prefix-strip — see
  // `scripts/attempt-provider-mapping.test.mjs`.
  authProbeProvider: (agent: string) =>
    ({
      "api-openai-agents": "openai",
      "api-claude-oauth": "anthropic",
      "api-claude": "anthropic",
    })[agent] ?? "anthropic",
}));

import { PlanPanel } from "@/components/agents/PlanPanel";
import { useAgentPlanStore } from "@/stores/agentPlanStore";
import { useServerStore } from "@/stores/serverStore";

const SERVER: ServerConfig = {
  id: "srv-1",
  name: "build box",
  host: "10.0.0.5",
  port: 2222,
  username: "ian",
  authMethod: "key",
  keyPath: "/home/ian/.ssh/id_ed25519",
  installedAgents: [],
  hostFingerprint: "SHA256:abc",
};

function makeConversation(remote: boolean): AgentConversation {
  return {
    id: "conv-1",
    title: "Planner",
    agent: "api-claude-oauth",
    projectPath: remote ? "/home/ian/proj" : "C:/proj",
    status: "idle",
    messages: [],
    sessionId: "conv-1",
    rawOutput: "",
    createdAt: 1,
    updatedAt: 1,
    mode: "api",
    model: "claude-sonnet-4-6",
    // The handoff button only renders while a plan awaits approval.
    planMode: true,
    ...(remote
      ? {
          sshTarget: {
            id: "srv-1",
            name: "box",
            host: "10.0.0.5",
            user: "ian",
            remotePath: "/home/ian/proj",
          },
        }
      : {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  createApiConversationMock.mockResolvedValue("conv-2");
  getProviderAuthStatusMock.mockResolvedValue({ status: "ready" });
  useServerStore.setState({ servers: [SERVER], activeServerId: null });
  useAgentPlanStore.setState({
    plan: new Map([
      [
        "conv-1",
        [{ content: "Step one", status: "pending" as const }],
      ],
    ]),
    planApproved: new Map(),
  });
});

async function renderPanel(conversation: AgentConversation) {
  await act(async () => {
    render(<PlanPanel conversation={conversation} />);
  });
  return screen.getByRole("button", { name: /hand off to openai/i });
}

describe("PlanPanel — plan handoff preserves the SSH target (D3 / P0-4)", () => {
  it("inherits the parent's remote identity from the live server record", async () => {
    const button = await renderPanel(makeConversation(true));
    await waitFor(() => expect(button).not.toBeDisabled());

    await act(async () => {
      fireEvent.click(button);
    });

    await waitFor(() => expect(createApiConversationMock).toHaveBeenCalled());
    expect(createApiConversationMock.mock.calls[0][0]).toMatchObject({
      // Repointed from the retired `api-openai-codex` row in 2026-07.
      agent: "api-openai-agents",
      projectPath: "/home/ian/proj",
      sshTarget: {
        serverId: "srv-1",
        host: "10.0.0.5",
        port: 2222,
        user: "ian",
        remotePath: "/home/ian/proj",
        authMethod: "key",
        hostFingerprint: "SHA256:abc",
      },
    });
  });

  it("still hands off local conversations with no SSH target", async () => {
    const button = await renderPanel(makeConversation(false));
    await waitFor(() => expect(button).not.toBeDisabled());

    await act(async () => {
      fireEvent.click(button);
    });

    await waitFor(() => expect(createApiConversationMock).toHaveBeenCalled());
    expect(createApiConversationMock.mock.calls[0][0].sshTarget).toBeNull();
  });

  it("disables the handoff when the SSH server record is gone instead of going local", async () => {
    useServerStore.setState({ servers: [] });

    const button = await renderPanel(makeConversation(true));
    expect(button).toBeDisabled();

    await act(async () => {
      fireEvent.click(button);
    });
    expect(createApiConversationMock).not.toHaveBeenCalled();
  });
});
