# Pong Ref

AI-powered beer pong referee: point a phone/webcam at the table and it tracks the ball, auto-detects made cups, calls elbow fouls, measures throw speed, and provides live commentary.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/public/` — the entire frontend (vanilla JS, no build step):
  - `app.js` — game controller: setup, calibration flow, scoring, turns, rebuttal/chandeliers, persistence
  - `vision.js` — CV engine (`window.Vision`): HSV ball tracking, throw state machine, cup make detection, elbow foul via MediaPipe Pose
  - `hands.js` — `window.HandGesture`: 4-finger island-call gesture via MediaPipe Hands (calls `window.onIslandGesture`)
  - `commentary.js` — `window.Commentary`: queued TTS + bubble; falls back to canned lines when `/api/commentary` returns null
- `artifacts/api-server/src/routes/commentary.ts` — Anthropic-backed commentary endpoint (returns `{text:null}` without `ANTHROPIC_API_KEY`; client falls back to canned lines)
- `.agents/memory/` — deep notes on the CV coordinate system and ball-tracking tuning; read before touching vision.js

## Architecture decisions

- All CV runs client-side on canvas pixels; the server only serves static files and generates commentary. No DB usage yet despite the scaffolding.
- Ball detection is pure HSV color matching against a user-sampled color — fragile by design; the in-game "Tracking ball / No ball" badge is the primary diagnostic.
- Gameplay is fully automatic: vision resolves every qualifying throw as a make (auto-score) or a miss (auto turn advance) — via cup disappearance, bounce-out, ball-at-rest, next-throw-start, or a 6s backstop timer. A throw only qualifies if it traveled ≥ ~1.2 ft toward the defending rack (so handling the ball never burns a turn). Low-confidence makes prompt briefly, then auto-count as a miss after 8s.
- Duplicate video frames (camera fps < rAF fps) are deduped before throw analysis — a zero-velocity repeat sample must never be treated as a reversal/stop.
- Every auto-detection still has a manual override: Pass Turn button, tap-a-cup toggle with confirm, rebuttal Made It/Miss buttons, click-to-place cups, undo on makes.
- Game state persists to localStorage (`pongref_v5`) after every event; calibration (corners, ball HSV, cup layout) is saved alongside so resume skips recalibration.
- MediaPipe Pose/Hands load from CDN and degrade gracefully (foul/gesture detection disabled) when unavailable.

## Product

- Setup: 1v1 or 2v2, 6 or 10 cups, table length, house rules (balls back, strict foul).
- Calibration: click 4 table corners → auto-detect red Solo cups (or drag/click to place) → sample ball color with live mask preview.
- Game: auto make detection with confidence prompt, throw-speed mph overlay, elbow-foul detection with confirm, fire streaks, island calls (button or hand gesture), behind-the-back bonus, balls back, rebuttal, chandeliers overtime, event log with undo, AI commentary with TTS, win screen with shareable stat card and game history.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
