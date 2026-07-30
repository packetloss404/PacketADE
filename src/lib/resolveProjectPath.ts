/**
 * Shared project-relative → absolute path resolution.
 *
 * Extracted from `AgentPreviewPane` so the dock Editor (D5) and the Markdown
 * preview resolve agent-emitted paths the same way. Separator style follows
 * the project root, so a Windows root keeps backslashes.
 */
export function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/") || path.startsWith("\\\\");
}

export function resolveProjectPath(projectPath: string, path: string): string {
  if (isAbsolutePath(path)) return path;
  if (!projectPath) return path;
  const sep = projectPath.includes("\\") && !projectPath.includes("/") ? "\\" : "/";
  const root = projectPath.replace(/[\\/]+$/, "");
  const rel = path.replace(/^[\\/]+/, "");
  return `${root}${sep}${sep === "\\" ? rel.replace(/\//g, "\\") : rel.replace(/\\/g, "/")}`;
}
