import { storageKey } from "@/lib/brand";

/**
 * First-run onboarding flag helpers.
 *
 * Stored in localStorage rather than the persisted UI state because the value
 * is purely per-installation UI state and routing it through the Rust DTO
 * chain would be churn for a single boolean.
 */

const KEY = storageKey("onboarding-complete");

export function isOnboardingComplete(): boolean {
  return typeof localStorage !== "undefined" && localStorage.getItem(KEY) === "true";
}

export function setOnboardingComplete(): void {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(KEY, "true");
  }
}
