export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  systemPrompt: string;
  defaultModel: string;
  isBuiltin: boolean;
  /** Restrict the agent to this tool subset. Undefined = all tools allowed.
   * Used by the built-in Scout profile for read-only investigation. */
  allowedTools?: string[];
  /** Inject the memory layer's project context into the system prompt by default
   * for conversations created from this profile. User can toggle per-conversation. */
  memoryContextDefault?: boolean;
}
