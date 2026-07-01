import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight, Settings2 } from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";
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
  const [open, setOpen] = useState<boolean>(
    // Force-open wins even when a stored "0" exists, so active non-default
    // settings are always revealed on first mount.
    () => forceOpenOnFirstMount || loadOpen(forceOpenOnFirstMount),
  );
  // The collapse animation clips content with `overflow-hidden`, but child
  // pickers (ProfilePicker) open absolutely-positioned dropdown menus that
  // must escape that box. Re-allow overflow only once the expand transition
  // has settled so those menus aren't clipped.
  const [overflowVisible, setOverflowVisible] = useState<boolean>(
    () => forceOpenOnFirstMount || loadOpen(forceOpenOnFirstMount),
  );

  useEffect(() => {
    persistOpen(open);
    if (!open) {
      setOverflowVisible(false);
      return;
    }
    const id = window.setTimeout(() => setOverflowVisible(true), 220);
    return () => window.clearTimeout(id);
  }, [open]);

  const activeBits = summary
    .filter((s) => s.label !== null)
    .map((s) => truncate(s.label as string, s.maxChars));
  const hasActive = activeBits.length > 0;

  return (
    <div className="flex flex-col">
      <div className="self-start">
        <Tooltip
          content={open ? "Hide advanced settings" : "Show advanced settings"}
        >
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-1 text-[10px] text-text-muted hover:text-text-primary transition-colors"
            aria-expanded={open}
          >
            <ChevronRight
              size={10}
              className={`transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
            />
            <Settings2 size={10} />
            <span>Advanced</span>
            {!open && hasActive && (
              <span className="text-text-secondary">
                ({activeBits.join(", ")})
              </span>
            )}
          </button>
        </Tooltip>
      </div>
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div
          className={`${overflowVisible ? "overflow-visible" : "overflow-hidden"} transition-opacity duration-200 motion-reduce:transition-none ${open ? "opacity-100" : "opacity-0"}`}
        >
          <div className="flex flex-wrap items-center gap-2 pt-2">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
