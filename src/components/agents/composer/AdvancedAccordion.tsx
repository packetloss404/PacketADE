import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Settings2 } from "lucide-react";
import { storageKey } from "@/lib/brand";

const OPEN_STORAGE_KEY = storageKey("composer-advanced-open");

export interface AdvancedAccordionSummaryItem {
  /** Short label like "Manual", "Reviewer", "Worktree". Pass `null` when
   * the picker is at its default — those slots are omitted from the
   * collapsed summary. */
  label: string | null;
  /** Optional truncation cap; defaults to no truncation. ProfilePicker
   * uses 12 chars since profile names can be long. */
  maxChars?: number;
}

interface AdvancedAccordionProps {
  /** When all three summary items are null we omit the section label entirely
   * — the audit win is hiding noise for default users. */
  summary: AdvancedAccordionSummaryItem[];
  /** Force expanded on first render when any picker is non-default, so the
   * user can see what's active. Subsequent toggles are user-controlled and
   * persisted. */
  forceOpenOnFirstMount?: boolean;
  children: ReactNode;
}

function loadOpen(forceOpen: boolean): boolean {
  if (typeof localStorage === "undefined") return forceOpen;
  try {
    const raw = localStorage.getItem(OPEN_STORAGE_KEY);
    if (raw === null) return forceOpen;
    return raw === "1";
  } catch {
    return forceOpen;
  }
}

function persistOpen(open: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(OPEN_STORAGE_KEY, open ? "1" : "0");
  } catch {
    // ignore
  }
}

function truncate(label: string, max: number | undefined): string {
  if (!max || label.length <= max) return label;
  return label.slice(0, max - 1) + "…";
}

export function AdvancedAccordion({
  summary,
  forceOpenOnFirstMount = false,
  children,
}: AdvancedAccordionProps) {
  const [open, setOpen] = useState<boolean>(() => loadOpen(forceOpenOnFirstMount));

  useEffect(() => {
    persistOpen(open);
  }, [open]);

  const activeBits = summary
    .filter((s) => s.label !== null)
    .map((s) => truncate(s.label as string, s.maxChars));
  const hasActive = activeBits.length > 0;

  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[10px] text-text-muted hover:text-text-primary transition-colors self-start"
        title={open ? "Hide advanced settings" : "Show advanced settings"}
        aria-expanded={open}
      >
        <Chevron size={10} />
        <Settings2 size={10} />
        <span>Advanced</span>
        {!open && hasActive && (
          <span className="text-text-secondary">
            ({activeBits.join(", ")})
          </span>
        )}
      </button>
      {open && (
        <div className="flex flex-wrap items-center gap-2 mt-2">{children}</div>
      )}
    </div>
  );
}
