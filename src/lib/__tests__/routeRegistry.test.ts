/**
 * D4 — the one navigation registry (audit finding P1-9 / UX-14).
 *
 * These are the drift guards: every `CoreView` must have a row, hotkeys must
 * be unique, palette entries must resolve to real routes, and the destinations
 * the audit named as missing from Ctrl+K must stay reachable.
 */
import { describe, expect, it } from "vitest";
import {
  ALL_ROUTES,
  ROUTE_REGISTRY,
  getRoute,
  hotkeyRoutes,
  paletteRoutes,
  railFooterRoutes,
  railPrimaryRoutes,
  resolveModuleAlias,
  resolveViewHotkey,
  resolveViewRouteId,
  routePaletteLabel,
  routeStatusLabel,
} from "@/lib/routeRegistry";
import { settingsDefinitionForSection } from "@/lib/settingsNavigation";
import { normalizeView, type CoreView } from "@/stores/appStore";
import { moduleRegistry } from "@/modules/registry";

/**
 * Literal list of every `CoreView`. `EXHAUSTIVE satisfies readonly CoreView[]`
 * plus the assignability check below makes a NEW CoreView a compile error here
 * as well as in the registry itself.
 */
const EXHAUSTIVE = [
  "welcome",
  "workspace",
  "agents",
  "packetcode",
  "issues",
  "flights",
  "history",
  "tools",
  "github",
  "memory",
  "dictation",
] as const satisfies readonly CoreView[];

// Compile-time proof the list above is complete: if a CoreView is added and
// not listed, this assignment fails to type-check.
type Listed = (typeof EXHAUSTIVE)[number];
const _exhaustive: Listed = null as unknown as CoreView;
void _exhaustive;

describe("ROUTE_REGISTRY exhaustiveness", () => {
  it("has one row per CoreView, keyed by its own id", () => {
    expect(Object.keys(ROUTE_REGISTRY).sort()).toEqual([...EXHAUSTIVE].sort());
    for (const [key, route] of Object.entries(ROUTE_REGISTRY)) {
      expect(route.id).toBe(key);
    }
  });

  it("gives every route a non-empty label and an icon", () => {
    for (const route of ALL_ROUTES) {
      expect(route.label.length).toBeGreaterThan(0);
      expect(route.icon).toBeTruthy();
    }
  });
});

describe("ROUTE_REGISTRY consistency", () => {
  it("binds each hotkey code and legacy glyph to exactly one route", () => {
    const codes = hotkeyRoutes().map((r) => r.hotkey.code);
    const legacy = hotkeyRoutes().map((r) => r.hotkey.legacyKey);
    expect(new Set(codes).size).toBe(codes.length);
    expect(new Set(legacy).size).toBe(legacy.length);
  });

  it("gives each rail group a unique, stable order", () => {
    for (const group of [railPrimaryRoutes(), railFooterRoutes()]) {
      const orders = group.map((r) => r.rail.order);
      expect(new Set(orders).size).toBe(orders.length);
      expect([...orders].sort((a, b) => a - b)).toEqual(orders);
    }
  });

  it("resolves every palette entry to a real route", () => {
    for (const route of paletteRoutes()) {
      expect(resolveViewRouteId(route.id)).toBe(route.id);
      expect(getRoute(route.id)).toBe(route);
      expect(routePaletteLabel(route).length).toBeGreaterThan(0);
    }
  });

  it("keeps palette keywords lowercase so query matching works", () => {
    for (const route of paletteRoutes()) {
      for (const kw of route.palette.keywords ?? []) {
        expect(kw).toBe(kw.toLowerCase());
      }
    }
  });

  it("only declares module linkage for modules that exist", () => {
    const moduleIds = moduleRegistry.map((m) => m.id);
    for (const route of ALL_ROUTES) {
      if (route.moduleId) expect(moduleIds).toContain(route.moduleId);
    }
  });
});

describe("Left Rail placement", () => {
  it("preserves the shipped rail order", () => {
    expect(railPrimaryRoutes().map((r) => r.id)).toEqual([
      "workspace",
      "agents",
      "packetcode",
      "flights",
      "issues",
      "memory",
      "github",
    ]);
    expect(railFooterRoutes().map((r) => r.id)).toEqual(["tools"]);
  });

  it("labels the rail entries as shipped", () => {
    expect(ROUTE_REGISTRY.flights.label).toBe("Flight Deck");
    // The rail row must keep agreeing with the pane heading in `GitHubView`
    // and the Settings section label, all three of which say "Git Hosts".
    expect(ROUTE_REGISTRY.github.label).toBe("Git Hosts");
    expect(ROUTE_REGISTRY.tools.label).toBe("Settings");
  });

  it("names the git-host route the same way Settings does", () => {
    // The rail said "GitHub" while the pane heading and the Settings section
    // both said "Git Hosts" — one product surface, two names. The route
    // serves GitHub *and* self-hosted Gitea/Forgejo, so "Git Hosts" is the
    // accurate one and this asserts the two tables cannot drift apart again.
    expect(ROUTE_REGISTRY.github.label).toBe(settingsDefinitionForSection("github").label);
  });
});

describe("command-palette coverage (audit P1-9)", () => {
  const paletteIds = paletteRoutes().map((r) => r.id);

  it.each(["agents", "flights", "dictation"] as const)(
    "exposes the previously missing %s destination",
    (id) => {
      expect(paletteIds).toContain(id);
    },
  );

  it("keeps the pre-existing destinations", () => {
    for (const id of ["workspace", "issues", "history", "github", "memory", "tools"] as const) {
      expect(paletteIds).toContain(id);
    }
  });

  it("hides Welcome, which is not a navigable destination", () => {
    expect(paletteIds).not.toContain("welcome");
  });
});

describe("Dictation route identity", () => {
  it("treats the core route as canonical and mod:dictation as an alias", () => {
    expect(resolveModuleAlias("dictation")).toBe("dictation");
    expect(resolveViewRouteId("mod:dictation")).toBe("dictation");
    expect(normalizeView("mod:dictation")).toBe("dictation");
    expect(normalizeView("dictation")).toBe("dictation");
  });

  it("leaves ordinary modules with their own identity", () => {
    expect(resolveModuleAlias("quality")).toBeNull();
    expect(normalizeView("mod:quality")).toBe("mod:quality");
    expect(resolveViewRouteId("mod:quality")).toBeNull();
  });

  it("reports one status label for either identity", () => {
    expect(routeStatusLabel("dictation")).toBe("Dictation");
    expect(routeStatusLabel("mod:dictation")).toBe("Dictation");
  });
});

describe("removed Cost Dashboard route (2026-07-31)", () => {
  it("has no registry row, so it is absent from rail, palette, hotkeys and status strip", () => {
    expect(Object.keys(ROUTE_REGISTRY)).not.toContain("cost_dashboard");
    expect(ALL_ROUTES.map((r) => r.id)).not.toContain("cost_dashboard");
    expect(paletteRoutes().map((r) => r.id)).not.toContain("cost_dashboard");
    expect(railPrimaryRoutes().map((r) => r.id)).not.toContain("cost_dashboard");
    expect(railFooterRoutes().map((r) => r.id)).not.toContain("cost_dashboard");
    expect(hotkeyRoutes().map((r) => r.id)).not.toContain("cost_dashboard");
  });

  it("no longer resolves as a view, so a persisted selection cannot strand the shell", () => {
    expect(resolveViewRouteId("cost_dashboard" as CoreView)).toBeNull();
    expect(getRoute("cost_dashboard" as CoreView)).toBeNull();
    expect(routeStatusLabel("cost_dashboard" as CoreView)).toBeNull();
  });
});

describe("status labels", () => {
  it("keeps the shipped Status Strip wording", () => {
    expect(routeStatusLabel("workspace")).toBe("Workspace");
    expect(routeStatusLabel("flights")).toBe("Flight Deck");
    // Pre-existing P2 wording mismatch, now visible in one place.
    expect(routeStatusLabel("tools")).toBe("Tools");
    expect(routeStatusLabel("welcome")).toBe("Welcome");
  });

  it("returns null for an unknown view", () => {
    expect(routeStatusLabel("mod:not-a-module")).toBeNull();
  });
});

describe("resolveViewHotkey", () => {
  const ev = (over: Partial<Parameters<typeof resolveViewHotkey>[0]>) => ({
    ctrlKey: true,
    shiftKey: true,
    key: "",
    ...over,
  });

  it("matches on the physical key, so chords work on any keyboard layout", () => {
    // AZERTY: physical Digit1 reports key "&" (and "1" with Shift). The code
    // is layout-independent, so the chord still resolves.
    expect(resolveViewHotkey(ev({ code: "Digit1", key: "&" }))).toBe("agents");
    expect(resolveViewHotkey(ev({ code: "Digit2", key: "é" }))).toBe("flights");
    expect(resolveViewHotkey(ev({ code: "Digit3", key: '"' }))).toBe("issues");
    expect(resolveViewHotkey(ev({ code: "Digit4", key: "'" }))).toBe("history");
    expect(resolveViewHotkey(ev({ code: "Digit5", key: "(" }))).toBe("tools");
    expect(resolveViewHotkey(ev({ code: "KeyW", key: "Z" }))).toBe("workspace");
    expect(resolveViewHotkey(ev({ code: "KeyD", key: "D" }))).toBe("dictation");
  });

  it("still honours the historical shifted glyphs when code is absent", () => {
    expect(resolveViewHotkey(ev({ key: "!" }))).toBe("agents");
    expect(resolveViewHotkey(ev({ key: "@" }))).toBe("flights");
    expect(resolveViewHotkey(ev({ key: "#" }))).toBe("issues");
    expect(resolveViewHotkey(ev({ key: "$" }))).toBe("history");
    expect(resolveViewHotkey(ev({ key: "%" }))).toBe("tools");
    expect(resolveViewHotkey(ev({ key: "W" }))).toBe("workspace");
    expect(resolveViewHotkey(ev({ key: "D" }))).toBe("dictation");
  });

  it("requires both modifiers", () => {
    expect(resolveViewHotkey(ev({ ctrlKey: false, code: "Digit1" }))).toBeNull();
    expect(resolveViewHotkey(ev({ shiftKey: false, code: "Digit1" }))).toBeNull();
  });

  it("returns null for unbound keys", () => {
    expect(resolveViewHotkey(ev({ code: "Digit9", key: "(" }))).toBeNull();
  });
});
