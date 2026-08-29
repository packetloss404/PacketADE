import { Terminal } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { bypassDefaultCaveat } from "@/lib/bypassFlags";

export function WorkspaceSettingsCard() {
  const defaultBypassPermissions = useWorkspaceStore((s) => s.defaultBypassPermissions);
  const setDefaultBypassPermissions = useWorkspaceStore((s) => s.setDefaultBypassPermissions);
  const autoBindGithubRepo = useWorkspaceStore((s) => s.autoBindGithubRepo);
  const setAutoBindGithubRepo = useWorkspaceStore((s) => s.setAutoBindGithubRepo);

  return (
    <div className="rounded-lg border border-bg-border bg-bg-secondary p-4">
      <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold text-text-primary">
        <Terminal size={12} className="text-accent-purple" />
        Workspace Pane
      </h3>

      <p className="mb-3 text-[10px] leading-snug text-text-muted">
        Controls for the separate Workspace pane. These do not change how the Agents pane groups or
        resumes conversations.
      </p>

      <div className="space-y-2">
        {/* FAULT: this row set the app-wide default for a toggle that reaches
            only two of the four launchable CLIs, while the creation modal and
            the workspace header both say so. A default that over-promises is
            the same lie one step earlier, so it carries the same sentence —
            from `bypassFlags.ts`, not a second copy that can drift. */}
        <Row
          title="Default new workspaces to bypass permission prompts"
          description="When you create a new workspace, pre-check the 'Bypass permission prompts' option. Existing workspaces are unaffected."
          caveat={bypassDefaultCaveat()}
          checked={defaultBypassPermissions}
          onChange={setDefaultBypassPermissions}
        />

        {/* `parseGithubRemote` matches github.com hosts only, so a Gitea,
            Forgejo, or GitLab origin binds nothing. Saying so beats letting a
            self-hosted user read the silence as a broken toggle. */}
        <Row
          title="Auto-detect GitHub repo on workspace creation"
          description="Run `git remote get-url origin` when creating a workspace and link it to the detected repo. Recognises github.com remotes only — a Gitea, Forgejo, or GitLab origin is left unbound, and you can bind it by hand from the Git pane. Disable if you don't want PacketBench making that call."
          checked={autoBindGithubRepo}
          onChange={setAutoBindGithubRepo}
        />
      </div>
    </div>
  );
}

function Row({
  title,
  description,
  caveat,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  /** Shown only while the toggle is on — a limit on what enabling it buys. */
  caveat?: string | null;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-bg-border bg-bg-primary px-3 py-2">
      <div className="min-w-0">
        <div className="text-[11px] text-text-secondary">{title}</div>
        <p className="mt-1 text-[10px] leading-snug text-text-muted">{description}</p>
        {checked && caveat && (
          <p className="mt-1 text-[10px] leading-snug text-accent-amber">{caveat}</p>
        )}
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative h-[18px] w-8 flex-shrink-0 rounded-full transition-colors ${
        checked ? "bg-accent-green" : "bg-bg-elevated"
      }`}
      aria-pressed={checked}
    >
      <span
        className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-transform ${
          checked ? "left-[16px]" : "left-[2px]"
        }`}
      />
    </button>
  );
}
