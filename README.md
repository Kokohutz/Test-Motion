# Clone Dance
### The Dance Game: online, cross-platform and open-source

Create reference choreographies using videos and play along with your webcam or smartphone camera. This game uses MediaPipe to compare choreographies, giving you a score.

**Status: Alpha version. In standby, thinking how to resolve to have high-quality reference videos. You can open an issue if you have any clue.**

Demo:

[![Demo](https://img.youtube.com/vi/MMOTEbvUGqo/0.jpg)](https://www.youtube.com/watch?v=MMOTEbvUGqo)

Copyright / takedown notice — If this repository on GitHub contains material you own, please contact me directly or open an issue with your claim. I will cooperate and remove the content immediately upon request.

The app is a **Vite + React + TypeScript** single-page application (extractor and visualizer), with the game itself still served as a legacy static page until it is migrated. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full picture. No Python anywhere.

## Usage

### Run with Docker (nginx)

The image build runs the Vitest suite and the TypeScript type-check first — if either fails, the build aborts and nothing is served.

```bash
docker compose up --build
```

Then open http://localhost:8080:

- `/` — React app: **Extractor** (`#/extractor`) and **Visualizer** (`#/visualizer`)
- `/clone_dance.html` — the game (legacy page, plays choreographies produced by the extractor)

> Note: the webcam requires a secure context. `http://localhost` works; if you host it elsewhere, you'll need HTTPS.

### Develop locally

```bash
npm install
npm run dev      # Vite dev server with HMR
npm test         # Vitest suite
npm run build    # test + type-check + production bundle in dist/
```

### Create a choreography (video to JSON) — in the browser

Open the **Extractor** page, drop your dance video, pick a model (lite/full/heavy) and extraction FPS, and click **Extract Choreography**. When it finishes you can download:

- **Clone-Dance JSON** — works directly with the game and the visualizer.
- **Beatmap JSON** — the new step-based format (beat detection and step labeling coming next).

### Visualize the choreography (check it's OK)

Open the **Visualizer** page, load the video plus its JSON, and play it back with the skeleton and angle overlay.

### Play the game

Open `/clone_dance.html`, select the reference video and its choreography JSON, calibrate, and dance.

## TODO

- [ ] Make an enjoyable game
- [ ] Migrate the game page (clone_dance.html/js) into the React app
- [ ] Beat detection + step segmentation (beatmap M2)
- [ ] Improve visual and sound effects
- [ ] Fine-tuning of the detection and scoring strategy (position vs angle). I think it's better only angles. Skip or simplify calibration if only angles are used.
- [ ] Fine-tuning of the difficulty levels
- [ ] Test in more devices (smartphones and other browsers)
- [ ] Preview next pose
- [ ] Local multiplayer (now is limited to one person in the reference and the live video)
- [ ] Choreography (JSON) editor




Made with love and AI
