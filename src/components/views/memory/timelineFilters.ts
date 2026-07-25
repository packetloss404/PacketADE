// M10 — Timeline type-filter chips.
//
// `task_completed` is intentionally ABSENT here. Nothing emits that event type
// anymore: the autonomous task scheduler that produced it was removed in July
// 2026, so the "Tasks" chip was a permanently-empty surface. The type itself
// stays in the MemoryEvent union (and MemoryEventCard still renders it) purely
// for read-compatibility with any events persisted before the scheduler was
// amputated — but we no longer offer a dedicated, always-zero filter for it.

import type { MemoryEventType } from "@/types/memory";

export type FilterType = "all" | MemoryEventType;

export const TIMELINE_FILTERS: { key: FilterType; label: string }[] = [
  { key: "all", label: "All" },
  { key: "session_completed", label: "Sessions" },
  { key: "flight_completed", label: "Flights" },
  { key: "manual_note", label: "Notes" },
];
