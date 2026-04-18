import { describe, it, expect, beforeEach } from "vitest";
import { useProjectHistoryStore } from "../projectHistoryStore";

const STORAGE_KEY = "packetade:project-history";
const store = () => useProjectHistoryStore.getState();

describe("projectHistoryStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useProjectHistoryStore.setState({ projects: [] });
  });

  it("recordOpen adds a new project to the front", () => {
    store().recordOpen("/a");
    store().recordOpen("/b");
    expect(store().projects.map((p) => p.path)).toEqual(["/b", "/a"]);
  });

  it("recordOpen moves an existing project to the front", () => {
    store().recordOpen("/a");
    store().recordOpen("/b");
    store().recordOpen("/a");
    expect(store().projects.map((p) => p.path)).toEqual(["/a", "/b"]);
    expect(store().projects).toHaveLength(2);
  });

  it("recordOpen sets lastOpened timestamp", () => {
    const before = Date.now();
    store().recordOpen("/a");
    expect(store().projects[0].lastOpened).toBeGreaterThanOrEqual(before);
  });

  it("recordOpen ignores empty path", () => {
    store().recordOpen("");
    expect(store().projects).toHaveLength(0);
  });

  it("recordOpen persists to localStorage", () => {
    store().recordOpen("/a");
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(raw).toHaveLength(1);
    expect(raw[0].path).toBe("/a");
  });

  it("removeProject removes a project by path", () => {
    store().recordOpen("/a");
    store().recordOpen("/b");
    store().removeProject("/a");
    expect(store().projects.map((p) => p.path)).toEqual(["/b"]);
  });

  it("removeProject is a no-op for unknown path", () => {
    store().recordOpen("/a");
    expect(() => store().removeProject("/nope")).not.toThrow();
    expect(store().projects).toHaveLength(1);
  });

  it("removeProject persists to localStorage", () => {
    store().recordOpen("/a");
    store().removeProject("/a");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual([]);
  });
});
