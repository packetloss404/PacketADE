import { useEffect, useState } from "react";

/**
 * Live viewport width, used by the `RightDock` width contract (D2 / P0-2) so
 * the dock re-clamps itself when the window is resized instead of holding a
 * width that starves the centre canvas.
 */
export function useViewportWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setWidth(window.innerWidth);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return width;
}
