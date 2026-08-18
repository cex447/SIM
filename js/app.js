import {fetchPositioning,normalizeTrain} from "./fgc-api.js?v=3.0.0";
import {renderPUV} from "./puv.js?v=3.0.0";
import {loadLIT,tickLIT} from "./lit.js?v=3.0.0";

const S={
  config:null,network:null,trains:[],lastFetch:null,lastError:null,
  rawCount:0,bvCount:0,activeView:"puv",selected:null
};
const $=s=>document.querySelector(s);

async function init(){
  [S.config,S.network]=await Promise.all([
    fetch("data/config.json?v=3.0.0",{cache:"no-store"}).then(r=>r.json()),
    fetch("data/network.json?v=3.0.0",{cache:"no-store"}).then(r=>r.json())
  ]);
  setupClock();setupTabs();setupFilters();setupDiag();
  $("#loadLit").onclick=()=>loadLIT(S,$("#circulationInput").value.trim().toUpperCase());
  $("#circulationInput").addEventListener("keydown",e=>{if(e.key==="Enter")$("#loadLit").click()});
  await refresh();
  setInterval(refresh,S.config.refreshMs);
  setInterval(()=>tickLIT(S),250);
}
function setupClock(){
  const f=()=>$("#clock").textContent=new Date().toLocaleTimeString("es-ES",{hour12:false});
  f();setInterval(f,1000);
}
function setupTabs(){
  document.querySelectorAll(".tab").forEach(b=>b.onclick=()=>{
    document.querySelectorAll(".tab").forEach(x=>x.classList.toggle("active",x===b));
    document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));
    $("#view-"+b.dataset.view).classList.add("active");
    S.activeView=b.dataset.view;
  });
}
function setupFilters(){
  const lf=$("#lineFilters"),uf=$("#utFilters");
  ["TOTES",...S.config.allowedLines].forEach(x=>{
    const b=document.createElement("button");b.textContent=x;b.dataset.line=x;b.className=x==="TOTES"?"":"off";
    b.onclick=()=>toggleGroup(lf,b,"line");lf.appendChild(b);
  });
  ["TOTES",...S.config.allowedUnitSeries].forEach(x=>{
    const b=document.createElement("button");b.textContent=x;b.dataset.ut=x;b.className=x==="TOTES"?"":"off";
    b.onclick=()=>toggleGroup(uf,b,"ut");uf.appendChild(b);
  });
}
function toggleGroup(box,b,key){
  if(b.dataset[key]==="TOTES"){
    box.querySelectorAll("button").forEach(q=>q.classList.toggle("off",q!==b));
  }else{
    box.querySelector(`[data-${key}="TOTES"]`).classList.add("off");
    b.classList.toggle("off");
    const rest=[...box.querySelectorAll("button")].filter(q=>q.dataset[key]!=="TOTES");
    if(rest.every(q=>q.classList.contains("off")))box.querySelector(`[data-${key}="TOTES"]`).classList.remove("off");
  }
  renderPUV(S);
}
async function refresh(){
  try{
    const got=await fetchPositioning(S.config.positioningUrl);
    S.rawCount=got.rows.length;
    S.trains=got.rows.map(r=>normalizeTrain(r,S.config)).filter(Boolean);
    S.bvCount=S.trains.length;
    S.lastFetch=new Date();S.lastError=null;
    renderPUV(S);
    if(S.selected){
      const t=S.trains.find(x=>x.circulation===S.selected.circulation);
      if(t){S.selected.live=t;$("#utTop").textContent=t.unit||"---.--";}
    }
  }catch(e){
    S.lastError=String(e);
    $("#puvStatus").textContent="ERROR DADES";
  }
}
function setupDiag(){
  let timer;
  const hs=$("#diagHotspot");
  const start=()=>timer=setTimeout(openDiag,1000),stop=()=>clearTimeout(timer);
  hs.addEventListener("touchstart",start);hs.addEventListener("touchend",stop);
  hs.addEventListener("mousedown",start);hs.addEventListener("mouseup",stop);
  $("#closeDiag").onclick=()=>$("#diag").close();
}
function openDiag(){
  $("#diagText").textContent=[
    "SIM+ Beta 3",
    "Vista: "+S.activeView,
    "Registres API: "+S.rawCount,
    "BV vàlids: "+S.bvCount,
    "Última actualització: "+(S.lastFetch?.toLocaleTimeString("es-ES",{hour12:false})||"—"),
    "Error: "+(S.lastError||"—"),
    "Circulació LIT: "+(S.selected?.circulation||"—"),
    "UT: "+(S.selected?.live?.unit||"—"),
    "trip_id: "+(S.selected?.live?.id||"—"),
    "Parades LIT: "+(S.selected?.stops?.length||0)
  ].join("\\n");
  $("#diag").showModal();
}
init().catch(e=>{S.lastError=String(e);$("#puvStatus").textContent="ERROR INICIALITZACIÓ";});
