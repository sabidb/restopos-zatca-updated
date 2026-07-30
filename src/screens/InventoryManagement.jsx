// ═══════════════════════════════════════════════════════════════════
// INVENTORY MANAGEMENT — stock movements, suppliers, low-stock, adjustments.
// Extracted verbatim from App.jsx; markup and logic unchanged.
// ═══════════════════════════════════════════════════════════════════
import { useState } from "react";
import { C } from "../lib/theme.js";
import { LS } from "../lib/storage.js";
import { t } from "../i18n/index.js";
import { fmtSAR } from "../lib/format.js";
import { debouncedSync } from "../lib/sync.js";

export function InventoryManagement({items,setItems,lang="en"}){
  const _t=s=>t(s,lang);
  const [tab,setTab]=useState("overview");
  const [search,setSearch]=useState("");
  const [lowThreshold,setLowThreshold]=useState(()=>parseInt(localStorage.getItem("restopos_low_stock_threshold")||"10"));
  const [movements,setMovements]=useState(()=>LS.get("restopos_stock_movements")||[]);
  const [suppliers,setSuppliers]=useState(()=>LS.get("restopos_suppliers")||[]);
  const [adjItem,setAdjItem]=useState(null); // item being adjusted
  const [adjQty,setAdjQty]=useState("");
  const [adjType,setAdjType]=useState("in"); // in | out
  const [adjReason,setAdjReason]=useState("");
  const [adjSupplier,setAdjSupplier]=useState("");
  const [newSupplier,setNewSupplier]=useState({name:"",phone:"",email:"",notes:""});
  const [showSupplierModal,setShowSupplierModal]=useState(false);

  function saveMovements(list){setMovements(list);LS.set("restopos_stock_movements",list);const lk=LS.get("restopos_license_v2")?.licenseKey;if(lk)debouncedSync(lk,"restopos_stock_movements",list);}
  function saveSuppliers(list){setSuppliers(list);LS.set("restopos_suppliers",list);const lk=LS.get("restopos_license_v2")?.licenseKey;if(lk)debouncedSync(lk,"restopos_suppliers",list);}
  function saveThreshold(v){setLowThreshold(v);localStorage.setItem("restopos_low_stock_threshold",String(v));}

  // Derived stats — recompute live from items so data is always current.
  const totalItems=items.length;
  const totalUnits=items.reduce((s,i)=>s+(Number(i.stock)||0),0);
  const totalValue=items.reduce((s,i)=>s+(Number(i.stock)||0)*(Number(i.cost)||Number(i.price)||0),0);
  const retailValue=items.reduce((s,i)=>s+(Number(i.stock)||0)*(Number(i.price)||0),0);
  const lowStock=items.filter(i=>(Number(i.stock)||0)>0&&(Number(i.stock)||0)<=lowThreshold);
  const outOfStock=items.filter(i=>(Number(i.stock)||0)<=0);

  const filtered=items.filter(i=>{
    const q=search.trim().toLowerCase();
    return !q||i.name?.toLowerCase().includes(q)||String(i.barcode||"").includes(q)||i.category?.toLowerCase().includes(q);
  });

  // Apply a stock adjustment (in/out) → updates item.stock (syncs) + logs a movement.
  function applyAdjustment(){
    const qty=parseInt(adjQty);
    if(!adjItem||!qty||qty<=0)return alert("Enter a valid quantity.");
    const delta=adjType==="in"?qty:-qty;
    const current=Number(adjItem.stock)||0;
    const next=Math.max(0,current+delta);
    setItems(prev=>prev.map(i=>i.id===adjItem.id?{...i,stock:next}:i));
    const movement={
      id:"MV-"+Date.now(),itemId:adjItem.id,itemName:adjItem.name,
      type:adjType,qty,before:current,after:next,
      reason:adjReason||(adjType==="in"?"Stock received":"Stock removed"),
      supplier:adjType==="in"?adjSupplier:"",
      at:new Date().toISOString(),
    };
    saveMovements([movement,...movements].slice(0,5000));
    setAdjItem(null);setAdjQty("");setAdjReason("");setAdjSupplier("");
  }

  function addSupplier(){
    if(!newSupplier.name.trim())return alert("Supplier name required.");
    saveSuppliers([{id:"SUP-"+Date.now(),...newSupplier},...suppliers]);
    setNewSupplier({name:"",phone:"",email:"",notes:""});setShowSupplierModal(false);
  }

  const tabs=[["overview","📊 "+_t("Overview")],["stock","📦 "+_t("Stock Levels")],["movements","🔄 "+_t("Movements")],["suppliers","🏭 "+_t("Suppliers")]];
  const statCard=(label,value,color,sub)=>(
    <div style={{background:"#fff",border:`1px solid ${C.border}`,borderLeft:`4px solid ${color}`,borderRadius:12,padding:"14px 16px",flex:1,minWidth:150}}>
      <div style={{fontSize:11,color:C.textMid,fontWeight:700}}>{label}</div>
      <div style={{fontSize:22,fontWeight:900,color,marginTop:3}}>{value}</div>
      {sub&&<div style={{fontSize:10,color:C.textLight,marginTop:2}}>{sub}</div>}
    </div>
  );

  return(
    <div>
      <div style={{fontSize:20,fontWeight:900,marginBottom:4}}>📦 {_t("Inventory Management")}</div>
      <div style={{fontSize:12.5,color:C.textMid,marginBottom:18}}>{_t("Live stock levels, alerts, movements, suppliers and value. Every change syncs automatically.")}</div>

      <div style={{display:"flex",gap:8,marginBottom:18,flexWrap:"wrap"}}>
        {tabs.map(([id,label])=><button key={id} onClick={()=>setTab(id)} style={{padding:"8px 16px",borderRadius:8,border:`1.5px solid ${tab===id?C.primary:C.border}`,background:tab===id?C.primaryLight:"#fff",color:tab===id?C.primary:C.textMid,fontFamily:"inherit",fontSize:13,fontWeight:600,cursor:"pointer"}}>{label}</button>)}
      </div>

      {/* OVERVIEW */}
      {tab==="overview"&&<div style={{display:"flex",flexDirection:"column",gap:14}}>
        <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
          {statCard(_t("Total Items"),totalItems,C.info)}
          {statCard(_t("Units in Stock"),totalUnits.toLocaleString(),C.primary)}
          {statCard(_t("Stock Value (cost)"),fmtSAR(totalValue),C.zatca,_t("Based on cost price"))}
          {statCard(_t("Retail Value"),fmtSAR(retailValue),C.success,_t("Based on selling price"))}
        </div>
        <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
          {statCard("⚠️ "+_t("Low Stock"),lowStock.length,C.warning,_t("At or below")+" "+lowThreshold)}
          {statCard("⛔ "+_t("Out of Stock"),outOfStock.length,C.danger)}
        </div>
        <Card>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
            <div style={{fontSize:13,fontWeight:800}}>⚠️ {_t("Low-Stock Threshold")}</div>
            <input type="number" value={lowThreshold} min={1} onChange={e=>saveThreshold(parseInt(e.target.value)||1)} style={{width:80,padding:"6px 10px",border:`1px solid ${C.border}`,borderRadius:8,fontFamily:"inherit",fontSize:13}}/>
            <span style={{fontSize:11,color:C.textMid}}>{_t("units or fewer = low stock")}</span>
          </div>
          {lowStock.length===0&&outOfStock.length===0?(
            <div style={{padding:"14px",background:C.successLight,borderRadius:8,fontSize:13,color:C.success,fontWeight:600}}>✅ {_t("All items are well stocked.")}</div>
          ):(
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {[...outOfStock,...lowStock].slice(0,30).map(i=>(
                <div key={i.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 12px",background:(Number(i.stock)||0)<=0?C.dangerLight:C.warningLight,borderRadius:8}}>
                  <div><span style={{fontSize:13,fontWeight:700}}>{i.name}</span> <span style={{fontSize:11,color:C.textMid}}>· {i.category}</span></div>
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    <span style={{fontSize:13,fontWeight:800,color:(Number(i.stock)||0)<=0?C.danger:C.warning}}>{Number(i.stock)||0} {_t("left")}</span>
                    <Btn size="sm" variant="outline" onClick={()=>{setAdjItem(i);setAdjType("in");setTab("stock");}}>+ {_t("Restock")}</Btn>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>}

      {/* STOCK LEVELS */}
      {tab==="stock"&&<Card>
        <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap"}}>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder={"🔍 "+_t("Search items")} style={{flex:1,minWidth:180,padding:"9px 12px",border:`1px solid ${C.border}`,borderRadius:9,fontSize:13,fontFamily:"inherit"}}/>
        </div>
        <DataTable headers={[_t("Item"),_t("Category"),_t("Stock"),_t("Cost"),_t("Value"),_t("Actions")]} rows={filtered.map(i=>{
          const st=Number(i.stock)||0;
          const stColor=st<=0?C.danger:st<=lowThreshold?C.warning:C.success;
          return[
            i.name,
            <Badge color={C.info} bg={C.infoLight}>{i.category}</Badge>,
            <strong style={{color:stColor}}>{st}</strong>,
            fmtSAR(Number(i.cost)||0),
            fmtSAR(st*(Number(i.cost)||Number(i.price)||0)),
            <div style={{display:"flex",gap:5}}>
              <Btn size="sm" variant="outline" onClick={()=>{setAdjItem(i);setAdjType("in");}}>➕ {_t("In")}</Btn>
              <Btn size="sm" variant="ghost" onClick={()=>{setAdjItem(i);setAdjType("out");}}>➖ {_t("Out")}</Btn>
            </div>
          ];
        })} emptyMsg={_t("No items")}/>
      </Card>}

      {/* MOVEMENTS */}
      {tab==="movements"&&<Card>
        <div style={{fontSize:14,fontWeight:800,marginBottom:12}}>🔄 {_t("Stock Movements")} ({movements.length})</div>
        {movements.length===0?(
          <div style={{padding:"20px",textAlign:"center",color:C.textMid,fontSize:13}}>{_t("No stock movements yet. Use + In / – Out on the Stock Levels tab.")}</div>
        ):(
          <DataTable headers={[_t("Date"),_t("Item"),_t("Type"),_t("Qty"),_t("Before"),_t("After"),_t("Reason"),_t("Supplier")]} rows={movements.slice(0,200).map(m=>[
            new Date(m.at).toLocaleString("en-SA",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}),
            m.itemName,
            <Badge color={m.type==="in"?C.success:C.danger} bg={m.type==="in"?C.successLight:C.dangerLight}>{m.type==="in"?"IN":"OUT"}</Badge>,
            m.qty,m.before,m.after,m.reason||"—",m.supplier||"—"
          ])}/>
        )}
      </Card>}

      {/* SUPPLIERS */}
      {tab==="suppliers"&&<Card>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <div style={{fontSize:14,fontWeight:800}}>🏭 {_t("Suppliers")} ({suppliers.length})</div>
          <Btn size="sm" onClick={()=>setShowSupplierModal(true)}>+ {_t("New Supplier")}</Btn>
        </div>
        {suppliers.length===0?(
          <div style={{padding:"20px",textAlign:"center",color:C.textMid,fontSize:13}}>{_t("No suppliers yet.")}</div>
        ):(
          <DataTable headers={[_t("Name"),_t("Phone"),_t("Email"),_t("Notes"),_t("Actions")]} rows={suppliers.map(s=>[
            <strong>{s.name}</strong>,s.phone||"—",s.email||"—",s.notes||"—",
            <Btn size="sm" variant="danger" onClick={()=>{if(confirm(_t("Delete supplier")+"?"))saveSuppliers(suppliers.filter(x=>x.id!==s.id));}}>{_t("Delete")}</Btn>
          ])}/>
        )}
      </Card>}

      {/* ADJUSTMENT MODAL */}
      {adjItem&&<Modal title={(adjType==="in"?"➕ "+_t("Stock In"):"➖ "+_t("Stock Out"))+" — "+adjItem.name} onClose={()=>setAdjItem(null)} width={420}>
        <div style={{fontSize:12.5,color:C.textMid,marginBottom:14}}>{_t("Current stock")}: <strong>{Number(adjItem.stock)||0}</strong></div>
        <div style={{display:"flex",gap:8,marginBottom:12}}>
          <button onClick={()=>setAdjType("in")} style={{flex:1,padding:10,borderRadius:8,border:`1.5px solid ${adjType==="in"?C.success:C.border}`,background:adjType==="in"?C.successLight:"#fff",color:adjType==="in"?C.success:C.text,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>➕ {_t("Stock In")}</button>
          <button onClick={()=>setAdjType("out")} style={{flex:1,padding:10,borderRadius:8,border:`1.5px solid ${adjType==="out"?C.danger:C.border}`,background:adjType==="out"?C.dangerLight:"#fff",color:adjType==="out"?C.danger:C.text,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>➖ {_t("Stock Out")}</button>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          <input type="number" value={adjQty} onChange={e=>setAdjQty(e.target.value)} placeholder={_t("Quantity")} min={1} style={{padding:"10px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontFamily:"inherit",fontSize:14}}/>
          <input value={adjReason} onChange={e=>setAdjReason(e.target.value)} placeholder={_t("Reason (optional)")} style={{padding:"10px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontFamily:"inherit",fontSize:14}}/>
          {adjType==="in"&&<select value={adjSupplier} onChange={e=>setAdjSupplier(e.target.value)} style={{padding:"10px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontFamily:"inherit",fontSize:14,background:"#fff"}}>
            <option value="">{_t("Supplier (optional)")}</option>
            {suppliers.map(s=><option key={s.id} value={s.name}>{s.name}</option>)}
          </select>}
          {adjQty&&parseInt(adjQty)>0&&<div style={{fontSize:12,color:C.textMid,padding:"8px 12px",background:C.bg,borderRadius:8}}>{_t("New stock will be")}: <strong style={{color:adjType==="in"?C.success:C.danger}}>{Math.max(0,(Number(adjItem.stock)||0)+(adjType==="in"?parseInt(adjQty):-parseInt(adjQty)))}</strong></div>}
        </div>
        <div style={{display:"flex",gap:10,marginTop:16}}>
          <Btn variant="ghost" style={{flex:1}} onClick={()=>setAdjItem(null)}>{_t("Cancel")}</Btn>
          <Btn style={{flex:1}} onClick={applyAdjustment}>{_t("Apply")}</Btn>
        </div>
      </Modal>}

      {/* SUPPLIER MODAL */}
      {showSupplierModal&&<Modal title={"🏭 "+_t("New Supplier")} onClose={()=>setShowSupplierModal(false)} width={420}>
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          <input value={newSupplier.name} onChange={e=>setNewSupplier(s=>({...s,name:e.target.value}))} placeholder={_t("Supplier name")+" *"} style={{padding:"10px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontFamily:"inherit",fontSize:14}}/>
          <input value={newSupplier.phone} onChange={e=>setNewSupplier(s=>({...s,phone:e.target.value}))} placeholder={_t("Phone")} style={{padding:"10px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontFamily:"inherit",fontSize:14}}/>
          <input value={newSupplier.email} onChange={e=>setNewSupplier(s=>({...s,email:e.target.value}))} placeholder={_t("Email")} style={{padding:"10px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontFamily:"inherit",fontSize:14}}/>
          <input value={newSupplier.notes} onChange={e=>setNewSupplier(s=>({...s,notes:e.target.value}))} placeholder={_t("Notes")} style={{padding:"10px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontFamily:"inherit",fontSize:14}}/>
        </div>
        <div style={{display:"flex",gap:10,marginTop:16}}>
          <Btn variant="ghost" style={{flex:1}} onClick={()=>setShowSupplierModal(false)}>{_t("Cancel")}</Btn>
          <Btn style={{flex:1}} onClick={addSupplier}>{_t("Add Supplier")}</Btn>
        </div>
      </Modal>}
    </div>
  );
}
