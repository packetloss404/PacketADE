import { describe, expect, it } from "vitest";
import { deviceFlowNextDelayMs, deviceFlowIsTerminal } from "@/lib/deviceFlow";

describe("deviceFlowNextDelayMs (GP3)", () => {
  it("holds the interval while pending", () => {
    expect(deviceFlowNextDelayMs("pending", 5000)).toBe(5000);
  });
  it("adds 5s on slow_down", () => {
    expect(deviceFlowNextDelayMs("slow_down", 5000)).toBe(10000);
    expect(deviceFlowNextDelayMs("slow_down", 10000)).toBe(15000);
  });
});

describe("deviceFlowIsTerminal (GP3)", () => {
  it("stops on authorized or error, continues otherwise", () => {
    expect(deviceFlowIsTerminal("authorized")).toBe(true);
    expect(deviceFlowIsTerminal("error")).toBe(true);
    expect(deviceFlowIsTerminal("pending")).toBe(false);
    expect(deviceFlowIsTerminal("slow_down")).toBe(false);
  });
});
