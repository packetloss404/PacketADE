import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileText } from "lucide-react";
import { InputPopover, type InputPopoverItem } from "./InputPopover";

interface FileMentionPopoverProps {
  visible: boolean;
  projectPath: string;
  query: string;
  highlightedIndex: number;
  onSelect: (path: string) => void;
  /** Called whenever the fetched items change, so parents can drive
   *  keyboard navigation (ArrowUp/Down/Enter) synchronously. */
  onItemsChange?: (paths: string[]) => void;
}

export function FileMentionPopover({
  visible,
  projectPath,
  query,
  highlightedIndex,
  onSelect,
  onItemsChange,
}: FileMentionPopoverProps) {
  const [items, setItems] = useState<InputPopoverItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible) {
      onItemsChange?.([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const handle = setTimeout(async () => {
      try {
        const results = await invoke<string[]>("list_project_files", {
          projectPath,
          filter: query,
          limit: 20,
        });
        if (cancelled) return;
        const paths = results ?? [];
        const mapped: InputPopoverItem[] = paths.map((path) => ({
          key: path,
          label: path,
          icon: <FileText size={12} />,
        }));
        setItems(mapped);
        onItemsChange?.(paths);
      } catch {
        if (!cancelled) {
          setItems([]);
          onItemsChange?.([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 100);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [visible, projectPath, query, onItemsChange]);

  return (
    <InputPopover
      visible={visible}
      items={loading ? [] : items}
      highlightedIndex={highlightedIndex}
      onSelect={(item) => onSelect(item.key)}
      emptyLabel={loading ? "Searching..." : "No files found"}
    />
  );
}
