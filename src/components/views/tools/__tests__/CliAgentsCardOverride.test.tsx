import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { CliCatalogCard } from "../CliAgentsCard";
import type { CliCatalogEntry } from "@/lib/cli-catalog";

/**
 * Audit F27.
 *
 * The ✕ that clears a manual path override used to render only when the CLI
 * read as installed. A pin at a path that no longer exists is exactly what
 * makes a CLI read as NOT installed, so the control was hidden precisely when
 * it was the only thing that would help: the pin became unclearable from the
 * card that displayed it.
 *
 * Found on a real machine — a packetcode pin at a deleted
 * `PacketBench-0.11.0-portable` path, where the binary itself resolved on PATH
 * and answered `--version` perfectly well.
 */
const ENTRY: CliCatalogEntry = {
  id: "packetcode",
  name: "PacketCode",
  binary: "packetcode",
  iconName: "Terminal",
  color: "green",
};

function renderCard(overrides: Partial<Parameters<typeof CliCatalogCard>[0]> = {}) {
  const onClearOverride = vi.fn();
  render(
    <CliCatalogCard
      entry={ENTRY}
      result={undefined}
      selected={false}
      detecting={false}
      installing={false}
      manualPath={String.raw`C:\Users\me\Desktop\gone\packetcode.exe`}
      onSelect={vi.fn()}
      onInstall={vi.fn()}
      onBrowse={vi.fn()}
      onClearOverride={onClearOverride}
      {...overrides}
    />,
  );
  return { onClearOverride };
}

describe("CliCatalogCard manual-path override", () => {
  it("offers the clear control even when the CLI reads as not installed", () => {
    // `result: undefined` is the not-installed case — the exact state a broken
    // pin produces.
    const { onClearOverride } = renderCard();

    fireEvent.click(screen.getByTitle("Clear manual path override"));

    expect(onClearOverride).toHaveBeenCalledTimes(1);
  });

  it("still shows the pinned path so the user can see what is wrong", () => {
    renderCard();
    expect(screen.getByText(/Override:/)).toBeInTheDocument();
  });

  it("shows nothing to clear when no override is pinned", () => {
    renderCard({ manualPath: null });
    expect(screen.queryByTitle("Clear manual path override")).toBeNull();
  });
});
