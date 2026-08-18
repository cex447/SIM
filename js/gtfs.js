let CACHE=null;

function parseCSVLine(line){
  const out=[];let cur="",q=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch==='"'){
      if(q&&line[i+1]==='"'){cur+='"';i++}else q=!q;
    }else if(ch===','&&!q){out.push(cur);cur=""}else cur+=ch;
  }
  out.push(cur);return out;
}
function csvHeader(text){
  const first=text.split(/\r?\n/,1)[0];
  return parseCSVLine(first);
}
function rowObj(header,line){
  const vals=parseCSVLine(line),o={};
  header.forEach((h,i)=>o[h]=vals[i]??"");
  return o;
}
export async function loadGtfsFileIndex(url){
  if(CACHE?.index)return CACHE.index;
  const r=await fetch(url+"&_ts="+Date.now(),{cache:"no-store"});
  if(!r.ok)throw new Error("GTFS index HTTP "+r.status);
  const j=await r.json();
  const index={};
  for(const rec of j.results||[]){
    const f=rec.file;if(f?.filename&&f?.url)index[f.filename]=f.url;
  }
  CACHE={...(CACHE||{}),index};
  return index;
}
async function textFile(indexUrl,name){
  const idx=await loadGtfsFileIndex(indexUrl);
  if(!idx[name])throw new Error("No existe "+name);
  if(CACHE?.[name])return CACHE[name];
  const r=await fetch(idx[name]+(idx[name].includes("?")?"&":"?")+"_ts="+Date.now(),{cache:"no-store"});
  if(!r.ok)throw new Error(name+" HTTP "+r.status);
  const t=await r.text();CACHE[name]=t;return t;
}
export async function getTripBundle(indexUrl,tripId){
  const [tripsText,stText,stopsText]=await Promise.all([
    textFile(indexUrl,"trips.txt"),
    textFile(indexUrl,"stop_times.txt"),
    textFile(indexUrl,"stops.txt")
  ]);

  const tripHead=csvHeader(tripsText);
  const tripLines=tripsText.split(/\r?\n/).slice(1);
  let trip=null;
  for(const l of tripLines){
    if(l.includes(tripId)){const o=rowObj(tripHead,l);if(o.trip_id===tripId){trip=o;break}}
  }
  if(!trip)throw new Error("trip_id no trobat a trips.txt");

  const stopHead=csvHeader(stText);
  const stopLines=stText.split(/\r?\n/).slice(1);
  const times=[];
  for(const l of stopLines){
    if(l.includes(tripId)){
      const o=rowObj(stopHead,l);
      if(o.trip_id===tripId)times.push(o);
    }
  }
  times.sort((a,b)=>Number(a.stop_sequence)-Number(b.stop_sequence));

  const stopsHead=csvHeader(stopsText);
  const stopMap=new Map();
  for(const l of stopsText.split(/\r?\n/).slice(1)){
    if(!l)continue;const o=rowObj(stopsHead,l);
    if(o.location_type==="1"||(!o.parent_station&&o.stop_id))stopMap.set(o.stop_id,o.stop_name);
  }

  return {trip,times:times.map(x=>({...x,stop_name:stopMap.get(x.stop_id)||x.stop_id}))};
}