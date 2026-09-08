# Verge

A small simulated wild place in the browser, drawn like a 16-bit game and dressed like a modern app: a verge of grass with a few stones and a dead oak, creatures as pixel sprites with names, a generative soundtrack made from what the inhabitants do, and a **real sky**: time, weather, temperature, wind, sunrise and sunset come from the place you are in, so no two verges look the same. The world keeps living while the page is closed.

## Look

- **Scene**: the Three.js world is rendered to a low-resolution target (about 420 px wide), upscaled without smoothing, quantised to 12 levels per channel with a 4×4 ordered dither, and topped with a faint bloom. Creatures are 8×8-ish pixel sprites with a one-pixel outline that flip to face the way they move; they leave no trails.
- **Interface**: dark glass panels with blur and a thin light edge, Geist for text and Geist Mono for numbers, a pixel display face (Pixelify Sans) only for the wordmark and section titles, Silkscreen for micro-labels, pixel icons on an 8×8 grid, block meters, smooth sliders, a segmented mood control, a now-playing "island" and an amber notification card for what happened while you were away. One warm accent, green for live, red for alarm.

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

## Day, night and the year

- Creatures are animated: a two-frame walk (faster when fleeing, a slow shuffle while busy) and a curled sleeping pose after a moment at rest.
- Seasons follow the calendar at the place (flipped south of the equator): the grass goes to straw in autumn and winter, a warm spell greens it up, and a snow cover builds while it snows, holds in the cold and melts above freezing. Snow persists between visits.
- At night the sky fills with stars and a moon drawn at its real phase (tilt the camera toward the horizon to see them), moonlight brightens clear nights, fireflies drift over the grass when it is warm and dry, crickets fade in and an owl calls from beyond the ravine.

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
- Segmented control: dusk / forest / night mood
- Look panel: pixel size (2–6 px), dither strength, bloom and the grass palette (meadow, moss, straw, arcade), remembered in the browser
- Hide tucks the interface away, Record captures the audio
