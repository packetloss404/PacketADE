# VibeToText Integration — Master Plan

Last updated: 2026-04-09

## Overview

Port VibeToText's core voice-to-text capabilities into PacketCode as a native Rust/Tauri dictation engine. Simultaneously move cost/usage analytics from a standalone view into the Tools page, and add a Dictation settings section alongside it.

**Source project:** `D:\repo\vibetotext` — a mature multi-platform dictation tool with local Whisper transcription, developer vocabulary biasing, multiple modes, and rich analytics.

**Goal:** PacketCode ships with built-in dictation — no external apps, no cloud APIs for transcription. Users press a hotkey or click a mic button, speak, and get developer-accurate text pasted into any input.

## Documents

- `features.md` — detailed feature spec covering the Rust backend, frontend UI, and analytics migration
- `sprint.md` — phased implementation plan with concrete file lists and acceptance criteria
- `../moat/analytics-plan.md` — existing analytics analysis (related: analytics moves to Tools page)

## Architecture

```
                    PacketCode (Tauri v2)
┌──────────────────────────────────────────────────┐
│  React Frontend                                   │
│  ┌────────────┐  ┌────────────┐  ┌─────────────┐ │
│  │ Dictation  │  │ Tools >    │  │ Mic button  │ │
│  │ Module View│  │ Dictation  │  │ in chats    │ │
│  │ (Record,   │  │ (Settings, │  │ (Insights,  │ │
│  │  History,  │  │  Model Mgr,│  │  Flights)   │ │
│  │  Analytics)│  │  Dictionary│  │             │ │
│  └─────┬──────┘  └─────┬──────┘  └──────┬──────┘ │
│        │               │                │         │
│        └───────────┬────┘────────────────┘         │
│                    │ Tauri invoke / events          │
│  ──────────────────┼────────────────────────────── │
│  Rust Backend      │                               │
│  ┌─────────────────▼──────────────────────┐        │
│  │  commands/dictation/                    │        │
│  │  ┌──────────┐ ┌──────────┐ ┌────────┐ │        │
│  │  │ audio.rs │ │whisper.rs│ │history │ │        │
│  │  │ (cpal +  │ │(whisper- │ │.rs     │ │        │
│  │  │  FFT)    │ │ rs)      │ │(sqlite)│ │        │
│  │  └──────────┘ └──────────┘ └────────┘ │        │
│  └────────────────────────────────────────┘        │
└──────────────────────────────────────────────────┘
         │                        │
    ~/.packetcode/           ~/.packetcode/
    models/                  dictation.db
    ggml-small.bin
```

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Transcription engine | whisper-rs (whisper.cpp bindings) | Local, offline, fast on CPU, GPU optional |
| Audio capture | cpal | Cross-platform, WASAPI on Windows, well-maintained |
| History storage | rusqlite (bundled) | Same schema as vibetotext for compatibility |
| Waveform viz | rustfft + Tauri events | 25-bar FFT at ~30fps, streamed to React |
| Vocabulary biasing | Whisper initial prompt | 200+ programming terms from vibetotext's vocab list |
| Paste mechanism | clipboard-win + enigo | Copy to clipboard, simulate Ctrl+V |
| Analytics location | Tools page sections | Analytics and Dictation as separate sidebar sections |
| Dictation full view | Module (not CoreView) | Keeps CoreView type lean, opt-in via module system |
