export default {
 async fetch(request, env) {
  const url=new URL(request.url);
  if(url.pathname==="/api/traffic-debug"){
   const sources=[["adsb.fi","https://opendata.adsb.fi/api/v3/lat/43.5728/lon/-71.4601/dist/100"],["aviationweather","https://aviationweather.gov/api/data/metar?ids=KLCI&format=json"]];
   const results=[];
   for(const [name,target] of sources){
    const start=Date.now();
    try{const response=await fetch(target,{headers:{"accept":"application/json"},signal:AbortSignal.timeout(8000)});const body=await response.text();results.push({source:name,status:response.status,elapsed_ms:Date.now()-start,bytes:body.length,preview:body.slice(0,160)});}
    catch(e){results.push({source:name,error:String(e),elapsed_ms:Date.now()-start});}
   }
   return Response.json({results},{headers:{"cache-control":"no-store"}});
  }
  if(url.pathname==="/api/adsblol-debug"){
   const target="https://api.adsb.lol/v2/point/43.5728/-71.4601/100";
   const started=Date.now();
   try{
    const response=await fetch(target,{headers:{"accept":"application/json","user-agent":"FlightDisplay/1.0 (+https://flight.whitetherouxvault.com; personal aviation display)"} ,signal:AbortSignal.timeout(10000)});
    const body=await response.text();
    let count=null;try{const parsed=JSON.parse(body);count=(parsed.ac||parsed.aircraft||[]).length}catch(e){}
    return Response.json({provider:"adsb.lol",status:response.status,elapsed_ms:Date.now()-started,bytes:body.length,aircraft_count:count,preview:body.slice(0,160)},{headers:{"cache-control":"no-store"}});
   }catch(e){return Response.json({provider:"adsb.lol",error:String(e),elapsed_ms:Date.now()-started},{headers:{"cache-control":"no-store"}});}
  }
  if(url.pathname==="/api/traffic"){
   const p=url.searchParams;
   const lat=((Number(p.get("lamin"))+Number(p.get("lamax")))/2)||43.5728;
   const lon=((Number(p.get("lomin"))+Number(p.get("lomax")))/2)||-71.4601;
   const normalize=a=>[a.hex||"",a.flight||a.r||"",null,null,null,a.lon,a.lat,typeof a.alt_baro==="number"?a.alt_baro/3.28084:null,a.alt_baro==="ground",typeof a.gs==="number"?a.gs/1.94384:null,a.track||0,null,null,null,null,null,null];
   const attempts=[];
   for(const src of [
    ["adsb.fi","https://opendata.adsb.fi/api/v3/lat/"+lat+"/lon/"+lon+"/dist/100"],
    ["airplanes.live","https://api.airplanes.live/v2/point/"+lat+"/"+lon+"/100"],
    ["adsb.lol","https://api.adsb.lol/v2/point/"+lat+"/"+lon+"/100"]
   ]){
    try{
     const x=await fetch(src[1],{headers:{"accept":"application/json"}});
     attempts.push(src[0]+":"+x.status);
     if(!x.ok) continue;
     const d=await x.json();
     const raw=d.ac||d.aircraft||[];
     const states=raw.filter(a=>a.lat!=null&&a.lon!=null).map(normalize);
     return Response.json({time:Math.floor(Date.now()/1000),states,source:src[0],attempts},{headers:{"cache-control":"public,max-age=5"}});
    }catch(e){attempts.push(src[0]+":fetch-failed")}
   }
   return Response.json({states:[],error:"all traffic sources failed",attempts},{status:502});
  }
  if(url.pathname==="/api/weather"){
   const ids=(url.searchParams.get("ids")||"KLCI").toUpperCase().replace(/[^A-Z0-9,]/g,"");
   try{const x=await fetch("https://aviationweather.gov/api/data/metar?ids="+ids+"&format=json");
    return new Response(await x.text(),{status:x.status,headers:{"content-type":"application/json","cache-control":"public,max-age=60"}});
   }catch(e){return Response.json({error:"weather unavailable"},{status:502})}
  }
  return env.ASSETS.fetch(request);
 }
}