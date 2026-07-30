// ═══════════════════════════════════════════════════════════════════
// CLOUD-GAP HELPERS — pure functions comparing what's loaded on this
// device against the cloud archive index, so range-based screens can tell
// the user exactly what's missing. Extracted verbatim from App.jsx; no deps.
// ═══════════════════════════════════════════════════════════════════

export function cloudGapOf(sales,archiveIndex,from,to){
  const have={};
  for(const s of sales||[]){
    if(!s||s.isDraft||s.status==="voided")continue;
    have[s.date]=(have[s.date]||0)+1;
  }
  const days=[];let invoices=0;
  for(const [date,info] of Object.entries(archiveIndex||{})){
    if(from&&date<from)continue;
    if(to&&date>to)continue;
    const missing=(info?.n||0)-(have[date]||0);
    if(missing>0){days.push(date);invoices+=missing;}
  }
  days.sort();
  return{days,invoices,from:days[0],to:days[days.length-1]};
}

export function archiveSpanOf(archiveIndex){
  const dates=Object.keys(archiveIndex||{}).sort();
  if(!dates.length)return null;
  const totals=Object.values(archiveIndex).reduce((a,v)=>({n:a.n+(v?.n||0),total:a.total+(v?.total||0)}),{n:0,total:0});
  return{first:dates[0],last:dates[dates.length-1],days:dates.length,...totals};
}
