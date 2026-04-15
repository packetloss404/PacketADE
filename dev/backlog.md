# Backlog

## Implementation Status — 2026-04-15

| Item | Status | Notes |
|------|--------|-------|
| B-VOICE-001: Desktop-wide voice | ✅ Done | All 6 sprints implemented; native Whisper engine integrated |

Last updated: 2026-04-15

This file captures ideas that should remain visible but are not active implementation priorities.

## B-VOICE-001 — Desktop-wide voice workflow

Status: **done** — native Whisper engine integrated

Priority: medium

Background:

- BridgeMind has a dedicated voice product and PacketCode does not
- A 6-sprint delivery plan (`dev/vibetotext/sprint.md`) was created 2026-04-09 covering native Rust dictation with local Whisper transcription
- All 6 sprints have been implemented: native Rust dictation backend, dictation store, native mic integration, and local Whisper transcription are complete

Minimum bar (all addressed in the vibetotext plan):

- push-to-talk or toggle recording
- reusable voice input across the app
- transcript history
- clear privacy model (local Whisper, no cloud APIs)
- practical workflows like prompt dictation, review notes, commit text, and issue updates

## Parking Lot

Use this section for future deferred items as they emerge.
