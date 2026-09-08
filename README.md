# Plot Ecosystem

A small simulated world in the browser: a circular plot of grass with wireframe creatures, red dotted trails, weather that drifts through the day, and a generative soundtrack made from what the inhabitants do.

## Run

Any static server works, for example:

```bash
python -m http.server 8765
```

Then open http://localhost:8765 and click to enter (audio needs a user gesture).

## What's inside

- `index.html` — layout and UI panels (ecosystem stats, how it works, events log, ticker player, recorder)
- `js/world.js` — Three.js scene: instanced grass with a wind shader, rocks, dead branches, flowers, rain, creatures and trails, orbit camera
- `js/sim.js` — weather machine, clock, and agents (nuthatch, badger, toad, voles, beetles, moths, wren, slug) with their own rules
- `js/audio.js` — Web Audio: pads that follow the weather, pentatonic plucks on events, rain/stream/wind beds and one-shot foley, recording to webm
- `js/main.js` — glue, log, ticker, recorder UI

## Controls

- Drag to orbit, wheel to zoom, click a creature to follow it
- Sliders: music and world volume
- Coloured dots: dusk / forest / night mood
- CLOSE hides the interface, RECORD captures the audio
