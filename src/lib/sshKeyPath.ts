/**
 * S2: SSH private-key path hygiene.
 *
 * A saved `ServerConfig.keyPath` is forwarded to `ssh` as a distinct `-i <path>`
 * argv element (see `execution.rs::ssh_args`), so it is not shell-interpolated
 * in the normal path — but it is stored, echoed into UI, and could reach a shell
 * in future code. A key path containing control bytes or shell metacharacters is
 * almost always a paste error or an injection attempt, so we reject it at save
 * time rather than let it flow into any argv.
 *
 * The check is deliberately lenient about ordinary path characters: spaces
 * (`C:\Users\Jane Doe\.ssh\id_ed25519`), `~`, `(`/`)` (`Program Files (x86)`),
 * drive colons, and both slash flavors are all allowed.
 */

/** Shell metacharacters (incl. glob wildcards) that have no business in a key
 *  path. Backslash is intentionally excluded (Windows paths need it), as are
 *  `(`/`)` (`Program Files (x86)`); newline and other control bytes are caught
 *  separately by the char-code scan below. */
const UNSAFE_KEYPATH_CHARS = /[;|&$`<>"'*?]/;

/**
 * True if `keyPath` is safe to persist and hand to `ssh -i`. An empty string is
 * treated as safe (it means "no key" and is handled by the caller). Backslash is
 * intentionally NOT rejected — Windows paths need it.
 */
export function isSafeKeyPath(keyPath: string): boolean {
  if (keyPath.length === 0) return true;
  for (let i = 0; i < keyPath.length; i++) {
    const code = keyPath.charCodeAt(i);
    // Control / non-printable bytes (covers NUL, tab, CR, LF).
    if (code < 0x20 || code === 0x7f) return false;
  }
  return !UNSAFE_KEYPATH_CHARS.test(keyPath);
}

/** User-facing reason shown when {@link isSafeKeyPath} rejects a value. */
export const UNSAFE_KEYPATH_MESSAGE =
  "Key path contains control or shell-special characters (e.g. ; | & $ ` < > \" '). Use a plain filesystem path.";
