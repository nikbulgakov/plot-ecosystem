# Plot Ecosystem

A small simulated world in the browser: a circular plot of grass with wireframe creatures, red dotted trails, a generative soundtrack made from what the inhabitants do, and a **real sky**: time, weather, temperature, wind, sunrise and sunset come from the place you are in, so no two plots look the same.

## Real weather

- Conditions come from [Open-Meteo](https://open-meteo.com) (no API key) and refresh every 10 minutes.
- The place is resolved in this order: `?place=City` in the URL, the last place you picked (stored in the browser), your geolocation (if you allow it), and finally Moscow as a fallback.
- Click the place name in the panel to move the plot to another city. Snow, thunderstorms, fog and wind all have their own look and sound.
- If the sky cannot be reached the plot falls back to its own simulated weather and clock.

## Run

Any static server works, for example:

```bash
python -m http.server 8765
```

Then open http://localhost:8765 and click to enter (audio needs a user gesture).

## What's inside

- `index.html` — layout and UI panels (ecosystem stats, how it works, events log, ticker player, recorder)
- `js/world.js` — Three.js scene: instanced grass with a wind shader, rocks, dead branches, flowers, rain, creatures and trails, orbit camera
- `js/weather.js` — Open-Meteo client: geocoding, geolocation fallback, WMO code mapping, refresh
- `js/sim.js` — clock and weather (live from the sky, or simulated), and agents (nuthatch, badger, toad, voles, beetles, moths, wren, slug) with their own rules
- `js/audio.js` — Web Audio: pads that follow the weather, pentatonic plucks on events, rain/stream/wind beds and one-shot foley, recording to webm
- `js/main.js` — glue, log, ticker, recorder UI

## Controls

- Drag to orbit, wheel to zoom, click a creature to follow it
- Sliders: music and world volume
- Coloured dots: dusk / forest / night mood
- CLOSE hides the interface, RECORD captures the audio
