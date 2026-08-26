import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  BellRing,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Server,
  Trash2,
} from "lucide-react";
import { AcpMcpConsent } from "@/components/agents/AcpMcpConsent";
import { engineDirectoryRecord, useAgentTaskStore } from "@/stores/agentTaskStore";
import { useAgentApprovalStore } from "@/stores/agentApprovalStore";
import { useAgentSidebarPrefsStore } from "@/stores/agentSidebarPrefsStore";
import { API_PROVIDERS } from "@/lib/api-models";
import { capabilitiesFor } from "@/lib/agentCapabilities";
import { ConfirmDeleteConversationModal } from "@/components/agents/ConfirmDeleteConversationModal";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import type { AcpSessionSummary } from "@/lib/tauri";
import type { AgentConversation } from "@/types/agent-conversation";

type StatusFilter = "all" | "active" | "done" | "archived";

interface AgentSidebarProps {
  selectedId: string | null;
  onSelect: (conversationId: string) => void;
  onNewAgent: () => void;
  /**
   * Show the engine's OWN session directory below the conversation list.
   *
   * Off by default and set only by the ACP-scoped route (`PacketCodeView`):
   * on the general Agents route a list of packetcode-engine sessions is noise,
   * and on the PacketCode route it is the point. This is route scoping by
   * TRANSPORT, not an affordance decision — everything the section then lets
   * you DO is resolved through `capabilitiesFor()` like every other control.
   */
  showEngineSessions?: boolean;
}

/**
 * Stable empty list for stores mocked without the engine slice (several
 * component suites stub `useAgentTaskStore` with only the fields they drive).
 * Referential stability matters: this feeds a `useMemo` dependency.
 */
const NO_ENGINE_SESSIONS: AcpSessionSummary[] = [];

function formatRelativeTime(timestamp: number): string {
  const elapsed = Date.now() - timestamp;
  if (elapsed < 60_000) return "now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The engine formats `updatedAt` itself, so an unparseable value is possible
 * and must not render as "NaNd". `null` simply omits the timestamp.
 */
function formatEngineTime(updatedAt: string): string | null {
  const parsed = Date.parse(updatedAt);
  return Number.isNaN(parsed) ? null : formatRelativeTime(parsed);
}

/**
 * Everything an engine row knows about itself, for its tooltip. An engine
 * session is a HANDLE — a summary and nothing else — so the metadata that a
 * conversation row can afford to leave implicit (there is a transcript to open
 * and read) has to be legible here without opening anything.
 */
function engineSessionDetail(session: AcpSessionSummary): string {
  const parts = [
    session.workingDir || "(no working directory)",
    `${session.provider}/${session.model}`,
    `${session.messageCount} message${session.messageCount === 1 ? "" : "s"}`,
  ];
  if (session.costUsd > 0) parts.push(`$${session.costUsd.toFixed(2)}`);
  return parts.join(" · ");
}

function providerLabel(agent: string): string {
  const provider = API_PROVIDERS.find((candidate) => candidate.agentCli === agent);
  if (provider) {
    return provider.name.replace(" (API)", "").replace(" (Local)", "");
  }
  return agent;
}

function projectKey(conversation: AgentConversation): string {
  return conversation.sshTarget
    ? `ssh:${conversation.sshTarget.id}:${conversation.projectPath}`
    : `local:${conversation.projectPath}`;
}

function projectLabel(conversation: AgentConversation, labels: Record<string, string>): string {
  if (conversation.sshTarget) return conversation.sshTarget.name;
  const custom = labels[conversation.projectPath];
  if (custom) return custom;
  const parts = conversation.projectPath.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? conversation.projectPath;
}

function matchesSearch(conversation: AgentConversation, query: string): boolean {
  const normalized = query.toLowerCase();
  if (conversation.title?.toLowerCase().includes(normalized)) return true;
  if (conversation.projectPath.toLowerCase().includes(normalized)) return true;
  return conversation.messages.some((message) =>
    message.content?.toLowerCase().includes(normalized),
  );
}

/**
 * The four states a session row's dot can report. This replaces the old
 * `statusIcon` + `getStatusColor` pair, which painted `idle` and `active` the
 * SAME green (so a running turn was indistinguishable from a parked session)
 * and had no state at all for "this session is blocked on you".
 */
type DotState = "running" | "attention" | "failed" | "idle";

/**
 * Derivation (spec — Sidebar): a pending permission/edit outranks everything
 * because it is the only state that needs the user to come back; then a live
 * turn; then a failed one. `done` and `idle` both read as parked.
 */
function dotStateFor(status: AgentConversation["status"], attention: boolean): DotState {
  if (attention) return "attention";
  if (status === "active") return "running";
  if (status === "failed") return "failed";
  return "idle";
}

function StatusDot({ state }: { state: DotState }) {
  // The glow is `currentColor` so the dot never hard-codes a shadow colour —
  // the accent token on the same element drives both fill and halo.
  const tone =
    state === "running"
      ? "bg-accent-blue text-accent-blue shadow-[0_0_6px_currentColor] animate-pulse motion-reduce:animate-none"
      : state === "attention"
        ? "bg-accent-amber text-accent-amber shadow-[0_0_6px_currentColor]"
        : state === "failed"
          ? "bg-accent-red"
          : "bg-text-faint";
  return (
    <span
      aria-hidden="true"
      data-status={state}
      className={`h-[6px] w-[6px] shrink-0 rounded-full ${tone}`}
    />
  );
}

function statusWord(state: DotState): string {
  if (state === "attention") return "waiting for your answer";
  if (state === "running") return "running";
  if (state === "failed") return "failed";
  return "idle";
}

function sortConversations(
  conversations: AgentConversation[],
  prefs: Record<string, { pinned?: boolean }>,
): AgentConversation[] {
  return [...conversations].sort((left, right) => {
    const leftPinned = prefs[left.id]?.pinned === true;
    const rightPinned = prefs[right.id]?.pinned === true;
    if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
    return right.updatedAt - left.updatedAt;
  });
}

export function AgentSidebar({
  selectedId,
  onSelect,
  onNewAgent,
  showEngineSessions = false,
}: AgentSidebarProps) {
  const conversations = useAgentTaskStore((state) => state.conversations);
  const archiveConversation = useAgentTaskStore((state) => state.archiveConversation);
  const unarchiveConversation = useAgentTaskStore((state) => state.unarchiveConversation);
  const renameConversation = useAgentTaskStore((state) => state.renameConversation);
  const pushEngineRename = useAgentTaskStore((state) => state.pushEngineRename);
  const renameEngineSession = useAgentTaskStore((state) => state.renameEngineSession);
  const engineSessions = useAgentTaskStore((state) => state.engineSessions);
  const engineSessionsStatus = useAgentTaskStore((state) => state.engineSessionsStatus);
  const engineCapabilities = useAgentTaskStore((state) => state.engineCapabilities);
  const refreshEngineSessions = useAgentTaskStore((state) => state.refreshEngineSessions);
  const adoptEngineSession = useAgentTaskStore((state) => state.adoptEngineSession);
  const pendingPermissions = useAgentApprovalStore((state) => state.permissions);
  const pendingEdits = useAgentApprovalStore((state) => state.edits);
  const prefs = useAgentSidebarPrefsStore((state) => state.prefs);
  const togglePinned = useAgentSidebarPrefsStore((state) => state.togglePinned);
  const projectLabels = useAgentSidebarPrefsStore((state) => state.projectLabels);

  const [filter, setFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [pendingDelete, setPendingDelete] = useState<AgentConversation | null>(null);
  // Inline rename: the row being edited plus its draft text. Engine rows use
  // the same slot, keyed by their engine session id, and say which list they
  // came from so the commit knows whose name it is changing.
  const [editing, setEditing] = useState<{
    id: string;
    draft: string;
    scope: "conversation" | "engine";
  } | null>(null);
  // Collapsed by default: expanding is what triggers the engine query, and
  // starting a subprocess must be something the user asked for.
  const [engineOpen, setEngineOpen] = useState(false);
  const deferredQuery = useDeferredValue(query.trim());

  const engineRows = engineSessions ?? NO_ENGINE_SESSIONS;
  const engineStatus = engineSessionsStatus ?? "idle";
  /**
   * Affordances on engine-only rows still come from the descriptor — there is
   * simply no conversation behind them, so the engine's own handshake record
   * stands in. `canRename` here is the engine's `sessionsRename` flag: without
   * it the backend degrades `_packetcode/sessions/rename` to a silent success
   * and the next listing would put the old name straight back.
   */
  const engineCaps = useMemo(
    () => capabilitiesFor(engineDirectoryRecord(engineCapabilities ?? null)),
    [engineCapabilities],
  );
  /**
   * Whether an engine row can be OPENED — adopted into a conversation bound to
   * it, which resumes it over ACP `session/load`.
   *
   * Read straight off the engine's handshake because that is where the answer
   * lives: `loadSession` is the ACP SPEC capability (`agentCapabilities
   * .loadSession`), not a `_packetcode` vendor flag and not the provider id.
   * An engine that did not advertise it cannot resume anything, so the
   * directory stays exactly as read-only as it is today — and, as everywhere
   * else here, an absent record (`null`, nobody asked yet) means no affordance
   * rather than an optimistic one.
   */
  const canAdoptEngineSessions =
    engineCapabilities?.loadSession === true && typeof adoptEngineSession === "function";

  /**
   * The project the MCP plan is computed against.
   *
   * MCP configuration is per-project (`.mcp.json` shadows the global file) and
   * a stdio command is resolved relative to the project directory, so a plan
   * without one would be a plan for nothing. The selected conversation is the
   * best available answer to "which project is the user thinking about"; with
   * nothing selected the newest conversation stands in, and with no
   * conversations at all the surface says to open a project rather than
   * showing a plan for a directory nobody chose.
   */
  const consentProjectPath =
    conversations.find((conversation) => conversation.id === selectedId)?.projectPath ??
    conversations[0]?.projectPath ??
    "";

  useEffect(() => {
    if (!showEngineSessions || !engineOpen) return;
    if (engineStatus !== "idle") return;
    void refreshEngineSessions?.();
  }, [engineOpen, engineStatus, refreshEngineSessions, showEngineSessions]);

  const needsYouIds = useMemo(() => {
    const result = new Set<string>();
    for (const conversation of conversations) {
      if (
        (pendingPermissions.get(conversation.id)?.length ?? 0) > 0 ||
        (pendingEdits.get(conversation.id)?.length ?? 0) > 0
      ) {
        result.add(conversation.id);
      }
    }
    return result;
  }, [conversations, pendingPermissions, pendingEdits]);

  const counts = useMemo(() => {
    const result = { all: 0, active: 0, done: 0, archived: 0 };
    for (const conversation of conversations) {
      if (conversation.archived) {
        result.archived += 1;
      } else {
        result.all += 1;
        if (conversation.status === "active" || conversation.status === "idle") {
          result.active += 1;
        } else {
          result.done += 1;
        }
      }
    }
    return result;
  }, [conversations]);

  const filtered = useMemo(() => {
    let result = conversations.filter((conversation) =>
      filter === "archived" ? conversation.archived : !conversation.archived,
    );
    if (filter === "active") {
      result = result.filter(
        (conversation) => conversation.status === "active" || conversation.status === "idle",
      );
    } else if (filter === "done") {
      result = result.filter(
        (conversation) => conversation.status === "done" || conversation.status === "failed",
      );
    }
    if (deferredQuery) {
      result = result.filter((conversation) => matchesSearch(conversation, deferredQuery));
    }
    return sortConversations(result, prefs);
  }, [conversations, deferredQuery, filter, prefs]);

  const needsYou = useMemo(
    () =>
      filter === "archived" || deferredQuery
        ? []
        : filtered.filter((conversation) => needsYouIds.has(conversation.id)),
    [deferredQuery, filter, filtered, needsYouIds],
  );

  const groups = useMemo(() => {
    const map = new Map<string, AgentConversation[]>();
    for (const conversation of filtered) {
      if (needsYouIds.has(conversation.id) && needsYou.length > 0) continue;
      const key = projectKey(conversation);
      const group = map.get(key) ?? [];
      group.push(conversation);
      map.set(key, group);
    }
    return map;
  }, [filtered, needsYou.length, needsYouIds]);

  const commitRename = useCallback(() => {
    if (!editing) return;
    const { id, draft, scope } = editing;
    setEditing(null);
    const next = draft.trim();

    if (scope === "engine") {
      // The engine's store is the ONLY record of this name, so there is no
      // local write to be optimistic about beyond the cached row — the store
      // action owns that, and re-reads if the push is refused.
      const row = engineRows.find((session) => session.sessionId === id);
      if (!next || !row || next === row.name) return;
      void renameEngineSession?.(id, next);
      return;
    }

    const conversation = conversations.find((c) => c.id === id);
    if (!next || next === (conversation?.title ?? "")) return;
    // Local first and unconditionally: the row renames under the pointer
    // whatever the engine goes on to say.
    renameConversation(id, next);
    // Then push it outward, so an ACP session keeps the name outside
    // PacketBench. `canRename` is the engine's own `sessionsRename` flag on an
    // ACP conversation and plain `true` on every other transport, where the
    // store action then no-ops on the provider check. Un-awaited and
    // failure-swallowing by contract: a refused engine rename must not revert
    // or throw over the local one.
    if (conversation && capabilitiesFor(conversation).canRename) {
      void pushEngineRename?.(id, next);
    }
  }, [conversations, editing, engineRows, pushEngineRename, renameConversation, renameEngineSession]);

  const renderConversation = (conversation: AgentConversation, attention: boolean) => {
    const selected = conversation.id === selectedId;
    const pinned = prefs[conversation.id]?.pinned === true;
    const dot = dotStateFor(conversation.status, attention);
    // A live turn owns the title (the backend may still be summarising it), so
    // renaming is offered only on a settled session — AND only where the
    // session record is renamable at all. On ACP that is the engine's
    // `sessionsRename` flag: the name lives in the engine's store, so without
    // the method a rename is a control that undoes itself on the next listing.
    const busy = conversation.status === "active";
    const canRename = !busy && capabilitiesFor(conversation).canRename;
    const rowShell = `group relative rounded-lg ${
      selected ? "bg-bg-hover" : ""
    }`;

    if (editing?.id === conversation.id && editing.scope === "conversation") {
      return (
        <div
          key={conversation.id}
          className={`${rowShell} flex items-center gap-2 py-[5px] pl-[26px] pr-2`}
        >
          <StatusDot state={dot} />
          <input
            aria-label="Rename conversation"
            autoFocus
            value={editing.draft}
            onChange={(event) =>
              setEditing({
                id: conversation.id,
                draft: event.target.value,
                scope: "conversation",
              })
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitRename();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setEditing(null);
              }
            }}
            onBlur={commitRename}
            className="min-w-0 flex-1 rounded-md border border-accent-blue bg-bg-elevated px-1 py-px text-ui text-text-primary outline-none"
          />
        </div>
      );
    }

    return (
      <div key={conversation.id} className={rowShell}>
        <button
          type="button"
          onClick={() => onSelect(conversation.id)}
          onDoubleClick={() => {
            if (canRename) {
              setEditing({
                id: conversation.id,
                draft: conversation.title ?? "",
                scope: "conversation",
              });
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "F2" && canRename) {
              event.preventDefault();
              setEditing({
                id: conversation.id,
                draft: conversation.title ?? "",
                scope: "conversation",
              });
            }
          }}
          // Provider identity lives in the tooltip and the composer's model
          // picker — never as row chrome (the capability rule).
          title={`${providerLabel(conversation.agent)} · ${statusWord(dot)}${
            canRename ? " — double-click or F2 to rename" : ""
          }`}
          className={`flex w-full items-center gap-2 rounded-lg py-[5px] pl-[26px] pr-2 text-left text-ui transition-colors ${
            selected
              ? "text-text-primary"
              : "text-text-secondary hover:bg-bg-elevated hover:text-text-primary"
          }`}
          aria-current={selected ? "page" : undefined}
        >
          <StatusDot state={dot} />
          <span className="min-w-0 flex-1 truncate">
            {conversation.title || "(untitled)"}
          </span>
          {/* The hover actions sit ON this cell, so it fades rather than
              reflowing the row when the pointer arrives. */}
          <span className="shrink-0 font-mono text-meta text-text-faint transition-opacity group-focus-within:opacity-0 group-hover:opacity-0">
            {formatRelativeTime(conversation.updatedAt)}
          </span>
        </button>
        <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <button
            type="button"
            onClick={() => togglePinned(conversation.id)}
            className={`rounded p-0.5 hover:bg-bg-tertiary ${
              pinned ? "text-accent-amber" : "text-text-muted"
            }`}
            title={pinned ? "Unpin conversation" : "Pin conversation"}
          >
            <Pin size={10} className={pinned ? "fill-accent-amber" : ""} />
          </button>
          <button
            type="button"
            onClick={() =>
              conversation.archived
                ? unarchiveConversation(conversation.id)
                : archiveConversation(conversation.id)
            }
            className="rounded p-0.5 text-text-muted hover:bg-bg-tertiary hover:text-accent-green"
            title={conversation.archived ? "Unarchive conversation" : "Archive conversation"}
          >
            {conversation.archived ? <ArchiveRestore size={10} /> : <Archive size={10} />}
          </button>
          <button
            type="button"
            onClick={() => setPendingDelete(conversation)}
            className="rounded p-0.5 text-text-muted hover:bg-bg-tertiary hover:text-accent-red"
            title="Delete conversation"
          >
            <Trash2 size={10} />
          </button>
        </div>
      </div>
    );
  };

  /**
   * One session that exists only in the ENGINE's store.
   *
   * A `<button>` only where the engine advertised the spec `loadSession`
   * capability, because only there does a click DO something: adopting binds a
   * new PacketBench conversation to the engine's session id, and the first
   * message resumes it over ACP `session/load`. Where the engine cannot
   * resume, the row stays the non-button it has always been — a row that
   * looked clickable-to-open and then did nothing is precisely the silent
   * no-op the pane's governing rule forbids.
   *
   * Either way it is focusable so the keyboard rename (F2) works, and the
   * hollow ring in place of a `StatusDot` says at a glance that this row has
   * no live status of its own.
   */
  const renderEngineSession = (session: AcpSessionSummary) => {
    const when = formatEngineTime(session.updatedAt);
    const detail = engineSessionDetail(session);

    if (editing?.id === session.sessionId && editing.scope === "engine") {
      return (
        <div
          key={session.sessionId}
          className="group relative flex items-center gap-2 rounded-lg py-[5px] pl-[26px] pr-2"
        >
          <span
            aria-hidden="true"
            className="h-[6px] w-[6px] shrink-0 rounded-full border border-text-faint"
          />
          <input
            aria-label="Rename engine session"
            autoFocus
            value={editing.draft}
            onChange={(event) =>
              setEditing({ id: session.sessionId, draft: event.target.value, scope: "engine" })
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitRename();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setEditing(null);
              }
            }}
            onBlur={commitRename}
            className="min-w-0 flex-1 rounded-md border border-accent-blue bg-bg-elevated px-1 py-px text-ui text-text-primary outline-none"
          />
        </div>
      );
    }

    const startRename = () => {
      if (!engineCaps.canRename) return;
      setEditing({ id: session.sessionId, draft: session.name, scope: "engine" });
    };

    /** Adopt, then open the conversation the adoption created. A refused
     *  adoption (unknown row, engine that cannot load) resolves `null` and is
     *  left alone rather than opening something arbitrary. */
    const adopt = () => {
      void Promise.resolve(adoptEngineSession(session.sessionId))
        .then((conversationId) => {
          if (conversationId) onSelect(conversationId);
        })
        .catch(() => {
          // Adoption is a local record write; there is nothing to retry and
          // nothing was started on the engine. Never throw into render.
        });
    };

    const hint = engineCaps.canRename ? " — double-click or F2 to rename" : "";
    const rowClass =
      "group flex w-full items-center gap-2 rounded-lg py-[5px] pl-[26px] pr-2 text-left text-ui text-text-secondary transition-colors hover:bg-bg-elevated focus:outline-none focus-visible:bg-bg-elevated";
    const body = (
      <>
        <span
          aria-hidden="true"
          className="h-[6px] w-[6px] shrink-0 rounded-full border border-text-faint"
        />
        <span className="min-w-0 flex-1 truncate">{session.name || "(untitled)"}</span>
        {when && <span className="shrink-0 font-mono text-meta text-text-faint">{when}</span>}
      </>
    );

    if (canAdoptEngineSessions) {
      return (
        <button
          key={session.sessionId}
          type="button"
          onClick={adopt}
          onDoubleClick={startRename}
          onKeyDown={(event) => {
            if (event.key === "F2") {
              event.preventDefault();
              startRename();
            }
          }}
          title={`${detail} — open to resume on the engine${hint}`}
          className={rowClass}
        >
          {body}
        </button>
      );
    }

    return (
      <div
        key={session.sessionId}
        tabIndex={0}
        onDoubleClick={startRename}
        onKeyDown={(event) => {
          if (event.key === "F2") {
            event.preventDefault();
            startRename();
          }
        }}
        title={`${detail}${hint}`}
        className={rowClass}
      >
        {body}
      </div>
    );
  };

  const renderEngineSection = () => (
    <section className="mt-3 border-t border-line-soft pt-2">
      <div className="flex items-center gap-2 rounded-lg px-2 py-[4.5px]">
        <button
          type="button"
          onClick={() => setEngineOpen((open) => !open)}
          aria-expanded={engineOpen}
          title="Sessions stored by the packetcode engine"
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-ui font-semibold text-text-primary"
        >
          {engineOpen ? (
            <ChevronDown size={10} className="shrink-0 text-text-muted" />
          ) : (
            <ChevronRight size={10} className="shrink-0 text-text-muted" />
          )}
          <span className="min-w-0 flex-1 truncate">On the engine</span>
        </button>
        {engineOpen && engineStatus === "ready" && (
          <span className="shrink-0 font-mono text-meta text-text-faint">
            {engineRows.length}
          </span>
        )}
        {engineOpen && (
          <button
            type="button"
            onClick={() => void refreshEngineSessions?.()}
            disabled={engineStatus === "loading"}
            title="Re-read the engine's session list"
            className="rounded p-0.5 text-text-muted hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-40"
          >
            <RefreshCw
              size={10}
              className={
                engineStatus === "loading"
                  ? "animate-spin motion-reduce:animate-none"
                  : undefined
              }
            />
          </button>
        )}
      </div>

      {engineOpen && (
        <>
          {/* The honest framing, stated once at the top rather than implied by
              each row: these are the engine's records, PacketBench holds no
              transcript for them, and opening one resumes it on the engine
              rather than reconstructing a history here. */}
          <p className="px-2 pb-1.5 text-meta leading-snug text-text-muted">
            Sessions the packetcode engine is holding — from its own TUI, or from an earlier
            run.{" "}
            {canAdoptEngineSessions
              ? "Opening one resumes it on the engine, which keeps the history as context; PacketBench has no transcript for it, so the conversation starts from the point you open it."
              : "PacketBench has no transcript for these, and this engine cannot resume a session, so they cannot be opened here."}
            {engineCaps.canRename ? " They can be renamed." : " Renaming is unavailable."}
          </p>
          {engineStatus === "loading" && engineRows.length === 0 && (
            <p className="px-2 py-1 text-meta text-text-faint">Asking the engine…</p>
          )}
          {engineStatus === "unavailable" && (
            <p className="px-2 py-1 text-meta text-text-faint">
              Could not reach the packetcode engine, so its history is unknown.
            </p>
          )}
          {engineStatus === "ready" && engineRows.length === 0 && (
            <p className="px-2 py-1 text-meta text-text-faint">
              The engine is holding no sessions.
            </p>
          )}
          {engineRows.map(renderEngineSession)}
        </>
      )}
    </section>
  );

  return (
    <aside className="flex w-[252px] shrink-0 flex-col overflow-hidden border-r border-bg-border bg-bg-secondary">
      <div className="flex items-center gap-1.5 px-3 pb-1 pt-2.5">
        <span className="text-ui font-semibold text-text-primary">Agents</span>
        <Badge>{counts.all}</Badge>
        {needsYouIds.size > 0 && <Badge tone="amber">{needsYouIds.size}</Badge>}
        <span className="flex-1" />
      </div>

      <div className="px-2.5 pb-1 pt-1">
        <label className="flex items-center gap-1.5 rounded-lg border border-bg-border bg-bg-primary px-2 py-1">
          <Search size={11} className="shrink-0 text-text-muted" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search conversations…"
            className="min-w-0 flex-1 bg-transparent text-ui text-text-primary placeholder:text-text-muted focus:outline-none"
          />
        </label>
        <div className="mt-1.5 flex items-center gap-0.5">
          {(["all", "active", "done", "archived"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              className={`flex-1 rounded-md py-0.5 text-meta transition-colors ${
                filter === value
                  ? "bg-bg-hover text-text-primary"
                  : "text-text-muted hover:bg-bg-elevated hover:text-text-primary"
              }`}
            >
              {value === "all"
                ? "All"
                : value === "active"
                  ? "Active"
                  : value === "done"
                    ? "Done"
                    : "Archived"}
              <span className="ml-0.5 opacity-60">({counts[value]})</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2.5 py-3">
        {filtered.length === 0 ? (
          <EmptyState
            className="py-16"
            icon={deferredQuery ? <Search size={22} /> : <BellRing size={22} />}
            title={deferredQuery ? "No matching conversations" : "No conversations yet"}
            description={
              deferredQuery
                ? "Try a different title, project, or message."
                : "Start your first one with New agent below."
            }
          />
        ) : (
          <>
            {needsYou.length > 0 && (
              <section>
                <div className="flex items-center gap-1.5 px-2 pb-1 pt-1">
                  <BellRing size={10} className="text-accent-amber" />
                  <span className="text-meta uppercase tracking-[0.09em] text-accent-amber">
                    Needs you
                  </span>
                  <span className="ml-auto font-mono text-meta text-accent-amber">
                    {needsYou.length}
                  </span>
                </div>
                {needsYou.map((conversation) => renderConversation(conversation, true))}
              </section>
            )}
            {Array.from(groups.entries()).map(([key, conversationsInProject]) => {
              const example = conversationsInProject[0];
              if (!example) return null;
              return (
                <section key={key}>
                  <div
                    className="flex items-center gap-2 rounded-lg px-2 py-[4.5px] text-ui font-semibold text-text-primary"
                    title={example.projectPath}
                  >
                    {example.sshTarget ? (
                      <Server size={10} className="shrink-0 text-accent-green" />
                    ) : (
                      <FolderOpen size={10} className="shrink-0 text-text-muted" />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      {projectLabel(example, projectLabels)}
                    </span>
                    <span className="shrink-0 font-mono text-meta text-text-faint">
                      {conversationsInProject.length}
                    </span>
                  </div>
                  {conversationsInProject.map((conversation) =>
                    renderConversation(conversation, false),
                  )}
                </section>
              );
            })}
          </>
        )}

        {/* Engine sessions are a SEPARATE list, below and visually unlike the
            conversation groups above. A PacketBench conversation owns a full
            local transcript; an engine session is a remote handle with a
            summary and nothing behind it. Blending them would make a row that
            cannot be opened look exactly like one that can. */}
        {showEngineSessions && renderEngineSection()}

        {/* The pre-session MCP disclosure. Sits with the engine directory
            because both are things that are true BEFORE any conversation
            exists — and, like every affordance here, it renders only where the
            descriptor says there is something to disclose (`caps.mcp`). */}
        {showEngineSessions && (
          <AcpMcpConsent projectPath={consentProjectPath} caps={engineCaps} />
        )}
      </div>

      {/* Footer CTA — the ONE create control in this sidebar (the header "+"
          that called this identical handler is gone, mirroring FleetSidebar). */}
      <div className="border-t border-line-soft p-2.5">
        <button
          type="button"
          onClick={onNewAgent}
          title="New agent — opens the launch composer"
          className="bg-accent-green/15 hover:bg-accent-green/25 flex w-full items-center justify-center gap-1.5 rounded-lg border border-accent-line px-2 py-1.5 text-ui font-medium text-accent-green transition-colors"
        >
          <Plus size={11} />
          New agent
        </button>
      </div>

      {/* Delete discards the conversation's worktree + branch; the shared
          confirm names them (and any uncommitted changes) before the click. */}
      {pendingDelete && (
        <ConfirmDeleteConversationModal
          conversationId={pendingDelete.id}
          title={pendingDelete.title}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </aside>
  );
}
