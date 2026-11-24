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
import { purchaseRegister, supplierBalances } from "../lib/purchaseReports.js";
import { getSyncStatus, SYNC_FIELD_BUDGET_BYTES } from "../lib/sync.js";
import { catalogueSubEnabled, setCatalogueSubEnabled } from "../lib/catalogueFlag.js";
import { computePO, matchThreeWay, addReceipt } from "../lib/purchaseOrders.js";
import { postReceiptToStock } from "../lib/costing.js";
import { loadPurchaseOrders, savePurchaseOrder, deletePurchaseOrder } from "../lib/poStore.js";
import { findByBarcode } from "../lib/barcode.js";

export function InventoryManagement({items,setItems,lang="en",initialTab="overview"}){
  const _t=s=>t(s,lang);
  const [tab,setTab]=useState(initialTab);
  const [search,setSearch]=useState("");
  const [lowThreshold,setLowThreshold]=useState(()=>parseInt(localStorage.getItem("restopos_low_stock_threshold")||"10"));
  const [movements,setMovements]=useState(()=>LS.get("restopos_stock_movements")||[]);
  const [suppliers,setSuppliers]=useState(()=>LS.get("restopos_suppliers")||[]);
  const [adjItem,setAdjItem]=useState(null); // item being adjusted
  const [adjQty,setAdjQty]=useState("");
  const [adjType,setAdjType]=useState("in"); // in | out
  const [adjReason,setAdjReason]=useState("");
  const [adjSupplier,setAdjSupplier]=useState("");
  const [newSupplier,setNewSupplier]=useState({name:"",vatNumber:"",crNumber:"",phone:"",email:"",address:"",notes:""});
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
  const [repFrom,setRepFrom]=useState(""); // purchase-report date filter (empty = all time)
  const [repTo,setRepTo]=useState("");
  const [syncTick,setSyncTick]=useState(0); // bump to re-read live sync status

  // ── Purchase orders + goods receipt + 3-way match ──────────────────────────
  const blankPOLine=()=>({name:"",qty:"",unitCost:"",receivedQty:""});
  const blankPO=()=>({supplierId:"",supplierName:"",poNumber:"",date:new Date().toISOString().slice(0,10),notes:"",lines:[blankPOLine()]});
  const [orders,setOrders]=useState(()=>loadPurchaseOrders());
  const [showPOModal,setShowPOModal]=useState(false);
  const [poDraft,setPODraft]=useState(blankPO);
  const [receivePO,setReceivePO]=useState(null); // computed PO being received (goods receipt)
  const [receiveNow,setReceiveNow]=useState({});  // {lineIndex: qty received in THIS delivery}
  const [matchPO,setMatchPO]=useState(null);      // PO being matched
  const [matchInvId,setMatchInvId]=useState("");  // invoice linked for the match

  function openNewPO(){ setPODraft(blankPO()); setShowPOModal(true); }
  // Editing a line's name resolves it to a catalogue product (exact, case-insensitive)
  // so received goods can post to stock; pre-fills unit cost from the item when blank.
  function setPOLine(i,patch){
    setPODraft(d=>({...d,lines:d.lines.map((l,j)=>{
      if(j!==i)return l;
      const nl={...l,...patch};
      if("name" in patch){
        // Resolve a scanned barcode OR an exact product name to a catalogue item.
        // A barcode match wins (so scanning a code pulls up the product by name),
        // then an exact case-insensitive name match. On a barcode hit the typed
        // code is replaced with the product's own name, so the line reads the item.
        const typed=String(patch.name||"").trim();
        const m=findByBarcode(items,typed)||items.find(it=>String(it.name||"").trim().toLowerCase()===typed.toLowerCase());
        if(m)nl.name=m.name;
        nl.itemId=m?m.id:undefined;
        if(m&&(nl.unitCost===""||nl.unitCost==null))nl.unitCost=m.cost!=null?String(m.cost):nl.unitCost;
      }
      return nl;
    })}));
  }
  function addPOLine(){ setPODraft(d=>({...d,lines:[...d.lines,blankPOLine()]})); }
  function removePOLine(i){ setPODraft(d=>({...d,lines:d.lines.length>1?d.lines.filter((_,j)=>j!==i):d.lines})); }
  function onPickPOSupplier(id){ const s=suppliers.find(x=>x.id===id); setPODraft(d=>({...d,supplierId:id,supplierName:s?s.name:""})); }
  function submitPO(){
    if(!poDraft.supplierId&&!String(poDraft.supplierName).trim())return alert(_t("Choose a supplier."));
    if(!String(poDraft.poNumber).trim())return alert(_t("Enter a PO number."));
    if(!poDraft.lines.some(l=>parseFloat(l.qty)>0))return alert(_t("Add at least one line with a quantity."));
    savePurchaseOrder(poDraft); setOrders(loadPurchaseOrders()); setShowPOModal(false);
  }
  function removePO(id){ if(confirm(_t("Delete this purchase order")+"?")) setOrders(deletePurchaseOrder(id)); }
  function openReceive(po){ setReceivePO(computePO(po)); setReceiveNow({}); }
  function submitReceive(){
    const recv=receivePO.lines.map((l,i)=>({name:l.name,itemId:l.itemId,qty:parseFloat(receiveNow[i])||0,unitCost:parseFloat(l.unitCost)||0})).filter(l=>l.qty>0);
    if(recv.length===0)return alert(_t("Enter at least one received quantity."));
    // Record the delivery on the PO (history) …
    savePurchaseOrder(addReceipt(receivePO,{lines:recv.map(({name,itemId,qty})=>({name,itemId,qty}))}));
    setOrders(loadPurchaseOrders());
    // … and post it to stock (weighted-average cost) for lines that map to a product.
    const {items:newItems,posted,unmatched}=postReceiptToStock(items,recv);
    if(posted.length)setItems(newItems);
    setReceivePO(null);
    if(unmatched.length)alert(`${_t("Received")}. ${_t("Posted to stock")}: ${posted.length}. ${_t("No matching product (recorded on the PO only)")}: ${unmatched.length}.`);
  }
  function openMatch(po){ setMatchPO(po); setMatchInvId(""); }

  function openNewPurchase(docType="invoice"){ setDraft({...blankPurchase(),docType}); setDupWarn(null); setShowPurchaseModal(true); }
  const isCN=normDocType(draft.docType)==="credit_note"; // current draft is a credit note?
  function setDraftLine(i,patch){
    setDraft(d=>({...d,lines:d.lines.map((l,j)=>{
      if(j!==i)return l;
      const nl={...l,...patch};
      if("name" in patch){
        // Scanning a barcode here used to just dump the raw digits into the line.
        // Resolve it (barcode first, then exact name) to the catalogue item so the
        // line shows the product and pre-fills its cost — the code becomes the name.
        const typed=String(patch.name||"").trim();
        const m=findByBarcode(items,typed)||items.find(it=>String(it.name||"").trim().toLowerCase()===typed.toLowerCase());
        if(m){
          nl.name=m.name;
          nl.itemId=m.id;
          if(nl.unitCost===""||nl.unitCost==null)nl.unitCost=m.cost!=null?String(m.cost):nl.unitCost;
        }else{
          nl.itemId=undefined;
        }
      }
      return nl;
    })}));
    setDupWarn(null);
  }
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
    const vn=String(newSupplier.vatNumber||"").replace(/\s/g,"");
    if(vn&&!/^\d{15}$/.test(vn))return alert("A Saudi VAT number is 15 digits. Leave it blank if the supplier isn't VAT-registered.");
    saveSuppliers([{id:"SUP-"+Date.now(),...newSupplier,vatNumber:vn},...suppliers]);
    setNewSupplier({name:"",vatNumber:"",crNumber:"",phone:"",email:"",address:"",notes:""});setShowSupplierModal(false);
  }

  const tabs=[["overview","📊 "+_t("Overview")],["stock","📦 "+_t("Stock Levels")],["movements","🔄 "+_t("Movements")],["suppliers","🏭 "+_t("Suppliers")],...(showPurchases?[["orders","📋 "+_t("Orders")],["purchases","🧾 "+_t("Purchases")],["preports","📈 "+_t("Purchase Reports")],["synchealth","☁️ "+_t("Sync Health")]]:[])];
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
          <DataTable headers={[_t("Name"),_t("VAT No."),_t("CR No."),_t("Phone"),_t("Email"),_t("Notes"),_t("Actions")]} rows={suppliers.map(s=>[
            <strong>{s.name}</strong>,<span style={{fontFamily:"monospace"}}>{s.vatNumber||"—"}</span>,<span style={{fontFamily:"monospace"}}>{s.crNumber||"—"}</span>,s.phone||"—",s.email||"—",s.notes||"—",
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
          {(()=>{ const net=purchases.reduce((a,p)=>{const s=signedAmounts(p);return{total:a.total+s.total,vat:a.vat+s.vatAmount};},{total:0,vat:0}); return(
            <div style={{display:"flex",justifyContent:"flex-end",gap:18,marginTop:10,fontSize:12.5,color:C.textMid}}>
              <span>{_t("Net input VAT")}: <strong style={{color:C.text}}>{fmtSAR(net.vat)}</strong></span>
              <span>{_t("Net payable")}: <strong style={{color:C.text}}>{fmtSAR(net.total)}</strong></span>
            </div>
          );})()}
        </>)}
      </Card>}

      {/* PURCHASE ORDERS (+ goods receipt + 3-way match) */}
      {showPurchases&&tab==="orders"&&<Card>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6,flexWrap:"wrap",gap:8}}>
          <div style={{fontSize:14,fontWeight:800}}>📋 {_t("Purchase Orders")} ({orders.length})</div>
          <Btn size="sm" onClick={openNewPO}>+ {_t("New Purchase Order")}</Btn>
        </div>
        <div style={{fontSize:11.5,color:C.textMid,marginBottom:12}}>{_t("What you ordered. Record goods as they arrive, then 3-way match the supplier invoice to catch short deliveries, over-billing and price changes before you pay.")}</div>
        {orders.length===0?(
          <div style={{padding:"20px",textAlign:"center",color:C.textMid,fontSize:13}}>{_t("No purchase orders yet.")}</div>
        ):(
          <DataTable headers={[_t("PO #"),_t("Supplier"),_t("Date"),_t("Ordered"),_t("Receipt"),""]} rows={orders.slice(0,200).map(po0=>{
            const po=computePO(po0); // derive status/value live (robust to cloud-restored data)
            const rb={open:[C.textMid,C.bg],partial:[C.warning,C.warningLight],received:[C.success,C.successLight]}[po.receiptStatus]||[C.textMid,C.bg];
            return [
              <strong>{po.poNumber||"—"}</strong>,
              po.supplierName||"—",
              po.date?fmtDate(po.date):"—",
              fmtSAR(po.orderedValue||0),
              <Badge color={rb[0]} bg={rb[1]}>{_t(po.receiptStatus==="received"?"Received":po.receiptStatus==="partial"?"Partial":"Open")}{po.receiptCount>0?` (${po.receiptCount})`:""}</Badge>,
              <div style={{display:"flex",gap:5}}>
                <Btn size="sm" variant="outline" onClick={()=>openReceive(po)}>📥 {_t("Receive")}</Btn>
                <Btn size="sm" variant="ghost" onClick={()=>openMatch(computePO(po))}>🔍 {_t("Match")}</Btn>
                <Btn size="sm" variant="danger" onClick={()=>removePO(po.id)}>✕</Btn>
              </div>
            ];
          })}/>
        )}
      </Card>}

      {/* NEW PO MODAL */}
      {showPOModal&&(()=>{ const c=computePO(poDraft); const inSty={padding:"9px 11px",border:`1px solid ${C.border}`,borderRadius:8,fontFamily:"inherit",fontSize:13.5,background:"#fff"}; return(
        <Modal title={"📋 "+_t("New Purchase Order")} onClose={()=>setShowPOModal(false)} width={720}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:12}}>
            <select value={poDraft.supplierId} onChange={e=>onPickPOSupplier(e.target.value)} style={inSty}>
              <option value="">{_t("Select supplier")+" *"}</option>
              {suppliers.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <input value={poDraft.poNumber} onChange={e=>setPODraft(d=>({...d,poNumber:e.target.value}))} placeholder={_t("PO number")+" *"} style={inSty}/>
            <input type="date" value={poDraft.date} onChange={e=>setPODraft(d=>({...d,date:e.target.value}))} style={inSty}/>
          </div>
          {suppliers.length===0&&<div style={{fontSize:12,color:C.warning,marginBottom:10}}>{_t("Add a supplier first on the Suppliers tab.")}</div>}
          <div style={{fontSize:12.5,fontWeight:800,margin:"6px 0 4px"}}>{_t("Order lines")} <span style={{fontWeight:500,color:C.textLight,fontSize:11}}>· {_t("pick a catalogue item (🔗) so received goods post to stock")}</span></div>
          <datalist id="po-item-names">{items.map(it=><option key={it.id} value={it.name}/>)}</datalist>
          <div style={{display:"flex",flexDirection:"column",gap:7,marginBottom:10}}>
            {poDraft.lines.map((l,i)=>{ const cl=c.lines[i]||{}; const linked=l.itemId!=null; return(
              <div key={i} style={{display:"grid",gridTemplateColumns:"2.4fr 0.9fr 1fr 1fr auto",gap:6,alignItems:"center"}}>
                <input list="po-item-names" value={l.name} onChange={e=>setPOLine(i,{name:e.target.value})} placeholder={(linked?"🔗 ":"")+_t("Item / description")} title={linked?_t("Linked to a catalogue item — will post to stock"):_t("Not linked — won't post to stock")} style={{...inSty,borderColor:linked?C.success:C.border}}/>
                <input type="number" value={l.qty} onChange={e=>setPOLine(i,{qty:e.target.value})} placeholder={_t("Qty")} min={0} style={{...inSty,textAlign:"right"}}/>
                <input type="number" value={l.unitCost} onChange={e=>setPOLine(i,{unitCost:e.target.value})} placeholder={_t("Unit cost")} min={0} style={{...inSty,textAlign:"right"}}/>
                <div style={{fontSize:13,fontWeight:700,textAlign:"right"}}>{fmtSAR(cl.lineTotal||0)}</div>
                <button onClick={()=>removePOLine(i)} style={{border:"none",background:"none",cursor:"pointer",fontSize:16,color:C.danger,opacity:poDraft.lines.length>1?1:0.3}}>✕</button>
              </div>
            );})}
          </div>
          <Btn size="sm" variant="outline" onClick={addPOLine}>+ {_t("Add line")}</Btn>
          <div style={{display:"flex",justifyContent:"flex-end",marginTop:14,fontWeight:900,fontSize:15}}>{_t("Ordered total")}: {fmtSAR(c.orderedValue)}</div>
          <div style={{display:"flex",gap:10,marginTop:14}}>
            <Btn variant="ghost" style={{flex:1}} onClick={()=>setShowPOModal(false)}>{_t("Cancel")}</Btn>
            <Btn style={{flex:1}} onClick={submitPO}>{_t("Save Purchase Order")}</Btn>
          </div>
        </Modal>
      );})()}

      {/* GOODS RECEIPT MODAL */}
      {receivePO&&(()=>{ const inSty={padding:"8px 10px",border:`1px solid ${C.border}`,borderRadius:8,fontFamily:"inherit",fontSize:13,background:"#fff",width:90,textAlign:"right"}; return(
        <Modal title={"📥 "+_t("Receive Goods")+" — "+(receivePO.poNumber||"")} onClose={()=>setReceivePO(null)} width={600}>
          <div style={{fontSize:12,color:C.textMid,marginBottom:12}}>{_t("Record THIS delivery. Enter only what arrived now — each delivery is kept as a separate goods receipt.")}</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {receivePO.lines.map((l,i)=>{ const remaining=Math.max(0,(l.qty||0)-(l.receivedQty||0)); return(
              <div key={i} style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,padding:"8px 10px",background:C.bg,borderRadius:8}}>
                <div><div style={{fontSize:13,fontWeight:700}}>{l.name||"—"}</div><div style={{fontSize:11,color:C.textMid}}>{_t("Ordered")}: {l.qty} · {_t("Already received")}: {l.receivedQty} · {_t("Remaining")}: {remaining}</div></div>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:11,color:C.textMid}}>{_t("Receiving now")}</span>
                  <input type="number" min={0} placeholder="0" value={receiveNow[i]??""} onChange={e=>setReceiveNow(m=>({...m,[i]:e.target.value}))} style={inSty}/>
                </div>
              </div>
            );})}
          </div>
          {Array.isArray(receivePO.receipts)&&receivePO.receipts.length>0&&<div style={{marginTop:14}}>
            <div style={{fontSize:12,fontWeight:800,marginBottom:6}}>📜 {_t("Delivery history")} ({receivePO.receipts.length})</div>
            <div style={{display:"flex",flexDirection:"column",gap:4}}>
              {receivePO.receipts.map((r,ri)=>(
                <div key={r.id||ri} style={{fontSize:11.5,color:C.textMid,padding:"5px 10px",background:C.bg,borderRadius:6}}>
                  {r.date?fmtDate(r.date):"—"} · {r.lines.map(rl=>`${rl.name||"—"} ×${rl.qty}`).join(", ")}
                </div>
              ))}
            </div>
          </div>}
          <div style={{display:"flex",gap:10,marginTop:16}}>
            <Btn variant="ghost" style={{flex:1}} onClick={()=>setReceivePO(null)}>{_t("Cancel")}</Btn>
            <Btn style={{flex:1}} onClick={submitReceive}>{_t("Save Delivery")}</Btn>
          </div>
        </Modal>
      );})()}

      {/* 3-WAY MATCH MODAL */}
      {matchPO&&(()=>{
        const invChoices=purchases.filter(p=>normDocType(p.docType)!=="credit_note");
        const inv=invChoices.find(p=>p.id===matchInvId)||null;
        const m=inv?matchThreeWay(matchPO,inv):null;
        const sc={"ok":[C.success,C.successLight,"OK"],"short-receipt":[C.warning,C.warningLight,"Short"],"over-receipt":[C.warning,C.warningLight,"Over-recv"],"price-variance":[C.warning,C.warningLight,"Price"],"over-billed":[C.danger,C.dangerLight,"Over-billed"],"not-received":[C.danger,C.dangerLight,"Not recv"],"not-ordered":[C.danger,C.dangerLight,"Not ordered"]};
        const inSty={padding:"9px 11px",border:`1px solid ${C.border}`,borderRadius:8,fontFamily:"inherit",fontSize:13.5,background:"#fff"};
        return(
        <Modal title={"🔍 "+_t("3-Way Match")+" — "+(matchPO.poNumber||"")} onClose={()=>setMatchPO(null)} width={820}>
          <div style={{fontSize:12,color:C.textMid,marginBottom:10}}>{_t("Compare what was ordered and received against the supplier's invoice.")}</div>
          <select value={matchInvId} onChange={e=>setMatchInvId(e.target.value)} style={{...inSty,width:"100%",marginBottom:12}}>
            <option value="">{_t("Select the supplier invoice to match…")}</option>
            {invChoices.map(p=><option key={p.id} value={p.id}>{(p.supplierName||"—")+" · "+(p.supplierInvoiceNo||"—")+" · "+fmtSAR(p.total)+(p.invoiceDate?" · "+fmtDate(p.invoiceDate):"")}</option>)}
          </select>
          {!inv?(
            <div style={{padding:"20px",textAlign:"center",color:C.textMid,fontSize:13}}>{invChoices.length?_t("Pick an invoice above to run the match."):_t("No purchase invoices captured yet — add one on the Purchases tab.")}</div>
          ):(<>
            <div style={{marginBottom:10,padding:"10px 12px",borderRadius:8,fontSize:13,fontWeight:700,background:m.summary.hasIssues?C.dangerLight:C.successLight,color:m.summary.hasIssues?C.danger:C.success}}>
              {m.summary.hasIssues?`⚠️ ${m.summary.issues} ${_t("line(s) need attention")} · ${m.summary.matched} ${_t("OK")}`:`✅ ${_t("All")} ${m.summary.matched} ${_t("line(s) match")}`}
            </div>
            <DataTable headers={[_t("Item"),_t("Ordered"),_t("Received"),_t("Invoiced"),_t("PO cost"),_t("Inv cost"),_t("Δ price"),_t("Status")]} rows={m.lines.map(l=>{
              const s=sc[l.status]||[C.textMid,C.bg,l.status];
              return [
                l.name||"—", l.orderedQty, l.receivedQty, l.invoicedQty,
                l.expectedCost!=null?fmtSAR(l.expectedCost):"—",
                l.invoicedCost!=null?fmtSAR(l.invoicedCost):"—",
                <span style={{color:l.priceVariance?C.danger:C.textMid}}>{l.priceVariance?fmtSAR(l.priceVariance):"—"}</span>,
                <Badge color={s[0]} bg={s[1]}>{_t(s[2])}</Badge>
              ];
            })}/>
          </>)}
          <div style={{display:"flex",marginTop:16}}>
            <Btn variant="ghost" style={{flex:1}} onClick={()=>setMatchPO(null)}>{_t("Close")}</Btn>
          </div>
        </Modal>
      );})()}

      {/* SYNC HEALTH (cloud-backup status per key) */}
      {showPurchases&&tab==="synchealth"&&(()=>{
        void syncTick; // re-read on refresh
        const st=getSyncStatus();
        const entries=Object.values(st);
        const problems=entries.filter(e=>!e.ok);
        const budgetKB=Math.round(SYNC_FIELD_BUDGET_BYTES/1024);
        const kb=b=>Math.round((b||0)/1024);
        const fmtAt=a=>{try{return new Date(a).toLocaleString("en-SA",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"});}catch{return "—";}};
        return(<div style={{display:"flex",flexDirection:"column",gap:14}}>
          <Card>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,flexWrap:"wrap"}}>
              <div style={{fontSize:14,fontWeight:800}}>☁️ {_t("Cloud Backup Health")}</div>
              <Btn size="sm" variant="outline" onClick={()=>setSyncTick(n=>n+1)}>↻ {_t("Refresh")}</Btn>
            </div>
            <div style={{marginTop:10,padding:"12px 14px",borderRadius:10,fontSize:13,fontWeight:600,
              background:problems.length?C.dangerLight:(entries.length?C.successLight:C.bg),
              color:problems.length?C.danger:(entries.length?C.success:C.textMid)}}>
              {problems.length
                ? `⚠️ ${problems.length} ${_t("data set(s) are NOT backing up to the cloud.")}`
                : (entries.length
                    ? `✅ ${_t("All")} ${entries.length} ${_t("synced data set(s) are backing up normally.")}`
                    : _t("No cloud-sync activity yet this session. Make a change (or reopen the app) to populate this."))}
            </div>
            <div style={{fontSize:11,color:C.textLight,marginTop:8}}>{_t("Each data set must stay under the")} {budgetKB} KB {_t("per-key budget; a set that exceeds it stops backing up (it belongs in a subcollection). Status is for this session.")}</div>
            {(()=>{ void syncTick; const on=catalogueSubEnabled(); return(
              <div style={{marginTop:14,padding:"12px 14px",borderRadius:10,border:`1px solid ${on?C.primary:C.border}`,background:on?C.primaryLight:C.bg}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                  <div style={{fontSize:13,fontWeight:800}}>📦 {_t("Catalogue cloud storage (subcollection)")} — {on?_t("ON"):_t("OFF")}</div>
                  <Btn size="sm" variant={on?"danger":"primary"} onClick={()=>{
                    if(!on){ if(!confirm(_t("Turn ON for this whole account (all devices)? Back up the catalogue to the cloud FIRST (run the backfill), or products may be missing after reload. Continue?")))return; }
                    setCatalogueSubEnabled(!on); setSyncTick(n=>n+1);
                    alert(_t("Saved. It syncs to this account's other devices on their next load. Reload this device for it to take effect here."));
                  }}>{on?_t("Turn OFF"):_t("Turn ON")}</Btn>
                </div>
                <div style={{fontSize:11,color:C.textMid,marginTop:6}}>{_t("Stores the product catalogue as one document per product (for catalogues too large for the backup budget). This is an ACCOUNT-WIDE switch — it applies to every device on this licence. Back up first via the cutover runbook; validate on the emulator before using in production.")}</div>
              </div>
            );})()}
          </Card>

          {problems.length>0&&<Card>
            <div style={{fontSize:13,fontWeight:800,marginBottom:10,color:C.danger}}>⛔ {_t("Not backing up")}</div>
            <DataTable headers={[_t("Data set"),_t("Problem"),_t("Size"),_t("When")]} rows={problems.map(e=>[
              <code style={{fontSize:12}}>{e.key}</code>,
              e.reason==="oversize"
                ? <Badge color={C.danger} bg={C.dangerLight}>{_t("Too large")} ({kb(e.sizeBytes)} KB &gt; {budgetKB} KB)</Badge>
                : <Badge color={C.danger} bg={C.dangerLight}>{_t("Error")}: {e.message||"—"}</Badge>,
              e.sizeBytes?kb(e.sizeBytes)+" KB":"—",
              fmtAt(e.at)
            ])}/>
          </Card>}

          {entries.length>0&&<Card>
            <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>📋 {_t("All data sets")} ({entries.length})</div>
            <DataTable headers={[_t("Data set"),_t("Status"),_t("Size"),_t("Last attempt")]} rows={entries.sort((a,b)=>(a.ok===b.ok)?0:(a.ok?1:-1)).map(e=>[
              <code style={{fontSize:12}}>{e.key}</code>,
              e.ok?<Badge color={C.success} bg={C.successLight}>{_t("Backed up")}</Badge>:<Badge color={C.danger} bg={C.dangerLight}>{e.reason==="oversize"?_t("Too large"):_t("Error")}</Badge>,
              e.sizeBytes?kb(e.sizeBytes)+" KB":"—",
              fmtAt(e.at)
            ])}/>
          </Card>}
        </div>);
      })()}

      {/* PURCHASE REPORTS (register + supplier balances) */}
      {showPurchases&&tab==="preports"&&(()=>{
        const reg=purchaseRegister(purchases,{from:repFrom||undefined,to:repTo||undefined});
        const bals=supplierBalances(purchases,{from:repFrom||undefined,to:repTo||undefined});
        const inSty={padding:"8px 10px",border:`1px solid ${C.border}`,borderRadius:8,fontFamily:"inherit",fontSize:13,background:"#fff"};
        const stat=(label,value,color,sub)=>(
          <div style={{background:"#fff",border:`1px solid ${C.border}`,borderLeft:`4px solid ${color}`,borderRadius:12,padding:"12px 14px",flex:1,minWidth:150}}>
            <div style={{fontSize:11,color:C.textMid,fontWeight:700}}>{label}</div>
            <div style={{fontSize:20,fontWeight:900,color,marginTop:3}}>{value}</div>
            {sub&&<div style={{fontSize:10,color:C.textLight,marginTop:2}}>{sub}</div>}
          </div>
        );
        return(<div style={{display:"flex",flexDirection:"column",gap:14}}>
          <Card>
            <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
              <div style={{fontSize:13,fontWeight:800}}>📈 {_t("Purchase Register")}</div>
              <span style={{fontSize:11,color:C.textMid}}>{_t("From")}</span>
              <input type="date" value={repFrom} onChange={e=>setRepFrom(e.target.value)} style={inSty}/>
              <span style={{fontSize:11,color:C.textMid}}>{_t("To")}</span>
              <input type="date" value={repTo} onChange={e=>setRepTo(e.target.value)} style={inSty}/>
              {(repFrom||repTo)&&<Btn size="sm" variant="ghost" onClick={()=>{setRepFrom("");setRepTo("");}}>{_t("Clear")}</Btn>}
              <span style={{fontSize:11,color:C.textLight}}>{reg.count} {_t("documents")} · {reg.totals.invoices} {_t("invoices")}, {reg.totals.creditNotes} {_t("credit notes")}</span>
            </div>
          </Card>
          <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
            {stat(_t("Net (ex-VAT)"),fmtSAR(reg.totals.net),C.info)}
            {stat(_t("Input VAT"),fmtSAR(reg.totals.vat),C.zatca,_t("Recoverable")+" "+fmtSAR(reg.totals.recoverableVat)+" · "+_t("Non")+" "+fmtSAR(reg.totals.nonRecoverableVat))}
            {stat(_t("Net Payable"),fmtSAR(reg.totals.gross),C.primary,_t("Invoices minus credit notes"))}
          </div>
          {reg.totals.nonRecoverableVat>0&&<div style={{fontSize:11.5,color:C.warning,padding:"8px 12px",background:C.warningLight,borderRadius:8}}>⚠️ {fmtSAR(reg.totals.nonRecoverableVat)} {_t("of input VAT is NOT recoverable — those suppliers were not marked as having issued a valid ZATCA e-invoice.")}</div>}

          <Card>
            <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>🏭 {_t("Supplier Balances")} ({bals.length})</div>
            {bals.length===0?(
              <div style={{padding:"18px",textAlign:"center",color:C.textMid,fontSize:13}}>{_t("No purchase documents in this period.")}</div>
            ):(
              <DataTable headers={[_t("Supplier"),_t("Invoices"),_t("Credit Notes"),_t("Balance"),_t("Docs"),_t("Last")]} rows={bals.map(b=>[
                <strong>{b.supplierName||"—"}</strong>,
                fmtSAR(b.invoiceTotal),
                fmtSAR(b.creditTotal),
                <strong style={{color:b.balance<0?C.danger:C.text}}>{fmtSAR(b.balance)}</strong>,
                b.docCount,
                b.lastDate?fmtDate(b.lastDate):"—"
              ])}/>
            )}
            <div style={{fontSize:10.5,color:C.textLight,marginTop:8}}>{_t("Balance = invoices − credit notes (before any supplier payments; payment tracking is a later feature).")}</div>
          </Card>

          <Card>
            <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>📄 {_t("Documents in period")} ({reg.count})</div>
            {reg.count===0?(
              <div style={{padding:"18px",textAlign:"center",color:C.textMid,fontSize:13}}>{_t("None.")}</div>
            ):(
              <DataTable headers={[_t("Date"),_t("Type"),_t("Supplier"),_t("Doc #"),_t("Net"),_t("VAT"),_t("Total")]} rows={reg.rows.slice(0,300).map(p=>{
                const cn=normDocType(p.docType)==="credit_note"; const s=signedAmounts(p);
                return [
                  p.invoiceDate?fmtDate(p.invoiceDate):"—",
                  cn?<Badge color={C.danger} bg={C.dangerLight}>{_t("Credit")}</Badge>:<Badge color={C.success} bg={C.successLight}>{_t("Invoice")}</Badge>,
                  p.supplierName||"—", p.supplierInvoiceNo||"—",
                  fmtSAR(s.subtotal), fmtSAR(s.vatAmount),
                  <strong style={cn?{color:C.danger}:undefined}>{fmtSAR(s.total)}</strong>
                ];
              })}/>
            )}
          </Card>
        </div>);
      })()}

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
            <div>
              <select value={draft.supplierId} onChange={e=>onPickSupplier(e.target.value)} style={{...inSty,width:"100%"}}>
                <option value="">{_t("Select supplier")+" *"}</option>
                {suppliers.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              {(()=>{const sel=suppliers.find(x=>x.id===draft.supplierId);return sel?(<div style={{fontSize:11,color:C.textMid,marginTop:4}}>{_t("VAT")}: <span style={{fontFamily:"monospace",color:sel.vatNumber?C.text:C.danger}}>{sel.vatNumber||_t("not set")}</span>{sel.crNumber?" · "+_t("CR")+" "+sel.crNumber:""}</div>):null;})()}
            </div>
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
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            <input value={newSupplier.vatNumber} onChange={e=>setNewSupplier(s=>({...s,vatNumber:e.target.value.replace(/\D/g,"").slice(0,15)}))} inputMode="numeric" placeholder={_t("VAT number (15 digits)")} style={{padding:"10px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontFamily:"monospace",fontSize:14}}/>
            <input value={newSupplier.crNumber} onChange={e=>setNewSupplier(s=>({...s,crNumber:e.target.value}))} placeholder={_t("CR number")} style={{padding:"10px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontFamily:"monospace",fontSize:14}}/>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            <input value={newSupplier.phone} onChange={e=>setNewSupplier(s=>({...s,phone:e.target.value}))} placeholder={_t("Phone")} style={{padding:"10px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontFamily:"inherit",fontSize:14}}/>
            <input value={newSupplier.email} onChange={e=>setNewSupplier(s=>({...s,email:e.target.value}))} placeholder={_t("Email")} style={{padding:"10px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontFamily:"inherit",fontSize:14}}/>
          </div>
          <input value={newSupplier.address} onChange={e=>setNewSupplier(s=>({...s,address:e.target.value}))} placeholder={_t("Address")} style={{padding:"10px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontFamily:"inherit",fontSize:14}}/>
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
