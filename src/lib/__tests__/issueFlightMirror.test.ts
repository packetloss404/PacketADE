import { describe, it, expect } from "vitest";
import {
  diffMirrorState,
  advanceMirrorRecord,
  hasPendingChange,
  resolveMirrorTarget,
  fieldEqual,
  buildBodyMarker,
  parseBodyMarker,
  stripBodyMarker,
  embedBodyMarker,
  type MirrorFields,
  type LocalMirrorState,
  type HostMirrorState,
  type MirrorRecord,
} from "@/lib/issueFlightMirror";

const base: MirrorFields = {
  title: "Add OAuth login",
  state: "open",
  labels: ["auth", "backend"],
  milestone: "v1",
};

function local(
  fields: Partial<MirrorFields> = {},
  updatedAt = 1000,
  localRev = 5,
): LocalMirrorState {
  return { localRev, updatedAt, fields: { ...base, ...fields } };
}
function host(
  fields: Partial<MirrorFields> = {},
  updatedAt = "2026-07-25T00:00:00Z",
): HostMirrorState {
  return { updatedAt, fields: { ...base, ...fields } };
}

describe("fieldEqual", () => {
  it("compares labels order-independently", () => {
    expect(fieldEqual("labels", ["a", "b"], ["b", "a"])).toBe(true);
    expect(fieldEqual("labels", ["a"], ["a", "b"])).toBe(false);
  });
  it("compares scalars strictly, incl. null milestone", () => {
    expect(fieldEqual("milestone", null, null)).toBe(true);
    expect(fieldEqual("milestone", "v1", null)).toBe(false);
    expect(fieldEqual("state", "open", "closed")).toBe(false);
  });
});

describe("diffMirrorState", () => {
  it("no changes → all noop, empty push/pull/conflicts", () => {
    const plan = diffMirrorState(local(), host(), base);
    expect(plan.decisions.every((d) => d.action === "noop")).toBe(true);
    expect(plan.toPush).toEqual({});
    expect(plan.toPull).toEqual({});
    expect(plan.conflicts).toEqual([]);
    expect(plan.resolvedFields).toEqual(base);
  });

  it("local-only change → push that field", () => {
    const plan = diffMirrorState(local({ title: "Add OAuth + SSO" }), host(), base);
    expect(plan.toPush).toEqual({ title: "Add OAuth + SSO" });
    expect(plan.toPull).toEqual({});
    expect(plan.conflicts).toEqual([]);
    expect(plan.resolvedFields.title).toBe("Add OAuth + SSO");
  });

  it("host-only change → pull that field", () => {
    const plan = diffMirrorState(local(), host({ state: "closed" }), base);
    expect(plan.toPull).toEqual({ state: "closed" });
    expect(plan.toPush).toEqual({});
    expect(plan.resolvedFields.state).toBe("closed");
  });

  it("both changed to the same value → noop, no conflict", () => {
    const plan = diffMirrorState(
      local({ milestone: "v2" }),
      host({ milestone: "v2" }),
      base,
    );
    expect(plan.decisions.find((d) => d.field === "milestone")?.action).toBe("noop");
    expect(plan.conflicts).toEqual([]);
    expect(plan.resolvedFields.milestone).toBe("v2");
  });

  it("both changed differently, local newer → conflict, local wins", () => {
    const plan = diffMirrorState(
      local({ title: "Local title" }, 2_000_000_000_000), // far-future local edit
      host({ title: "Host title" }, "2026-07-25T00:00:00Z"),
      base,
    );
    const d = plan.decisions.find((x) => x.field === "title");
    expect(d?.action).toBe("conflict");
    expect(plan.toPush.title).toBe("Local title");
    expect(plan.toPull.title).toBeUndefined();
    expect(plan.resolvedFields.title).toBe("Local title");
    expect(plan.conflicts).toEqual([
      {
        field: "title",
        winner: "local",
        localValue: "Local title",
        hostValue: "Host title",
      },
    ]);
  });

  it("both changed differently, host newer → conflict, host wins", () => {
    const plan = diffMirrorState(
      local({ title: "Local title" }, 1000), // old local edit
      host({ title: "Host title" }, "2026-07-25T00:00:00Z"),
      base,
    );
    expect(plan.toPull.title).toBe("Host title");
    expect(plan.toPush.title).toBeUndefined();
    expect(plan.resolvedFields.title).toBe("Host title");
    expect(plan.conflicts[0]).toMatchObject({ winner: "host" });
  });

  it("label set reordering is not a change", () => {
    const plan = diffMirrorState(
      local({ labels: ["backend", "auth"] }),
      host(),
      base,
    );
    expect(plan.decisions.find((d) => d.field === "labels")?.action).toBe("noop");
    expect(plan.toPush).toEqual({});
  });

  it("mixed: push one field, pull another, conflict a third, in one plan", () => {
    const plan = diffMirrorState(
      local({ title: "Local T", labels: ["auth", "backend", "x"] }, 5_000_000_000_000),
      host({ title: "Host T", state: "closed" }, "2026-07-25T00:00:00Z"),
      base,
    );
    // labels: local-only add → push
    expect(plan.toPush.labels).toEqual(["auth", "backend", "x"]);
    // state: host-only → pull
    expect(plan.toPull.state).toBe("closed");
    // title: both changed, local newer → conflict, local wins
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].field).toBe("title");
    expect(plan.resolvedFields).toEqual({
      title: "Local T",
      state: "closed",
      labels: ["auth", "backend", "x"],
      milestone: "v1",
    });
  });

  it("unparseable host timestamp resolves conflicts to local", () => {
    const plan = diffMirrorState(
      local({ title: "L" }, 1),
      host({ title: "H" }, "not-a-date"),
      base,
    );
    expect(plan.conflicts[0].winner).toBe("local");
  });

  it("resolves multiple simultaneous conflicts the same direction (host newer)", () => {
    const plan = diffMirrorState(
      local({ title: "LT", milestone: "v9" }, 1000),
      host({ title: "HT", milestone: "v2" }, "2026-07-25T00:00:00Z"),
      base,
    );
    expect(plan.conflicts.map((c) => c.field)).toEqual(["title", "milestone"]);
    expect(plan.conflicts.every((c) => c.winner === "host")).toBe(true);
    expect(plan.resolvedFields.title).toBe("HT");
    expect(plan.resolvedFields.milestone).toBe("v2");
  });

  it("handles a milestone → null transition (push and pull)", () => {
    const pushPlan = diffMirrorState(local({ milestone: null }), host(), base);
    expect(pushPlan.toPush).toEqual({ milestone: null });
    expect(pushPlan.resolvedFields.milestone).toBeNull();

    const pullPlan = diffMirrorState(local(), host({ milestone: null }), base);
    expect(pullPlan.toPull).toEqual({ milestone: null });
    expect(pullPlan.resolvedFields.milestone).toBeNull();
  });

  it("does not alias input label arrays into the plan outputs", () => {
    const l = local({ labels: ["auth", "backend", "new"] });
    const plan = diffMirrorState(l, host(), base);
    // toPush.labels must be a copy — mutating it can't affect the input.
    plan.toPush.labels!.push("mutated");
    expect(l.fields.labels).toEqual(["auth", "backend", "new"]);
    // resolvedFields.labels is likewise independent.
    expect(plan.resolvedFields.labels).not.toBe(l.fields.labels);
  });

  it("push-side echo suppression: a pushed field does not re-sync next poll", () => {
    // Local changes the title → push. After the write the host reflects the new
    // title with a NEWER updated_at. The next diff against the advanced base
    // must produce zero work (no sync loop) — the design's headline guarantee.
    const l = local({ title: "New title" }, 1000, 6);
    const beforeHost = host(); // host still has base title
    const plan = diffMirrorState(l, beforeHost, base);
    expect(plan.toPush).toEqual({ title: "New title" });

    const record: MirrorRecord = {
      hostConnectionId: "gh",
      owner: "acme",
      repo: "app",
      issueNumber: 42,
      lastSyncedLocalRev: 5,
      lastSyncedHostUpdatedAt: beforeHost.updatedAt,
      lastSyncedFields: base,
    };
    // Simulate the write bumping host.updated_at and reflecting the pushed value.
    const postWriteHost = host({ title: "New title" }, "2026-07-25T06:00:00Z");
    const advanced = advanceMirrorRecord(record, {
      localRev: l.localRev,
      hostUpdatedAt: postWriteHost.updatedAt,
      fields: plan.resolvedFields,
    });

    const echo = diffMirrorState(l, postWriteHost, advanced.lastSyncedFields);
    expect(echo.toPush).toEqual({});
    expect(echo.toPull).toEqual({});
    expect(echo.conflicts).toEqual([]);
  });
});

describe("resolveMirrorTarget", () => {
  const record: MirrorRecord = {
    hostConnectionId: "gh",
    owner: "a",
    repo: "b",
    issueNumber: 1,
    lastSyncedLocalRev: 0,
    lastSyncedHostUpdatedAt: "2026-07-25T00:00:00Z",
    lastSyncedFields: base,
  };
  it("updates when a record exists", () => {
    expect(resolveMirrorTarget(record, false)).toBe("update");
    expect(resolveMirrorTarget(record, true)).toBe("update");
  });
  it("adopts when no record but a marker was found", () => {
    expect(resolveMirrorTarget(undefined, true)).toBe("adopt");
  });
  it("creates when neither a record nor a marker exists", () => {
    expect(resolveMirrorTarget(null, false)).toBe("create");
  });
});

describe("hasPendingChange", () => {
  const record: MirrorRecord = {
    hostConnectionId: "gh",
    owner: "acme",
    repo: "app",
    issueNumber: 42,
    lastSyncedLocalRev: 5,
    lastSyncedHostUpdatedAt: "2026-07-25T00:00:00Z",
    lastSyncedFields: base,
  };

  it("false when neither fence advanced", () => {
    expect(hasPendingChange(record, local({}, 1000, 5), host())).toBe(false);
  });
  it("true when local rev advanced", () => {
    expect(hasPendingChange(record, local({}, 1000, 6), host())).toBe(true);
  });
  it("true when host updatedAt advanced", () => {
    expect(
      hasPendingChange(record, local({}, 1000, 5), host({}, "2026-07-25T01:00:00Z")),
    ).toBe(true);
  });
  it("true (conservative) on an unparseable timestamp", () => {
    expect(hasPendingChange(record, local({}, 1000, 5), host({}, "nope"))).toBe(true);
  });
});

describe("advanceMirrorRecord", () => {
  const record: MirrorRecord = {
    hostConnectionId: "gh",
    owner: "acme",
    repo: "app",
    issueNumber: 42,
    lastSyncedLocalRev: 5,
    lastSyncedHostUpdatedAt: "2026-07-25T00:00:00Z",
    lastSyncedFields: base,
  };

  it("stamps the new post-write fences and field snapshot", () => {
    const next = advanceMirrorRecord(record, {
      localRev: 8,
      hostUpdatedAt: "2026-07-25T02:00:00Z",
      fields: { ...base, state: "closed" },
    });
    expect(next.lastSyncedLocalRev).toBe(8);
    expect(next.lastSyncedHostUpdatedAt).toBe("2026-07-25T02:00:00Z");
    expect(next.lastSyncedFields.state).toBe("closed");
    // identity fields untouched
    expect(next.issueNumber).toBe(42);
    expect(next.conflicts).toBeUndefined();
  });

  it("appends conflicts to the log without dropping prior ones", () => {
    const withPrior: MirrorRecord = {
      ...record,
      conflicts: [
        { field: "title", winner: "host", localValue: "a", hostValue: "b" },
      ],
    };
    const next = advanceMirrorRecord(withPrior, {
      localRev: 9,
      hostUpdatedAt: "2026-07-25T03:00:00Z",
      fields: base,
      conflicts: [
        { field: "state", winner: "local", localValue: "open", hostValue: "closed" },
      ],
    });
    expect(next.conflicts).toHaveLength(2);
    expect(next.conflicts?.map((c) => c.field)).toEqual(["title", "state"]);
  });

  it("advancing to host fields makes the next echo diff a no-op", () => {
    // Simulate: host changed state → pull; record advances to the pulled value;
    // a re-poll with the same host state must produce zero work.
    const h = host({ state: "closed" });
    const plan = diffMirrorState(local(), h, base);
    const advanced = advanceMirrorRecord(record, {
      localRev: 5,
      hostUpdatedAt: h.updatedAt,
      fields: plan.resolvedFields,
    });
    const echo = diffMirrorState(local({ state: "closed" }), h, advanced.lastSyncedFields);
    expect(echo.toPush).toEqual({});
    expect(echo.toPull).toEqual({});
    expect(echo.conflicts).toEqual([]);
  });
});

describe("body marker", () => {
  it("builds with and without a task id", () => {
    expect(buildBodyMarker("F1", "T2")).toBe("<!-- packetbench:flight=F1;task=T2 -->");
    expect(buildBodyMarker("F1")).toBe("<!-- packetbench:flight=F1 -->");
    expect(buildBodyMarker("F1", null)).toBe("<!-- packetbench:flight=F1 -->");
  });

  it("parses flight + task, and flight-only", () => {
    expect(parseBodyMarker("body\n<!-- packetbench:flight=F1;task=T2 -->")).toEqual({
      flightId: "F1",
      taskId: "T2",
    });
    expect(parseBodyMarker("<!-- packetbench:flight=F1 -->")).toEqual({ flightId: "F1" });
  });

  it("returns null when no marker is present", () => {
    expect(parseBodyMarker("just an ordinary issue body")).toBeNull();
  });

  it("round-trips: embed then parse recovers the ids", () => {
    const body = embedBodyMarker("The issue description.", "flight-9", "task-3");
    expect(body).toContain("The issue description.");
    expect(parseBodyMarker(body)).toEqual({ flightId: "flight-9", taskId: "task-3" });
  });

  it("embed is idempotent (never duplicates the marker)", () => {
    const once = embedBodyMarker("desc", "F", "T");
    const twice = embedBodyMarker(once, "F", "T");
    expect(twice).toBe(once);
    const markerCount = (twice.match(/packetbench:flight=/g) ?? []).length;
    expect(markerCount).toBe(1);
  });

  it("re-embedding with new ids replaces the old marker", () => {
    const first = embedBodyMarker("desc", "F1", "T1");
    const second = embedBodyMarker(first, "F2", "T2");
    expect(parseBodyMarker(second)).toEqual({ flightId: "F2", taskId: "T2" });
    expect((second.match(/packetbench:flight=/g) ?? []).length).toBe(1);
  });

  it("stripBodyMarker leaves the human body intact", () => {
    expect(stripBodyMarker("hello\n\n<!-- packetbench:flight=F -->")).toBe("hello");
    expect(stripBodyMarker("no marker here")).toBe("no marker here");
  });

  it("embedding into an empty body yields just the marker", () => {
    expect(embedBodyMarker("", "F", "T")).toBe("<!-- packetbench:flight=F;task=T -->");
  });

  it("parses a flight-only marker embedded in a longer multi-line body", () => {
    const body = "## Task\n\nDo the thing.\n\nMore detail.\n\n<!-- packetbench:flight=flight-42 -->";
    expect(parseBodyMarker(body)).toEqual({ flightId: "flight-42" });
  });

  it("returns the LAST marker when a stray earlier one is present", () => {
    const body =
      "<!-- packetbench:flight=FAKE;task=TFAKE -->\nreal body\n<!-- packetbench:flight=F1;task=T1 -->";
    // The authoritative marker is the one we append at the end.
    expect(parseBodyMarker(body)).toEqual({ flightId: "F1", taskId: "T1" });
  });

  it("strips ALL markers and re-embeds exactly one (idempotent over duplicates)", () => {
    const dirty =
      "<!-- packetbench:flight=old -->\ndesc\n<!-- packetbench:flight=old2;task=t -->";
    const cleaned = embedBodyMarker(dirty, "F", "T");
    expect((cleaned.match(/packetbench:flight=/g) ?? []).length).toBe(1);
    expect(parseBodyMarker(cleaned)).toEqual({ flightId: "F", taskId: "T" });
    expect(cleaned).toContain("desc");
  });
});
