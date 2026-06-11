# Architecture

Clone Dance is a fully client-side dance game: a video of someone dancing is
turned into a "choreography" (a pose time series), and the player dances along
in front of their webcam while the game scores the match. There is no backend
and no Python — everything runs in the browser, served as static files.

## High-level layout

```
                    ┌──────────────────────────────────────────────┐
                    │            React SPA (Vite + TS)             │
                    │  src/pages/ExtractorPage   VisualizerPage    │
                    │  src/hooks/usePoseLandmarker  useAppConfig   │
                    └───────────────┬──────────────────────────────┘
                                    │ imports
                    ┌───────────────▼──────────────────────────────┐
                    │        Core domain layer (src/core/)         │
                    │  choreography.ts  extraction.ts  drawing.ts  │
                    │  config.ts        types.ts                   │
                    │  (no React; choreography.ts also no DOM)     │
                    └───────────────┬──────────────────────────────┘
                                    │ shared contract: config.json +
                                    │ choreography JSON schema
                    ┌───────────────▼──────────────────────────────┐
                    │       Legacy game page (public/)             │
                    │  clone_dance.html + clone_dance.js           │
                    │  + vendored MediaPipe legacy Pose + p5.js    │
                    └──────────────────────────────────────────────┘
```

## Layers

### 1. Core domain layer — `src/core/`

Framework-free TypeScript. This is where all the dance-specific logic lives,
and it is the part covered by unit tests.

| Module | Responsibility | Browser APIs? |
|---|---|---|
| `types.ts` | All shared domain types: landmarks, pose frames, the legacy choreography schema, the step-based beatmap schema, the config.json shape. | none |
| `choreography.ts` | Pure functions: 2D joint-angle math, landmark serialization, visibility gating, building the legacy choreography JSON and the beatmap JSON, dominant-joint detection, mirroring. Deterministic — fully unit-tested in Node. | none |
| `extraction.ts` | The video→pose-series engine: seeks an `HTMLVideoElement` frame-by-frame at a fixed FPS (deterministic, machine-speed independent) and runs MediaPipe `PoseLandmarker` in VIDEO mode. Reports through callbacks (`onProgress`, `onFrame`, `shouldCancel`) so it has no opinion about UI. | video element, MediaPipe |
| `drawing.ts` | Canvas skeleton/angle-label rendering shared by the extractor preview and the visualizer. | canvas 2D |
| `config.ts` | Fetches and validates `public/config.json` (memoized promise). | fetch |

The rule for this layer: **anything that can be a pure function is one**, and
React never reaches around it to touch MediaPipe or canvas directly.

### 2. Hooks — `src/hooks/`

The bridge between React's lifecycle and stateful browser/ML resources:

- `usePoseLandmarker` — lazily creates the MediaPipe `PoseLandmarker` for the
  requested model complexity (lite/full/heavy), caches it across runs,
  falls back from GPU to CPU delegate, and closes it on unmount.
- `useAppConfig` — loads `config.json` once and exposes `{config, error}`;
  pages render fallback defaults until it arrives.

### 3. Pages — `src/pages/` + `src/App.tsx`

Thin React components: form state, progress display, canvas refs, download
buttons. `App.tsx` does hash-based routing (`#/extractor`, `#/visualizer`) —
no router dependency. The render loop in the visualizer keeps mutable refs for
playback state so the `requestAnimationFrame` loop doesn't re-subscribe on
every React state change.

### 4. Legacy game — `public/clone_dance.html` + `clone_dance.js`

The playable game (calibration, scoring, combos, effects) still runs as a
self-contained static page, served untouched from `public/`. It is a
**strangler-fig migration**: the React app and the legacy page interoperate
through two shared contracts —

1. `public/config.json` — single source of truth for landmarks, angle joints,
   difficulty presets; read by both worlds (and validated by tests, including
   a drift check against the TypeScript fallbacks).
2. The **choreography JSON schema** — the extractor produces exactly the
   format the game consumes.

Migrating it into React is the next big step; until then nothing about it
changed, so it cannot have regressed.

## Data flow

```
reference.mp4 ──► ExtractorPage ──► extraction.ts (seek + PoseLandmarker VIDEO mode)
                                        │ poses: landmarks + 8 joint angles/frame
                                        ▼
                       choreography.ts builders
                        │                      │
            legacy choreography JSON      beatmap JSON (steps/angles,
                        │                  bpm pending M2 beat detection)
                        ▼
        /clone_dance.html (play)  +  VisualizerPage (inspect)
```

Angles, not raw coordinates, are the comparison currency (scale/translation
invariant); each frame stores both angles (for scoring) and landmarks (for
ghost-overlay rendering later).

## Build & deployment pipeline

```
npm run build
  └─ prebuild: vitest run (49 tests)  ← gate
               scripts/copy-wasm.mjs  ← vendors MediaPipe wasm into public/
  └─ tsc --noEmit                     ← gate
  └─ vite build → dist/               ← SPA bundle + everything in public/
```

- **Docker**: stage 1 (`node:22-alpine`) runs `npm ci && npm run build`; the
  nginx stage copies only `dist/`. A test or type failure aborts the image.
- **nginx**: gzip for the multi-MB choreography JSONs; immutable caching for
  Vite's content-hashed `/assets/`, the `.task` models and the wasm runtime;
  `no-cache` for JSON configs.
- The MediaPipe wasm runtime is copied from `node_modules` at build time
  (`public/mediapipe-wasm/`, gitignored), so the served site is fully
  self-contained — no CDN at runtime for the React app — and the wasm version
  can never drift from the npm package. (The legacy game page still loads its
  older MediaPipe Pose solution from `public/cdn/` as before.)

## Testing strategy

All tests run in Node (no browser needed), which is what allows them to gate
the Docker build:

- `tests/choreography.test.ts` — unit tests for the pure logic: angle math,
  visibility gating, both output schemas, mirroring, dominant joints.
- `tests/config.test.ts` — validates `config.json` (sections, landmark/joint
  references, difficulty presets, threshold ordering) and that the TypeScript
  fallbacks haven't drifted from it.
- `tests/site.test.ts` — static wiring for the legacy page: every script it
  references exists, every element id `clone_dance.js` looks up exists in the
  HTML, sound/model assets are present, shipped choreographies match the
  schema.

What is *not* covered: anything requiring a real camera, GPU, or MediaPipe
inference — that stays manual for now (a Playwright smoke test is the natural
next addition).

## Directory map

```
├── index.html              React entry (Vite)
├── src/
│   ├── main.tsx, App.tsx   bootstrap + hash routing
│   ├── core/               framework-free domain logic (tested)
│   ├── hooks/              React ↔ MediaPipe/config lifecycle bridges
│   ├── pages/              ExtractorPage, VisualizerPage
│   └── styles.css
├── public/                 served verbatim; legacy game + shared assets
│   ├── clone_dance.html/.js, config_loader.js, cdn/, visual_effects/
│   ├── config.json         shared config contract
│   ├── pose_landmarker_{lite,full,heavy}.task
│   ├── choreographies/     sample extracted choreographies
│   └── mediapipe-wasm/     (generated, gitignored)
├── tests/                  Vitest (Node environment)
├── scripts/copy-wasm.mjs   vendors the wasm runtime at build time
├── Dockerfile              test+build stage → nginx stage
├── docker-compose.yml      localhost:8080
└── nginx.conf
```
