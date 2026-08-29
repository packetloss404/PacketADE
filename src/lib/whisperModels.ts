/**
 * Size reporting for downloaded Whisper models.
 *
 * Kept out of `DictationSettingsCard` so the reclaim figure can be unit-tested
 * on its own — it is the entire justification for the delete button, and a
 * silently wrong unit turns the prompt into a lie.
 */
import type { WhisperModel } from "@/types/dictation";

/** Render bytes the way a disk-reclaim prompt has to: exact enough that the
 *  number matches what the user will see free up, short enough to sit in an
 *  11px row. Whisper models span 75 MB to 3 GB, so MB below 1 GiB and GB above. */
export function formatDiskSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  const mib = bytes / (1024 * 1024);
  if (mib < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (mib < 1024) return `${Math.round(mib)} MB`;
  return `${(mib / 1024).toFixed(1)} GB`;
}

/**
 * What a model row should say it weighs.
 *
 * An installed file quotes its real size on disk; anything not installed can
 * only quote the shipped estimate of what downloading it will cost. The two
 * are not interchangeable — the `large-v3` spec advertises a flat 3000 MB
 * against a ~3.1 GB file, and a half-written file weighs neither.
 */
export function modelSizeLabel(model: WhisperModel): string {
  if (model.installed && model.diskBytes != null) return formatDiskSize(model.diskBytes);
  return `${model.fileSizeMb} MB`;
}
