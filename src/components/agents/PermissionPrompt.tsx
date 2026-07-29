import { useEffect, useRef, useState } from "react";
import {
  ShieldAlert,
  Check,
  X,
  Sparkles,
  AlertTriangle,
  ChevronRight,
  ChevronUp,
  MessageSquare,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import {
  derivePatternHint,
  parseBashCommand,
  isDestructiveBash,
} from "./permissionPatternHint";
import { ProvenanceChip } from "@/components/common/ProvenanceChip";
import type { PendingPermission } from "@/types/agent-conversation";

interface PermissionPromptProps {
  item: PendingPermission;
  onAllowOnce: (toolId: string) => void;
  onAllowAlways: (toolId: string) => void;
  /** P1-9 deny-and-continue: `reason`, when present, is steering text the
   * provider folds into the denial the model sees — rejection redirects the
   * agent instead of stalling the turn. */
  onDeny: (toolId: string, reason?: string) => void;
  /** B3: when set, the Allow split-button grows an "Always allow `<pattern>`"
   * scope that resolves the prompt as allow_always AND appends the derived
   * pattern to the conversation's allowedTools. */
  onAllowAlwaysWithPattern?: (toolId: string, pattern: string) => void;
  /** B3: current conversation's allowedTools snapshot. Used to (a) hide
   * the scope when allowedTools is undefined ("all tools allowed" mode —
   * appending would NARROW access, opposite intent) and (b) show
   * "already in this conversation" when the pattern is already in. */
  conversationAllowedTools?: string[];
  /** When true, this prompt is the current Y/N keyboard target — render
   * inline `(Y)` / `(N)` hints on the Allow and Deny buttons. */
  showKeyboardHints?: boolean;
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}


export function PermissionPrompt({
  item,
  onAllowOnce,
  onAllowAlways,
  onDeny,
  onAllowAlwaysWithPattern,
  conversationAllowedTools,
  showKeyboardHints,
}: PermissionPromptProps) {
  const pattern = derivePatternHint(item.name, item.arguments);
  // For bash, surface the real command up front instead of burying it in
  // raw JSON, and flag obviously-destructive commands so the prompt can
  // escalate from amber (caution) to red (danger).
  const bashCommand =
    item.name === "bash" ? parseBashCommand(item.arguments) : null;
  const destructive = bashCommand !== null && isDestructiveBash(bashCommand);
  const [showRaw, setShowRaw] = useState(false);
  // P1-9: the "Always allow rule" row folded into the Allow split-button as
  // a third scope. Shown only when:
  //   1. a non-null pattern was derived,
  //   2. the parent wired the handler,
  //   3. the conversation actually has an allowlist (undefined = "all
  //      tools allowed" — appending would narrow access, opposite intent).
  const canAppendRule =
    pattern !== null &&
    !!onAllowAlwaysWithPattern &&
    Array.isArray(conversationAllowedTools);
  const alreadyAllowed =
    canAppendRule && conversationAllowedTools!.includes(pattern!);

  // Allow split-button scope menu (opens upward — the prompt sits at the
  // bottom viewport edge).
  const [scopeOpen, setScopeOpen] = useState(false);
  const scopeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!scopeOpen) return;
    function handleClick(e: MouseEvent) {
      if (scopeRef.current && !scopeRef.current.contains(e.target as Node)) {
        setScopeOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [scopeOpen]);

  // Deny-and-continue reason input. While it's focused, the section's Y/N
  // handler stands down via its typing-context guard (INPUT target).
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  const submitDenyWithReason = () => {
    const trimmed = reason.trim();
    onDeny(item.id, trimmed.length > 0 ? trimmed : undefined);
  };

  return (
    <div
      className={`bg-bg-secondary border rounded p-3 flex flex-col gap-2 animate-[welcomeFadeIn_150ms_ease-out] motion-reduce:animate-none ${
        destructive ? "border-accent-red/40" : "border-accent-amber/40"
      }`}
    >
      <div className="flex items-center gap-2">
        {destructive ? (
          <AlertTriangle size={14} className="text-accent-red shrink-0" />
        ) : (
          <ShieldAlert size={14} className="text-accent-amber shrink-0" />
        )}
        <span className="text-ui text-text-primary">
          Run{" "}
          <code
            className={`font-mono ${destructive ? "text-accent-red" : "text-accent-amber"}`}
          >
            {item.name}
          </code>
          ?
        </span>
        {destructive && (
          <Badge tone="red" className="ml-auto">
            Destructive
          </Badge>
        )}
      </div>
      {bashCommand !== null ? (
        <>
          <pre
            className={`text-ui font-mono bg-bg-primary rounded p-2 max-h-32 overflow-auto whitespace-pre-wrap ${
              destructive ? "text-accent-red" : "text-text-primary"
            }`}
          >
            {bashCommand}
          </pre>
          <button
            type="button"
            onClick={() => setShowRaw((v) => !v)}
            className="flex items-center gap-1 text-ui text-text-muted hover:text-text-secondary transition-colors self-start"
          >
            <ChevronRight
              size={10}
              className={`transition-transform ${showRaw ? "rotate-90" : ""}`}
            />
            Raw arguments
          </button>
          {showRaw && (
            <pre className="text-meta font-mono bg-bg-primary rounded p-2 max-h-32 overflow-auto text-text-secondary whitespace-pre-wrap">
              {prettyJson(item.arguments)}
            </pre>
          )}
        </>
      ) : (
        <pre className="text-meta font-mono bg-bg-primary rounded p-2 max-h-32 overflow-auto text-text-secondary whitespace-pre-wrap">
          {prettyJson(item.arguments)}
        </pre>
      )}
      {item.sourceChain && item.sourceChain.length > 0 && (
        <div className="rounded border border-accent-amber/30 bg-accent-amber/5 p-2">
          <div className="mb-1 flex items-center justify-between gap-2 text-meta text-accent-amber">
            <span>
              Evidence boundary · {item.effectivePolicy ?? "explicit approval"}
            </span>
            <span>
              {item.sourceChain.length} source
              {item.sourceChain.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="flex flex-wrap gap-1">
            {item.sourceChain.map((source) => (
              <ProvenanceChip key={source.id} envelope={source} force />
            ))}
          </div>
        </div>
      )}
      <div className="flex gap-1.5 flex-wrap items-center">
        {/* Allow split-button: primary click = allow once (the Y target);
            the chevron opens a scope menu (once / session / saved rule). */}
        <div ref={scopeRef} className="relative flex">
          <button
            type="button"
            onClick={() => onAllowOnce(item.id)}
            className="flex items-center gap-1 text-ui px-2 py-1 rounded-l bg-accent-green/20 hover:bg-accent-green/30 text-accent-green font-medium transition-colors"
          >
            <Check size={12} /> Allow
            {showKeyboardHints && (
              <kbd className="ml-1 text-meta font-mono text-accent-green/80 border border-accent-green/40 rounded px-1 leading-none py-0.5">
                Y
              </kbd>
            )}
          </button>
          <button
            type="button"
            onClick={() => setScopeOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={scopeOpen}
            title="Allow with a wider scope"
            className="flex items-center px-1 py-1 rounded-r border-l border-accent-green/30 bg-accent-green/20 hover:bg-accent-green/30 text-accent-green transition-colors"
          >
            <ChevronUp
              size={12}
              className={`transition-transform motion-reduce:transition-none ${scopeOpen ? "rotate-180" : ""}`}
            />
          </button>
          {scopeOpen && (
            <div
              role="menu"
              className="absolute bottom-full left-0 mb-1 z-30 min-w-[220px] bg-bg-elevated border border-bg-border rounded-md shadow-xl py-1"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setScopeOpen(false);
                  onAllowOnce(item.id);
                }}
                className="w-full text-left px-3 py-1.5 text-ui text-text-primary hover:bg-bg-hover transition-colors"
              >
                Allow once
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setScopeOpen(false);
                  onAllowAlways(item.id);
                }}
                className="w-full text-left px-3 py-1.5 text-ui text-text-primary hover:bg-bg-hover transition-colors"
              >
                Allow for this session
                <span className="text-meta text-text-muted ml-1">
                  (no rule saved)
                </span>
              </button>
              {canAppendRule && (
                <button
                  type="button"
                  role="menuitem"
                  disabled={alreadyAllowed}
                  onClick={() => {
                    setScopeOpen(false);
                    onAllowAlwaysWithPattern!(item.id, pattern!);
                  }}
                  title={
                    alreadyAllowed
                      ? "Pattern already in this conversation's allowlist"
                      : "Always allow this pattern in this conversation"
                  }
                  className={`w-full text-left px-3 py-1.5 text-ui transition-colors flex items-center gap-1.5 ${
                    alreadyAllowed
                      ? "text-text-muted opacity-60 cursor-not-allowed"
                      : "text-accent-blue hover:bg-bg-hover"
                  }`}
                >
                  <Sparkles size={11} className="shrink-0" />
                  <span>Always allow</span>
                  <code className="font-mono text-meta bg-accent-blue/10 text-accent-blue px-1 rounded">
                    {pattern}
                  </code>
                  {alreadyAllowed && (
                    <span className="text-meta text-text-muted ml-auto">
                      already in
                    </span>
                  )}
                </button>
              )}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => onDeny(item.id)}
          className="ml-auto flex items-center gap-1 text-ui px-2 py-1 rounded bg-accent-red/15 hover:bg-accent-red/25 text-accent-red font-medium transition-colors"
        >
          <X size={12} /> Deny
          {showKeyboardHints && (
            <kbd className="ml-1 text-meta font-mono text-accent-red/80 border border-accent-red/40 rounded px-1 leading-none py-0.5">
              N
            </kbd>
          )}
        </button>
        <button
          type="button"
          onClick={() => setReasonOpen((v) => !v)}
          aria-expanded={reasonOpen}
          title="Deny and tell the agent what to do instead — the turn continues"
          className="flex items-center gap-1 text-ui px-1.5 py-1 rounded text-text-muted hover:text-accent-red transition-colors"
        >
          <MessageSquare size={11} />
          with reason…
        </button>
      </div>
      {/* Deny-and-continue: the reason steers the agent's next step instead
          of stalling the turn on a bare refusal. */}
      {reasonOpen && (
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitDenyWithReason();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setReasonOpen(false);
                setReason("");
              }
            }}
            placeholder="Why not / what to do instead — sent to the agent"
            aria-label="Denial reason"
            className="flex-1 bg-bg-primary border border-bg-border rounded px-2 py-1 text-ui text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-red/60"
          />
          <button
            type="button"
            onClick={submitDenyWithReason}
            className="flex items-center gap-1 text-ui px-2 py-1 rounded bg-accent-red/15 hover:bg-accent-red/25 text-accent-red font-medium transition-colors"
          >
            <X size={12} /> Deny & steer
          </button>
        </div>
      )}
    </div>
  );
}
