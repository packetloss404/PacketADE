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

  // Allow split-button scope menu. Opens UPWARD: the card is inline in the
  // transcript now (B3) rather than pinned to a footer band, but a live
  // approval is still almost always the last thing in the scroll, so a
  // downward menu would open off the bottom of the viewport.
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

  // B3 chrome: the card now renders INLINE in the transcript at the call site,
  // so it has to read as part of the conversation rather than as a footer
  // band. One card background (`bg-bg-tertiary`, the transcript's only card
  // fill), a 3px accent spine on the leading edge, and an uppercase eyebrow
  // that names the state before the target. Tone is amber for "decide this",
  // escalating to red when the command is destructive.
  //
  // `box` and `spine` are DELIBERATELY separate classes. A single accent
  // `border-<color>` alongside `border-l-[3px]` paints all FOUR edges in the
  // accent, which turns the card into an outlined box instead of a neutral
  // card with one accent edge. Tailwind's borderColor plugin emits
  // `.border-l-<color>` after `.border-<color>`, so the leading edge wins on
  // source order and the other three stay neutral. Do not collapse these two
  // back into one class.
  //
  // The spine carries NO `/opacity` modifier on purpose. Graphite tokens are
  // `var(--color-…)` strings in `tailwind.config.ts` with no `<alpha-value>`
  // placeholder, and Tailwind v3 cannot compute an alpha over a value it
  // cannot parse — so `border-l-accent-amber/70` compiles to NOTHING and the
  // left edge silently falls back to the box color, i.e. no spine at all.
  // (That is the same reason the old `border-accent-amber/60` produced a
  // preflight-gray box rather than an amber one.) `box` stays neutral for
  // both tones for the same reason: a `border-accent-red/30` tint is not
  // expressible today. Escalation lives in the spine, the eyebrow, the
  // Destructive badge and the consequence sentence — all of which do render.
  const tone = destructive
    ? {
        box: "border-bg-border",
        spine: "border-l-accent-red",
        eyebrow: "text-accent-red",
      }
    : {
        box: "border-bg-border",
        spine: "border-l-accent-amber",
        eyebrow: "text-accent-amber",
      };

  return (
    <div
      data-approval-id={item.id}
      className={`flex flex-col gap-2 rounded-xl border border-l-[3px] bg-bg-tertiary p-3.5 animate-[welcomeFadeIn_150ms_ease-out] motion-reduce:animate-none ${tone.box} ${tone.spine}`}
    >
      <div
        className={`flex items-center gap-1.5 text-meta font-semibold uppercase tracking-[0.07em] ${tone.eyebrow}`}
      >
        {destructive ? (
          <AlertTriangle size={11} className="shrink-0" />
        ) : (
          <ShieldAlert size={11} className="shrink-0" />
        )}
        Permission required
        {destructive && (
          <Badge tone="red" className="ml-auto">
            Destructive
          </Badge>
        )}
      </div>
      <div className="flex items-baseline gap-2">
        <code className="font-mono text-body text-text-primary">
          {item.name}
        </code>
        {item.safeTarget && (
          <span className="truncate font-mono text-ui text-text-secondary">
            {item.safeTarget}
          </span>
        )}
      </div>
      {bashCommand !== null ? (
        <>
          <pre
            className={`selectable text-ui font-mono bg-bg-primary rounded-lg border border-bg-border p-2 max-h-32 overflow-auto whitespace-pre-wrap ${
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
            <pre className="selectable text-meta font-mono bg-bg-primary rounded-lg border border-bg-border p-2 max-h-32 overflow-auto text-text-secondary whitespace-pre-wrap">
              {prettyJson(item.arguments)}
            </pre>
          )}
        </>
      ) : (
        <pre className="selectable text-meta font-mono bg-bg-primary rounded-lg border border-bg-border p-2 max-h-32 overflow-auto text-text-secondary whitespace-pre-wrap">
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
      {/* Name the consequence in words. A color escalation alone does not slow
          a reflexive click; a sentence does. Destructive-only — on an ordinary
          prompt it would be noise that trains people to skip the line. */}
      {destructive && (
        <p className="text-ui text-accent-red">
          This command can delete or overwrite files that git is not tracking.
        </p>
      )}
      <div className="mt-0.5 flex flex-wrap items-center gap-2">
        {/* Allow and Deny are ONE non-wrapping group. They used to be direct
            children of the wrapping row with `ml-auto` on Deny, so a narrow
            mosaic tile could wrap Deny onto its own line — splitting the exact
            pair the Y/N keys mirror. Only the tertiary "with reason…" floats
            right now. Keep these two inside this group. */}
        <div data-testid="approval-verbs" className="flex items-center gap-2">
          {/* Allow split-button: primary click = allow once (the Y target);
              the chevron opens a scope menu (once / session / saved rule). */}
          <div ref={scopeRef} className="relative flex">
            <button
              type="button"
              onClick={() => onAllowOnce(item.id)}
              aria-keyshortcuts={showKeyboardHints ? "y" : undefined}
              className="flex items-center gap-1 rounded-l-lg border border-accent-green/40 bg-accent-green/15 px-3 py-1 text-ui font-semibold text-accent-green transition-colors hover:bg-accent-green/25 motion-reduce:transition-none"
            >
              <Check size={12} /> Allow
              {showKeyboardHints && (
                <kbd
                  aria-hidden="true"
                  className="ml-1 rounded border border-accent-green/30 px-1 py-0.5 font-mono text-meta leading-none text-accent-green/70"
                >
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
              className="flex items-center rounded-r-lg border border-l-0 border-accent-green/40 bg-accent-green/15 px-1.5 py-1 text-accent-green transition-colors hover:bg-accent-green/25 motion-reduce:transition-none"
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
          {/* Equal weight with Allow — this is a safety gate, and PacketBench
              does not know which answer is right, so neither verb may
              dominate. Escalation lives in the card's spine, eyebrow and
              Destructive badge, never in the verbs. */}
          <button
            type="button"
            onClick={() => onDeny(item.id)}
            aria-keyshortcuts={showKeyboardHints ? "n" : undefined}
            className="flex items-center gap-1 rounded-lg border border-accent-red/40 bg-accent-red/15 px-3 py-1 text-ui font-semibold text-accent-red transition-colors hover:bg-accent-red/25 motion-reduce:transition-none"
          >
            <X size={12} /> Deny
            {showKeyboardHints && (
              <kbd
                aria-hidden="true"
                className="ml-1 rounded border border-accent-red/30 px-1 py-0.5 font-mono text-meta leading-none text-accent-red/70"
              >
                N
              </kbd>
            )}
          </button>
        </div>
        <button
          type="button"
          onClick={() => setReasonOpen((v) => !v)}
          aria-expanded={reasonOpen}
          title="Deny and tell the agent what to do instead — the turn continues"
          className="ml-auto flex items-center gap-1 rounded px-1.5 py-1 text-ui text-text-muted transition-colors hover:text-accent-red motion-reduce:transition-none"
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
            className="flex-1 bg-bg-primary border border-bg-border rounded-lg px-2 py-1 text-ui text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-red/60"
          />
          <button
            type="button"
            onClick={submitDenyWithReason}
            className="flex items-center gap-1 text-ui px-3 py-1 rounded-lg border border-accent-red/40 bg-accent-red/15 hover:bg-accent-red/25 text-accent-red font-semibold transition-colors"
          >
            <X size={12} /> Deny & steer
          </button>
        </div>
      )}
    </div>
  );
}
