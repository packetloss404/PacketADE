import { useState } from "react";
import { open } from "@tauri-apps/plugin-shell";
import {
  Send,
  FolderOpen,
  Terminal,
  Code2,
  Code,
} from "lucide-react";
import { Dropdown } from "@/components/ui/Dropdown";
import type { AgentConversation } from "@/types/agent-conversation";

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
 * can show disabled state, an icon, and a subtitle row. Closes the dropdown
 * by dispatching a click on the document, which the parent Dropdown listens
 * for via its outside-click handler.
 *
 * Hoisted to module scope so React Fast Refresh doesn't re-create the type
 * on every render of the parent — that was triggering
 * `react-hooks/static-components`.
 */
function MenuItem({
  icon,
  label,
  subtitle,
  disabled,
  disabledReason,
  onClick,
}: MenuItemProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={disabled ? disabledReason : subtitle}
      onClick={() => {
        if (disabled) return;
        void onClick();
        // Close dropdown by simulating an outside click.
        document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      }}
      className={`w-full text-left px-3 py-1.5 flex items-start gap-2 transition-colors ${
        disabled
          ? "opacity-40 cursor-not-allowed"
          : "hover:bg-bg-hover cursor-pointer"
      }`}
    >
      <span className="mt-0.5 text-text-secondary shrink-0">{icon}</span>
      <span className="flex flex-col min-w-0">
        <span className="text-[11px] text-text-primary truncate">{label}</span>
        <span className="text-[10px] text-text-muted truncate">{subtitle}</span>
      </span>
    </button>
  );
}

interface ContinueInMenuProps {
  conversation: AgentConversation;
}

/**
 * "Continue in ..." menu, modeled after Claude Code Desktop's affordance for
 * jumping a conversation's context into another surface.
 *
 * Items:
 *  1. Open project folder in OS    — `open(path)` via tauri-plugin-shell
 *  2. Continue in CLI (claude)     — copy `cd <path> && claude` to clipboard
 *                                    (cross-platform terminal spawning is fragile;
 *                                    a paste-into-terminal flow is the v1 trade-off)
 *  3. Open in VS Code              — `vscode://file/<absolutePath>`
 *  4. Open in Cursor               — `cursor://file/<absolutePath>`
 *
 * SSH-targeted conversations disable the local-path items since the path lives
 * on a remote host.
 */
export function ContinueInMenu({ conversation }: ContinueInMenuProps) {
  const [feedback, setFeedback] = useState<string | null>(null);

  const projectPath = conversation.projectPath;
  const isRemote = Boolean(conversation.sshTarget);
  const hasPath = Boolean(projectPath);
  const localOnlyDisabled = isRemote || !hasPath;

  function flashFeedback(msg: string) {
    setFeedback(msg);
    window.setTimeout(() => setFeedback(null), 1800);
  }

  async function handleOpenFolder() {
    if (localOnlyDisabled) return;
    try {
      await open(projectPath);
    } catch (err) {
      console.warn("[ContinueInMenu] open folder failed:", err);
    }
  }

  async function handleContinueInCli() {
    if (localOnlyDisabled) return;
    // Cross-platform "spawn a detached terminal at <path> running claude" is a
    // mess (Terminal.app, Windows Terminal, gnome-terminal, kitty, etc. all
    // diverge). For v1, copy a ready-to-paste invocation and let the user
    // paste it into whatever shell they prefer.
    const cmd = `cd "${projectPath}" && claude`;
    try {
      await navigator.clipboard.writeText(cmd);
      flashFeedback("Path copied — paste into your terminal");
    } catch (err) {
      console.warn("[ContinueInMenu] clipboard write failed:", err);
      flashFeedback("Could not copy to clipboard");
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

  return (
    <div className="relative" data-agent-pane-continue-in>
      <Dropdown
        align="right"
        trigger={
          <span
            className="flex items-center gap-1 text-[11px] text-text-secondary"
            title="Continue this conversation in another surface"
          >
            <Send size={11} />
            Continue in
          </span>
        }
      >
        <div className="min-w-[240px] py-0.5">
          <MenuItem
            icon={<FolderOpen size={12} />}
            label="Open project folder in OS"
            subtitle="Reveal the folder in Explorer / Finder"
            disabled={localOnlyDisabled}
            disabledReason={
              isRemote
                ? "Path is on a remote SSH host"
                : "No project path on this conversation"
            }
            onClick={handleOpenFolder}
          />
          <MenuItem
            icon={<Terminal size={12} />}
            label="Continue in CLI (claude)"
            subtitle="Copy `cd <path> && claude` to clipboard"
            disabled={localOnlyDisabled}
            disabledReason={
              isRemote
                ? "Path is on a remote SSH host"
                : "No project path on this conversation"
            }
            onClick={handleContinueInCli}
          />
          <MenuItem
            icon={<Code2 size={12} />}
            label="Open in VS Code"
            subtitle="vscode://file/<path>"
            disabled={localOnlyDisabled}
            disabledReason={
              isRemote
                ? "Path is on a remote SSH host"
                : "No project path on this conversation"
            }
            onClick={() => handleOpenInEditor("vscode")}
          />
          <MenuItem
            icon={<Code size={12} />}
            label="Open in Cursor"
            subtitle="cursor://file/<path>"
            disabled={localOnlyDisabled}
            disabledReason={
              isRemote
                ? "Path is on a remote SSH host"
                : "No project path on this conversation"
            }
            onClick={() => handleOpenInEditor("cursor")}
          />
        </div>
      </Dropdown>
      {feedback && (
        <div className="absolute top-full right-0 mt-1 z-50 px-2 py-1 text-[10px] bg-bg-elevated border border-bg-border rounded shadow text-text-secondary whitespace-nowrap">
          {feedback}
        </div>
      )}
    </div>
  );
}
