const $=s=>document.querySelector(s);
function active(sel,key){
  const all=[...document.querySelectorAll(sel+" button")];
  const allBtn=all.find(b=>b.dataset[key]==="TOTES");
  if(allBtn&&!allBtn.classList.contains("off"))return null;
  return new Set(all.filter(b=>!b.classList.contains("off")).map(b=>b.dataset[key]));
}
export function renderPUV(S){
  if(!S.config)return;
  const lines=active("#lineFilters","line"),uts=active("#utFilters","ut");
  let rows=S.trains.filter(t=>(!lines||lines.has(t.line))&&(!uts||uts.has(t.unit.slice(0,3))));
  rows.sort((a,b)=>{
    const ia="ADFBL".indexOf(a.circulation[0]),ib="ADFBL".indexOf(b.circulation[0]);
    return ia-ib||a.circulation.localeCompare(b.circulation);
  });
  draw("#ascList",rows.filter(t=>t.ascending),uts);
  draw("#descList",rows.filter(t=>!t.ascending),uts);
  const tm=S.lastFetch?S.lastFetch.toLocaleTimeString("es-ES",{hour12:false}):"—";
  $("#puvStatus").textContent="Actualitzat "+tm+" · "+S.trains.length+" BV";
}
function draw(sel,arr,uts){
  const box=$(sel);box.innerHTML="";
  if(!arr.length){
    const d=document.createElement("div");d.className="empty";
    d.textContent=uts&&uts.size===1?"ACTUALMENT NO CIRCULEN UT"+[...uts][0]:"SENSE CIRCULACIONS";
    box.appendChild(d);return;
  }
  for(const t of arr){
    const d=document.createElement("div");d.className="trainrow";
    let loc;
    if(t.stationed) loc="Est. "+t.stationed+(t.dest?" → "+t.dest:"");
    else if(t.origin&&t.dest) loc="direcció "+t.origin+" → "+t.dest;
    else loc="En circulació"+(t.dest?" → "+t.dest:"");
    d.innerHTML=`<div>${t.unit}</div><div>${t.circulation}</div><div class="where">${loc}</div>`;
    if(t.line==="L7"&&!t.unit.startsWith("114."))d.classList.add("alert");
    box.appendChild(d);
  }
}