export default {
 async fetch(request, env) {
  const url=new URL(request.url);
  if(url.pathname==="/api/traffic"){
   const p=url.searchParams;
   const lat=((Number(p.get("lamin"))+Number(p.get("lamax")))/2)||43.5728;
   const lon=((Number(p.get("lomin"))+Number(p.get("lomax")))/2)||-71.4601;
   try{
    const x=await fetch("https://api.adsb.lol/v2/lat/"+lat+"/lon/"+lon+"/dist/100");
    if(!x.ok) throw new Error("ADSB "+x.status);
    const d=await x.json();
    const states=(d.ac||[]).filter(a=>a.lat!=null&&a.lon!=null).map(a=>[
      a.hex||"",a.flight||a.r||"",null,null,null,a.lon,a.lat,
      typeof a.alt_baro==="number"?a.alt_baro/3.28084:null,
      a.alt_baro==="ground",
      typeof a.gs==="number"?a.gs/1.94384:null,
      a.track||0,null,null,null,null,null,null
    ]);
    return Response.json({time:Math.floor(Date.now()/1000),states,source:"adsb.lol"},{headers:{"cache-control":"public,max-age=5"}});
   }catch(e){
    return Response.json({states:[],error:String(e),source:"adsb.lol"},{status:502});
   }
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