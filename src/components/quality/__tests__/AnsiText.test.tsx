import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { AnsiText } from "../AnsiText";

describe("AnsiText", () => {
  it("renders plain text without ANSI escapes", () => {
    const { container } = render(<AnsiText text={"hello world"} />);
    expect(container.textContent).toContain("hello world");
  });

  it("strips SGR escapes from the rendered text and applies styles", () => {
    // Red foreground (31), then reset (0).
    const text = "\x1b[31merror:\x1b[0m something failed";
    const { container } = render(<AnsiText text={text} />);
    // Escape bytes never reach the DOM.
    expect(container.textContent).not.toContain("\x1b");
    expect(container.textContent).toContain("error: something failed");
    // The red span carries an inline color.
    const styled = container.querySelector("span[style*='color']");
    expect(styled).not.toBeNull();
  });

  it("linkifies path:line:col tokens when onPathClick is provided", () => {
    const text = "src/foo.ts:12:5  error  Unexpected token";
    const { container } = render(
      <AnsiText text={text} onPathClick={() => {}} />,
    );
    const link = container.querySelector("button");
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe("src/foo.ts:12:5");
  });

  it("filters out lines that do not contain the filter text", () => {
    const text = "keep me\nfilter target\nignored line";
    const { container } = render(
      <AnsiText text={text} filter="target" />,
    );
    expect(container.textContent).toContain("filter target");
    expect(container.textContent).not.toContain("ignored line");
  });

  it("highlights filter matches when highlightFilter is true", () => {
    const text = "match target here";
    const { container } = render(
      <AnsiText text={text} filter="target" highlightFilter />,
    );
    const mark = container.querySelector("mark");
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe("target");
  });

  it("renders an empty-state message when no lines match the filter", () => {
    const { container } = render(
      <AnsiText text={"a\nb\nc"} filter="zzz" />,
    );
    expect(container.textContent).toContain("No lines match");
  });
});
