import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpRootsEditor } from "../McpRootsEditor";

const openDialog = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openDialog(...args),
}));

function renderEditor(overrides: Partial<Parameters<typeof McpRootsEditor>[0]> = {}) {
  const onChange = vi.fn();
  render(
    <McpRootsEditor
      serverLabel="demo"
      roots={["C:\\projects\\demo"]}
      workspacePath="D:\\projects\\demo"
      enforced
      onChange={onChange}
      {...overrides}
    />,
  );
  return onChange;
}

function typeRoot(value: string) {
  fireEvent.change(screen.getByLabelText(/Add a filesystem root/), { target: { value } });
}

describe("McpRootsEditor", () => {
  beforeEach(() => {
    openDialog.mockReset();
  });

  it("adds a typed root and shows the normalised value before it is stored", () => {
    const onChange = renderEditor({ roots: [] });
    typeRoot("c:/projects/app/");

    expect(screen.getByText("Will be saved as")).toBeInTheDocument();
    expect(screen.getByText("C:\\projects\\app")).toBeInTheDocument();
    expect(screen.getByText(/Upper-cased the drive letter/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Add/ }));
    expect(onChange).toHaveBeenCalledWith(
      ["C:\\projects\\app"],
      "root granted: C:\\projects\\app",
    );
  });

  // Denial paths. Each of these is a value one of the two enforcement engines
  // would read differently from the other, so storing it is worse than
  // refusing it.
  it.each([
    [".", /lexically/i],
    ["C:\\projects\\..\\Windows", /resolves it lexically/i],
    ["projects\\app", /absolute path/i],
    ["~\\projects", /not expanded/i],
    ["%USERPROFILE%\\projects", /environment variables/i],
    ["C:\\projects\\*", /wildcard/i],
    ["file:///C:/projects/app", /not a URL/i],
    ["\\\\?\\C:\\projects", /verbatim/i],
    ["C:projects", /drive-relative/i],
  ])("refuses %j and says why", (value, reason) => {
    const onChange = renderEditor({ roots: [] });
    typeRoot(value);

    expect(screen.getByRole("alert")).toHaveTextContent(reason);
    expect(screen.getByRole("button", { name: /Add/ })).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("warns rather than refuses when a root grants a whole drive", () => {
    renderEditor({ roots: [] });
    typeRoot("C:\\");

    expect(screen.getByText(/entire C: drive/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add/ })).toBeEnabled();
  });

  it("blocks a duplicate and a root already covered by an existing one", () => {
    renderEditor();

    typeRoot("c:\\PROJECTS\\demo");
    expect(screen.getByText(/Already granted as/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add/ })).toBeDisabled();

    typeRoot("C:\\projects\\demo\\src");
    expect(screen.getByText(/Already covered by/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add/ })).toBeDisabled();
  });

  it("states that the empty list is the locked state, not the open one", () => {
    renderEditor({ roots: [] });
    expect(screen.getByText(/No roots granted — fully locked/)).toBeInTheDocument();
    expect(
      screen.getByText(/Empty does not mean unrestricted here/),
    ).toBeInTheDocument();
  });

  it("allows removing the last root and reports the locked state afterwards", () => {
    const onChange = renderEditor({ roots: ["C:\\projects\\demo"] });
    fireEvent.click(screen.getByRole("button", { name: "Remove root C:\\projects\\demo" }));
    expect(onChange).toHaveBeenCalledWith([], "root revoked: C:\\projects\\demo");
  });

  it("validates paths returned by the native picker instead of trusting them", async () => {
    openDialog.mockResolvedValue(["C:\\projects\\picked", "\\\\?\\C:\\verbatim"]);
    const onChange = renderEditor({ roots: [] });

    fireEvent.click(screen.getByRole("button", { name: /Browse/ }));

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        ["C:\\projects\\picked"],
        "roots granted: C:\\projects\\picked",
      ),
    );
    expect(openDialog).toHaveBeenCalledWith(
      expect.objectContaining({ directory: true, multiple: true }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/verbatim/i);
  });

  it("says the list is inert when the outside-workspace floor is not armed", () => {
    renderEditor({ enforced: false });
    expect(
      screen.getByText(/denial floor is not armed .* not consulted at tool-call time/),
    ).toBeInTheDocument();
  });

  it("says when a change takes effect", () => {
    renderEditor();
    expect(screen.getByText(/Changes apply to new sessions/)).toBeInTheDocument();
  });

  it("refuses a POSIX-shaped root in a Windows workspace", () => {
    renderEditor({ roots: [] });
    typeRoot("/home/you/app");
    expect(screen.getByRole("alert")).toHaveTextContent(/Windows paths/);
  });
});
