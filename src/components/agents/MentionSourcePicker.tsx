import { FileMentionPopover } from "./FileMentionPopover";

interface MentionSourcePickerProps {
  visible: boolean;
  projectPath: string;
  /** Free-text query as typed after the `@`. */
  query: string;
  highlightedIndex: number;
  /**
   * Called when the user picks/commits a mention. The value is the formatted
   * insertion string (e.g. `@src/foo.ts`).
   */
  onSelect: (insertion: string) => void;
  /** Forwarded to FileMentionPopover for keyboard nav. */
  onItemsChange?: (paths: string[]) => void;
}

/**
 * File `@`-mention picker for the chat composer. Defers entirely to
 * `FileMentionPopover`; its job is formatting the picked path into the
 * `@<path>` insertion token the composer splices into the input.
 */
export function MentionSourcePicker({
  visible,
  projectPath,
  query,
  highlightedIndex,
  onSelect,
  onItemsChange,
}: MentionSourcePickerProps) {
  if (!visible) return null;

  return (
    <div className="absolute bottom-full mb-1 left-0 z-50">
      <FileMentionPopover
        visible
        projectPath={projectPath}
        query={query}
        highlightedIndex={highlightedIndex}
        onSelect={(path) => onSelect(`@${path.trim()}`)}
        onItemsChange={onItemsChange}
        floating={false}
      />
    </div>
  );
}
