export function ptyOutputEvent(sessionId: string): string {
  return `pty:output:${sessionId}`;
}

export function ptyExitEvent(sessionId: string): string {
  return `pty:exit:${sessionId}`;
}

export function agentChatChunkEvent(requestId: string): string {
  return `agent-chat:chunk:${requestId}`;
}

export function agentChatErrorEvent(requestId: string): string {
  return `agent-chat:error:${requestId}`;
}

export function agentChatDoneEvent(requestId: string): string {
  return `agent-chat:done:${requestId}`;
}

export function flightChatChunkEvent(requestId: string): string {
  return `flight-chat:chunk:${requestId}`;
}

export function flightChatErrorEvent(requestId: string): string {
  return `flight-chat:error:${requestId}`;
}

export function flightChatDoneEvent(requestId: string): string {
  return `flight-chat:done:${requestId}`;
}

// Side chat (ephemeral helper overlay) — single global event names since
// only one side-chat request is in flight at a time.
export const sideChatDoneEvent = "side-chat:done";
export const sideChatErrorEvent = "side-chat:error";

// API agent events
export function apiAgentChunkEvent(sessionId: string): string {
  return `api-agent:chunk:${sessionId}`;
}

export function apiAgentToolStartEvent(sessionId: string): string {
  return `api-agent:tool-start:${sessionId}`;
}

export function apiAgentToolResultEvent(sessionId: string): string {
  return `api-agent:tool-result:${sessionId}`;
}

export function apiAgentDoneEvent(sessionId: string): string {
  return `api-agent:done:${sessionId}`;
}

export function apiAgentErrorEvent(sessionId: string): string {
  return `api-agent:error:${sessionId}`;
}

export function apiAgentThinkingEvent(sessionId: string): string {
  return `api-agent:thinking:${sessionId}`;
}

export function apiAgentThinkingStopEvent(sessionId: string): string {
  return `api-agent:thinking-stop:${sessionId}`;
}

export function apiAgentPermissionRequestEvent(sessionId: string): string {
  return `api-agent:permission-request:${sessionId}`;
}

export function apiAgentPendingEditEvent(sessionId: string): string {
  return `api-agent:pending-edit:${sessionId}`;
}
