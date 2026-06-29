import { useState } from "react";
import { ShieldAlert, Check, X, Sparkles, AlertTriangle, ChevronRight } from "lucide-react";
import {
  derivePatternHint,
  parseBashCommand,
  isDestructiveBash,
} from "./permissionPatternHint";

interface PermissionPromptProps {
  item: { id: string; name: string; arguments: string };
  onAllowOnce: (toolId: string) => void;
  onAllowAlways: (toolId: string) => void;
  onDeny: (toolId: string) => void;
  /** B3: when set, render a fourth "Always allow `<pattern>`" row that
   * resolves the prompt as allow_always AND appends the derived pattern
   * to the conversation's allowedTools. Deferred profile-write goes via
   * a follow-up that adds sourceProfileId to AgentConversation. */
  onAllowAlwaysWithPattern?: (toolId: string, pattern: string) => void;
  /** B3: current conversation's allowedTools snapshot. Used to (a) hide
   * the row when allowedTools is undefined ("all tools allowed" mode —
   * appending would NARROW access, opposite intent) and (b) show
   * "(already in this conversation)" when the pattern is already in. */
  conversationAllowedTools?: string[];
  /** When true, this prompt is the current Y/N keyboard target — render
   * inline `(Y)` / `(N)` hints on the Allow-once and Deny buttons. */
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
  // Show the smart-allow row only when:
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

  return (
    <div
      className={`bg-bg-secondary border rounded p-3 flex flex-col gap-2 ${
        destructive ? "border-accent-red/40" : "border-accent-amber/40"
      }`}
    >
      <div className="flex items-center gap-2">
        {destructive ? (
          <AlertTriangle size={14} className="text-accent-red shrink-0" />
        ) : (
          <ShieldAlert size={14} className="text-accent-amber shrink-0" />
        )}
        <span className="text-xs text-text-primary">
          Run{" "}
          <code
            className={`font-mono ${destructive ? "text-accent-red" : "text-accent-amber"}`}
          >
            {item.name}
          </code>
          ?
        </span>
        {destructive && (
          <span className="ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded bg-accent-red/20 text-accent-red">
            Destructive
          </span>
        )}
      </div>
      {bashCommand !== null ? (
        <>
          <pre
            className={`text-[11px] font-mono bg-bg-primary rounded p-2 max-h-32 overflow-auto whitespace-pre-wrap ${
              destructive ? "text-accent-red" : "text-text-primary"
            }`}
          >
            {bashCommand}
          </pre>
          <button
            type="button"
            onClick={() => setShowRaw((v) => !v)}
            className="flex items-center gap-1 text-[10px] text-text-muted hover:text-text-secondary transition-colors self-start"
          >
            <ChevronRight
              size={10}
              className={`transition-transform ${showRaw ? "rotate-90" : ""}`}
            />
            Raw arguments
          </button>
          {showRaw && (
            <pre className="text-[10px] font-mono bg-bg-primary rounded p-2 max-h-32 overflow-auto text-text-secondary whitespace-pre-wrap">
              {prettyJson(item.arguments)}
            </pre>
          )}
        </>
      ) : (
        <pre className="text-[10px] font-mono bg-bg-primary rounded p-2 max-h-32 overflow-auto text-text-secondary whitespace-pre-wrap">
          {prettyJson(item.arguments)}
        </pre>
      )}
      <div className="flex gap-1.5 flex-wrap">
        <button
          type="button"
          onClick={() => onAllowOnce(item.id)}
          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-accent-green/20 hover:bg-accent-green/30 text-accent-green font-medium transition-colors"
        >
          <Check size={12} /> Allow once
          {showKeyboardHints && (
            <kbd className="ml-1 text-[10px] font-mono text-accent-green/80 border border-accent-green/40 rounded px-1 leading-none py-0.5">
              Y
            </kbd>
          )}
        </button>
        <button
          type="button"
          onClick={() => onAllowAlways(item.id)}
          title="Always allow this tool for the rest of the session (no rule saved)"
          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-accent-green/40 text-accent-green hover:bg-accent-green/10 transition-colors"
        >
          <Check size={12} /> Always allow
          <span className="text-[10px] text-text-muted">(session)</span>
        </button>
        <button
          type="button"
          onClick={() => onDeny(item.id)}
          className="ml-auto flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-accent-red/15 hover:bg-accent-red/25 text-accent-red font-medium transition-colors"
        >
          <X size={12} /> Deny
          {showKeyboardHints && (
            <kbd className="ml-1 text-[10px] font-mono text-accent-red/80 border border-accent-red/40 rounded px-1 leading-none py-0.5">
              N
            </kbd>
          )}
        </button>
      </div>
      {/* B3 — Codex-style smart-rule proposal. One-click writes the
          derived pattern into the conversation's allowedTools so future
          turns of this conversation skip the prompt entirely. */}
      {canAppendRule && (
        <button
          type="button"
          onClick={() =>
            onAllowAlwaysWithPattern!(item.id, pattern!)
          }
          disabled={alreadyAllowed}
          title={
            alreadyAllowed
              ? `Pattern already in this conversation's allowlist`
              : `Always allow this pattern in this conversation`
          }
          className={`flex items-center gap-1.5 text-[11px] px-2 py-1 rounded border w-full justify-start transition-colors ${
            alreadyAllowed
              ? "border-bg-border text-text-muted opacity-60 cursor-not-allowed"
              : "border-accent-blue/40 text-accent-blue hover:bg-accent-blue/10"
          }`}
        >
          <Sparkles size={12} />
          <span>Always allow rule</span>
          <code className="font-mono text-[10px] bg-accent-blue/10 text-accent-blue px-1 rounded">
            {pattern}
          </code>
          {alreadyAllowed && (
            <span className="text-[10px] text-text-muted ml-auto">
              already in conversation
            </span>
          )}
        </button>
      )}
    </div>
  );
}
