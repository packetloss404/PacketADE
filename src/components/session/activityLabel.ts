/**
 * Compose the human-readable label shown in `ActivityStrip` for the current
 * agent state + tool + file. Pulled out of `ActivityStrip.tsx` so the file
 * can stay component-only (Vite Fast Refresh requires that exports from a
 * `.tsx` file are React components).
 */
export function getActivityLabel(
  state: string,
  tool: string | null,
  file: string | null,
): string {
  if (state === "thinking") return "Thinking...";

  if (!tool) return "";

  const shortFile = file
    ? file.length > 50
      ? "..." + file.slice(-47)
      : file
    : "";

  switch (tool) {
    case "Edit":
      return `Editing ${shortFile}`;
    case "Write":
      return `Writing ${shortFile}`;
    case "Read":
      return `Reading ${shortFile}`;
    case "Bash":
      return `Running: ${shortFile}`;
    case "Glob":
      return `Searching: ${shortFile}`;
    case "Grep":
      return `Searching: ${shortFile}`;
    case "Task":
      return `Running task: ${shortFile}`;
    default:
      return `${tool} ${shortFile}`;
  }
}
