// Shared presentation for the git-host credential flows.
//
// These three pieces are used by BOTH the first-time setup wizard and the
// edit/rotate modal. They live here rather than in either owner so the two
// flows cannot drift: a user rotating an expired token must read the same nine
// verdicts, in the same words, as the user who first connected the host.
//
// SECURITY: none of these components ever receives the token. `WizardVerdict`
// is produced by `verdictFor`, which is given the probe *result* only.

import { AlertTriangle, CheckCircle2, ExternalLink, XCircle } from "lucide-react";
import type { GitHostWizardDescriptor, WizardVerdict } from "@/lib/gitHostWizard";

/** The required/optional scopes for a host, plus where to create the token. */
export function ScopeList({
  descriptor,
  origin,
}: {
  descriptor: GitHostWizardDescriptor;
  origin: string | null;
}) {
  const createUrl = descriptor.tokenCreateUrl(origin);
  return (
    <div className="rounded border border-bg-border bg-bg-primary px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-text-muted">
        Scopes this token needs
      </div>
      <ul className="mt-1.5 flex flex-col gap-1">
        {descriptor.scopes.map((scope) => (
          <li key={scope.id} className="flex items-start gap-2 text-[10px]">
            <code className="mt-px flex-shrink-0 rounded bg-bg-elevated px-1 py-px font-mono text-[10px] text-text-primary">
              {scope.id}
            </code>
            <span className="text-text-muted">
              {scope.reason}
              {scope.optional && <span className="text-text-faint"> (optional)</span>}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[10px] text-text-muted">{descriptor.tokenCreateHint}</p>
      {createUrl && (
        <a
          href={createUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-flex items-center gap-1 text-[10px] text-accent-green hover:underline"
        >
          <ExternalLink size={10} />
          Create a token on {descriptor.label}
        </a>
      )}
    </div>
  );
}

/** One of the nine probe verdicts, rendered with its remedy. */
export function VerdictCard({
  verdict,
  endpoint,
}: {
  verdict: WizardVerdict;
  endpoint: string | null;
}) {
  const tone =
    verdict.level === "ok"
      ? { border: "border-accent-green/30", bg: "bg-accent-green/10", text: "text-accent-green" }
      : verdict.level === "warning"
        ? { border: "border-accent-amber/30", bg: "bg-accent-amber/10", text: "text-accent-amber" }
        : { border: "border-accent-red/30", bg: "bg-accent-red/10", text: "text-accent-red" };
  const Icon =
    verdict.level === "ok" ? CheckCircle2 : verdict.level === "warning" ? AlertTriangle : XCircle;
  return (
    <div
      role={verdict.level === "error" ? "alert" : "status"}
      data-verdict={verdict.code}
      className={`flex items-start gap-2 rounded border px-3 py-2.5 ${tone.border} ${tone.bg}`}
    >
      <Icon size={14} className={`mt-0.5 flex-shrink-0 ${tone.text}`} />
      <div className="min-w-0">
        <div className={`text-[11px] font-medium ${tone.text}`}>{verdict.title}</div>
        <p className="mt-0.5 text-[10px] leading-snug text-text-secondary">{verdict.detail}</p>
        {verdict.remedy && (
          <p className="mt-1 text-[10px] leading-snug text-text-muted">{verdict.remedy}</p>
        )}
        {verdict.missingScopes && verdict.missingScopes.length > 0 && (
          <ul className="mt-1.5 flex flex-wrap gap-1">
            {verdict.missingScopes.map((scope) => (
              <li
                key={scope}
                className="rounded bg-bg-elevated px-1 py-px font-mono text-[10px] text-text-primary"
              >
                {scope}
              </li>
            ))}
          </ul>
        )}
        {endpoint && (
          <p className="mt-1.5 break-all font-mono text-[10px] text-text-faint">{endpoint}</p>
        )}
      </div>
    </div>
  );
}

/** A command-level rejection (argument validation), not a host verdict. */
export function FieldError({ message }: { message: string }) {
  return (
    <p role="alert" className="flex items-start gap-1.5 text-[10px] text-accent-red">
      <XCircle size={10} className="mt-0.5 flex-shrink-0" />
      {message}
    </p>
  );
}
