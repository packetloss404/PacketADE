import { storageKey } from "@/lib/brand";

export const SYNDICATE_INTEGRATION_ENABLED_KEY = storageKey("syndicate-integration-enabled-v1");

export const SYNDICATE_INTEGRATION_DISABLED_MESSAGE =
  "Syndicate integration is disabled in Settings.";

/**
 * Syndicate shipped enabled before this preference existed. Defaulting to
 * enabled preserves paired machines and existing Workspace behavior; the user
 * can now explicitly pause every PacketADE-owned transport and operation.
 */
function readSyndicateIntegrationEnabled(): boolean {
  if (typeof localStorage === "undefined") return true;
  try {
    const raw = localStorage.getItem(SYNDICATE_INTEGRATION_ENABLED_KEY);
    if (raw === null) return true;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "boolean" ? parsed : true;
  } catch {
    return true;
  }
}

let runtimeEnabled = readSyndicateIntegrationEnabled();

export function loadSyndicateIntegrationEnabled(): boolean {
  return runtimeEnabled;
}

export function persistSyndicateIntegrationEnabled(enabled: boolean): void {
  runtimeEnabled = enabled;
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(SYNDICATE_INTEGRATION_ENABLED_KEY, JSON.stringify(enabled));
  } catch {
    // Runtime state remains authoritative for this launch if storage is unavailable.
  }
}

export function assertSyndicateIntegrationEnabled(): void {
  if (!loadSyndicateIntegrationEnabled()) {
    throw new Error(SYNDICATE_INTEGRATION_DISABLED_MESSAGE);
  }
}
