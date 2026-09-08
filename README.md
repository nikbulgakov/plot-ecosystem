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

## The plot remembers

- Every creature is an individual with a name, an age and a lifespan. Young ones are small, old ones slow.
- The roster, the flowers, the stats and the last 40 log lines live in the browser's localStorage and are saved every half minute and when you leave.
- When you come back, the days you missed are replayed against the real weather history of your place (Open-Meteo, up to 92 days): frost and storms take the fragile, rain brings slugs and toads, warm months bring births, and empty niches are refilled by wanderers from beyond the plot.
- A pinned "while you were away" block at the top of the log tells you what happened, day by day.
- Add `?reset=1` to the URL to start a fresh plot.

## What's inside

- `index.html` — layout and UI panels (ecosystem stats, how it works, events log, ticker player, recorder)
- `js/world.js` — Three.js scene: instanced grass with a wind shader, rocks, dead branches, flowers, rain, creatures and trails, orbit camera
- `js/weather.js` — Open-Meteo client: geocoding, geolocation fallback, WMO code mapping, refresh
- `js/sim.js` — clock and weather (live from the sky, or simulated), and agents (nuthatch, badger, toad, voles, beetles, moths, wren, slug) with their own rules
- `js/audio.js` — Web Audio: pads that follow the weather, pentatonic plucks on events, rain/stream/wind beds and one-shot foley, recording to webm
- `js/life.js` — persistence and demography: roster with names and ages, births, deaths, arrivals, flowers, day steps and the catch-up after an absence
- `js/main.js` — glue, log, ticker, recorder UI, the "while you were away" block

## Controls

- Drag to orbit, wheel to zoom, click a creature to follow it
- Sliders: music and world volume
- Coloured dots: dusk / forest / night mood
- CLOSE hides the interface, RECORD captures the audio
