import { describe, it, expect, vi } from "vitest";
import { normaliseBackendStatus } from "../qualityStream";

describe("normaliseBackendStatus", () => {
  it("passes through clean terminal statuses", () => {
    expect(normaliseBackendStatus("passed")).toBe("passed");
    expect(normaliseBackendStatus("failed")).toBe("failed");
    expect(normaliseBackendStatus("cancelled")).toBe("cancelled");
    expect(normaliseBackendStatus("skipped")).toBe("skipped");
  });

  it("collapses backend-specific failures onto 'errored'", () => {
    expect(normaliseBackendStatus("timed-out")).toBe("errored");
    expect(normaliseBackendStatus("missing-tool")).toBe("errored");
    expect(normaliseBackendStatus("spawn-error")).toBe("errored");
  });

  it("falls back to 'errored' for unknown statuses and warns", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(normaliseBackendStatus("future-status")).toBe("errored");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
