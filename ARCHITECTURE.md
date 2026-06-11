# Architecture

Clone Dance is a fully client-side dance game: a video of someone dancing is
turned into a "choreography" (a pose time series), and the player dances along
in front of their webcam while the game scores the match. There is no backend,
no Python, and no standalone HTML pages — the whole product is one React SPA
(Vite + TypeScript) served as static files. `index.html` is only Vite's shell;
a test enforces that `public/` contains no other HTML.

## High-level layout

```
                 ┌────────────────────────────────────────────────┐
                 │              React SPA (Vite + TS)              │
                 │   src/pages: GamePage  ExtractorPage  Visualizer│
                 │   src/hooks: usePoseLandmarker  useAppConfig    │
                 └──────────────┬─────────────────┬───────────────┘
                                │ snapshots/cmds   │ imports
                 ┌──────────────▼──────────┐      │
                 │  Game runtime (src/game) │      │
                 │  engine.ts  effects.ts   │      │
                 │  sounds.ts (stateful,    │      │
                 │  framework-free)         │      │
                 └──────────────┬──────────┘      │
                                │ imports          │
                 ┌──────────────▼──────────────────▼───────────────┐
                 │           Core domain layer (src/core/)          │
                 │  choreography.ts  comparison.ts  scoring.ts      │
                 │  gameConfig.ts  extraction.ts  drawing.ts        │
                 │  config.ts  types.ts   (pure logic, unit-tested) │
                 └──────────────────────────────────────────────────┘
```

Both pipelines — offline extraction and the live game — run the **same**
`@mediapipe/tasks-vision` PoseLandmarker (VIDEO mode), so reference and player
skeletons are directly comparable.

## Layers

### 1. Core domain layer — `src/core/`

Framework-free TypeScript; everything pure is unit-tested in Node (83 tests).

| Module | Responsibility |
|---|---|
| `types.ts` | Domain types: landmarks, pose frames, choreography + beatmap schemas, config shape. |
| `choreography.ts` | Angle math, landmark serialization, visibility gating, choreography/beatmap builders, mirroring, dominant joints. |
| `comparison.ts` | Live-game math: left/right mirroring, torso-based normalization (calibration), angle/position comparison with injectable EMA smoothing state, windowed best-pose search (binary search + quick compare) for timing forgiveness. |
| `scoring.ts` | Scoring/combo state machine as a pure reducer returning events (comboUp/comboMax), GOOD/GREAT/PERFECT tier resolution, no-pose warning state machine. |
| `gameConfig.ts` | Merges `config.json`'s game section + difficulty presets (+ per-session tuning overrides) into one typed, defaulted `GameConfig`. |
| `extraction.ts` | Deterministic video→pose-series engine (seek per frame, callback-driven). |
| `drawing.ts` | Canvas skeleton/angle-label rendering shared by extractor preview and visualizer. |
| `config.ts` | Fetches + validates `public/config.json` (memoized). |

### 2. Game runtime — `src/game/`

Stateful but framework-free; React drives it with commands and renders the
snapshots it emits.

- `engine.ts` — owns the whole game loop: the webcam/test-video pose loop
  (`detectForVideo` per rAF with monotonic timestamps), the calibration phase
  (match the reference pose, hold it N frames, derive torso normalization),
  the 3-2-1 countdown, reference-video playback sync, per-frame comparison →
  scoring → feedback/sound/effects triggers, debug skeleton drawing, sizing.
  It exposes commands (`togglePlayPause`, `reset`, `startCalibration`,
  `skipCalibration`, `retry`, `setCalibrationTime`, …) and emits one
  `GameSnapshot` object the UI renders from.
- `effects.ts` — canvas-2D additive particle trail that follows the reference
  dancer's most active joint while the player scores well (replaces the old
  p5.js/WebGL shader, so no p5/CDN dependency).
- `sounds.ts` — reward SFX bank (initialized inside a user gesture).

### 3. Hooks — `src/hooks/`

`usePoseLandmarker` (lazy create per model complexity, GPU→CPU fallback,
close on unmount) and `useAppConfig` (shared `config.json`).

### 4. Pages — `src/pages/` + `App.tsx`

Hash routing without a router dependency: `#/game` (default), `#/extractor`,
`#/visualizer`. `GamePage` renders the setup screen (files, webcam/test-video
input, difficulty presets with a per-field tuning editor, mirror/VFX/debug
toggles), then the HUD, calibration overlay with a frame scrubber, countdown,
feedback popups, and the end-of-song stats card — all driven by engine
snapshots. Visual intensity (popup scale/duration, combo pulse) flows from the
difficulty preset into CSS custom properties.

## Data flow

```
reference.mp4 ─► ExtractorPage ─► extraction.ts (PoseLandmarker VIDEO mode)
                                     │  poses: landmarks + 8 joint angles
                                     ▼
                      choreography.ts builders
                       │                      │
           choreography JSON             beatmap JSON (steps/angles;
                       │                  bpm pending M2 beat detection)
                       ▼
   GamePage (#/game): webcam ─► engine ─► comparison ─► scoring ─► HUD/FX
                       │
              VisualizerPage (inspect overlay)
```

Angles are the comparison currency (scale/translation invariant); landmarks
are kept per frame for skeleton/ghost rendering.

## Dev & prod systems

```
Dev  (hot reload):  npm run dev            → http://localhost:5173
                    docker compose --profile dev up
                       (bind mount + polling watch → HMR inside Docker)

Prod (nginx):       docker compose --profile prod up --build
                       → http://localhost:8080
```

One multi-stage `Dockerfile` serves both: `base` (npm ci) → `dev` (Vite dev
server, used by the dev compose profile) and `build` (vitest + tsc + vite
build) → `prod` (nginx serving `dist/`). The prod image cannot assemble if a
test or type error exists. nginx config: gzip for multi-MB choreography JSONs,
immutable caching for hashed `/assets/`, `.task` models and the wasm runtime.

The MediaPipe wasm runtime is copied from `node_modules` into
`public/mediapipe-wasm/` before dev/build (`scripts/copy-wasm.mjs`,
gitignored), so the served app needs no CDN at runtime and the wasm can never
drift from the npm package version.

## Git workflow (CI)

`.github/workflows/ci.yml`:

- **test-and-build** — on every PR and push to main: `npm ci` →
  `npm run build` (Vitest suite → `tsc --noEmit` → Vite bundle), uploads
  `dist/` as an artifact.
- **docker-image** — on main: builds the production nginx image (tests run
  again inside the build stage) with GitHub Actions layer caching. Add a
  registry login/push step there to publish the image.

## Testing strategy

All tests run in Node — no browser — which is what lets them gate the build:

- `tests/choreography.test.ts` — extraction math + output schemas.
- `tests/comparison.test.ts` — mirroring, normalization (torso mapping),
  angle/position comparison incl. EMA smoothing, windowed best-pose search.
- `tests/scoring.test.ts` — points/combo state machine, combo events,
  freeze-on-no-pose, seek handling, feedback tiers, warning delays.
- `tests/gameConfig.test.ts` — difficulty preset resolution + overrides.
- `tests/config.test.ts` — `config.json` validation + drift check against
  the TypeScript fallbacks.
- `tests/site.test.ts` — served assets exist; **no `.html` files in
  `public/`**; shipped choreographies match the schema.

Not covered: real camera/GPU/MediaPipe inference — that remains manual (a
Playwright smoke test is the natural next addition).

## Directory map

```
├── index.html              Vite shell (the only HTML file)
├── src/
│   ├── main.tsx, App.tsx   bootstrap + hash routing
│   ├── core/               pure domain logic (unit-tested)
│   ├── game/               game engine, effects, sounds (framework-free)
│   ├── hooks/              React ↔ MediaPipe/config bridges
│   ├── pages/              GamePage, ExtractorPage, VisualizerPage
│   └── styles.css, pages/game.css
├── public/                 config.json, pose models, choreographies, sfx,
│                           mediapipe-wasm/ (generated)
├── tests/                  Vitest (Node)
├── scripts/copy-wasm.mjs
├── Dockerfile              base → dev | build → prod (nginx)
├── docker-compose.yml      profiles: dev (5173, HMR) / prod (8080)
├── nginx.conf
└── .github/workflows/ci.yml
```
