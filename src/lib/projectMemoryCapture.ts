import type { MemoryEvent } from "@/types/memory";
import type {
  CreateProjectMemoryInput,
  ProjectMemoryNote,
} from "@/types/project-memory";
import type { ProvenanceEnvelope } from "@/types/provenance";

export function redactProjectMemoryCapture(value: string): string {
  return value
    .replace(
      /-----BEGIN (?:OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:OPENSSH )?PRIVATE KEY-----/g,
      "[REDACTED]",
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /\b(?:sk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{8,}\b/g,
      "[REDACTED]",
    );
}

export function buildProjectMemoryCapture(input: {
  title: string;
  body: string;
  tags?: string[];
  provenance?: ProvenanceEnvelope[];
}): CreateProjectMemoryInput {
  return {
    title: redactProjectMemoryCapture(input.title).trim(),
    body: redactProjectMemoryCapture(input.body).trim(),
    tags: input.tags ?? [],
    provenanceIds: input.provenance?.map((source) => source.id) ?? [],
  };
}

export function captureFromGlobalMemoryEvent(
  event: MemoryEvent,
): CreateProjectMemoryInput {
  const title =
    event.type === "session_completed"
      ? event.payload.summary || `Session ${event.payload.sessionId}`
      : event.type === "flight_completed"
        ? event.payload.flightTitle
        : event.type === "task_completed"
          ? event.payload.taskTitle
          : event.payload.summary;
  return buildProjectMemoryCapture({
    title,
    body: [
      `Captured from PacketBench global memory event \`${event.id}\`.`,
      "",
      "```json",
      JSON.stringify(event.payload, null, 2),
      "```",
    ].join("\n"),
    tags: ["global-memory", event.type],
    provenance: event.provenance ? [event.provenance] : [],
  });
}

export function alreadyCaptured(
  notes: ProjectMemoryNote[],
  provenanceIds: string[],
): boolean {
  return (
    provenanceIds.length > 0 &&
    notes.some((note) =>
      provenanceIds.every((id) => note.metadata.provenanceIds.includes(id)),
    )
  );
}
