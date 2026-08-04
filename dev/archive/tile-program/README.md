# Tile Program - Superseded Design Record

Status: **ARCHIVED 2026-08-03 - DO NOT RESUME**

The Tile program executed useful substrate work, including conversation tiles,
session projection/glue, Fleet sidebar behavior, and worktree lifecycle paths.
Its final product direction was later reversed by the approved Workspace/Agents
contract:

- Workspaces are CLI/PacketCode-first.
- Agents remains a first-class same-window GUI-agent surface.
- New Workspace conversation attachments and wrapper materializers are retired.
- Existing saved conversation panes remain load-compatible.
- Interactive detachable Agent windows wait for a safe single-writer state
  contract.

The files in this directory are retained as historical implementation evidence,
not as a backlog or restart plan. Current authority:

- [`../../workspace-agents-restructuring-goal.md`](../../workspace-agents-restructuring-goal.md)
- [`../../workspace-agents-wa0-route-contract.md`](../../workspace-agents-wa0-route-contract.md)
- [`../../workspace-agents-wa4-dogfood-gate.md`](../../workspace-agents-wa4-dogfood-gate.md)
- [`../../../backlog.md`](../../../backlog.md)
