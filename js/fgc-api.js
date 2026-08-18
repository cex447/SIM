export async function fetchPositioning(url){
  const r=await fetch(url,{cache:"no-store"});
  if(!r.ok) throw new Error("HTTP "+r.status);
  const j=await r.json();
  return j.results||[];
}

export function decodeCirculation(id){
  const s=String(id||"");
  const tail=s.includes("|")?s.split("|").pop():s;
  const family={"6f2":"A","6c2":"B","622":"L","6a2":"D","682":"F"}[tail.slice(0,3)];
  if(!family)return null;
  const a={"7e":"0","6e":"1","5e":"2","4e":"3","3e":"4","2e":"5","0e":"7"}[tail.slice(5,7)];
  const b={"30":"0","20":"1","10":"2","00":"3","70":"4","60":"5","50":"6","40":"7","b0":"8","a0":"9"}[tail.slice(7,9)];
  const c={"2":"0","3":"1","0":"2","1":"3","6":"4","7":"5","4":"6","5":"7","a":"8","b":"9"}[tail.slice(9,10)];
  return (a!==undefined&&b!==undefined&&c!==undefined)?family+a+b+c:null;
}

export function decodeUnit(ud){
  const s=String(ud||"");
  if(!s.startsWith("1f2cc"))return null;
  const series={"5":"112","4":"113","3":"114","2":"115"}[s[5]];
  const a={"02":"0","03":"1","00":"2","01":"3"}[s.slice(8,10)];
  const b={"74":"0","75":"1","76":"2","77":"3","70":"4","71":"5","72":"6","73":"7","7c":"8","7d":"9"}[s.slice(10,12)];
  return series&&a!==undefined&&b!==undefined?series+"."+a+b:null;
}

function get(r,...names){
  for(const n of names){
    if(r[n]!==undefined&&r[n]!==null&&r[n]!=="") return r[n];
  }
  return null;
}

export function normalizeTrain(r,cfg){
  const id=String(get(r,"id","trip_id")||"");
  const ud=String(get(r,"ud","vehicle_id")||"");

  /* Importante:
     el service_id cambia según el tipo de servicio/versión del GTFS.
     Solo exigimos la familia BV estable 6c4bdae..., no un service_id concreto. */
  if(!id.startsWith(cfg.idPrefix)) return null;
  if(!ud.startsWith(cfg.udPrefix)) return null;

  const circulation=decodeCirculation(id);
  const unit=decodeUnit(ud);
  if(!circulation||!unit)return null;

  const line=String(get(r,"lin","linia","linea","route_short_name")||"");
  const stationed=get(r,"estacionat_a","estacionado_en");
  const next=get(r,"properes_parades","proximas_paradas");
  const origin=get(r,"origen");
  const dest=get(r,"desti","destino");

  const whereText=stationed ? "Est. "+stationed : "En circulació";

  return {
    raw:r,id,ud,circulation,unit,line,origin,dest,
    stationed,next,whereText,
    ascending:Number(circulation.slice(-1))%2===1
  };
}
