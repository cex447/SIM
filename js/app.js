import {
  fetchPositioning,
  normalizeTrain
} from "./fgc-api.js?v=3.3.0";

import {
  wirePUV,
  renderPUV
} from "./puv.js?v=3.3.0";

const S={
  config:null,
  network:null,
  trains:[],
  rawCount:0,
  apiTotal:null,
  lastFetch:null,
  lastError:null,
  lastLatencyMs:null,
  activeView:"puv",
  selected:null,
  puvFilters:{
    lines:new Set(),
    units:new Set()
  }
};

const $=selector=>document.querySelector(selector);

let refreshTimer=null;
let refreshRunning=false;
let controller=null;
let litModule=null;
let litTimer=null;

function setupClock(){
  const tick=()=>{
    $("#clock").textContent=new Date().toLocaleTimeString("es-ES",{hour12:false});
  };
  tick();
  setInterval(tick,1000);
}

function showView(name){
  S.activeView=name;

  document.querySelectorAll(".tab").forEach(button=>{
    button.classList.toggle("active",button.dataset.view===name);
  });

  document.querySelectorAll(".view").forEach(view=>{
    view.classList.toggle("active",view.id===`view-${name}`);
  });
}

function setupTabs(){
  document.querySelectorAll(".tab").forEach(button=>{
    button.addEventListener("click",()=>showView(button.dataset.view));
  });
}

async function loadConfig(){
  const response=await fetch("data/config.json?v=3.3.0",{cache:"no-store"});
  if(!response.ok)throw new Error(`config.json HTTP ${response.status}`);
  S.config=await response.json();
}

async function ensureLit(){
  if(!S.network){
    try{
      const response=await fetch("data/network.json?v=3.0.0",{cache:"no-store"});
      S.network=response.ok?await response.json():{segments:[]};
    }catch{
      S.network={segments:[]};
    }
  }

  if(!litModule){
    litModule=await import("./lit.js?v=3.0.0");
    if(!litTimer){
      litTimer=setInterval(()=>litModule?.tickLIT?.(S),250);
    }
  }

  return litModule;
}

function setupLIT(){
  const input=$("#circulationInput");

  input.addEventListener("input",()=>{
    input.value=input.value
      .replace(/[^a-zA-Z0-9]/g,"")
      .slice(0,4)
      .toUpperCase();
  });

  const load=async()=>{
    const circulation=input.value.trim().toUpperCase();
    if(!circulation)return;

    $("#litStatus").textContent="Carregant…";

    try{
      const mod=await ensureLit();
      await mod.loadLIT(S,circulation);
    }catch(error){
      $("#litStatus").textContent="ERROR LIT";
      $("#litRoute").innerHTML=
        `<div class="empty">${String(error?.message||error)}</div>`;
    }
  };

  $("#loadLit").addEventListener("click",load);

  input.addEventListener("keydown",event=>{
    if(event.key==="Enter"){
      event.preventDefault();
      load();
    }
  });
}

function dedupe(trains){
  const map=new Map();
  for(const t of trains)map.set(t.id,t);
  return [...map.values()];
}

function scheduleNext(delay=S.config.refreshMs){
  clearTimeout(refreshTimer);
  if(document.hidden)return;

  refreshTimer=setTimeout(()=>{
    refreshPositioning();
  },delay);
}

async function refreshPositioning(){
  if(refreshRunning||document.hidden)return;
  refreshRunning=true;

  controller?.abort();
  controller=new AbortController();

  const timeout=setTimeout(
    ()=>controller.abort(),
    S.config.requestTimeoutMs||8000
  );

  const started=performance.now();

  try{
    const result=await fetchPositioning(
      S.config.positioningUrl,
      {signal:controller.signal}
    );

    S.rawCount=result.rows.length;
    S.apiTotal=result.total;

    S.trains=dedupe(
      result.rows
        .map(row=>normalizeTrain(row,S.config))
        .filter(Boolean)
    );

    S.lastFetch=new Date();
    S.lastLatencyMs=Math.round(performance.now()-started);
    S.lastError=null;

    renderPUV(S);

    if(S.selected?.circulation){
      const live=S.trains.find(
        t=>t.circulation===S.selected.circulation
      );

      if(live){
        S.selected.live=live;
        $("#utTop").textContent=live.unit;
      }
    }
  }catch(error){
    if(error?.name==="AbortError"){
      S.lastError="temps d'espera excedit";
    }else{
      S.lastError=String(error?.message||error);
    }
    renderPUV(S);
  }finally{
    clearTimeout(timeout);
    refreshRunning=false;
    scheduleNext();
  }
}

function setupConnectivity(){
  document.addEventListener("visibilitychange",()=>{
    if(document.hidden){
      clearTimeout(refreshTimer);
      controller?.abort();
    }else{
      refreshPositioning();
    }
  });

  window.addEventListener("online",()=>refreshPositioning());

  window.addEventListener("offline",()=>{
    S.lastError="sense connexió";
    renderPUV(S);
  });
}

function setupDiag(){
  const hotspot=$("#diagHotspot");
  const dialog=$("#diag");
  let timer=null;

  const open=()=>{
    $("#diagText").textContent=[
      "SIM+ Beta 3.3",
      `Vista: ${S.activeView}`,
      `Registres rebuts: ${S.rawCount}`,
      `Total API: ${S.apiTotal??"—"}`,
      `BV vàlids: ${S.trains.length}`,
      `Última consulta: ${
        S.lastFetch
          ?S.lastFetch.toLocaleTimeString("es-ES",{hour12:false})
          :"—"
      }`,
      `Latència: ${S.lastLatencyMs===null?"—":S.lastLatencyMs+" ms"}`,
      `Error: ${S.lastError||"—"}`
    ].join("\n");

    dialog.showModal();
  };

  hotspot.addEventListener("pointerdown",()=>{
    timer=setTimeout(open,900);
  });

  for(const eventName of ["pointerup","pointercancel","pointerleave"]){
    hotspot.addEventListener(eventName,()=>clearTimeout(timer));
  }

  $("#closeDiag").addEventListener("click",()=>dialog.close());
}

async function init(){
  /*
   * El reloj y navegación arrancan antes de tocar la API.
   * PUV ya no depende de network.json, GTFS ni lit.js.
   */
  setupClock();
  setupTabs();
  setupLIT();
  setupDiag();

  try{
    await loadConfig();
  }catch(error){
    $("#puvStatus").textContent=`ERROR CONFIG · ${String(error?.message||error)}`;
    $("#puvStatus").classList.add("error");
    return;
  }

  wirePUV(S);
  setupConnectivity();
  renderPUV(S);

  await refreshPositioning();
}

init();
