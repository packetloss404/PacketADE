/**
 * Stable per-CLI-account identity colors.
 *
 * Multi-account CLI support lets one workspace run `claude-code` under a
 * "Personal / OSS" login in one tile and a "Client work" login in the next.
 * The two tiles are otherwise pixel-identical, so a text label alone is too
 * easy to skim past — every account gets a stable color that the header chip
 * and the tab-strip dot both use.
 *
 * Mirrors `lib/agentColors.ts`: dependency-free, returns design-token
 * classNames only (never raw Tailwind colors), and the mapping is a pure
 * function of the account id so the same account is the same color in every
 * surface and across restarts.
 */

import type { AgentColor } from "@/lib/agentColors";

/**
 * The identity palette, in assignment order. Drawn from the Graphite accent
 * tokens — the only colors the theme guarantees. `accent-red` is included
 * last: inside a labelled account chip it reads as identity rather than
 * error, and it is only reached once four accounts already exist.
 */
const ACCOUNT_COLORS: readonly AgentColor[] = [
  {
    text: "text-accent-purple",
    bg: "bg-accent-purple/10",
    border: "border-accent-purple/30",
  },
  { text: "text-accent-blue", bg: "bg-accent-blue/10", border: "border-accent-blue/30" },
  { text: "text-accent-amber", bg: "bg-accent-amber/10", border: "border-accent-amber/30" },
  { text: "text-accent-green", bg: "bg-accent-green/10", border: "border-accent-green/30" },
  { text: "text-accent-red", bg: "bg-accent-red/10", border: "border-accent-red/30" },
];

/** Neutral bundle for panes with no explicit account (ambient login). */
const AMBIENT: AgentColor = {
  text: "text-text-secondary",
  bg: "bg-bg-elevated",
  border: "border-bg-border",
};

/** FNV-1a — small, stable, and dependency-free. Same id ⇒ same bucket, always. */
function hashAccountId(accountId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < accountId.length; i++) {
    hash ^= accountId.charCodeAt(i);
    // Math.imul keeps the 32-bit multiply exact across JS engines.
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Stable identity colors for a CLI account.
 *
 * A null/undefined/empty id means "ambient login" — the neutral bundle, so an
 * ambient pane renders nothing that looks like an account binding.
 *
 * For a solid identity dot, pair `.text` with `bg-current` on the same span,
 * exactly like `getAgentColor`.
 */
export function getAccountColor(accountId: string | null | undefined): AgentColor {
  if (!accountId) return AMBIENT;
  return ACCOUNT_COLORS[hashAccountId(accountId) % ACCOUNT_COLORS.length];
}

/** Palette size — exported for tests that assert full coverage. */
export const ACCOUNT_COLOR_COUNT = ACCOUNT_COLORS.length;
