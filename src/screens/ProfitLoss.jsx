// ═══════════════════════════════════════════════════════════════════
// PROFIT & LOSS — revenue, COGS, expenses, margins by period.
// Extracted verbatim from App.jsx; markup and logic unchanged.
// ═══════════════════════════════════════════════════════════════════
import { useState } from "react";
import { C } from "../lib/theme.js";
import { LS } from "../lib/storage.js";
import { fmtSAR } from "../lib/format.js";
import { TODAY } from "../lib/date.js";
import { Card, StatCard } from "../components/ui.jsx";

export function ProfitLoss({sales,items}){
  const [period,setPeriod]=useState("month");
  const now=new Date();
  const expenses=LS.get("restopos_expenses")||[];
  const filteredSales=sales.filter(s=>{
    const d=new Date(s.date);
    if(period==="today")return s.date===TODAY;
    if(period==="week"){const w=new Date();w.setDate(w.getDate()-7);return d>=w;}
    if(period==="month")return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear();
    return true;
  });
  const filteredExp=expenses.filter(e=>{
    const d=new Date(e.date);
    if(period==="today")return e.date===TODAY;
    if(period==="week"){const w=new Date();w.setDate(w.getDate()-7);return d>=w;}
    if(period==="month")return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear();
    return true;
  });
  const revenue=filteredSales.reduce((s,o)=>s+(o.total||0),0);
  const vatCollected=filteredSales.reduce((s,o)=>s+(o.vat||0),0);
  const revenueExclVat=revenue-vatCollected;
  const cogs=filteredSales.reduce((s,o)=>s+(o.items||[]).reduce((ss,it)=>{const item=items.find(i=>i.id===it.id);return ss+(item?.cost||0)*it.qty;},0),0);
  const opExpenses=filteredExp.reduce((s,e)=>s+e.amount,0);
  const grossProfit=revenueExclVat-cogs;
  const netProfit=grossProfit-opExpenses;
  const grossMargin=revenueExclVat>0?((grossProfit/revenueExclVat)*100).toFixed(1):0;
  const netMargin=revenueExclVat>0?((netProfit/revenueExclVat)*100).toFixed(1):0;
  const payBreakdown=["Cash","Card","Both"].map(m=>({method:m,total:filteredSales.filter(s=>s.payMethod===m).reduce((s,o)=>s+o.total,0),count:filteredSales.filter(s=>s.payMethod===m).length}));
  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:24,flexWrap:"wrap",gap:10}}>
        <div><div style={{fontSize:20,fontWeight:800}}>📈 Profit & Loss</div><div style={{fontSize:13,color:C.textMid,marginTop:2}}>{{"today":"Today","week":"Last 7 Days","month":"This Month","all":"All Time"}[period]}</div></div>
        <div style={{display:"flex",gap:6}}>{[["today","Today"],["week","Week"],["month","Month"],["all","All"]].map(([id,lbl])=>(
          <button key={id} onClick={()=>setPeriod(id)} style={{padding:"7px 14px",borderRadius:8,border:`1.5px solid ${period===id?C.primary:C.border}`,background:period===id?C.primary:"#fff",color:period===id?"#fff":C.textMid,fontFamily:"inherit",fontSize:13,fontWeight:600,cursor:"pointer"}}>{lbl}</button>
        ))}</div>
      </div>
      {filteredSales.length===0?(
        <Card><div style={{textAlign:"center",padding:"60px 20px",color:C.textLight}}>
          <div style={{fontSize:48,marginBottom:12}}>📊</div>
          <div style={{fontSize:16,fontWeight:700,marginBottom:6}}>No sales data yet</div>
          <div style={{fontSize:13}}>Complete orders in the POS screen to see P&L data here.</div>
        </div></Card>
      ):(
      <>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))",gap:16,marginBottom:24}}>
        <StatCard icon="💰" label="Total Revenue (incl. VAT)" value={fmtSAR(revenue)} color={C.primary} bg={C.primaryLight}/>
        <StatCard icon="🧾" label="VAT Collected (15%)" value={fmtSAR(vatCollected)} sub="Extracted from revenue" color={C.zatca} bg={C.zatcaLight}/>
        <StatCard icon="📦" label="Cost of Goods (COGS)" value={fmtSAR(cogs)} sub="Excl. VAT" color={C.warning} bg={C.warningLight}/>
        <StatCard icon="💸" label="Operating Expenses" value={fmtSAR(opExpenses)} color={C.danger} bg={C.dangerLight}/>
        <StatCard icon="📊" label="Gross Profit" value={fmtSAR(grossProfit)} sub={`${grossMargin}% margin`} color={grossProfit>=0?C.success:C.danger} bg={grossProfit>=0?C.successLight:C.dangerLight}/>
        <StatCard icon="🏆" label="Net Profit" value={fmtSAR(netProfit)} sub={`${netMargin}% margin`} color={netProfit>=0?C.success:C.danger} bg={netProfit>=0?C.successLight:C.dangerLight}/>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
        <Card>
          <div style={{fontSize:14,fontWeight:700,marginBottom:16}}>💳 Payment Breakdown</div>
          {payBreakdown.map(p=>(
            <div key={p.method} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 0",borderBottom:`1px solid ${C.border}`}}>
              <div><div style={{fontSize:13,fontWeight:600}}>{p.method}</div><div style={{fontSize:11,color:C.textLight}}>{p.count} transactions</div></div>
              <strong style={{color:C.primary}}>{fmtSAR(p.total)}</strong>
            </div>
          ))}
        </Card>
        <Card>
          <div style={{fontSize:14,fontWeight:700,marginBottom:16}}>📊 P&L Summary</div>
          {[["Revenue (excl. VAT)",revenueExclVat,C.primary,false],["Cost of Goods Sold",-cogs,C.warning,false],["Gross Profit",grossProfit,grossProfit>=0?C.success:C.danger,false],["Operating Expenses",-opExpenses,C.danger,false],["Net Profit / (Loss)",netProfit,netProfit>=0?C.success:C.danger,true]].map(([label,val,color,isFinal])=>(
            <div key={label} style={{display:"flex",justifyContent:"space-between",padding:"10px 0",borderBottom:!isFinal?`1px solid ${C.border}`:"none",borderTop:isFinal?`2px solid ${C.border}`:"none",fontWeight:isFinal?800:400}}>
              <span style={{fontSize:13,color:isFinal?C.text:C.textMid}}>{label}</span>
              <span style={{fontWeight:700,color}}>{val<0?"(":""}{fmtSAR(Math.abs(val))}{val<0?")":""}</span>
            </div>
          ))}
        </Card>
      </div>
      </>
      )}
    </div>
  );
}
