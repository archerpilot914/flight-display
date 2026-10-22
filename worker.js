// Cloudflare Worker: ADS-B relay for the Flight Display page.
// Fetches aircraft near a point from free community feeds (server-side, so the
// browser never has to talk to them directly) and returns the JSON with CORS enabled.
// Usage: https://YOUR-WORKER.workers.dev/?lat=43.57&lon=-71.42&r=50

const SOURCES = [
  (la, lo, r) => `https://api.adsb.lol/v2/point/${la}/${lo}/${r}`,
  (la, lo, r) => `https://opendata.adsb.fi/api/v2/lat/${la}/lon/${lo}/dist/${r}`,
  (la, lo, r) => `https://api.adsb.one/v2/point/${la}/${lo}/${r}`,
];
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const u = new URL(request.url);
    // /metar?ids=KLCI,KCON  -> aviationweather.gov METARs (includes flight category)
    if (u.pathname === "/api/metar" || u.pathname === "/metar") {
      const ids = (u.searchParams.get("ids") || "").replace(/[^A-Za-z0-9,]/g, "").slice(0, 200);
      if (!ids) return new Response(JSON.stringify({ error: "ids required" }), { status: 400, headers: CORS });
      try {
        const up = await fetch(`https://aviationweather.gov/api/data/metar?format=json&ids=${ids}`, {
          headers: { "User-Agent": "flight-display/1.0 (personal project)" },
          cf: { cacheTtl: 60, cacheEverything: true },
        });
        return new Response(await up.text(), { status: up.status, headers: { ...CORS, "Cache-Control": "public, max-age=60" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: "metar fetch failed" }), { status: 502, headers: CORS });
      }
    }
    if (u.pathname !== "/api/aircraft" && u.pathname !== "/") return env.ASSETS.fetch(request);
    if (u.pathname === "/" && !u.searchParams.has("lat")) return env.ASSETS.fetch(request);
    const q = u.searchParams;
    const lat = parseFloat(q.get("lat")), lon = parseFloat(q.get("lon"));
    const r = Math.min(250, Math.max(1, parseInt(q.get("r") || "50", 10) || 50));
    if (isNaN(lat) || isNaN(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return new Response(JSON.stringify({ error: "lat and lon required" }), { status: 400, headers: CORS });
    }
    // Snap to a ~3 NM grid so several displays share one cached upstream request.
    const la = (Math.round(lat * 20) / 20).toFixed(2);
    const lo = (Math.round(lon * 20) / 20).toFixed(2);
    const attempts = [];
    for (let i = 0; i < SOURCES.length; i++) {
      const provider = ["adsb.lol", "adsb.fi", "adsb.one"][i];
      try {
        const up = await fetch(SOURCES[i](la, lo, r), {
          headers: { "Accept": "application/json" },
          signal: AbortSignal.timeout(8000),
        });
        if (!up.ok) { attempts.push({provider,status:up.status}); continue; }
        const payload = await up.json();
        if (!Array.isArray(payload.ac) && !Array.isArray(payload.aircraft)) {
          attempts.push({provider,status:"invalid aircraft format"}); continue;
        }
        return Response.json(payload, { headers: { "Cache-Control": "public, max-age=10" } });
      } catch (e) {
        attempts.push({provider,status:String(e).slice(0,100)});
      }
    }
    return Response.json({error:"All internet aircraft sources unavailable",attempts}, {status:502,headers:{"Cache-Control":"no-store"}});
  },
};
