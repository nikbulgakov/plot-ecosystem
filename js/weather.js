/* Real sky: Open-Meteo current conditions for the viewer's place (no API key needed). */
(function () {
  const Wx = {};
  const KEY = 'plot.place';
  const DEFAULT = { name: 'Moscow, RU', lat: 55.75, lon: 37.62 };
  const REFRESH = 10 * 60 * 1000;
  let place = null, timer = null, opts = {}, lastData = null;

  // WMO weather interpretation codes → plot weather states
  function fromCode(code) {
    if (code === 0 || code === 1) return 'clear';
    if (code === 2 || code === 3) return 'overcast';
    if (code === 45 || code === 48) return 'fog';
    if (code >= 51 && code <= 57) return 'drizzle';
    if (code >= 61 && code <= 67) return 'rain';
    if (code >= 71 && code <= 77) return 'snow';
    if (code >= 80 && code <= 82) return 'rain';
    if (code === 85 || code === 86) return 'snow';
    if (code >= 95) return 'storm';
    return 'overcast';
  }
  const hhmm = s => { const m = /T(\d\d):(\d\d)/.exec(s || ''); return m ? +m[1] + m[2] / 60 : null; };

  async function getJSON(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('http ' + r.status);
    return r.json();
  }
  async function geocode(name) {
    const j = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en&format=json`);
    if (!j.results || !j.results.length) throw new Error('place not found');
    const g = j.results[0];
    return { name: g.name + (g.country_code ? ', ' + g.country_code : ''), lat: g.latitude, lon: g.longitude };
  }
  async function reverse(lat, lon) {
    try {
      const j = await getJSON(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
      const n = j.city || j.locality || j.principalSubdivision;
      return n ? n + (j.countryCode ? ', ' + j.countryCode : '') : null;
    } catch (e) { return null; }
  }
  function geolocate() {
    return new Promise((res, rej) => {
      if (!navigator.geolocation) return rej(new Error('no geolocation'));
      navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lon: p.coords.longitude }), rej, { timeout: 8000, maximumAge: 600000 });
    });
  }
  function load() { try { const p = JSON.parse(localStorage.getItem(KEY)); return p && p.lat != null ? p : null; } catch (e) { return null; } }
  function save(p) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (e) {} }

  async function fetchWeather(p) {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}` +
      `&current=temperature_2m,precipitation,weather_code,wind_speed_10m,cloud_cover,is_day` +
      `&hourly=precipitation&past_hours=3&forecast_hours=1&daily=sunrise,sunset&timezone=auto&forecast_days=1`;
    const j = await getJSON(u);
    const c = j.current;
    const raw = fromCode(c.weather_code);
    let state = raw === 'storm' ? 'rain' : raw;
    const recent = ((j.hourly && j.hourly.precipitation) || []).slice(0, 3).reduce((a, b) => a + (b || 0), 0);
    if (state === 'clear' || state === 'overcast') {
      if (recent > 0.2 && !(c.precipitation > 0)) state = 'after rain';
      else if (c.wind_speed_10m >= 25) state = 'wind';
    }
    return {
      state, storm: raw === 'storm', code: c.weather_code, temp: c.temperature_2m, windKmh: c.wind_speed_10m, cloud: c.cloud_cover,
      isDay: c.is_day === 1, precipitation: c.precipitation, recentPrecipitation: recent,
      utcOffset: j.utc_offset_seconds, timezone: j.timezone,
      sunrise: hhmm(j.daily && j.daily.sunrise[0]), sunset: hhmm(j.daily && j.daily.sunset[0]),
      place: p, fetchedAt: Date.now(),
    };
  }

  async function refresh() {
    try {
      lastData = await fetchWeather(place);
      opts.onData && opts.onData(lastData);
    } catch (e) { opts.onError && opts.onError(e, 'weather'); }
  }
  function schedule() {
    clearInterval(timer);
    timer = setInterval(refresh, REFRESH);
  }

  async function resolvePlace() {
    const q = new URLSearchParams(location.search).get('place');
    if (q) { try { return await geocode(q); } catch (e) { opts.onError && opts.onError(e, 'geocode'); } }
    const stored = load();
    if (stored) return stored;
    try {
      const g = await geolocate();
      const name = await reverse(g.lat, g.lon);
      return { name: name || `here (${g.lat.toFixed(1)}, ${g.lon.toFixed(1)})`, lat: g.lat, lon: g.lon, fromGps: true };
    } catch (e) { opts.onError && opts.onError(e, 'geolocate'); }
    return Object.assign({ fallback: true }, DEFAULT);
  }

  Wx.start = async function (o) {
    opts = o || {};
    place = await resolvePlace();
    if (!place.fallback) save(place);
    opts.onPlace && opts.onPlace(place);
    await refresh();
    schedule();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && lastData && Date.now() - lastData.fetchedAt > REFRESH) refresh();
    });
  };
  Wx.setPlace = async function (name) {
    const p = await geocode(name);
    place = p; save(p);
    opts.onPlace && opts.onPlace(place);
    await refresh();
    schedule();
    return p;
  };
  // what the sky did over the last N days at the current place: per-date summaries
  Wx.history = async function (days) {
    const p = place || DEFAULT;
    const n = Math.max(1, Math.min(92, Math.ceil(days)));
    const j = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}&hourly=temperature_2m,precipitation,weather_code&past_days=${n}&forecast_days=1&timezone=auto`);
    const out = {}, H = j.hourly;
    for (let i = 0; i < H.time.length; i++) {
      const t = H.temperature_2m[i]; if (t == null) continue;
      const date = H.time[i].slice(0, 10), code = H.weather_code[i] || 0, pr = H.precipitation[i] || 0;
      const d = out[date] || (out[date] = { rainHours: 0, snowHours: 0, stormHours: 0, minTemp: t, maxTemp: t });
      const snow = (code >= 71 && code <= 77) || code === 85 || code === 86;
      if (snow) d.snowHours++; else if (pr > 0.1) d.rainHours++;
      if (code >= 95) d.stormHours++;
      d.minTemp = Math.min(d.minTemp, t); d.maxTemp = Math.max(d.maxTemp, t);
    }
    return { days: out, utcOffset: j.utc_offset_seconds };
  };
  Wx.place = () => place;
  Wx.last = () => lastData;
  Wx.describe = function (d) {
    const names = { 0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'rime fog', 51: 'light drizzle', 53: 'drizzle', 55: 'dense drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle', 61: 'slight rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain', 71: 'slight snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'rain showers', 81: 'rain showers', 82: 'violent showers', 85: 'snow showers', 86: 'snow showers', 95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with hail' };
    return `${names[d.code] || 'sky'}, ${Math.round(d.temp)}°C, wind ${Math.round(d.windKmh)} km/h`;
  };
  window.Weather = Wx;
})();
