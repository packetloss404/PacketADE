import { useEffect, useMemo, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  AlertTriangle,
  Archive,
  Check,
  FilePlus2,
  GitFork,
  List,
  RefreshCw,
  Save,
  Search,
  X,
} from "lucide-react";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import {
  alreadyCaptured,
  captureFromGlobalMemoryEvent,
} from "@/lib/projectMemoryCapture";
import { useProjectMemoryStore } from "@/stores/projectMemoryStore";
import { ConfirmDeleteModal } from "@/components/ui/ConfirmDeleteModal";
import type { MemoryEvent } from "@/types/memory";
import { APP_NAME } from "@/lib/brand";
import type {
  ProjectMemoryChangedEvent,
  ProjectMemoryNote,
} from "@/types/project-memory";

export function ProjectNotesTab({
  projectPath,
  globalEvents,
  remote,
}: {
  projectPath: string | null;
  globalEvents: MemoryEvent[];
  /** Set when the active workspace is remote. `.agents/memory` is read from
   *  this machine's filesystem, so remote notes are not reachable - say so
   *  rather than showing the previous local project's notes. */
  remote?: { serverName: string; remotePath: string };
}) {
  const snapshot = useProjectMemoryStore((state) => state.snapshot);
  const loading = useProjectMemoryStore((state) => state.loading);
  const error = useProjectMemoryStore((state) => state.error);
  const changedExternally = useProjectMemoryStore(
    (state) => state.changedExternally,
  );
  const load = useProjectMemoryStore((state) => state.load);
  const createNote = useProjectMemoryStore((state) => state.createNote);
  const updateNote = useProjectMemoryStore((state) => state.updateNote);
  const archiveNote = useProjectMemoryStore((state) => state.archiveNote);
  const clearError = useProjectMemoryStore((state) => state.clearError);
  const acknowledgeExternalChange = useProjectMemoryStore(
    (state) => state.acknowledgeExternalChange,
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [layout, setLayout] = useState<"list" | "graph">("list");
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");
  const [editingRevision, setEditingRevision] = useState("");
  const [pendingArchive, setPendingArchive] = useState<ProjectMemoryNote | null>(null);

  const selected =
    snapshot.notes.find((note) => note.metadata.id === selectedId) ?? null;

  useEffect(() => {
    if (!projectPath) return;
    void load(projectPath);
  }, [load, projectPath]);

  useEffect(() => {
    if (
      !projectPath ||
      typeof window === "undefined" ||
      !("__TAURI_INTERNALS__" in window)
    ) {
      return;
    }
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<ProjectMemoryChangedEvent>(
      "project-memory:changed",
      (event) => {
        if (event.payload.projectPath === projectPath) {
          void load(projectPath, true);
        }
      },
    )
      .then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [load, projectPath]);

  useEffect(() => {
    if (
      selectedId &&
      !snapshot.notes.some((note) => note.metadata.id === selectedId)
    ) {
      setSelectedId(null);
    }
  }, [selectedId, snapshot.notes]);

  const visibleNotes = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return snapshot.notes.filter((note) => {
      if (!showArchived && note.metadata.archived) return false;
      if (!needle) return true;
      return `${note.metadata.title}\n${note.body}\n${note.metadata.tags.join(" ")}`
        .toLowerCase()
        .includes(needle);
    });
  }, [query, showArchived, snapshot.notes]);

  const byId = useMemo(
    () => new Map(snapshot.notes.map((note) => [note.metadata.id, note])),
    [snapshot.notes],
  );

  function beginCreate() {
    clearError();
    setCreating(true);
    setEditing(true);
    setSelectedId(null);
    setTitle("");
    setBody("");
    setTags("");
    setEditingRevision("");
  }

  function beginEdit(note: ProjectMemoryNote) {
    clearError();
    setCreating(false);
    setEditing(true);
    setSelectedId(note.metadata.id);
    setTitle(note.metadata.title);
    setBody(note.body);
    setTags(note.metadata.tags.join(", "));
    setEditingRevision(note.revision);
  }

  function cancelEdit() {
    setEditing(false);
    setCreating(false);
    clearError();
  }

  async function save() {
    const parsedTags = tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    const saved = creating
      ? await createNote({ title, body, tags: parsedTags })
      : selected
        ? await updateNote({
            id: selected.metadata.id,
            expectedRevision: editingRevision,
            title,
            body,
            tags: parsedTags,
            provenanceIds: selected.metadata.provenanceIds,
          })
        : null;
    if (!saved) return;
    setSelectedId(saved.metadata.id);
    setEditing(false);
    setCreating(false);
    acknowledgeExternalChange();
  }

  async function promoteEvent(event: MemoryEvent) {
    const input = captureFromGlobalMemoryEvent(event);
    if (alreadyCaptured(snapshot.notes, input.provenanceIds ?? [])) {
      setSelectedId(
        snapshot.notes.find((note) =>
          (input.provenanceIds ?? []).every((id) =>
            note.metadata.provenanceIds.includes(id),
          ),
        )?.metadata.id ?? null,
      );
      return;
    }
    const saved = await createNote(input);
    if (saved) setSelectedId(saved.metadata.id);
  }

  if (remote) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
        <p className="text-[11px] text-text-secondary">Project notes are local-only</p>
        <p className="max-w-[380px] text-[10px] leading-relaxed text-text-faint">
          <span className="font-mono text-text-muted">.agents/memory</span> is read from this
          machine&apos;s filesystem. This workspace runs on{" "}
          <span className="text-text-muted">{remote.serverName}</span>, so its notes are not
          reachable from here. Open the project locally to read or edit them.
        </p>
        <p className="max-w-[380px] text-[10px] leading-relaxed text-text-faint">
          Everything else in Memory does work for this workspace — sessions, flights and saved
          notes are recorded against{" "}
          <span className="text-text-muted">{remote.serverName}</span> and injected back into its
          agents. Only these Markdown files are local-only.
        </p>
      </div>
    );
  }

  if (!projectPath) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-text-muted">
        Open a project to use project memory.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <aside className="flex w-72 shrink-0 flex-col border-r border-bg-border bg-bg-secondary">
        <div className="flex items-center gap-1.5 border-b border-bg-border p-2">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded border border-bg-border bg-bg-primary px-2 py-1">
            <Search size={10} className="text-text-faint" />
            <input
              aria-label="Search project notes"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search project notes"
              className="min-w-0 flex-1 bg-transparent text-[10.5px] text-text-primary outline-none"
            />
          </div>
          <button
            type="button"
            onClick={beginCreate}
            title="Create project note"
            className="rounded p-1.5 text-accent-green hover:bg-bg-elevated"
          >
            <FilePlus2 size={12} />
          </button>
        </div>

        <div className="flex items-center gap-1 border-b border-bg-border px-2 py-1.5">
          <button
            type="button"
            aria-pressed={layout === "list"}
            onClick={() => setLayout("list")}
            className={`rounded p-1 ${layout === "list" ? "text-accent-green" : "text-text-muted"}`}
            title="List view"
          >
            <List size={11} />
          </button>
          <button
            type="button"
            aria-pressed={layout === "graph"}
            onClick={() => setLayout("graph")}
            className={`rounded p-1 ${layout === "graph" ? "text-accent-green" : "text-text-muted"}`}
            title="Link graph"
          >
            <GitFork size={11} />
          </button>
          <label className="ml-1 flex items-center gap-1 text-[10px] text-text-muted">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
            />
            Archived
          </label>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => void load(projectPath)}
            className="rounded p-1 text-text-muted hover:text-text-primary"
            title="Reload project memory"
          >
            <RefreshCw size={10} className={loading ? "animate-spin" : ""} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {layout === "list" ? (
            visibleNotes.map((note) => (
              <button
                type="button"
                key={note.metadata.id}
                onClick={() => {
                  setSelectedId(note.metadata.id);
                  setEditing(false);
                  setCreating(false);
                }}
                className={`mb-1 w-full rounded border px-2 py-1.5 text-left ${
                  selectedId === note.metadata.id
                    ? "border-accent-line bg-accent-soft"
                    : "border-transparent hover:bg-bg-elevated"
                }`}
              >
                <span className="block truncate text-[11px] text-text-primary">
                  {note.metadata.title}
                </span>
                <span className="mt-0.5 flex gap-1.5 text-[9px] text-text-faint">
                  {note.orphaned && <span>orphan</span>}
                  {note.brokenLinks.length > 0 && (
                    <span className="text-accent-amber">
                      {note.brokenLinks.length} broken
                    </span>
                  )}
                  {note.metadata.provenanceIds.length > 0 && (
                    <span>{note.metadata.provenanceIds.length} source</span>
                  )}
                </span>
              </button>
            ))
          ) : (
            visibleNotes.map((note) => (
              <button
                type="button"
                key={note.metadata.id}
                onClick={() => setSelectedId(note.metadata.id)}
                className="mb-1 w-full rounded border border-bg-border bg-bg-primary p-2 text-left"
              >
                <span className="block truncate text-[10.5px] text-text-primary">
                  {note.metadata.title}
                </span>
                <span className="mt-1 block text-[9px] text-text-faint">
                  →{" "}
                  {note.outboundIds
                    .map((id) => byId.get(id)?.metadata.title ?? "unknown")
                    .join(", ") || "no links"}
                </span>
                <span className="block text-[9px] text-text-faint">
                  ←{" "}
                  {note.backlinkIds
                    .map((id) => byId.get(id)?.metadata.title ?? "unknown")
                    .join(", ") || "no backlinks"}
                </span>
              </button>
            ))
          )}
        </div>

        {globalEvents.length > 0 && (
          <div className="border-t border-bg-border p-2">
            <div className="mb-1 text-[9px] uppercase tracking-wide text-text-faint">
              Promote global memory
            </div>
            <select
              aria-label="Promote global memory event"
              defaultValue=""
              onChange={(event) => {
                const source = globalEvents.find(
                  (candidate) => candidate.id === event.target.value,
                );
                event.target.value = "";
                if (source) void promoteEvent(source);
              }}
              className="w-full rounded border border-bg-border bg-bg-primary px-1.5 py-1 text-[10px] text-text-secondary"
            >
              <option value="">Choose event…</option>
              {[...globalEvents].reverse().slice(0, 50).map((event) => (
                <option key={event.id} value={event.id}>
                  {event.type.replaceAll("_", " ")} ·{" "}
                  {new Date(event.timestamp).toLocaleDateString()}
                </option>
              ))}
            </select>
          </div>
        )}
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        {changedExternally && (
          <div className="flex items-center gap-2 border-b border-accent-amber/30 bg-accent-amber/10 px-3 py-2 text-[10.5px] text-accent-amber">
            <AlertTriangle size={11} />
            Files changed outside {APP_NAME}. The list is reloaded; an open
            draft still uses its original revision and will not overwrite it.
            <button
              type="button"
              onClick={acknowledgeExternalChange}
              className="ml-auto rounded px-1.5 py-0.5 hover:bg-bg-elevated"
            >
              <Check size={10} />
            </button>
          </div>
        )}
        {error && (
          <div
            role="alert"
            className="flex items-center gap-2 border-b border-accent-red/30 bg-accent-red/10 px-3 py-2 text-[10.5px] text-accent-red"
          >
            {error}
            <button
              type="button"
              onClick={clearError}
              className="ml-auto rounded p-0.5"
            >
              <X size={10} />
            </button>
          </div>
        )}

        {editing ? (
          <div className="flex min-h-full flex-col p-3">
            <input
              aria-label="Project note title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Note title"
              className="mb-2 rounded border border-bg-border bg-bg-primary px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent-green/50"
            />
            <textarea
              aria-label="Project note Markdown"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="Markdown. Link notes with [[Title]] or [label](note.md)."
              className="min-h-72 flex-1 resize-y rounded border border-bg-border bg-bg-primary p-2 font-mono text-[11px] leading-relaxed text-text-primary outline-none focus:border-accent-green/50"
            />
            <input
              aria-label="Project note tags"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="tags, comma-separated"
              className="mt-2 rounded border border-bg-border bg-bg-primary px-2 py-1 text-[10.5px] text-text-primary outline-none"
            />
            <div className="mt-2 flex justify-end gap-1.5">
              <button
                type="button"
                onClick={cancelEdit}
                className="rounded px-2 py-1 text-[10.5px] text-text-muted hover:bg-bg-elevated"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={!title.trim() || !body.trim()}
                className="inline-flex items-center gap-1 rounded bg-accent-green/20 px-2 py-1 text-[10.5px] text-accent-green disabled:opacity-40"
              >
                <Save size={10} />
                Save
              </button>
            </div>
          </div>
        ) : selected ? (
          <article className="p-4">
            <div className="mb-3 flex items-start gap-2 border-b border-bg-border pb-3">
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold text-text-primary">
                  {selected.metadata.title}
                </h2>
                <div className="mt-1 font-mono text-[9px] text-text-faint">
                  {snapshot.directory}/{selected.relativePath} · rev{" "}
                  {selected.revision.slice(0, 8)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => beginEdit(selected)}
                className="rounded px-2 py-1 text-[10.5px] text-accent-green hover:bg-bg-elevated"
              >
                Edit
              </button>
              {!selected.metadata.archived && (
                <button
                  type="button"
                  onClick={() => setPendingArchive(selected)}
                  className="rounded p-1 text-text-muted hover:text-accent-amber"
                  title="Archive note"
                >
                  <Archive size={11} />
                </button>
              )}
            </div>
            <MarkdownRenderer content={selected.body} />
            <div className="mt-5 grid grid-cols-2 gap-2 border-t border-bg-border pt-3 text-[10px] text-text-muted">
              <div>
                <div className="mb-1 font-semibold text-text-secondary">
                  Backlinks
                </div>
                {selected.backlinkIds.length
                  ? selected.backlinkIds.map((id) => (
                      <button
                        type="button"
                        key={id}
                        onClick={() => setSelectedId(id)}
                        className="block text-accent-blue hover:underline"
                      >
                        {byId.get(id)?.metadata.title ?? "Unavailable source"}
                      </button>
                    ))
                  : "None"}
              </div>
              <div>
                <div className="mb-1 font-semibold text-text-secondary">
                  Health
                </div>
                {selected.orphaned && <div>Orphaned note</div>}
                {selected.brokenLinks.map((link) => (
                  <div key={link} className="text-accent-amber">
                    Broken: {link}
                  </div>
                ))}
                {!selected.orphaned && selected.brokenLinks.length === 0 && (
                  <div>Healthy</div>
                )}
              </div>
              <div className="col-span-2">
                <div className="mb-1 font-semibold text-text-secondary">
                  Provenance references
                </div>
                {selected.metadata.provenanceIds.length
                  ? selected.metadata.provenanceIds.join(", ")
                  : "Created directly in project memory"}
              </div>
            </div>
          </article>
        ) : (
          <div className="flex min-h-full items-center justify-center p-6 text-center text-xs text-text-muted">
            Select a note, create one, or promote an existing global-memory
            event. Notes remain ordinary Markdown in {snapshot.directory}.
          </div>
        )}
      </main>

      {(snapshot.warnings.length > 0 ||
        snapshot.notes.some(
          (note) => note.orphaned || note.brokenLinks.length > 0,
        )) && (
        <aside className="w-64 shrink-0 overflow-y-auto border-l border-bg-border bg-bg-secondary p-2.5">
          <div className="mb-2 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-accent-amber">
            <AlertTriangle size={10} />
            Memory health
          </div>
          {snapshot.warnings.map((warning, index) => (
            <div
              key={`${warning.relativePath}-${warning.code}-${index}`}
              className="mb-2 rounded border border-accent-amber/20 bg-accent-amber/5 p-2 text-[9.5px]"
            >
              <div className="font-mono text-text-secondary">
                {warning.relativePath}
              </div>
              <div className="mt-0.5 text-accent-amber">
                {warning.message}
              </div>
            </div>
          ))}
          <div className="text-[9.5px] text-text-muted">
            {snapshot.notes.filter((note) => note.orphaned).length} orphaned ·{" "}
            {snapshot.notes.reduce(
              (count, note) => count + note.brokenLinks.length,
              0,
            )}{" "}
            broken links
          </div>
        </aside>
      )}

      {pendingArchive && (
        <ConfirmDeleteModal
          title="Archive note?"
          entityName={pendingArchive.metadata.title || pendingArchive.relativePath}
          description="is hidden from the notes list. Turn on “Archived” to bring it back."
          confirmLabel="Archive"
          undoNote={null}
          onConfirm={() => {
            void archiveNote(pendingArchive.metadata.id, pendingArchive.revision);
            setPendingArchive(null);
          }}
          onClose={() => setPendingArchive(null)}
        />
      )}
    </div>
  );
}
