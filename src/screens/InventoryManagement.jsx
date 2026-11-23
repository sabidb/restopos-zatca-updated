// ═══════════════════════════════════════════════════════════════════
// INVENTORY MANAGEMENT — stock movements, suppliers, low-stock, adjustments.
// Extracted verbatim from App.jsx; markup and logic unchanged.
// ═══════════════════════════════════════════════════════════════════
import { useState } from "react";
import { C } from "../lib/theme.js";
import { LS } from "../lib/storage.js";
import { t } from "../i18n/index.js";
import { fmtSAR, fmtDate } from "../lib/format.js";
import { debouncedSync } from "../lib/sync.js";
import { Card, Btn, Badge, Modal, DataTable } from "../components/ui.jsx";
import { bizFeature } from "../config/businessTypes.js";
import { computePurchaseInvoice, validatePurchaseInvoice, detectDuplicatePurchase, signedAmounts, normDocType } from "../lib/purchases.js";
import { loadPurchaseInvoices, savePurchaseInvoice, deletePurchaseInvoice } from "../lib/purchaseStore.js";

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

  // ── Purchases (supplier/AP invoices) — Supermarket/Hypermarket only ─────────
  // Feature-flagged so Restaurant Mode's Inventory screen is unchanged.
  const showPurchases=bizFeature("purchasing");
  const blankLine=()=>({name:"",qty:"",unitCost:"",rate:0.15});
  const blankPurchase=()=>({supplierId:"",supplierName:"",docType:"invoice",supplierInvoiceNo:"",invoiceDate:new Date().toISOString().slice(0,10),hasValidEInvoice:false,notes:"",lines:[blankLine()]});
  const [purchases,setPurchases]=useState(()=>loadPurchaseInvoices());
  const [showPurchaseModal,setShowPurchaseModal]=useState(false);
  const [draft,setDraft]=useState(blankPurchase);
  const [dupWarn,setDupWarn]=useState(null); // { level:"exact"|"near", match } when a save is held

  function openNewPurchase(docType="invoice"){ setDraft({...blankPurchase(),docType}); setDupWarn(null); setShowPurchaseModal(true); }
  const isCN=normDocType(draft.docType)==="credit_note"; // current draft is a credit note?
  function setDraftLine(i,patch){ setDraft(d=>({...d,lines:d.lines.map((l,j)=>j===i?{...l,...patch}:l)})); setDupWarn(null); }
  function addDraftLine(){ setDraft(d=>({...d,lines:[...d.lines,blankLine()]})); }
  function removeDraftLine(i){ setDraft(d=>({...d,lines:d.lines.length>1?d.lines.filter((_,j)=>j!==i):d.lines})); setDupWarn(null); }
  function onPickSupplier(id){ const s=suppliers.find(x=>x.id===id); setDraft(d=>({...d,supplierId:id,supplierName:s?s.name:""})); setDupWarn(null); }

  // Save a purchase invoice. Validation blocks always; an EXACT duplicate (same
  // supplier + invoice number) and a NEAR duplicate (same supplier + total +
  // date) hold the save behind an explicit "save anyway" so the same supplier
  // invoice can't be entered twice by accident (which would double-count input VAT).
  function submitPurchase(force){
    const v=validatePurchaseInvoice(draft);
    if(!v.valid){
      const msg={"supplier-required":_t("Choose a supplier."),"invoice-number-required":_t("Enter the supplier's invoice number."),"invoice-date-required":_t("Enter the invoice date."),"no-lines":_t("Add at least one line with a quantity."),"negative-qty":_t("Quantity can't be negative."),"negative-cost":_t("Cost can't be negative.")};
      alert(v.errors.map(e=>msg[e]||e).join("\n"));
      return;
    }
    if(!force){
      const dup=detectDuplicatePurchase(draft,purchases);
      if(dup.duplicate){ setDupWarn(dup); return; }
    }
    savePurchaseInvoice(draft);
    setPurchases(loadPurchaseInvoices());
    setShowPurchaseModal(false); setDupWarn(null);
  }
  function removePurchase(id){ if(confirm(_t("Delete this purchase invoice")+"?")) setPurchases(deletePurchaseInvoice(id)); }

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

  const tabs=[["overview","📊 "+_t("Overview")],["stock","📦 "+_t("Stock Levels")],["movements","🔄 "+_t("Movements")],["suppliers","🏭 "+_t("Suppliers")],...(showPurchases?[["purchases","🧾 "+_t("Purchases")]]:[])];
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

      {/* PURCHASES (supplier / accounts-payable invoices) */}
      {showPurchases&&tab==="purchases"&&<Card>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6,flexWrap:"wrap",gap:8}}>
          <div style={{fontSize:14,fontWeight:800}}>🧾 {_t("Purchase Documents")} ({purchases.length})</div>
          <div style={{display:"flex",gap:6}}>
            <Btn size="sm" onClick={()=>openNewPurchase("invoice")}>+ {_t("Invoice")}</Btn>
            <Btn size="sm" variant="outline" onClick={()=>openNewPurchase("credit_note")}>+ {_t("Credit Note")}</Btn>
          </div>
        </div>
        <div style={{fontSize:11.5,color:C.textMid,marginBottom:12}}>{_t("Supplier invoices (what you owe) and credit notes (returns / overcharges that reduce it). These record input VAT — they are NOT sent to ZATCA; the supplier already reported them.")}</div>
        {purchases.length===0?(
          <div style={{padding:"20px",textAlign:"center",color:C.textMid,fontSize:13}}>{_t("No purchase documents yet.")}</div>
        ):(<>
          <DataTable headers={[_t("Date"),_t("Type"),_t("Supplier"),_t("Doc #"),_t("Net"),_t("VAT"),_t("Total"),""]} rows={purchases.slice(0,200).map(p=>{
            const cn=normDocType(p.docType)==="credit_note"; const s=signedAmounts(p);
            return [
              p.invoiceDate?fmtDate(p.invoiceDate):"—",
              cn?<Badge color={C.danger} bg={C.dangerLight}>{_t("Credit")}</Badge>:<Badge color={C.success} bg={C.successLight}>{_t("Invoice")}</Badge>,
              p.supplierName||"—",
              p.supplierInvoiceNo||"—",
              fmtSAR(s.subtotal),
              fmtSAR(s.vatAmount),
              <strong style={cn?{color:C.danger}:undefined}>{fmtSAR(s.total)}</strong>,
              <Btn size="sm" variant="danger" onClick={()=>removePurchase(p.id)}>{_t("Delete")}</Btn>
            ];
          })}/>
          {(()=>{ const net=purchases.reduce((a,p)=>{const s=signedAmounts(p);return{total:a.total+s.total,vat:a.vat+s.vat};},{total:0,vat:0}); return(
            <div style={{display:"flex",justifyContent:"flex-end",gap:18,marginTop:10,fontSize:12.5,color:C.textMid}}>
              <span>{_t("Net input VAT")}: <strong style={{color:C.text}}>{fmtSAR(net.vat)}</strong></span>
              <span>{_t("Net payable")}: <strong style={{color:C.text}}>{fmtSAR(net.total)}</strong></span>
            </div>
          );})()}
        </>)}
      </Card>}

      {/* PURCHASE INVOICE MODAL */}
      {showPurchaseModal&&(()=>{ const c=computePurchaseInvoice(draft); const inSty={padding:"9px 11px",border:`1px solid ${C.border}`,borderRadius:8,fontFamily:"inherit",fontSize:13.5,background:"#fff"}; return(
        <Modal title={"🧾 "+(isCN?_t("New Credit Note"):_t("New Purchase Invoice"))} onClose={()=>{setShowPurchaseModal(false);setDupWarn(null);}} width={760}>
          <div style={{display:"flex",gap:6,marginBottom:12}}>
            <button onClick={()=>{setDraft(d=>({...d,docType:"invoice"}));setDupWarn(null);}} style={{flex:1,padding:"8px 10px",borderRadius:8,border:`1.5px solid ${!isCN?C.success:C.border}`,background:!isCN?C.successLight:"#fff",color:!isCN?C.success:C.textMid,fontWeight:700,fontFamily:"inherit",fontSize:12.5,cursor:"pointer"}}>🧾 {_t("Purchase Invoice")}</button>
            <button onClick={()=>{setDraft(d=>({...d,docType:"credit_note"}));setDupWarn(null);}} style={{flex:1,padding:"8px 10px",borderRadius:8,border:`1.5px solid ${isCN?C.danger:C.border}`,background:isCN?C.dangerLight:"#fff",color:isCN?C.danger:C.textMid,fontWeight:700,fontFamily:"inherit",fontSize:12.5,cursor:"pointer"}}>↩️ {_t("Credit Note")}</button>
          </div>
          {isCN&&<div style={{fontSize:11.5,color:C.textMid,marginBottom:10,padding:"8px 11px",background:C.dangerLight,borderRadius:8}}>{_t("A credit note reduces what you owe this supplier and reduces recoverable input VAT (a return or overcharge correction).")}</div>}
          {dupWarn&&<div style={{padding:"12px 14px",borderRadius:10,marginBottom:14,border:`1.5px solid ${dupWarn.level==="exact"?C.danger:C.warning}`,background:dupWarn.level==="exact"?C.dangerLight:C.warningLight}}>
            <div style={{fontSize:13,fontWeight:800,color:dupWarn.level==="exact"?C.danger:C.warning}}>{dupWarn.level==="exact"?("⛔ "+_t("Possible duplicate document")):("⚠️ "+_t("Looks similar to an existing document"))}</div>
            <div style={{fontSize:12,color:C.textMid,marginTop:4}}>
              {(dupWarn.level==="exact"?_t("This supplier and document number are already recorded"):_t("Same supplier, total and date as an existing document"))}: <strong>{dupWarn.match.supplierName} · {dupWarn.match.supplierInvoiceNo||"—"} · {fmtSAR(computePurchaseInvoice(dupWarn.match).total)}</strong>. {_t("Entering it twice double-counts input VAT.")}
            </div>
            <div style={{display:"flex",gap:8,marginTop:10}}>
              <Btn size="sm" variant="ghost" onClick={()=>setDupWarn(null)}>{_t("Go back & edit")}</Btn>
              <Btn size="sm" variant="danger" onClick={()=>submitPurchase(true)}>{_t("Save anyway")}</Btn>
            </div>
          </div>}

          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
            <select value={draft.supplierId} onChange={e=>onPickSupplier(e.target.value)} style={inSty}>
              <option value="">{_t("Select supplier")+" *"}</option>
              {suppliers.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <input value={draft.supplierInvoiceNo} onChange={e=>{const v=e.target.value;setDraft(d=>({...d,supplierInvoiceNo:v}));setDupWarn(null);}} placeholder={(isCN?_t("Credit note #"):_t("Supplier invoice #"))+" *"} style={inSty}/>
            <input type="date" value={draft.invoiceDate} onChange={e=>{const v=e.target.value;setDraft(d=>({...d,invoiceDate:v}));setDupWarn(null);}} style={inSty}/>
            <label style={{display:"flex",alignItems:"center",gap:8,fontSize:12,color:C.textMid}}>
              <input type="checkbox" checked={draft.hasValidEInvoice} onChange={e=>setDraft(d=>({...d,hasValidEInvoice:e.target.checked}))}/>
              {_t("Supplier issued a valid ZATCA e-invoice (input VAT recoverable)")}
            </label>
          </div>
          {suppliers.length===0&&<div style={{fontSize:12,color:C.warning,marginBottom:10}}>{_t("Add a supplier first on the Suppliers tab.")}</div>}

          <div style={{fontSize:12.5,fontWeight:800,margin:"6px 0 8px"}}>{_t("Lines")} <span style={{fontWeight:500,color:C.textLight,fontSize:11}}>· {_t("unit cost is ex-VAT; VAT is added on top")}</span></div>
          <div style={{display:"flex",flexDirection:"column",gap:7,marginBottom:10}}>
            {draft.lines.map((l,i)=>{ const cl=c.lines[i]||{}; return(
              <div key={i} style={{display:"grid",gridTemplateColumns:"2fr 0.8fr 1fr 0.9fr 1fr auto",gap:6,alignItems:"center"}}>
                <input value={l.name} onChange={e=>setDraftLine(i,{name:e.target.value})} placeholder={_t("Item / description")} style={inSty}/>
                <input type="number" value={l.qty} onChange={e=>setDraftLine(i,{qty:e.target.value})} placeholder={_t("Qty")} min={0} style={{...inSty,textAlign:"right"}}/>
                <input type="number" value={l.unitCost} onChange={e=>setDraftLine(i,{unitCost:e.target.value})} placeholder={_t("Unit cost")} min={0} style={{...inSty,textAlign:"right"}}/>
                <select value={l.rate} onChange={e=>setDraftLine(i,{rate:parseFloat(e.target.value)})} style={inSty}>
                  <option value={0.15}>15%</option>
                  <option value={0}>0%</option>
                </select>
                <div style={{fontSize:13,fontWeight:700,textAlign:"right"}}>{fmtSAR(cl.gross||0)}</div>
                <button onClick={()=>removeDraftLine(i)} title={_t("Remove")} style={{border:"none",background:"none",cursor:"pointer",fontSize:16,color:C.danger,opacity:draft.lines.length>1?1:0.3}}>✕</button>
              </div>
            );})}
          </div>
          <Btn size="sm" variant="outline" onClick={addDraftLine}>+ {_t("Add line")}</Btn>

          <div style={{display:"flex",justifyContent:"flex-end",marginTop:14}}>
            <div style={{minWidth:220,fontSize:13}}>
              <div style={{display:"flex",justifyContent:"space-between",padding:"3px 0",color:C.textMid}}><span>{_t("Net (ex-VAT)")}</span><span>{fmtSAR(c.subtotal)}</span></div>
              <div style={{display:"flex",justifyContent:"space-between",padding:"3px 0",color:C.textMid}}><span>{_t("Input VAT")}</span><span>{fmtSAR(c.vatAmount)}</span></div>
              <div style={{display:"flex",justifyContent:"space-between",padding:"6px 0",fontWeight:900,fontSize:15,borderTop:`1px solid ${C.border}`,marginTop:4}}><span>{_t("Total")}</span><span>{fmtSAR(c.total)}</span></div>
            </div>
          </div>

          <div style={{display:"flex",gap:10,marginTop:14}}>
            <Btn variant="ghost" style={{flex:1}} onClick={()=>{setShowPurchaseModal(false);setDupWarn(null);}}>{_t("Cancel")}</Btn>
            <Btn style={{flex:1}} onClick={()=>submitPurchase(false)}>{isCN?_t("Save Credit Note"):_t("Save Purchase Invoice")}</Btn>
          </div>
        </Modal>
      );})()}

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
