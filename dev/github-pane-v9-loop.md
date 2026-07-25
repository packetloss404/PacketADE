# GitHub Pane v0.9+ — Scoped Loop

Created: 2026-07-25
Backlog: [`../backlog.md`](../backlog.md) → "GitHub pane v0.9+ (from v0.8 deferrals)".
Shape: same gated-loop cadence as [`gitea-support-loop.md`](./gitea-support-loop.md)
and [`memory-v9-loop.md`](./memory-v9-loop.md) (discrete, independently-gated
items; per-item commit; verify → record).

## Objective

Work through the seven GitHub-pane deferrals from v0.8. These are enhancements
to the (now dual-host) GitHub/Gitea pane, not gap-fixes — pick the value that's
worth the weight. **Host-awareness note:** the pane is now multi-host
(`core/git_host.rs`, active-connection routing). New commands must route through
`active_host_session` and be capability-gated (`lib/git-hosts.ts`
`GIT_HOST_CAPABILITIES`) so GitHub-only surfaces degrade cleanly on Gitea.

## Grounding — what's live today (do not rebuild)

| Piece | Where | Notes |
|---|---|---|
| API layer | `commands/github.rs` (~3200 ln) | All `reqwest`, routed per-connection via `active_host_session`. `github_post_pr_review_comment` already resolves the PR head SHA for `commit_id`. |
| Review data | `github_list_pr_reviews` / `github_list_pr_review_comments` (Rust DTOs `PullRequestReview` / `PullRequestReviewComment`) | Reviews viewable on both hosts; inline authoring GitHub-only (Gitea gated, G11). |
| Pane | `views/GitHubView.tsx` + `views/github/*` | Tabs `issues \| prs \| activity \| inbox`; `NotificationsInbox`, `PRReviewPanel`/`PullRequestReviewsPanel`, `DiffViewer.tsx`. |
| Notifications | `github_list_notifications` / `_mark_notification_read`; `NotificationsInbox.tsx` | Refresh on inbox-open / manual only. `githubStore` holds `notifications`. |
| Flight↔Issue link | `flightStore.addIssueToFlight` + `issueStore.assignToFlight` (bidirectional refs); one-way spec handoff from GitHub `InvestigationPanel` | Two-way *sync* to GitHub issues does not exist. |
| Auth | keyring per connection (`git_host_*` commands); PAT paste in `GitHubSettingsCard` + inline connect | No OAuth device-flow. |
| Commit hook | `prepare-commit-msg` POSIX sh (Git-for-Windows MSYS sh) | No `.cmd` shim; silent no-op under vanilla Windows OpenSSH. |
| SSH attempt publish | `core/tool_pull_request.rs` (`gh pr create`, local + SSH branches); `asyncFlightStore` publish path | "Publish attempts as draft PRs" **skips** SSH attempts (logs `errorMessage`). |
| Capability catalog | `lib/git-hosts.ts` `GIT_HOST_CAPABILITIES` / `capabilitiesFor` | Add flags here for any new GitHub-only surface. |

## Loop ledger

`queued → in-progress → gated → closed`. Order roughly value-per-weight, small
polish first.

| ID | Item | Acceptance | Key hooks | Gate | Size | Status |
|---|---|---|---|---|---|---|
| **GP1** | Inline review comments in the diff | New pure `lib/reviewCommentThreads.ts` (`groupCommentThreads` reply-chaining, `lineAnchorKey` JSON tuple, `threadsByAnchor` per-line index). `DiffViewer` takes `reviewComments`, indexes threads, and renders an `InlineThread` under each anchored line. GitHubView fetches the PR review comments (refetch on post + host change) and passes them in. | `lib/reviewCommentThreads.ts`; `DiffViewer.tsx`; `GitHubView.tsx`. | reviewCommentThreads vitest 5; lint 0; build OK. | M | ✅ closed 2026-07-25 |
| **GP2** | Notifications background polling | Pure `lib/notificationPoll.ts` (`isPollStale`, `shouldPollNotifications` — connected+visible+stale gate); `useNotificationsPoller` hook (immediate + interval, visibility-aware, resets on host change) wired in GitHubView so the unread badge stays live. Both hosts. | `lib/notificationPoll.ts`; `hooks/useNotificationsPoller.ts`; `GitHubView.tsx`. | notificationPoll vitest 6; lint 0; build OK. | S | ✅ closed 2026-07-25 |
| **GP3** | Native gh device-flow auth | Rust `github_device_flow_start`/`_poll` (device-code request + token poll against github.com; persists to keyring like a PAT); client id from `PACKETADE_GITHUB_CLIENT_ID` env or `brand::GITHUB_OAUTH_CLIENT_ID` (empty = disabled, clear error). Pure `lib/deviceFlow.ts` (delay/terminal); "Authorize with GitHub" flow in GitHubSettingsCard. | `github.rs`; `brand.rs`; `lib.rs`; `lib/tauri.ts`; `lib/deviceFlow.ts`; `GitHubSettingsCard.tsx`. | deviceFlow vitest 3; cargo check REAL_EXIT=0; lint 0; build OK. | M | ✅ closed 2026-07-25 |
| **GP4** | Windows hook shim | Detect-and-warn: `write_prepare_commit_msg_hook` warns (non-fatal) on Windows when no POSIX `sh`/`bash` is on PATH — the hook silently no-ops there. Testable `posix_shell_on_path_with` (injectable `exists`). A `.cmd` shim was rejected — git invokes hooks via `sh` regardless. | `core/worktree.rs`. | worktree gp4 unit tests (compile); cargo check REAL_EXIT=0. | S | ✅ closed 2026-07-25 |
| **GP5** | SSH attempt draft-PR publishing | "Publish attempts as draft PRs" works for **SSH** attempts too — `git push` from the remote worktree host + open the PR (host-aware: `gh`/API for GitHub, `tea`/API for Gitea). | `core/tool_pull_request.rs` SSH branch (currently errors); `asyncFlightStore` publish path; host-aware PR-URL extraction (already host-agnostic, G14). | cargo check + mocked publish test. | M | queued |
| **GP6** | Releases / gists / Actions-runs view | A read view for the current repo's releases (and optionally Actions runs), as new sub-tabs or a "More" surface. GitHub-only (capability-gated; Gitea Actions differ). | New `github_list_releases` / `_actions_runs` commands (route via active host, gate for Gitea); `GitHubView` sub-tabs. | Vitest + cargo check. | L | queued |
| **GP7** | Issue ⇄ Flight two-way mirroring | Opt-in "mirror this Flight to GitHub issues": create + update issues from Flight state, and reflect issue changes back. **Needs a design pass first** (collision + conflict resolution) — land the design doc before code. | `flightStore` ↔ `github.rs` issue writes; a sync-state + conflict model; `issueStore` bidirectional refs. | Design doc → then per-slice vitest. | L | queued (design-gated) |

## Deferred (not in this loop)

- **Full Actions/CI dashboard** beyond a read view (re-run, logs streaming) — its
  own effort; GP6 ships read-only first.
- **Gists** if GP6's scope proves too wide — split to releases-only.

## Loop protocol

Each iteration: claim the lowest-ID `queued` item whose deps are `closed`;
revalidate hooks against current code; implement minimally; add a focused test
(prefer pure helpers); gate (targeted vitest + `pnpm lint` + `pnpm build`;
`cargo check` real-exit for Rust — into the `packetade-build` scratch/target,
never the user's build dir); flip to `closed` + record; commit one item per
commit on `feat/github-pane-v9`. New host-facing commands route through
`active_host_session` and add a capability flag when GitHub-only.

## Suggested slices

- **Quick-win slice (S):** GP2 (polling badge) → GP4 (Windows hook shim). Small,
  self-contained, immediately visible.
- **Auth+publish slice (M):** GP3 (device-flow) + GP5 (SSH draft-PR publish) +
  GP1 (inline review comments) — the "fuller client" upgrades.
- **Bigger surfaces (L):** GP6 (releases/actions view), then GP7 (two-way
  mirroring) **after** its design pass. Re-confirm scope before starting each.
