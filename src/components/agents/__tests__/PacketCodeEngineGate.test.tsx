/**
 * The PacketCode engine gate.
 *
 * What these cases pin down is the honesty of the surface, not its markup:
 *
 * - the gate never claims "not installed" before the probe has answered;
 * - a ready engine costs the route nothing — no wrapper, no chrome;
 * - an install NEVER starts without a click, because the command behind it
 *   downloads and runs a remote script;
 * - the "engine is running" refusal — the one failure a user can actually fix
 *   — is translated, and the raw backend sentence is withheld;
 * - the output listener is attached once per attempt and detached on both
 *   completion and unmount.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20_000 });

const harness = vi.hoisted(() => ({
  acpProbe: vi.fn(),
  acpInstallEngine: vi.fn(),
  getAcpEnginePath: vi.fn(),
  setAcpEnginePath: vi.fn(),
  openFileDialog: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  /** Handlers currently registered for the install-output event. */
  outputHandlers: [] as ((event: { payload: unknown }) => void)[],
}));

// Whole-module factory: the real `@/lib/tauri` drags in the workspace and
// flight graphs, none of which this component touches.
vi.mock("@/lib/tauri", () => ({
  acpProbe: harness.acpProbe,
  acpInstallEngine: harness.acpInstallEngine,
  getAcpEnginePath: harness.getAcpEnginePath,
  setAcpEnginePath: harness.setAcpEnginePath,
  ACP_INSTALL_OUTPUT_EVENT: "acp:install-output",
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: harness.listen,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: harness.openFileDialog,
}));

import { PacketCodeEngineGate } from "@/components/agents/PacketCodeEngineGate";
import {
  classifyInstallFailure,
  engineGateState,
  resetEngineProbeCache,
} from "@/components/agents/engineGateState";
import type { AcpEngineProbe } from "@/lib/tauri";

const READY: AcpEngineProbe = {
  found: true,
  path: "C:\\Users\\dev\\.local\\bin\\packetcode.exe",
  version: "0.9.0",
  status: "ok",
  minimumVersion: "0.8.0",
  compatible: true,
  installSupported: true,
};

const MISSING: AcpEngineProbe = {
  found: false,
  minimumVersion: "0.8.0",
  compatible: false,
  installSupported: true,
};

const TOO_OLD: AcpEngineProbe = {
  found: true,
  path: "/home/dev/.local/bin/packetcode",
  version: "0.6.1",
  status: "ok",
  minimumVersion: "0.8.0",
  compatible: false,
  installSupported: true,
};

/**
 * A binary that exists and ran, but never said what version it is — what the
 * backend produces when `doctor --json` times out, and what it would produce
 * for a doctor report with no version field.
 *
 * `compatible: false` here is the backend declining to vouch for a version it
 * never saw. Reading that as "too old" would send the user to update a binary
 * that may be perfectly current, or not the engine at all.
 */
const UNRESPONSIVE: AcpEngineProbe = {
  found: true,
  path: "D:\\projects\\packetcode\\packetcode.exe",
  minimumVersion: "0.8.0",
  compatible: false,
  installSupported: true,
  detail: "doctor --json timed out",
};

/** Verbatim copy of `acp::install::MANUAL_INSTALL_HINT`. */
const MANUAL_HINT =
  "PacketBench cannot install the packetcode engine on this platform. Install it yourself " +
  "(see the packetcode README), then either point PacketBench at the binary in the field " +
  "below (or Settings → Provider Endpoints), put `packetcode` on PATH, or set " +
  "PACKETBENCH_ACP_ENGINE to its full path.";

const UNSUPPORTED: AcpEngineProbe = {
  found: false,
  minimumVersion: "0.8.0",
  compatible: false,
  installSupported: false,
  detail: MANUAL_HINT,
};

/** The backend's verbatim refusal when the engine is live. */
const ENGINE_RUNNING_ERROR =
  "Stop the packetcode engine before installing: its executable is in use.";

function child() {
  return <div data-testid="agents-view">agents view</div>;
}

/** Emit one installer line to every handler `listen` handed out. */
function emit(line: string, stream: "stdout" | "stderr") {
  act(() => {
    for (const handler of harness.outputHandlers) handler({ payload: { line, stream } });
  });
}

beforeEach(() => {
  resetEngineProbeCache();
  harness.outputHandlers = [];
  harness.acpProbe.mockReset();
  harness.acpInstallEngine.mockReset();
  harness.getAcpEnginePath.mockReset();
  harness.getAcpEnginePath.mockResolvedValue(null);
  harness.setAcpEnginePath.mockReset();
  harness.openFileDialog.mockReset();
  harness.unlisten.mockReset();
  harness.listen.mockReset();
  harness.listen.mockImplementation(
    async (_event: string, handler: (event: { payload: unknown }) => void) => {
      harness.outputHandlers.push(handler);
      return harness.unlisten;
    },
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("engineGateState", () => {
  it("maps every probe shape onto exactly one state", () => {
    expect(engineGateState(READY)).toBe("ready");
    expect(engineGateState(MISSING)).toBe("missing");
    expect(engineGateState(TOO_OLD)).toBe("incompatible");
    // `compatible` is meaningless without `found` — a backend that ever sent
    // both must still read as missing, not as ready.
    expect(engineGateState({ ...MISSING, compatible: true })).toBe("missing");
  });

  it("refuses to call a version-less engine 'too old'", () => {
    // The distinction the whole state exists for: `compatible: false` with no
    // version is the backend saying "I could not check", not "it is old".
    expect(engineGateState(UNRESPONSIVE)).toBe("unresponsive");
    expect(engineGateState({ ...UNRESPONSIVE, version: "" })).toBe("unresponsive");
    expect(engineGateState({ ...UNRESPONSIVE, version: "   " })).toBe("unresponsive");
    // A real version is what licenses the "too old" claim.
    expect(engineGateState({ ...UNRESPONSIVE, version: "0.6.1" })).toBe("incompatible");
  });
});

describe("state 1 — engine ready", () => {
  it("renders the view with no gate chrome and no wrapper element", async () => {
    harness.acpProbe.mockResolvedValue(READY);
    const { container } = render(<PacketCodeEngineGate>{child()}</PacketCodeEngineGate>);

    await screen.findByTestId("agents-view");

    // No headline, no install control, no installer log.
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("log")).toBeNull();
    expect(screen.queryByText(/packetcode is not installed/i)).toBeNull();
    // The child is the root: the happy path pays nothing for the gate.
    expect(container.firstChild).toBe(screen.getByTestId("agents-view"));
  });

  it("never installs on mount", async () => {
    harness.acpProbe.mockResolvedValue(MISSING);
    render(<PacketCodeEngineGate>{child()}</PacketCodeEngineGate>);

    await screen.findByText(/packetcode is not installed/i);
    expect(harness.acpInstallEngine).not.toHaveBeenCalled();
    expect(harness.listen).not.toHaveBeenCalled();
  });

  it("shows a neutral placeholder, not a gate, while the first probe is in flight", async () => {
    let settle: (probe: AcpEngineProbe) => void = () => {};
    harness.acpProbe.mockImplementation(
      () =>
        new Promise<AcpEngineProbe>((resolve) => {
          settle = resolve;
        }),
    );

    render(<PacketCodeEngineGate>{child()}</PacketCodeEngineGate>);

    expect(screen.getByRole("status")).toHaveTextContent(/checking for the packetcode engine/i);
    expect(screen.queryByText(/not installed/i)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();

    await act(async () => {
      settle(READY);
    });
    await screen.findByTestId("agents-view");
  });
});

describe("state 2 — engine missing", () => {
  it("explains what packetcode is and offers an install", async () => {
    harness.acpProbe.mockResolvedValue(MISSING);
    render(<PacketCodeEngineGate>{child()}</PacketCodeEngineGate>);

    await screen.findByText(/packetcode is not installed/i);
    expect(screen.getByText(/agent client protocol/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /install packetcode/i })).toBeEnabled();
    // Its cost is stated up front — this runs for minutes, not milliseconds.
    expect(screen.getByText(/several minutes/i)).toBeInTheDocument();
    expect(screen.queryByTestId("agents-view")).toBeNull();
  });
});

describe("state 3 — engine too old", () => {
  it("shows the found version and the minimum, and offers the upgrade", async () => {
    harness.acpProbe.mockResolvedValue(TOO_OLD);
    render(<PacketCodeEngineGate>{child()}</PacketCodeEngineGate>);

    await screen.findByText(/packetcode is too old/i);
    expect(screen.getByText("0.6.1")).toBeInTheDocument();
    expect(screen.getByText("0.8.0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /update packetcode/i })).toBeEnabled();
    expect(screen.queryByTestId("agents-view")).toBeNull();
  });
});

describe("state 3b — engine found but silent", () => {
  it("says it did not answer, and never claims it is out of date", async () => {
    harness.acpProbe.mockResolvedValue(UNRESPONSIVE);
    render(<PacketCodeEngineGate>{child()}</PacketCodeEngineGate>);

    await screen.findByText(/packetcode did not answer/i);
    // The lie this state exists to prevent.
    expect(screen.queryByText(/too old/i)).toBeNull();
    expect(screen.queryByText(/0\.8\.0/)).toBeNull();
    expect(screen.getByText(/did not report a version/i)).toBeInTheDocument();
    // The path that failed is named, because that is the thing to check.
    expect(screen.getByText("D:\\projects\\packetcode\\packetcode.exe")).toBeInTheDocument();
    // "Update" would be the wrong verb for a binary of unknown vintage.
    expect(screen.queryByRole("button", { name: /update packetcode/i })).toBeNull();
    expect(screen.getByRole("button", { name: /reinstall packetcode/i })).toBeEnabled();
  });
});

describe("state 4 — install unsupported", () => {
  it("shows the probe's manual instructions and no install button", async () => {
    harness.acpProbe.mockResolvedValue(UNSUPPORTED);
    render(<PacketCodeEngineGate>{child()}</PacketCodeEngineGate>);

    await screen.findByText(/packetcode is not installed/i);
    expect(screen.getByText(MANUAL_HINT)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /install packetcode/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /update packetcode/i })).toBeNull();
    // The only control left is the manual re-check.
    expect(screen.getByRole("button", { name: /check again/i })).toBeEnabled();
  });
});

/**
 * The remedy for the most common failure, which is NOT "the engine is
 * missing" — it is "the engine is installed somewhere nothing searches".
 * packetcode's own installers do not add it to PATH, and a build from source
 * is not on PATH either, so the gate has to offer something other than
 * downloading a second copy.
 */
describe("pointing at an existing binary", () => {
  const PINNED = "D:\\projects\\packetcode\\packetcode.exe";

  it("offers the path field on every non-ready state, including where install is unsupported", async () => {
    for (const probe of [MISSING, TOO_OLD, UNRESPONSIVE, UNSUPPORTED]) {
      harness.acpProbe.mockResolvedValue(probe);
      const view = render(<PacketCodeEngineGate>{child()}</PacketCodeEngineGate>);
      expect(await screen.findByLabelText(/packetcode engine binary/i)).toBeInTheDocument();
      view.unmount();
      resetEngineProbeCache();
    }
  });

  it("pins a browsed path and drops through to the route on a ready probe", async () => {
    harness.acpProbe.mockResolvedValue(MISSING);
    harness.openFileDialog.mockResolvedValue(PINNED);
    harness.setAcpEnginePath.mockResolvedValue({ ...READY, path: PINNED, version: "0.5.1" });

    render(<PacketCodeEngineGate>{child()}</PacketCodeEngineGate>);
    await screen.findByText(/packetcode is not installed/i);

    fireEvent.click(screen.getByTitle(/browse for the packetcode binary/i));
    await waitFor(() =>
      expect(screen.getByLabelText(/packetcode engine binary/i)).toHaveValue(PINNED),
    );

    fireEvent.click(screen.getByTitle(/use this binary/i));

    await screen.findByTestId("agents-view");
    expect(harness.setAcpEnginePath).toHaveBeenCalledWith(PINNED);
    // Adopting the returned probe means no second probe and no install.
    expect(harness.acpProbe).toHaveBeenCalledTimes(1);
    expect(harness.acpInstallEngine).not.toHaveBeenCalled();
  });

  it("shows the backend's rejection and keeps the gate up when the path is bad", async () => {
    harness.acpProbe.mockResolvedValue(MISSING);
    harness.setAcpEnginePath.mockRejectedValue(
      "Cannot read D:\\nope\\packetcode.exe: The system cannot find the path specified.",
    );

    render(<PacketCodeEngineGate>{child()}</PacketCodeEngineGate>);
    await screen.findByText(/packetcode is not installed/i);

    const field = screen.getByLabelText(/packetcode engine binary/i);
    fireEvent.change(field, { target: { value: "D:\\nope\\packetcode.exe" } });
    fireEvent.click(screen.getByTitle(/use this binary/i));

    await screen.findByText(/cannot find the path specified/i);
    // Nothing was saved, so the gate is still the gate.
    expect(screen.getByText(/packetcode is not installed/i)).toBeInTheDocument();
    expect(screen.queryByTestId("agents-view")).toBeNull();
  });

  it("reports a file that saved but is not a usable engine instead of claiming success", async () => {
    harness.acpProbe.mockResolvedValue(MISSING);
    harness.setAcpEnginePath.mockResolvedValue(UNRESPONSIVE);

    render(<PacketCodeEngineGate>{child()}</PacketCodeEngineGate>);
    await screen.findByText(/packetcode is not installed/i);

    fireEvent.change(screen.getByLabelText(/packetcode engine binary/i), {
      target: { value: PINNED },
    });
    fireEvent.click(screen.getByTitle(/use this binary/i));

    // The save succeeded; the engine did not. Saying "Saved" and stopping
    // there would be the same over-claim the gate exists to remove. (Two
    // matches: the field's own verdict, and the gate re-rendered onto the
    // adopted probe.)
    await screen.findByText(
      /that file ran but did not report a version, so it may not be a packetcode engine/i,
    );
    await screen.findByText(/packetcode did not answer/i);
    expect(screen.queryByTestId("agents-view")).toBeNull();
  });

  it("shows the resolved version, which is the only proof it picked the engine", async () => {
    harness.acpProbe.mockResolvedValue(UNSUPPORTED);
    harness.setAcpEnginePath.mockResolvedValue({ ...READY, path: PINNED, version: "0.5.1" });

    render(<PacketCodeEngineGate>{child()}</PacketCodeEngineGate>);
    await screen.findByText(/packetcode is not installed/i);

    fireEvent.change(screen.getByLabelText(/packetcode engine binary/i), {
      target: { value: PINNED },
    });
    fireEvent.click(screen.getByTitle(/use this binary/i));

    await screen.findByTestId("agents-view");
    expect(harness.setAcpEnginePath).toHaveBeenCalledWith(PINNED);
  });

  it("loads an already-pinned path so the user can see and clear it", async () => {
    harness.acpProbe.mockResolvedValue(UNRESPONSIVE);
    harness.getAcpEnginePath.mockResolvedValue(PINNED);
    harness.setAcpEnginePath.mockResolvedValue(MISSING);

    render(<PacketCodeEngineGate>{child()}</PacketCodeEngineGate>);
    const field = await screen.findByLabelText(/packetcode engine binary/i);
    await waitFor(() => expect(field).toHaveValue(PINNED));
    expect(screen.getByText(/^Pinned$/)).toBeInTheDocument();

    fireEvent.click(screen.getByTitle(/clear the pinned path/i));
    await waitFor(() => expect(harness.setAcpEnginePath).toHaveBeenCalledWith(null));
    await waitFor(() => expect(field).toHaveValue(""));
  });
});

describe("manual re-probe", () => {
  it("lets an engine installed outside PacketBench through without a restart", async () => {
    harness.acpProbe.mockResolvedValueOnce(MISSING).mockResolvedValueOnce(READY);
    render(<PacketCodeEngineGate>{child()}</PacketCodeEngineGate>);

    await screen.findByText(/packetcode is not installed/i);
    fireEvent.click(screen.getByRole("button", { name: /check again/i }));

    await screen.findByTestId("agents-view");
    expect(harness.acpProbe).toHaveBeenCalledTimes(2);
    expect(harness.acpInstallEngine).not.toHaveBeenCalled();
  });
});

describe("install streaming and listener lifecycle", () => {
  it("streams output, distinguishes stderr, and detaches on completion", async () => {
    harness.acpProbe.mockResolvedValue(MISSING);
    let finish: (probe: AcpEngineProbe) => void = () => {};
    harness.acpInstallEngine.mockImplementation(
      () =>
        new Promise<AcpEngineProbe>((resolve) => {
          finish = resolve;
        }),
    );

    render(<PacketCodeEngineGate>{child()}</PacketCodeEngineGate>);
    await screen.findByText(/packetcode is not installed/i);

    fireEvent.click(screen.getByRole("button", { name: /install packetcode/i }));

    // The subscription is opened before the invoke, so the installer's first
    // line cannot be lost to the `listen()` round trip.
    await waitFor(() => expect(harness.listen).toHaveBeenCalledTimes(1));
    expect(harness.listen.mock.calls[0][0]).toBe("acp:install-output");

    // Disabled and self-describing for the whole run.
    expect(screen.getByRole("button", { name: /installing/i })).toBeDisabled();

    emit("Downloading packetcode 0.9.0…", "stdout");
    emit("WARNING: overwriting an existing install", "stderr");

    const log = screen.getByRole("log");
    expect(log).toHaveTextContent("Downloading packetcode 0.9.0…");
    const stderrLine = screen.getByText(/overwriting an existing install/);
    expect(stderrLine).toHaveAttribute("data-stream", "stderr");
    expect(screen.getByText(/Downloading packetcode/)).toHaveAttribute("data-stream", "stdout");
    // The two streams are styled apart, not merged into one blob.
    expect(stderrLine.className).not.toBe(screen.getByText(/Downloading packetcode/).className);

    expect(harness.unlisten).not.toHaveBeenCalled();

    // The command resolves with a probe already gated on found && compatible.
    await act(async () => {
      finish(READY);
    });

    await screen.findByTestId("agents-view");
    expect(harness.acpProbe).toHaveBeenCalledTimes(1); // no second round trip
    expect(harness.unlisten).toHaveBeenCalledTimes(1);
  });

  it("detaches the listener when the route unmounts mid-install", async () => {
    harness.acpProbe.mockResolvedValue(MISSING);
    harness.acpInstallEngine.mockImplementation(() => new Promise<AcpEngineProbe>(() => {}));

    const view = render(<PacketCodeEngineGate>{child()}</PacketCodeEngineGate>);
    await screen.findByText(/packetcode is not installed/i);
    fireEvent.click(screen.getByRole("button", { name: /install packetcode/i }));
    await waitFor(() => expect(harness.listen).toHaveBeenCalledTimes(1));

    view.unmount();
    expect(harness.unlisten).toHaveBeenCalledTimes(1);
  });
});

describe("install failures", () => {
  it("translates the already-running refusal instead of showing the backend string", async () => {
    harness.acpProbe.mockResolvedValue(TOO_OLD);
    harness.acpInstallEngine.mockRejectedValue(ENGINE_RUNNING_ERROR);

    render(<PacketCodeEngineGate>{child()}</PacketCodeEngineGate>);
    await screen.findByText(/packetcode is too old/i);
    fireEvent.click(screen.getByRole("button", { name: /update packetcode/i }));

    await screen.findByText(/the engine is currently running/i);
    expect(screen.getByText(/close or stop any packetcode conversations/i)).toBeInTheDocument();
    // The raw sentence is not what the user is asked to act on.
    expect(screen.queryByText(ENGINE_RUNNING_ERROR)).toBeNull();
    expect(screen.queryByText(/executable is in use/i)).toBeNull();

    // Retryable: the button comes back enabled and relabelled.
    const retry = await screen.findByRole("button", { name: /retry install/i });
    expect(retry).toBeEnabled();
  });

  it("shows an unrecognised failure verbatim and allows a retry", async () => {
    harness.acpProbe.mockResolvedValue(MISSING);
    harness.acpInstallEngine
      .mockRejectedValueOnce("installer exited with exit status: 1")
      .mockResolvedValueOnce(READY);

    render(<PacketCodeEngineGate>{child()}</PacketCodeEngineGate>);
    await screen.findByText(/packetcode is not installed/i);
    fireEvent.click(screen.getByRole("button", { name: /install packetcode/i }));

    await screen.findByText("installer exited with exit status: 1");
    expect(harness.unlisten).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /retry install/i }));
    await screen.findByTestId("agents-view");
    expect(harness.acpInstallEngine).toHaveBeenCalledTimes(2);
    expect(harness.unlisten).toHaveBeenCalledTimes(2);
  });
});

describe("classifyInstallFailure", () => {
  it("recognises the engine-running refusal from either half of the sentence", () => {
    expect(classifyInstallFailure(ENGINE_RUNNING_ERROR).kind).toBe("engineRunning");
    expect(classifyInstallFailure("its executable is in use").kind).toBe("engineRunning");
    expect(classifyInstallFailure(new Error(ENGINE_RUNNING_ERROR)).kind).toBe("engineRunning");
  });

  it("separates the concurrent-install guard, the timeout, and everything else", () => {
    expect(classifyInstallFailure("An engine install is already running.").kind).toBe(
      "installInProgress",
    );
    expect(classifyInstallFailure("installer timed out").kind).toBe("timedOut");
    const other = classifyInstallFailure("failed to launch the installer (powershell): nope");
    expect(other.kind).toBe("unknown");
    expect(other.raw).toContain("powershell");
  });
});

describe("probe failure", () => {
  it("reports a failed probe without pretending the engine is missing", async () => {
    harness.acpProbe.mockRejectedValueOnce("engine resolution blew up");
    render(<PacketCodeEngineGate>{child()}</PacketCodeEngineGate>);

    await screen.findByText(/could not check for the packetcode engine/i);
    expect(screen.getByText("engine resolution blew up")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /install packetcode/i })).toBeNull();
    expect(screen.queryByTestId("agents-view")).toBeNull();
  });
});
