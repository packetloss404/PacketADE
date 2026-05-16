// v0.8.8 quality autofix
//
// Aggregated panel of auto-fix actions for the Code Quality modal. This
// is the integration surface — drop one `<AutoFixPanel projectPath={…}/>`
// inside any tab and it self-discovers which fixers apply.
//
// Renders one section per fixer family:
//   - Lint    → ESLint --fix + Prettier --write
//   - Cargo   → cargo fix (if a Cargo.toml exists)
//   - Security → pnpm audit --fix
//
// Each fixer button is a self-contained `<AutoFixButton/>` and confirms
// destructive runs through its own nested Modal. After completion, the
// availability probe is re-run so disabled-state badges (e.g. fixable
// counts) reflect the new file state.
//
// Also surfaces the "Auto-fix on next run" toggle that the parent
// analyzer can consult before running its checks.

import { useEffect, useState } from "react";
import { ShieldAlert, Sparkles, Terminal as TerminalIcon } from "lucide-react";
import { codeQualityProbeFixers, type QualityFixerAvailability } from "@/lib/tauri";
import { AutoFixButton } from "./AutoFixButton";
import {
  QUALITY_AUTOFIX_STORAGE_KEY,
  readAutoFixPref,
  writeAutoFixPref,
} from "./autoFixPrefs";

interface AutoFixPanelProps {
  projectPath: string;
  /** Optional callback fired any time a fixer completes successfully.
   *  The parent modal can use this to re-run its analyzer / lint pass
   *  so the user sees the post-fix state immediately. */
  onFixApplied?: () => void;
}

export function AutoFixPanel({ projectPath, onFixApplied }: AutoFixPanelProps) {
  const [availability, setAvailability] = useState<QualityFixerAvailability | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoFixOnNextRun, setAutoFixOnNextRun] = useState<boolean>(readAutoFixPref);

  async function refreshAvailability() {
    try {
      setError(null);
      const a = await codeQualityProbeFixers(projectPath);
      setAvailability(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    void refreshAvailability();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  // Re-sync the preference if another tab toggles it (storage event).
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === QUALITY_AUTOFIX_STORAGE_KEY) {
        setAutoFixOnNextRun(readAutoFixPref());
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  function togglePref() {
    const next = !autoFixOnNextRun;
    setAutoFixOnNextRun(next);
    writeAutoFixPref(next);
  }

  function onComplete() {
    void refreshAvailability();
    onFixApplied?.();
  }

  if (loading) {
    return (
      <div className="text-[11px] text-text-muted px-3 py-2">Detecting available fixers…</div>
    );
  }
  if (error) {
    return (
      <div className="text-[11px] text-accent-red px-3 py-2 bg-accent-red/5 border border-accent-red/20 rounded">
        {error}
      </div>
    );
  }
  if (!availability) return null;

  const lintAvailable = availability.eslint || availability.prettier;
  const cargoAvailable = availability.cargo_fix;
  const securityAvailable = availability.npm_audit_fix;
  const anyAvailable = lintAvailable || cargoAvailable || securityAvailable;

  if (!anyAvailable) {
    return (
      <div className="text-[11px] text-text-muted px-3 py-2 bg-bg-primary border border-bg-border rounded">
        No auto-fixers detected for this project. Add an{" "}
        <code className="text-text-secondary">eslint.config.js</code>,{" "}
        <code className="text-text-secondary">.prettierrc</code>, or{" "}
        <code className="text-text-secondary">Cargo.toml</code> to enable.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-text-primary flex items-center gap-1.5">
          <Sparkles size={12} className="text-accent-amber" />
          Auto-fix
        </h3>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={autoFixOnNextRun}
            onChange={togglePref}
            className="accent-accent-green w-3 h-3 cursor-pointer"
          />
          <span className="text-[10px] text-text-muted">Auto-fix on next run</span>
        </label>
      </div>

      {lintAvailable && (
        <FixerSection
          icon={<TerminalIcon size={11} className="text-accent-blue" />}
          title="Lint & Format"
        >
          {availability.eslint && (
            <AutoFixButton
              projectPath={projectPath}
              fixer="eslint"
              label="Apply ESLint fixes"
              description="Runs `pnpm exec eslint --fix src e2e`. Fixes auto-fixable lint rules (unused imports, missing semis, prefer-const, etc.). Other violations remain."
              enabled={availability.eslint}
              badge={
                availability.eslint_fixable_count != null
                  ? `${availability.eslint_fixable_count} fixable`
                  : undefined
              }
              variant="blue"
              onComplete={onComplete}
            />
          )}
          {availability.prettier && (
            <AutoFixButton
              projectPath={projectPath}
              fixer="prettier"
              label="Format with Prettier"
              description="Runs `pnpm exec prettier --write src/**/*.{ts,tsx,css}`. Reformats every matched file to match your Prettier config. Files NOT covered by the glob are untouched."
              fileCount={availability.prettier_target_count ?? undefined}
              enabled={availability.prettier}
              variant="purple"
              onComplete={onComplete}
            />
          )}
        </FixerSection>
      )}

      {cargoAvailable && (
        <FixerSection
          icon={<TerminalIcon size={11} className="text-accent-amber" />}
          title="Rust"
        >
          <AutoFixButton
            projectPath={projectPath}
            fixer="cargo_fix"
            label="Run cargo fix"
            description="Runs `cargo fix --allow-dirty --allow-staged --edition-idioms` in src-tauri (or the project root). Applies safe lint suggestions; may modify Rust sources."
            enabled
            variant="amber"
            onComplete={onComplete}
          />
        </FixerSection>
      )}

      {securityAvailable && (
        <FixerSection
          icon={<ShieldAlert size={11} className="text-accent-red" />}
          title="Security"
        >
          <AutoFixButton
            projectPath={projectPath}
            fixer="npm_audit_fix"
            label="Patch security advisories"
            description="Runs `pnpm audit --fix`. Auto-applies fixes for known advisories where possible. Remaining advisories will be reported; you may need to bump majors manually."
            enabled
            variant="danger"
            onComplete={onComplete}
          />
        </FixerSection>
      )}
    </div>
  );
}

function FixerSection({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-bg-primary border border-bg-border rounded-lg px-3 py-2">
      <div className="flex items-center gap-1.5 mb-1">
        {icon}
        <span className="text-[10px] uppercase tracking-wider text-text-muted font-medium">
          {title}
        </span>
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}
