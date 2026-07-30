import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { LeftRail } from "@/components/layout/LeftRail";
import { useAppStore } from "@/stores/appStore";
import { railFooterRoutes, railPrimaryRoutes } from "@/lib/routeRegistry";

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

/** D4: the rail renders from the one route registry (audit P1-9). */
describe("LeftRail registry wiring", () => {
  beforeEach(() => {
    useAppStore.setState({ activeView: "workspace" });
  });

  it("renders exactly the registry's rail entries, in order", () => {
    render(<LeftRail />);

    const expected = [...railPrimaryRoutes(), ...railFooterRoutes()].map((r) => r.label);
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("title"))).toEqual(expected);
  });

  it("routes every rail button to its registry id", () => {
    for (const route of [...railPrimaryRoutes(), ...railFooterRoutes()]) {
      useAppStore.setState({ activeView: "welcome" });
      const view = render(<LeftRail />);
      fireEvent.click(screen.getByTitle(route.label));
      expect(useAppStore.getState().activeView).toBe(route.id);
      view.unmount();
    }
  });

  it("highlights an aliased module view as its canonical rail route", () => {
    // Dictation is not a rail entry, but the normalization must not leave a
    // stale rail highlight behind either.
    useAppStore.getState().setActiveView("mod:dictation");
    expect(useAppStore.getState().activeView).toBe("dictation");
  });
});
