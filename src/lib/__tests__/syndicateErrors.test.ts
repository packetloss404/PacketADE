import { describe, expect, it } from "vitest";
import {
  grantStatusFromSyndicateError,
  isFatalSyndicateError,
  isSyndicateControllerError,
  SyndicateControllerError,
  toSyndicateError,
} from "@/lib/syndicateErrors";

/** The shape a native Syndicate command rejects with. */
function nativeRejection(detail: {
  message: string;
  code?: string;
  retryable?: boolean;
  correlationId?: string;
}) {
  return toSyndicateError(detail);
}

describe("syndicateErrors", () => {
  it("rehydrates the native payload without losing the readable message", () => {
    const error = nativeRejection({
      message: "DEVICE_UNAUTHORIZED: Syndicate rejected the controller request",
      code: "DEVICE_UNAUTHORIZED",
      retryable: false,
      correlationId: "correlation-1",
    });

    // Every existing `catch` reads `.message`; the typed fields are additive.
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("DEVICE_UNAUTHORIZED: Syndicate rejected the controller request");
    expect(isSyndicateControllerError(error)).toBe(true);
    expect((error as SyndicateControllerError).code).toBe("DEVICE_UNAUTHORIZED");
    expect((error as SyndicateControllerError).correlationId).toBe("correlation-1");
  });

  it("stops retrying on every terminal Host verdict", () => {
    // The Host marks each of these `retryable: false`. Before this seam the
    // pane matched message fragments and missed DEVICE_UNAUTHORIZED entirely,
    // so an expired grant re-signed session.attach every 5 seconds forever.
    for (const code of [
      "DEVICE_UNAUTHORIZED",
      "DEVICE_REVOKED",
      "MACHINE_MISMATCH",
      "INVALID_SIGNATURE",
      "AUTH_REPLAY",
      "REQUEST_EXPIRED",
      "SCOPE_DENIED",
      "SESSION_NOT_FOUND",
      "SESSION_NOT_OWNED",
    ]) {
      expect(
        isFatalSyndicateError(nativeRejection({ message: code, code, retryable: false })),
      ).toBe(true);
    }
  });

  it("keeps retrying transient Host conditions and local faults", () => {
    // The Host explicitly marks these retryable, and a socket fault carries no
    // verdict at all. Treating either as fatal would break ordinary reconnect.
    for (const code of [
      "TERMINAL_RUNTIME_UNAVAILABLE",
      "WORKTREE_RUNTIME_UNAVAILABLE",
      "WORKSPACE_BUSY",
      "INTERNAL_ERROR",
    ]) {
      expect(isFatalSyndicateError(nativeRejection({ message: code, code, retryable: true }))).toBe(
        false,
      );
    }

    expect(
      isFatalSyndicateError(
        nativeRejection({ message: "Cannot reach Syndicate on the loopback forward: timed out" }),
      ),
    ).toBe(false);
    expect(isFatalSyndicateError(new Error("PacketRelay connection timed out."))).toBe(false);
    expect(isFatalSyndicateError("a bare string")).toBe(false);
  });

  it("reads a dead grant from the code, not the sentence", () => {
    expect(
      grantStatusFromSyndicateError(
        nativeRejection({ message: "expired", code: "DEVICE_UNAUTHORIZED", retryable: false }),
      ),
    ).toBe("expired");
    expect(
      grantStatusFromSyndicateError(
        nativeRejection({ message: "revoked", code: "DEVICE_REVOKED", retryable: false }),
      ),
    ).toBe("revoked");
    // PacketADE's own verdict on a relay grant it can see has expired.
    expect(
      grantStatusFromSyndicateError(
        nativeRejection({
          message:
            "PacketRelay request failed without an automatic retry over SSH: The Syndicate relay grant is expired or has an invalid lifetime.",
          code: "GRANT_EXPIRED",
          retryable: false,
        }),
      ),
    ).toBe("expired");
  });

  it("never invents a grant state", () => {
    // A fatal verdict is not automatically a dead grant: a denied scope or a
    // replayed nonce says nothing about whether the grant still lives.
    expect(
      grantStatusFromSyndicateError(
        nativeRejection({ message: "denied", code: "SCOPE_DENIED", retryable: false }),
      ),
    ).toBeUndefined();
    expect(
      grantStatusFromSyndicateError(
        // Prose alone proves nothing once codes exist.
        new Error("This PacketADE device was revoked by Syndicate."),
      ),
    ).toBeUndefined();
    expect(grantStatusFromSyndicateError(undefined)).toBeUndefined();
  });

  it("recognizes its own errors without relying on class identity", () => {
    // The brand survives a second copy of the module; `instanceof` would not,
    // and a miss silently downgrades a fatal verdict back to an infinite retry.
    const foreign = Object.assign(new Error("DEVICE_UNAUTHORIZED"), {
      isSyndicateControllerError: true as const,
      code: "DEVICE_UNAUTHORIZED",
      retryable: false,
    });

    expect(isSyndicateControllerError(foreign)).toBe(true);
    expect(isFatalSyndicateError(foreign)).toBe(true);
    expect(grantStatusFromSyndicateError(foreign)).toBe("expired");
  });

  it("passes through values that are not native payloads", () => {
    const original = new Error("already an error");
    expect(toSyndicateError(original)).toBe(original);
    expect(toSyndicateError("plain string").message).toBe("plain string");
    expect(isSyndicateControllerError(toSyndicateError({ unexpected: true }))).toBe(false);
  });
});
