import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

import remoteEnvelopeSchema from "../schema/remote-envelope-v1.schema.json";
import { validateRemoteEnvelopeV1 } from "./index.js";

const validEnvelope = {
  v: 1,
  envelopeId: "env_01",
  traceId: "trace_01",
  accountId: "acct_01",
  hostId: "host_01",
  channel: "presence",
  type: "host.online",
  streamId: "host_01:presence",
  seq: 1,
  createdAt: "2026-09-01T00:00:00Z",
  payload: { online: true },
};

describe("validateRemoteEnvelopeV1", () => {
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  const validateSchema = ajv.compile(remoteEnvelopeSchema);

  it("accepts the locked v1 fixture shape", () => {
    expect(validateRemoteEnvelopeV1(validEnvelope)).toMatchObject({ ok: true });
  });

  it.each([
    ["unknown properties", { ...validEnvelope, unexpected: true }],
    ["invalid timestamps", { ...validEnvelope, createdAt: "not-a-date" }],
    ["invalid calendar dates", { ...validEnvelope, createdAt: "2026-02-30T00:00:00Z" }],
    ["space-separated timestamps", { ...validEnvelope, createdAt: "2026-09-01 00:00:00Z" }],
    ["leap seconds", { ...validEnvelope, createdAt: "1990-12-31T23:59:60Z" }],
    ["lowercase separators", { ...validEnvelope, createdAt: "2026-09-01t00:00:00z" }],
    ["unsupported versions", { ...validEnvelope, v: 2 }],
    ["blank identifiers", { ...validEnvelope, envelopeId: "   " }],
    ["zero TTLs", { ...validEnvelope, ttlMs: 0 }],
    ["unsafe sequence numbers", { ...validEnvelope, seq: Number.MAX_SAFE_INTEGER + 1 }],
    ["null optional fields", { ...validEnvelope, deviceId: null }],
  ])("rejects %s", (_description, envelope) => {
    expect(validateRemoteEnvelopeV1(envelope)).toMatchObject({ ok: false });
  });

  it.each([
    validEnvelope,
    { ...validEnvelope, unexpected: true },
    { ...validEnvelope, createdAt: "not-a-date" },
    { ...validEnvelope, createdAt: "2026-02-30T00:00:00Z" },
    { ...validEnvelope, createdAt: "2026-09-01 00:00:00Z" },
    { ...validEnvelope, createdAt: "1990-12-31T23:59:60Z" },
    { ...validEnvelope, createdAt: "2026-09-01t00:00:00z" },
    { ...validEnvelope, v: 2 },
    { ...validEnvelope, envelopeId: "   " },
    { ...validEnvelope, ttlMs: 0 },
    { ...validEnvelope, seq: Number.MAX_SAFE_INTEGER + 1 },
    { ...validEnvelope, deviceId: null },
    { ...validEnvelope, channel: "unknown" },
  ])("matches the exported JSON Schema for %#", (envelope) => {
    const schemaAccepted = validateSchema(envelope);
    const runtimeAccepted = validateRemoteEnvelopeV1(envelope).ok;
    expect(runtimeAccepted).toBe(schemaAccepted);
  });
});
