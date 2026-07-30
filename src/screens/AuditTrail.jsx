// ═══════════════════════════════════════════════════════════════════
// AUDIT TRAIL — read-only viewer of the local activity log.
// Extracted verbatim from App.jsx; markup and logic unchanged.
// ═══════════════════════════════════════════════════════════════════
import { useState } from "react";
import { C } from "../lib/theme.js";
import { LS } from "../lib/storage.js";
import { Card, Btn } from "../components/ui.jsx";

export function AuditTrail(){
  const [logs,setLogs]=useState(()=>LS.get("restopos_activity_log")||[]);
  const [filter,setFilter]=useState("");
  const filtered=logs.filter(l=>!filter||l.action?.toLowerCase().includes(filter.toLowerCase())||l.user?.toLowerCase().includes(filter.toLowerCase()));
  const ACTION_COLORS={SALE_COMPLETED:C.success,ITEM_ADDED:C.info,ITEM_DELETED:C.danger,USER_ADDED:C.info,USER_DELETED:C.danger,SETTINGS_CHANGED:C.warning,PINS_CHANGED:C.warning,LICENSE_TOGGLE:C.accent,PLAN_CHANGE:C.zatca,CLIENT_SUSPENDED:C.danger,SHIFT_STARTED:C.success,SHIFT_ENDED:C.primary,EXPENSE_ADDED:C.danger,CUSTOMER_ADDED:C.info};
  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
        <div><div style={{fontSize:20,fontWeight:800}}>🔍 Audit Trail</div><div style={{fontSize:13,color:C.textMid,marginTop:2}}>{logs.length} logged events · Last 500 retained</div></div>
        <Btn variant="danger" size="sm" onClick={()=>{if(confirm("Clear all audit logs?")){{LS.set("restopos_activity_log",[]);setLogs([])}}}}>🗑 Clear Logs</Btn>
      </div>
      <Card style={{marginBottom:16}}>
        <input value={filter} onChange={e=>setFilter(e.target.value)} placeholder="🔍 Filter by action or user..." style={{width:"100%",padding:"9px 14px",border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontFamily:"inherit"}}/>
      </Card>
      {filtered.length===0?<Card><div style={{textAlign:"center",padding:"40px 0",color:C.textMid}}><div style={{fontSize:32,marginBottom:12}}>🔍</div>No audit logs{filter?" matching filter":""}</div></Card>
      :<Card><div style={{display:"flex",flexDirection:"column",gap:0}}>
        {filtered.slice(0,200).map((log,i)=>(
          <div key={log.id||i} style={{display:"flex",gap:14,padding:"10px 0",borderBottom:`1px solid ${C.border}`,alignItems:"flex-start"}}>
            <span style={{fontSize:10,padding:"3px 8px",borderRadius:20,fontWeight:700,background:((ACTION_COLORS[log.action]||C.info)+"22"),color:ACTION_COLORS[log.action]||C.info,whiteSpace:"nowrap",flexShrink:0,marginTop:1}}>{log.action}</span>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:12,color:C.text,fontWeight:500,overflow:"hidden",textOverflow:"ellipsis"}}>{JSON.stringify(log.after||log.details||{})}</div>
              <div style={{fontSize:11,color:C.textLight,marginTop:2}}>by <strong>{log.user}</strong> · {log.timestamp?.slice(0,19).replace("T"," ")}</div>
            </div>
          </div>
        ))}
      </div></Card>}
    </div>
  );
}
