interface PathCollisionOptions {
  caseSensitive?: boolean;
}

export function normalizeClaimedPath(path: string, options: PathCollisionOptions = {}): string {
  const normalized = path
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "")
    .replace(/^\.\//, "");
  return options.caseSensitive ? normalized : normalized.toLowerCase();
}

export function claimedPathsOverlap(
  left: string,
  right: string,
  options: PathCollisionOptions = {},
): boolean {
  const a = normalizeClaimedPath(left, options);
  const b = normalizeClaimedPath(right, options);
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
