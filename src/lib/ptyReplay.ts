export interface PtyOutputPayload {
  data: string;
  sequence: number | null;
}

/** Accept the sequenced contract and legacy string events during upgrades. */
export function parsePtyOutputPayload(payload: unknown): PtyOutputPayload {
  if (typeof payload === "string") return { data: payload, sequence: null };
  if (payload && typeof payload === "object") {
    const candidate = payload as { data?: unknown; sequence?: unknown };
    if (typeof candidate.data === "string") {
      return {
        data: candidate.data,
        sequence:
          typeof candidate.sequence === "number" && Number.isFinite(candidate.sequence)
            ? candidate.sequence
            : null,
      };
    }
  }
  return { data: "", sequence: null };
}

function legacyNonOverlappingSuffix(base: string, tail: string): string {
  if (!base || !tail) return tail;
  const max = Math.min(base.length, tail.length);
  for (let len = max; len > 0; len--) {
    if (base.endsWith(tail.slice(0, len))) return tail.slice(len);
  }
  return tail;
}

/** Join a locked transcript snapshot with events captured while it was read. */
export function bufferedPtyRemainder(
  replayed: string,
  transcriptSequence: number | null | undefined,
  buffered: PtyOutputPayload[],
): string {
  if (typeof transcriptSequence === "number" && Number.isFinite(transcriptSequence)) {
    return buffered
      .filter((event) => event.sequence === null || event.sequence > transcriptSequence)
      .map((event) => event.data)
      .join("");
  }

  return legacyNonOverlappingSuffix(replayed, buffered.map((event) => event.data).join(""));
}
