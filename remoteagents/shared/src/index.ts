export const REMOTE_PROTOCOL_VERSION = 1 as const;
export const MAX_INLINE_PAYLOAD_BYTES = 64 * 1024;

export const REMOTE_CHANNELS = [
  "presence",
  "agent",
  "approval",
  "host",
  "control",
  "file",
  "push",
] as const;

export type RemoteChannel = (typeof REMOTE_CHANNELS)[number];

export interface RemoteEnvelopeV1 {
  v: typeof REMOTE_PROTOCOL_VERSION;
  envelopeId: string;
  traceId: string;
  accountId: string;
  hostId: string;
  deviceId?: string;
  conversationId?: string;
  channel: RemoteChannel;
  type: string;
  streamId: string;
  seq?: number;
  ack?: number;
  idempotencyKey?: string;
  createdAt: string;
  ttlMs?: number;
  keyId?: string;
  ciphertext?: string;
  signature?: string;
  /** Internal development only. External beta requires encrypted payloads. */
  payload?: unknown;
}

export type RemoteEnvelopeValidation =
  | { ok: true; value: RemoteEnvelopeV1 }
  | { ok: false; issues: string[] };

const channelSet = new Set<string>(REMOTE_CHANNELS);
const envelopeKeys = new Set([
  "v",
  "envelopeId",
  "traceId",
  "accountId",
  "hostId",
  "deviceId",
  "conversationId",
  "channel",
  "type",
  "streamId",
  "seq",
  "ack",
  "idempotencyKey",
  "createdAt",
  "ttlMs",
  "keyId",
  "ciphertext",
  "signature",
  "payload",
]);
const rfc3339Pattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):([0-5]\d)(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

export function validateRemoteEnvelopeV1(input: unknown): RemoteEnvelopeValidation {
  if (!isRecord(input)) return { ok: false, issues: ["envelope must be an object"] };

  const issues: string[] = [];
  for (const key of Object.keys(input)) {
    if (!envelopeKeys.has(key)) issues.push(`${key} is not a supported property`);
  }
  if (input.v !== REMOTE_PROTOCOL_VERSION) issues.push("v must equal 1");
  requireString(input, "envelopeId", issues);
  requireString(input, "traceId", issues);
  requireString(input, "accountId", issues);
  requireString(input, "hostId", issues);
  requireString(input, "type", issues);
  requireString(input, "streamId", issues);
  requireString(input, "createdAt", issues);
  if (typeof input.createdAt === "string" && !isRfc3339DateTime(input.createdAt)) {
    issues.push("createdAt must be an RFC 3339 date-time");
  }
  optionalString(input, "deviceId", issues);
  optionalString(input, "conversationId", issues);
  optionalString(input, "idempotencyKey", issues);
  optionalString(input, "keyId", issues);
  optionalString(input, "ciphertext", issues);
  optionalString(input, "signature", issues);
  optionalInteger(input, "seq", 0, issues);
  optionalInteger(input, "ack", 0, issues);
  optionalInteger(input, "ttlMs", 1, issues);
  if (typeof input.channel !== "string" || !channelSet.has(input.channel)) {
    issues.push("channel is not supported");
  }

  return issues.length === 0
    ? { ok: true, value: input as unknown as RemoteEnvelopeV1 }
    : { ok: false, issues };
}

function isRfc3339DateTime(value: string): boolean {
  const match = rfc3339Pattern.exec(value);
  if (!match) return false;
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    offsetHour,
    offsetMinute,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (daysInMonth[month - 1] ?? 0) &&
    Number(hourText) <= 23 &&
    Number(minuteText) <= 59 &&
    Number(secondText) <= 59 &&
    (offsetHour === undefined || Number(offsetHour) <= 23) &&
    (offsetMinute === undefined || Number(offsetMinute) <= 59)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: Record<string, unknown>, key: string, issues: string[]): void {
  if (typeof value[key] !== "string" || value[key].trim().length === 0) {
    issues.push(`${key} must be a non-empty string`);
  }
}

function optionalString(value: Record<string, unknown>, key: string, issues: string[]): void {
  if (
    value[key] !== undefined &&
    (typeof value[key] !== "string" || value[key].trim().length === 0)
  ) {
    issues.push(`${key} must be a non-empty string when present`);
  }
}

function optionalInteger(
  value: Record<string, unknown>,
  key: string,
  minimum: number,
  issues: string[],
): void {
  if (
    value[key] !== undefined &&
    (!Number.isSafeInteger(value[key]) || (value[key] as number) < minimum)
  ) {
    issues.push(`${key} must be an integer >= ${minimum} when present`);
  }
}
