import { useEffect, useRef, useState } from "react";
import { acpSearchFiles } from "@/lib/tauri";

/**
 * The engine's own cap on `_packetcode/project/files` (`FILE_MENTION_LIMIT`
 * in `src-tauri/src/acp/`). Mirrored here so the popover slices to the same
 * number rather than assuming the list is unbounded — a future engine that
 * returns more must not be able to grow this menu without a deliberate edit.
 */
export const FILE_MENTION_LIMIT = 20;

/**
 * Debounce before each engine query. Every keystroke inside an `@token` would
 * otherwise be one round trip into a subprocess; this collapses a burst of
 * typing into a single search while staying under the ~150 ms that reads as
 * instant.
 */
export const FILE_SEARCH_DEBOUNCE_MS = 140;

export interface EngineFileSearchResult {
  /** Matches, engine-ranked, capped at `FILE_MENTION_LIMIT`. */
  paths: string[];
  /** A query is debouncing or in flight. */
  loading: boolean;
  /**
   * The most recent engine query REJECTED. The caller's contract is to fall
   * back to its pre-engine file source when this is true — a broken engine
   * must degrade the `@` menu to the local scan, never to an empty menu that
   * looks like "this project has no files".
   */
  failed: boolean;
}

/**
 * Project-file search for the `@` menu, served by the ACP engine.
 *
 * The engine owns the project's ignore rules, so it — not PacketADE's local
 * directory walk — is the authority on what `@` may mention in an engine
 * session. Each query is a subprocess round trip, hence the debounce; results
 * are superseded (not merged) by the next query, and a query that lands out
 * of order is discarded by the epoch check.
 *
 * Never throws: a rejection sets `failed` and leaves `paths` empty.
 */
export function useEngineFileSearch(
  cwd: string,
  query: string,
  enabled: boolean,
): EngineFileSearchResult {
  const [paths, setPaths] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  // Monotonic per-query epoch so a slow search can never land over a fresher
  // one (or setState after unmount).
  const epochRef = useRef(0);
  // Latch: once this engine has failed for this cwd, stop asking. Otherwise a
  // permanently-broken engine would take one round trip per keystroke while
  // the caller has already fallen back to its local scan. Cleared when the
  // project changes, so a different session gets a fresh attempt.
  const failedCwdRef = useRef<string | null>(null);

  useEffect(() => {
    if (failedCwdRef.current !== null && failedCwdRef.current !== cwd) {
      failedCwdRef.current = null;
      setFailed(false);
    }
    if (!enabled || !cwd || failedCwdRef.current === cwd) {
      epochRef.current++;
      setPaths([]);
      setLoading(false);
      return undefined;
    }

    const epoch = ++epochRef.current;
    setLoading(true);
    const timer = setTimeout(() => {
      acpSearchFiles(cwd, query)
        .then((hits) => {
          if (epochRef.current !== epoch) return;
          setPaths((Array.isArray(hits) ? hits : []).slice(0, FILE_MENTION_LIMIT));
          setFailed(false);
          setLoading(false);
        })
        .catch(() => {
          if (epochRef.current !== epoch) return;
          failedCwdRef.current = cwd;
          setPaths([]);
          setFailed(true);
          setLoading(false);
        });
    }, FILE_SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [cwd, query, enabled]);

  useEffect(
    () => () => {
      // Invalidate any in-flight search so it cannot setState after unmount.
      epochRef.current++;
    },
    [],
  );

  return { paths, loading, failed };
}
