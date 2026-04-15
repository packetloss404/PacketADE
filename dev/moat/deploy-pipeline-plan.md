# Deploy Pipeline Plan

## Implementation Status — 2026-04-15

| Item | Status | Notes |
|------|--------|-------|
| Basic deploy execution via PTY | ✅ Done | DeployView launches PTY sessions |
| `run_deploy` backend command | ✅ Done | Dedicated deploy command implemented |
| `validate_deploy` backend command | ✅ Done | — |
| DeployRun.output field | ✅ Done | Type includes output array |
| Pre-deploy validation | ✅ Done | — |
| Flight→deploy integration | ✅ Done | — |

Last updated: 2026-04-15

## What the Deploy Pipeline Does Today

The deploy pipeline is implemented across:

- `src/stores/deployStore.ts`
- `src/components/views/DeployView.tsx`
- `src-tauri/src/commands/deploy.rs`

The current flow:

1. `deployStore.fetchConfigs()` calls `readDeployConfig(projectPath)` to load deploy configs for the current project
2. Users can add, remove, and edit deploy configurations
3. `saveConfigs()` calls `createDeployConfig(projectPath, configs)` to persist
4. `startRun()` tracks a deploy run with status, startedAt, finishedAt, and sessionId
5. The `DeployView` renders configs and run history

Deploy configs are stored as `packetcode.deploy.json` in the project directory.

## What Works

- Deploy configs are project-scoped and stored in the project directory
- Run history is tracked with timing and status
- Multiple configs per project are supported
- The run history is capped at 10 entries

## Known Gaps

### 1. Deploy execution is not implemented in the store

`startRun()` tracks the run but does not actually execute anything. The command to run is stored in the config but there is no backend command that actually runs the deploy.

### 2. No connection to sessions

A deploy run can be associated with a `sessionId` but there is no mechanism to launch a deploy inside a PTY session or to pipe session output into the deploy view.

### 3. Deploy is project-scoped but workspace-scoped deploy would be better

Deploy configs resolve against `projectPath` from `layoutStore`. Once the workspace-per-project model (Track W) lands, deploy should resolve against the active workspace's project instead.

### 4. No pre-deploy validation

There is no check that the deploy command is valid before running, that the target is reachable, or that the project is in a deployable state.

### 5. No deploy log

Completed deploy runs show status and timing but no log output.

### 6. Deploy is not connected to flights

A flight could have a deploy as an end goal, but there is no way to mark a flight's completion as a deploy step.

## What a Full Plan Would Cover

1. **Implement deploy execution** — wire `startRun()` to actually run the deploy command in a PTY session
2. **Pre-deploy validation** — check command validity, target reachability, and project state before running
3. **Deploy log output** — capture and display deploy command stdout/stderr in the run history
4. **Flight integration** — allow marking a flight as complete pending a successful deploy; surface deploy status in flight detail
5. **Workspace-per-project alignment** — once Track W lands, ensure deploy resolves from the active workspace's project path
6. **Deploy templates** — common deploy patterns (Vercel, Netlify, Docker, etc.) as pre-filled configs

## Recommendation

This doc is currently a gap audit. A full plan is needed before significant deploy pipeline work begins.

The most impactful single improvement would be: **implement actual deploy execution** in the backend, so that `startRun()` does something real instead of just recording metadata.

## Next Step

Read `src-tauri/src/commands/deploy.rs` to understand what deploy commands are currently supported and what the execution model should be.

## Implementation Spec

See `dev/moat/deploy-pipeline-implementation.md` for the full implementation plan covering deploy execution via PTY, pre-deploy validation, deploy log capture, and flight integration.
