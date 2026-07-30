import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { LeftRail } from "@/components/layout/LeftRail";
import { useAppStore } from "@/stores/appStore";

describe("LeftRail Agents route", () => {
  beforeEach(() => {
    useAppStore.setState({ activeView: "workspace" });
  });

  it("opens Agents as its own same-window destination", () => {
    render(<LeftRail />);

    fireEvent.click(screen.getByTitle("Agents"));

    expect(useAppStore.getState().activeView).toBe("agents");
  });
});
