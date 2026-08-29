import { useEffect, useState } from "react";
import { FileText, Save, AlertTriangle, ArrowRightLeft } from "lucide-react";
import { useLayoutStore } from "@/stores/layoutStore";
import { readFileContents, writeFileContents } from "@/lib/tauri";
import { CardHeader } from "./CardHeader";
import { formatTime } from "@/lib/time";

const STARTER_TEMPLATE = `# Project Rules

PacketBench writes this file as both \`AGENTS.md\` and \`CLAUDE.md\` so the same
rules apply whether you're using Claude Code, Codex, or another agent that
follows the AGENTS.md convention.

## Conventions

- (replace this section with project-specific rules)

## Architecture

- (overview, important modules, anti-patterns)

## What NOT to do

- (footguns, deprecated APIs, things that look right but break things)
`;

type LoadState =
  | { kind: "loading" }
  | { kind: "no-project" }
  | {
      kind: "ready";
      agentsContent: string | null;
      claudeContent: string | null;
    }
  | { kind: "error"; message: string };

/**
 * B7 — cross-tool unified AGENTS.md / CLAUDE.md editor.
 *
 * The single biggest cross-tool gripe in the Codex sentiment research is
 * that `AGENTS.md` / `CLAUDE.md` / `DESIGN.md` doesn't transfer between
 * tools. PacketBench hosts both providers, so we can fix it: one editor,
 * Save writes BOTH files. Divergent files surface a warning + Unify
 * affordance so users can collapse them onto a canonical version.
 */
export function ProjectRulesCard() {
  const projectPath = useLayoutStore((s) => s.projectPath);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [editorValue, setEditorValue] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);

  // Reload both files whenever the project changes. read failures (= file
  // missing) yield null so the UI can offer the "Create" path.
  useEffect(() => {
    if (!projectPath) {
      setState({ kind: "no-project" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    void (async () => {
      try {
        const [a, c] = await Promise.all([
          readFileContents(`${projectPath}/AGENTS.md`, projectPath).catch(
            () => null,
          ),
          readFileContents(`${projectPath}/CLAUDE.md`, projectPath).catch(
            () => null,
          ),
        ]);
        if (cancelled) return;
        setState({ kind: "ready", agentsContent: a, claudeContent: c });
        // Seed the editor from whichever exists, preferring AGENTS.md.
        // Empty state seeds from the starter template.
        if (a !== null) setEditorValue(a);
        else if (c !== null) setEditorValue(c);
        else setEditorValue("");
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  if (state.kind === "no-project") {
    return (
      <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
        <CardHeader
          icon={FileText}
          iconColor="text-accent-amber"
          title="Project Rules"
          className="flex items-center gap-2 mb-2"
        />
        <p className="text-[11px] text-text-muted">
          Open a project folder to edit its <code>AGENTS.md</code> /{" "}
          <code>CLAUDE.md</code>.
        </p>
      </div>
    );
  }

  if (state.kind === "loading") {
    return (
      <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
        <span className="text-[11px] text-text-muted">Loading…</span>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="bg-bg-secondary border border-accent-red/40 rounded-lg p-4">
        <span className="text-[11px] text-accent-red">
          Failed to load: {state.message}
        </span>
      </div>
    );
  }

  const { agentsContent, claudeContent } = state;
  const bothMissing = agentsContent === null && claudeContent === null;
  const oneMissing =
    (agentsContent === null) !== (claudeContent === null);
  const divergent =
    agentsContent !== null &&
    claudeContent !== null &&
    agentsContent !== claudeContent;
  const dirty =
    editorValue !==
    (agentsContent ?? claudeContent ?? "");

  function pickAsCanonical(side: "agents" | "claude"): void {
    const value = side === "agents" ? agentsContent : claudeContent;
    if (value === null) return;
    setEditorValue(value);
  }

  async function save(): Promise<void> {
    if (!projectPath) return;
    setSaving(true);
    setSaveError(null);
    try {
      // Write both files atomically (best-effort — Tauri's writes are
      // sequential, but small text files settle in milliseconds).
      await Promise.all([
        writeFileContents(
          `${projectPath}/AGENTS.md`,
          projectPath,
          editorValue,
        ),
        writeFileContents(
          `${projectPath}/CLAUDE.md`,
          projectPath,
          editorValue,
        ),
      ]);
      setState({
        kind: "ready",
        agentsContent: editorValue,
        claudeContent: editorValue,
      });
      setLastSavedAt(Date.now());
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function seedFromTemplate(): void {
    setEditorValue(STARTER_TEMPLATE);
  }

  return (
    <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-text-primary flex items-center gap-2">
          <FileText size={12} className="text-accent-amber" />
          Project Rules{" "}
          <span className="text-text-muted font-normal">
            (AGENTS.md + CLAUDE.md)
          </span>
          {dirty && (
            <span
              className="w-1.5 h-1.5 rounded-full bg-accent-amber"
              title="Unsaved changes"
            />
          )}
        </h3>
        <div className="flex items-center gap-2">
          {lastSavedAt && (
            <span className="text-[10px] text-text-muted">
              {/* Settings → Date & Time owns the zone. */}
              Saved {formatTime(lastSavedAt)}
            </span>
          )}
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-accent-green/40 text-accent-green hover:bg-accent-green/10 disabled:opacity-40"
          >
            <Save size={11} /> {saving ? "Saving…" : "Save to both files"}
          </button>
        </div>
      </div>

      <p className="text-[10px] text-text-muted mb-3">
        Rules saved here apply to every PacketBench conversation in this project,
        and to Codex / Claude Code when they read these files directly. Saving
        writes the same content to both filenames so a single rule set works
        across tools.
      </p>

      {bothMissing && (
        <div className="mb-3 p-2 rounded border border-bg-border bg-bg-primary text-[11px] flex items-center justify-between">
          <span className="text-text-secondary">
            Neither file exists yet in this project.
          </span>
          <button
            type="button"
            onClick={seedFromTemplate}
            className="text-[11px] px-2 py-0.5 rounded border border-accent-blue/40 text-accent-blue hover:bg-accent-blue/10"
          >
            Use starter template
          </button>
        </div>
      )}

      {oneMissing && (
        <div className="mb-3 p-2 rounded border border-accent-blue/30 bg-accent-blue/5 text-[11px] text-text-secondary">
          Only one of the two files exists. Saving will create the missing
          one with identical content.
        </div>
      )}

      {divergent && (
        <div className="mb-3 p-2 rounded border border-accent-amber/40 bg-accent-amber/5">
          <div className="flex items-center gap-1.5 text-[11px] text-accent-amber mb-2">
            <AlertTriangle size={11} />
            AGENTS.md and CLAUDE.md have diverged. Pick a canonical version
            to load into the editor; Save will then mirror it to both files.
          </div>
          <div className="flex items-center gap-2 mb-2">
            <button
              type="button"
              onClick={() => pickAsCanonical("agents")}
              className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border border-bg-border text-text-secondary hover:bg-bg-hover"
            >
              <ArrowRightLeft size={10} /> Use AGENTS.md
            </button>
            <button
              type="button"
              onClick={() => pickAsCanonical("claude")}
              className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border border-bg-border text-text-secondary hover:bg-bg-hover"
            >
              <ArrowRightLeft size={10} /> Use CLAUDE.md
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="text-[9.5px] text-text-faint mb-1 font-mono">
                AGENTS.md ({agentsContent!.length} chars)
              </div>
              <pre className="text-[10px] font-mono bg-bg-primary border border-bg-border rounded p-1.5 max-h-40 overflow-auto whitespace-pre-wrap text-text-secondary">
                {agentsContent}
              </pre>
            </div>
            <div>
              <div className="text-[9.5px] text-text-faint mb-1 font-mono">
                CLAUDE.md ({claudeContent!.length} chars)
              </div>
              <pre className="text-[10px] font-mono bg-bg-primary border border-bg-border rounded p-1.5 max-h-40 overflow-auto whitespace-pre-wrap text-text-secondary">
                {claudeContent}
              </pre>
            </div>
          </div>
        </div>
      )}

      <textarea
        value={editorValue}
        onChange={(e) => setEditorValue(e.target.value)}
        rows={20}
        spellCheck={false}
        placeholder="# Project Rules\n\nWrite your AGENTS.md / CLAUDE.md here…"
        className="w-full bg-bg-primary border border-bg-border rounded p-2 text-[11px] text-text-primary font-mono leading-relaxed focus:outline-none focus:border-accent-blue/60 resize-y"
      />

      {saveError && (
        <div className="mt-2 text-[11px] text-accent-red">
          Save failed: {saveError}
        </div>
      )}
    </div>
  );
}
