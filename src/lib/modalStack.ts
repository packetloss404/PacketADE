/**
 * Registry of currently-open `ui/Modal` instances.
 *
 * Escape used to be handled by a per-modal `window` keydown listener. That
 * makes the OUTER dialog win whenever modals nest: it registered its listener
 * first, so it fires first, calls `preventDefault()`, and the inner dialog
 * bails on `defaultPrevented`. `stopPropagation()` cannot help — both handlers
 * sit on the same target, and only `stopImmediatePropagation` would reach them.
 *
 * Every mounted Modal registers here instead, and the Escape handler acts only
 * when its own instance is top-most. `isModalOpen` additionally lets the app
 * shell suppress view-switching chords, which would otherwise unmount the view
 * underneath an open dialog and destroy a half-typed form.
 *
 * "Top-most" orders by React nesting depth first and registration order second.
 * Depth has to lead: React runs child effects before parent effects, so a
 * dialog rendered inside another dialog's children registers FIRST and raw
 * ordering would get that case exactly backwards.
 */

interface ModalStackEntry {
  id: string;
  /** 1-based nesting depth from `ModalDepthContext`. */
  depth: number;
  /** Monotonic registration order, used to break depth ties between siblings. */
  seq: number;
}

let seqCounter = 0;
const entries: ModalStackEntry[] = [];

function outranks(a: ModalStackEntry, b: ModalStackEntry): boolean {
  if (a.depth !== b.depth) return a.depth > b.depth;
  return a.seq > b.seq;
}

export function registerModal(id: string, depth: number): void {
  const existing = entries.findIndex((e) => e.id === id);
  if (existing !== -1) entries.splice(existing, 1);
  entries.push({ id, depth, seq: ++seqCounter });
}

export function unregisterModal(id: string): void {
  const index = entries.findIndex((e) => e.id === id);
  if (index !== -1) entries.splice(index, 1);
}

/** True when `id` is the dialog a keypress should be routed to. */
export function isTopModal(id: string): boolean {
  let top: ModalStackEntry | null = null;
  for (const entry of entries) {
    if (!top || outranks(entry, top)) top = entry;
  }
  return top?.id === id;
}

export function isModalOpen(): boolean {
  return entries.length > 0;
}

export function modalStackSize(): number {
  return entries.length;
}

/** Test-only escape hatch for suites that unmount without running cleanup. */
export function resetModalStack(): void {
  entries.length = 0;
  seqCounter = 0;
}
