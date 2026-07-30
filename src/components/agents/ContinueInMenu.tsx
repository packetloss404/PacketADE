import {
  Bot,
  FolderOpen,
  Terminal,
  Code2,
  Code,
  GitMerge,
  PanelsTopLeft,
  Plane,
} from "lucide-react";
import { useDropdownClose } from "@/components/ui/Dropdown";
import { open } from "@tauri-apps/plugin-shell";
import type { AgentConversation } from "@/types/agent-conversation";
import type { AgentCli } from "@/stores/agentTaskStore";
import {
  attachTerminalToConversationProject,
  openConversationGitEnding,
  openConversationProjectInWorkspace,
} from "@/lib/agentHandoffs";

interface MenuItemProps {
  icon: React.ReactNode;
  label: string;
  subtitle: string;
  disabled?: boolean;
  disabledReason?: string;
  onClick: () => void | Promise<void>;
}

/**
 * Inline menu item — reimplemented (instead of reusing DropdownItem) so we
 * can show disabled state, an icon, and a subtitle row. Closes the enclosing
 * Dropdown via `useDropdownClose()` (a no-op outside a Dropdown, e.g. in
 * bare render tests).
 *
 * Hoisted to module scope so React Fast Refresh doesn't re-create the type
 * on every render of the parent — that was triggering
 * `react-hooks/static-components`.
 */
function MenuItem({ icon, label, subtitle, disabled, disabledReason, onClick }: MenuItemProps) {
  const close = useDropdownClose();
  return (
    <button
      type="button"
      disabled={disabled}
      title={disabled ? disabledReason : subtitle}
      onClick={() => {
        if (disabled) return;
        void onClick();
        close();
      }}
      className={`flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors motion-reduce:transition-none ${
        disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer hover:bg-bg-hover"
      }`}
    >
      <span className="mt-0.5 shrink-0 text-text-secondary">{icon}</span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-ui text-text-primary">{label}</span>
        <span className="truncate text-meta text-text-muted">{subtitle}</span>
      </span>
    </button>
  );
}

interface ContinueInMenuProps {
  conversation: AgentConversation;
  /** Flash a transient confirmation/error message in the caller's shared
   * feedback slot (e.g. the overflow menu's toast). */
  onFeedback: (msg: string) => void;
  onRequestPacketCode?: () => void;
  onRequestFlight?: () => void;
}

interface CliContinuation {
  command: string;
  label: string;
}

const CONTINUATION_CLIS: Partial<Record<AgentCli, CliContinuation>> = {
  "claude-code": { command: "claude", label: "Claude" },
  codex: { command: "codex", label: "Codex" },
  gemini: { command: "gemini", label: "Gemini" },
  opencode: { command: "opencode", label: "OpenCode" },
  packetcode: { command: "packetcode", label: "PacketCode" },
  "api-claude-oauth": { command: "claude", label: "Claude" },
  "api-openai-codex": { command: "codex", label: "Codex" },
};

function getCliContinuation(agent: AgentCli): CliContinuation | null {
  return CONTINUATION_CLIS[agent] ?? null;
}

function quoteShellArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * "Continue in ..." menu section, modeled after Claude Code Desktop's
 * affordance for jumping a conversation's context into another surface.
 * Renders ONLY its section content — the caller (HeaderOverflowMenu) owns
 * the enclosing Dropdown and shared feedback flash.
 *
 * Items:
 *  1. Open project folder in OS    — `open(path)` via tauri-plugin-shell
 *  2. Continue in CLI              — copy a provider-matched command when
 *                                    this conversation has a known local CLI
 *  3. Open in VS Code              — `vscode://file/<absolutePath>`
 *  4. Open in Cursor               — `cursor://file/<absolutePath>`
 *
 * SSH-targeted conversations disable the local-path items since the path lives
 * on a remote host.
 */
export function ContinueInMenu({
  conversation,
  onFeedback,
  onRequestPacketCode = () => {},
  onRequestFlight = () => {},
}: ContinueInMenuProps) {
  const projectPath = conversation.projectPath;
  const isRemote = Boolean(conversation.sshTarget);
  const hasPath = Boolean(projectPath);
  const localOnlyDisabled = isRemote || !hasPath;
  const cliContinuation = getCliContinuation(conversation.agent);
  const cliDisabled = localOnlyDisabled || !cliContinuation;

  async function handleOpenFolder() {
    if (localOnlyDisabled) return;
    try {
      await open(projectPath);
    } catch (err) {
      console.warn("[ContinueInMenu] open folder failed:", err);
    }
  }

  async function handleContinueInCli() {
    if (cliDisabled || !cliContinuation) return;
    // Cross-platform detached terminal spawning is a
    // mess (Terminal.app, Windows Terminal, gnome-terminal, kitty, etc. all
    // diverge). For v1, copy a ready-to-paste invocation and let the user
    // paste it into whatever shell they prefer.
    const cmd = `cd ${quoteShellArg(projectPath)} && ${cliContinuation.command}`;
    try {
      await navigator.clipboard.writeText(cmd);
      onFeedback("Command copied - paste into your terminal");
    } catch (err) {
      console.warn("[ContinueInMenu] clipboard write failed:", err);
      onFeedback("Could not copy to clipboard");
    }
  }

  async function handleOpenInEditor(scheme: "vscode" | "cursor") {
    if (localOnlyDisabled) return;
    // Both VS Code and Cursor accept `<scheme>://file/<absolutePath>`.
    // Backslashes on Windows don't need conversion for these handlers, but a
    // leading slash is conventional on POSIX paths; keep the path verbatim.
    const url = `${scheme}://file/${projectPath}`;
    try {
      await open(url);
    } catch (err) {
      console.warn(`[ContinueInMenu] open ${scheme} failed:`, err);
    }
  }

  function reportResult(
    result:
      | ReturnType<typeof openConversationProjectInWorkspace>
      | ReturnType<typeof attachTerminalToConversationProject>
      | ReturnType<typeof openConversationGitEnding>,
    success: string,
  ) {
    onFeedback(result.ok ? success : result.message);
  }

  return (
    <div className="min-w-[240px] py-0.5" data-agent-pane-continue-in>
      <div className="px-3 pb-0.5 pt-1 text-meta font-medium uppercase tracking-wide text-text-muted">
        Move work
      </div>
      <MenuItem
        icon={<PanelsTopLeft size={12} />}
        label="Open project in Workspace"
        subtitle="Open the same target without moving this conversation"
        onClick={() =>
          reportResult(
            openConversationProjectInWorkspace(conversation.id),
            "Project opened in Workspace",
          )
        }
      />
      <MenuItem
        icon={<Terminal size={12} />}
        label="Attach terminal"
        subtitle="Add a separate shell on this exact project or worktree"
        onClick={() =>
          reportResult(
            attachTerminalToConversationProject(conversation.id),
            "Terminal attached in Workspace",
          )
        }
      />
      <MenuItem
        icon={<Bot size={12} />}
        label="Continue in PacketCode…"
        subtitle="Review a bounded payload, then open PacketCode"
        onClick={onRequestPacketCode}
      />
      <MenuItem
        icon={<GitMerge size={12} />}
        label="Open Git ending"
        subtitle="Review merge, PR, discard, or keep for this worktree"
        onClick={() =>
          reportResult(openConversationGitEnding(conversation.id), "Git ending opened in Workspace")
        }
      />
      <MenuItem
        icon={<Plane size={12} />}
        label="Add to Flight…"
        subtitle="Link this conversation without copying its state"
        onClick={onRequestFlight}
      />
      <div className="my-1 border-t border-bg-border" />
      <MenuItem
        icon={<FolderOpen size={12} />}
        label="Open project folder in OS"
        subtitle="Reveal the folder in Explorer / Finder"
        disabled={localOnlyDisabled}
        disabledReason={
          isRemote ? "Path is on a remote SSH host" : "No project path on this conversation"
        }
        onClick={handleOpenFolder}
      />
      <MenuItem
        icon={<Terminal size={12} />}
        label={cliContinuation ? `Continue in CLI (${cliContinuation.label})` : "Continue in CLI"}
        subtitle={
          cliContinuation
            ? `Copy cd <path> && ${cliContinuation.command} to clipboard`
            : "No local CLI handoff for this provider"
        }
        disabled={cliDisabled}
        disabledReason={
          isRemote
            ? "Path is on a remote SSH host"
            : !hasPath
              ? "No project path on this conversation"
              : "This API provider does not have a mapped local CLI"
        }
        onClick={handleContinueInCli}
      />
      <MenuItem
        icon={<Code2 size={12} />}
        label="Open in VS Code"
        subtitle="vscode://file/<path>"
        disabled={localOnlyDisabled}
        disabledReason={
          isRemote ? "Path is on a remote SSH host" : "No project path on this conversation"
        }
        onClick={() => handleOpenInEditor("vscode")}
      />
      <MenuItem
        icon={<Code size={12} />}
        label="Open in Cursor"
        subtitle="cursor://file/<path>"
        disabled={localOnlyDisabled}
        disabledReason={
          isRemote ? "Path is on a remote SSH host" : "No project path on this conversation"
        }
        onClick={() => handleOpenInEditor("cursor")}
      />
    </div>
  );
}
