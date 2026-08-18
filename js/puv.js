
const $=s=>document.querySelector(s);
function active(sel,key){
 const all=[...document.querySelectorAll(sel+" button")];
 if(!all.length)return null;
 const allBtn=all.find(b=>b.dataset[key]==="TOTES");
 if(allBtn&&!allBtn.classList.contains("off"))return null;
 return new Set(all.filter(b=>!b.classList.contains("off")).map(b=>b.dataset[key]));
}
export function renderPUV(S){
 if(!S.config)return;
 const lines=active("#lineFilters","line"),uts=active("#utFilters","ut");
 let a=S.trains.filter(t=>(!lines||lines.has(t.line))&&(!uts||uts.has(t.unit.slice(0,3))));
 a.sort((x,y)=>"ADFBL".indexOf(x.circulation[0])-"ADFBL".indexOf(y.circulation[0])||x.circulation.localeCompare(y.circulation));
 draw("#ascList",a.filter(t=>t.ascending),uts);draw("#descList",a.filter(t=>!t.ascending),uts);
 $("#puvStatus").textContent=(S.lastFetch?"Actualitzat "+S.lastFetch.toLocaleTimeString("es-ES",{hour12:false}):"Esperant dades…");
}
function draw(sel,arr,uts){
 const box=$(sel);box.innerHTML="";
 if(!arr.length){let d=document.createElement("div");d.className="empty";d.textContent=uts&&uts.size===1?"ACTUALMENT NO CIRCULEN UT"+[...uts][0]:"SENSE CIRCULACIONS";box.appendChild(d);return}
 for(const t of arr){
  let d=document.createElement("div");d.className="trainrow";
  const loc=t.stationed?"Est. "+t.stationed:(t.origin&&t.dest?"direcció "+t.origin+" → "+t.dest:"En circulació");
  d.innerHTML=`<div>${t.unit}</div><div>${t.circulation}</div><div class="where">${loc}${t.dest&&!loc.includes("→")?" → "+t.dest:""}</div>`;
  if(t.line==="L7"&&!t.unit.startsWith("114."))d.classList.add("alert");
  box.appendChild(d);
 }
}
