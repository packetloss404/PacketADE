# Deploy Pipeline — Implementation Spec

Last updated: 2026-04-09

## Goal

Wire `startRun()` to actual command execution, add pre-deploy validation, capture deploy logs, and connect deploys to flight completion.

## Current State

`deployStore.startRun()` only records metadata:

```typescript
// deployStore.ts
startRun: (config, sessionId) => {
  const run: DeployRun = { id, configName, command, status: "running", startedAt, finishedAt: null, sessionId };
  set({ runs: [run, ...s.runs].slice(0, 10), activeRunId: id });
},
```

There is no backend command that executes the deploy command.

Relevant files:

- `src/stores/deployStore.ts`
- `src/types/deploy.ts`
- `src-tauri/src/commands/deploy.rs`

## What This Spec Adds

1. **Actual deploy execution** — run the deploy command in a PTY session
2. **Pre-deploy validation** — check command validity and project state before running
3. **Deploy log capture** — stream stdout/stderr to the deploy run record
4. **Flight integration** — surface deploy status in flight detail

---

## Change 1: Deploy Execution Command

### New backend command: `run_deploy`

Add to `src-tauri/src/commands/deploy.rs`:

```rust
#[tauri::command]
pub async fn run_deploy(
    app: AppHandle,
    project_path: String,
    command: String,
    run_id: String,
) -> Result<(), String> {
    // Use the same PTY mechanism as regular sessions
    // but stream output back as deploy:output events
    let output_tx = app.clone();
    spawn_deploy_session(project_path, command, run_id, output_tx).await
}
```

The key difference from a normal PTY session:

- The `PACKETCODE=1` env var is set so the CLI knows it is running in PacketCode
- Output is emitted as `deploy:output` events (not `pty:output`)
- Exit is emitted as `deploy:exit`
- No interactive terminal chrome needed — just raw output streaming

### New frontend store action

In `deployStore.ts`:

```typescript
startRun: async (config, sessionId) => {
  const id = `deploy_${++runCounter}_${Date.now()}`;
  const run: DeployRun = {
    id, configName: config.name, command: config.command,
    status: "running", startedAt: Date.now(), finishedAt: null, sessionId,
    output: [],  // NEW: accumulate output lines
  };
  set(s => ({ runs: [run, ...s.runs].slice(0, 10), activeRunId: id }));

  // Set up event listeners
  const unlistenOutput = listen<string>("deploy:output", (event) => {
    set(s => ({
      runs: s.runs.map(r => r.id === id ? { ...r, output: [...r.output, event.payload] } : r)
    }));
  });
  const unlistenExit = listen<{ run_id: string; exit_code: number }>("deploy:exit", (event) => {
    const status = event.payload.exit_code === 0 ? "success" : "failed";
    set(s => ({
      runs: s.runs.map(r => r.id === id ? { ...r, status, finishedAt: Date.now() } : r)
    }));
    unlistenOutput();
  });

  // Call backend
  await runDeploy(config.command, projectPath);
},
```

### DeployRun type change

```typescript
// src/types/deploy.ts

export interface DeployRun {
  id: string;
  configName: string;
  command: string;
  status: "running" | "success" | "failed" | "cancelled";
  startedAt: number;
  finishedAt: number | null;
  sessionId?: string;
  output: string[]; // accumulated output lines
}
```

---

## Change 2: Pre-Deploy Validation

### When to validate

Before calling `runDeploy`, run a quick validation pass:

1. **Command exists**: check if the deploy command binary is on PATH
2. **Git status check**: warn if there are uncommitted changes
3. **Working tree clean**: warn if not on the expected branch

### New backend command: `validate_deploy`

```rust
#[tauri::command]
pub async fn validate_deploy(
    project_path: String,
    command: String,
) -> Result<DeployValidation, String> {
    // 1. Parse the command to get the binary name
    // 2. Check if it exists on PATH
    // 3. Run git status --short to check working tree
    // 4. Return warnings/errors
}

#[derive(Serialize)]
pub struct DeployValidation {
    pub valid: bool,
    pub warnings: Vec<String>,   // non-blocking
    pub errors: Vec<String>,     // blocking
    pub git_branch: String,
    pub has_uncommitted: bool,
}
```

### Frontend: surface validation before running

In `DeployView`, before calling `startRun`:

```typescript
const validation = await validateDeploy(projectPath, config.command);
if (!validation.valid) {
  // Show validation errors and block deploy
  return;
}
// Show warnings but allow proceed
if (validation.warnings.length > 0) {
  // Show confirmation dialog with warnings
}
```

---

## Change 3: Deploy Log Display

### Deploy output panel

Add to `DeployView.tsx`:

- A collapsible deploy output panel below each active deploy run
- Shows live output as `deploy:output` events arrive
- On deploy completion, shows full output with ANSI color rendering
- "Copy log" and "Download log" buttons

### Log file persistence

Optionally write deploy output to:

```
~/.packetcode/deploys/{run_id}.log
```

This gives a persistent artifact even if the app restarts mid-deploy.

---

## Change 4: Flight Integration

### Wire deploy to flight completion

When a flight reaches `done` status, offer to run a deploy as the final step.

In `flightStore.ts` (or wherever flight completion is handled):

```typescript
// After flight marked done:
if (flight.deployConfig) {
  const confirmed = await confirm("Run deploy for this flight?");
  if (confirmed) {
    useDeployStore.getState().startRun(flight.deployConfig);
  }
}
```

### Surface deploy status in flight detail

In `FlightDetailView.tsx`, add a deploy status section:

- Show latest deploy run for this flight's project
- Show status, duration, and exit code
- "View log" button opens the deploy output panel

---

## Summary of Changes

| What                                                  | Where                              | Type           |
| ----------------------------------------------------- | ---------------------------------- | -------------- |
| `run_deploy` backend command                          | `src-tauri/src/commands/deploy.rs` | Backend change |
| `validate_deploy` backend command                     | `src-tauri/src/commands/deploy.rs` | Backend change |
| `DeployValidation` Rust type                          | `src-tauri/src/commands/deploy.rs` | Type change    |
| `DeployRun.output` field                              | `src/types/deploy.ts`              | Type change    |
| `startRun` async execution                            | `deployStore.ts`                   | Store change   |
| `validateDeploy` store action                         | `deployStore.ts`                   | Store change   |
| Event listeners for `deploy:output` and `deploy:exit` | `deployStore.ts`                   | Store change   |
| Pre-deploy validation call                            | `DeployView.tsx`                   | UI change      |
| Deploy output panel                                   | `DeployView.tsx`                   | UI change      |
| Flight → deploy wiring                                | `flightStore.ts`                   | Store change   |
| Deploy status in flight detail                        | `FlightDetailView.tsx`             | UI change      |

## Files to Modify

- `src-tauri/src/commands/deploy.rs`
- `src/types/deploy.ts`
- `src/stores/deployStore.ts`
- `src/components/views/DeployView.tsx`
- `src/stores/flightStore.ts` (or wherever flight completion is handled)
- `src/components/views/FlightDetailView.tsx` (or wherever flight detail is rendered)

## Delivery Order

1. Deploy execution (Change 1) — the core missing piece
2. Deploy log display (Change 3) — can ship immediately after Change 1
3. Pre-deploy validation (Change 2) — small addition before running
4. Flight integration (Change 4) — depends on Changes 1–3 landing first
