import { beforeEach, describe, expect, it, vi } from "vitest";
import { storageKey } from "@/lib/brand";

const SETTINGS_KEY = storageKey("memory-settings");

async function loadStore() {
  vi.resetModules();
  return import("../memorySettingsStore");
}

describe("memorySettingsStore", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("keeps capture and learning enabled by default", async () => {
    const { useMemorySettingsStore } = await loadStore();

    expect(useMemorySettingsStore.getState()).toMatchObject({
      captureSessions: true,
      captureFlights: true,
      summarizeSessions: true,
      extractPatterns: true,
      injectIntoFlightPrompts: true,
      retentionDays: null,
      maxEvents: 200,
      maxPatterns: 20,
      patternRefreshThreshold: 3,
    });
  });

  it("persists capture and retention settings", async () => {
    const { useMemorySettingsStore } = await loadStore();

    useMemorySettingsStore.getState().setCaptureSessions(false);
    useMemorySettingsStore.getState().setRetentionDays(45);
    useMemorySettingsStore.getState().setMaxEvents(500);

    expect(useMemorySettingsStore.getState()).toMatchObject({
      captureSessions: false,
      retentionDays: 45,
      maxEvents: 500,
    });
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!)).toMatchObject({
      captureSessions: false,
      retentionDays: 45,
      maxEvents: 500,
    });
  });

  it("clamps numeric settings on hydrate", async () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        retentionDays: 99999,
        maxEvents: 1,
        maxPatterns: 999,
        patternRefreshThreshold: 0,
        contextMaxPatterns: -5,
      }),
    );

    const { useMemorySettingsStore } = await loadStore();

    expect(useMemorySettingsStore.getState()).toMatchObject({
      retentionDays: 3650,
      maxEvents: 20,
      maxPatterns: 100,
      patternRefreshThreshold: 1,
      contextMaxPatterns: 0,
    });
  });
});
