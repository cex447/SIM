const $=s=>document.querySelector(s);
export async function loadLIT(S,circ){
  if(!circ)return;
  const live=S.trains.find(t=>t.circulation===circ);
  S.selected={circulation:circ,live,stops:[]};
  $("#utTop").textContent=live?.unit||"---.--";
  $("#litStatus").textContent=live?"Circulació activa · "+circ:"Circulació no activa";
  $("#litRoute").innerHTML=live?
    '<div class="empty">LIT Beta: identificació activa correcta. Reconstrucció horària completa en la següent iteració.</div>':
    '<div class="empty">No s’ha trobat aquesta circulació activa.</div>';
}
export function tickLIT(S){}