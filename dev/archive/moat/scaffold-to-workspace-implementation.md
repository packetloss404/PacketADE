# Scaffold-to-Workspace — Implementation Spec

## Implementation Status — 2026-04-15

| Item | Status | Notes |
|------|--------|-------|
| ScaffoldView | ✅ Done | 3-step wizard in ScaffoldView.tsx |
| WorkspaceTemplatePicker | ✅ Done | Built into ScaffoldView result step |
| Scaffold→workspace flow | ✅ Done | — |
| Scaffold→flight flow | ✅ Done | — |

Last updated: 2026-04-15

## Goal

After scaffolding a new project, offer to create a PacketCode workspace bound to that project — so users go from blank directory to a running multi-agent workspace in one flow.

## Current State

When scaffolding succeeds, `ResultStep` in `ScaffoldView.tsx` shows the result but only offers "Create Another". The new project is not automatically associated with a PacketCode workspace.

The `ConfigStep` already sets the global `projectPath` to the new project via `setProjectPath(result.project_path)`, but it does not create a workspace.

Relevant files:

- `src/components/views/ScaffoldView.tsx`
- `src/stores/scaffoldStore.ts`
- `src/stores/workspaceStore.ts`

## What This Spec Adds

1. **"Create Workspace" button in ResultStep** — appears on successful scaffold, offers to create a workspace for the new project
2. **Workspace template picker in ResultStep** — let user choose a workspace template (solo, duo, etc.) before creating the workspace
3. **Optional: scaffold → flight flow** — after scaffolding and workspace creation, offer to create a flight for the new project

---

## Change 1: "Create Workspace" in ResultStep

### Wire to workspaceStore

In `ResultStep`, add a button that calls `workspaceStore.createWorkspace()`:

```tsx
// In ResultStep, after the success state:
{
  result.success && (
    <div className="mt-4 border-t border-bg-border pt-4">
      <p className="mb-3 text-[11px] text-text-secondary">
        Set up a workspace to start coding with AI agents
      </p>
      <WorkspaceTemplatePicker projectPath={result.project_path} />
    </div>
  );
}
```

### `WorkspaceTemplatePicker` component

A new component that shows workspace template options and creates the workspace:

```tsx
function WorkspaceTemplatePicker({ projectPath }: { projectPath: string }) {
  const createWorkspace = useWorkspaceStore((s) => s.createWorkspace);
  const [selectedAgents, setSelectedAgents] = useState<Set<WorkspaceAgentSlot>>(
    new Set(["claude-code"]),
  );
  const [name, setName] = useState("My Workspace");

  const TEMPLATES = [
    { id: "solo", label: "Solo", agents: ["claude-code"] },
    { id: "duo", label: "Duo", agents: ["claude-code", "codex"] },
    { id: "review-trio", label: "Review Trio", agents: ["claude-code", "codex", "terminal"] },
  ];

  async function handleCreate() {
    createWorkspace(name, selectedAgents, projectPath);
    // Navigate to workspace view
    useAppStore.getState().setActiveView("workspace");
    useScaffoldStore.getState().reset();
  }

  return (
    <div className="space-y-3">
      {/* Workspace name */}
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full rounded border border-bg-border bg-bg-secondary px-2 py-1 text-xs"
        placeholder="Workspace name"
      />
      {/* Template picker */}
      <div className="flex gap-2">
        {TEMPLATES.map((t) => (
          <button
            key={t.id}
            onClick={() => {
              setSelectedAgents(new Set(t.agents));
              setName(t.label + " — " + projectPath.split("/").pop());
            }}
            className="rounded border border-bg-border bg-bg-secondary px-3 py-1.5 text-[11px] hover:border-accent-green"
          >
            {t.label}
          </button>
        ))}
      </div>
      <button
        onClick={handleCreate}
        className="bg-accent-green/20 hover:bg-accent-green/30 w-full rounded px-4 py-2 text-xs font-medium text-accent-green"
      >
        Create Workspace & Open
      </button>
    </div>
  );
}
```

---

## Change 2: Wire Scaffold Result to Workspace Store

### In scaffoldStore

Add a helper to create a workspace from scaffold result data:

```typescript
// In scaffoldStore.ts (or a new helper):
export async function scaffoldAndCreateWorkspace(
  projectPath: string,
  projectName: string,
  agents: WorkspaceAgentSlot[],
  sessionConfig?: WorkspaceSessionConfig,
): Promise<string> {
  const id = useWorkspaceStore
    .getState()
    .createWorkspace(projectName, agents, projectPath, sessionConfig);
  // Set this project as the active project globally
  useLayoutStore.getState().setProjectPath(projectPath);
  return id;
}
```

### Update `handleCreate` in ConfigStep

```tsx
// In ConfigStep, replace the handleCreate body:
async function handleCreate() {
  const result = await runScaffold();
  if (result.success && result.project_path) {
    // Set project path but don't navigate — ResultStep now handles the next step
    setProjectPath(result.project_path);
  }
}
```

The `ResultStep` then offers the workspace creation UI.

---

## Change 3: Optional — Scaffold → Flight

### UX

After creating the workspace, show a secondary prompt:

```
Start a flight for this project?
[ Create Flight ] [ Skip ]
```

### Implementation

In `ResultStep`, after the workspace creation succeeds:

```tsx
{
  workspaceCreated && (
    <div className="mt-3 flex justify-center gap-2">
      <button
        onClick={() => {
          // Create a draft flight for this project
          useFlightStore.getState().createFlight({
            title: `${projectName} — flight`,
            projectPath: result.project_path,
            status: "draft",
          });
          useAppStore.getState().setActiveView("flight_deck");
        }}
        className="bg-accent-amber/20 hover:bg-accent-amber/30 rounded px-3 py-1.5 text-[11px] text-accent-amber"
      >
        Create Flight
      </button>
      <button
        onClick={reset}
        className="px-3 py-1.5 text-[11px] text-text-muted hover:text-text-secondary"
      >
        Skip
      </button>
    </div>
  );
}
```

---

## Summary of Changes

| What                                      | Where                                              | Type             |
| ----------------------------------------- | -------------------------------------------------- | ---------------- |
| `WorkspaceTemplatePicker` component       | `ScaffoldView.tsx` (new component)                 | UI change        |
| Scaffold → workspace wiring               | `scaffoldStore.ts` or inline in `ScaffoldView.tsx` | Store/UI change  |
| Workspace creation button in `ResultStep` | `ScaffoldView.tsx`                                 | UI change        |
| Workspace → project path sync             | `ConfigStep` already does this                     | No change needed |
| Scaffold → flight offer                   | `ResultStep`                                       | UI change        |

## Files to Modify

- `src/components/views/ScaffoldView.tsx` — add `WorkspaceTemplatePicker`, update `ResultStep`
- `src/stores/scaffoldStore.ts` — no changes needed (existing API is sufficient)
- `src/stores/workspaceStore.ts` — no changes needed
- `src/stores/flightStore.ts` — if adding flight creation (optional)

## Delivery Order

1. Add `WorkspaceTemplatePicker` and "Create Workspace" button to `ResultStep` (Change 1 + 2) — one self-contained change
2. Scaffold → flight offer (Change 3) — small additive step after Change 1 lands
