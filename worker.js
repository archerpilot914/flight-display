export default {
 async fetch(request, env) {
  const url=new URL(request.url);
  if(url.pathname==="/api/traffic"){
   const p=url.searchParams;
   const q=new URLSearchParams({lamin:p.get("lamin")||"42.7",lomin:p.get("lomin")||"-72.5",lamax:p.get("lamax")||"44.5",lomax:p.get("lomax")||"-70.3"});
   try{const x=await fetch("https://opensky-network.org/api/states/all?"+q,{headers:{"User-Agent":"FlightDisplay/2.0"}});
    return new Response(await x.text(),{status:x.status,headers:{"content-type":"application/json","cache-control":"public,max-age=10"}});
   }catch(e){return Response.json({states:[],error:"traffic unavailable"},{status:502})}
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