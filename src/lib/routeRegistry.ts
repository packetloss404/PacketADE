/**
 * D4 — the single navigation registry.
 *
 * Audit finding P1-9 / UX-14 (dev/main-shell-navigation-and-right-panel-audit-2026-07-29.md):
 * route labels, icons, ordering, palette visibility and hotkeys used to be
 * duplicated across `LeftRail`, `StatusStrip`, `CommandPalette`,
 * `lib/viewHotkeys` and the modules registry, and had drifted (the palette
 * omitted Agents, Flight Deck and the canonical Dictation entry, and Dictation
 * had two route identities).
 *
 * This module is now the ONE place a shell route's presentation is declared.
 * Adding a `CoreView` without a registry row is a compile error, and every
 * consumer derives its list from `ROUTE_REGISTRY`.
 *
 * Renames land here too: the "GitHub → Git Hosts" rail rename was a one-line
 * change in this table.
 */
import {
  Bot,
  Brain,
  Clock,
  Github,
  Home,
  KanbanSquare,
  MessageSquare,
  Mic,
  Plane,
  Settings,
  Terminal,
  Ticket,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
// Type-only import: erased at build time, so there is no runtime import cycle
// even though `appStore` imports this module for alias normalization.
import type { AppView, CoreView } from "@/stores/appStore";

/** Where (if anywhere) a route appears in the Left Rail. */
export type RailPlacement = "primary" | "footer" | "none";

/**
 * A Ctrl+Shift chord binding.
 *
 * `code` is the physical `KeyboardEvent.code` (US-QWERTY reference positions),
 * which is layout-independent: Ctrl+Shift+<physical 1> resolves the same on
 * AZERTY/QWERTZ/Dvorak as it does on US QWERTY. `legacyKey` keeps the old
 * shifted-glyph matching alive as a fallback for environments that do not
 * report `code` (and preserves the historical `VIEW_HOTKEY_MAP` contract).
 */
export interface RouteHotkey {
  /** Physical key, e.g. "Digit1" / "KeyW". Layout independent. */
  code: string;
  /** Historical shifted-character fallback, e.g. "!" for Shift+1. */
  legacyKey: string;
  /** Human-facing chord label, e.g. "Ctrl+Shift+1". */
  display: string;
}

/** Command-palette presentation for a route. */
export interface RoutePalette {
  /** Whether Ctrl+K can reach this route. */
  visible: boolean;
  /** Palette row label; falls back to {@link RouteMeta.label}. */
  label?: string;
  description?: string;
  /** Palette icon override (the palette historically uses softer glyphs). */
  icon?: LucideIcon;
  iconColor?: string;
  keywords?: string[];
}

export interface RouteMeta {
  id: CoreView;
  /** Canonical label — Left Rail tooltip and default palette/status label. */
  label: string;
  /** Rail icon. */
  icon: LucideIcon;
  rail: {
    placement: RailPlacement;
    /** Ascending sort order inside the placement group. */
    order: number;
  };
  palette: RoutePalette;
  hotkey?: RouteHotkey;
  /**
   * Status Strip label when it differs from {@link label}. Retained so the
   * pre-existing Settings/"Tools" wording mismatch (a P2 item) stays visible
   * in one place instead of drifting across files.
   */
  statusLabel?: string;
  /**
   * Module linkage. When set, the `mod:<moduleId>` view is an ALIAS of this
   * core route: navigation normalizes to the core id and the palette lists the
   * route once (see `resolveModuleAlias`). The module manifest still owns
   * enable/disable state in Settings → Modules.
   */
  moduleId?: string;
}

/**
 * The registry. `Record<CoreView, RouteMeta>` makes a missing route a compile
 * error; `ROUTE_REGISTRY_CONSISTENCY` in the tests covers the rest.
 */
export const ROUTE_REGISTRY: Record<CoreView, RouteMeta> = {
  welcome: {
    id: "welcome",
    label: "Welcome",
    icon: Home,
    rail: { placement: "none", order: 0 },
    palette: { visible: false },
  },
  workspace: {
    id: "workspace",
    label: "Workspace",
    icon: Terminal,
    rail: { placement: "primary", order: 10 },
    palette: {
      visible: true,
      description: "View active workspace panes",
      icon: MessageSquare,
      iconColor: "text-accent-green",
      keywords: ["sessions", "claude", "codex", "terminal", "pane", "packetcode"],
    },
    hotkey: { code: "KeyW", legacyKey: "W", display: "Ctrl+Shift+W" },
  },
  agents: {
    id: "agents",
    label: "Agents",
    icon: Bot,
    rail: { placement: "primary", order: 20 },
    palette: {
      visible: true,
      description: "Agent conversations and inspector",
      iconColor: "text-accent-green",
      keywords: ["agent", "conversation", "chat", "inspector", "api"],
    },
    hotkey: { code: "Digit1", legacyKey: "!", display: "Ctrl+Shift+1" },
  },
  flights: {
    id: "flights",
    label: "Flight Deck",
    icon: Plane,
    rail: { placement: "primary", order: 30 },
    palette: {
      visible: true,
      description: "Plan and launch flights",
      iconColor: "text-accent-blue",
      keywords: ["flight", "deck", "mission", "attempt", "worktree", "launch"],
    },
    hotkey: { code: "Digit2", legacyKey: "@", display: "Ctrl+Shift+2" },
  },
  issues: {
    id: "issues",
    label: "Issues",
    icon: KanbanSquare,
    rail: { placement: "primary", order: 40 },
    palette: {
      visible: true,
      label: "Issues Board",
      description: "Kanban issue tracker",
      icon: Ticket,
      iconColor: "text-accent-amber",
      keywords: ["kanban", "tickets", "board", "todo"],
    },
    hotkey: { code: "Digit3", legacyKey: "#", display: "Ctrl+Shift+3" },
  },
  memory: {
    id: "memory",
    label: "Memory",
    icon: Brain,
    rail: { placement: "primary", order: 50 },
    palette: {
      visible: true,
      description: "AI memory and file map",
      iconColor: "text-accent-purple",
      keywords: ["context", "knowledge", "files"],
    },
  },
  // Named "Git Hosts", not "GitHub": the pane heading and the Settings section
  // already say "Git Hosts", and the route serves GitHub *and* self-hosted
  // Gitea/Forgejo. The rail was the last surface still naming only one vendor.
  github: {
    id: "github",
    label: "Git Hosts",
    icon: Github,
    rail: { placement: "primary", order: 60 },
    palette: {
      visible: true,
      description: "GitHub, Gitea and Forgejo integration",
      iconColor: "text-text-primary",
      keywords: ["git", "repo", "pr", "pull request", "gitea", "forgejo", "host"],
    },
  },
  history: {
    id: "history",
    label: "History",
    icon: Clock,
    rail: { placement: "none", order: 0 },
    palette: {
      visible: true,
      label: "Session History",
      description: "Browse past sessions",
      iconColor: "text-text-secondary",
      keywords: ["past", "log", "previous"],
    },
    hotkey: { code: "Digit4", legacyKey: "$", display: "Ctrl+Shift+4" },
  },
  // NOTE: there is deliberately no `cost_dashboard` row. The cost REPORTING
  // surface (Cost Dashboard view + toolbar spend chip) was removed on
  // 2026-07-31 — see dev/cost-efficiency-loop.md. Cost data still exists and
  // still drives the budget guardrails; only the dollars-on-screen UI is gone.
  dictation: {
    id: "dictation",
    label: "Dictation",
    icon: Mic,
    rail: { placement: "none", order: 0 },
    palette: {
      visible: true,
      description: "Voice-to-text with local Whisper transcription",
      iconColor: "text-accent-purple",
      keywords: ["voice", "speech", "whisper", "transcribe", "microphone", "vt"],
    },
    hotkey: { code: "KeyD", legacyKey: "D", display: "Ctrl+Shift+D" },
    // Dictation's canonical identity is the core `"dictation"` route.
    // `mod:dictation` is an alias, normalized away in `appStore.normalizeView`.
    moduleId: "dictation",
  },
  // Rail footer: the Settings destination. `statusLabel` preserves the
  // pre-existing Status Strip wording ("Tools"); reconciling the two is a
  // separate P2 item and is now a one-line change here.
  tools: {
    id: "tools",
    label: "Settings",
    icon: Settings,
    rail: { placement: "footer", order: 10 },
    palette: {
      visible: true,
      label: "Settings",
      description: "Project and app settings",
      icon: Wrench,
      iconColor: "text-text-muted",
      keywords: ["config", "preferences", "options", "tools", "modules"],
    },
    hotkey: { code: "Digit5", legacyKey: "%", display: "Ctrl+Shift+5" },
    statusLabel: "Tools",
  },
};

/** All routes, in a stable declaration-independent order. */
export const ALL_ROUTES: RouteMeta[] = Object.values(ROUTE_REGISTRY);

function byRailOrder(a: RouteMeta, b: RouteMeta): number {
  return a.rail.order - b.rail.order;
}

/** Left Rail primary group, in render order. */
export function railPrimaryRoutes(): RouteMeta[] {
  return ALL_ROUTES.filter((r) => r.rail.placement === "primary").sort(byRailOrder);
}

/** Left Rail footer group (pinned to the bottom), in render order. */
export function railFooterRoutes(): RouteMeta[] {
  return ALL_ROUTES.filter((r) => r.rail.placement === "footer").sort(byRailOrder);
}

/**
 * Command-palette routes, in rail-then-declaration order so the palette reads
 * like the rail with the non-rail destinations appended.
 */
export function paletteRoutes(): RouteMeta[] {
  const rank = (r: RouteMeta) => (r.rail.placement === "none" ? 1000 + r.rail.order : r.rail.order);
  return ALL_ROUTES.filter((r) => r.palette.visible).sort((a, b) => rank(a) - rank(b));
}

/** Palette row label (falls back to the canonical label). */
export function routePaletteLabel(route: RouteMeta): string {
  return route.palette.label ?? route.label;
}

/** Palette row icon (falls back to the rail icon). */
export function routePaletteIcon(route: RouteMeta): LucideIcon {
  return route.palette.icon ?? route.icon;
}

/** Status Strip label for any view, including module views. `null` if unknown. */
export function routeStatusLabel(view: AppView): string | null {
  const route = getRoute(view);
  if (!route) return null;
  return route.statusLabel ?? route.label;
}

/** Core id behind a view, resolving `mod:<id>` aliases. `null` if not a route. */
export function resolveViewRouteId(view: AppView): CoreView | null {
  if (view.startsWith("mod:")) {
    return resolveModuleAlias(view.slice(4));
  }
  return view in ROUTE_REGISTRY ? (view as CoreView) : null;
}

/** Registry row for a view, resolving `mod:<id>` aliases. */
export function getRoute(view: AppView): RouteMeta | null {
  const id = resolveViewRouteId(view);
  return id ? ROUTE_REGISTRY[id] : null;
}

/**
 * Module id → canonical core route, for modules that also exist as a first
 * class shell route (currently only Dictation). Returns `null` for ordinary
 * modules, whose `mod:<id>` view stays their real identity.
 */
export function resolveModuleAlias(moduleId: string): CoreView | null {
  const route = ALL_ROUTES.find((r) => r.moduleId === moduleId);
  return route ? route.id : null;
}

/** A route known to declare a hotkey. */
export type BoundRoute = RouteMeta & { hotkey: RouteHotkey };

/** Every route that declares a hotkey. */
export function hotkeyRoutes(): BoundRoute[] {
  return ALL_ROUTES.filter((r): r is BoundRoute => Boolean(r.hotkey));
}

/** Minimal shape of the keyboard event fields hotkey resolution needs. */
export interface HotkeyEventLike {
  ctrlKey: boolean;
  shiftKey: boolean;
  /** Physical key. Optional so synthetic/legacy events still resolve. */
  code?: string;
  key: string;
}

/**
 * Resolve a Ctrl+Shift chord to a view.
 *
 * Physical-key (`event.code`) matching first, so the chords work on every
 * keyboard layout — this replaces the old shifted-glyph-only map, whose
 * documented caveat was that Shift+1 is not "!" outside US layouts. The
 * shifted-glyph map is still consulted as a fallback.
 */
export function resolveViewHotkey(e: HotkeyEventLike): CoreView | null {
  if (!e.ctrlKey || !e.shiftKey) return null;
  for (const route of hotkeyRoutes()) {
    if (e.code && e.code === route.hotkey.code) return route.id;
  }
  for (const route of hotkeyRoutes()) {
    if (e.key === route.hotkey.legacyKey) return route.id;
  }
  return null;
}
