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

// ---- geometry + airport helpers (used to verify routes against what the aircraft actually did) ----
const R_NM = 3440.065, rd = (d) => (d * Math.PI) / 180;
const dNM = (a, b, c, d) => { const p = rd(c - a), l = rd(d - b), x = Math.sin(p / 2) ** 2 + Math.cos(rd(a)) * Math.cos(rd(c)) * Math.sin(l / 2) ** 2; return 2 * R_NM * Math.asin(Math.sqrt(x)); };
const brg = (a, b, c, d) => { const y = Math.sin(rd(d - b)) * Math.cos(rd(c)), x = Math.cos(rd(a)) * Math.sin(rd(c)) - Math.sin(rd(a)) * Math.cos(rd(c)) * Math.cos(rd(d - b)); return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360; };
function xtrack(o, d, p) { // nautical miles from point p to the great circle o -> d
  const d13 = dNM(o[0], o[1], p[0], p[1]) / R_NM, t13 = rd(brg(o[0], o[1], p[0], p[1])), t12 = rd(brg(o[0], o[1], d[0], d[1]));
  return Math.abs(Math.asin(Math.sin(d13) * Math.sin(t13 - t12)) * R_NM);
}
function plausible(o, d, pos) { // is an aircraft at pos (with heading pos.trk) really flying o -> d?
  if (xtrack(o, d, pos) > 60) return false;
  const left = dNM(pos[0], pos[1], d[0], d[1]);
  if (left > 30 && pos.trk != null) {
    const diff = Math.abs(((brg(pos[0], pos[1], d[0], d[1]) - pos.trk + 540) % 360) - 180);
    if (diff > 75) return false;
  }
  return true;
}
const APTS = ("KBOS|BOS|Boston Logan|42.3643|-71.0052;KPWM|PWM|Portland|43.6462|-70.3093;KMHT|MHT|Manchester|42.9326|-71.4357;KCON|CON|Concord|43.2027|-71.5023;KLCI|LCI|Laconia|43.5727|-71.4189;KPSM|PSM|Portsmouth|43.0779|-70.8233;KBGR|BGR|Bangor|44.8074|-68.8281;KBTV|BTV|Burlington|44.4720|-73.1533;KALB|ALB|Albany|42.7483|-73.8017;KBDL|BDL|Hartford Bradley|41.9389|-72.6832;KPVD|PVD|Providence|41.7233|-71.4282;KHPN|HPN|White Plains|41.0670|-73.7076;KLGA|LGA|LaGuardia|40.7769|-73.8740;KJFK|JFK|New York JFK|40.6398|-73.7789;KEWR|EWR|Newark|40.6925|-74.1687;KPHL|PHL|Philadelphia|39.8719|-75.2411;KBWI|BWI|Baltimore|39.1754|-76.6683;KDCA|DCA|Washington National|38.8521|-77.0377;KIAD|IAD|Washington Dulles|38.9445|-77.4558;KORD|ORD|Chicago O'Hare|41.9786|-87.9048;KMDW|MDW|Chicago Midway|41.7868|-87.7522;KATL|ATL|Atlanta|33.6367|-84.4281;KCLT|CLT|Charlotte|35.2140|-80.9431;KMCO|MCO|Orlando|28.4294|-81.3089;KMIA|MIA|Miami|25.7959|-80.2870;KFLL|FLL|Fort Lauderdale|26.0726|-80.1527;KTPA|TPA|Tampa|27.9755|-82.5332;KDTW|DTW|Detroit|42.2124|-83.3534;KCLE|CLE|Cleveland|41.4117|-81.8498;KPIT|PIT|Pittsburgh|40.4915|-80.2329;KCVG|CVG|Cincinnati|39.0488|-84.6678;KDFW|DFW|Dallas Fort Worth|32.8998|-97.0403;KIAH|IAH|Houston|29.9844|-95.3414;KAUS|AUS|Austin|30.1975|-97.6664;KDEN|DEN|Denver|39.8561|-104.6737;KLAX|LAX|Los Angeles|33.9416|-118.4085;KSFO|SFO|San Francisco|37.6213|-122.3790;KSEA|SEA|Seattle|47.4502|-122.3088;KLAS|LAS|Las Vegas|36.0840|-115.1537;KPHX|PHX|Phoenix|33.4343|-112.0116;KMSP|MSP|Minneapolis|44.8848|-93.2223;KSTL|STL|St. Louis|38.7487|-90.3700;KBUF|BUF|Buffalo|42.9405|-78.7322;KROC|ROC|Rochester NY|43.1189|-77.6724;KSYR|SYR|Syracuse|43.1112|-76.1063;KORF|ORF|Norfolk|36.8946|-76.2012;KRDU|RDU|Raleigh Durham|35.8776|-78.7875;KBNA|BNA|Nashville|36.1245|-86.6782;KMSY|MSY|New Orleans|29.9934|-90.2580;KSAN|SAN|San Diego|32.7336|-117.1897;KSLC|SLC|Salt Lake City|40.7884|-111.9778;KPDX|PDX|Portland OR|45.5887|-122.5975;KBED|BED|Hanscom|42.4700|-71.2890;KORH|ORH|Worcester|42.2673|-71.8757;KEEN|EEN|Keene|42.8984|-72.2708;KLEB|LEB|Lebanon|43.6261|-72.3042;KASH|ASH|Nashua|42.7817|-71.5148;KSFM|SFM|Sanford|43.3939|-70.7088;KDAW|DAW|Rochester NH|43.2841|-71.0292;KHYA|HYA|Hyannis|41.6693|-70.2804;KACK|ACK|Nantucket|41.2531|-70.0603;KMVY|MVY|Martha's Vineyard|41.3931|-70.6143;KISP|ISP|Islip|40.7952|-73.1002;KSWF|SWF|Stewart|41.5041|-74.1048;KTEB|TEB|Teterboro|40.8501|-74.0608;CYUL|YUL|Montreal|45.4706|-73.7408;CYYZ|YYZ|Toronto|43.6777|-79.6248;CYOW|YOW|Ottawa|45.3225|-75.6692;CYQB|YQB|Quebec City|46.7911|-71.3933;CYHZ|YHZ|Halifax|44.8808|-63.5086").split(";").map((s) => { const p = s.split("|"); return { icao: p[0], iata: p[1], name: p[2], latitude: +p[3], longitude: +p[4] }; });
function nearestApt(lat, lon, maxNM) {
  let best = null, bd = maxNM;
  for (const a of APTS) { const d = dNM(lat, lon, a.latitude, a.longitude); if (d < bd) { bd = d; best = a; } }
  return best;
}
// The most recent takeoff in today's ADS-B trace = the last point the aircraft reported "ground" before flying on.
function departureOf(j) {
  const rows = j.trace || [];
  let idx = -1;
  for (let i = 0; i < rows.length; i++) if (rows[i][3] === "ground") idx = i;
  if (idx < 0 || idx >= rows.length - 1) return null;
  const r = rows[idx], lat = num(r[1]), lon = num(r[2]);
  if (lat === null || lon === null) return null;
  return { lat, lon, time: (num(j.timestamp) || 0) + (num(r[0]) || 0), airport: nearestApt(lat, lon, 8) };
}

async function plan(env, ident, hex, pos) {
  const out = { ident, origin: null, destination: null, airline: null, route: "", filed: [], actual: [], departure: null, notes: [], sources: {} };
  const apt = (a, fix) => a ? { icao: a.code_icao || a.code || null, iata: a.code_iata || null, name: a.name || null, city: a.city || null, latitude: fix ? num(fix.latitude) : null, longitude: fix ? num(fix.longitude) : null } : null;
  const okA = (a) => a && a.latitude !== null && a.longitude !== null;
  let faTrack = [];

  // 1) Today's ADS-B trace: the flown path and where this aircraft actually took off
  if (/^[0-9a-f]{6}$/i.test(hex || "")) {
    const h = hex.toLowerCase();
    for (const base of ["https://globe.adsb.lol", "https://adsb.lol"]) {
      try {
        const r = await get(`${base}/data/traces/${h.slice(-2)}/trace_full_${h}.json`, 30);
        if (!r.ok) continue;
        const j = await r.json();
        const pts = (j.trace || []).filter((p) => num(p[1]) !== null && num(p[2]) !== null).map((p) => [p[1], p[2]]);
        if (pts.length > 1) { out.actual = thin(pts, 400); out.sources.actual = "adsb.lol"; }
        const dep = departureOf(j);
        if (dep) { out.departure = { time: dep.time, airport: dep.airport, latitude: dep.lat, longitude: dep.lon }; }
        break;
      } catch (e) { /* try next */ }
    }
  }

  // 2) The filed flight plan for the flight that is airborne right now (FlightAware AeroAPI, needs a key)
  if (env.AEROAPI_KEY) {
    try {
      const h = { "x-apikey": env.AEROAPI_KEY };
      const fa = (u) => get("https://aeroapi.flightaware.com/aeroapi" + u, 60, h);
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

  // 3) Free schedule database (adsbdb). It is keyed by callsign only, so it can describe a different
  //    leg of the same flight number. Only accept it if it agrees with where this aircraft really took off.
  if (!okA(out.origin) || !okA(out.destination)) {
    try {
      const r = await get(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(ident)}`, 600);
      if (r.ok) {
        const fr = ((await r.json()).response || {}).flightroute;
        if (fr && fr.origin && fr.destination) {
          const m = (a) => ({ icao: a.icao_code, iata: a.iata_code, name: a.name, city: a.municipality, latitude: num(a.latitude), longitude: num(a.longitude) });
          const o = m(fr.origin), d = m(fr.destination);
          out.airline = out.airline || (fr.airline && fr.airline.name) || null;
          const depIcao = out.departure && out.departure.airport && out.departure.airport.icao;
          let use = null;
          if (depIcao) { if (o.icao === depIcao) use = [o, d]; else if (d.icao === depIcao) use = [d, o]; }
          else if (pos && okA(o) && okA(d)) {
            if (plausible([o.latitude, o.longitude], [d.latitude, d.longitude], pos)) use = [o, d];
            else if (plausible([d.latitude, d.longitude], [o.latitude, o.longitude], pos)) use = [d, o];
          } else if (!pos) use = [o, d];
          if (use) { out.origin = use[0]; out.destination = use[1]; out.sources.airports = "adsbdb"; }
          else out.notes.push(`The stored schedule route (${o.iata || o.icao} to ${d.iata || d.icao}) doesn't match where this aircraft actually departed, so it was ignored.`);
        }
      }
    } catch (e) { /* ignore */ }
  }

  // 4) If we still have no origin, use the airport it really departed from
  if (!okA(out.origin) && out.departure && out.departure.airport) {
    out.origin = { icao: out.departure.airport.icao, iata: out.departure.airport.iata, name: out.departure.airport.name, city: null, latitude: out.departure.airport.latitude, longitude: out.departure.airport.longitude };
    out.sources.airports = "ADS-B departure";
  }

  if (out.actual.length < 2 && faTrack.length > 1) { out.actual = thin(faTrack, 400); out.sources.actual = "FlightAware"; }
  return out;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const u = new URL(request.url), q = u.searchParams, p = u.pathname;
    if (!p.startsWith("/api/")) return env.ASSETS.fetch(request);

    if (p === "/api/nearby-airports") {
      const lat=num(q.get("lat")),lon=num(q.get("lon"));
      if(lat===null||lon===null||Math.abs(lat)>90||Math.abs(lon)>180)return json({error:"Invalid center"},400);
      const rad=Math.PI/180;
      const distance=(a,b)=>{
        const dl=(b[1]-a[1])*rad,dp=(b[0]-a[0])*rad;
        const x=Math.sin(dp/2)**2+Math.cos(a[0]*rad)*Math.cos(b[0]*rad)*Math.sin(dl/2)**2;
        return 3440.065*2*Math.asin(Math.min(1,Math.sqrt(x)));
      };
      const csvRow=line=>{
        const result=[];let v="",quote=false;
        for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(quote&&line[i+1]==='"'){v+='"';i++}else quote=!quote}
          else if(c===","&&!quote){result.push(v);v=""}else v+=c}
        result.push(v);return result;
      };
      try{
        const result=await get("https://davidmegginson.github.io/ourairports-data/airports.csv",86400);
        if(!result.ok)throw Error("Directory HTTP "+result.status);
        const rows=(await result.text()).split(/\r?\n/),headers=csvRow(rows.shift()),index=n=>headers.indexOf(n);
        const col={id:index("ident"),gps:index("gps_code"),icao:index("icao_code"),name:index("name"),lat:index("latitude_deg"),lon:index("longitude_deg"),type:index("type"),continent:index("continent")};
        if(Object.values(col).some(i=>i<0))throw Error("Directory schema changed");
        const airports=[];
        for(const row of rows){
          if(!row||!row.includes(",NA,")&&row.indexOf("NA")<0)continue;
          const r=csvRow(row),type=r[col.type];
          if(r[col.continent]!=="NA"||!["large_airport","medium_airport","small_airport","seaplane_base"].includes(type))continue;
          const la=num(r[col.lat]),lo=num(r[col.lon]);
          if(la===null||lo===null||Math.abs(la-lat)>1.45||Math.abs(lo-lon)>2.1)continue;
          const nm=distance([lat,lon],[la,lo]);
          if(nm>75)continue;
          const id=(r[col.icao]||r[col.gps]||r[col.id]||"").toUpperCase();
          if(!/^[A-Z0-9]{3,7}$/.test(id))continue;
          airports.push({id,name:r[col.name]||id,lat:la,lon:lo,nm,type});
        }
        airports.sort((a,b)=>a.nm-b.nm);
        const dedup=new Set(),answer=[];
        for(const item of airports){
          if(dedup.has(item.id))continue;
          dedup.add(item.id);answer.push(item);
          if(answer.length===100)break;
        }
        return json({airports:answer,source:"OurAirports"},200,300);
      }catch(e){return json({error:"Nearby airport directory unavailable"},502)}
    }

    if (p === "/api/airport-lookup") {
      const code=(q.get("code")||"").trim().toUpperCase();
      if(!/^[A-Z0-9]{3,4}$/.test(code))return json({error:"Enter a valid 3- or 4-character airport identifier."},400);
      const parseAirport=a=>{
        if(!a||typeof a!=="object")return null;
        const lat=num(a.lat??a.latitude??a.latitude_deg??a.lat_deg);
        const lon=num(a.lon??a.longitude??a.longitude_deg??a.lon_deg);
        if(lat===null||lon===null||Math.abs(lat)>90||Math.abs(lon)>180)return null;
        return {code:String(a.icaoId||a.icao_code||a.gps_code||a.code||a.ident||code).toUpperCase(),name:String(a.name||a.site||code),lat,lon};
      };
      // First use the dedicated airport endpoint. It does not cover all GA/private fields.
      try {
        const up=await get("https://aviationweather.gov/api/data/airport?ids="+encodeURIComponent(code)+"&format=json",3600);
        if(up.ok){
          const payload=await up.json();
          const rows=Array.isArray(payload)?payload:[payload];
          const match=rows.find(a=>[a?.icaoId,a?.iataId,a?.ident,a?.id].some(v=>String(v||"").toUpperCase()===code));
          const airport=parseAirport(match);
          if(airport)return json(airport,200,3600);
        }
      }catch(e){ /* continue to comprehensive directory */ }

      // OurAirports is a daily refreshed open directory. Includes ICAO, IATA and local
      // identifiers for US, Canada, Mexico, Central America and the Caribbean.
      try {
        const csv=await get("https://davidmegginson.github.io/ourairports-data/airports.csv",86400);
        if(!csv.ok)throw Error("Airport directory HTTP "+csv.status);
        const body=await csv.text();
        const lines=body.split(/\r?\n/);
        const parseCSV=line=>{
          const fields=[];let current="",quoted=false;
          for(let n=0;n<line.length;n++){
            const ch=line[n];
            if(ch==='"'){if(quoted&&line[n+1]==='"'){current+='"';n++}else quoted=!quoted}
            else if(ch===","&&!quoted){fields.push(current);current=""}
            else current+=ch;
          }
          fields.push(current);return fields;
        };
        const h=parseCSV(lines[0]),at=name=>h.indexOf(name);
        const ix={ident:at("ident"),icao:at("icao_code"),gps:at("gps_code"),local:at("local_code"),iata:at("iata_code"),lat:at("latitude_deg"),lon:at("longitude_deg"),name:at("name"),continent:at("continent"),type:at("type")};
        if(Object.values(ix).some(n=>n<0))throw Error("Unexpected directory columns");
        let best=null,bestScore=-Infinity;
        for(let n=1;n<lines.length;n++){
          const line=lines[n];if(!line||!line.toUpperCase().includes(code))continue;
          const row=parseCSV(line);
          if(row[ix.continent]!=="NA"||row[ix.type]==="closed")continue;
          const ids=[row[ix.icao],row[ix.gps],row[ix.ident],row[ix.local],row[ix.iata]].map(x=>String(x||"").toUpperCase());
          const exact=ids.indexOf(code);
          if(exact<0)continue;
          const lat=num(row[ix.lat]),lon=num(row[ix.lon]);
          if(lat===null||lon===null||Math.abs(lat)>90||Math.abs(lon)>180)continue;
          const score=(5-exact)*10+({large_airport:4,medium_airport:3,small_airport:2,seaplane_base:1,heliport:0}[row[ix.type]]??0);
          if(score>bestScore){
            bestScore=score;
            best={code:ids[0]||ids[1]||ids[2]||code,name:row[ix.name]||code,lat,lon,source:"OurAirports"};
          }
        }
        if(best)return json(best,200,86400);
      }catch(e){ console.warn("OurAirports lookup unavailable",String(e)); }

      // Limited fallback; included for backwards compatibility with older clients.
      try{
        const up=await get("https://airportsapi.com/api/airports/"+encodeURIComponent(code),3600);
        if(up.ok){const airport=parseAirport(await up.json());if(airport)return json(airport,200,3600)}
      }catch(e){/* provider offline */}
      return json({error:"Airport not found or directory temporarily unavailable. Try its ICAO or FAA identifier."},404);
    }

    if (p === "/api/photo") {
      const hex = (q.get("hex") || "").trim().toLowerCase();
      const reg = (q.get("reg") || "").trim().toUpperCase();
      if (!/^[0-9a-f]{6}$/.test(hex)) return json({ error: "invalid hex" }, 400);
      const validUrl = (value) => {
        try { const u = new URL(value); return u.protocol === "https:" &&
          ["planespotters.net", "plnspttrs.net"].some(d => u.hostname === d || u.hostname.endsWith("." + d)); }
        catch { return false; }
      };
      const tries = [
        "https://api.planespotters.net/pub/photos/hex/" + hex,
        "https://api.adsb.lol/0/planespotters_net/hex/" + hex +
          (/^[A-Z0-9-]{3,12}$/.test(reg) ? "?reg=" + encodeURIComponent(reg) : ""),
        ...(/^[A-Z0-9-]{3,12}$/.test(reg) ? ["https://api.planespotters.net/pub/photos/reg/" + encodeURIComponent(reg)] : [])
      ];
      let available = false, failed = 0;
      for (const target of tries) {
        try {
          const up = await get(target, 300);
          if (!up.ok) { failed++; continue; }
          available = true;
          const data = await up.json();
          for (const ph of (data.photos || [])) {
            const src = (ph.thumbnail_large && ph.thumbnail_large.src) || (ph.thumbnail && ph.thumbnail.src);
            if (src && validUrl(src) && validUrl(ph.link))
              return json({ photo: { src, link: ph.link, by: ph.photographer || "Unknown" } }, 200, 3600);
          }
        } catch (err) { failed++; }
      }
      return json({ photo: null, reason: available ? "no_photo" : "provider_unavailable", attempted: tries.length }, 200, 120);
    }

    if (p === "/api/airports") {
      const cs = (q.get("callsign") || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 10).toUpperCase();
      if (cs.length < 3) return json({ error: "callsign required" }, 400);
      try {
        const r = await get("https://api.adsbdb.com/v0/callsign/" + encodeURIComponent(cs), 3600);
        if (r.ok) {
          const j = await r.json();
          const fr = (j.response || {}).flightroute;
          if (fr && fr.origin && fr.destination) {
            const ap = a => ({ icao:a.icao_code||null, iata:a.iata_code||null, name:a.name||null });
            return json({ origin:ap(fr.origin),destination:ap(fr.destination),source:"adsbdb" },200,3600);
          }
        }
      } catch(err) { /* flight not listed or provider offline */ }
      return json({origin:null,destination:null,source:null},200,300);
    }

    if (/\/search$/.test(p)) return json(await search(q.get("query") || ""), 200, 5);

    if (/\/plan$/.test(p)) {
      const ident = (q.get("ident") || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 10).toUpperCase();
      if (!ident) return json({ error: "ident required" }, 400);
      const la = num(q.get("lat")), lo = num(q.get("lon")), trk = num(q.get("trk"));
      let pos = null; if (la !== null && lo !== null) { pos = [la, lo]; pos.trk = trk; }
      return json(await plan(env || {}, ident, q.get("hex") || "", pos), 200, 30);
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