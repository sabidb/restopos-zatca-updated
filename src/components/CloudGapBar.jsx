// ═══════════════════════════════════════════════════════════════════
// CLOUD GAP BAR — shared banner warning that some invoices in the shown
// period live only in the cloud, with a one-click load. Extracted verbatim
// from App.jsx; markup and logic unchanged.
// ═══════════════════════════════════════════════════════════════════
import { useMemo } from "react";
import { C } from "../lib/theme.js";
import { fmtDate } from "../lib/format.js";
import { cloudGapOf, archiveSpanOf } from "../lib/cloudGap.js";

export function CloudGapBar({sales,archiveIndex,from,to,fetchCloudRange,cloudLoading,cloudError,
  whatFollows="the totals below",showComplete=true,style}){
  const gap=useMemo(()=>cloudGapOf(sales,archiveIndex,from,to),[sales,archiveIndex,from,to]);
  const span=useMemo(()=>archiveSpanOf(archiveIndex),[archiveIndex]);
  const has=gap.days.length>0;
  if(!has&&(!showComplete||!span))return null;
  return(
    <div style={{padding:"10px 13px",borderRadius:10,marginBottom:10,
      border:`1px solid ${has?"#F0A50055":C.border}`,background:has?"#FFF8E7":C.bg,
      display:"flex",alignItems:"center",gap:12,flexWrap:"wrap",...style}}>
      <span style={{fontSize:16}}>{has?"☁️":"✅"}</span>
      <div style={{flex:1,minWidth:220}}>
        {has?(
          <>
            <div style={{fontSize:12.5,fontWeight:700,color:"#8A6100"}}>
              {gap.invoices.toLocaleString()} invoice{gap.invoices===1?"":"s"} in this period are stored in the cloud, not on this device.
            </div>
            <div style={{fontSize:11,color:C.textMid,marginTop:2}}>
              {gap.days.length} day{gap.days.length===1?"":"s"} · {fmtDate(gap.from)}
              {gap.from!==gap.to?` → ${fmtDate(gap.to)}`:""} — {whatFollows} exclude{whatFollows.endsWith("s")?"":"s"} them until you load them.
            </div>
          </>
        ):(
          <>
            <div style={{fontSize:12.5,fontWeight:700,color:C.text}}>
              This period is complete — everything in the cloud for these dates is loaded.
            </div>
            {span&&(
              <div style={{fontSize:11,color:C.textMid,marginTop:2}}>
                Cloud history: {span.days.toLocaleString()} day{span.days===1?"":"s"} from {fmtDate(span.first)} to {fmtDate(span.last)} · {span.n.toLocaleString()} invoices.
              </div>
            )}
          </>
        )}
        {cloudError&&<div style={{fontSize:11,color:C.danger,marginTop:4}}>{cloudError}</div>}
      </div>
      {has&&(
        <button onClick={()=>fetchCloudRange&&fetchCloudRange(gap.from,gap.to)} disabled={cloudLoading}
          style={{padding:"9px 16px",background:cloudLoading?"#ccc":"linear-gradient(135deg,#1A6B4A,#134D36)",
            color:"#fff",border:"none",borderRadius:9,fontSize:12,fontWeight:800,
            cursor:cloudLoading?"wait":"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}}>
          {cloudLoading?"Downloading…":"☁️ Load from cloud"}
        </button>
      )}
    </div>
  );
}
