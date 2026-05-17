import { useCallback, useState } from "react";

export interface PrefixMatchState {
  active: boolean;
  query: string;
  /** Position of the trigger character in the textarea value. */
  prefixIndex: number;
  highlightedIndex: number;
}

const INITIAL_STATE: PrefixMatchState = {
  active: false,
  query: "",
  prefixIndex: -1,
  highlightedIndex: 0,
};

export interface UsePrefixMatcherResult {
  state: PrefixMatchState;
  /** Recompute state from the current textarea value + caret. Returns the
   * new detection (or null) for the caller to chain. */
  detect: (value: string, caret: number) => { prefixIndex: number; query: string } | null;
  /** Set the highlighted index, with bounds-checking against `itemCount`. */
  setHighlighted: (next: number, itemCount: number) => void;
  /** Move highlight ±1 wrapping. */
  moveHighlight: (delta: 1 | -1, itemCount: number) => void;
  /** Adjust highlight after an external item list change (e.g. async
   * directory scan returns); clamps to [0, itemCount). */
  clampHighlight: (itemCount: number) => void;
  close: () => void;
}

/**
 * Unified state machine for trigger-character pickers (`@` for file mentions,
 * `/` for slash-command templates). The trigger must be at start-of-input or
 * preceded by whitespace; otherwise a stray slash mid-word ("either/or")
 * would pop the menu.
 */
export function usePrefixMatcher(prefix: string): UsePrefixMatcherResult {
  const [state, setState] = useState<PrefixMatchState>(INITIAL_STATE);

  const detect = useCallback(
    (value: string, caret: number) => {
      for (let i = caret - 1; i >= 0; i--) {
        const ch = value[i];
        if (ch === prefix) {
          const prev = i === 0 ? "" : value[i - 1];
          if (i === 0 || /\s/.test(prev)) {
            const hit = { prefixIndex: i, query: value.slice(i + 1, caret) };
            setState((prev2) => ({
              active: true,
              query: hit.query,
              prefixIndex: hit.prefixIndex,
              highlightedIndex:
                prev2.active && prev2.query === hit.query
                  ? prev2.highlightedIndex
                  : 0,
            }));
            return hit;
          }
          setState(INITIAL_STATE);
          return null;
        }
        if (/\s/.test(ch)) {
          setState(INITIAL_STATE);
          return null;
        }
      }
      setState(INITIAL_STATE);
      return null;
    },
    [prefix],
  );

  const setHighlighted = useCallback((next: number, itemCount: number) => {
    setState((prev) => ({
      ...prev,
      highlightedIndex: itemCount === 0 ? 0 : Math.max(0, Math.min(next, itemCount - 1)),
    }));
  }, []);

  const moveHighlight = useCallback((delta: 1 | -1, itemCount: number) => {
    setState((prev) => ({
      ...prev,
      highlightedIndex:
        itemCount === 0
          ? 0
          : (prev.highlightedIndex + delta + itemCount) % itemCount,
    }));
  }, []);

  const clampHighlight = useCallback((itemCount: number) => {
    setState((prev) => {
      if (!prev.active) return prev;
      if (prev.highlightedIndex >= itemCount) {
        return { ...prev, highlightedIndex: 0 };
      }
      return prev;
    });
  }, []);

  const close = useCallback(() => setState(INITIAL_STATE), []);

  return { state, detect, setHighlighted, moveHighlight, clampHighlight, close };
}
