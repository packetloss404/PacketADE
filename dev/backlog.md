# Backlog

## Implementation Status — 2026-04-15

| Item | Status | Notes |
|------|--------|-------|
| B-VOICE-001: Desktop-wide voice | ❌ Not started | All 6 sprints still TODO; useVoiceInput used in Agents tab (Web Speech API only) |

Last updated: 2026-04-09

This file captures ideas that should remain visible but are not active implementation priorities.

## B-VOICE-001 — Desktop-wide voice workflow

Status: **planned** — full integration plan exists in `dev/vibetotext/`

Priority: medium

Background:

- BridgeMind has a dedicated voice product and PacketCode does not
- PacketCode currently only has limited browser speech recognition via `useVoiceInput` hook
- A 6-sprint delivery plan (`dev/vibetotext/sprint.md`) was created 2026-04-09 covering native Rust dictation with local Whisper transcription

Current decision:

- A concrete plan exists to port VibeToText's local Whisper engine into PacketCode as a native Tauri module
- All sprints are still TODO — no Rust dictation backend, no dictation store, no native mic integration yet
- Sprint 1 (analytics migration) may be partially obsolete if AnalyticsView doesn't exist at time of implementation

Minimum bar (all addressed in the vibetotext plan):

- push-to-talk or toggle recording
- reusable voice input across the app
- transcript history
- clear privacy model (local Whisper, no cloud APIs)
- practical workflows like prompt dictation, review notes, commit text, and issue updates

## Parking Lot

Use this section for future deferred items as they emerge.
