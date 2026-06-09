import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LEGACY_STORAGE_PREFIX, storageKey } from "@/lib/brand";

const mocks = vi.hoisted(() => ({
  getApiKeyExists: vi.fn(),
  setApiKey: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  getApiKeyExists: mocks.getApiKeyExists,
  setApiKey: mocks.setApiKey,
}));

import { GeminiApiKeyCard } from "@/components/views/tools/GeminiApiKeyCard";

const GEMINI_API_KEY_STORAGE_KEY = storageKey("gemini-api-key");
const LEGACY_GEMINI_API_KEY_STORAGE_KEY = `${LEGACY_STORAGE_PREFIX}gemini-api-key`;

describe("GeminiApiKeyCard localStorage migration", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.getApiKeyExists.mockResolvedValue(false);
    mocks.setApiKey.mockResolvedValue(undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("removes localStorage keys only after a successful keyring write", async () => {
    localStorage.setItem(GEMINI_API_KEY_STORAGE_KEY, " current-key ");
    localStorage.setItem(LEGACY_GEMINI_API_KEY_STORAGE_KEY, "legacy-key");
    mocks.getApiKeyExists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    render(<GeminiApiKeyCard />);

    await waitFor(() => {
      expect(mocks.setApiKey).toHaveBeenCalledWith("gemini", "current-key");
    });
    await waitFor(() => {
      expect(screen.getByText("Configured")).toBeInTheDocument();
    });

    expect(localStorage.getItem(GEMINI_API_KEY_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_GEMINI_API_KEY_STORAGE_KEY)).toBeNull();
  });

  it("does not overwrite an existing keyring key with stale localStorage", async () => {
    localStorage.setItem(GEMINI_API_KEY_STORAGE_KEY, "stale-key");
    mocks.getApiKeyExists.mockResolvedValue(true);

    render(<GeminiApiKeyCard />);

    await waitFor(() => {
      expect(mocks.getApiKeyExists).toHaveBeenCalledWith("gemini");
    });
    await waitFor(() => {
      expect(screen.getByText("Configured")).toBeInTheDocument();
    });

    expect(mocks.setApiKey).not.toHaveBeenCalled();
    expect(localStorage.getItem(GEMINI_API_KEY_STORAGE_KEY)).toBeNull();
  });

  it("keeps current and legacy localStorage keys when keyring write fails", async () => {
    localStorage.setItem(GEMINI_API_KEY_STORAGE_KEY, "current-key");
    localStorage.setItem(LEGACY_GEMINI_API_KEY_STORAGE_KEY, "legacy-key");
    mocks.setApiKey.mockRejectedValue(new Error("keyring unavailable"));

    render(<GeminiApiKeyCard />);

    await waitFor(() => {
      expect(mocks.setApiKey).toHaveBeenCalledWith("gemini", "current-key");
    });
    await waitFor(() => {
      expect(mocks.getApiKeyExists).toHaveBeenCalledWith("gemini");
    });

    expect(localStorage.getItem(GEMINI_API_KEY_STORAGE_KEY)).toBe("current-key");
    expect(localStorage.getItem(LEGACY_GEMINI_API_KEY_STORAGE_KEY)).toBe("legacy-key");
    expect(screen.getByText("Not configured")).toBeInTheDocument();
  });
});
