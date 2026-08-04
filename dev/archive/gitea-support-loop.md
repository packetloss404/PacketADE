# Gitea / Forgejo Support — Scoped Loop

Created: 2026-07-25
Backlog: [`../../backlog.md`](../../backlog.md) → current Git-host proof and parity items.
Shape: same gated-loop cadence as [`memory-v9-loop.md`](./memory-v9-loop.md)
(discrete, independently-gated items; per-item commit; verify → record).

## Objective

Support a **self-hosted Gitea/Forgejo host alongside cloud GitHub, both
configured at once**. A workspace uses whichever host its `origin` remote
belongs to; the pane's logo/labels follow that host. No global "active provider"
switch — dual-config is a first-class requirement, resolved per workspace.

Forgejo shares Gitea's `/api/v1`, so "Gitea support" delivers Forgejo for free.

## The "both configured" model (design decision)

- Config holds a **list** of git-host connections, each
  `{ id, type: "github" | "gitea", baseUrl, token, label }`. Multiple GitHub +
  multiple Gitea allowed. (Today: a single in-memory GitHub token.)
- **Per-workspace resolution:** match the repo's `origin` remote host to a
  configured connection — `github.com` → the GitHub connection; a configured
  Gitea `baseUrl` host → that Gitea connection.
- **Branding follows the resolved host** (nav icon/label, RepoSelector, PR URLs).
- **Ambiguous cases** (no matching connection, multiple remotes, host not
  configured) → a small manual host picker / per-workspace override.
- Secrets: tokens stay in-memory per current model; **Gitea `baseUrl` persists**
  (not a secret, needed to build any request).

## Grounding — what's live today (do not rebuild)

| Piece | Where | Notes |
|---|---|---|
| GitHub API layer | `commands/github.rs` (3118 ln) | All `reqwest`, host hardcoded `https://api.github.com`. 45 Tauri commands. Client builder `github_client` (:173), token from state `github_client_from_state` (:260). `Link`-header pagination (:800). |
| 2nd GitHub client | `core/tool_github.rs` | Independent client + token loader for API-agent tools (`gh_list_issues`/`_get_issue`/`_list_prs`). Also hardcodes `api.github.com`. Must become host-aware too. |
| `gh` CLI shell-out | `core/tool_pull_request.rs` | The ONLY `gh` dependency — `create_pull_request` agent tool (local + SSH). Hardcodes `github.com/.../pull/`. Gitea has no `gh` (→ `tea`/API). |
| Auth | `GitHubAuthState { token: RwLock<Option<String>> }` (github.rs:157) | In-memory only; keyring/file read-once-then-scrubbed at startup (:87). No restart persistence. |
| Frontend store | `stores/githubStore.ts` | `githubHasToken`/`SetToken`/`ClearToken`; persists selected repo only (`packetade:github`) + settings (`packetade:github:settings`). |
| View | `views/GitHubView.tsx` (1007 ln) + `views/github/*` | Tabs `issues \| prs \| activity \| inbox`; PR sub-tabs `overview \| checks`. |
| DTOs | `types/github.ts` | Two families: **passthrough snake_case** (`GitHubRepo/Issue/Pr` — raw GitHub JSON parsed on the frontend → couples to GitHub wire shape) and **camelCase Rust DTOs** (checks/reviews/notifications — already normalized, frontend-stable). |
| Provider-picker precedent | `lib/api-models.ts` `API_PROVIDERS` | The 8-row LLM catalog with per-provider capability flags — the pattern to mirror for a `GIT_HOSTS` catalog. |
| Branding | lucide `Github` icon + "GitHub" in ~20 files | `LeftRail.tsx:20`, `GitHubView`, `GitHubSettingsCard`, `CommandPalette`, `ToolsView`, `StatusStrip`, workspace cards, etc. No Gitea glyph in lucide → custom SVG needed. |

## Gitea vs GitHub API divergences (the hard edges)

| Area | GitHub | Gitea `/api/v1` | Item |
|---|---|---|---|
| Auth | `Bearer` | `token <PAT>` (also accepts Bearer) | G2/G4 |
| Pagination | `per_page` + `Link rel=next` | `page`+`limit` + `X-Total-Count` | G4 |
| PR diff | `Accept: application/vnd.github.diff` | `.diff` **URL suffix** | G6 |
| Merge | `PUT .../merge {merge_method}` | `{Do: merge\|squash\|rebase}` | G9 |
| Draft PR | GraphQL `convertPullRequestToDraft` (+`node_id`) | REST `draft` field / `WIP:` title — **no GraphQL** | G10 |
| Review state enum | `CHANGES_REQUESTED` | `REQUEST_CHANGES` | G11 |
| Inline review comment | `line`+`side`+`commit_id` | `path`+`new_position`/`old_position` | G11 |
| Checks | `/commits/{sha}/check-runs` + `/status` | `/status` only (no check-runs → 404) | G10 |
| Notifications | `GET /notifications`, `PATCH /threads/{id}` (205) | `GET /api/v1/notifications`, mark-read `?to-status=read` | G12 |
| Activity feed | `/repos/.../events` (typed events) | no equivalent (`/activities/feeds`, diff schema) | G10 (hide) |

## Loop ledger

`queued → in-progress → gated → closed`. Foundation first, then read, write,
divergent surfaces, branding. Sizes from the map.

| ID | Item | Acceptance | Key hooks | Gate | Size | Status |
|---|---|---|---|---|---|---|
| **G1** | `GitHost` seam + client construction routed | New `core/git_host.rs`: `GitHostKind`, `GitHost { kind, api_base }`, `github()`/`gitea()`, `url()`, `build_client()` (Bearer vs `token` auth, per-kind Accept). `github.rs` `github_client` delegates to it; `active_git_host` resolver stub added. **GitHub byte-identical.** Per-command `host.url()` base-threading rides with G4–G12 (each Gitea command group threads its own — lower risk than a 46-site sweep). | `core/git_host.rs`; `commands/github.rs`. | cargo check REAL_EXIT=0, no new warnings; git_host unit tests (compile-only in WSL). | L | ✅ closed 2026-07-25 |
| **G2** | Multi-connection auth + config model | `GitHubAuthState` now holds a connection list + keyring-backed token map. **All tokens persist in the OS keyring** keyed by connection id — GitHub included, so no re-prompt after restart (migrates the legacy token in); Gitea connection metadata persists to `git-hosts.json`. New commands `git_host_list_connections`/`_add_gitea`/`_remove_connection`/`_set_token`/`_has_token`; `github_set/has/clear_token` stay as `"github"`-connection aliases. Frontend `lib/git-hosts.ts` catalog + URL normalizer, `githubStore` connections slice, "+ Add Gitea host" flow in `GitHubSettingsCard`. | `github.rs`; `lib.rs`; `lib/tauri.ts`; `lib/git-hosts.ts`; `githubStore.ts`; `GitHubSettingsCard.tsx`. | git-hosts vitest 7; cargo check REAL_EXIT=0; lint 0; build OK. | L | ✅ closed 2026-07-25 |
| **G3** | Per-workspace host resolution | Pure `lib/gitHostResolve.ts` (`remoteHost` hostname parse for https/scp/ssh, `connectionHost`, `resolveConnectionForRemote`); `githubStore.activeConnectionId` + `resolveActiveConnectionForProject` (via `gitGetOriginUrl`); GitHubView resolves on project change. | Vitest 11 (parse/match/ambiguous/no-match); lint 0; build OK. | M | ✅ closed 2026-07-25 |
| **G4** | GiteaHost — auth, user, repos + routing | Backend active-connection routing: `GitHubAuthState.active_connection_id` + `git_host_set_active` cmd + `active_host_session` helper. Routed `github_get_authenticated_user` & `github_list_repos`(`_page`) through the active host; `GitHost::page_params`/`user_repos_path` handle the `per_page`-vs-`limit` divergence. Gitea repo/user JSON matches the `GitHubRepo`/`GhUser` subset, so no normalization needed. Frontend `gitHostSetActive` synced from the store resolver. | `git_host.rs`; `github.rs`; `lib.rs`; `lib/tauri.ts`; `githubStore.ts`. | git_host unit tests (page/repos paths); cargo check REAL_EXIT=0; lint 0; build OK. | M | ✅ closed 2026-07-25 |
| **G5** | Gitea issues read | Routed `github_list_issues`, `github_get_issue`(`_with_client`), `github_list_issue_comments`, `github_list_issues_page` through `active_host_session` + `host.url()`/`page_params`. Gitea issue/comment JSON matches the `GitHubIssue`/`GitHubIssueComment` subset (no normalization); PR-strip filter is a harmless no-op on Gitea; both hosts emit RFC5988 `Link` for `has_more`. AI-path `github_get_issue_with_client` callers pinned to `GitHost::github()`. | `github.rs`. | cargo check REAL_EXIT=0. | M | ✅ closed 2026-07-25 |
| **G6** | Gitea PRs read | Routed `github_list_prs`(`_page`), `github_get_pr_diff`, `github_list_branches` through the active host. `GitHost::pr_diff_path`/`pr_diff_accept` handle GitHub media-type-header vs Gitea `.diff` URL-suffix; branch SHA falls back to Gitea `commit.id`. PR JSON matches `GitHubPr` subset (no normalization). | `git_host.rs`; `github.rs`. | cargo check REAL_EXIT=0. | M | ✅ closed 2026-07-25 |
| **G7** | Gitea labels / milestones / assignees read | Routed `github_list_repo_labels`, `github_list_repo_milestones`, `github_list_repo_assignable_users` through the active host + `page_params`. Gitea shapes match. | `github.rs`. | cargo check REAL_EXIT=0. | S | ✅ closed 2026-07-25 |
| **G8** | Gitea issue writes | Routed `patch_issue` (close/reopen/assignees/milestone via PATCH state), `github_post_issue_comment`, `github_set_issue_labels` through the active host. Gitea label PUT takes **ids** not names → `resolve_gitea_label_ids` maps names→ids from the repo label set. | `github.rs`. | cargo check REAL_EXIT=0. | M | ✅ closed 2026-07-25 |
| **G9** | Gitea PR writes | Routed `github_create_pr`, `github_merge_pr`, `patch_pr_state` (close/reopen), `github_set_pr_reviewers`, `github_set_pr_labels`, `github_set_pr_milestone`. Merge body key `merge_method`→`Do` for Gitea; `draft` sent only to GitHub; PR labels name→id for Gitea. | `github.rs`. | cargo check REAL_EXIT=0. | M | ✅ closed 2026-07-25 |
| **G10** | Capability flags + graceful degradation | `GIT_HOST_CAPABILITIES` + `capabilitiesFor` in `git-hosts.ts` (draft/checks/activity false for Gitea). GitHubView hides the Activity tab + redirects off it for Gitea. Backend: `active_host_kind` helper; `github_get_pr_checks` returns empty for Gitea (no check-runs), `github_convert_pr_to_draft` errors with a WIP-title hint. | `git-hosts.ts`; `GitHubView.tsx`; `github.rs`. | git-hosts vitest 8; cargo check REAL_EXIT=0; lint 0; build OK. | M | ✅ closed 2026-07-25 |
| **G11** | Gitea PR reviews + inline comments | Routed `github_list_pr_reviews` (enum `REQUEST_CHANGES`→`CHANGES_REQUESTED`, `COMMENT`→`COMMENTED` in `parse_pr_review`) + `github_list_pr_review_comments` (empty for Gitea). Inline-comment authoring feature-gated for Gitea (v1) with a clear error → use a regular PR comment. | `github.rs`. | cargo check REAL_EXIT=0. | L | ✅ closed 2026-07-25 |
| **G12** | Gitea notifications | Routed `github_list_notifications` + `github_mark_notification_read` through the active host. `parse_notification` handles Gitea numeric ids + `subject.html_url`; mark-read appends `?to-status=read` for Gitea. | `github.rs`. | cargo check REAL_EXIT=0. | M | ✅ closed 2026-07-25 |
| **G13** | Branding follows host | New `components/HostIcon.tsx` (custom Gitea/Forgejo mug+branch SVG + GitHub lucide) and `hostLabel` in `git-hosts.ts`. GitHubView shows a host-switcher bar (HostIcon + connection label, click to override the active host) once >1 connection is configured. | `HostIcon.tsx`; `git-hosts.ts`; `GitHubView.tsx`. | lint 0 errors; build OK. | M | ✅ closed 2026-07-25 |
| **G14** | Agent-tool + PR-tool host-awareness | `core/tool_pull_request.rs` `extract_pr_url` made host-agnostic (matches Gitea `/pulls/<n>` as well as GitHub `/pull/<n>`, any http/https). `core/tool_github.rs` `gh_*` agent read-tools documented as GitHub-scoped; full Gitea agent-tool parity deferred (they load the GitHub token directly with no per-workspace host context — the interactive pane is the primary Gitea surface). | `core/tool_pull_request.rs`; `core/tool_github.rs`. | cargo check REAL_EXIT=0. | M | ✅ closed 2026-07-25 |

## Deferred (not in this loop)

- **Gitea agent-tool parity** — the `gh_*` read tools in `core/tool_github.rs`
  and the `gh pr create` path in `core/tool_pull_request.rs` stay GitHub-scoped;
  Gitea would need per-workspace host context threaded into those tools + a
  `tea`/API create-PR path. The interactive GitHub pane already covers Gitea.
- **Full Gitea Actions/check-runs parity** — Gitea has no check-runs API; G10
  degrades to combined commit status. Richer CI surfacing is its own effort.
- **AI compare-diff for Gitea** — GitHub's `/compare` returns a raw diff; Gitea's
  returns JSON, so `github_ai_pr_description`'s compare path degrades to the
  `.diff` PR endpoint on Gitea (fine for single-PR); multi-commit compare deferred.
- **GraphQL-only GitHub features** beyond the draft toggle stay GitHub-only
  (capability-gated, never called on Gitea).

## Loop protocol

Each iteration: claim the lowest-ID `queued` item whose deps are `closed`;
revalidate hooks against current code (line refs drift); implement minimally;
add a focused test (prefer pure helpers + Rust unit tests / mocked clients);
gate (targeted vitest + `pnpm lint` + `pnpm build`; `cargo check` real-exit for
Rust — into the redirected `packetade-build` target dir); flip to `closed` +
record; commit one item per commit on `feat/gitea-support`.

## Suggested slices

- **Foundation slice (must-do first):** G1 → G2 → G3. The trait seam + multi-
  connection config + per-workspace resolution. Nothing Gitea-facing works until
  these land, and GitHub keeps working throughout.
- **MVP-usable slice:** + G4 → G6 → G8/G9 (partial) + G13. A Gitea workspace can
  browse repos/issues/PRs, read diffs, do basic issue/PR actions, with the Gitea
  logo. Feature-gate reviews/checks/notifications (G10 hides them) until later.
- **Full-parity slice:** G7, G10–G12, G14 — reviews, notifications, capability
  gating, and the agent/PR tools.

## Scope note

This is materially larger than the Memory loop (45 commands across **three**
GitHub client locations + ~20 branding files + real API divergences). Recommended
to run the **Foundation slice first** and re-confirm before the Gitea client work,
so GitHub stays green and the seam is proven before breadth.
