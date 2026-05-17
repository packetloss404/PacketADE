import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  Eye,
  PanelLeft,
  Check,
  FileDiff,
  FolderTree,
} from "lucide-react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import {
  aggregateConversationDiffs,
  type PerFileDiffStat,
} from "@/lib/aggregateConversationDiffs";
import { aggregateConversationCost, formatCostPill } from "@/lib/conversationCost";
import { API_PROVIDERS } from "@/lib/api-models";
import { AgentPreviewPane } from "./AgentPreviewPane";
import { EmbeddedDiffPane } from "./EmbeddedDiffPane";
import { AgentFilePane } from "./AgentFilePane";
import { usePreviewPaneStore } from "@/stores/previewPaneStore";
import { logSwallowed } from "@/lib/logSwallowed";

interface AgentInspectorPaneProps {
  conversationId: string;
}

type Tab = "inspector" | "preview" | "diff" | "files";

const TAB_DEFS: { id: Tab; icon: typeof PanelLeft; label: string }[] = [
  { id: "inspector", icon: PanelLeft, label: "Inspector" },
  { id: "preview", icon: Eye, label: "Preview" },
  { id: "diff", icon: FileDiff, label: "Diff" },
  { id: "files", icon: FolderTree, label: "Files" },
];

const WIDTH_STORAGE_KEY = "packetade:agent-inspector-width-v1";
const MIN_WIDTH = 280;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 340;

function readPersistedWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_STORAGE_KEY);
    if (!raw) return DEFAULT_WIDTH;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return DEFAULT_WIDTH;
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, n));
  } catch {
    return DEFAULT_WIDTH;
  }
}

function persistWidth(w: number) {
  try {
    localStorage.setItem(WIDTH_STORAGE_KEY, String(w));
  } catch (err) {
    logSwallowed("AgentInspectorPane.persistWidth")(err);
  }
}

export function AgentInspectorPane({ conversationId }: AgentInspectorPaneProps) {
  const conversation = useAgentTaskStore((s) =>
    s.conversations.find((c) => c.id === conversationId),
  );
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<Tab>("inspector");
  const [width, setWidth] = useState<number>(() => readPersistedWidth());
  const [isDragging, setIsDragging] = useState(false);

  // Auto-switch to the Preview tab when the preview store flips to open
  // (e.g. clicking a .md link in chat or detecting a plan response).
  const previewOpen = usePreviewPaneStore((s) => s.open);
  const prevPreviewOpenRef = useRef(previewOpen);
  useEffect(() => {
    if (previewOpen && !prevPreviewOpenRef.current) {
      setTab("preview");
      setOpen(true);
    }
    prevPreviewOpenRef.current = previewOpen;
  }, [previewOpen]);

  // Global pointer-move / up listeners while dragging.
  useEffect(() => {
    if (!isDragging) return;
    const handleMove = (e: PointerEvent) => {
      const next = window.innerWidth - e.clientX;
      const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, next));
      setWidth(clamped);
    };
    const handleUp = () => {
      setIsDragging(false);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };
  }, [isDragging]);

  // Persist on drag-end (not on every pointermove).
  useEffect(() => {
    if (!isDragging) {
      persistWidth(width);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDragging]);

  if (!conversation) return null;

  if (!open) {
    return (
      <div className="w-[30px] shrink-0 bg-bg-secondary border-l border-bg-border flex flex-col items-center py-2 gap-1">
        <button
          onClick={() => setOpen(true)}
          title="Show right pane"
          className="w-6 h-6 grid place-items-center text-text-muted hover:text-text-primary rounded transition-colors"
        >
          <ChevronRight size={12} className="rotate-180" />
        </button>
        <div className="w-px h-2 bg-line-soft" />
        {TAB_DEFS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => {
                setTab(t.id);
                setOpen(true);
              }}
              title={t.label}
              className={`w-6 h-6 grid place-items-center rounded transition-colors ${
                tab === t.id
                  ? "bg-bg-elevated text-text-primary"
                  : "text-text-muted hover:text-text-secondary"
              }`}
            >
              <Icon size={12} />
            </button>
          );
        })}
        <div className="flex-1" />
      </div>
    );
  }

  return (
    <aside
      className="relative shrink-0 bg-bg-secondary border-l border-bg-border flex flex-col min-h-0"
      style={{ width }}
    >
      {/* Drag handle on the left edge. Sits above the border so it picks up
          pointer events first. */}
      <div
        onPointerDown={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        className={`absolute top-0 left-0 h-full w-1 cursor-col-resize z-10 transition-colors ${
          isDragging ? "bg-accent-line" : "bg-transparent hover:bg-accent-line/60"
        }`}
        title="Drag to resize"
        aria-label="Resize right pane"
        role="separator"
      />
      <div className="flex items-stretch h-[33px] border-b border-bg-border px-1">
        {TAB_DEFS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-2.5 text-[11px] border-b-2 transition-colors ${
                active
                  ? "border-accent-green text-text-primary"
                  : "border-transparent text-text-muted hover:text-text-secondary"
              }`}
            >
              <Icon size={11} />
              <span>{t.label}</span>
            </button>
          );
        })}
        <div className="flex-1" />
        <button
          onClick={() => setOpen(false)}
          title="Collapse pane"
          className="self-center w-6 h-[22px] grid place-items-center text-text-muted hover:text-text-primary rounded transition-colors"
        >
          <ChevronRight size={12} />
        </button>
      </div>
      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        {tab === "inspector" && (
          <div className="flex-1 overflow-auto flex flex-col min-h-0">
            <InspectorContent conversationId={conversationId} />
          </div>
        )}
        {tab === "preview" && (
          <AgentPreviewPane
            projectPath={conversation.projectPath}
            embedded
            onRequestClose={() => setTab("inspector")}
          />
        )}
        {tab === "diff" && (
          conversation.mode === "api" ? (
            <EmbeddedDiffPane conversationId={conversationId} />
          ) : (
            <div className="flex-1 flex items-center justify-center px-6 text-center bg-bg-primary">
              <span className="text-[11px] text-text-muted max-w-[220px]">
                Diffs are only tracked for API-mode conversations.
              </span>
            </div>
          )
        )}
        {tab === "files" && (
          <AgentFilePane
            conversationId={conversationId}
            projectPath={conversation.projectPath}
            sshTarget={conversation.sshTarget ?? null}
          />
        )}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* Inspector content                                                   */
/* ------------------------------------------------------------------ */

function InspectorContent({ conversationId }: { conversationId: string }) {
  const conversation = useAgentTaskStore((s) =>
    s.conversations.find((c) => c.id === conversationId),
  );
  const [files, setFiles] = useState<PerFileDiffStat[]>([]);
  const [totals, setTotals] = useState<{ adds: number; dels: number; count: number }>({
    adds: 0,
    dels: 0,
    count: 0,
  });

  const messageCount = conversation?.messages.length ?? 0;
  useEffect(() => {
    if (!conversation || conversation.mode !== "api") {
      setFiles([]);
      setTotals({ adds: 0, dels: 0, count: 0 });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const r = await aggregateConversationDiffs(conversation);
        if (cancelled) return;
        setFiles(r.perFile);
        setTotals({ adds: r.totalAdds, dels: r.totalDels, count: r.fileCount });
      } catch {
        if (!cancelled) {
          setFiles([]);
          setTotals({ adds: 0, dels: 0, count: 0 });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?.id, conversation?.mode, messageCount]);

  // Plan progress derived from the latest assistant plan message containing
  // a checkbox list. Best-effort and graceful when none is present.
  const plan = useMemo(() => deriveLatestPlan(conversation?.messages ?? []), [conversation?.messages]);

  // Session metadata
  const provider = API_PROVIDERS.find((p) => p.agentCli === conversation?.agent);
  const modelLabel =
    provider?.models.find((m) => m.value === conversation?.model)?.label ??
    conversation?.model ??
    "—";
  const startedRel = conversation ? relTime(Date.now() - conversation.createdAt) : "—";
  const { totalTokens, estCost } = conversation
    ? aggregateConversationCost(conversation)
    : { totalTokens: 0, estCost: 0 };
  const costLabel = formatCostPill(estCost, totalTokens) ?? "$0.00";

  return (
    <>
      {/* Files changed */}
      <div>
        <SectionHeader
          label="Files changed"
          right={`${totals.count} · +${totals.adds} −${totals.dels}`}
        />
        <div className="p-2 flex flex-col gap-1.5">
          {files.length === 0 ? (
            <span className="text-[10px] text-text-muted px-1 py-1">
              No edits in this conversation yet.
            </span>
          ) : (
            files.map((f, i) => <FileChangedRow key={i} stat={f} />)
          )}
        </div>
      </div>

      {/* Plan progress */}
      <div>
        <SectionHeader
          label="Plan progress"
          right={plan ? `${plan.done} / ${plan.items.length}` : "—"}
        />
        <div className="px-2.5 py-2 flex flex-col gap-1.5 text-[11.5px]">
          {plan && plan.items.length > 0 ? (
            plan.items.map((s, i) => (
              <div key={i} className="flex items-center gap-2">
                <span
                  className={`w-3 h-3 rounded-sm shrink-0 grid place-items-center border ${
                    s.done
                      ? "bg-accent-green border-accent-green"
                      : s.run
                        ? "border-accent-green"
                        : "border-line-strong"
                  }`}
                >
                  {s.done && <Check size={8} className="text-bg-primary" strokeWidth={3} />}
                  {s.run && (
                    <span className="w-1 h-1 rounded-full bg-accent-amber animate-pulse" />
                  )}
                </span>
                <span
                  className={
                    s.done
                      ? "text-text-muted line-through"
                      : "text-text-secondary"
                  }
                >
                  {s.label}
                </span>
              </div>
            ))
          ) : (
            <span className="text-[10px] text-text-muted">No active plan.</span>
          )}
        </div>
      </div>

      {/* Session info */}
      <div>
        <SectionHeader label="Session" />
        <div className="px-2.5 py-2 text-[11px] text-text-secondary flex flex-col gap-1.5">
          <KvRow
            k="Agent"
            v={
              <span>
                <span className="text-accent-green font-medium">
                  {agentDisplayName(conversation?.agent ?? "")}
                </span>
                <span className="text-text-muted"> · {modelLabel}</span>
              </span>
            }
          />
          {conversation?.sshTarget && (
            <KvRow
              k="Host"
              v={
                <span className="font-mono text-accent-blue">
                  {conversation.sshTarget.user}@{conversation.sshTarget.host}
                </span>
              }
            />
          )}
          <KvRow
            k="Worktree"
            v={
              <span className="font-mono text-[10.5px] truncate">
                {conversation?.projectPath ?? "—"}
              </span>
            }
          />
          <KvRow k="Started" v={startedRel} />
          <KvRow k="Cost" v={<span className="font-mono">{costLabel}</span>} />
          <KvRow
            k="Tokens"
            v={<span className="font-mono">{totalTokens.toLocaleString()}</span>}
          />
        </div>
      </div>
    </>
  );
}

function SectionHeader({ label, right }: { label: string; right?: string }) {
  return (
    <div className="px-2.5 py-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted bg-bg-tertiary border-y border-line-soft">
      <ChevronDown size={10} />
      <span>{label}</span>
      <span className="flex-1" />
      {right && (
        <span className="font-mono normal-case tracking-normal text-[10px] text-text-secondary">
          {right}
        </span>
      )}
    </div>
  );
}

function FileChangedRow({ stat }: { stat: PerFileDiffStat }) {
  const cells = 24;
  const pos = stat.adds + stat.dels;
  const addsCells = pos === 0 ? 0 : Math.max(1, Math.round((stat.adds / pos) * cells));
  const delsCells = pos === 0 ? 0 : Math.max(stat.dels > 0 ? 1 : 0, cells - addsCells);
  return (
    <div className="px-2 py-1.5 rounded border border-bg-border bg-bg-tertiary">
      <div className="flex items-center gap-1.5 mb-1">
        <FileIcon size={10} className="text-text-muted" />
        <span className="font-mono text-[10.5px] text-text-primary truncate flex-1" title={stat.path}>
          {basename(stat.path)}
        </span>
        <span className="font-mono text-[9.5px] text-accent-green">+{stat.adds}</span>
        <span className="font-mono text-[9.5px] text-accent-red">−{stat.dels}</span>
      </div>
      <div className="flex gap-px h-[3px] rounded overflow-hidden">
        {Array.from({ length: cells }).map((_, j) => {
          const filled =
            j < addsCells
              ? "bg-accent-green"
              : j < addsCells + delsCells
                ? "bg-accent-red"
                : "bg-bg-elevated";
          return <div key={j} className={`flex-1 ${filled} opacity-90`} />;
        })}
      </div>
    </div>
  );
}

function KvRow({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-[70px] text-text-muted">{k}</span>
      <span className="flex-1 min-w-0 truncate">{v}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function basename(p: string): string {
  const segs = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return segs[segs.length - 1] ?? p;
}

function relTime(ms: number): string {
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function agentDisplayName(agent: string): string {
  const provider = API_PROVIDERS.find((p) => p.agentCli === agent);
  if (provider) return provider.name.replace(" (API)", "").replace(" (Local)", "");
  const labels: Record<string, string> = {
    "claude-code": "Claude",
    codex: "Codex",
    gemini: "Gemini",
    opencode: "OpenCode",
    packetcode: "PacketCode",
  };
  return labels[agent] ?? agent;
}

interface PlanItem {
  done: boolean;
  run: boolean;
  label: string;
}

function deriveLatestPlan(messages: { role: string; content: string }[]): {
  items: PlanItem[];
  done: number;
} | null {
  // Walk backward looking for a recent assistant message that contains
  // markdown checkbox items. Returns null if none found.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const items = parseChecklistFromMarkdown(m.content);
    if (items.length > 0) {
      const done = items.filter((it) => it.done).length;
      return { items, done };
    }
  }
  return null;
}

function parseChecklistFromMarkdown(md: string): PlanItem[] {
  const out: PlanItem[] = [];
  for (const raw of md.split(/\r?\n/)) {
    const m = raw.match(/^\s*[-*]\s*\[([ xX~-])\]\s+(.+?)\s*$/);
    if (!m) continue;
    const ch = m[1];
    const label = m[2];
    const done = ch.toLowerCase() === "x";
    const run = ch === "~" || ch === "-";
    out.push({ done, run: !done && run, label });
  }
  return out;
}
