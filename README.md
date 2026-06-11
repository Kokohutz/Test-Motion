# Clone Dance
### The Dance Game: online, cross-platform and open-source

Create reference choreographies using videos and play along with your webcam or smartphone camera. This game uses MediaPipe to compare choreographies, giving you a score.

**Status: Alpha version. In standby, thinking how to resolve to have high-quality reference videos. You can open an issue if you have any clue.**

Demo:

[![Demo](https://img.youtube.com/vi/MMOTEbvUGqo/0.jpg)](https://www.youtube.com/watch?v=MMOTEbvUGqo)

Copyright / takedown notice — If this repository on GitHub contains material you own, please contact me directly or open an issue with your claim. I will cooperate and remove the content immediately upon request.

The app is a **Vite + React + TypeScript** single-page application covering the game, the extractor and the visualizer. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full picture. No Python, no standalone HTML pages.

## Usage

### Dev (hot reload)

```bash
npm install
npm run dev          # Vite dev server with HMR -> http://localhost:5173
```

or inside Docker (bind-mounted, still hot-reloads on edit):

```bash
docker compose --profile dev up
```

### Prod (nginx)

The image build runs the Vitest suite and the TypeScript type-check first — if either fails, the build aborts and nothing is served. The same checks run in CI (`.github/workflows/ci.yml`) on every PR and push to main.

```bash
docker compose --profile prod up --build   # -> http://localhost:8080
```

The app is a single React SPA (no standalone HTML pages):

- `#/game` (default) — play: pick a reference video + choreography JSON, calibrate, dance
- `#/extractor` — drop a dance video, get the choreography JSON (in-browser, no Python)
- `#/visualizer` — overlay an extracted choreography on its video to check it

> Note: the webcam requires a secure context. `http://localhost` works; if you host it elsewhere, you'll need HTTPS.

### Tests

```bash
npm test   # Vitest, 83 tests, all run in Node (no browser needed)
```

## TODO

- [ ] Make an enjoyable game
- [ ] Beat detection + step segmentation (beatmap M2)
- [ ] Improve visual and sound effects
- [ ] Fine-tuning of the detection and scoring strategy (position vs angle). I think it's better only angles. Skip or simplify calibration if only angles are used.
- [ ] Fine-tuning of the difficulty levels
- [ ] Test in more devices (smartphones and other browsers)
- [ ] Preview next pose
- [ ] Local multiplayer (now is limited to one person in the reference and the live video)
- [ ] Choreography (JSON) editor




Made with love and AI
