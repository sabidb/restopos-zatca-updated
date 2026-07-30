// ═══════════════════════════════════════════════════════════════════
// STOCK TAKES & AUDITS — physical count vs system stock.
// Extracted verbatim from App.jsx; markup and logic unchanged.
// ═══════════════════════════════════════════════════════════════════
import { useState } from "react";
import { C } from "../lib/theme.js";
import { Card, Btn, Badge } from "../components/ui.jsx";

export function StockTakes({items,setItems}){
  const [audits,setAudits]=useState(()=>JSON.parse(localStorage.getItem("restopos_stock_audits")||"[]"));
  const [activeAudit,setActiveAudit]=useState(null);
  const [counts,setCounts]=useState({});
  const [tab,setTab]=useState("history");
  function startAudit(){
    const audit={id:Date.now(),startedAt:new Date().toISOString(),status:"open",items:items.map(it=>({id:it.id,name:it.name,systemQty:it.stock||0,countedQty:null,variance:null}))};
    setActiveAudit(audit);setCounts({});setTab("audit");
  }
  function submitAudit(){
    if(!activeAudit)return;
    const auditItems=activeAudit.items.map(it=>({...it,countedQty:parseInt(counts[it.id]??it.systemQty),variance:(parseInt(counts[it.id]??it.systemQty))-(it.systemQty)}));
    const closed={...activeAudit,status:"completed",completedAt:new Date().toISOString(),items:auditItems,totalVariance:auditItems.reduce((s,i)=>s+Math.abs(i.variance),0)};
    const updated=[closed,...audits.slice(0,49)];setAudits(updated);localStorage.setItem("restopos_stock_audits",JSON.stringify(updated));
    // Update actual stock in items
    setItems(prev=>prev.map(it=>{const counted=auditItems.find(a=>a.id===it.id);return counted?{...it,stock:counted.countedQty}:it;}));
    setActiveAudit(null);setCounts({});setTab("history");
    alert("✅ Stock audit completed and inventory updated.");
  }
  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
        <div><div style={{fontSize:20,fontWeight:800}}>📦 Stock Takes & Audits</div><div style={{fontSize:13,color:C.textMid,marginTop:2}}>Physical count vs system stock</div></div>
        <Btn onClick={startAudit}>+ New Stock Take</Btn>
      </div>
      <div style={{display:"flex",gap:8,marginBottom:20}}>
        {[["history","📋 History"],["audit","🔢 Current Audit"]].map(([id,lbl])=>(
          <button key={id} onClick={()=>setTab(id)} style={{padding:"8px 16px",borderRadius:8,border:`1.5px solid ${tab===id?C.primary:C.border}`,background:tab===id?C.primaryLight:"#fff",color:tab===id?C.primary:C.textMid,fontFamily:"inherit",fontSize:13,fontWeight:600,cursor:"pointer"}}>{lbl}</button>
        ))}
      </div>
      {tab==="audit"&&(
        activeAudit?(
          <Card>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
              <div style={{fontSize:15,fontWeight:700}}>Stock Count — {activeAudit.startedAt.slice(0,10)}</div>
              <div style={{display:"flex",gap:8}}>
                <Btn variant="ghost" size="sm" onClick={()=>{setActiveAudit(null);setCounts({});setTab("history");}}>Cancel</Btn>
                <Btn size="sm" onClick={submitAudit}>✅ Submit Audit</Btn>
              </div>
            </div>
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
                <thead><tr style={{background:C.bg}}>{["Item","System Qty","Counted Qty","Variance"].map(h=><th key={h} style={{padding:"10px 14px",textAlign:"left",fontWeight:700,color:C.textMid,fontSize:11,textTransform:"uppercase",borderBottom:`1px solid ${C.border}`}}>{h}</th>)}</tr></thead>
                <tbody>{activeAudit.items.map((it,i)=>{
                  const counted=parseInt(counts[it.id]??it.systemQty);
                  const variance=counted-it.systemQty;
                  return(
                    <tr key={it.id} style={{borderBottom:`1px solid ${C.border}`,background:i%2===0?"#fff":"#FAFBFC"}}>
                      <td style={{padding:"10px 14px",fontWeight:600}}>{it.name}</td>
                      <td style={{padding:"10px 14px",color:C.textMid}}>{it.systemQty}</td>
                      <td style={{padding:"10px 14px"}}>
                        <input type="number" value={counts[it.id]??""} onChange={e=>setCounts(prev=>({...prev,[it.id]:e.target.value}))} placeholder={String(it.systemQty)} style={{width:80,padding:"6px 10px",border:`1.5px solid ${C.border}`,borderRadius:7,fontSize:13,fontFamily:"inherit",textAlign:"center"}}/>
                      </td>
                      <td style={{padding:"10px 14px",fontWeight:700,color:variance===0?C.success:variance<0?C.danger:C.warning}}>{variance>0?"+":""}{variance===0?"—":variance}</td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          </Card>
        ):<Card><div style={{textAlign:"center",padding:"40px 0",color:C.textLight}}>No active audit. Click "New Stock Take" to begin.</div></Card>
      )}
      {tab==="history"&&(
        audits.length===0?<Card><div style={{textAlign:"center",padding:"40px 0",color:C.textLight}}>No stock audits yet.</div></Card>:(
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            {audits.map(a=>(
              <Card key={a.id}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
                  <div>
                    <div style={{fontSize:14,fontWeight:700}}>Audit — {a.startedAt.slice(0,10)}</div>
                    <div style={{fontSize:12,color:C.textMid}}>Completed: {a.completedAt?.slice(0,16).replace("T"," ")} · Items: {a.items?.length||0}</div>
                  </div>
                  <Badge color={a.totalVariance===0?C.success:C.warning} bg={a.totalVariance===0?C.successLight:C.warningLight}>Variance: {a.totalVariance||0} units</Badge>
                </div>
                {a.items?.filter(it=>it.variance!==0).length>0&&(
                  <div style={{marginTop:12,paddingTop:12,borderTop:`1px solid ${C.border}`}}>
                    <div style={{fontSize:12,fontWeight:700,color:C.textMid,marginBottom:6}}>VARIANCES:</div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                      {a.items.filter(it=>it.variance!==0).map(it=>(
                        <span key={it.id} style={{padding:"3px 10px",borderRadius:20,fontSize:11,fontWeight:700,background:it.variance<0?C.dangerLight:C.warningLight,color:it.variance<0?C.danger:C.warning}}>{it.name}: {it.variance>0?"+":""}{it.variance}</span>
                      ))}
                    </div>
                  </div>
                )}
              </Card>
            ))}
          </div>
        )
      )}
    </div>
  );
}
