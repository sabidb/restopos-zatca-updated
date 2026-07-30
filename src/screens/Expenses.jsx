// ═══════════════════════════════════════════════════════════════════
// EXPENSES — expense tracking with categories, period filter, CSV export.
// Extracted verbatim from App.jsx; markup and logic unchanged.
// ═══════════════════════════════════════════════════════════════════
import { useState } from "react";
import { C } from "../lib/theme.js";
import { LS } from "../lib/storage.js";
import { t } from "../i18n/index.js";
import { fmtSAR } from "../lib/format.js";
import { TODAY } from "../lib/date.js";
import { logActivity } from "../lib/activity.js";
import { debouncedSync } from "../lib/sync.js";
import { Card, Btn, Inp, Sel, Modal, Badge, DataTable } from "../components/ui.jsx";

const EXPENSE_CATEGORIES=["Rent","Utilities","Salaries","Food Supplies","Kitchen Supplies","Packaging","Marketing","Maintenance","Transport","Other"];
export function Expenses({embedded=false,lang="en"}){
  const _t=s=>t(s,lang);
  const [expenses,setExpenses]=useState(()=>LS.get("restopos_expenses")||[]);
  const [showModal,setShowModal]=useState(false);
  const [period,setPeriod]=useState("month");
  const [form,setForm]=useState({description:"",amount:"",category:"Food Supplies",date:TODAY,notes:""});
  const now=new Date();
  function saveExpenses(newList){setExpenses(newList);LS.set("restopos_expenses",newList);const _lic_exp=LS.get("restopos_license_v2")?.licenseKey;if(_lic_exp)debouncedSync(_lic_exp,"restopos_expenses",newList);}
  function addExpense(){
    if(!form.description||!form.amount)return alert("Description and amount required");
    const exp={...form,id:Date.now(),amount:parseFloat(form.amount)};
    const updated=[exp,...expenses];saveExpenses(updated);setShowModal(false);
    setForm({description:"",amount:"",category:"Food Supplies",date:TODAY,notes:""});
    logActivity("EXPENSE_ADDED",{after:{description:form.description,amount:form.amount}},"Admin");
  }
  function deleteExpense(id){if(confirm("Delete expense?"))saveExpenses(expenses.filter(e=>e.id!==id));}
  const filtered=expenses.filter(e=>{
    const d=new Date(e.date);
    if(period==="today")return e.date===TODAY;
    if(period==="week"){const w=new Date();w.setDate(w.getDate()-7);return d>=w;}
    if(period==="month")return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear();
    return true;
  });
  const total=filtered.reduce((s,e)=>s+e.amount,0);
  const byCat=EXPENSE_CATEGORIES.map(cat=>({cat,total:filtered.filter(e=>e.category===cat).reduce((s,e)=>s+e.amount,0)})).filter(c=>c.total>0);
  function exportExpenses(){
    if(!expenses.length)return alert("No expenses to export");
    const headers=["Date","Description","Category","Amount","Notes"];
    const rows=filtered.map(e=>[e.date,e.description,e.category,e.amount.toFixed(2),e.notes||""]);
    const csv=[headers,...rows].map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
    const blob=new Blob([csv],{type:"text/csv"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=`expenses-${TODAY}.csv`;a.click();
  }
  return(
    <div>
      {showModal&&<Modal title="➕ Add Expense" onClose={()=>setShowModal(false)} width={460}>
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          <Inp label="Description" value={form.description} onChange={v=>setForm(f=>({...f,description:v}))} placeholder="e.g. Chicken supplier invoice"/>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
            <Inp label="Amount (SAR)" value={form.amount} onChange={v=>setForm(f=>({...f,amount:v}))} type="number" placeholder="0.00"/>
            <Inp label="Date" value={form.date} onChange={v=>setForm(f=>({...f,date:v}))} type="date"/>
          </div>
          <Sel label="Category" value={form.category} onChange={v=>setForm(f=>({...f,category:v}))} options={EXPENSE_CATEGORIES}/>
          <div style={{display:"flex",flexDirection:"column",gap:4}}>
            <label style={{fontSize:12,fontWeight:600,color:C.textMid}}>Notes (optional)</label>
            <textarea value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} rows={2} placeholder="Extra details..." style={{padding:"9px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontFamily:"inherit",resize:"none"}}/>
          </div>
        </div>
        <div style={{display:"flex",gap:10,marginTop:16}}>
          <Btn variant="ghost" onClick={()=>setShowModal(false)} style={{flex:1}}>Cancel</Btn>
          <Btn onClick={addExpense} style={{flex:1}}>💾 Save Expense</Btn>
        </div>
      </Modal>}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20,flexWrap:"wrap",gap:10}}>
        <div><div style={{fontSize:20,fontWeight:800}}>💸 Expense Tracking</div><div style={{fontSize:13,color:C.textMid,marginTop:2}}>{filtered.length} entries · Total: <strong style={{color:C.danger}}>{fmtSAR(total)}</strong></div></div>
        <div style={{display:"flex",gap:8}}>
          <Btn variant="outline" size="sm" onClick={exportExpenses}>📤 Export CSV</Btn>
          <Btn onClick={()=>setShowModal(true)}>+ Add Expense</Btn>
        </div>
      </div>
      <div style={{display:"flex",gap:6,marginBottom:16,flexWrap:"wrap"}}>
        {[["today","Today"],["week","This Week"],["month","This Month"],["all","All Time"]].map(([id,lbl])=>(
          <button key={id} onClick={()=>setPeriod(id)} style={{padding:"7px 16px",borderRadius:8,border:`1.5px solid ${period===id?C.danger:C.border}`,background:period===id?"#FDE8E8":"#fff",color:period===id?C.danger:C.textMid,fontFamily:"inherit",fontSize:13,fontWeight:600,cursor:"pointer"}}>{lbl}</button>
        ))}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20,marginBottom:20}}>
        <Card>
          <div style={{fontSize:13,fontWeight:700,color:C.textMid,marginBottom:12}}>BY CATEGORY</div>
          {byCat.length===0?<div style={{color:C.textLight,fontSize:13}}>No expenses</div>:byCat.map(c=>(
            <div key={c.cat} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:`1px solid ${C.border}`}}>
              <span style={{fontSize:13,color:C.text}}>{c.cat}</span>
              <span style={{fontSize:13,fontWeight:700,color:C.danger}}>{fmtSAR(c.total)}</span>
            </div>
          ))}
        </Card>
        <Card>
          <div style={{fontSize:13,fontWeight:700,color:C.textMid,marginBottom:12}}>SUMMARY</div>
          <div style={{fontSize:32,fontWeight:900,color:C.danger,marginBottom:8}}>{fmtSAR(total)}</div>
          <div style={{fontSize:12,color:C.textLight}}>Total expenses · {filtered.length} entries</div>
          <div style={{marginTop:16,fontSize:13,color:C.textMid}}>Period: {{"today":"Today","week":"Last 7 Days","month":"This Month","all":"All Time"}[period]}</div>
        </Card>
      </div>
      {filtered.length===0?<Card><div style={{textAlign:"center",padding:"40px 0",color:C.textMid}}><div style={{fontSize:40,marginBottom:12}}>💸</div><div>No expenses in this period</div></div></Card>
      :<Card><DataTable headers={["Date","Description","Category","Amount","Notes","Action"]} rows={filtered.map(e=>[
        <span style={{fontFamily:"monospace",fontSize:12}}>{e.date}</span>,
        <span style={{fontWeight:600}}>{e.description}</span>,
        <Badge color={C.info} bg={C.infoLight}>{e.category}</Badge>,
        <strong style={{color:C.danger}}>{fmtSAR(e.amount)}</strong>,
        <span style={{fontSize:12,color:C.textLight}}>{e.notes||"—"}</span>,
        <Btn size="sm" variant="danger" onClick={()=>deleteExpense(e.id)}>Del</Btn>
      ])}/></Card>}
    </div>
  );
}
