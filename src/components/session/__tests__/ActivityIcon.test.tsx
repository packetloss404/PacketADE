import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ActivityIcon, getActivityLabel } from "@/components/session/ActivityStrip";

describe("ActivityIcon", () => {
  it("renders Brain icon for thinking state", () => {
    const { container } = render(<ActivityIcon state="thinking" tool={null} />);
    // lucide-react renders an SVG; Brain icon has a specific class
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.classList.contains("text-accent-blue")).toBe(true);
  });

  it("renders FileEdit icon for Edit tool", () => {
    const { container } = render(<ActivityIcon state="tool_use" tool="Edit" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.classList.contains("text-accent-amber")).toBe(true);
  });

  it("renders TerminalSquare icon for Bash tool", () => {
    const { container } = render(<ActivityIcon state="tool_use" tool="Bash" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.classList.contains("text-accent-green")).toBe(true);
  });

  it("renders fallback FileEdit for unknown tool", () => {
    const { container } = render(<ActivityIcon state="tool_use" tool="SomeUnknownTool" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.classList.contains("text-text-muted")).toBe(true);
  });
});

describe("getActivityLabel", () => {
  it('returns "Thinking..." for thinking state', () => {
    expect(getActivityLabel("thinking", null, null)).toBe("Thinking...");
  });

  it('returns "Editing path/file.ts" for Edit tool', () => {
    expect(getActivityLabel("tool_use", "Edit", "path/file.ts")).toBe("Editing path/file.ts");
  });

  it('returns "Running: command" for Bash tool', () => {
    expect(getActivityLabel("tool_use", "Bash", "npm test")).toBe("Running: npm test");
  });

  it("truncates long file paths", () => {
    const longPath = "src/components/views/very/deeply/nested/folder/structure/MyComponent.tsx";
    const result = getActivityLabel("tool_use", "Edit", longPath);
    // Path is >50 chars, so it should be truncated with "..." prefix
    expect(result).toContain("...");
    expect(result.length).toBeLessThan(longPath.length + 10); // "Editing " + truncated path
    expect(result.startsWith("Editing ...")).toBe(true);
  });
});
