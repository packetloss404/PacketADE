import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckSquare,
  File as FileIcon,
  FileText,
  Eye,
  PanelLeft,
  FileDiff,
  FolderTree,
  AlertCircle,
} from "lucide-react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useAgentPlanStore } from "@/stores/agentPlanStore";
import {
  aggregateConversationDiffs,
  type PerFileDiffStat,
} from "@/lib/aggregateConversationDiffs";
import { aggregateConversationCost } from "@/lib/conversationCost";
import { API_PROVIDERS } from "@/lib/api-models";
import { AgentPreviewPane } from "./AgentPreviewPane";
import { ReviewSurface } from "./review/ReviewSurface";
import { AgentFilePane } from "./AgentFilePane";
import { PlanPanel } from "./PlanPanel";
import { EditorDockPanel } from "@/components/editor/EditorDockPanel";
import { RightDock, type RightDockPanel } from "@/components/layout/RightDock";
import { useRightDockStore } from "@/stores/rightDockStore";
import { usePreviewPaneStore } from "@/stores/previewPaneStore";
import { openInEditor } from "@/lib/openInEditor";
import {
  isRemoteConversation,
  REMOTE_UNSUPPORTED_TOOLTIP,
} from "@/lib/remoteConversation";
import { useUnviewedCount } from "./review/useUnviewedCount";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { getAgentColor } from "@/lib/agentColors";

interface AgentInspectorPaneProps {
  conversationId: string;
}

/**
 * D2 — the Agents surface's `RightDock` host.
 *
 * The five inspector "tabs" are now dock panels (plus the reconnected Editor
 * from D5), so mutual exclusion, width arbitration and collapse are the dock's
 * job rather than five pieces of local component state. Preview in particular
 * is a real dock panel now instead of a free-floating global (P0-3).
 */
export function AgentInspectorPane({ conversationId }: AgentInspectorPaneProps) {
  const conversation = useAgentTaskStore((s) =>
    s.conversations.find((c) => c.id === conversationId),
  );
  const unreviewedCount = useUnviewedCount(conversationId);
  const openPanel = useRightDockStore((s) => s.openPanel);
  // D3 / P0-4: Preview + Editor read LOCAL disk, so they are disabled (not
  // hidden) for SSH-backed conversations until a remote file contract exists.
  const remote = isRemoteConversation(conversation);

  // Auto-reveal the Preview panel when a NEW preview target lands for THIS
  // conversation (a .md click in chat, a plan-shaped response). Scoped by
  // conversation id, so conversation B never steals conversation A's preview.
  const previewTarget = usePreviewPaneStore((s) => s.target);
  const previewSignature =
    previewTarget && previewTarget.conversationId === conversationId
      ? `${previewTarget.activeTab}:${previewTarget.markdownPath ?? ""}:${previewTarget.planContent.length}`
      : null;
  const prevPreviewSignatureRef = useRef(previewSignature);
  useEffect(() => {
    if (
      previewSignature &&
      previewSignature !== prevPreviewSignatureRef.current &&
      !remote
    ) {
      openPanel("agents", "preview");
    }
    prevPreviewSignatureRef.current = previewSignature;
  }, [previewSignature, remote, openPanel]);

  // Peer effect: reveal the Plan panel on the rising edge of "plan arrives",
  // so we never steal a panel the user picked while a plan already existed.
  const planCount = useAgentPlanStore(
    (s) => s.plan.get(conversationId)?.length ?? 0,
  );
  const prevPlanCountRef = useRef(planCount);
  useEffect(() => {
    if (planCount > 0 && prevPlanCountRef.current === 0) {
      openPanel("agents", "plan");
    }
    prevPlanCountRef.current = planCount;
  }, [planCount, openPanel]);

  const panels = useMemo<RightDockPanel[]>(() => {
    if (!conversation) return [];
    return [
      {
        id: "inspector",
        label: "Inspector",
        icon: PanelLeft,
        render: () => (
          <div className="flex min-h-0 flex-1 flex-col overflow-auto">
            <InspectorContent conversationId={conversationId} />
          </div>
        ),
      },
      {
        id: "plan",
        label: "Plan",
        icon: CheckSquare,
        render: () => (
          <div className="min-h-0 flex-1 overflow-auto">
            <PlanPanel conversation={conversation} />
          </div>
        ),
      },
      {
        id: "preview",
        label: "Preview",
        icon: Eye,
        disabled: remote,
        disabledReason: REMOTE_UNSUPPORTED_TOOLTIP,
        render: () => (
          <AgentPreviewPane
            conversationId={conversationId}
            projectPath={conversation.projectPath}
            remote={remote}
            embedded
          />
        ),
      },
      {
        id: "diff",
        label: "Diff",
        icon: FileDiff,
        badge: unreviewedCount,
        render: () =>
          conversation.mode === "api" ? (
            <ReviewSurface conversationId={conversationId} embedded />
          ) : (
            <div className="flex flex-1 items-center justify-center bg-bg-primary">
              <EmptyState
                icon={<FileDiff size={24} />}
                title="Diffs are only tracked for API-mode conversations."
              />
            </div>
          ),
      },
      {
        id: "files",
        label: "Files",
        icon: FolderTree,
        render: () => (
          <AgentFilePane
            conversationId={conversationId}
            projectPath={conversation.projectPath}
            sshTarget={conversation.sshTarget ?? null}
            // D5 / P1-5: Files advertised a preview path that was never wired
            // — `onSelectFile` had no producer. Rows now open the file in the
            // dock Editor, which renders `.md` through MarkdownRenderer.
            onSelectFile={(absolutePath) =>
              openInEditor(absolutePath, {
                projectPath: conversation.projectPath,
                remote,
                surface: "agents",
              })
            }
          />
        ),
      },
      {
        id: "editor",
        label: "Editor",
        icon: FileText,
        disabled: remote,
        disabledReason: REMOTE_UNSUPPORTED_TOOLTIP,
        render: () => <EditorDockPanel />,
      },
    ];
  }, [conversation, conversationId, remote, unreviewedCount]);

  if (!conversation) return null;

  return <RightDock surface="agents" panels={panels} ariaLabel="Inspector views" />;
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
  const [unavailableCount, setUnavailableCount] = useState(0);

  const messageCount = conversation?.messages.length ?? 0;
  useEffect(() => {
    if (!conversation || conversation.mode !== "api") {
      setFiles([]);
      setTotals({ adds: 0, dels: 0, count: 0 });
      setFilesLoading(false);
      setFilesError(false);
      setUnavailableCount(0);
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
        setUnavailableCount(r.unavailableCount);
      } catch {
        if (!cancelled) {
          setFiles([]);
          setTotals({ adds: 0, dels: 0, count: 0 });
          setUnavailableCount(0);
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

  // Session metadata
  const provider = API_PROVIDERS.find((p) => p.agentCli === conversation?.agent);
  const modelLabel =
    provider?.models.find((m) => m.value === conversation?.model)?.label ??
    conversation?.model ??
    "—";
  const startedRel = conversation ? relTime(Date.now() - conversation.createdAt) : "—";
  // Tokens only. The dollar figure that used to sit next to this was part of
  // the cost reporting surface removed on 2026-07-31; token counts stay because
  // they are the measurement the prompt-caching work depends on.
  const { totalTokens } = conversation
    ? aggregateConversationCost(conversation)
    : { totalTokens: 0 };

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
            <span className="flex items-center gap-1.5 text-ui text-text-muted px-1 py-1">
              <Spinner size={10} />
              Computing edits…
            </span>
          ) : filesError ? (
            <span className="flex items-center gap-1.5 text-ui text-accent-red px-1 py-1">
              <AlertCircle size={10} />
              Could not compute edits.
            </span>
          ) : files.length === 0 ? (
            <span className="text-ui text-text-muted px-1 py-1">
              No edits in this conversation yet.
            </span>
          ) : (
            <>
              {unavailableCount > 0 && (
                <span className="flex items-center gap-1.5 text-ui text-accent-amber px-1 py-1">
                  <AlertCircle size={10} />
                  {unavailableCount}{" "}
                  {unavailableCount === 1 ? "file" : "files"} could not be
                  diffed — totals are incomplete.
                </span>
              )}
              {files.map((f, i) => (
                <FileChangedRow key={i} stat={f} />
              ))}
            </>
          )}
        </div>
      </div>

      {/* Session info */}
      <div>
        <SectionHeader label="Session" />
        <div className="px-2.5 py-2 text-ui text-text-secondary flex flex-col gap-1.5">
          <KvRow
            k="Agent"
            v={
              <span>
                <span className={`${getAgentColor(conversation?.agent ?? "").text} font-medium`}>
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
                className="font-mono text-ui truncate"
                title={conversation?.projectPath ?? undefined}
              >
                {conversation?.projectPath ?? "—"}
              </span>
            }
          />
          <KvRow k="Started" v={startedRel} />
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
    <div className="px-2.5 py-1.5 flex items-center gap-1.5 text-meta font-semibold uppercase tracking-wide text-text-faint bg-bg-tertiary border-y border-line-soft">
      <span>{label}</span>
      <span className="flex-1" />
      {right && (
        <span className="font-mono normal-case tracking-normal text-meta text-text-secondary">
          {right}
        </span>
      )}
    </div>
  );
}

function FileChangedRow({ stat }: { stat: PerFileDiffStat }) {
  const cells = 24;
  // D3 / P0-4: a failed/remote diff is NOT a zero-line diff. Say so instead of
  // rendering "+0 −0", which reads as "this file didn't really change".
  if (stat.unavailable) {
    return (
      <div className="px-2 py-1.5 rounded border border-accent-amber/30 bg-bg-tertiary">
        <div className="flex items-center gap-1.5">
          <AlertCircle size={10} className="text-accent-amber shrink-0" />
          <span
            className="font-mono text-ui text-text-primary truncate flex-1"
            title={stat.path}
          >
            {basename(stat.path)}
          </span>
          <span className="text-meta text-accent-amber shrink-0">
            {stat.unavailable === "remote"
              ? "diff unavailable (SSH)"
              : "diff unavailable"}
          </span>
        </div>
      </div>
    );
  }
  const pos = stat.adds + stat.dels;
  const addsCells = pos === 0 ? 0 : Math.max(1, Math.round((stat.adds / pos) * cells));
  const delsCells = pos === 0 ? 0 : Math.max(stat.dels > 0 ? 1 : 0, cells - addsCells);
  return (
    <div className="px-2 py-1.5 rounded border border-bg-border bg-bg-tertiary">
      <div className="flex items-center gap-1.5 mb-1">
        <FileIcon size={10} className="text-text-muted" />
        <span className="font-mono text-ui text-text-primary truncate flex-1" title={stat.path}>
          {basename(stat.path)}
        </span>
        <span className="font-mono text-meta text-accent-green">+{stat.adds}</span>
        <span className="font-mono text-meta text-accent-red">−{stat.dels}</span>
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
    opencode: "OpenCode",
    packetcode: "PacketCode",
  };
  return labels[agent] ?? agent;
}
