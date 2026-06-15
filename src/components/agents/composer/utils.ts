import {
  Bot,
  MessageCircle,
  Hand,
  Layers,
  type LucideIcon,
} from "lucide-react";
import type { AgentCli } from "@/stores/agentTaskStore";
import type { ImageAttachment } from "@/lib/tauri";

/** Cursor-style launch modes. */
export type AgentMode = "agent" | "ask" | "manual" | "plan";

/** B2: Codex-App-style 3-way "where does the agent run" picker. `local`
 * is the default — no worktree, edits land in the project tree. `worktree`
 * provisions `.pkt-worktrees/<convId>` on a fresh `pkt/<convId>` branch
 * (T3.F). `cloud` is reserved for future cloud delegation; greyed-out
 * for now. The choice persists in localStorage so users don't re-pick. */
export type ComposerMode = "local" | "worktree" | "cloud";

export const MODE_META: Record<
  AgentMode,
  { label: string; description: string; icon: LucideIcon; color: string }
> = {
  agent: {
    label: "Agent",
    description: "Full tools — read, write, run commands",
    icon: Bot,
    color: "text-accent-green",
  },
  ask: {
    label: "Ask",
    description: "Read-only — no edits or commands",
    icon: MessageCircle,
    color: "text-accent-blue",
  },
  manual: {
    label: "Manual",
    description: "Every risky tool requires your approval",
    icon: Hand,
    color: "text-accent-amber",
  },
  plan: {
    label: "Plan",
    description: "Produce a structured plan first, then execute",
    icon: Layers,
    color: "text-accent-purple",
  },
};

export const MODE_ORDER: AgentMode[] = ["agent", "ask", "manual", "plan"];

/**
 * Provider dropdown grouping. Only includes `api-*` agents (PTY CLI agents
 * like `claude-code` / `codex` are handled elsewhere). The subscription
 * providers (`api-claude-oauth`, `api-openai-codex`) are fully wired via
 * the sidecar and share this dropdown with the key-based API providers.
 */
export const PROVIDER_GROUPS: { label: string; agents: AgentCli[] }[] = [
  { label: "Anthropic", agents: ["api-claude-oauth" as AgentCli, "api-claude"] },
  {
    label: "OpenAI",
    agents: [
      "api-openai-codex" as AgentCli,
      "api-openai",
      "api-openai-agents",
    ],
  },
  { label: "Other", agents: ["api-openrouter", "api-minimax", "api-ollama"] },
];

/**
 * Slugify a template name to its slash-command form, e.g. "Code Review"
 * becomes "code-review". Matches the kebab-case slug used by the in-chat
 * popover in AgentChatPane so users see the same `/<name>` everywhere.
 */
export function templateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const SLASH_POPOVER_LIMIT = 6;

/** Hard cap to keep payloads sane — Anthropic accepts ~5MB per image. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Read a File / Blob into a base64 string suitable for ImageAttachment.
 * Strips the `data:<mime>;base64,` prefix that FileReader.readAsDataURL
 * always prepends so the wire payload is just the encoded bytes.
 */
export function fileToImageAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("FileReader returned non-string result"));
        return;
      }
      const commaIdx = result.indexOf(",");
      const data_base64 = commaIdx >= 0 ? result.slice(commaIdx + 1) : result;
      resolve({
        media_type: file.type || "image/png",
        data_base64,
      });
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

export const COMPOSER_HELP_TEXT =
  "Enter to send · Shift+Enter for newline · Ctrl+N for new agent · @ to mention a file · / to expand a prompt template · drag/paste images";
