import { useId, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, FolderOpen, Info, Lock, Plus, ShieldAlert, X } from "lucide-react";
import {
  MCP_ROOT_LIMIT,
  mcpRootAddition,
  mcpRootPlatformOf,
  normalizeMcpRoot,
} from "@/lib/mcpRoots";

interface McpRootsEditorProps {
  serverLabel: string;
  roots: string[];
  workspacePath: string | null;
  /** Whether the `outside_workspace` denial floor is armed for this server. */
  enforced: boolean;
  onChange: (roots: string[], detail: string) => void;
}

/**
 * Editor for one server's `allowedRoots`.
 *
 * Three things this deliberately does NOT do:
 *
 *  - It never stores a value it could not normalise. Every rejection carries
 *    the reason, because the reasons are all "the two enforcement engines
 *    disagree about this spelling" and a user cannot guess that.
 *  - It never normalises silently. The normalised form is shown before Add,
 *    the same way the git-host wizard shows a normalised instance URL.
 *  - It never treats the empty list as an error. Zero roots is the STRICTEST
 *    state (both engines deny every path-like argument when the list is
 *    empty), so removing the last root needs a clear statement of what just
 *    happened, not a block. See the header comment in `@/lib/mcpRoots`.
 */
export function McpRootsEditor({
  serverLabel,
  roots,
  workspacePath,
  enforced,
  onChange,
}: McpRootsEditorProps) {
  const [draft, setDraft] = useState("");
  const [touched, setTouched] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const fieldId = useId();

  const platform = useMemo(() => mcpRootPlatformOf(workspacePath), [workspacePath]);
  const normalized = useMemo(
    () => (draft.trim() ? normalizeMcpRoot(draft, platform) : null),
    [draft, platform],
  );
  const addition = useMemo(
    () => (normalized?.ok ? mcpRootAddition(normalized.value, roots) : null),
    [normalized, roots],
  );

  const additionError =
    addition?.status === "duplicate"
      ? `Already granted as ${addition.existing}.`
      : addition?.status === "covered"
        ? `Already covered by ${addition.existing}; adding it would grant nothing new.`
        : addition?.status === "full"
          ? `At the ${MCP_ROOT_LIMIT}-root limit. Remove one first.`
          : null;

  const canAdd = normalized?.ok === true && addition?.status === "add";

  function commit(next: string[], detail: string) {
    onChange(next, detail);
    setDraft("");
    setTouched(false);
  }

  function addTypedRoot() {
    if (!canAdd || !normalized?.ok) return;
    setPickerError(null);
    commit([...roots, normalized.value], `root granted: ${normalized.value}`);
  }

  function removeRoot(root: string) {
    setPickerError(null);
    commit(
      roots.filter((candidate) => candidate !== root),
      `root revoked: ${root}`,
    );
  }

  async function browse() {
    setPickerError(null);
    try {
      const picked = await openDialog({
        directory: true,
        multiple: true,
        title: `Grant a filesystem root to ${serverLabel}`,
      });
      const selected = Array.isArray(picked) ? picked : picked ? [picked] : [];
      if (selected.length === 0) return;

      // The picker returns a real on-disk path, but it still goes through the
      // same validator: a picked path can be a UNC share, a drive root, or a
      // spelling the enforcement engines read differently, and "the user
      // clicked it" is not evidence that enforcement will honour it.
      const next = [...roots];
      const rejected: string[] = [];
      for (const path of selected) {
        const result = normalizeMcpRoot(path, platform);
        if (!result.ok) {
          rejected.push(`${path}: ${result.error}`);
          continue;
        }
        if (mcpRootAddition(result.value, next).status !== "add") continue;
        next.push(result.value);
      }
      if (rejected.length > 0) setPickerError(rejected.join(" "));
      if (next.length !== roots.length) {
        commit(next, `roots granted: ${next.slice(roots.length).join(", ")}`);
      }
    } catch (error) {
      setPickerError(`Could not open the directory picker: ${String(error)}`);
    }
  }

  return (
    <div className="mt-2 rounded border border-bg-border bg-bg-primary p-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
          Filesystem roots
        </div>
        <button
          type="button"
          onClick={() => void browse()}
          className="flex items-center gap-1 rounded border border-bg-border px-1.5 py-0.5 text-[9px] text-text-secondary hover:border-accent-green hover:text-accent-green"
        >
          <FolderOpen size={9} />
          Browse…
        </button>
      </div>

      {roots.length === 0 ? (
        // Zero roots is the LOCKED state, not the open one. Saying which it is
        // matters more than anything else on this control: an allowlist that
        // opens up when emptied is the usual convention, and this one does the
        // opposite.
        <div className="mt-2 flex items-start gap-1.5 rounded border border-accent-green/30 bg-accent-green/10 px-2 py-1.5 text-[9px] text-accent-green">
          <Lock size={10} className="mt-0.5 shrink-0" />
          <span>
            <span className="font-medium">No roots granted — fully locked.</span> Every path-like
            argument this server receives is refused. Empty does not mean unrestricted here.
          </span>
        </div>
      ) : (
        <ul className="mt-2 flex flex-col gap-1">
          {roots.map((root) => (
            <li
              key={root}
              className="flex items-center justify-between gap-2 rounded border border-bg-border bg-bg-secondary px-2 py-1"
            >
              <span className="truncate font-mono text-[10px] text-text-primary" title={root}>
                {root}
              </span>
              <button
                type="button"
                onClick={() => removeRoot(root)}
                aria-label={`Remove root ${root}`}
                title={
                  roots.length === 1
                    ? "Remove the last root — the server will then be refused every path argument"
                    : `Remove ${root}`
                }
                className="shrink-0 rounded p-0.5 text-text-muted hover:bg-accent-red/10 hover:text-accent-red"
              >
                <X size={10} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2">
        <label htmlFor={fieldId} className="sr-only">
          Add a filesystem root for {serverLabel}
        </label>
        <div className="flex items-center gap-1">
          <input
            id={fieldId}
            type="text"
            spellCheck={false}
            autoComplete="off"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setTouched(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addTypedRoot();
              }
            }}
            aria-invalid={touched && normalized ? !normalized.ok || !canAdd : undefined}
            aria-describedby={`${fieldId}-help`}
            placeholder={platform === "posix" ? "/home/you/app" : "C:\\projects\\app"}
            className="min-w-0 flex-1 rounded border border-bg-border bg-bg-secondary px-2 py-1 text-[10px] text-text-primary outline-none placeholder:text-text-muted focus:border-accent-green"
          />
          <button
            type="button"
            onClick={addTypedRoot}
            disabled={!canAdd}
            className="flex shrink-0 items-center gap-1 rounded border border-accent-green/30 bg-accent-green/10 px-2 py-1 text-[9px] text-accent-green disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus size={9} />
            Add
          </button>
        </div>
        <p id={`${fieldId}-help`} className="mt-1 text-[9px] text-text-faint">
          Absolute paths only. <code className="text-text-muted">~</code>, environment variables,
          wildcards, <code className="text-text-muted">.</code> and{" "}
          <code className="text-text-muted">..</code> are refused — the two enforcement engines read
          them differently.
        </p>
      </div>

      {touched && normalized && !normalized.ok && (
        <p role="alert" className="mt-1.5 flex items-start gap-1.5 text-[9px] text-accent-red">
          <ShieldAlert size={10} className="mt-0.5 shrink-0" />
          {normalized.error}
        </p>
      )}

      {normalized?.ok && (
        <div role="status" className="mt-1.5 rounded border border-bg-border bg-bg-secondary px-2 py-1.5">
          <div className="text-[9px] uppercase tracking-wider text-text-muted">Will be saved as</div>
          <div className="mt-0.5 break-all font-mono text-[10px] text-text-primary">
            {normalized.value}
          </div>
          {normalized.notes.map((note) => (
            <p key={note} className="mt-1 flex items-start gap-1.5 text-[9px] text-text-muted">
              <Info size={9} className="mt-0.5 shrink-0" />
              {note}
            </p>
          ))}
          {normalized.warnings.map((warning) => (
            <p key={warning} className="mt-1 flex items-start gap-1.5 text-[9px] text-accent-amber">
              <AlertTriangle size={9} className="mt-0.5 shrink-0" />
              {warning}
            </p>
          ))}
          {additionError && (
            <p className="mt-1 flex items-start gap-1.5 text-[9px] text-accent-amber">
              <AlertTriangle size={9} className="mt-0.5 shrink-0" />
              {additionError}
            </p>
          )}
        </div>
      )}

      {pickerError && (
        <p role="alert" className="mt-1.5 flex items-start gap-1.5 text-[9px] text-accent-red">
          <ShieldAlert size={10} className="mt-0.5 shrink-0" />
          {pickerError}
        </p>
      )}

      {!enforced && (
        // Roots are only consulted behind the `outside_workspace` denial floor.
        // If it is ever off, this editor edits an inert list, and pretending
        // otherwise would be the whole fault this control exists to avoid.
        <p className="mt-1.5 flex items-start gap-1.5 text-[9px] text-accent-red">
          <ShieldAlert size={10} className="mt-0.5 shrink-0" />
          The outside-workspace denial floor is not armed for this server, so these roots are not
          consulted at tool-call time.
        </p>
      )}

      <p className="mt-1.5 text-[9px] text-text-faint">
        Roots constrain arguments whose name looks path-like (path, file, folder, directory, dir,
        root, cwd, workspace). They are matched literally: no symlink is resolved on either
        enforcement path, so a link that points outside a root is judged by the path text it was
        given. Changes apply to new sessions — use Reconnect above for the selected conversation.
      </p>
    </div>
  );
}
