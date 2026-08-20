import { fetchPositioning, normalizeTrain } from "./fgc-api.js?v=3.4.1";
import { wirePUV, renderPUV, revealSearchedTrain, paintOccupancy } from "./puv.js?v=3.4.1";

const S = {
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
  puvFilters:{lines:new Set(),units:new Set()},
  query:{code:"",state:"empty",train:null,requestId:0}
};

const $ = selector => document.querySelector(selector);
let refreshTimer = null;
let activeController = null;
let refreshRunning = false;
let refreshPromise = null;
let litModule = null;
let litTimer = null;
let audio = null;

function setupClock(){
  const tick=()=>{$("#clock").textContent=new Date().toLocaleTimeString("es-ES",{hour12:false});};
  tick(); setInterval(tick,1000);
}

async function loadConfig(){
  const response=await fetch("data/config.json?v=3.4.1",{cache:"no-store"});
  if(!response.ok) throw new Error(`config.json HTTP ${response.status}`);
  S.config=await response.json();
}

function hideQueryMeta(){
  $("#queryMeta").hidden=true;
  $("#queryStatus").hidden=true;
  $("#queryUnit").hidden=true;
  $("#queryOccupancy").hidden=true;
}

function renderQuery(){
  const input=$("#circulationInput");
  const meta=$("#queryMeta");
  const status=$("#queryStatus");
  const unit=$("#queryUnit");
  const occupancy=$("#queryOccupancy");
  input.classList.remove("delayed-text");
  unit.classList.remove("delayed-text");

  if(!S.query.code || S.query.state==="empty") { hideQueryMeta(); return; }
  meta.hidden=false;

  if(S.query.state==="loading"){
    status.textContent="CARREGANT"; status.hidden=false; unit.hidden=true; occupancy.hidden=true; return;
  }
  if(S.query.state==="inactive"){
    status.textContent="CIRCULACIÓ NO ACTIVA"; status.hidden=false; unit.hidden=true; occupancy.hidden=true; return;
  }

  const train=S.query.train;
  if(!train){ hideQueryMeta(); return; }
  status.hidden=true;
  unit.textContent=train.unit; unit.hidden=false;
  occupancy.hidden=false; paintOccupancy(occupancy,train.occupancy,false);
  if(train.onTime===false){ input.classList.add("delayed-text"); unit.classList.add("delayed-text"); }
}

async function ensureLIT(){
  if(!litModule){
    litModule=await import("./lit.js?v=3.4.1");
    if(!litTimer) litTimer=setInterval(()=>litModule?.tickLIT?.(S),250);
  }
  if(!S.network){
    try{
      const r=await fetch("data/network.json?v=3.0.0",{cache:"no-store"});
      S.network=r.ok?await r.json():{segments:[]};
    }catch{ S.network={segments:[]}; }
  }
  return litModule;
}

function clearLITSafely(){
  if(litModule?.clearLIT) litModule.clearLIT(S);
  else $("#litRoute")?.replaceChildren();
}

function findTrain(code){ return S.trains.find(train=>train.circulation===code)||null; }

async function ensureFreshPositioning(){
  const age=S.lastFetch?Date.now()-S.lastFetch.getTime():Infinity;
  if(age>S.config.refreshMs) await refreshPositioning({reschedule:false});
}

async function resolveQuery(code){
  const requestId=++S.query.requestId;
  S.query.code=code; S.query.state="loading"; S.query.train=null; renderQuery();
  try{ await ensureFreshPositioning(); }catch{}
  if(requestId!==S.query.requestId||S.query.code!==code) return;
  const train=findTrain(code);
  if(!train){
    S.query.state="inactive"; S.query.train=null; renderQuery(); clearLITSafely(); renderPUV(S); return;
  }
  S.query.state="active"; S.query.train=train; renderQuery(); renderPUV(S);
  if(S.activeView==="puv") revealSearchedTrain(S);
  if(S.activeView==="lit"){
    S.query.state="loading"; renderQuery();
    try{
      const lit=await ensureLIT();
      const loaded=await lit.loadLIT(S,code,train);
      if(requestId===S.query.requestId&&S.query.code===code){
        const live=findTrain(code);
        if(!live){S.query.state="inactive";S.query.train=null;clearLITSafely();}
        else{S.query.state=loaded?"active":"active";S.query.train=live;}
        renderQuery();
      }
    }catch(error){
      S.lastError=String(error?.message||error);
      if(requestId===S.query.requestId&&S.query.code===code){S.query.state="active";S.query.train=train;renderQuery();}
    }
  }
}

function setupSearch(){
  const input=$("#circulationInput");
  input.addEventListener("input",()=>{
    const value=input.value.replace(/[^a-zA-Z0-9]/g,"").slice(0,4).toUpperCase();
    input.value=value;
    if(value.length<4){
      S.query.requestId+=1; S.query.code=value; S.query.state="empty"; S.query.train=null;
      renderQuery(); clearLITSafely(); renderPUV(S); return;
    }
    resolveQuery(value);
  });
}

async function activateView(name){
  if(name===S.activeView) return;
  S.activeView=name;
  document.querySelectorAll(".tab").forEach(button=>button.classList.toggle("active",button.dataset.view===name));
  document.querySelectorAll(".view").forEach(view=>view.classList.toggle("active",view.id===`view-${name}`));
  if(name==="ema") audio?.enterEMA?.(); else audio?.leaveEMA?.();
  if(name==="lit"&&S.query.code.length===4&&S.query.train){
    S.query.state="loading"; renderQuery();
    try{const lit=await ensureLIT(); await lit.loadLIT(S,S.query.code,S.query.train); S.query.state="active"; renderQuery();}
    catch{S.query.state="active";renderQuery();}
  }
  if(name==="puv"&&S.query.code.length===4) revealSearchedTrain(S);
}

function setupTabs(){
  document.querySelectorAll(".tab").forEach(button=>button.addEventListener("click",()=>activateView(button.dataset.view)));
}

function dedupe(trains){ const map=new Map(); for(const train of trains) map.set(train.id,train); return [...map.values()]; }

function scheduleNext(){
  clearTimeout(refreshTimer);
  if(document.hidden) return;
  refreshTimer=setTimeout(()=>refreshPositioning(),S.config.refreshMs);
}

function syncActiveQuery(){
  if(S.query.code.length!==4) return;
  const live=findTrain(S.query.code);
  if(!live){S.query.state="inactive";S.query.train=null;renderQuery();return;}
  S.query.train=live;
  if(S.query.state!=="loading") S.query.state="active";
  renderQuery();
  if(S.selected?.circulation===live.circulation) S.selected.live=live;
}

async function refreshPositioning({reschedule=true}={}){
  if(refreshRunning) return refreshPromise;
  if(document.hidden) return null;
  refreshRunning=true;
  activeController?.abort(); activeController=new AbortController();
  const timeoutId=setTimeout(()=>activeController.abort(),S.config.requestTimeoutMs||8000);
  const started=performance.now();
  refreshPromise=(async()=>{
    try{
      const result=await fetchPositioning(S.config.positioningUrl,{signal:activeController.signal});
      S.rawCount=result.rows.length; S.apiTotal=result.total;
      S.trains=dedupe(result.rows.map(row=>normalizeTrain(row,S.config)).filter(Boolean));
      S.lastFetch=new Date(); S.lastLatencyMs=Math.round(performance.now()-started); S.lastError=null;
      syncActiveQuery(); renderPUV(S);
    }catch(error){
      if(error?.name!=="AbortError") S.lastError=String(error?.message||error);
      else S.lastError="temps d'espera excedit";
      renderPUV(S);
    }finally{
      clearTimeout(timeoutId); refreshRunning=false; refreshPromise=null; if(reschedule) scheduleNext();
    }
  })();
  return refreshPromise;
}

function setupConnectivity(){
  document.addEventListener("visibilitychange",()=>{
    if(document.hidden){clearTimeout(refreshTimer);activeController?.abort();}
    else refreshPositioning();
  });
  window.addEventListener("online",()=>refreshPositioning());
  window.addEventListener("offline",()=>{S.lastError="sense connexió";renderPUV(S);});
}

function setupDiagnostics(){
  const hotspot=$("#diagHotspot"), dialog=$("#diag"); let timer=null;
  const open=()=>{
    $("#diagText").textContent=[
      "SIM+ Beta 3.4.1","Vista: "+S.activeView,`Registres API: ${S.rawCount}`,`BV vàlids: ${S.trains.length}`,
      `Última consulta: ${S.lastFetch?S.lastFetch.toLocaleTimeString("es-ES",{hour12:false}):"—"}`,
      `Latència: ${S.lastLatencyMs===null?"—":S.lastLatencyMs+" ms"}`,`Refresc: ${S.config?.refreshMs??"—"} ms`,
      `Error: ${S.lastError||"—"}`].join("\n");
    dialog?.showModal?.();
  };
  hotspot?.addEventListener("pointerdown",()=>{timer=setTimeout(open,900);});
  ["pointerup","pointercancel","pointerleave"].forEach(ev=>hotspot?.addEventListener(ev,()=>clearTimeout(timer)));
  $("#closeDiag")?.addEventListener("click",()=>dialog?.close?.());
}

async function setupAudioOptional(){
  try{
    const {BackgroundAudio}=await import("./audio.js?v=3.4.1");
    audio=new BackgroundAudio(S.config.audio||{});
    await audio.init();
    $("#brandAudioToggle")?.addEventListener("click",event=>{event.stopPropagation();audio?.toggleByUser?.();});
    document.addEventListener("pointerup",event=>{
      if(event.target.closest?.("#brandAudioToggle")) return;
      if(S.activeView!=="ema") audio?.unlockFromUserGesture?.();
    },{passive:true});
  }catch(error){ console.warn("Àudio opcional no disponible",error); }
}

async function init(){
  setupClock(); setupTabs(); setupSearch(); setupDiagnostics();
  try{ await loadConfig(); }
  catch(error){
    S.lastError=String(error?.message||error);
    const status=$("#puvStatus"); if(status){status.textContent="ERROR CONFIG";status.classList.add("error");}
    return;
  }
  wirePUV(S); setupConnectivity(); renderQuery(); renderPUV(S);
  setupAudioOptional();
  await refreshPositioning();
}

init();
