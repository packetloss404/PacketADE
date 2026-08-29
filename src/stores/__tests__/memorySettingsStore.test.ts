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

  // `contextMaxNotes` was `MAX_CONTEXT_PROJECT_NOTES = 5`, a constant in
  // `memoryStore.ts`, while its three brief-budget siblings were settings.
  // Promoting it must not move the shipped ceiling.
  it("defaults the project-note brief cap to the previously hardcoded 5", async () => {
    const { useMemorySettingsStore, DEFAULT_MEMORY_CONTEXT_MAX_NOTES } = await loadStore();

    expect(DEFAULT_MEMORY_CONTEXT_MAX_NOTES).toBe(5);
    expect(useMemorySettingsStore.getState().contextMaxNotes).toBe(5);
  });

  it("persists and clamps the project-note brief cap like its siblings", async () => {
    const { useMemorySettingsStore } = await loadStore();

    useMemorySettingsStore.getState().setContextMaxNotes(12);
    expect(useMemorySettingsStore.getState().contextMaxNotes).toBe(12);
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!)).toMatchObject({
      contextMaxNotes: 12,
    });

    // 0 is a real value ("keep notes out of the brief"), 99 is not.
    useMemorySettingsStore.getState().setContextMaxNotes(0);
    expect(useMemorySettingsStore.getState().contextMaxNotes).toBe(0);
    useMemorySettingsStore.getState().setContextMaxNotes(99);
    expect(useMemorySettingsStore.getState().contextMaxNotes).toBe(50);
  });

  it("gives a settings blob written before the cap existed the shipped default", async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ contextMaxPatterns: 3 }));

    const { useMemorySettingsStore } = await loadStore();

    expect(useMemorySettingsStore.getState().contextMaxNotes).toBe(5);
  });

  // The brief's character ceiling was a constant behind an `options.maxChars`
  // override no caller passed, so it was the real limit on every injected
  // brief with no way to move it.
  it("defaults the brief character budget to the previously hardcoded 1800", async () => {
    const { useMemorySettingsStore, DEFAULT_MEMORY_BRIEF_MAX_CHARS } = await loadStore();

    expect(DEFAULT_MEMORY_BRIEF_MAX_CHARS).toBe(1800);
    expect(useMemorySettingsStore.getState().briefMaxChars).toBe(1800);
  });

  it("clamps the brief character budget to the bounds the store already enforced", async () => {
    const { useMemorySettingsStore } = await loadStore();

    useMemorySettingsStore.getState().setBriefMaxChars(1);
    expect(useMemorySettingsStore.getState().briefMaxChars).toBe(400);
    useMemorySettingsStore.getState().setBriefMaxChars(99_999);
    expect(useMemorySettingsStore.getState().briefMaxChars).toBe(4000);
    useMemorySettingsStore.getState().setBriefMaxChars(2500);
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!)).toMatchObject({
      briefMaxChars: 2500,
    });
  });
});
