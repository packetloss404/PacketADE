import { useCallback, useEffect, useRef, useState } from "react";
import type { ImageAttachment } from "@/lib/tauri";
import { fileToImageAttachment, MAX_IMAGE_BYTES } from "../composer/utils";

/** A pending image attachment shown as a chip in the composer. Keeps both
 * the wire-shape `attachment` and a transient preview URL so the chip can
 * render a thumbnail without re-decoding the base64. */
export type StagedAttachment = {
  id: string;
  name: string;
  sizeBytes: number;
  attachment: ImageAttachment;
  previewUrl: string;
};

export interface UseAttachmentStagingResult {
  staged: StagedAttachment[];
  addFiles: (files: File[]) => Promise<void>;
  removeStaged: (id: string) => void;
  clear: () => void;
}

/** Encapsulates the staged-image subsystem: queued attachments, object-URL
 * lifecycle (revoke on remove/unmount), and the addFiles entrypoint used by
 * paste + drag-drop. */
export function useAttachmentStaging(): UseAttachmentStagingResult {
  const [staged, setStaged] = useState<StagedAttachment[]>([]);
  const stagedPreviewUrlsRef = useRef<Set<string>>(new Set());

  const addFiles = useCallback(async (files: File[]) => {
    const next: StagedAttachment[] = [];
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      if (file.size > MAX_IMAGE_BYTES) {
        console.warn(`Skipping ${file.name}: ${file.size} bytes > 5MB cap`);
        continue;
      }
      try {
        const attachment = await fileToImageAttachment(file);
        next.push({
          id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: file.name || "pasted-image",
          sizeBytes: file.size,
          attachment,
          previewUrl: URL.createObjectURL(file),
        });
      } catch (err) {
        console.warn("Failed to read attachment:", err);
      }
    }
    if (next.length > 0) {
      setStaged((prev) => [...prev, ...next]);
    }
  }, []);

  const removeStaged = useCallback((id: string) => {
    setStaged((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const clear = useCallback(() => setStaged([]), []);

  // Revoke preview URLs as staged attachments are removed or replaced.
  useEffect(() => {
    const nextUrls = new Set(staged.map((s) => s.previewUrl));
    for (const url of stagedPreviewUrlsRef.current) {
      if (!nextUrls.has(url)) {
        URL.revokeObjectURL(url);
      }
    }
    stagedPreviewUrlsRef.current = nextUrls;
  }, [staged]);

  // Cleanup any remaining object URLs on unmount.
  useEffect(() => {
    return () => {
      for (const url of stagedPreviewUrlsRef.current) {
        URL.revokeObjectURL(url);
      }
      stagedPreviewUrlsRef.current.clear();
    };
  }, []);

  return { staged, addFiles, removeStaged, clear };
}
