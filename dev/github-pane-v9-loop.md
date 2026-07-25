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
| **GP1** | Inline review comments in the diff | The diff viewer shows existing PR review comments anchored to their lines (path + line + thread), read from `github_list_pr_review_comments`. (The `commit_id`-on-author half is already done.) | `DiffViewer.tsx`; `PullRequestReviewsPanel.tsx`; group comments by `path`+`line`, chain by `in_reply_to_id`. GitHub-only surface (Gitea listing returns `[]`, G11). | Vitest: pure comment→line grouping/threading helper. lint/build. | M | queued |
| **GP2** | Notifications background polling | A conservative background cadence refreshes the inbox + drives a live unread badge, pausing when the app is hidden. Both hosts. | Poller hook modelled on `useStatusLinePollerBase.ts` (mount + interval, visibility-aware); `githubStore.fetchNotifications`; badge in `SubTabs`/nav. | Vitest: pure cadence/visibility gate. lint/build. | S | queued |
| **GP3** | Native `gh` CLI device-flow auth | An "Authorize with GitHub" flow runs OAuth device-flow (user-code + verification URL) and stores the resulting token in the keyring like a pasted PAT. GitHub only. | New Rust command (device-code request + poll `access_token`); `GitHubSettingsCard` device-flow UI; reuse `save_host_token("github", …)`. | Vitest (UI state machine) + cargo check. | M | queued |
| **GP4** | Windows hook shim | The `prepare-commit-msg` hook works under vanilla Windows OpenSSH (no MSYS sh): ship a `.cmd` shim or detect-and-warn at hook-install time. | Hook install path (search `prepare-commit-msg`); add `prepare-commit-msg.cmd` + platform detection. | Rust unit test on shim selection; cargo check. | S | queued |
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
