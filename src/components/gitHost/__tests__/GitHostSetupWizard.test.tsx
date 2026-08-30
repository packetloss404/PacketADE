import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GitHostProbeResult } from "@/lib/gitHostProbe";
import { GitHostSetupWizard } from "@/components/gitHost/GitHostSetupWizard";

/**
 * A token that would be trivially greppable if it ever escaped the two calls
 * that are allowed to see it. Used as a canary across the whole suite.
 */
const SECRET = "ghp_CANARY_must_never_leak_0000";

const mocks = vi.hoisted(() => ({
  probe: vi.fn(),
  probePending: vi.fn(),
  githubSetToken: vi.fn(),
  gitHostAddGitea: vi.fn(),
  loadConnections: vi.fn(),
  setActiveConnection: vi.fn(),
  initializeAuth: vi.fn(),
  oauthConfigured: vi.fn(),
  deviceStart: vi.fn(),
  devicePoll: vi.fn(),
  deviceCommit: vi.fn(),
  deviceDiscard: vi.fn(),
}));

vi.mock("@/lib/gitHostProbe", () => ({
  probeGitHostCredential: (...args: unknown[]) => mocks.probe(...args),
  probePendingDeviceCredential: (...args: unknown[]) => mocks.probePending(...args),
}));

// The wizard's descriptors call these directly — they are the ONLY sanctioned
// persistence path (each writes to the OS keyring in Rust). The device-flow
// four are the browser-authorisation half of the same contract; note that
// none of them ever carries a credential in either direction.
vi.mock("@/lib/tauri", () => ({
  githubSetToken: (...args: unknown[]) => mocks.githubSetToken(...args),
  gitHostAddGitea: (...args: unknown[]) => mocks.gitHostAddGitea(...args),
  githubOauthConfigured: (...args: unknown[]) => mocks.oauthConfigured(...args),
  githubDeviceFlowStart: (...args: unknown[]) => mocks.deviceStart(...args),
  githubDeviceFlowPoll: (...args: unknown[]) => mocks.devicePoll(...args),
  githubDeviceFlowCommit: (...args: unknown[]) => mocks.deviceCommit(...args),
  githubDeviceFlowDiscard: (...args: unknown[]) => mocks.deviceDiscard(...args),
}));

vi.mock("@/stores/githubStore", () => ({
  useGitHubStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      connections: [
        {
          id: "github",
          kind: "github",
          baseUrl: "https://api.github.com",
          label: "GitHub",
          hasToken: true,
        },
      ],
      activeConnectionId: "github",
      loadConnections: mocks.loadConnections,
      setActiveConnection: mocks.setActiveConnection,
      initializeAuth: mocks.initializeAuth,
    }),
}));


function probeResult(overrides: Partial<GitHostProbeResult> = {}): GitHostProbeResult {
  return {
    outcome: "ok",
    status: 200,
    login: "octocat",
    avatarUrl: null,
    scopes: ["repo", "read:org"],
    detail: null,
    endpoint: "https://api.github.com/user",
    ...overrides,
  };
}

function typeToken(value = SECRET) {
  const field = screen.getByLabelText(/personal access token|access token/i);
  fireEvent.change(field, { target: { value } });
  return field;
}

/** Everything the wizard put on screen, for leak assertions. */
function renderedText(): string {
  return document.body.innerHTML;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadConnections.mockResolvedValue(undefined);
  mocks.githubSetToken.mockResolvedValue(undefined);
  mocks.gitHostAddGitea.mockResolvedValue("gitea-git-example-com");
  mocks.probe.mockResolvedValue(probeResult());
  mocks.probePending.mockResolvedValue(probeResult());
  // Default: no OAuth app id in this build, so the browser option is absent
  // and the wizard is the plain paste-a-token flow the rest of these tests
  // describe. The `browser authorisation` block below turns it on.
  mocks.oauthConfigured.mockResolvedValue(false);
  mocks.deviceCommit.mockResolvedValue(undefined);
  mocks.deviceDiscard.mockResolvedValue(undefined);
});

describe("host picker", () => {
  it("offers every descriptor and disables the unsupported one", () => {
    render(<GitHostSetupWizard onClose={() => {}} />);
    expect(screen.getByRole("radiogroup", { name: /which git host/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /GitHub Enterprise Server/ })).toBeDisabled();
    expect(screen.getByText(/fixed to github\.com/i)).toBeInTheDocument();
  });

  it("skips the instance step for a cloud host and shows it for a self-hosted one", () => {
    render(<GitHostSetupWizard onClose={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: /the hosted service/i }));
    expect(screen.getByLabelText(/personal access token/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/instance URL/i)).not.toBeInTheDocument();
  });
});

describe("instance URL step", () => {
  it("shows the normalised value and what it changed, rather than rewriting silently", () => {
    render(<GitHostSetupWizard onClose={() => {}} initialDescriptorId="gitea" />);
    const field = screen.getByLabelText(/instance URL/i);
    fireEvent.change(field, { target: { value: "git.example.com/api/v1/" } });

    expect(screen.getByText("https://git.example.com")).toBeInTheDocument();
    expect(screen.getByText(/Added https:\/\//)).toBeInTheDocument();
    expect(screen.getByText(/Removed the \/api\/v1 suffix/)).toBeInTheDocument();
    // The user's own typing is left exactly as they typed it.
    expect(field).toHaveValue("git.example.com/api/v1/");
  });

  it("blocks Continue and announces the problem for an unusable URL", () => {
    render(<GitHostSetupWizard onClose={() => {}} initialDescriptorId="gitea" />);
    fireEvent.change(screen.getByLabelText(/instance URL/i), {
      target: { value: "ftp://git.example.com" },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/http:\/\/ or https:\/\//);
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });
});

describe("token step", () => {
  it("explains the required scopes and links to the host's token page", () => {
    render(<GitHostSetupWizard onClose={() => {}} initialDescriptorId="github" />);
    expect(screen.getByText("repo")).toBeInTheDocument();
    expect(
      screen.getByText(/Read repositories, issues, and pull requests/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Create a token on GitHub/i })).toHaveAttribute(
      "href",
      "https://github.com/settings/tokens/new",
    );
  });

  it("derives the token page from the instance URL for a self-hosted host", () => {
    render(<GitHostSetupWizard onClose={() => {}} initialDescriptorId="gitea" />);
    fireEvent.change(screen.getByLabelText(/instance URL/i), {
      target: { value: "https://git.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("link", { name: /Create a token/i })).toHaveAttribute(
      "href",
      "https://git.example.com/user/settings/applications",
    );
  });

  it("uses a non-autocompleting password field with no reveal control", () => {
    render(<GitHostSetupWizard onClose={() => {}} initialDescriptorId="github" />);
    const field = typeToken();
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("autocomplete", "off");
    expect(field).toHaveAttribute("spellcheck", "false");
    // A reveal toggle would defeat the password field; there deliberately is none.
    expect(screen.queryByRole("button", { name: /show|reveal/i })).not.toBeInTheDocument();
  });
});

describe("verification", () => {
  async function verifyGithubWith(result: Partial<GitHostProbeResult>) {
    mocks.probe.mockResolvedValue(probeResult(result));
    render(<GitHostSetupWizard onClose={() => {}} initialDescriptorId="github" />);
    typeToken();
    fireEvent.click(screen.getByRole("button", { name: "Verify token" }));
    await waitFor(() => expect(mocks.probe).toHaveBeenCalled());
  }

  it("validates before saving — nothing is persisted while on the verify step", async () => {
    await verifyGithubWith({});
    await screen.findByText(/Connected as octocat/);
    expect(mocks.githubSetToken).not.toHaveBeenCalled();
    expect(mocks.gitHostAddGitea).not.toHaveBeenCalled();
  });

  it("names an unreachable host and refuses to save", async () => {
    await verifyGithubWith({ outcome: "unreachable", detail: "The connection was refused." });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("data-verdict", "unreachable");
    expect(alert).toHaveTextContent("Could not reach GitHub");
    expect(screen.getByRole("button", { name: "Save connection" })).toBeDisabled();
  });

  it("names a rejected token and refuses to save", async () => {
    await verifyGithubWith({ outcome: "invalid_token", login: null, scopes: null });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("data-verdict", "invalid_token");
    expect(screen.getByRole("button", { name: "Save connection" })).toBeDisabled();
  });

  it("names the missing scopes on an otherwise valid token", async () => {
    await verifyGithubWith({ scopes: ["read:org"] });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("data-verdict", "insufficient_scopes");
    expect(alert).toHaveTextContent("repo");
    expect(screen.getByRole("button", { name: "Save connection" })).toBeDisabled();
  });

  it("distinguishes a wrong address that answered from a rejected token", async () => {
    await verifyGithubWith({
      outcome: "not_a_host",
      login: null,
      scopes: null,
      endpoint: "https://wrong.example.com/user",
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("data-verdict", "not_a_host");
    expect(alert).toHaveTextContent("https://wrong.example.com/user");
  });

  it("allows saving with a warning when the host reports no scopes", async () => {
    await verifyGithubWith({ scopes: null });
    const status = await screen.findByRole("status");
    expect(status).toHaveAttribute("data-verdict", "scopes_unknown");
    expect(screen.getByRole("button", { name: "Save connection" })).toBeEnabled();
  });

  it("never echoes the token back in a failure", async () => {
    await verifyGithubWith({ outcome: "invalid_token", login: null, scopes: null });
    await screen.findByRole("alert");
    expect(renderedText()).not.toContain(SECRET);
  });
});

describe("saving", () => {
  it("routes a GitHub token only to the keyring command, then clears it", async () => {
    render(<GitHostSetupWizard onClose={() => {}} initialDescriptorId="github" />);
    typeToken();
    fireEvent.click(screen.getByRole("button", { name: "Verify token" }));
    await screen.findByText(/Connected as octocat/);
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));

    await waitFor(() => expect(mocks.githubSetToken).toHaveBeenCalledWith(SECRET));
    expect(mocks.gitHostAddGitea).not.toHaveBeenCalled();
    // Exactly two calls ever saw the credential: the probe and the keyring write.
    expect(mocks.probe).toHaveBeenCalledWith(
      "https://api.github.com",
      expect.objectContaining({ identityPath: "/user" }),
      SECRET,
    );

    await screen.findByText(/GitHub connected/);
    // Nothing on the finished screen, in localStorage, or in the store carries it.
    expect(renderedText()).not.toContain(SECRET);
    expect(JSON.stringify(window.localStorage)).not.toContain(SECRET);
    for (const call of mocks.setActiveConnection.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(SECRET);
    }
    for (const call of mocks.loadConnections.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(SECRET);
    }
  });

  it("saves a self-hosted host through the add-connection command with the normalised URL", async () => {
    // Gitea reports no scope header, so a good token lands on the honest
    // "couldn't check the scopes" warning rather than a green tick.
    mocks.probe.mockResolvedValue(probeResult({ scopes: null }));
    render(<GitHostSetupWizard onClose={() => {}} initialDescriptorId="gitea" />);
    fireEvent.change(screen.getByLabelText(/instance URL/i), {
      target: { value: "git.example.com/api/v1/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    typeToken();
    fireEvent.click(screen.getByRole("button", { name: "Verify token" }));
    await screen.findByRole("status");
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));

    await waitFor(() =>
      expect(mocks.gitHostAddGitea).toHaveBeenCalledWith(
        "https://git.example.com",
        "git.example.com",
        SECRET,
      ),
    );
    expect(mocks.githubSetToken).not.toHaveBeenCalled();
  });

  it("makes the new connection active when asked, and says what that means", async () => {
    render(<GitHostSetupWizard onClose={() => {}} initialDescriptorId="github" />);
    typeToken();
    fireEvent.click(screen.getByRole("button", { name: "Verify token" }));
    await screen.findByText(/Connected as octocat/);
    expect(screen.getByRole("checkbox", { name: /Use this connection now/i })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));

    await waitFor(() => expect(mocks.setActiveConnection).toHaveBeenCalledWith("github", true));
    expect(await screen.findByText(/This connection is active now/)).toBeInTheDocument();
  });

  it("leaves the active connection alone when the user unticks the box", async () => {
    mocks.probe.mockResolvedValue(probeResult({ scopes: null }));
    render(<GitHostSetupWizard onClose={() => {}} initialDescriptorId="gitea" />);
    fireEvent.change(screen.getByLabelText(/instance URL/i), {
      target: { value: "https://git.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    typeToken();
    fireEvent.click(screen.getByRole("button", { name: "Verify token" }));
    await screen.findByRole("status");
    fireEvent.click(screen.getByRole("checkbox", { name: /Use this connection now/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));

    await screen.findByText(/Gitea \/ Forgejo connected/);
    expect(mocks.setActiveConnection).not.toHaveBeenCalled();
    expect(
      screen.getByText(/previously active connection is unchanged/i),
    ).toBeInTheDocument();
  });
});

/**
 * Browser authorisation, folded into the same wizard.
 *
 * Before this, GitHub's device flow lived only in a Settings inline form: it
 * was invisible until you opened a token field you did not intend to use, and
 * nothing checked what the resulting credential could actually do. The wizard
 * checked scopes but had never heard of it. These tests pin the consolidation:
 * one surface, both credential kinds, the same verdicts, and the same refusal
 * to save anything that has not been checked.
 */
describe("browser authorisation", () => {
  /** GitHub's device-flow start payload. The user code is not a secret. */
  const START = {
    deviceCode: "device-code-abc",
    userCode: "WDJB-MJHT",
    verificationUri: "https://github.com/login/device",
    interval: 0,
    expiresIn: 900,
  };

  function enableDeviceFlow() {
    mocks.oauthConfigured.mockResolvedValue(true);
    mocks.deviceStart.mockResolvedValue(START);
  }

  /** Poll once with `pending`, then land on the given terminal answer. */
  function pollsTo(final: {
    status: string;
    message?: string | null;
    pendingId?: string | null;
  }) {
    mocks.devicePoll
      .mockResolvedValueOnce({ status: "pending", message: null, pendingId: null })
      .mockResolvedValue({ message: null, pendingId: null, ...final });
  }

  async function authorize() {
    fireEvent.click(await screen.findByRole("button", { name: /Sign in with GitHub/i }));
  }

  it("is hidden when this build has no OAuth app configured", async () => {
    // A button that can only ever error is worse than no button: the flow
    // degrades to the token step it has always been, with nothing missing.
    render(<GitHostSetupWizard onClose={() => {}} initialDescriptorId="github" />);
    await waitFor(() => expect(mocks.oauthConfigured).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Sign in with GitHub/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/personal access token/i)).toBeInTheDocument();
  });

  it("offers both credential kinds on one step when it is available", async () => {
    enableDeviceFlow();
    render(<GitHostSetupWizard onClose={() => {}} initialDescriptorId="github" />);
    // Neither is buried behind the other, and neither costs an extra step.
    expect(await screen.findByRole("button", { name: /Sign in with GitHub/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/personal access token/i)).toBeInTheDocument();
  });

  it("shows the code to type, then lands on the same verdict a token gets", async () => {
    enableDeviceFlow();
    pollsTo({ status: "authorized", pendingId: "pending-1" });
    render(<GitHostSetupWizard onClose={() => {}} initialDescriptorId="github" />);
    await authorize();

    expect(await screen.findByText("WDJB-MJHT")).toBeInTheDocument();
    await screen.findByText(/Connected as octocat/, undefined, { timeout: 5000 });
    // Checked by handle against the SAME descriptor probe spec the paste path
    // uses — so the two kinds cannot drift into different verdict quality.
    expect(mocks.probePending).toHaveBeenCalledWith(
      "pending-1",
      expect.objectContaining({ identityPath: "/user", scopeHeader: "x-oauth-scopes" }),
    );
    expect(screen.getByRole("button", { name: "Save connection" })).toBeEnabled();
  });

  it("refuses to save a browser credential whose granted scopes fall short", async () => {
    // The whole reason this path needed folding in: an org-restricted grant
    // used to be written to the keyring unexamined.
    enableDeviceFlow();
    pollsTo({ status: "authorized", pendingId: "pending-2" });
    mocks.probePending.mockResolvedValue(probeResult({ scopes: ["read:org"] }));
    render(<GitHostSetupWizard onClose={() => {}} initialDescriptorId="github" />);
    await authorize();

    const alert = await screen.findByRole("alert", undefined, { timeout: 5000 });
    expect(alert).toHaveAttribute("data-verdict", "insufficient_scopes");
    expect(alert).toHaveTextContent("repo");
    expect(screen.getByRole("button", { name: "Save connection" })).toBeDisabled();
    expect(mocks.deviceCommit).not.toHaveBeenCalled();
  });

  it("saves by handle — no credential passes through the frontend at all", async () => {
    enableDeviceFlow();
    pollsTo({ status: "authorized", pendingId: "pending-3" });
    render(<GitHostSetupWizard onClose={() => {}} initialDescriptorId="github" />);
    await authorize();
    await screen.findByText(/Connected as octocat/, undefined, { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));

    await waitFor(() => expect(mocks.deviceCommit).toHaveBeenCalledWith("pending-3"));
    // The paste path's keyring command is untouched: there was no token here.
    expect(mocks.githubSetToken).not.toHaveBeenCalled();
    await screen.findByText(/GitHub connected/);
    expect(screen.getByText(/Browser sign-in, stored in the OS keyring/)).toBeInTheDocument();
    await waitFor(() => expect(mocks.setActiveConnection).toHaveBeenCalledWith("github", true));
  });

  it("tells the backend to drop the credential when the user backs out", async () => {
    enableDeviceFlow();
    pollsTo({ status: "authorized", pendingId: "pending-4" });
    render(<GitHostSetupWizard onClose={() => {}} initialDescriptorId="github" />);
    await authorize();
    await screen.findByText(/Connected as octocat/, undefined, { timeout: 5000 });

    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    // Forgetting the handle would leave a live token parked in the backend
    // until its TTL; the wizard has to say so out loud.
    await waitFor(() => expect(mocks.deviceDiscard).toHaveBeenCalledWith("pending-4"));
    expect(screen.getByLabelText(/personal access token/i)).toHaveValue("");
  });

  it("drops the credential when the wizard is closed mid-flow", async () => {
    enableDeviceFlow();
    pollsTo({ status: "authorized", pendingId: "pending-5" });
    const { unmount } = render(
      <GitHostSetupWizard onClose={() => {}} initialDescriptorId="github" />,
    );
    await authorize();
    await screen.findByText(/Connected as octocat/, undefined, { timeout: 5000 });
    unmount();
    await waitFor(() => expect(mocks.deviceDiscard).toHaveBeenCalledWith("pending-5"));
  });

  it("reports a refused authorisation and saves nothing", async () => {
    enableDeviceFlow();
    pollsTo({ status: "error", message: "access_denied" });
    render(<GitHostSetupWizard onClose={() => {}} initialDescriptorId="github" />);
    await authorize();

    expect(await screen.findByText("access_denied", undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(mocks.deviceCommit).not.toHaveBeenCalled();
    expect(mocks.githubSetToken).not.toHaveBeenCalled();
    // Still on the credential step, with the paste path intact.
    expect(screen.getByLabelText(/personal access token/i)).toBeInTheDocument();
  });
});

describe("credential lifetime", () => {
  it("does not survive stepping back off the verify screen", async () => {
    render(<GitHostSetupWizard onClose={() => {}} initialDescriptorId="github" />);
    typeToken();
    fireEvent.click(screen.getByRole("button", { name: "Verify token" }));
    await screen.findByText(/Connected as octocat/);
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));

    expect(screen.getByLabelText(/personal access token/i)).toHaveValue("");
  });

  it("does not survive the wizard closing", async () => {
    const { unmount } = render(<GitHostSetupWizard onClose={() => {}} initialDescriptorId="github" />);
    typeToken();
    unmount();
    expect(renderedText()).not.toContain(SECRET);
  });
});
