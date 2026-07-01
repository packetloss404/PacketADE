import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

type Placement = "bottom-start" | "bottom-end" | "top-start" | "top-end";

interface PopoverProps {
  /** Element the popover is anchored to. Provide this or `trigger`. */
  anchorRef?: RefObject<HTMLElement | null>;
  /** Inline trigger rendered by the popover; its wrapper becomes the anchor
   *  when `anchorRef` is not supplied. Open/close is still controlled by the
   *  parent via `open`/`onClose`. */
  trigger?: ReactNode;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  placement?: Placement;
  /** Semantic role for the panel. Use "menu" for action lists. */
  role?: "dialog" | "menu";
  className?: string;
}

/** Gap in px between the anchor and the popover panel. */
const GAP = 4;
/** Minimum distance the panel keeps from the viewport edge. */
const MARGIN = 8;

export function Popover({
  anchorRef,
  trigger,
  open,
  onClose,
  children,
  placement = "bottom-start",
  role = "dialog",
  className = "",
}: PopoverProps) {
  const internalAnchorRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const [side, setSide] = useState<"top" | "bottom">(
    placement.startsWith("top") ? "top" : "bottom",
  );

  const getAnchor = useCallback(
    (): HTMLElement | null => anchorRef?.current ?? internalAnchorRef.current,
    [anchorRef],
  );

  // Measure + position with basic viewport-flip collision. Runs whenever the
  // popover opens and on scroll/resize while open.
  useLayoutEffect(() => {
    if (!open) return;

    const reposition = () => {
      const anchor = getAnchor();
      const panel = panelRef.current;
      if (!anchor || !panel) return;

      const a = anchor.getBoundingClientRect();
      const pw = panel.offsetWidth;
      const ph = panel.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      const wantsTop = placement.startsWith("top");
      const wantsEnd = placement.endsWith("end");

      // Vertical flip: keep the requested side unless it would clip and the
      // opposite side has more room.
      let nextSide: "top" | "bottom" = wantsTop ? "top" : "bottom";
      const spaceBelow = vh - a.bottom;
      const spaceAbove = a.top;
      if (nextSide === "bottom" && spaceBelow < ph + GAP + MARGIN && spaceAbove > spaceBelow) {
        nextSide = "top";
      } else if (nextSide === "top" && spaceAbove < ph + GAP + MARGIN && spaceBelow > spaceAbove) {
        nextSide = "bottom";
      }

      let top = nextSide === "bottom" ? a.bottom + GAP : a.top - ph - GAP;
      let left = wantsEnd ? a.right - pw : a.left;

      // Clamp horizontally into the viewport.
      left = Math.max(MARGIN, Math.min(left, vw - pw - MARGIN));
      // Clamp vertically as a final guard.
      top = Math.max(MARGIN, Math.min(top, vh - ph - MARGIN));

      setSide(nextSide);
      setCoords({ top, left });
    };

    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, placement, getAnchor]);

  // Reset measured coords when closed so the next open re-measures cleanly.
  useEffect(() => {
    if (!open) setCoords(null);
  }, [open]);

  // Outside-click (mousedown) + Escape to close. Clicks on the anchor are
  // ignored here so the parent's own toggle handler stays in control.
  useEffect(() => {
    if (!open) return;
    const handlePointer = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (getAnchor()?.contains(target)) return;
      onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open, onClose, getAnchor]);

  const panel = open ? (
    <div
      ref={panelRef}
      role={role}
      style={{
        position: "fixed",
        top: coords?.top ?? 0,
        left: coords?.left ?? 0,
        // Keep the panel invisible until measured to avoid a positioning flash.
        visibility: coords ? "visible" : "hidden",
      }}
      className={`z-50 ${side === "top" ? "origin-bottom" : "origin-top"} bg-bg-secondary border border-bg-border rounded shadow-xl animate-[popoverIn_120ms_ease-out] motion-reduce:animate-none ${className}`}
    >
      {children}
    </div>
  ) : null;

  if (trigger !== undefined) {
    return (
      <>
        <span ref={internalAnchorRef} className="contents">
          {trigger}
        </span>
        {panel && createPortal(panel, document.body)}
      </>
    );
  }

  return panel ? createPortal(panel, document.body) : null;
}
