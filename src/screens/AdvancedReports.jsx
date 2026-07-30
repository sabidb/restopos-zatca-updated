// ═══════════════════════════════════════════════════════════════════
// ADVANCED ANALYTICS — hourly sales, monthly VAT, staff, top items.
// Extracted verbatim from App.jsx; markup and logic unchanged.
// ═══════════════════════════════════════════════════════════════════
import { useState } from "react";
import { C } from "../lib/theme.js";
import { fmtSAR } from "../lib/format.js";
import { TODAY } from "../lib/date.js";
import { Card, Btn, Badge, DataTable } from "../components/ui.jsx";

export function AdvancedReports({sales,items}){
  const [tab,setTab]=useState("hourly");
  const todaySales=sales.filter(s=>s.date===TODAY);
  const hourly=Array.from({length:24},(_,h)=>{const hrs=todaySales.filter(s=>parseInt(s.time?.slice(0,2)||"0")===h);return{hour:h,count:hrs.length,revenue:hrs.reduce((s,o)=>s+o.total,0)};});
  const peakHour=hourly.reduce((max,h)=>h.revenue>max.revenue?h:max,hourly[0]);
  const vatByMonth={};
  sales.forEach(s=>{const ym=s.date?.slice(0,7)||"Unknown";if(!vatByMonth[ym])vatByMonth[ym]={month:ym,orders:0,revenue:0,vat:0};vatByMonth[ym].orders++;vatByMonth[ym].revenue+=s.subtotal||0;vatByMonth[ym].vat+=s.vat||0;});
  const vatRows=Object.values(vatByMonth).sort((a,b)=>b.month.localeCompare(a.month));
  const byUser={};
  sales.forEach(s=>{const u=s.cashier||s.user||"Unknown";if(!byUser[u])byUser[u]={user:u,count:0,revenue:0};byUser[u].count++;byUser[u].revenue+=s.total||0;});
  const userRows=Object.values(byUser).sort((a,b)=>b.revenue-a.revenue);
  const maxRevenue=Math.max(...hourly.map(h=>h.revenue),1);
  return(
    <div>
      <div style={{fontSize:20,fontWeight:800,marginBottom:20}}>📋 Advanced Analytics</div>
      <div style={{display:"flex",gap:6,marginBottom:20,flexWrap:"wrap"}}>
        {[["hourly","⏰ Hourly"],["vat","🧾 VAT Reports"],["staff","👤 Staff"],["items","🏆 Top Items"]].map(([id,lbl])=>(
          <button key={id} onClick={()=>setTab(id)} style={{padding:"7px 16px",borderRadius:8,border:`1.5px solid ${tab===id?C.primary:C.border}`,background:tab===id?C.primaryLight:"#fff",color:tab===id?C.primary:C.textMid,fontFamily:"inherit",fontSize:13,fontWeight:600,cursor:"pointer"}}>{lbl}</button>
        ))}
      </div>
      {tab==="hourly"&&<Card>
        <div style={{fontSize:14,fontWeight:700,marginBottom:4}}>⏰ Hour-by-Hour Sales — Today</div>
        <div style={{fontSize:12,color:C.textMid,marginBottom:16}}>Peak hour: {peakHour.hour}:00 — {fmtSAR(peakHour.revenue)}</div>
        <div style={{display:"flex",gap:3,alignItems:"flex-end",height:160,overflowX:"auto",paddingBottom:8}}>
          {hourly.map(h=>(
            <div key={h.hour} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4,minWidth:28}}>
              <div style={{fontSize:9,color:C.textLight,fontWeight:600}}>{h.revenue>0?h.revenue.toFixed(0):"—"}</div>
              <div style={{width:22,background:h.hour===peakHour.hour&&h.revenue>0?C.accent:h.revenue>0?C.primary:C.border,borderRadius:"4px 4px 0 0",transition:"height 0.3s",height:`${Math.max(4,(h.revenue/maxRevenue)*120)}px`}}/>
              <div style={{fontSize:9,color:C.textLight}}>{h.hour}h</div>
            </div>
          ))}
        </div>
        <div style={{marginTop:16,display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
          {[["Peak Hour",`${peakHour.hour}:00`,C.accent],["Today Orders",todaySales.length,C.primary],["Today Revenue",fmtSAR(todaySales.reduce((s,o)=>s+o.total,0)),C.success]].map(([l,v,col])=>(
            <div key={l} style={{background:C.bg,borderRadius:8,padding:"10px 12px"}}><div style={{fontSize:11,color:C.textMid}}>{l}</div><div style={{fontSize:14,fontWeight:800,color:col}}>{v}</div></div>
          ))}
        </div>
      </Card>}
      {tab==="vat"&&<Card>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div style={{fontSize:14,fontWeight:700}}>🧾 Monthly VAT Summary (ZATCA)</div>
          <Btn size="sm" variant="outline" onClick={()=>{
            const csv=["Month,Orders,Revenue (excl VAT),VAT 15%,Total",...vatRows.map(r=>`${r.month},${r.orders},${r.revenue.toFixed(2)},${r.vat.toFixed(2)},${(r.revenue+r.vat).toFixed(2)}`)].join("\n");
            const blob=new Blob([csv],{type:"text/csv"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=`vat-summary-${TODAY}.csv`;a.click();
          }}>📤 Export</Btn>
        </div>
        {vatRows.length===0?<div style={{textAlign:"center",padding:"32px 0",color:C.textLight}}>No sales data yet</div>
        :<DataTable headers={["Month","Orders","Revenue (excl VAT)","VAT 15%","Total"]} rows={vatRows.map(r=>[
          <strong style={{fontFamily:"monospace"}}>{r.month}</strong>,r.orders,fmtSAR(r.revenue),
          <span style={{color:C.zatca,fontWeight:700}}>{fmtSAR(r.vat)}</span>,
          <strong style={{color:C.primary}}>{fmtSAR(r.revenue+r.vat)}</strong>
        ])}/>}
        <div style={{marginTop:16,padding:"12px 16px",background:C.zatcaLight,borderRadius:10,fontSize:13}}>
          <strong style={{color:C.zatca}}>Total VAT Collected (all time): {fmtSAR(sales.reduce((s,o)=>s+o.vat,0))}</strong>
        </div>
      </Card>}
      {tab==="staff"&&<Card>
        <div style={{fontSize:14,fontWeight:700,marginBottom:16}}>👤 Staff Performance</div>
        {userRows.length===0?<div style={{textAlign:"center",padding:"32px 0",color:C.textLight}}>No data yet</div>
        :<DataTable headers={["Cashier / User","Orders","Total Revenue","Avg Order"]} rows={userRows.map(u=>[
          <strong>{u.user}</strong>,
          <Badge color={C.info} bg={C.infoLight}>{u.count}</Badge>,
          <strong style={{color:C.primary}}>{fmtSAR(u.revenue)}</strong>,
          fmtSAR(u.count>0?u.revenue/u.count:0)
        ])}/>}
      </Card>}
      {tab==="items"&&<Card>
        <div style={{fontSize:14,fontWeight:700,marginBottom:16}}>🏆 Top Items (All Time)</div>
        {(()=>{
          const itemMap={};
          sales.forEach(s=>(s.items||[]).forEach(it=>{if(!itemMap[it.id])itemMap[it.id]={name:it.name,qty:0,revenue:0};itemMap[it.id].qty+=it.qty;itemMap[it.id].revenue+=it.qty*it.price;}));
          const ranked=Object.values(itemMap).sort((a,b)=>b.revenue-a.revenue).slice(0,15);
          return ranked.length===0?<div style={{textAlign:"center",padding:"32px 0",color:C.textLight}}>No items sold yet</div>
          :<DataTable headers={["#","Item","Units Sold","Revenue"]} rows={ranked.map((it,i)=>[
            <span style={{fontWeight:800,color:i<3?C.accent:C.textMid}}>{i+1}</span>,
            <strong>{it.name}</strong>,
            <Badge color={C.info} bg={C.infoLight}>{it.qty}</Badge>,
            <strong style={{color:C.primary}}>{fmtSAR(it.revenue)}</strong>
          ])}/>;
        })()}
      </Card>}
    </div>
  );
}
