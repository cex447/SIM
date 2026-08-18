
import {fetchPositioning, normalizeTrain, decodeCirculation, decodeUnit} from "./fgc-api.js";
import {renderPUV} from "./puv.js";
import {loadLIT, tickLIT} from "./lit.js";

const S={config:null,interstations:null,trains:[],lastFetch:null,lastError:null,activeView:"lit",selected:null};
const $=s=>document.querySelector(s);

async function init(){
  S.config=await fetch("data/config.json").then(r=>r.json());
  S.interstations=await fetch("data/interstations.json").then(r=>r.json());
  setupClock(); setupTabs(); setupFilters(); setupDiag();
  $("#loadLit").onclick=()=>loadLIT(S,$("#circulationInput").value.trim().toUpperCase());
  $("#circulationInput").addEventListener("keydown",e=>{if(e.key==="Enter")$("#loadLit").click()});
  await refresh(); setInterval(refresh,S.config.refreshMs); setInterval(()=>tickLIT(S),250);
}
function setupClock(){const f=()=>$("#clock").textContent=new Date().toLocaleTimeString("es-ES",{hour12:false});f();setInterval(f,1000)}
function setupTabs(){document.querySelectorAll(".tab").forEach(b=>b.onclick=()=>{document.querySelectorAll(".tab").forEach(x=>x.classList.toggle("active",x===b));document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));$("#view-"+b.dataset.view).classList.add("active");S.activeView=b.dataset.view})}
function setupFilters(){
 const lf=$("#lineFilters"),uf=$("#utFilters");
 ["TOTES",...S.config.allowedLines].forEach(x=>{let b=document.createElement("button");b.textContent=x;b.dataset.line=x;b.className=x==="TOTES"?"":"off";b.onclick=()=>{if(x==="TOTES"){lf.querySelectorAll("button").forEach(q=>q.classList.toggle("off",q!==b))}else{lf.querySelector('[data-line="TOTES"]').classList.add("off");b.classList.toggle("off");if([...lf.querySelectorAll("button:not([data-line=TOTES])")].every(q=>q.classList.contains("off")))lf.querySelector('[data-line="TOTES"]').classList.remove("off")}renderPUV(S)};lf.appendChild(b)});
 ["TOTES",...S.config.allowedUnitSeries].forEach(x=>{let b=document.createElement("button");b.textContent=x;b.dataset.ut=x;b.className=x==="TOTES"?"":"off";b.onclick=()=>{if(x==="TOTES"){uf.querySelectorAll("button").forEach(q=>q.classList.toggle("off",q!==b))}else{uf.querySelector('[data-ut="TOTES"]').classList.add("off");b.classList.toggle("off");if([...uf.querySelectorAll("button:not([data-ut=TOTES])")].every(q=>q.classList.contains("off")))uf.querySelector('[data-ut="TOTES"]').classList.remove("off")}renderPUV(S)};uf.appendChild(b)});
}
async function refresh(){
 try{
   const raw=await fetchPositioning(S.config.positioningUrl);
   S.trains=raw.map(r=>normalizeTrain(r,S.config)).filter(Boolean);
   S.lastFetch=new Date();S.lastError=null;renderPUV(S);
   if(S.selected){const t=S.trains.find(x=>x.circulation===S.selected.circulation);if(t){S.selected.live=t;$("#utTop").textContent=t.unit||"---.--"}}
 }catch(e){S.lastError=String(e);$("#puvStatus").textContent="Error de dades";}
}
function setupDiag(){
 let timer;$("#diagHotspot").addEventListener("touchstart",()=>timer=setTimeout(openDiag,1200));
 $("#diagHotspot").addEventListener("touchend",()=>clearTimeout(timer));
 $("#diagHotspot").addEventListener("mousedown",()=>timer=setTimeout(openDiag,1200));
 $("#diagHotspot").addEventListener("mouseup",()=>clearTimeout(timer));
 $("#closeDiag").onclick=()=>$("#diag").close();
}
function openDiag(){
 $("#diagText").textContent=[
 "Vista: "+S.activeView,
 "Trens BV: "+S.trains.length,
 "Última actualització: "+(S.lastFetch?.toLocaleTimeString("es-ES",{hour12:false})||"—"),
 "Error: "+(S.lastError||"—"),
 "Circulació LIT: "+(S.selected?.circulation||"—"),
 "UT: "+(S.selected?.live?.unit||"—"),
 "trip_id: "+(S.selected?.live?.id||"—"),
 "Estat: "+(S.selected?.live?.whereText||"—")
 ].join("\n");$("#diag").showModal();
}
init();
