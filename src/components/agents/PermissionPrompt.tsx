import { ShieldAlert, Check, X, Sparkles } from "lucide-react";
import { derivePatternHint } from "./permissionPatternHint";

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
    <div className="bg-bg-secondary border border-accent-amber/40 rounded p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <ShieldAlert size={14} className="text-accent-amber shrink-0" />
        <span className="text-xs text-text-primary">
          Run <code className="font-mono text-accent-amber">{item.name}</code>?
        </span>
      </div>
      <pre className="text-[10px] font-mono bg-bg-primary rounded p-2 max-h-32 overflow-auto text-text-secondary whitespace-pre-wrap">
        {prettyJson(item.arguments)}
      </pre>
      <div className="flex gap-1.5 flex-wrap">
        <button
          type="button"
          onClick={() => onAllowOnce(item.id)}
          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-accent-green/40 text-accent-green hover:bg-accent-green/10"
        >
          <Check size={12} /> Allow once
          {showKeyboardHints && (
            <kbd className="ml-1 text-[9.5px] font-mono text-accent-green/80 border border-accent-green/40 rounded px-1 leading-none py-0.5">
              Y
            </kbd>
          )}
        </button>
        <button
          type="button"
          onClick={() => onAllowAlways(item.id)}
          title="Always allow this tool for the rest of the session (no rule saved)"
          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-accent-green/40 text-accent-green hover:bg-accent-green/10"
        >
          <Check size={12} /> Always allow
        </button>
        <button
          type="button"
          onClick={() => onDeny(item.id)}
          className="ml-auto flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-accent-red/40 text-accent-red hover:bg-accent-red/10"
        >
          <X size={12} /> Deny
          {showKeyboardHints && (
            <kbd className="ml-1 text-[9.5px] font-mono text-accent-red/80 border border-accent-red/40 rounded px-1 leading-none py-0.5">
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
          className={`flex items-center gap-1.5 text-[11px] px-2 py-1 rounded border w-full justify-start ${
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
            <span className="text-[9.5px] text-text-faint ml-auto">
              already in conversation
            </span>
          )}
        </button>
      )}
    </div>
  );
}
