# Restore point — timeline and lighting reliability batch

Created before implementation on 2026-08-01. This document is intentionally
frozen: do not edit it. It lets another human or AI safely resume the work
from the repository history if the active session is interrupted.

## Scope agreed with the project owner

1. Make follow-playhead pinning suspend throughout a playhead drag, then
   restore its prior mode after the gesture ends.
2. Keep vertical scrolling stable while the timeline is fully playhead-pinned.
3. Make a seek made by dragging the playhead authoritative while transport is
   playing; no concurrent live-state update may overwrite or reject it.
4. Audit the lighting signal path, make every tempo-synchronised effect use
   the master transport beat phase exactly, and expand the real addressable
   LED effect library, including selectable custom gradients for rhythmic
   effects.
5. Give the 3D LED preview a subtle per-pixel glow and snap every lighting
   panel to the stage grid, including after user movement.

## Engineering guardrails

- Native changes are in `/app` and `/engine`; frontend is `/ui` (Vite dev
  server is already running).
- After each completed feature, run its relevant tests and `pnpm run lint`.
  For native work, also run `pnpm test` and `pnpm run rebuild:run` before the
  feature commit. Pure frontend-only changes do not need an app restart.
- Make small, independently reviewable commits using the existing lowercase
  Conventional Commit style. Never include AI co-author or attribution lines.
- Preserve unrelated working-tree changes. Use `rg` to relocate symbols;
  paths and line numbers naturally drift.
- Prefer deterministic tests for timing, interpolation, grid snapping, and
  effect math. Do not add shallow UI tests solely for JSX wiring.

## First inspection targets

- Timeline gesture/follow logic: `ui/src/components/Timeline.tsx`,
  `ui/src/components/TrackWaveformLane.tsx`, and
  `ui/src/lib/useLiveState.ts`.
- Lighting renderer and transport phase: `app/LightEngine.cpp`,
  `app/MainComponentLighting.cpp`, `engine/lighting/`, plus
  `ui/src/components/light/`.
- Existing tests: `tests/test_light_*`, `tests/test_master_clock.cpp`, and
  `ui/src/lib/*.test.ts`.
