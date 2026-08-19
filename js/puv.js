/*
 * SIM+ Beta 3.3 — PUV.
 * DOM incremental: las filas existentes se actualizan, no se recrea el panel.
 */

const FAMILY_ORDER=["A","D","F","B","L"];
const LINE_BY_FAMILY={A:"L6",D:"S1",F:"S2",B:"L7",L:"L12"};
const familyRank=new Map(FAMILY_ORDER.map((x,i)=>[x,i]));

const nodes=new Map();
const groups=new Map();

function make(tag,className,text){
  const n=document.createElement(tag);
  if(className)n.className=className;
  if(text!==undefined)n.textContent=text;
  return n;
}

function unitNumber(unit){
  const m=String(unit||"").match(/^(\d{3})\.(\d{2})$/);
  return m?Number(m[1])*100+Number(m[2]):999999;
}

function sortTrains(a,b){
  return (familyRank.get(a.family)-familyRank.get(b.family))
    ||(unitNumber(a.unit)-unitNumber(b.unit))
    ||a.circulation.localeCompare(b.circulation,"es",{numeric:true});
}

function passes(S,t){
  const f=S.puvFilters;
  if(f.lines.size&&!f.lines.has(t.family))return false;
  if(f.units.size&&!f.units.has(t.unit.slice(0,3)))return false;
  return true;
}

function syncButtons(S){
  document.querySelectorAll("[data-family]").forEach(b=>{
    const on=!S.puvFilters.lines.size||S.puvFilters.lines.has(b.dataset.family);
    b.classList.toggle("selected",on);
    b.classList.toggle("dimmed",!on);
    b.setAttribute("aria-pressed",String(on));
  });

  document.querySelectorAll("[data-series]").forEach(b=>{
    const on=!S.puvFilters.units.size||S.puvFilters.units.has(b.dataset.series);
    b.classList.toggle("selected",on);
    b.classList.toggle("dimmed",!on);
    b.setAttribute("aria-pressed",String(on));
  });
}

function lineButton(S,family){
  const line=LINE_BY_FAMILY[family];
  const b=make("button","line-filter selected");
  b.type="button";
  b.dataset.family=family;
  b.setAttribute("aria-pressed","true");

  const img=document.createElement("img");
  img.src=S.config.lineAssets?.[line]||"";
  img.alt=line;
  img.decoding="async";

  const fallback=make("span","line-fallback",line);
  b.append(img,fallback);

  img.addEventListener("error",()=>{
    img.hidden=true;
    fallback.hidden=false;
  });
  fallback.hidden=true;

  b.addEventListener("click",()=>{
    const set=S.puvFilters.lines;

    if(!set.size){
      set.add(family);
    }else if(set.has(family)){
      set.delete(family);
    }else{
      set.add(family);
    }

    if(set.size===FAMILY_ORDER.length)set.clear();

    syncButtons(S);
    renderPUV(S);
  });

  return b;
}

function unitButton(S,series){
  const b=make("button","ut-filter selected",series);
  b.type="button";
  b.dataset.series=series;
  b.setAttribute("aria-pressed","true");

  b.addEventListener("click",()=>{
    const set=S.puvFilters.units;

    if(!set.size){
      set.add(series);
    }else if(set.has(series)){
      set.delete(series);
    }else{
      set.add(series);
    }

    if(set.size===S.config.allowedUnitSeries.length)set.clear();

    syncButtons(S);
    renderPUV(S);
  });

  return b;
}

export function wirePUV(S){
  const lineBox=document.querySelector("#lineFilters");
  const unitBox=document.querySelector("#utFilters");

  lineBox.replaceChildren(...FAMILY_ORDER.map(f=>lineButton(S,f)));
  unitBox.replaceChildren(...S.config.allowedUnitSeries.map(s=>unitButton(S,s)));

  document.querySelector("#clearPuvFilters").addEventListener("click",()=>{
    S.puvFilters.lines.clear();
    S.puvFilters.units.clear();
    syncButtons(S);
    renderPUV(S);
  });

  syncButtons(S);
}

function groupKey(direction,family){
  return `${direction}:${family}`;
}

function ensureGroup(S,direction,family){
  const key=groupKey(direction,family);
  if(groups.has(key))return groups.get(key);

  const host=document.querySelector(direction==="asc"?"#ascList":"#descList");
  const section=make("section","puv-line-group");
  const heading=make("div","puv-line-heading");
  const rows=make("div","puv-line-rows");

  const line=LINE_BY_FAMILY[family];
  const img=document.createElement("img");
  img.src=S.config.lineAssets?.[line]||"";
  img.alt=line;
  img.decoding="async";

  const fallback=make("span","puv-line-fallback",line);
  fallback.hidden=true;

  img.addEventListener("error",()=>{
    img.hidden=true;
    fallback.hidden=false;
  });

  heading.append(img,fallback);
  section.append(heading,rows);
  host.appendChild(section);

  const model={section,rows};
  groups.set(key,model);
  return model;
}

function keyFor(direction,t){
  return `${direction}:${t.id}`;
}

function ensureRow(direction,t){
  const key=keyFor(direction,t);
  if(nodes.has(key))return nodes.get(key);

  const row=make("div","trainrow");
  const unit=make("span","train-unit");
  const circulation=make("span","train-circulation");
  const where=make("span","train-where");

  row.append(unit,circulation,where);

  const model={row,unit,circulation,where,last:""};
  nodes.set(key,model);
  return model;
}

function fingerprint(t){
  return [
    t.unit,
    t.circulation,
    t.stationed||"",
    t.nextStop||"",
    t.destination||"",
    t.onTime===null?"?":String(t.onTime)
  ].join("|");
}

function updateRow(model,t){
  const fp=fingerprint(t);
  if(model.last===fp)return;
  model.last=fp;

  model.unit.textContent=t.unit;
  model.circulation.textContent=t.circulation;

  model.row.classList.toggle("delayed",t.onTime===false);
  model.row.classList.toggle("is-stationed",Boolean(t.stationed));

  model.where.replaceChildren();

  if(t.stationed){
    model.where.append(
      document.createTextNode("estacionat "),
      make("span","train-station",t.stationed),
      document.createTextNode(` → ${t.destination||"—"}`)
    );
  }else{
    model.where.textContent=
      `direcció ${t.nextStop||"—"} → ${t.destination||"—"}`;
  }
}

function reconcile(S,direction,trains){
  const byFamily=new Map(FAMILY_ORDER.map(f=>[f,[]]));
  for(const t of trains)byFamily.get(t.family)?.push(t);

  const active=new Set();

  for(const family of FAMILY_ORDER){
    const arr=byFamily.get(family);
    const group=ensureGroup(S,direction,family);

    group.section.hidden=arr.length===0;
    if(!arr.length)continue;

    for(const t of arr){
      const key=keyFor(direction,t);
      active.add(key);

      const model=ensureRow(direction,t);
      updateRow(model,t);
      group.rows.appendChild(model.row);
    }
  }

  for(const [key,model] of nodes){
    if(!key.startsWith(direction+":"))continue;
    if(active.has(key))continue;
    model.row.remove();
    nodes.delete(key);
  }
}

function emptyText(S){
  const uts=[...S.puvFilters.units].sort();
  if(uts.length===1)return `ACTUALMENT NO CIRCULEN UT${uts[0]}`;
  if(uts.length>1)return `ACTUALMENT NO CIRCULEN ${uts.map(x=>"UT"+x).join(" / ")}`;
  return "ACTUALMENT NO CIRCULEN UNITATS AMB AQUESTS CONDICIONANTS";
}

function setEmpty(id,visible,text){
  const n=document.querySelector(id);
  n.hidden=!visible;
  n.textContent=visible?text:"";
}

function status(S,count){
  if(S.lastError&&!S.lastFetch){
    return `ERROR DADES · ${S.lastError}`;
  }
  if(S.lastError&&S.lastFetch){
    return `DADES CONSERVADES ${S.lastFetch.toLocaleTimeString("es-ES",{hour12:false})}`;
  }
  if(!S.lastFetch)return "ESPERANT DADES…";

  return `ACTUALITZAT ${S.lastFetch.toLocaleTimeString("es-ES",{hour12:false})} · ${count} UT`;
}

export function renderPUV(S){
  const filtered=(S.trains||[])
    .filter(t=>passes(S,t))
    .sort(sortTrains);

  const asc=filtered.filter(t=>t.ascending);
  const desc=filtered.filter(t=>!t.ascending);
  const empty=emptyText(S);

  setEmpty("#ascEmpty",asc.length===0,empty);
  setEmpty("#descEmpty",desc.length===0,empty);

  reconcile(S,"asc",asc);
  reconcile(S,"desc",desc);

  const statusNode=document.querySelector("#puvStatus");
  statusNode.textContent=status(S,filtered.length);
  statusNode.classList.toggle("error",Boolean(S.lastError));

  syncButtons(S);
}
