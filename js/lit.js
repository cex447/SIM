
const $=s=>document.querySelector(s);
const aliases={"PLAÇA CATALUNYA":"PC","PROVENÇA":"PR","GRÀCIA":"GR","PL. MOLINA":"PM","PADUA":"PD","EL PUTXET":"EP","AV. TIBIDABO":"TB","SANT GERVASI":"SG","MUNTANER":"MN","LA BONANOVA":"BN","LES TRES TORRES":"TT","SARRIÀ":"SR","PEU DEL FUNICULAR":"PF","VALLVIDRERA SUPERIOR":"VL","LES PLANES":"LP","LA FLORESTA":"LF","VALLDOREIX":"VD","SANT CUGAT":"SC","MIRA-SOL":"MS"};
function code(n){let u=String(n||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase();for(const [k,v] of Object.entries(aliases))if(u.includes(k.normalize("NFD").replace(/[\u0300-\u036f]/g,"")))return v;return null}
function hhmm(s){if(!s)return"  --:--";let [h,m]=String(s).split(":");h=String(Number(h)%24);return (h.length===1?" ":"")+h+":"+m}
export async function loadLIT(S,circ){
 if(!circ)return;
 const live=S.trains.find(t=>t.circulation===circ);
 S.selected={circulation:circ,live,stops:[]};$("#utTop").textContent=live?.unit||"---.--";$("#litStatus").textContent="Carregant "+circ+"…";
 try{
  // Beta: intenta obtenir el viatge del dataset "viajes-de-hoy" per trip_id.
  // Si el portal canvia l'esquema, el diagnòstic deixa visible el problema sense falsejar l'itinerari.
  const base=S.config.todayTripsUrl;
  let rows=[],offset=0;
  for(let i=0;i<20;i++){
    const u=base+(base.includes("?")?"&":"?")+"offset="+offset;
    const r=await fetch(u,{cache:"no-store"});if(!r.ok)throw new Error("HTTP "+r.status);
    const j=await r.json(),part=j.results||[];rows.push(...part);if(part.length<100)break;offset+=100;
  }
  const id=live?.id;
  let matches=rows.filter(r=>id && String(r.trip_id??r.id??"")===id);
  if(!matches.length){
    matches=rows.filter(r=>String(r.circulacion??r.circulation??r.trip_short_name??"").toUpperCase()===circ);
  }
  matches.sort((a,b)=>(Number(a.stop_sequence??0)-Number(b.stop_sequence??0)));
  S.selected.stops=matches.map(r=>({name:r.stop_name??r.parada??r.estacion??r.nom_parada??"?",time:r.arrival_time??r.hora_llegada??r.hora??"",seq:r.stop_sequence??0}));
  if(!S.selected.stops.length)throw new Error("Itinerari no trobat a viajes-de-hoy");
  render(S);$("#litStatus").textContent=circ+" · "+S.selected.stops.length+" parades";
 }catch(e){$("#litStatus").textContent="Sense itinerari: "+e.message;$("#litRoute").innerHTML='<div class="empty">No es mostren dades inventades. Consulta DIAGNÒSTIC.</div>'}
}
function render(S){
 const box=$("#litRoute");box.innerHTML="";const stops=S.selected.stops;
 stops.forEach((s,i)=>{
  const row=document.createElement("div");row.className="lit-row";row.dataset.i=i;
  row.innerHTML=`<div class="pointer"></div><div class="time">${hhmm(s.time)}</div><div>${s.name}</div><div class="count"></div>`;box.appendChild(row);
  if(i<stops.length-1){
   const a=code(s.name),b=code(stops[i+1].name),x=(a&&b)?S.interstations[a+">"+b]||S.interstations[b+">"+a]:null;
   const inter=document.createElement("div");inter.className="inter";
   inter.innerHTML=`<div></div><div></div><div class="technical">${x?x.grade+"  "+x.length:""}</div><div></div>`;box.appendChild(inter);
   const sep=document.createElement("div");sep.className="separator";box.appendChild(sep);
  }
 });
}
export function tickLIT(S){
 if(!S.selected?.stops?.length)return;
 const live=S.selected.live;let idx=0;
 if(live?.stationed){const needle=String(live.stationed).toUpperCase();const f=S.selected.stops.findIndex(s=>String(s.name).toUpperCase().includes(needle));if(f>=0)idx=f}
 document.querySelectorAll(".lit-row").forEach((r,i)=>{r.classList.toggle("current",i===idx);r.querySelector(".pointer").textContent=i===idx?"▷":""});
 const row=document.querySelector(`.lit-row[data-i="${idx}"]`);if(row&&!row.dataset.seen){row.dataset.seen="1";row.scrollIntoView({block:"center",behavior:"smooth"})}
 const s=S.selected.stops[idx],count=row?.querySelector(".count");if(!count||!s.time)return;
 const [h,m,sec="0"]=String(s.time).split(":").map(Number),now=new Date(),target=new Date(now);target.setHours(h%24,m,sec,0);let d=Math.floor((target-now)/1000);
 count.className="count";if(d>=0&&d<=59){count.textContent="0:"+String(d).padStart(2,"0");if(d<=9)count.classList.add("red")}else if(d<0&&d>-3600){count.textContent="0:00";count.classList.add("blink")}else count.textContent="";
}
