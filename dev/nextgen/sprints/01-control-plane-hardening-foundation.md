# Sprint 1 - Control Plane Hardening Foundation

## Goal

Make the Rust core the authoritative control plane so all later next-gen surfaces sit on trustworthy runtime semantics.

## Scope

- canonicalize orchestration ownership in Rust
- make PTY stop, pause, cancel, and detach atomic with state transitions
- promote approval-needed into canonical runtime events
- fix persistence ownership and cross-layer drift
- harden git safety
- expand tests around orchestration, PTY lifecycle, persistence, and git safety

## Team Of 10 Split

1. Runtime authority - 2 people
2. PTY and approval hardening - 2 people
3. Persistence and contract cleanup - 2 people
4. Git and trust boundaries - 2 people
5. Test and CI harness - 2 people

## Dependencies

- none; this sprint is the prerequisite for the rest of the roadmap

## Definition Of Done

- Rust is the only orchestration authority
- pause and cancel reflect real PTY behavior
- approval is canonical and durable
- persistence no longer depends on overlapping full-state rewrites
- git toolbar behavior is materially safer

## Risks

- runtime migration can break recovery or TUI parity
- Windows PTY behavior can differ under shutdown paths

## Demo Outcome

- launch, pause, approve, resume, cancel, and recover a flight with consistent state across desktop restart
