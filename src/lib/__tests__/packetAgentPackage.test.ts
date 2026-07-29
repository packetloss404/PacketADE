import { describe, expect, it } from "vitest";
import fixture from "./fixtures/packetagent-worker-package-v1.json";
import {
  canonicalPacketAgentJson,
  computePacketAgentPackageDigest,
} from "@/lib/packetAgentPackage";
import type { PacketAgentWorkerPackage } from "@/types/packet-agent";

const EXPECTED_FIXTURE_DIGEST =
  "sha256:fcea4fc3eb7cf0598c8d2312b1374bddd1a07c953380bd7a15792e35422e143d";

describe("PacketAgent W9 package contract", () => {
  it("reproduces the PacketAgent-owned canonical fixture digest", async () => {
    const contractFixture = fixture as unknown as PacketAgentWorkerPackage;
    await expect(computePacketAgentPackageDigest(contractFixture)).resolves.toBe(
      EXPECTED_FIXTURE_DIGEST,
    );
  });

  it("uses deterministic UTF-16 code-unit property ordering", () => {
    expect(
      canonicalPacketAgentJson({
        "\u20ac": "Euro Sign",
        "\r": "Carriage Return",
        "\ufb33": "Hebrew Letter Dalet With Dagesh",
        1: "One",
        "\ud83d\ude00": "Emoji: Grinning Face",
        "\u0080": "Control",
        "\u00f6": "Latin Small Letter O With Diaeresis",
      }),
    ).toBe(
      '{"\\r":"Carriage Return","1":"One","":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it("rejects values outside strict JSON", () => {
    expect(() => canonicalPacketAgentJson({ missing: undefined })).toThrow(/undefined/i);
    expect(() => canonicalPacketAgentJson({ amount: Number.POSITIVE_INFINITY })).toThrow(
      /non-finite/i,
    );
    expect(() => canonicalPacketAgentJson({ invalid: "\ud800" })).toThrow(/unpaired/i);
  });
});
