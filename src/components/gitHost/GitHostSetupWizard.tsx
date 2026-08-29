// Guided git-host setup.
//
// Replaces "find the right Settings card and know in advance what to paste"
// with a four-step flow that validates at every step instead of at the end:
// pick a host → normalise the instance URL (and show what it normalised to) →
// enter a token with its required scopes spelled out → verify the credential
// against the live host BEFORE anything is written → confirm what the
// connection resolved to and which connection workspaces will use.
//
// There are no per-host branches in this file. Everything host-specific comes
// from a descriptor in `lib/gitHostWizard.ts`; adding a forge is a descriptor.
//
// SECURITY (see also the module header in `lib/gitHostProbe.ts`):
//  * The token lives in one piece of component state and nowhere else. It is
//    passed to exactly two backend calls — the probe (never persists) and the
//    descriptor's `save` (the existing keyring command) — and is wiped when the
//    wizard unmounts, when the user steps back, and immediately after a
//    successful save.
//  * The field is `type="password"` with `autoComplete="off"`; there is no
//    reveal toggle, deliberately.
//  * No error string is built from the token. Verdict copy comes from
//    `verdictFor`, which never receives it.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Info,
  Loader2,
  Lock,
  ShieldCheck,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { HostIcon } from "@/components/HostIcon";
// Shared with the edit/rotate modal so both flows render the same verdicts.
import { FieldError, ScopeList, VerdictCard } from "@/components/gitHost/GitHostVerdict";
import { useGitHubStore } from "@/stores/githubStore";
import { probeGitHostCredential } from "@/lib/gitHostProbe";
import {
  GIT_HOST_WIZARD_DESCRIPTORS,
  defaultConnectionLabel,
  normalizeInstanceUrl,
  verdictFor,
  wizardSteps,
  type GitHostWizardDescriptor,
  type WizardStep,
  type WizardVerdict,
} from "@/lib/gitHostWizard";

interface GitHostSetupWizardProps {
  onClose: () => void;
  /** Pre-select a host so a "add a self-hosted instance" entry point can skip
   *  the picker's default. The user can still change it. */
  initialDescriptorId?: string;
  /** Called with the new connection id once the wizard finishes. */
  onConnected?: (connectionId: string) => void;
}

export function GitHostSetupWizard({
  onClose,
  initialDescriptorId,
  onConnected,
}: GitHostSetupWizardProps) {
  const connections = useGitHubStore((s) => s.connections);
  const activeConnectionId = useGitHubStore((s) => s.activeConnectionId);
  const loadConnections = useGitHubStore((s) => s.loadConnections);
  const setActiveConnection = useGitHubStore((s) => s.setActiveConnection);
  const initializeAuth = useGitHubStore((s) => s.initializeAuth);

  const [descriptorId, setDescriptorId] = useState<string | null>(initialDescriptorId ?? null);
  const descriptor = useMemo(
    () => GIT_HOST_WIZARD_DESCRIPTORS.find((d) => d.id === descriptorId) ?? null,
    [descriptorId],
  );
  const steps = useMemo(() => wizardSteps(descriptor), [descriptor]);
  const [step, setStep] = useState<WizardStep>(() => {
    const preset = GIT_HOST_WIZARD_DESCRIPTORS.find((d) => d.id === initialDescriptorId);
    if (!preset || preset.unsupported) return "host";
    return preset.needsInstanceUrl ? "instance" : "token";
  });

  const [urlInput, setUrlInput] = useState("");
  const [urlTouched, setUrlTouched] = useState(false);
  const [label, setLabel] = useState("");

  // The credential. Component state only — never a store, never persisted.
  const [token, setToken] = useState("");

  const [verifying, setVerifying] = useState(false);
  const [verdict, setVerdict] = useState<WizardVerdict | null>(null);
  const [probeEndpoint, setProbeEndpoint] = useState<string | null>(null);
  const [verifiedLogin, setVerifiedLogin] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  const [useNow, setUseNow] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedConnectionId, setSavedConnectionId] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Belt and braces: drop the credential on the way out rather than relying
      // on React discarding the fibre.
      setToken("");
    };
  }, []);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  const normalized = useMemo(
    () => (descriptor && descriptor.needsInstanceUrl ? normalizeInstanceUrl(urlInput, descriptor) : null),
    [descriptor, urlInput],
  );
  const origin = normalized?.ok ? normalized.value : null;
  const baseUrl = descriptor?.needsInstanceUrl ? (origin ?? "") : (descriptor?.fixedBaseUrl ?? "");

  const stepIndex = steps.findIndex((s) => s.id === step);
  const headingId = useId();
  const urlFieldId = `${headingId}-url`;
  const labelFieldId = `${headingId}-label`;
  const tokenFieldId = `${headingId}-token`;

  function selectDescriptor(next: GitHostWizardDescriptor) {
    if (next.unsupported) return;
    setDescriptorId(next.id);
    setVerdict(null);
    setStep(next.needsInstanceUrl ? "instance" : "token");
  }

  function goBack() {
    setVerdict(null);
    setFatal(null);
    if (step === "verify") {
      // Stepping back off the verify screen discards the credential: the user
      // is going to re-enter or re-paste it anyway.
      setToken("");
      setStep("token");
      return;
    }
    if (step === "token") {
      setToken("");
      setStep(descriptor?.needsInstanceUrl ? "instance" : "host");
      return;
    }
    if (step === "instance") {
      setStep("host");
      setDescriptorId(null);
    }
  }

  const runVerification = useCallback(async () => {
    if (!descriptor) return;
    setVerifying(true);
    setVerdict(null);
    setFatal(null);
    try {
      const result = await probeGitHostCredential(baseUrl, descriptor.probe, token);
      if (!mountedRef.current) return;
      setProbeEndpoint(result.endpoint);
      setVerifiedLogin(result.login);
      setVerdict(verdictFor(descriptor, result));
    } catch (e) {
      if (!mountedRef.current) return;
      // Command-level rejection (malformed URL, unencodable token). The Rust
      // side never puts the token in these; they are argument validation.
      setFatal(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setVerifying(false);
    }
  }, [descriptor, baseUrl, token]);

  // Verification runs on arrival at the verify step, so the user never has to
  // find a "test" button — and never gets a late failure at save time.
  useEffect(() => {
    if (step === "verify" && !verdict && !verifying && !fatal) {
      void runVerification();
    }
    // `runVerification` is stable for a given descriptor/url/token triple.
  }, [step, verdict, verifying, fatal, runVerification]);

  async function handleSave() {
    if (!descriptor || !verdict?.canSave) return;
    setSaving(true);
    setFatal(null);
    try {
      const resolvedLabel = label.trim() || defaultConnectionLabel(descriptor, baseUrl);
      const { connectionId } = await descriptor.save({
        baseUrl: descriptor.needsInstanceUrl ? baseUrl : "",
        label: resolvedLabel,
        token,
      });
      // The credential is in the keyring now; drop our copy immediately.
      setToken("");
      await loadConnections();
      if (useNow) {
        setActiveConnection(connectionId, true);
      } else if (connectionId === activeConnectionId) {
        void initializeAuth();
      }
      if (!mountedRef.current) return;
      setSavedConnectionId(connectionId);
      setStep("done");
      onConnected?.(connectionId);
    } catch (e) {
      if (!mountedRef.current) return;
      setFatal(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  const otherConnections = connections.filter((c) => c.id !== savedConnectionId);

  const footer = (
    <div className="flex items-center justify-between gap-3">
      <div className="text-[10px] text-text-muted">
        {step === "done" ? (
          <span className="inline-flex items-center gap-1">
            <Lock size={10} />
            Token stored in the OS keyring.
          </span>
        ) : (
          <span>
            Step {Math.max(stepIndex, 0) + 1} of {steps.length}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        {step !== "host" && step !== "done" && (
          <button
            type="button"
            onClick={goBack}
            disabled={verifying || saving}
            className="inline-flex items-center gap-1 rounded px-2.5 py-1 text-[11px] text-text-muted transition-colors hover:text-text-primary disabled:opacity-40"
          >
            <ArrowLeft size={11} />
            Back
          </button>
        )}
        {step === "instance" && (
          <PrimaryButton
            onClick={() => setStep("token")}
            disabled={!normalized?.ok}
            label="Continue"
          />
        )}
        {step === "token" && (
          <PrimaryButton
            onClick={() => setStep("verify")}
            disabled={!token.trim()}
            label="Verify token"
          />
        )}
        {step === "verify" && (
          <>
            <button
              type="button"
              onClick={() => void runVerification()}
              disabled={verifying}
              className="rounded px-2.5 py-1 text-[11px] text-text-muted transition-colors hover:text-text-primary disabled:opacity-40"
            >
              Verify again
            </button>
            <PrimaryButton
              onClick={() => void handleSave()}
              disabled={!verdict?.canSave || saving || verifying}
              label={saving ? "Saving…" : "Save connection"}
            />
          </>
        )}
        {step === "done" && <PrimaryButton onClick={onClose} label="Done" />}
      </div>
    </div>
  );

  return (
    <Modal
      onClose={saving ? () => {} : onClose}
      closeDisabled={saving}
      title="Connect a git host"
      icon={<ShieldCheck size={14} className="text-accent-green" />}
      width="w-[560px] max-w-[94vw]"
      footer={footer}
    >
      <div className="px-5 py-4">
        <StepRail steps={steps} currentIndex={stepIndex} />

        {step === "host" && (
          <fieldset className="mt-4">
            <legend id={`${headingId}-hosts`} className="mb-2 text-[11px] text-text-secondary">
              Which git host are you connecting?
            </legend>
            <div
              role="radiogroup"
              aria-labelledby={`${headingId}-hosts`}
              className="flex flex-col gap-1.5"
            >
              {GIT_HOST_WIZARD_DESCRIPTORS.map((d) => (
                <HostOption
                  key={d.id}
                  descriptor={d}
                  selected={descriptorId === d.id}
                  onSelect={() => selectDescriptor(d)}
                />
              ))}
            </div>
          </fieldset>
        )}

        {step === "instance" && descriptor && (
          <div className="mt-4 flex flex-col gap-3">
            <div>
              <label
                htmlFor={urlFieldId}
                className="mb-1 block text-[11px] font-medium text-text-secondary"
              >
                {descriptor.label} instance URL
              </label>
              <input
                id={urlFieldId}
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                value={urlInput}
                onChange={(e) => {
                  setUrlInput(e.target.value);
                  setUrlTouched(true);
                }}
                placeholder={descriptor.instanceUrlPlaceholder}
                aria-describedby={`${urlFieldId}-help`}
                aria-invalid={urlTouched && normalized ? !normalized.ok : undefined}
                className="w-full rounded border border-bg-border bg-bg-primary px-2 py-1.5 text-[11px] text-text-primary outline-none placeholder:text-text-muted focus:border-accent-green"
                autoFocus
              />
              <p id={`${urlFieldId}-help`} className="mt-1 text-[10px] text-text-muted">
                Paste the address you use in the browser. A scheme, a trailing slash, or an{" "}
                <code className="text-text-secondary">/api</code> suffix are all fine — they are
                normalised below.
              </p>
            </div>

            <div>
              {urlTouched && normalized && !normalized.ok && (
                <FieldError message={normalized.error} />
              )}
              {normalized?.ok && (
                <div
                  role="status"
                  className="rounded border border-bg-border bg-bg-primary px-2.5 py-2"
                >
                  <div className="text-[10px] uppercase tracking-wider text-text-muted">
                    Will be saved as
                  </div>
                  <div className="mt-0.5 break-all font-mono text-[11px] text-text-primary">
                    {normalized.value}
                  </div>
                  {normalized.notes.length > 0 && (
                    <ul className="mt-1.5 flex flex-col gap-0.5">
                      {normalized.notes.map((note) => (
                        <li
                          key={note}
                          className="flex items-start gap-1.5 text-[10px] text-text-muted"
                        >
                          <Info size={10} className="mt-0.5 flex-shrink-0" />
                          {note}
                        </li>
                      ))}
                    </ul>
                  )}
                  {normalized.warnings.map((warning) => (
                    <p
                      key={warning}
                      className="mt-1.5 flex items-start gap-1.5 text-[10px] text-accent-amber"
                    >
                      <AlertTriangle size={10} className="mt-0.5 flex-shrink-0" />
                      {warning}
                    </p>
                  ))}
                  <p className="mt-1.5 text-[10px] text-text-muted">
                    PacketBench appends{" "}
                    <code className="text-text-secondary">{descriptor.probe.apiPrefix || "/"}</code>{" "}
                    itself when it calls the API.
                  </p>
                </div>
              )}
            </div>

            <div>
              <label
                htmlFor={labelFieldId}
                className="mb-1 block text-[11px] font-medium text-text-secondary"
              >
                Display name <span className="text-text-muted">(optional)</span>
              </label>
              <input
                id={labelFieldId}
                type="text"
                autoComplete="off"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={origin ? defaultConnectionLabel(descriptor, origin) : descriptor.label}
                className="w-full rounded border border-bg-border bg-bg-primary px-2 py-1.5 text-[11px] text-text-primary outline-none placeholder:text-text-muted focus:border-accent-green"
              />
            </div>
          </div>
        )}

        {step === "token" && descriptor && (
          <div className="mt-4 flex flex-col gap-3">
            <ScopeList descriptor={descriptor} origin={origin} />

            <div>
              <label
                htmlFor={tokenFieldId}
                className="mb-1 block text-[11px] font-medium text-text-secondary"
              >
                {descriptor.tokenLabel}
              </label>
              <input
                id={tokenFieldId}
                type="password"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-1p-ignore="true"
                data-lpignore="true"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={descriptor.tokenPlaceholder}
                aria-describedby={`${tokenFieldId}-help`}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && token.trim()) setStep("verify");
                }}
                className="w-full rounded border border-bg-border bg-bg-primary px-2 py-1.5 text-[11px] text-text-primary outline-none placeholder:text-text-muted focus:border-accent-green"
                autoFocus
              />
              <p
                id={`${tokenFieldId}-help`}
                className="mt-1 flex items-start gap-1.5 text-[10px] text-text-muted"
              >
                <Lock size={10} className="mt-0.5 flex-shrink-0" />
                The token is checked against {descriptor.label} first and only written to the OS
                keyring once it works. It is never stored in the app&apos;s settings or logs.
              </p>
            </div>
          </div>
        )}

        {step === "verify" && descriptor && (
          <div className="mt-4 flex flex-col gap-3" aria-busy={verifying}>
            {verifying && (
              <div role="status" className="flex items-center gap-2 text-[11px] text-text-secondary">
                <Loader2 size={12} className="animate-spin" />
                Checking {baseUrl || descriptor.label}…
              </div>
            )}
            {!verifying && fatal && <FieldError message={fatal} />}
            {!verifying && verdict && (
              <VerdictCard verdict={verdict} endpoint={probeEndpoint} />
            )}
            {!verifying && verdict?.canSave && (
              <ActiveConnectionChoice
                useNow={useNow}
                onChange={setUseNow}
                connectionCount={connections.length}
                fieldIdPrefix={headingId}
              />
            )}
          </div>
        )}

        {step === "done" && descriptor && (
          <div className="mt-4 flex flex-col gap-3">
            <div className="flex items-start gap-2 rounded border border-accent-green/30 bg-accent-green/10 px-3 py-2.5">
              <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0 text-accent-green" />
              <div className="min-w-0">
                <div className="text-[11px] font-medium text-accent-green">
                  {descriptor.label} connected
                </div>
                <dl className="mt-1 flex flex-col gap-0.5 text-[10px] text-text-secondary">
                  <SummaryRow term="Account" value={verifiedLogin ?? "unknown"} />
                  {descriptor.needsInstanceUrl && <SummaryRow term="Instance" value={baseUrl} />}
                  <SummaryRow
                    term="Connection"
                    value={label.trim() || defaultConnectionLabel(descriptor, baseUrl)}
                  />
                  <SummaryRow term="Credential" value="OS keyring" />
                </dl>
              </div>
            </div>

            <div className="rounded border border-bg-border bg-bg-primary px-3 py-2.5">
              <div className="text-[10px] uppercase tracking-wider text-text-muted">
                Which connection gets used
              </div>
              <p className="mt-1 text-[10px] leading-snug text-text-secondary">
                {useNow
                  ? "This connection is active now."
                  : "Your previously active connection is unchanged."}{" "}
                When you open a workspace, PacketBench picks the connection whose host matches that
                repository&apos;s <code className="text-text-primary">origin</code> remote, so this
                choice applies until you switch workspace.
              </p>
              {otherConnections.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1">
                  {otherConnections.map((c) => (
                    <li
                      key={c.id}
                      className="flex items-center gap-1.5 text-[10px] text-text-muted"
                    >
                      <HostIcon kind={c.kind} size={10} />
                      <span className="truncate">{c.label}</span>
                      {!c.hasToken && <span className="text-accent-amber">· no token</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function PrimaryButton({
  onClick,
  disabled,
  label,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded border border-accent-green/30 bg-accent-green/15 px-3 py-1 text-[11px] font-medium text-accent-green transition-colors hover:bg-accent-green/25 disabled:opacity-40"
    >
      {label}
    </button>
  );
}

function StepRail({
  steps,
  currentIndex,
}: {
  steps: Array<{ id: WizardStep; title: string }>;
  currentIndex: number;
}) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5" aria-label="Setup progress">
      {steps.map((s, i) => {
        const state = i < currentIndex ? "done" : i === currentIndex ? "current" : "todo";
        return (
          <li
            key={s.id}
            aria-current={state === "current" ? "step" : undefined}
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${
              state === "current"
                ? "bg-bg-elevated text-text-primary"
                : state === "done"
                  ? "text-accent-green"
                  : "text-text-muted"
            }`}
          >
            {state === "done" ? (
              <Check size={9} />
            ) : (
              <span className="tabular-nums">{i + 1}.</span>
            )}
            {s.title}
          </li>
        );
      })}
    </ol>
  );
}

function HostOption({
  descriptor,
  selected,
  onSelect,
}: {
  descriptor: GitHostWizardDescriptor;
  selected: boolean;
  onSelect: () => void;
}) {
  const disabled = Boolean(descriptor.unsupported);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onClick={onSelect}
      className={`flex w-full items-start gap-2.5 rounded border px-3 py-2 text-left transition-colors ${
        selected
          ? "border-accent-green/40 bg-accent-green/10"
          : "border-bg-border bg-bg-primary hover:border-line-strong"
      } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
    >
      <HostIcon kind={descriptor.kind ?? "github"} size={14} className="mt-0.5 text-text-muted" />
      <span className="min-w-0">
        <span className="block text-[11px] font-medium text-text-primary">{descriptor.label}</span>
        <span className="block text-[10px] text-text-muted">{descriptor.blurb}</span>
        {descriptor.unsupported && (
          <span className="mt-1 block text-[10px] text-accent-amber">{descriptor.unsupported}</span>
        )}
      </span>
    </button>
  );
}

function ActiveConnectionChoice({
  useNow,
  onChange,
  connectionCount,
  fieldIdPrefix,
}: {
  useNow: boolean;
  onChange: (next: boolean) => void;
  connectionCount: number;
  fieldIdPrefix: string;
}) {
  const id = `${fieldIdPrefix}-use-now`;
  return (
    <div className="rounded border border-bg-border bg-bg-primary px-3 py-2.5">
      <label htmlFor={id} className="flex cursor-pointer items-start gap-2">
        <input
          id={id}
          type="checkbox"
          checked={useNow}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 accent-accent-green"
        />
        <span className="min-w-0">
          <span className="block text-[11px] text-text-primary">Use this connection now</span>
          <span className="block text-[10px] leading-snug text-text-muted">
            {connectionCount > 1
              ? `You have ${connectionCount} connections configured. Workspaces normally pick one automatically from the repository's origin remote — this only sets what is used until you switch workspace.`
              : "Workspaces pick a connection automatically from the repository's origin remote; this sets what is used until then."}
          </span>
        </span>
      </label>
    </div>
  );
}

function SummaryRow({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-20 flex-shrink-0 text-text-muted">{term}</dt>
      <dd className="min-w-0 break-all text-text-primary">{value}</dd>
    </div>
  );
}
