let openskyToken="",openskyTokenExpiresAt=0;
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
  if(url.pathname==="/api/opensky-diagnostic"){
   const started=Date.now();
   const target="https://opensky-network.org/api/states/all?lamin=43.2&lamax=43.8&lomin=-71.9&lomax=-71.0";
   try{
    const response=await fetch(target,{headers:{"accept":"application/json"},signal:AbortSignal.timeout(20000)});
    const raw=await response.text();
    let count=null;try{count=JSON.parse(raw).states?.length??null}catch(e){}
    return Response.json({provider:"OpenSky",http_status:response.status,elapsed_ms:Date.now()-started,aircraft_count:count,content_type:response.headers.get("content-type"),preview:response.ok?null:raw.slice(0,180)},{headers:{"cache-control":"no-store"}});
   }catch(e){return Response.json({provider:"OpenSky",error:String(e),elapsed_ms:Date.now()-started},{headers:{"cache-control":"no-store"}})}
  }
  if(url.pathname==="/api/traffic"){
   // OpenSky trial. The map center (not a fixed NH location) controls the coverage.
   const p=url.searchParams;
   const numbers=["lamin","lamax","lomin","lomax"].map(key=>Number(p.get(key)));
   if(numbers.some(v=>!Number.isFinite(v))||numbers[0]<-90||numbers[1]>90||numbers[2]<-180||numbers[3]>180||numbers[0]>=numbers[1]||numbers[2]>=numbers[3]){
    return Response.json({error:"Invalid geographic bounds",source:"OpenSky"},{status:400});
   }
   // Quantize center to a half-degree grid so map movements reuse cached responses.
   const centerLat=Math.round(((numbers[0]+numbers[1])/2)*2)/2;
   const centerLon=Math.round(((numbers[2]+numbers[3])/2)*2)/2;
   const lowerLat=Math.max(-90,centerLat-1.25),upperLat=Math.min(90,centerLat+1.25);
   const lowerLon=Math.max(-180,centerLon-1.75),upperLon=Math.min(180,centerLon+1.75);
   const authorized=Boolean(env.OPENSKY_CLIENT_ID&&env.OPENSKY_CLIENT_SECRET);
   // Anonymous 400-credit allowance: at most 288 requests/day per cached area.
   const ttl=authorized?60:300;
   const cacheKey=new Request(url.origin+"/api/traffic-cache?lat="+centerLat+"&lon="+centerLon+"&auth="+Number(authorized));
   const store=caches.default;
   const cached=await store.match(cacheKey);
   if(cached)return cached;
   const apiUrl=new URL("https://opensky-network.org/api/states/all");
   for(const [key,value] of [["lamin",lowerLat],["lamax",upperLat],["lomin",lowerLon],["lomax",upperLon]])apiUrl.searchParams.set(key,String(value));
   const headers={"accept":"application/json"};
   try{
    if(authorized){
     if(!openskyToken||Date.now()>openskyTokenExpiresAt){
      const form=new URLSearchParams({grant_type:"client_credentials",client_id:env.OPENSKY_CLIENT_ID,client_secret:env.OPENSKY_CLIENT_SECRET});
      const tokenResponse=await fetch("https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:form.toString(),signal:AbortSignal.timeout(10000)});
      if(!tokenResponse.ok)throw Error("OpenSky OAuth token request HTTP "+tokenResponse.status);
      const token=await tokenResponse.json();
      if(!token.access_token)throw Error("OpenSky OAuth token was missing");
      openskyToken=token.access_token;
      openskyTokenExpiresAt=Date.now()+Math.max(60,Number(token.expires_in||1800)-90)*1000;
     }
     headers.authorization="Bearer "+openskyToken;
    }
    const response=await fetch(apiUrl.toString(),{headers,signal:AbortSignal.timeout(12000)});
    if(!response.ok){
     if(response.status===401)openskyToken="";
     const error=response.status===403?"OpenSky denied requests from this server":response.status===429?"OpenSky rate limit reached":"OpenSky HTTP "+response.status;
     const denied=Response.json({source:"OpenSky",error,upstream_status:response.status,retry_after:response.headers.get("x-rate-limit-retry-after-seconds")||response.headers.get("retry-after")||null,authenticated:authorized,states:[]},{status:response.status===429?429:502,headers:{"cache-control":"public,max-age=60"}});
     await store.put(cacheKey,denied.clone());
     return denied;
    }
    const data=await response.json();
    if(!Array.isArray(data.states))throw Error("OpenSky did not return an aircraft states array");
    const states=data.states.filter(a=>Array.isArray(a)&&Number.isFinite(a[5])&&Number.isFinite(a[6]));
    const output=Response.json({source:"OpenSky",authenticated:authorized,time:data.time||null,states,checked_at:new Date().toISOString(),refresh_seconds:ttl,coverage_center:[centerLon,centerLat],credits_remaining:response.headers.get("x-rate-limit-remaining")},{headers:{"cache-control":"public,max-age="+ttl}});
    await store.put(cacheKey,output.clone());
    return output;
   }catch(error){
    const unavailable=Response.json({source:"OpenSky",error:String(error),states:[]},{status:502,headers:{"cache-control":"public,max-age=60"}});
    await store.put(cacheKey,unavailable.clone());
    return unavailable;
   }
  }
  if(url.pathname==="/api/airspace"){
   const raw=(url.searchParams.get("bbox")||"-74,41,-69,45").split(",").map(Number);
   if(raw.length!==4||raw.some(x=>!Number.isFinite(x))||raw[0]>=raw[2]||raw[1]>=raw[3]||raw[2]-raw[0]>12||raw[3]-raw[1]>10)return Response.json({error:"Invalid map bounds"},{status:400});
   const q=new URL("https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Class_Airspace/FeatureServer/0/query");
   const includeE=url.searchParams.get("classE")==="1";
   q.searchParams.set("where",includeE?"CLASS IN ('B','C','D','E')":"CLASS IN ('B','C','D')");
   q.searchParams.set("geometry",raw.join(","));q.searchParams.set("geometryType","esriGeometryEnvelope");q.searchParams.set("inSR","4326");q.searchParams.set("spatialRel","esriSpatialRelIntersects");q.searchParams.set("outFields","CLASS,NAME,LOWER_DESC,UPPER_DESC,LOWER_VAL,UPPER_VAL,LOWER_UOM,UPPER_UOM");
   q.searchParams.set("returnGeometry","true");q.searchParams.set("outSR","4326");q.searchParams.set("f","geojson");q.searchParams.set("resultRecordCount","2000");
   try{const response=await fetch(q.toString(),{headers:{"accept":"application/geo+json"},signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw Error("FAA service HTTP "+response.status);
    const data=await response.json();if(data.error||!Array.isArray(data.features))throw Error("FAA service returned invalid data");
    data.metadata={source:"FAA AIS Class Airspace ArcGIS",effective:"Sep 03–Oct 29, 2026",checked:new Date().toISOString(),limited:data.features.length>=2000};
    return Response.json(data,{headers:{"cache-control":"public,max-age=1800"}});
   }catch(e){return Response.json({error:"FAA airspace service unavailable",detail:String(e)},{status:502})}
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