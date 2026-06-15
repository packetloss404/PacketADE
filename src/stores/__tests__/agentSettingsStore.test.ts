import { beforeEach, describe, expect, it, vi } from "vitest";
import { storageKey } from "@/lib/brand";

const SETTINGS_KEY = storageKey("agent-settings");
const COMPOSER_MODE_KEY = storageKey("composer-mode");
const RAIL_COLLAPSED_KEY = storageKey("agent-tabbed-rail-collapsed");
const ONBOARDING_DISMISSED_KEY = storageKey("agents-onboarding-dismissed");

async function loadStore() {
  vi.resetModules();
  return import("../agentSettingsStore");
}

describe("agentSettingsStore", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("hydrates existing Agents UI preference keys", async () => {
    localStorage.setItem(COMPOSER_MODE_KEY, "worktree");
    localStorage.setItem(RAIL_COLLAPSED_KEY, "1");
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "1");

    const { useAgentSettingsStore } = await loadStore();

    expect(useAgentSettingsStore.getState()).toMatchObject({
      composerMode: "worktree",
      railCollapsed: true,
      onboardingDismissed: true,
      autoArchiveDays: 14,
      autoFailoverEnabled: true,
    });
  });

  it("persists Agents UI preferences back to the existing keys", async () => {
    const { useAgentSettingsStore } = await loadStore();
    const store = useAgentSettingsStore.getState();

    store.setComposerMode("worktree");
    store.setRailCollapsed(true);
    store.dismissOnboarding();

    expect(localStorage.getItem(COMPOSER_MODE_KEY)).toBe("worktree");
    expect(localStorage.getItem(RAIL_COLLAPSED_KEY)).toBe("1");
    expect(localStorage.getItem(ONBOARDING_DISMISSED_KEY)).toBe("1");
  });

  it("keeps the current 14 day auto-archive default and allows off", async () => {
    const {
      DEFAULT_AGENT_AUTO_ARCHIVE_DAYS,
      getAgentAutoArchiveIdleMs,
      useAgentSettingsStore,
    } = await loadStore();

    expect(useAgentSettingsStore.getState().autoArchiveDays).toBe(
      DEFAULT_AGENT_AUTO_ARCHIVE_DAYS,
    );
    expect(getAgentAutoArchiveIdleMs()).toBe(
      DEFAULT_AGENT_AUTO_ARCHIVE_DAYS * 24 * 60 * 60 * 1000,
    );

    useAgentSettingsStore.getState().setAutoArchiveDays(null);

    expect(useAgentSettingsStore.getState().autoArchiveDays).toBeNull();
    expect(getAgentAutoArchiveIdleMs()).toBeNull();
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).autoArchiveDays).toBeNull();
  });

  it("keeps automatic failover enabled by default and persists changes", async () => {
    const { useAgentSettingsStore } = await loadStore();

    expect(useAgentSettingsStore.getState().autoFailoverEnabled).toBe(true);

    useAgentSettingsStore.getState().setAutoFailoverEnabled(false);

    expect(useAgentSettingsStore.getState().autoFailoverEnabled).toBe(false);
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).autoFailoverEnabled).toBe(false);
  });
});
