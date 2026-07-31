/**
 * The account chip is the mis-pick safeguard: two tiles running the same CLI
 * under two logins are otherwise identical. These tests pin (a) that it only
 * appears for panes with an explicit account, and (b) that its color is stable
 * and account-derived rather than incidental.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountChip, AccountDot } from "@/components/session/AccountChip";
import { TerminalHeader } from "@/components/session/TerminalHeader";
import { useCliAccountStore } from "@/stores/cliAccountStore";
import { getAccountColor } from "@/lib/accountColors";

const OSS = {
  id: "acct-oss",
  label: "Personal / OSS",
  cli: "claude-code" as const,
  configDir: "/a/oss",
  createdAt: 1,
};
const CLIENT = {
  id: "acct-client",
  label: "Client work",
  cli: "claude-code" as const,
  configDir: "/a/client",
  createdAt: 2,
};

describe("AccountChip", () => {
  beforeEach(() => {
    useCliAccountStore.setState({ accounts: [OSS, CLIENT] });
  });

  it("renders nothing for ambient panes", () => {
    const { container } = render(<AccountChip accountId={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the account label and its stable color", () => {
    render(<AccountChip accountId={CLIENT.id} />);
    const chip = screen.getByTestId("account-chip");
    expect(chip).toHaveTextContent(CLIENT.label);
    expect(chip.className).toContain(getAccountColor(CLIENT.id).text);
  });

  it("gives two accounts two different colors", () => {
    const { unmount } = render(<AccountChip accountId={OSS.id} />);
    const ossClass = screen.getByTestId("account-chip").className;
    unmount();
    render(<AccountChip accountId={CLIENT.id} />);
    const clientClass = screen.getByTestId("account-chip").className;
    expect(ossClass).not.toBe(clientClass);
  });

  it("degrades to a named placeholder if the account was deleted", () => {
    useCliAccountStore.setState({ accounts: [] });
    render(<AccountChip accountId={CLIENT.id} />);
    expect(screen.getByTestId("account-chip")).toHaveTextContent("Unknown account");
  });

  it("AccountDot renders a titled dot for bound panes and nothing for ambient", () => {
    const { unmount } = render(<AccountDot accountId={OSS.id} />);
    expect(screen.getByTestId("account-dot")).toHaveAttribute(
      "title",
      `CLI account: ${OSS.label}`,
    );
    unmount();
    const { container } = render(<AccountDot accountId={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("TerminalHeader account chip", () => {
  beforeEach(() => {
    useCliAccountStore.setState({ accounts: [OSS, CLIENT] });
  });

  const base = {
    alive: true,
    error: null,
    showApproval: false,
    cliCommand: "claude",
    onRestart: vi.fn(),
    onKill: vi.fn(),
    showCloseButton: false,
  };

  it("renders the chip beside the agent identity when the session is bound", () => {
    render(<TerminalHeader {...base} accountId={CLIENT.id} />);
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByTestId("account-chip")).toHaveTextContent(CLIENT.label);
  });

  it("renders nothing extra for an ambient session", () => {
    render(<TerminalHeader {...base} />);
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.queryByTestId("account-chip")).not.toBeInTheDocument();
  });
});
