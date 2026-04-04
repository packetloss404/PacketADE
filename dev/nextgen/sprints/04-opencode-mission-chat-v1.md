# Sprint 4 - OpenCode Mission Chat V1

## Goal

Add an OpenCode-powered mission chat that helps with planning, decomposition, and review assistance without replacing structured flight execution.

## Scope

- mission-scoped chat surface in Mission Workspace
- structured apply-actions for plan edits and review summaries
- audit trail for prompts, responses, and accepted actions
- no bypass of canonical runtime, git, or review policy

## Team Of 10 Split

1. Chat UX and interaction model - 2 people
2. OpenCode integration and session plumbing - 2 people
3. Structured apply-actions and plan mutation flow - 2 people
4. Safety and observability - 2 people
5. QA and readiness - 2 people

## Dependencies

- Sprint 1 complete
- Sprint 2 mission workspace complete
- Sprint 3 evidence and review packet work strongly preferred

## Definition Of Done

- operators can use mission chat inside a single flight workspace
- chat proposes structured changes that are explicitly accepted before mutation
- all accepted changes still flow through normal mutation and persistence paths
- mission chat runtime is OpenCode only in v1

## Risks

- users may assume more autonomy than the product intends
- prompt context packaging can drift from canonical flight state if not centralized

## Demo Outcome

- ask OpenCode to draft milestones, add dependencies, summarize review evidence, and apply selected changes safely
