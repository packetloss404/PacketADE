import { useEffect } from "react";
import { useSideChatStore } from "@/stores/sideChatStore";

/**
 * Mounts a global Cmd/Ctrl+; (semicolon) listener that toggles the side
 * chat overlay. Mount once near the app root.
 */
export function useSideChatHotkey(): void {
  const toggle = useSideChatStore((s) => s.toggle);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      // `e.key` is ";" for both unshifted semicolon and (on some layouts)
      // shifted colon — match either to be forgiving.
      if (isMod && (e.key === ";" || e.key === ":")) {
        e.preventDefault();
        toggle();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggle]);
}
