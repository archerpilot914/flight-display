// Cloudflare Worker backend for the Flight Display page. Serves, on your own domain:
//   /api/aircraft?lat=&lon=&r=      live aircraft near a point (adsb.lol -> adsb.fi -> adsb.one)
//   /api/search?query=DAL123        find any aircraft worldwide by callsign, registration or ICAO hex
//   /api/plan?ident=DAL123&hex=...  filed route (FlightAware, needs a key) + flown path (ADS-B trace)
//   /api/metar?ids=KLCI,KCON        METARs from aviationweather.gov
//   /api/route?callsign=DAL123      origin/destination from adsbdb (kept for older pages)
// Optional secret: AEROAPI_KEY (FlightAware AeroAPI key) enables the real filed route.

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Content-Type": "application/json" };
const json = (o, status = 200, ttl = 0) => new Response(JSON.stringify(o), { status, headers: { ...CORS, ...(ttl ? { "Cache-Control": "public, max-age=" + ttl } : {}) } });
const UA = { "User-Agent": "flight-display/1.0 (personal project)" };
const get = (url, ttl = 5, headers = {}) => fetch(url, { headers: { ...UA, ...headers }, cf: { cacheTtl: ttl, cacheEverything: true } });
const num = (v) => (v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const thin = (a, n) => (a.length <= n ? a : a.filter((_, i) => i % Math.ceil(a.length / n) === 0 || i === a.length - 1));

const AIR = [
  (la, lo, r) => `https://api.adsb.lol/v2/point/${la}/${lo}/${r}`,
  (la, lo, r) => `https://opendata.adsb.fi/api/v2/lat/${la}/lon/${lo}/dist/${r}`,
  (la, lo, r) => `https://api.adsb.one/v2/point/${la}/${lo}/${r}`,
];
const FIND = [
  ["adsb.lol", "https://api.adsb.lol/v2", { hex: "hex", cs: "callsign", reg: "reg" }],
  ["adsb.fi", "https://opendata.adsb.fi/api/v2", { hex: "hex", cs: "callsign", reg: "registration" }],
  ["adsb.one", "https://api.adsb.one/v2", { hex: "hex", cs: "callsign", reg: "reg" }],
];

async function search(raw) {
  const q = raw.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 12);
  if (q.length < 3) return { ac: [], source: null, error: "query too short" };
  const kinds = /^[0-9A-F]{6}$/.test(q) ? ["hex", "cs", "reg"] : ["cs", "reg"];
  for (const [name, base, paths] of FIND) {
    for (const k of kinds) {
      try {
        const r = await get(`${base}/${paths[k]}/${q}`, 5);
        if (!r.ok) continue;
        const j = await r.json();
        const ac = (j.ac || j.aircraft || []).filter((a) => a.lat != null && a.lon != null);
        if (ac.length) return { ac, source: name };
      } catch (e) { /* try next */ }
    }
  }
  return { ac: [], source: null };
}

async function plan(env, ident, hex) {
  const out = { ident, origin: null, destination: null, airline: null, route: "", filed: [], actual: [], sources: {} };
  const apt = (a, fix) => a ? { icao: a.code_icao || a.code || null, iata: a.code_iata || null, name: a.name || null, city: a.city || null, latitude: fix ? num(fix.latitude) : null, longitude: fix ? num(fix.longitude) : null } : null;
  let faTrack = [];

  // 1) Filed route from FlightAware AeroAPI (only if a key is configured)
  if (env.AEROAPI_KEY) {
    try {
      const h = { "x-apikey": env.AEROAPI_KEY };
      const fa = (u) => get("https://aeroapi.flightaware.com/aeroapi" + u, 300, h);
      const r = await fa(`/flights/${encodeURIComponent(ident)}?max_pages=1`);
      if (r.ok) {
        const flights = (await r.json()).flights || [];
        const f = flights.find((x) => x.actual_off && !x.actual_on) || flights.find((x) => x.actual_off) || flights[0];
        if (f && f.fa_flight_id) {
          const [rr, tr] = await Promise.all([fa(`/flights/${f.fa_flight_id}/route`), fa(`/flights/${f.fa_flight_id}/track`)]);
          const rj = rr.ok ? await rr.json() : {};
          const fixes = (rj.fixes || []).filter((x) => num(x.latitude) !== null && num(x.longitude) !== null);
          out.origin = apt(f.origin, fixes[0]);
          out.destination = apt(f.destination, fixes[fixes.length - 1]);
          out.airline = f.operator || null;
          out.route = f.route || "";
          out.filed = fixes.map((x) => [num(x.latitude), num(x.longitude), x.name || ""]);
          if (out.filed.length > 1) out.sources.filed = "FlightAware";
          if (tr.ok) faTrack = ((await tr.json()).positions || []).map((p) => [num(p.latitude), num(p.longitude)]).filter((p) => p[0] !== null && p[1] !== null);
        }
      }
    } catch (e) { /* fall through to free sources */ }
  }

  // 2) Airports from adsbdb when no filed route/coordinates are available
  const okA = (a) => a && a.latitude !== null && a.longitude !== null;
  if (!okA(out.origin) || !okA(out.destination)) {
    try {
      const r = await get(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(ident)}`, 3600);
      if (r.ok) {
        const fr = ((await r.json()).response || {}).flightroute;
        if (fr && fr.origin && fr.destination) {
          const m = (a) => ({ icao: a.icao_code, iata: a.iata_code, name: a.name, city: a.municipality, latitude: num(a.latitude), longitude: num(a.longitude) });
          out.origin = m(fr.origin); out.destination = m(fr.destination);
          out.airline = out.airline || (fr.airline && fr.airline.name) || null;
          out.sources.airports = "adsbdb";
        }
      }
    } catch (e) { /* ignore */ }
  }

  // 3) Flown path: ADS-B trace history (adsb.lol), else FlightAware track
  if (/^[0-9a-f]{6}$/i.test(hex || "")) {
    const h = hex.toLowerCase();
    for (const base of ["https://globe.adsb.lol", "https://adsb.lol"]) {
      try {
        const r = await get(`${base}/data/traces/${h.slice(-2)}/trace_full_${h}.json`, 30);
        if (!r.ok) continue;
        const pts = ((await r.json()).trace || []).filter((p) => num(p[1]) !== null && num(p[2]) !== null).map((p) => [p[1], p[2]]);
        if (pts.length > 1) { out.actual = thin(pts, 400); out.sources.actual = "adsb.lol"; break; }
      } catch (e) { /* try next */ }
    }
  }
  if (out.actual.length < 2 && faTrack.length > 1) { out.actual = thin(faTrack, 400); out.sources.actual = "FlightAware"; }
  return out;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const u = new URL(request.url), q = u.searchParams, p = u.pathname;
    if (!p.startsWith("/api/")) return env.ASSETS.fetch(request);

    if (p === "/api/photo") {
      const hex = (q.get("hex") || "").trim().toLowerCase();
      const reg = (q.get("reg") || "").trim().toUpperCase();
      if (!/^[0-9a-f]{6}$/.test(hex)) return json({ error: "invalid hex" }, 400);
      const validUrl = (value) => {
        try { const u = new URL(value); return u.protocol === "https:" &&
          (u.hostname === "planespotters.net" || u.hostname.endsWith(".planespotters.net")); }
        catch { return false; }
      };
      for (const path of ["hex/" + hex, ...(/^[A-Z0-9-]{3,12}$/.test(reg) ? ["reg/" + encodeURIComponent(reg)] : [])]) {
        try {
          const upstream = await get("https://api.planespotters.net/pub/photos/" + path, 3600);
          if (!upstream.ok) continue;
          const ph = ((await upstream.json()).photos || [])[0];
          const src = ph && ((ph.thumbnail_large && ph.thumbnail_large.src) || (ph.thumbnail && ph.thumbnail.src));
          if (src && validUrl(src) && validUrl(ph.link))
            return json({ photo: { src, link: ph.link, by: ph.photographer || "Unknown" } }, 200, 3600);
        } catch (err) { /* try registration or return unavailable */ }
      }
      return json({ photo: null }, 200, 3600);
    }

    if (/\/search$/.test(p)) return json(await search(q.get("query") || ""), 200, 5);

    if (/\/plan$/.test(p)) {
      const ident = (q.get("ident") || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 10).toUpperCase();
      if (!ident) return json({ error: "ident required" }, 400);
      return json(await plan(env || {}, ident, q.get("hex") || ""), 200, 60);
    }

    if (/\/route$/.test(p)) {
      const cs = (q.get("callsign") || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 10);
      if (!cs) return json({ error: "callsign required" }, 400);
      try {
        const up = await get(`https://api.adsbdb.com/v0/callsign/${cs}`, 3600);
        return new Response(await up.text(), { status: up.status, headers: { ...CORS, "Cache-Control": "public, max-age=3600" } });
      } catch (e) { return json({ error: "route fetch failed" }, 502); }
    }

    if (/\/metar$/.test(p)) {
      const ids = (q.get("ids") || "").replace(/[^A-Za-z0-9,]/g, "").slice(0, 200);
      if (!ids) return json({ error: "ids required" }, 400);
      try {
        const up = await get(`https://aviationweather.gov/api/data/metar?format=json&ids=${ids}`, 60);
        return new Response(await up.text(), { status: up.status, headers: { ...CORS, "Cache-Control": "public, max-age=60" } });
      } catch (e) { return json({ error: "metar fetch failed" }, 502); }
    }

    // default: aircraft near a point
    const lat = parseFloat(q.get("lat")), lon = parseFloat(q.get("lon"));
    const r = Math.min(250, Math.max(1, parseInt(q.get("r") || "50", 10) || 50));
    if (isNaN(lat) || isNaN(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return json({ error: "lat and lon required" }, 400);
    const la = (Math.round(lat * 20) / 20).toFixed(2), lo = (Math.round(lon * 20) / 20).toFixed(2);
    const attempts = [];
    for (const src of AIR) {
      try {
        const up = await get(src(la, lo, r), 5);
        if (!up.ok) { attempts.push({ provider: new URL(src(la, lo, r)).hostname, status: up.status }); continue; }
        return new Response(await up.text(), { headers: { ...CORS, "Cache-Control": "public, max-age=5" } });
      } catch (e) { attempts.push({ provider: "network", status: 0 }); }
    }
    return json({ error: "all sources failed", attempts }, 502);
  },
};