import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  Eye,
  PanelLeft,
  Check,
} from "lucide-react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import {
  aggregateConversationDiffs,
  type PerFileDiffStat,
} from "@/lib/aggregateConversationDiffs";
import { aggregateConversationCost, formatCostPill } from "@/lib/conversationCost";
import { API_PROVIDERS } from "@/lib/api-models";

interface AgentInspectorPaneProps {
  conversationId: string;
}

type Tab = "inspector" | "preview";

export function AgentInspectorPane({ conversationId }: AgentInspectorPaneProps) {
  const conversation = useAgentTaskStore((s) =>
    s.conversations.find((c) => c.id === conversationId),
  );
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<Tab>("inspector");

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
        {(["inspector", "preview"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => {
              setTab(t);
              setOpen(true);
            }}
            title={t === "inspector" ? "Inspector" : "Preview"}
            className={`w-6 h-6 grid place-items-center rounded transition-colors ${
              tab === t
                ? "bg-bg-elevated text-text-primary"
                : "text-text-muted hover:text-text-secondary"
            }`}
          >
            {t === "inspector" ? <PanelLeft size={12} /> : <Eye size={12} />}
          </button>
        ))}
        <div className="flex-1" />
      </div>
    );
  }

  return (
    <aside className="w-[340px] shrink-0 bg-bg-secondary border-l border-bg-border flex flex-col min-h-0">
      <div className="flex items-stretch h-[33px] border-b border-bg-border px-1">
        {(
          [
            { id: "inspector", icon: PanelLeft, label: "Inspector" },
            { id: "preview", icon: Eye, label: "Preview" },
          ] as { id: Tab; icon: typeof PanelLeft; label: string }[]
        ).map((t) => {
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
      <div className="flex-1 overflow-auto flex flex-col min-h-0">
        {tab === "inspector" ? (
          <InspectorContent conversationId={conversationId} />
        ) : (
          <PreviewBrowser conversationId={conversationId} />
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
/* Preview tab — static placeholder browser chrome                     */
/* ------------------------------------------------------------------ */

function PreviewBrowser({ conversationId }: { conversationId: string }) {
  const conversation = useAgentTaskStore((s) =>
    s.conversations.find((c) => c.id === conversationId),
  );
  const folder = basename(conversation?.projectPath ?? "");
  return (
    <div className="flex-1 flex flex-col min-h-0 bg-bg-primary">
      <div className="px-2 py-1.5 flex items-center gap-1.5 bg-bg-tertiary border-b border-line-soft">
        <button className="p-0.5 text-text-muted hover:text-text-primary rounded">
          <ChevronRight size={11} className="rotate-180" />
        </button>
        <button className="p-0.5 text-text-muted hover:text-text-primary rounded">
          <ChevronRight size={11} />
        </button>
        <div className="flex-1 flex items-center gap-1.5 px-2 py-0.5 bg-bg-secondary border border-bg-border rounded text-[10.5px] font-mono">
          <span className="w-2 h-2 rounded-full bg-text-muted" />
          <span className="text-text-muted">localhost:</span>
          <span className="text-text-primary">1420</span>
          <span className="text-text-muted">/agents/{conversationId.slice(0, 6)}</span>
          <span className="flex-1" />
          <span className="text-[9px] text-text-muted">static</span>
        </div>
      </div>
      <div className="px-2 py-1 flex items-center gap-1.5 border-b border-line-soft bg-bg-secondary text-[10px] text-text-muted">
        <span className="w-1.5 h-1.5 rounded-full bg-text-muted" />
        <span>Static preview state</span>
        <span>·</span>
        <span className="font-mono">{folder || "preview"}</span>
        <span className="flex-1" />
        <div className="flex border border-bg-border rounded overflow-hidden">
          {["Desktop", "Tablet", "Mobile"].map((m, i) => (
            <span
              key={m}
              className={`px-1.5 py-px text-[10px] ${
                i === 0
                  ? "bg-bg-elevated text-text-primary"
                  : "text-text-muted hover:text-text-secondary"
              }`}
            >
              {m}
            </span>
          ))}
        </div>
      </div>
      <div
        className="flex-1 p-2.5 overflow-auto"
        style={{
          background:
            "repeating-linear-gradient(45deg, var(--color-bg-primary) 0 10px, var(--color-bg-secondary) 10px 11px)",
        }}
      >
        <div className="bg-bg-secondary border border-bg-border rounded overflow-hidden shadow-md">
          <div className="px-2 py-1.5 border-b border-line-soft flex items-center gap-1 bg-bg-tertiary">
            <span className="w-[7px] h-[7px] rounded-full bg-accent-red" />
            <span className="w-[7px] h-[7px] rounded-full bg-accent-amber" />
            <span className="w-[7px] h-[7px] rounded-full bg-accent-green" />
            <span className="flex-1" />
            <span className="text-[9px] text-text-muted">Agent chat · sample</span>
          </div>
          <div className="p-2.5 flex flex-col gap-2">
            <div className="flex gap-1.5">
              <div className="w-3.5 h-3.5 rounded-sm bg-accent-soft border border-accent-line shrink-0" />
              <div className="flex-1">
                <div className="h-1.5 bg-bg-elevated rounded mb-1 w-3/5" />
                <div className="h-1 bg-bg-tertiary rounded mb-0.5" />
                <div className="h-1 bg-bg-tertiary rounded w-[85%]" />
              </div>
            </div>
            <div className="bg-bg-tertiary border border-bg-border rounded p-1.5 flex flex-col gap-1">
              <div className="flex items-center gap-1">
                <FileIcon size={9} className="text-text-secondary" />
                <span className="text-[9px] font-mono text-text-primary">
                  Edit · {folder || "file"}
                </span>
                <span className="flex-1" />
                <span className="w-1 h-1 rounded-full bg-accent-green" />
              </div>
              <div className="h-1 rounded bg-accent-green/20" />
              <div className="h-1 rounded bg-accent-red/20 w-[55%]" />
            </div>
          </div>
        </div>
        <div className="mt-2 text-[9.5px] text-text-muted text-center">
          Static sample; connect a local preview to inspect running changes
        </div>
      </div>
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
