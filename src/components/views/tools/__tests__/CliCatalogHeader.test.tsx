import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CliCatalogHeader } from "../CliCatalogHeader";

const REPORT = [
  "PacketBench CLI launch resolution",
  "platform: windows",
  "",
  "claude-code | ~\\AppData\\Roaming\\npm\\claude.cmd | tier=path | version=2.1.0",
  "packetcode | D:\\tools\\packetcode.exe | tier=settings | version=packetcode v0.5.1",
].join("\n");

function renderHeader(overrides: Partial<Parameters<typeof CliCatalogHeader>[0]> = {}) {
  const props = {
    installedCount: 2,
    selectedEntry: null,
    isRescanning: false,
    onRescan: vi.fn(),
    onTest: vi.fn().mockResolvedValue({ ok: true, output: "" }),
    onCopyDiagnostics: vi.fn().mockResolvedValue(REPORT),
    ...overrides,
  };
  render(<CliCatalogHeader {...props} />);
  return props;
}

describe("CliCatalogHeader diagnostics export", () => {
  it("copies the report and shows it so the user can read what they are pasting", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    renderHeader();
    fireEvent.click(screen.getByRole("button", { name: /Copy diagnostics/ }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(REPORT));
    // Shown inline too: a block that silently vanishes into the clipboard
    // cannot be reviewed before it lands in a public issue.
    expect(await screen.findByText(/tier=path/)).toBeInTheDocument();
    expect(screen.getByText(/Copied to clipboard/)).toBeInTheDocument();
  });

  it("still shows the report when the webview refuses the clipboard", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockRejectedValue(new Error("denied")),
      },
    });

    renderHeader();
    fireEvent.click(screen.getByRole("button", { name: /Copy diagnostics/ }));

    expect(await screen.findByText(/select and copy manually/)).toBeInTheDocument();
    expect(screen.getByText(/tier=settings/)).toBeInTheDocument();
  });
});
