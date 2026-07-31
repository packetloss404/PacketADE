import { describe, expect, it } from "vitest";
import { ACCOUNT_COLOR_COUNT, getAccountColor } from "@/lib/accountColors";

describe("getAccountColor", () => {
  it("is stable for a given account id", () => {
    const a = getAccountColor("acct-personal-oss");
    const b = getAccountColor("acct-personal-oss");
    expect(a).toBe(b);
    expect(a.text).toMatch(/^text-accent-/);
  });

  it("gives different accounts different colors (the point of the chip)", () => {
    // Not a hash-collision guarantee in general, but these two real-shaped ids
    // must differ or the mis-pick safeguard is invisible.
    const oss = getAccountColor("acct-1a2b3c");
    const client = getAccountColor("acct-9z8y7x");
    expect(oss.text).not.toBe(client.text);
  });

  it("returns the neutral bundle for ambient panes (no account)", () => {
    for (const id of [null, undefined, ""]) {
      const c = getAccountColor(id);
      expect(c.text).toBe("text-text-secondary");
      expect(c.text).not.toMatch(/^text-accent-/);
    }
  });

  it("only ever emits design-token classNames, never raw Tailwind colors", () => {
    for (let i = 0; i < 200; i++) {
      const c = getAccountColor(`acct-${i}`);
      for (const cls of [c.text, c.bg, c.border]) {
        expect(cls).toMatch(/(accent-|text-text-|bg-bg-|border-bg-)/);
        expect(cls).not.toMatch(/-(50|100|200|300|400|500|600|700|800|900)\b/);
      }
    }
  });

  it("spreads across the whole palette", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(getAccountColor(`acct-${i}`).text);
    expect(seen.size).toBe(ACCOUNT_COLOR_COUNT);
  });
});
