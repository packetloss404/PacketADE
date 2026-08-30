// Rotating a token / renaming a connection in place.
//
// The property every test here circles: a replacement credential that does not
// verify must not be handed to the save path at all. (The *authoritative*
// guarantee lives in Rust — `update_connection_inner` probes again before it
// writes — but the UI must not even offer to save a red verdict, and must never
// let a verdict earned by one token authorise a different one.)

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GitHostProbeResult } from "@/lib/gitHostProbe";
import type { GitHostConnectionInfo, GitHostConnectionUpdate } from "@/lib/tauri";
import { GitHostEditConnectionModal } from "@/components/gitHost/GitHostEditConnectionModal";

/** Greppable across the whole rendered tree — see `leakCheck` below. */
const SECRET = "glpat_CANARY_must_never_leak_0000";

const mocks = vi.hoisted(() => ({
  probe: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@/lib/gitHostProbe", () => ({
  probeGitHostCredential: (...args: unknown[]) => mocks.probe(...args),
  // The descriptor module imports this for the browser-authorisation path.
  // Rotation never uses it; it must exist for the module to load.
  probePendingDeviceCredential: vi.fn(),
}));

const GITLAB: GitHostConnectionInfo = {
  id: "gitlab-gitlab-com",
  kind: "gitlab",
  baseUrl: "https://gitlab.com",
  label: "Work GitLab",
  hasToken: true,
};

const GITHUB: GitHostConnectionInfo = {
  id: "github",
  kind: "github",
  baseUrl: "https://api.github.com",
  label: "GitHub",
  hasToken: true,
};

function probeResult(overrides: Partial<GitHostProbeResult> = {}): GitHostProbeResult {
  return {
    outcome: "ok",
    status: 200,
    login: "octocat",
    avatarUrl: null,
    scopes: ["api"],
    detail: null,
    endpoint: "https://gitlab.com/api/v4/user",
    ...overrides,
  };
}

function renderModal(connection: GitHostConnectionInfo = GITLAB) {
  const onClose = vi.fn();
  render(
    <GitHostEditConnectionModal
      connection={connection}
      onSave={mocks.save as (id: string, u: GitHostConnectionUpdate) => Promise<void>}
      onClose={onClose}
    />,
  );
  return { onClose };
}

function startRotation() {
  fireEvent.click(screen.getByRole("button", { name: /replace token/i }));
}

function typeToken(value = SECRET) {
  fireEvent.change(screen.getByLabelText(/new personal access token/i), {
    target: { value },
  });
}

function saveButton() {
  return screen.getByRole("button", { name: /save changes/i });
}

/**
 * The credential may live in the password field the user is typing into, and
 * NOWHERE else: not in a message, a label, a title, or any other attribute.
 */
function leakCheck() {
  expect(document.body.textContent ?? "").not.toContain(SECRET);
  for (const input of Array.from(document.querySelectorAll("input"))) {
    if (input.value.includes(SECRET)) expect(input.getAttribute("type")).toBe("password");
  }
  const withoutFieldValues = document.body.innerHTML.replace(/value="[^"]*"/g, 'value=""');
  expect(withoutFieldValues).not.toContain(SECRET);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.probe.mockResolvedValue(probeResult());
  mocks.save.mockResolvedValue(undefined);
});

describe("editing a git-host connection", () => {
  it("saves a rotated token once the host has accepted it", async () => {
    const { onClose } = renderModal();
    startRotation();
    typeToken();

    // Nothing may be saveable before the credential has been checked.
    expect(saveButton()).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /verify token/i }));
    await waitFor(() => expect(saveButton()).toBeEnabled());
    // The probe targets the connection's own stored origin.
    expect(mocks.probe).toHaveBeenCalledWith(
      "https://gitlab.com",
      expect.objectContaining({ apiPrefix: "/api/v4" }),
      SECRET,
    );

    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));

    const [id, update] = mocks.save.mock.calls[0] as [string, GitHostConnectionUpdate];
    expect(id).toBe("gitlab-gitlab-com");
    expect(update.token).toBe(SECRET);
    // The descriptor travels with it so Rust can re-verify before writing.
    expect(update.probe).toMatchObject({ apiPrefix: "/api/v4", authScheme: "private-token" });
    // Kind and base URL are echoed as assertions, never as edits.
    expect(update.kind).toBe("gitlab");
    expect(update.baseUrl).toBe("https://gitlab.com");
    expect(update.label).toBeUndefined();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    leakCheck();
  });

  it("refuses to save a token the host rejected, and never reaches the save path", async () => {
    mocks.probe.mockResolvedValue(
      probeResult({ outcome: "invalid_token", status: 401, login: null, scopes: null }),
    );
    renderModal();
    startRotation();
    typeToken();
    fireEvent.click(screen.getByRole("button", { name: /verify token/i }));

    await screen.findByText(/the token was rejected/i);
    expect(saveButton()).toBeDisabled();
    expect(mocks.save).not.toHaveBeenCalled();
    leakCheck();
  });

  it.each([
    ["unreachable", /could not reach/i],
    ["tls_error", /certificate was rejected/i],
    ["forbidden", /valid but not permitted/i],
    ["rate_limited", /rate-limiting/i],
    ["not_a_host", /not this host's api/i],
    ["server_error", /server error/i],
    ["unknown", /unexpected response/i],
  ] as const)("blocks the save on a %s verdict", async (outcome, copy) => {
    mocks.probe.mockResolvedValue(probeResult({ outcome, login: null, scopes: null }));
    renderModal();
    startRotation();
    typeToken();
    fireEvent.click(screen.getByRole("button", { name: /verify token/i }));

    await screen.findByText(copy);
    expect(saveButton()).toBeDisabled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("blocks the save when the host reports the token is missing a required scope", async () => {
    mocks.probe.mockResolvedValue(probeResult({ scopes: ["read_user"] }));
    renderModal();
    startRotation();
    typeToken();
    fireEvent.click(screen.getByRole("button", { name: /verify token/i }));

    await screen.findByText(/missing scopes/i);
    expect(saveButton()).toBeDisabled();
  });

  it("discards a verdict as soon as the token changes", async () => {
    // Otherwise a green verdict earned by a working token would authorise
    // saving whatever was typed after it.
    renderModal();
    startRotation();
    typeToken("glpat-good");
    fireEvent.click(screen.getByRole("button", { name: /verify token/i }));
    await waitFor(() => expect(saveButton()).toBeEnabled());

    typeToken("glpat-something-else");
    expect(saveButton()).toBeDisabled();
    expect(screen.getByRole("button", { name: /verify token/i })).toBeInTheDocument();
  });

  it("renames a connection without asking for a token", async () => {
    const { onClose } = renderModal();
    fireEvent.change(screen.getByLabelText(/display name/i), {
      target: { value: "  Prod GitLab  " },
    });
    fireEvent.click(saveButton());

    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    const [, update] = mocks.save.mock.calls[0] as [string, GitHostConnectionUpdate];
    expect(update.label).toBe("Prod GitLab");
    // No token means the stored credential is not touched at all — the whole
    // point of allowing a rename without re-entering one.
    expect(update.token).toBeUndefined();
    expect(update.probe).toBeUndefined();
    expect(mocks.probe).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("has nothing to save until something actually changes", () => {
    renderModal();
    expect(saveButton()).toBeDisabled();
  });

  it("offers no way to change the host kind or its address", () => {
    renderModal();
    // The address is shown, but only as text — there is no field for it, and
    // no host picker. Re-pointing a connection is a new connection.
    expect(screen.getByText("https://gitlab.com")).toBeInTheDocument();
    expect(screen.queryByLabelText(/instance url|base url|address/i)).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByText(/cannot be changed here/i)).toBeInTheDocument();
  });

  it("surfaces a backend refusal instead of closing", async () => {
    mocks.save.mockRejectedValue(
      new Error(
        "The new token was not saved because the host rejected it. The existing credential is unchanged.",
      ),
    );
    const { onClose } = renderModal();
    startRotation();
    typeToken();
    fireEvent.click(screen.getByRole("button", { name: /verify token/i }));
    await waitFor(() => expect(saveButton()).toBeEnabled());
    fireEvent.click(saveButton());

    await screen.findByText(/existing credential is unchanged/i);
    expect(onClose).not.toHaveBeenCalled();
    leakCheck();
  });

  it("keeps the current token when the rotation is abandoned", async () => {
    renderModal();
    startRotation();
    typeToken();
    fireEvent.click(screen.getByRole("button", { name: /keep the current token/i }));

    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "Renamed" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    const [, update] = mocks.save.mock.calls[0] as [string, GitHostConnectionUpdate];
    expect(update.token).toBeUndefined();
    leakCheck();
  });

  it("does not offer to rename the built-in GitHub connection", () => {
    // Its label is not persisted (it is re-seeded on every launch), so a
    // rename would silently revert; the backend refuses it too.
    renderModal(GITHUB);
    expect(screen.queryByLabelText(/display name/i)).toBeNull();
    expect(screen.getByText(/name is fixed/i)).toBeInTheDocument();
    // Rotation is still available — that is the whole point.
    expect(screen.getByRole("button", { name: /replace token/i })).toBeInTheDocument();
  });

  it("stores the credential in a password field with autofill disabled", () => {
    renderModal();
    startRotation();
    const field = screen.getByLabelText(/new personal access token/i);
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("autocomplete", "off");
    // No reveal toggle, deliberately.
    expect(screen.queryByRole("button", { name: /show|reveal/i })).toBeNull();
  });
});
