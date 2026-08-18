import {getTripBundle} from "./gtfs.js?v=3.0.0";
const $=s=>document.querySelector(s);

function hhmm(s){
  if(!s)return" --:--";
  const [hh,mm]=String(s).split(":");
  const h=Number(hh)%24;
  return (h<10?" ":"")+h+":"+mm;
}
function parentCode(stopId){
  return String(stopId||"").replace(/\d+$/,"");
}
function segData(S,a,b){
  const list=S.network.segments||[];
  return list.find(x=>(x.from===a&&x.to===b)||(x.from===b&&x.to===a))||null;
}
export async function loadLIT(S,circ){
  if(!circ)return;
  const live=S.trains.find(t=>t.circulation===circ);
  S.selected={circulation:circ,live,stops:[]};
  $("#utTop").textContent=live?.unit||"---.--";

  if(!live?.id){
    $("#litStatus").textContent="Circulació no activa";
    $("#litRoute").innerHTML='<div class="empty">No s’ha trobat aquesta circulació activa.</div>';
    return;
  }
  $("#litStatus").textContent="Carregant "+circ+"…";
  try{
    const bundle=await getTripBundle(S.config.gtfsZipIndexUrl,live.id);
    S.selected.trip=bundle.trip;
    S.selected.stops=bundle.times;
    render(S);
    $("#litStatus").textContent=circ+" · "+bundle.times.length+" parades";
    updateCurrent(S,true);
  }catch(e){
    S.lastError=String(e);
    $("#litStatus").textContent="ERROR LIT";
    $("#litRoute").innerHTML='<div class="empty">'+String(e.message||e)+'</div>';
  }
}
function render(S){
  const box=$("#litRoute");box.innerHTML="";
  const st=S.selected.stops;
  st.forEach((s,i)=>{
    const row=document.createElement("div");
    row.className="lit-row";row.dataset.i=i;row.dataset.code=parentCode(s.stop_id);
    row.innerHTML=`<div class="pointer"></div><div class="time">${hhmm(s.arrival_time)}</div><div>${s.stop_name}</div><div class="count"></div>`;
    box.appendChild(row);

    if(i<st.length-1){
      const a=parentCode(s.stop_id),b=parentCode(st[i+1].stop_id),seg=segData(S,a,b);
      const inter=document.createElement("div");inter.className="inter";
      let txt="";
      if(seg?.grade)txt+=seg.grade;
      if(seg?.length)txt+=(txt?"   ":"")+seg.length;
      if(seg?.technical?.length)txt+=(txt?"   ":"")+seg.technical.join(" · ");
      inter.innerHTML=`<div></div><div></div><div class="technical">${txt}</div><div></div>`;
      box.appendChild(inter);
      const sep=document.createElement("div");sep.className="separator";box.appendChild(sep);
    }
  });
}
function firstNextCode(next){
  if(!next)return null;
  const m=String(next).match(/"parada"\s*:\s*"([^"]+)"/);
  return m?m[1]:null;
}
function currentIndex(S){
  const st=S.selected?.stops||[],live=S.selected?.live;
  if(!st.length)return 0;
  if(live?.stationed){
    const ix=st.findIndex(x=>parentCode(x.stop_id)===String(live.stationed));
    if(ix>=0)return ix;
  }
  const n=firstNextCode(live?.next);
  if(n){
    const ix=st.findIndex(x=>parentCode(x.stop_id)===n);
    if(ix>0)return ix-1; // entre estación anterior y próxima
    if(ix===0)return 0;
  }
  return 0;
}
function secondsTo(time){
  if(!time)return null;
  const [h,m,s="0"]=String(time).split(":").map(Number),now=new Date(),t=new Date(now);
  t.setHours(h%24,m,s,0);
  let d=Math.floor((t-now)/1000);
  if(d<-43200)d+=86400;
  if(d>43200)d-=86400;
  return d;
}
export function updateCurrent(S,forceScroll=false){
  if(!S.selected?.stops?.length)return;
  const live=S.trains.find(t=>t.circulation===S.selected.circulation);
  if(live)S.selected.live=live;
  const idx=currentIndex(S);
  document.querySelectorAll(".lit-row").forEach((r,i)=>{
    r.classList.toggle("current",i===idx);
    r.querySelector(".pointer").textContent=i===idx?"▷":"";
  });
  const row=document.querySelector(`.lit-row[data-i="${idx}"]`);
  if(row&&(forceScroll||S.selected.lastIndex!==idx)){
    row.scrollIntoView({block:"center",behavior:"smooth"});
    S.selected.lastIndex=idx;
  }
  const stop=S.selected.stops[idx],count=row?.querySelector(".count"),d=secondsTo(stop?.arrival_time);
  if(!count||d===null)return;
  count.className="count";
  if(d>=0&&d<=59){
    count.textContent="0:"+String(d).padStart(2,"0");
    if(d<=9)count.classList.add("red");
  }else if(d<0&&d>-3600){
    count.textContent="0:00";count.classList.add("blink");
  }else count.textContent="";
}
export function tickLIT(S){updateCurrent(S,false)}