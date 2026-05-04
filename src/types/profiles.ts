import type { PermissionMode } from "./agent-conversation";

/**
 * Reusable agent configuration. A profile bundles a system prompt, an
 * allowed-tool whitelist, and a permission posture so the user can launch
 * conversations with a known persona without re-configuring each one.
 *
 * Profiles are durable (persisted to localStorage). Built-in profiles use
 * stable ids prefixed with `builtin-` and cannot be deleted; user-created
 * profiles use `prof_*` ids and are fully editable.
 */
export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  /** When non-null, restricts the agent to this exact tool set. Null = all
   * tools available (matches createApiConversation's `allowedTools` semantics). */
  allowedTools: string[] | null;
  /** Inject the project memory layer into the system prompt at start. */
  memoryContextEnabled: boolean;
  /** Permission posture applied to the conversation immediately after start. */
  permissionMode: PermissionMode;
  /** Plan-mode-on-start: if true, conversation begins in plan/read-only mode. */
  planMode: boolean;
  /** True for built-in profiles (cannot be deleted; can be cloned-and-edited). */
  isBuiltin: boolean;
  createdAt: number;
  updatedAt: number;
}
