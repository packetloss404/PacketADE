import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckSquare,
  ChevronRight,
  File as FileIcon,
  Eye,
  PanelLeft,
  Check,
  FileDiff,
  FolderTree,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useAgentPlanStore } from "@/stores/agentPlanStore";
import {
  aggregateConversationDiffs,
  type PerFileDiffStat,
} from "@/lib/aggregateConversationDiffs";
import { aggregateConversationCost, formatCostPill } from "@/lib/conversationCost";
import { API_PROVIDERS } from "@/lib/api-models";
import { AgentPreviewPane } from "./AgentPreviewPane";
import { EmbeddedDiffPane } from "./EmbeddedDiffPane";
import { AgentFilePane } from "./AgentFilePane";
import { PlanPanel } from "./PlanPanel";
import { usePreviewPaneStore } from "@/stores/previewPaneStore";
import { logSwallowed } from "@/lib/logSwallowed";
import { useReviewedDiffs } from "./hooks/useReviewedDiffs";

interface AgentInspectorPaneProps {
  conversationId: string;
}

type Tab = "inspector" | "plan" | "preview" | "diff" | "files";

const TAB_DEFS: { id: Tab; icon: typeof PanelLeft; label: string }[] = [
  { id: "inspector", icon: PanelLeft, label: "Inspector" },
  { id: "plan", icon: CheckSquare, label: "Plan" },
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
  const { unreviewedCount } = useReviewedDiffs(conversationId);

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

  // Auto-switch to the Plan tab on the rising edge of "plan arrives".
  // Peer effect to the Preview auto-switch above; uses the same rising-edge
  // pattern so we never steal focus from a tab the user manually picked
  // while the plan was already populated.
  const planCount = useAgentPlanStore(
    (s) => s.plan.get(conversationId)?.length ?? 0,
  );
  const prevPlanCountRef = useRef(planCount);
  useEffect(() => {
    if (planCount > 0 && prevPlanCountRef.current === 0) {
      setTab("plan");
      setOpen(true);
    }
    prevPlanCountRef.current = planCount;
  }, [planCount]);

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
        <div role="tablist" aria-label="Inspector views" className="contents">
        {TAB_DEFS.map((t) => {
          const Icon = t.icon;
          const showBadge = t.id === "diff" && unreviewedCount > 0;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              aria-label={t.label}
              onClick={() => {
                setTab(t.id);
                setOpen(true);
              }}
              title={
                showBadge
                  ? `${t.label} (${unreviewedCount} unreviewed)`
                  : t.label
              }
              className={`relative w-6 h-6 grid place-items-center rounded transition-colors ${
                tab === t.id
                  ? "bg-bg-elevated text-text-primary"
                  : "text-text-muted hover:text-text-secondary"
              }`}
            >
              <Icon size={12} />
              {showBadge && <UnreviewedBadge count={unreviewedCount} compact />}
            </button>
          );
        })}
        </div>
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
        onKeyDown={(e) => {
          const step = e.shiftKey ? 32 : 8;
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            setWidth((w) => {
              const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w + step));
              persistWidth(next);
              return next;
            });
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            setWidth((w) => {
              const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w - step));
              persistWidth(next);
              return next;
            });
          }
        }}
        className={`absolute top-0 left-0 h-full w-1 cursor-col-resize z-10 transition-colors ${
          isDragging ? "bg-accent-line" : "bg-transparent hover:bg-accent-line/60"
        }`}
        title="Drag to resize"
        aria-label="Resize right pane"
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={Math.round(width)}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        tabIndex={0}
      />
      <div
        role="tablist"
        aria-label="Inspector views"
        className="flex items-stretch h-[33px] border-b border-bg-border px-1"
      >
        {TAB_DEFS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          const showBadge = t.id === "diff" && unreviewedCount > 0;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.id)}
              className={`relative flex items-center gap-1.5 px-2.5 text-[11px] border-b-2 transition-colors ${
                active
                  ? "border-accent-green text-text-primary"
                  : "border-transparent text-text-muted hover:text-text-secondary"
              }`}
              title={
                showBadge ? `${t.label} (${unreviewedCount} unreviewed)` : undefined
              }
            >
              <Icon size={11} />
              <span>{t.label}</span>
              {showBadge && <UnreviewedBadge count={unreviewedCount} />}
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
        {tab === "plan" && (
          <div className="flex-1 overflow-auto min-h-0">
            <PlanPanel conversation={conversation} />
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
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState(false);

  const messageCount = conversation?.messages.length ?? 0;
  useEffect(() => {
    if (!conversation || conversation.mode !== "api") {
      setFiles([]);
      setTotals({ adds: 0, dels: 0, count: 0 });
      setFilesLoading(false);
      setFilesError(false);
      return;
    }
    let cancelled = false;
    setFilesLoading(true);
    setFilesError(false);
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
          setFilesError(true);
        }
      } finally {
        if (!cancelled) setFilesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?.id, conversation?.mode, messageCount]);

  // Tick once a minute so the "Started" relative time stays fresh.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setNowTick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

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
          {filesLoading ? (
            <span className="flex items-center gap-1.5 text-[10px] text-text-muted px-1 py-1">
              <Loader2 size={10} className="animate-spin motion-reduce:animate-none" />
              Computing edits…
            </span>
          ) : filesError ? (
            <span className="flex items-center gap-1.5 text-[10px] text-accent-red px-1 py-1">
              <AlertCircle size={10} />
              Could not compute edits.
            </span>
          ) : files.length === 0 ? (
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
        <div className="px-2.5 py-2 flex flex-col gap-1.5 text-[11px]">
          {plan && plan.items.length > 0 ? (
            plan.items.map((s, i) => (
              <div key={i} className="flex items-center gap-2">
                <span
                  className={`w-3 h-3 rounded shrink-0 grid place-items-center border ${
                    s.done
                      ? "bg-accent-green border-accent-green"
                      : s.run
                        ? "border-accent-green"
                        : "border-line-strong"
                  }`}
                >
                  {s.done && <Check size={10} className="text-bg-primary" strokeWidth={3} />}
                  {s.run && (
                    <span className="w-1 h-1 rounded-full bg-accent-amber animate-pulse motion-reduce:animate-none" />
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
              <span
                className="font-mono text-[11px] truncate"
                title={conversation?.projectPath ?? undefined}
              >
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
    <div className="px-2.5 py-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-faint bg-bg-tertiary border-y border-line-soft">
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
        <span className="font-mono text-[11px] text-text-primary truncate flex-1" title={stat.path}>
          {basename(stat.path)}
        </span>
        <span className="font-mono text-[10px] text-accent-green">+{stat.adds}</span>
        <span className="font-mono text-[10px] text-accent-red">−{stat.dels}</span>
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

/**
 * Small accent-green pill rendered on the Diff tab when there are
 * unreviewed `write_file` tool calls. Caps display at "9+" so the badge
 * stays compact. `compact=true` is used in the mini-icon strip (collapsed
 * sidebar) where the host button is only 24px wide.
 */
function UnreviewedBadge({
  count,
  compact = false,
}: {
  count: number;
  compact?: boolean;
}) {
  const label = count > 9 ? "9+" : String(count);
  if (compact) {
    return (
      <span
        className="absolute -top-0.5 -right-0.5 min-w-[12px] h-[12px] px-[3px] grid place-items-center rounded-full bg-accent-green text-[9px] font-mono font-semibold text-bg-primary leading-none pointer-events-none"
        aria-label={`${count} unreviewed`}
      >
        {label}
      </span>
    );
  }
  return (
    <span
      className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-1 grid place-items-center rounded-full bg-accent-green text-[9px] font-mono font-semibold text-bg-primary leading-none pointer-events-none"
      aria-label={`${count} unreviewed`}
    >
      {label}
    </span>
  );
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
