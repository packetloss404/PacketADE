export function ptyOutputEvent(sessionId: string): string {
  return `pty:output:${sessionId}`;
}

export function ptyExitEvent(sessionId: string): string {
  return `pty:exit:${sessionId}`;
}

export function insightsChunkEvent(requestId: string): string {
  return `insights:chunk:${requestId}`;
}

export function insightsErrorEvent(requestId: string): string {
  return `insights:error:${requestId}`;
}

export function insightsDoneEvent(requestId: string): string {
  return `insights:done:${requestId}`;
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
