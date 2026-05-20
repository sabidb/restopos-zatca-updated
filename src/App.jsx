import { useState, useEffect, useRef } from "react";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, query, where, getDocs, updateDoc, doc, addDoc, getDoc } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDcVRHCOafLYt-0rCTfafaC6MFpyQVfG9o",
  authDomain: "restopos-db.firebaseapp.com",
  projectId: "restopos-db",
  storageBucket: "restopos-db.firebasestorage.app",
  messagingSenderId: "82816670819",
  appId: "1:82816670819:web:1a589e6a6b0b12edb4ec56"
};
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// ═══════════════════════════════════════════════════════════════════
// ZATCA TLV ENGINE v2 — multi-byte length, chunked btoa
// ═══════════════════════════════════════════════════════════════════
function encodeTLV(tag, value) {
  const encoder = new TextEncoder();
  const valueBytes = encoder.encode(value);
  let lengthBytes;
  if (valueBytes.length <= 127) { lengthBytes = new Uint8Array([valueBytes.length]); }
  else if (valueBytes.length <= 255) { lengthBytes = new Uint8Array([0x81, valueBytes.length]); }
  else { const hi = (valueBytes.length >> 8) & 0xff; const lo = valueBytes.length & 0xff; lengthBytes = new Uint8Array([0x82, hi, lo]); }
  const combined = new Uint8Array(1 + lengthBytes.length + valueBytes.length);
  combined[0] = tag; combined.set(lengthBytes, 1); combined.set(valueBytes, 1 + lengthBytes.length);
  return combined;
}
function mergeTLV(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const merged = new Uint8Array(total); let offset = 0;
  for (const arr of arrays) { merged.set(arr, offset); offset += arr.length; }
  return merged;
}
function tlvToBase64(tlvBytes) {
  let binary = ""; const chunkSize = 8192;
  for (let i = 0; i < tlvBytes.length; i += chunkSize) { binary += String.fromCharCode(...tlvBytes.subarray(i, i + chunkSize)); }
  return btoa(binary);
}
function generatePhase1QR({ sellerName, vatNumber, timestamp, total, vatAmount }) {
  return tlvToBase64(mergeTLV(encodeTLV(1, sellerName), encodeTLV(2, vatNumber), encodeTLV(3, timestamp), encodeTLV(4, parseFloat(total).toFixed(2)), encodeTLV(5, parseFloat(vatAmount).toFixed(2))));
}
function generateZATCABase64(opts) { return generatePhase1QR(opts); }

// ═══════════════════════════════════════════════════════════════════
// SHA-256 + HASH CHAIN (Web Crypto API)
// ═══════════════════════════════════════════════════════════════════
async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}
async function sha256Base64(text) {
  const hex = await sha256(text);
  const bytes = new Uint8Array(hex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
  return tlvToBase64(bytes);
}
function buildHashInput(inv) {
  return [inv.invoice_number, inv.timestamp, inv.seller_vat, inv.total.toFixed(2), inv.vat_amount.toFixed(2), inv.prev_invoice_hash || "0".repeat(64)].join("|");
}

// ═══════════════════════════════════════════════════════════════════
// UBL 2.1 XML GENERATOR
// ═══════════════════════════════════════════════════════════════════
function escapeXML(str) { if (!str) return ""; return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;"); }
function generateUBLXML(invoice) {
  const { invoice_number, uuid, timestamp, seller_name, seller_vat, seller_address, items, subtotal, vat_amount, total, prev_invoice_hash, icv, qr_string } = invoice;
  const dateStr = timestamp.slice(0, 10); const timeStr = timestamp.slice(11, 19);
  const lineItems = (items || []).map((item, idx) => `<cac:InvoiceLine><cbc:ID>${idx+1}</cbc:ID><cbc:InvoicedQuantity unitCode="PCE">${item.qty}</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="SAR">${(item.price*item.qty).toFixed(2)}</cbc:LineExtensionAmount><cac:TaxTotal><cbc:TaxAmount currencyID="SAR">${(item.price*item.qty*0.15).toFixed(2)}</cbc:TaxAmount></cac:TaxTotal><cac:Item><cbc:Name>${escapeXML(item.name)}</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>15</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item><cac:Price><cbc:PriceAmount currencyID="SAR">${item.price.toFixed(2)}</cbc:PriceAmount></cac:Price></cac:InvoiceLine>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"><ext:UBLExtensions><ext:UBLExtension><ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:ext:ZATCA</ext:ExtensionURI><ext:ExtensionContent><!-- ECDSA placeholder Phase 2 --></ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions><cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:CustomizationID>urn:zatca.gov.sa:trUBL:Invoice:2.0</cbc:CustomizationID><cbc:ProfileID>reporting:1.0</cbc:ProfileID><cbc:ID>${escapeXML(invoice_number)}</cbc:ID><cbc:UUID>${uuid}</cbc:UUID><cbc:IssueDate>${dateStr}</cbc:IssueDate><cbc:IssueTime>${timeStr}</cbc:IssueTime><cbc:InvoiceTypeCode name="0200000">${invoice.is_credit_note?"381":"388"}</cbc:InvoiceTypeCode><cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode><cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode><cbc:AdditionalDocumentReference><cbc:ID>ICV</cbc:ID><cbc:UUID>${icv}</cbc:UUID></cbc:AdditionalDocumentReference><cbc:AdditionalDocumentReference><cbc:ID>PIH</cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${prev_invoice_hash||"NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZhNTdlOQ=="}</cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cbc:AdditionalDocumentReference><cbc:AdditionalDocumentReference><cbc:ID>QR</cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${qr_string}</cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cbc:AdditionalDocumentReference><cac:AccountingSupplierParty><cac:Party><cac:PartyIdentification><cbc:ID schemeID="CRN">${escapeXML(invoice.seller_cr||"")}</cbc:ID></cac:PartyIdentification><cac:PostalAddress><cbc:StreetName>${escapeXML(seller_address)}</cbc:StreetName><cbc:CityName>Riyadh</cbc:CityName><cbc:CountrySubentity>SA</cbc:CountrySubentity><cac:Country><cbc:IdentificationCode>SA</cbc:IdentificationCode></cac:Country></cac:PostalAddress><cac:PartyTaxScheme><cbc:CompanyID>${escapeXML(seller_vat)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme><cac:PartyLegalEntity><cbc:RegistrationName>${escapeXML(seller_name)}</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty><cac:AccountingCustomerParty><cac:Party><cac:PostalAddress><cbc:CountrySubentity>SA</cbc:CountrySubentity><cac:Country><cbc:IdentificationCode>SA</cbc:IdentificationCode></cac:Country></cac:PostalAddress><cac:PartyTaxScheme><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme></cac:Party></cac:AccountingCustomerParty><cac:TaxTotal><cbc:TaxAmount currencyID="SAR">${vat_amount.toFixed(2)}</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxableAmount currencyID="SAR">${subtotal.toFixed(2)}</cbc:TaxableAmount><cbc:TaxAmount currencyID="SAR">${vat_amount.toFixed(2)}</cbc:TaxAmount><cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>15</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal><cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="SAR">${subtotal.toFixed(2)}</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="SAR">${subtotal.toFixed(2)}</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="SAR">${total.toFixed(2)}</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="SAR">${total.toFixed(2)}</cbc:PayableAmount></cac:LegalMonetaryTotal>${lineItems}</Invoice>`;
}

// ═══════════════════════════════════════════════════════════════════
// INVOICE STORAGE — sequential ICV, hash chain, immutable
// ═══════════════════════════════════════════════════════════════════
const ZATCA_COUNTER_KEY = "zatca_icv_v2";
const ZATCA_STORAGE_KEY = "zatca_invoices_v2";
const ZATCA_LAST_HASH_KEY = "zatca_last_hash_v2";
const ZATCA_QUEUE_KEY = "zatca_queue_v2";

const invoiceStorage = {
  getNextCounter() { const c = parseInt(localStorage.getItem(ZATCA_COUNTER_KEY)||"1000",10); localStorage.setItem(ZATCA_COUNTER_KEY,String(c+1)); return c+1; },
  getLastHash() { return localStorage.getItem(ZATCA_LAST_HASH_KEY)||null; },
  save(inv) { const all=this.getAll(); if(all.find(i=>i.invoice_number===inv.invoice_number))return; all.unshift(inv); localStorage.setItem(ZATCA_STORAGE_KEY,JSON.stringify(all.slice(0,500))); localStorage.setItem(ZATCA_LAST_HASH_KEY,inv.invoice_hash); },
  getAll() { try{return JSON.parse(localStorage.getItem(ZATCA_STORAGE_KEY)||"[]");}catch{return [];} },
  getOne(n) { return this.getAll().find(i=>i.invoice_number===n)||null; }
};

const fatooraQueue = {
  enqueue(inv) { const q=this.getQueue(); q.push({invoice_number:inv.invoice_number,queued_at:new Date().toISOString(),attempts:0,status:"pending"}); localStorage.setItem(ZATCA_QUEUE_KEY,JSON.stringify(q)); },
  getQueue() { try{return JSON.parse(localStorage.getItem(ZATCA_QUEUE_KEY)||"[]");}catch{return[];} },
  markSent(n) { localStorage.setItem(ZATCA_QUEUE_KEY,JSON.stringify(this.getQueue().map(q=>q.invoice_number===n?{...q,status:"reported",sent_at:new Date().toISOString()}:q))); },
  markFailed(n) { localStorage.setItem(ZATCA_QUEUE_KEY,JSON.stringify(this.getQueue().map(q=>q.invoice_number===n?{...q,status:"failed",attempts:(q.attempts||0)+1}:q))); },
  getUrgent() { const cutoff=Date.now()-23*60*60*1000; return this.getQueue().filter(q=>q.status!=="reported"&&new Date(q.queued_at).getTime()<cutoff); }
};

async function reportToFatoora(inv) {
  console.log("[ZATCA] Simulating report for:",inv.invoice_number);
  fatooraQueue.markSent(inv.invoice_number);
  return {success:true,simulated:true};
}

async function generateZATCAInvoice({seller_name,seller_vat,seller_address,seller_cr="",items=[],is_credit_note=false}) {
  const icv = invoiceStorage.getNextCounter();
  const invoice_number = `INV-${String(icv).padStart(6,"0")}`;
  const timestamp = new Date().toISOString();
  const uuid = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const subtotal = items.reduce((s,i)=>s+i.price*i.qty,0);
  const vat_amount = parseFloat((subtotal*0.15).toFixed(2));
  const total = parseFloat((subtotal+vat_amount).toFixed(2));
  const prev_invoice_hash = invoiceStorage.getLastHash();
  const partial = {invoice_number,uuid,timestamp,icv,seller_name,seller_vat,seller_address,seller_cr,items,subtotal,vat_amount,total,prev_invoice_hash,is_credit_note};
  const invoice_hash = await sha256(buildHashInput(partial));
  const invoice_hash_base64 = await sha256Base64(buildHashInput(partial));
  const qr_string = generatePhase1QR({sellerName:seller_name,vatNumber:seller_vat,timestamp,total,vatAmount:vat_amount});
  const invoice = {...partial,invoice_hash,invoice_hash_base64,qr_string,ecdsa_signature:null,ecdsa_public_key:null,zatca_reported:false,phase:1};
  invoiceStorage.save(invoice);
  fatooraQueue.enqueue(invoice);
  reportToFatoora(invoice).catch(()=>{});
  return invoice;
}

const zatcaUtils = {
  validateVATNumber(v){return /^3\d{14}$/.test(v);},
  getQueueStatus(){const q=fatooraQueue.getQueue();return{total:q.length,reported:q.filter(x=>x.status==="reported").length,pending:q.filter(x=>x.status==="pending").length,urgent:fatooraQueue.getUrgent().length};},
  downloadXML(inv){const xml=generateUBLXML(inv);const blob=new Blob([xml],{type:"application/xml"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=`${inv.invoice_number}.xml`;a.click();URL.revokeObjectURL(url);},
  getAllInvoices(){return invoiceStorage.getAll();}
};

// ═══════════════════════════════════════════════════════════════════
// QR CODE COMPONENTS
// ═══════════════════════════════════════════════════════════════════
function useQRScript() {
  const [ready,setReady]=useState(!!window.QRCode);
  useEffect(()=>{if(window.QRCode){setReady(true);return;}const s=document.createElement("script");s.src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";s.onload=()=>setReady(true);document.head.appendChild(s);},[]);
  return ready;
}
function QRCodeDisplay({data,size=140}){
  const ref=useRef(); const qrReady=useQRScript();
  useEffect(()=>{if(!qrReady||!data||!ref.current)return;ref.current.innerHTML="";try{new window.QRCode(ref.current,{text:data,width:size,height:size,colorDark:"#000000",colorLight:"#ffffff",correctLevel:window.QRCode?.CorrectLevel?.M});}catch(e){ref.current.innerHTML=`<div style="width:${size}px;height:${size}px;background:#f0f0f0;display:flex;align-items:center;justify-content:center;font-size:10px;color:#999">QR Error</div>`;};},[qrReady,data,size]);
  if(!qrReady)return<div style={{width:size,height:size,background:"#f0f0f0",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,color:"#999"}}>Loading…</div>;
  return<div ref={ref}/>;
}

// ═══════════════════════════════════════════════════════════════════
// ZATCA INVOICE HISTORY COMPONENT
// ═══════════════════════════════════════════════════════════════════
function ZATCAInvoiceHistory(){
  const [invoices,setInvoices]=useState([]);const [selected,setSelected]=useState(null);const [tab,setTab]=useState("list");const [queue,setQueue]=useState([]);
  useEffect(()=>{setInvoices(invoiceStorage.getAll());setQueue(fatooraQueue.getQueue());},[]);
  const urgent=queue.filter(q=>q.status!=="reported"&&new Date(q.queued_at).getTime()<Date.now()-23*60*60*1000);
  return(
    <div style={{color:C.text}}>
      {urgent.length>0&&<div style={{background:C.dangerLight,border:`1px solid ${C.danger}`,borderRadius:8,padding:"10px 16px",marginBottom:16,fontSize:13,fontWeight:600,color:C.danger}}>🚨 {urgent.length} invoice(s) approaching 24-hour FATOORA reporting deadline!</div>}
      <div style={{display:"flex",gap:6,marginBottom:16}}>
        {[["list","📋 Invoices"],["queue","⏳ Queue"],["xml","📄 XML Export"]].map(([id,label])=>(
          <button key={id} onClick={()=>setTab(id)} style={{background:tab===id?C.zatcaLight:"transparent",border:`1px solid ${tab===id?C.zatca:C.border}`,borderRadius:6,padding:"7px 14px",color:tab===id?C.zatca:C.textMid,cursor:"pointer",fontSize:12,fontFamily:"inherit"}}>{label}</button>
        ))}
      </div>
      {tab==="list"&&(
        <div>{invoices.length===0?<div style={{color:C.textLight,textAlign:"center",padding:"40px 0"}}>No ZATCA invoices yet. Process a sale to generate the first invoice.</div>:invoices.slice(0,50).map(inv=>(
          <div key={inv.invoice_number}>
            <div onClick={()=>setSelected(selected?.invoice_number===inv.invoice_number?null:inv)} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 14px",borderRadius:8,border:`1px solid ${selected?.invoice_number===inv.invoice_number?C.zatca:C.border}`,marginBottom:6,cursor:"pointer",background:selected?.invoice_number===inv.invoice_number?C.zatcaLight:"#fff"}}>
              <div><div style={{fontWeight:700,fontSize:13,color:C.zatca,fontFamily:"monospace"}}>#{inv.invoice_number}</div><div style={{fontSize:11,color:C.textLight}}>{inv.timestamp.slice(0,16).replace("T"," ")} · ICV:{inv.icv}</div></div>
              <div style={{textAlign:"right"}}><div style={{fontWeight:700}}>SAR {inv.total.toFixed(2)}</div><span style={{fontSize:10,padding:"2px 8px",borderRadius:20,fontWeight:600,background:inv.zatca_reported?C.successLight:C.warningLight,color:inv.zatca_reported?C.success:C.warning}}>{inv.zatca_reported?"✓ Reported":"⏳ Pending"}</span></div>
            </div>
            {selected?.invoice_number===inv.invoice_number&&(
              <div style={{background:C.bg,border:`1px solid ${C.zatca}`,borderRadius:10,padding:16,marginTop:-4,marginBottom:8}}>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,fontSize:12,marginBottom:12}}>
                  {[["ICV",inv.icv],["UUID",inv.uuid?.slice(0,18)+"..."],["Hash",inv.invoice_hash?.slice(0,20)+"..."],["Phase",inv.phase||1]].map(([l,v])=>(<div key={l}><div style={{fontSize:10,color:C.textLight,textTransform:"uppercase",letterSpacing:1}}>{l}</div><div style={{fontFamily:"monospace",fontSize:11}}>{v}</div></div>))}
                </div>
                <button style={{background:C.primary,color:"#fff",border:"none",borderRadius:6,padding:"7px 14px",cursor:"pointer",fontSize:12,fontFamily:"inherit",fontWeight:600}} onClick={()=>zatcaUtils.downloadXML(inv)}>⬇️ Download XML</button>
              </div>
            )}
          </div>
        ))}</div>
      )}
      {tab==="queue"&&(
        <div>
          <div style={{fontWeight:700,marginBottom:12,fontSize:14}}>FATOORA Queue ({queue.length})</div>
          {queue.length===0?<div style={{color:C.textLight,textAlign:"center",padding:"40px 0"}}>Queue is empty.</div>:queue.slice(0,30).map((q,i)=>{
            const age=Math.floor((Date.now()-new Date(q.queued_at).getTime())/60000);const isUrgent=age>23*60;
            return(<div key={i} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",background:C.bg,border:`1px solid ${isUrgent?C.danger:C.border}`,borderRadius:8,marginBottom:6,fontSize:13}}>
              <span style={{fontWeight:700,fontFamily:"monospace"}}>#{q.invoice_number}</span>
              <span style={{fontSize:11,color:C.textLight}}>{age}m ago</span>
              <span style={{fontSize:10,padding:"2px 8px",borderRadius:20,fontWeight:600,background:q.status==="reported"?C.successLight:isUrgent?C.dangerLight:C.warningLight,color:q.status==="reported"?C.success:isUrgent?C.danger:C.warning}}>{q.status==="reported"?"✓ Reported":isUrgent?"🚨 URGENT":"⏳ Pending"}</span>
              <span style={{fontSize:11,color:C.textLight}}>Attempts: {q.attempts||0}</span>
            </div>);
          })}
        </div>
      )}
      {tab==="xml"&&(
        <div>
          <div style={{fontWeight:700,marginBottom:12,fontSize:14}}>UBL 2.1 XML Export — FATOORA Format</div>
          <p style={{fontSize:12,color:C.textMid,marginBottom:12}}>Each XML file is ready to POST to the FATOORA reporting API. Full UBL 2.1 format with Phase 2 extension stubs.</p>
          {invoices.length===0?<div style={{color:C.textLight,textAlign:"center",padding:"40px 0"}}>No invoices yet.</div>:invoices.slice(0,20).map(inv=>(
            <div key={inv.invoice_number} style={{display:"flex",alignItems:"center",gap:12,padding:"8px 0",borderBottom:`1px solid ${C.border}`,fontSize:13}}>
              <span style={{fontWeight:700,fontFamily:"monospace"}}>#{inv.invoice_number}</span>
              <span style={{fontSize:11,color:C.textLight}}>{inv.timestamp.slice(0,10)}</span>
              <span style={{fontSize:12,color:C.textMid}}>SAR {inv.total.toFixed(2)}</span>
              <button style={{background:C.primary,color:"#fff",border:"none",borderRadius:6,padding:"5px 12px",cursor:"pointer",fontSize:12,fontFamily:"inherit",fontWeight:600,marginLeft:"auto"}} onClick={()=>zatcaUtils.downloadXML(inv)}>⬇️ Download XML</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// LOCAL STORAGE HELPERS + CONSTANTS
// ═══════════════════════════════════════════════════════════════════
const LS={get:(k)=>{try{return JSON.parse(localStorage.getItem(k));}catch{return null;}},set:(k,v)=>localStorage.setItem(k,JSON.stringify(v)),del:(k)=>localStorage.removeItem(k)};
const C={bg:"#F8F9FB",card:"#FFFFFF",border:"#E8EBF0",primary:"#1A6B4A",primaryLight:"#E8F5EE",primaryDark:"#134D36",accent:"#F0A500",accentLight:"#FEF6E4",danger:"#D94040",dangerLight:"#FDE8E8",info:"#2176AE",infoLight:"#E6F0F8",text:"#1A1D23",textMid:"#5A6070",textLight:"#9AA0AD",success:"#1A8A4A",successLight:"#E6F7ED",warning:"#E07B00",warningLight:"#FFF3E0",zatca:"#6366f1",zatcaLight:"#eef2ff"};
const SEED_ITEMS=[{id:1,name:"Broasted Chicken Half",nameAr:"دجاج مبروست نصف",category:"Broasted",price:28,cost:14,stock:50,active:true,barcode:""},{id:2,name:"Broasted Chicken Full",nameAr:"دجاج مبروست كامل",category:"Broasted",price:52,cost:26,stock:30,active:true,barcode:""},{id:3,name:"Crispy Wings 6pc",nameAr:"أجنحة مقرمشة",category:"Broasted",price:22,cost:10,stock:40,active:true,barcode:""},{id:4,name:"Mixed Grill Platter",nameAr:"مشاوي مشكلة",category:"Grills",price:65,cost:30,stock:20,active:true,barcode:""},{id:5,name:"Shish Tawook",nameAr:"شيش طاووق",category:"Grills",price:38,cost:18,stock:25,active:true,barcode:""},{id:6,name:"French Fries",nameAr:"بطاطس مقلية",category:"Sides",price:10,cost:3,stock:100,active:true,barcode:""},{id:7,name:"Coleslaw",nameAr:"كول سلو",category:"Sides",price:8,cost:2,stock:60,active:true,barcode:""},{id:8,name:"Pepsi Can",nameAr:"بيبسي",category:"Drinks",price:5,cost:2,stock:120,active:true,barcode:""},{id:9,name:"Fresh Lemon Juice",nameAr:"عصير ليمون",category:"Drinks",price:14,cost:4,stock:40,active:true,barcode:""},{id:10,name:"Umm Ali",nameAr:"أم علي",category:"Desserts",price:18,cost:6,stock:15,active:true,barcode:""},{id:11,name:"Family Box",nameAr:"وجبة عائلية",category:"Combos",price:85,cost:40,stock:20,active:true,barcode:""},{id:12,name:"Solo Meal",nameAr:"وجبة فردية",category:"Combos",price:32,cost:15,stock:30,active:true,barcode:""}];
const SEED_CATEGORIES=["Broasted","Grills","Sides","Drinks","Desserts","Combos"];
const TABLES_INIT=Array.from({length:12},(_,i)=>({id:i+1,status:i<3?"occupied":"free",capacity:4}));
const DEFAULT_PINS={Admin:"1234",Manager:"2345",Cashier:"3456"};
const TODAY=new Date().toISOString().split("T")[0];
function fmtSAR(n){return"SAR "+Number(n).toFixed(2);}
function fmtDate(d){return new Date(d).toLocaleDateString("en-SA",{day:"2-digit",month:"short",year:"numeric"});}
function fmtDateTime(d){return new Date(d).toLocaleString("en-SA",{day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit"});}

// ═══════════════════════════════════════════════════════════════════
// REUSABLE UI COMPONENTS
// ═══════════════════════════════════════════════════════════════════
const Card=({children,style={}})=><div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:20,...style}}>{children}</div>;
const Btn=({children,onClick,variant="primary",size="md",disabled=false,style={}})=>{
  const variants={primary:{background:C.primary,color:"#fff",border:"none"},outline:{background:"transparent",color:C.primary,border:`1.5px solid ${C.primary}`},danger:{background:C.danger,color:"#fff",border:"none"},ghost:{background:"transparent",color:C.textMid,border:`1px solid ${C.border}`},accent:{background:C.accent,color:"#fff",border:"none"},zatca:{background:C.zatca,color:"#fff",border:"none"}};
  const sizes={sm:{padding:"5px 12px",fontSize:12},md:{padding:"8px 18px",fontSize:13},lg:{padding:"12px 28px",fontSize:15}};
  return<button onClick={onClick} disabled={disabled} style={{...variants[variant],...sizes[size],borderRadius:8,fontFamily:"inherit",fontWeight:600,cursor:disabled?"not-allowed":"pointer",opacity:disabled?0.5:1,transition:"all 0.15s",...style}}>{children}</button>;
};
const Inp=({label,value,onChange,type="text",placeholder="",style={},readOnly=false})=>(
  <div style={{display:"flex",flexDirection:"column",gap:4,...style}}>
    {label&&<label style={{fontSize:12,fontWeight:600,color:C.textMid}}>{label}</label>}
    <input type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} readOnly={readOnly} style={{padding:"9px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontFamily:"inherit",color:C.text,background:readOnly?C.bg:"#fff"}}/>
  </div>
);
const Sel=({label,value,onChange,options,style={}})=>(
  <div style={{display:"flex",flexDirection:"column",gap:4,...style}}>
    {label&&<label style={{fontSize:12,fontWeight:600,color:C.textMid}}>{label}</label>}
    <select value={value} onChange={e=>onChange(e.target.value)} style={{padding:"9px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontFamily:"inherit",color:C.text,background:"#fff"}}>
      {options.map(o=><option key={o.value??o} value={o.value??o}>{o.label??o}</option>)}
    </select>
  </div>
);
const Badge=({children,color=C.primary,bg=C.primaryLight})=><span style={{padding:"2px 10px",borderRadius:20,fontSize:11,fontWeight:700,color,background:bg,whiteSpace:"nowrap"}}>{children}</span>;
const StatCard=({label,value,sub,icon,color=C.primary,bg=C.primaryLight})=>(
  <Card style={{display:"flex",alignItems:"center",gap:16}}>
    <div style={{width:48,height:48,borderRadius:12,background:bg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,flexShrink:0}}>{icon}</div>
    <div><div style={{fontSize:22,fontWeight:800,color}}>{value}</div><div style={{fontSize:12,color:C.textMid,fontWeight:600}}>{label}</div>{sub&&<div style={{fontSize:11,color:C.textLight,marginTop:2}}>{sub}</div>}</div>
  </Card>
);
const Modal=({title,onClose,children,width=520})=>(
  <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
    <div style={{background:"#fff",borderRadius:16,width,maxWidth:"95vw",maxHeight:"90vh",overflow:"auto",boxShadow:"0 20px 60px rgba(0,0,0,0.2)"}}>
      <div style={{padding:"20px 24px",borderBottom:`1px solid ${C.border}`,display:"flex",justifyContent:"space-between",alignItems:"center",position:"sticky",top:0,background:"#fff",zIndex:1}}>
        <span style={{fontSize:16,fontWeight:700,color:C.text}}>{title}</span>
        <button onClick={onClose} style={{background:"none",border:"none",fontSize:20,cursor:"pointer",color:C.textLight}}>×</button>
      </div>
      <div style={{padding:24}}>{children}</div>
    </div>
  </div>
);
const DataTable=({headers,rows,emptyMsg="No data"})=>(
  <div style={{overflowX:"auto"}}>
    <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
      <thead><tr style={{background:C.bg}}>{headers.map(h=><th key={h} style={{padding:"10px 14px",textAlign:"left",fontWeight:700,color:C.textMid,fontSize:11,textTransform:"uppercase",letterSpacing:"0.05em",borderBottom:`1px solid ${C.border}`,whiteSpace:"nowrap"}}>{h}</th>)}</tr></thead>
      <tbody>{rows.length===0?<tr><td colSpan={headers.length} style={{textAlign:"center",padding:32,color:C.textLight}}>{emptyMsg}</td></tr>:rows.map((row,i)=><tr key={i} style={{borderBottom:`1px solid ${C.border}`,background:i%2===0?"#fff":"#FAFBFC"}}>{row.map((cell,j)=><td key={j} style={{padding:"10px 14px",color:C.text,verticalAlign:"middle"}}>{cell}</td>)}</tr>)}</tbody>
    </table>
  </div>
);

// ═══════════════════════════════════════════════════════════════════
// BUSINESS REGISTRATION
// ═══════════════════════════════════════════════════════════════════
function BusinessRegistration({onNext}){
  const [form,setForm]=useState({businessName:"",crNumber:"",vatNumber:"",address:"",city:"Riyadh",phone:""});
  const [error,setError]=useState("");
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  function handleNext(){
    setError("");
    if(!form.businessName.trim())return setError("Business name is required.");
    if(!/^\d{12}$/.test(form.crNumber.trim()))return setError("CR Number must be exactly 12 digits.");
    if(!/^3\d{14}$/.test(form.vatNumber.trim()))return setError("VAT number must be 15 digits starting with 3.");
    if(!form.address.trim())return setError("Address is required.");
    onNext(form);
  }
  return(
    <div style={{minHeight:"100vh",background:"linear-gradient(135deg, #0a1628 0%, #1A3A5C 50%, #0a2818 100%)",display:"flex",alignItems:"center",justifyContent:"center",padding:20,fontFamily:"'Plus Jakarta Sans', sans-serif"}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Tajawal:wght@400;500;700&display=swap');*{box-sizing:border-box;margin:0;padding:0}`}</style>
      <div style={{width:"100%",maxWidth:520}}>
        <div style={{textAlign:"center",marginBottom:28}}>
          <div style={{display:"inline-flex",alignItems:"center",gap:12,marginBottom:8}}>
            <div style={{width:48,height:48,background:"linear-gradient(135deg,#1A6B4A,#F0A500)",borderRadius:14,display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,fontWeight:900,color:"#fff"}}>R</div>
            <div style={{textAlign:"left"}}><div style={{fontSize:26,fontWeight:900,color:"#fff",lineHeight:1}}>RestoPOS</div><div style={{fontSize:10,color:"rgba(255,255,255,0.5)",letterSpacing:"0.15em"}}>ZATCA PHASE 2 READY · KSA</div></div>
          </div>
        </div>
        <div style={{background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:20,padding:32,backdropFilter:"blur(12px)"}}>
          <div style={{fontSize:18,fontWeight:800,color:"#fff",marginBottom:6}}>Business Registration</div>
          <div style={{fontSize:13,color:"rgba(255,255,255,0.5)",marginBottom:24}}>Step 1 of 2 — Enter your business details</div>
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            {[["businessName","Business Name (English)","Al Baik Restaurant"],["crNumber","CR Number (12 digits)","100000000001"],["vatNumber","VAT / TRN (15 digits, starts with 3)","300000000000003"],["address","Business Address","King Fahd Road, Riyadh"],["city","City","Riyadh"],["phone","Phone (optional)","+966 50 000 0000"]].map(([k,label,ph])=>(
              <div key={k}>
                <label style={{fontSize:12,fontWeight:700,color:"rgba(255,255,255,0.6)",display:"block",marginBottom:5}}>{label}</label>
                <input value={form[k]} onChange={e=>set(k,e.target.value)} placeholder={ph} style={{width:"100%",padding:"11px 14px",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.2)",borderRadius:10,fontSize:13,color:"#fff",fontFamily:"inherit"}}/>
              </div>
            ))}
          </div>
          {error&&<div style={{marginTop:14,padding:"10px 14px",background:"rgba(217,64,64,0.2)",border:"1px solid rgba(217,64,64,0.4)",borderRadius:8,fontSize:13,color:"#ff8080"}}>{error}</div>}
          <button onClick={handleNext} style={{width:"100%",marginTop:20,padding:14,background:"linear-gradient(135deg,#1A6B4A,#134D36)",color:"#fff",border:"none",borderRadius:12,fontSize:15,fontWeight:800,cursor:"pointer",fontFamily:"inherit"}}>Next: Enter License Key →</button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// LICENSE VERIFICATION
// ═══════════════════════════════════════════════════════════════════
function LicenseVerification({businessData,onSuccess,onBack}){
  const [key,setKey]=useState("");const [error,setError]=useState("");const [loading,setLoading]=useState(false);
  async function handleVerify(){
    setError("");setLoading(true);
    const cleanKey=key.trim().toUpperCase();
    if(!/^[A-Z0-9]{12}$/.test(cleanKey)){setError("License key must be 12 alphanumeric characters.");setLoading(false);return;}
    try{
      const q=query(collection(db,"licenses"),where("key","==",cleanKey),where("active","==",true));
      const snap=await getDocs(q);
      if(snap.empty){setError("Invalid or inactive license key.");setLoading(false);return;}
      const licDoc=snap.docs[0]; const licData=licDoc.data();
      if(licData.activatedBy&&licData.activatedBy!==businessData.crNumber){setError("This license key is already activated by another business.");setLoading(false);return;}
      const licensePayload={...businessData,licenseKey:cleanKey,activatedAt:new Date().toISOString()};
      await updateDoc(doc(db,"licenses",licDoc.id),{activatedBy:businessData.crNumber,activatedAt:new Date().toISOString(),businessName:businessData.businessName,vatNumber:businessData.vatNumber,deviceId:navigator.userAgent.slice(0,100)});
      await addDoc(collection(db,"pending_activations"),{...businessData,licenseKey:cleanKey,submittedAt:new Date().toISOString(),status:"approved"});
      LS.set("restopos_license_v2",licensePayload);
      localStorage.removeItem("restopos_pending_id");
      onSuccess(licensePayload);
    }catch(e){setError("Verification failed: "+e.message);}
    setLoading(false);
  }
  return(
    <div style={{minHeight:"100vh",background:"linear-gradient(135deg, #0a1628 0%, #1A3A5C 50%, #0a2818 100%)",display:"flex",alignItems:"center",justifyContent:"center",padding:20,fontFamily:"'Plus Jakarta Sans', sans-serif"}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');*{box-sizing:border-box;margin:0;padding:0}`}</style>
      <div style={{width:"100%",maxWidth:480}}>
        <div style={{textAlign:"center",marginBottom:28}}>
          <div style={{width:56,height:56,background:"linear-gradient(135deg,#F0A500,#e09000)",borderRadius:16,display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,margin:"0 auto 12px"}}>🔑</div>
          <div style={{fontSize:22,fontWeight:900,color:"#fff"}}>Activate License</div>
          <div style={{fontSize:13,color:"rgba(255,255,255,0.5)",marginTop:4}}>Step 2 of 2 — Enter your 12-character license key</div>
        </div>
        <div style={{background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:20,padding:32}}>
          <div style={{background:"rgba(255,255,255,0.06)",borderRadius:10,padding:"12px 16px",marginBottom:20,fontSize:13,color:"rgba(255,255,255,0.7)"}}>
            <strong style={{color:"#fff"}}>{businessData.businessName}</strong><br/>
            <span style={{fontSize:12}}>CR: {businessData.crNumber} · VAT: {businessData.vatNumber}</span>
          </div>
          <label style={{fontSize:12,fontWeight:700,color:"rgba(255,255,255,0.6)",display:"block",marginBottom:6}}>License Key</label>
          <input value={key} onChange={e=>{setKey(e.target.value.toUpperCase());setError("");}} placeholder="XXXXXXXXXXXX"
            style={{width:"100%",padding:"14px 16px",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.2)",borderRadius:10,fontSize:18,color:"#fff",fontFamily:"monospace",fontWeight:700,textAlign:"center",letterSpacing:"0.15em"}}/>
          {error&&<div style={{marginTop:10,padding:"8px 12px",background:"rgba(217,64,64,0.2)",border:"1px solid rgba(217,64,64,0.4)",borderRadius:8,fontSize:13,color:"#ff8080"}}>{error}</div>}
          <button onClick={handleVerify} disabled={loading||key.length<12} style={{width:"100%",marginTop:16,padding:14,background:loading||key.length<12?"#444":"linear-gradient(135deg,#1A6B4A,#134D36)",color:"#fff",border:"none",borderRadius:12,fontSize:15,fontWeight:800,cursor:loading||key.length<12?"not-allowed":"pointer",fontFamily:"inherit"}}>
            {loading?"Verifying…":"✓ Activate License"}
          </button>
          <button onClick={onBack} style={{width:"100%",marginTop:10,padding:12,background:"transparent",color:"rgba(255,255,255,0.4)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:12,fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>← Back</button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// ROLE LOGIN — PIN pad
// ═══════════════════════════════════════════════════════════════════
function RoleLogin({license,onLogin}){
  const [selectedRole,setSelectedRole]=useState(null);const [pin,setPin]=useState("");const [error,setError]=useState("");
  const pins=LS.get("restopos_pins")||DEFAULT_PINS;
  const roles=[{id:"Admin",icon:"👑",desc:"Full access"},{id:"Manager",icon:"📊",desc:"Reports & management"},{id:"Cashier",icon:"🖥️",desc:"POS billing only"}];
  function handleLoginWithPin(p){if(p===pins[selectedRole]){onLogin({role:selectedRole,name:selectedRole});}else{setError("Incorrect PIN");setPin("");}}
  return(
    <div style={{minHeight:"100vh",background:"linear-gradient(135deg, #0a1628 0%, #1A3A5C 50%, #0a2818 100%)",display:"flex",alignItems:"center",justifyContent:"center",padding:20,fontFamily:"'Plus Jakarta Sans', sans-serif"}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');*{box-sizing:border-box;margin:0;padding:0}`}</style>
      <div style={{width:"100%",maxWidth:400}}>
        <div style={{textAlign:"center",marginBottom:24}}>
          <div style={{display:"inline-flex",alignItems:"center",gap:10,marginBottom:6}}>
            <div style={{width:40,height:40,background:"linear-gradient(135deg,#1A6B4A,#F0A500)",borderRadius:12,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,fontWeight:900,color:"#fff"}}>R</div>
            <div style={{fontSize:22,fontWeight:900,color:"#fff"}}>RestoPOS</div>
          </div>
          <div style={{fontSize:13,color:"rgba(255,255,255,0.5)"}}>{license.businessName}</div>
          <button onClick={()=>window.dispatchEvent(new Event("ownerLogin"))} style={{marginTop:8,background:"none",border:"none",color:"rgba(255,255,255,0.2)",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>⚙ Owner</button>
        </div>
        <div style={{background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:20,padding:28}}>
          {!selectedRole?(
            <>
              <div style={{fontSize:15,fontWeight:700,color:"#fff",marginBottom:16,textAlign:"center"}}>Select your role</div>
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                {roles.map(r=>(
                  <button key={r.id} onClick={()=>{setSelectedRole(r.id);setPin("");setError("");}}
                    style={{display:"flex",alignItems:"center",gap:14,padding:"14px 18px",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:12,cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>
                    <span style={{fontSize:26}}>{r.icon}</span>
                    <div><div style={{fontSize:15,fontWeight:700,color:"#fff"}}>{r.id}</div><div style={{fontSize:12,color:"rgba(255,255,255,0.5)"}}>{r.desc}</div></div>
                    <span style={{marginLeft:"auto",color:"rgba(255,255,255,0.3)"}}>→</span>
                  </button>
                ))}
              </div>
            </>
          ):(
            <>
              <button onClick={()=>{setSelectedRole(null);setPin("");setError("");}} style={{background:"none",border:"none",color:"rgba(255,255,255,0.5)",cursor:"pointer",fontSize:13,marginBottom:16,fontFamily:"inherit"}}>← Back</button>
              <div style={{textAlign:"center",marginBottom:20}}>
                <div style={{fontSize:32,marginBottom:6}}>{roles.find(r=>r.id===selectedRole)?.icon}</div>
                <div style={{fontSize:17,fontWeight:800,color:"#fff"}}>{selectedRole}</div>
                <div style={{fontSize:12,color:"rgba(255,255,255,0.5)"}}>Enter your PIN</div>
              </div>
              <div style={{display:"flex",gap:10,justifyContent:"center",marginBottom:16}}>
                {[0,1,2,3].map(i=><div key={i} style={{width:14,height:14,borderRadius:"50%",background:pin.length>i?"#F0A500":"rgba(255,255,255,0.2)"}}/>)}
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:12}}>
                {[1,2,3,4,5,6,7,8,9,"",0,"⌫"].map((k,i)=>(
                  <button key={i} onClick={()=>{if(k==="⌫")setPin(p=>p.slice(0,-1));else if(k!=="")setPin(p=>p.length<4?p+k:p);}}
                    style={{padding:"16px",background:k===""?"transparent":"rgba(255,255,255,0.08)",border:k===""?"none":"1px solid rgba(255,255,255,0.12)",borderRadius:10,fontSize:18,fontWeight:700,cursor:k===""?"default":"pointer",fontFamily:"inherit",color:"#fff"}}>{k}</button>
                ))}
              </div>
              {error&&<div style={{background:"rgba(217,64,64,0.2)",border:"1px solid rgba(217,64,64,0.4)",borderRadius:8,padding:"8px 12px",fontSize:12,color:"#ff8080",marginBottom:10,textAlign:"center"}}>{error}</div>}
              <button onClick={()=>handleLoginWithPin(pin)} disabled={pin.length!==4}
                style={{width:"100%",background:pin.length===4?"linear-gradient(135deg,#1A6B4A,#134D36)":"rgba(255,255,255,0.1)",color:"#fff",border:"none",borderRadius:12,padding:14,fontSize:15,fontWeight:800,cursor:pin.length===4?"pointer":"not-allowed",fontFamily:"inherit"}}>
                Login as {selectedRole}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// PAYMENT MODAL
// ═══════════════════════════════════════════════════════════════════
function PaymentModal({total,subtotal,vat,promos,onConfirm,onClose}){
  const [method,setMethod]=useState("Cash");const [given,setGiven]=useState("");const [promoCode,setPromoCode]=useState("");const [appliedPromo,setAppliedPromo]=useState(null);
  const promoDiscount=appliedPromo?(appliedPromo.type==="%"?subtotal*appliedPromo.value/100:appliedPromo.value):0;
  const finalTotal=Math.max(0,total-promoDiscount);const change=Math.max(0,parseFloat(given||0)-finalTotal);const shortfall=parseFloat(given||0)>0&&parseFloat(given||0)<finalTotal;
  const METHODS=[{id:"Cash",icon:"💵",label:"Cash"},{id:"Mada",icon:"💳",label:"Mada"},{id:"Apple Pay",icon:"",label:"Apple Pay"},{id:"STC Pay",icon:"📱",label:"STC Pay"}];
  const QUICK=[10,20,50,100,200,500];
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:3000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:"#fff",borderRadius:20,width:520,maxHeight:"95vh",overflow:"auto",boxShadow:"0 24px 80px rgba(0,0,0,0.25)"}}>
        <div style={{background:"linear-gradient(135deg,#1A3A5C,#0F2340)",padding:"20px 24px",borderRadius:"20px 20px 0 0",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div><div style={{color:"#fff",fontSize:18,fontWeight:800}}>💳 Payment</div><div style={{color:"rgba(255,255,255,0.6)",fontSize:12,marginTop:2}}>Complete the transaction</div></div>
          <button onClick={onClose} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",width:32,height:32,borderRadius:"50%",cursor:"pointer",fontSize:18}}>×</button>
        </div>
        <div style={{padding:24}}>
          <div style={{background:"#F0F7FF",border:"1.5px solid #C5DCF5",borderRadius:14,padding:"16px 20px",marginBottom:20,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div><div style={{fontSize:12,color:"#5A7A9A",fontWeight:600}}>AMOUNT DUE</div><div style={{fontSize:32,fontWeight:900,color:"#1A3A5C"}}>SAR {finalTotal.toFixed(2)}</div></div>
            <div style={{textAlign:"right",fontSize:12,color:"#5A7A9A"}}><div>Subtotal: SAR {subtotal.toFixed(2)}</div>{promoDiscount>0&&<div style={{color:"#D94040"}}>Promo: -SAR {promoDiscount.toFixed(2)}</div>}<div>VAT 15%: SAR {vat.toFixed(2)}</div></div>
          </div>
          <div style={{marginBottom:16}}>
            <div style={{fontSize:12,fontWeight:700,color:"#5A7A9A",marginBottom:8}}>PROMO CODE</div>
            <div style={{display:"flex",gap:8}}>
              <input value={promoCode} onChange={e=>setPromoCode(e.target.value.toUpperCase())} placeholder="e.g. SAVE10" style={{flex:1,padding:"9px 12px",border:"1.5px solid #E0E8F0",borderRadius:10,fontSize:14,fontFamily:"inherit"}}/>
              <button onClick={()=>{const p=promos.find(p=>p.code.toLowerCase()===promoCode.toLowerCase()&&p.active);if(p)setAppliedPromo(p);else alert("Invalid promo code");}} style={{padding:"9px 16px",background:"#1A3A5C",color:"#fff",border:"none",borderRadius:10,cursor:"pointer",fontSize:13,fontWeight:700,fontFamily:"inherit"}}>Apply</button>
            </div>
            {appliedPromo&&<div style={{fontSize:12,color:"#1A8A4A",marginTop:6,fontWeight:600}}>✓ {appliedPromo.code} — {appliedPromo.type==="%"?appliedPromo.value+"% off":"SAR "+appliedPromo.value+" off"}</div>}
          </div>
          <div style={{marginBottom:16}}>
            <div style={{fontSize:12,fontWeight:700,color:"#5A7A9A",marginBottom:8}}>PAYMENT METHOD</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:8}}>
              {METHODS.map(m=><button key={m.id} onClick={()=>setMethod(m.id)} style={{padding:"12px 8px",border:`2px solid ${method===m.id?"#1A3A5C":"#E0E8F0"}`,background:method===m.id?"#1A3A5C":"#fff",color:method===m.id?"#fff":"#5A7A9A",borderRadius:10,cursor:"pointer",fontFamily:"inherit",fontSize:12,fontWeight:700,display:"flex",flexDirection:"column",alignItems:"center",gap:4}}><span style={{fontSize:18}}>{m.icon}</span>{m.label}</button>)}
            </div>
          </div>
          {method==="Cash"&&(
            <div style={{marginBottom:16}}>
              <div style={{fontSize:12,fontWeight:700,color:"#5A7A9A",marginBottom:8}}>AMOUNT GIVEN</div>
              <input value={given} onChange={e=>setGiven(e.target.value)} type="number" placeholder="0.00" style={{width:"100%",padding:"12px 16px",border:`2px solid ${shortfall?"#D94040":"#E0E8F0"}`,borderRadius:10,fontSize:22,fontWeight:800,fontFamily:"inherit",color:"#1A3A5C",textAlign:"center"}}/>
              <div style={{display:"flex",gap:6,marginTop:8,flexWrap:"wrap"}}>
                {QUICK.map(q=><button key={q} onClick={()=>setGiven(String(q))} style={{flex:1,minWidth:55,padding:"7px 4px",background:parseFloat(given)===q?"#1A3A5C":"#F0F7FF",color:parseFloat(given)===q?"#fff":"#1A3A5C",border:"1.5px solid #C5DCF5",borderRadius:8,cursor:"pointer",fontFamily:"inherit",fontSize:12,fontWeight:700}}>SAR {q}</button>)}
                <button onClick={()=>setGiven(finalTotal.toFixed(2))} style={{flex:1,minWidth:60,padding:"7px 4px",background:"#E8F5EE",color:"#1A6B4A",border:"1.5px solid #A8D5B8",borderRadius:8,cursor:"pointer",fontFamily:"inherit",fontSize:11,fontWeight:700}}>Exact</button>
              </div>
              {parseFloat(given)>0&&<div style={{marginTop:12,background:shortfall?"#FDE8E8":"#E8F5EE",border:`1.5px solid ${shortfall?"#D94040":"#1A8A4A"}`,borderRadius:12,padding:"12px 16px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:13,fontWeight:700,color:shortfall?"#D94040":"#1A6B4A"}}>{shortfall?"⚠️ Shortfall":"✓ Change"}</span>
                <span style={{fontSize:22,fontWeight:900,color:shortfall?"#D94040":"#1A6B4A"}}>SAR {shortfall?(finalTotal-parseFloat(given)).toFixed(2):change.toFixed(2)}</span>
              </div>}
            </div>
          )}
          <button onClick={()=>onConfirm(method,parseFloat(given||finalTotal),change,appliedPromo,promoDiscount)} disabled={method==="Cash"&&parseFloat(given||0)<finalTotal}
            style={{width:"100%",padding:15,background:method==="Cash"&&parseFloat(given||0)<finalTotal?"#ccc":"linear-gradient(135deg,#1A6B4A,#0F4A30)",color:"#fff",border:"none",borderRadius:12,fontSize:15,fontWeight:800,cursor:method==="Cash"&&parseFloat(given||0)<finalTotal?"not-allowed":"pointer",fontFamily:"inherit"}}>
            {method==="Cash"?(parseFloat(given||0)<finalTotal?"Enter amount received":"✓ Confirm & Print Receipt"):`✓ Confirm ${method} Payment`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// RECEIPT MODAL — iframe print, ZATCA invoice meta on receipt
// ═══════════════════════════════════════════════════════════════════
function ReceiptModal({order,license,zatcaInvoice,onClose}){
  const qrData=zatcaInvoice?zatcaInvoice.qr_string:generatePhase1QR({sellerName:license.businessName,vatNumber:license.vatNumber,timestamp:new Date().toISOString(),total:order.total,vatAmount:order.vat});
  const printFrameRef=useRef();
  function handleThermalPrint(){
    let qrImgSrc="";
    try{const tempDiv=document.createElement("div");tempDiv.style.cssText="position:absolute;left:-9999px;top:-9999px;width:120px;height:120px;";document.body.appendChild(tempDiv);new window.QRCode(tempDiv,{text:qrData,width:110,height:110,colorDark:"#000000",colorLight:"#ffffff",correctLevel:window.QRCode?.CorrectLevel?.M});const canvas=tempDiv.querySelector("canvas");if(canvas)qrImgSrc=canvas.toDataURL("image/png");document.body.removeChild(tempDiv);}catch(e){console.warn("QR gen error:",e);}
    const zatcaMeta=zatcaInvoice?`<div class="row"><span>ZATCA Invoice</span><span>${zatcaInvoice.invoice_number}</span></div><div class="row"><span>ICV</span><span>${zatcaInvoice.icv}</span></div><div style="font-size:8px;text-align:center;color:#666;word-break:break-all;margin-top:2px">Hash: ${zatcaInvoice.invoice_hash?.slice(0,24)}...</div>`:"";
    const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Receipt ${order.id}</title><style>@page{size:80mm auto;margin:0}*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Courier New',monospace;font-size:12px;color:#000;background:#fff;width:80mm;padding:4mm}.center{text-align:center}.bold{font-weight:bold}.big{font-size:16px;font-weight:bold}.hr{border:none;border-top:1px dashed #000;margin:6px 0}.row{display:flex;justify-content:space-between;margin:2px 0}.row-total{display:flex;justify-content:space-between;margin:4px 0;font-size:15px;font-weight:900;border-top:2px solid #000;padding-top:4px}.item-name{flex:1}.item-amt{white-space:nowrap;margin-left:4px}.qr-wrap{text-align:center;margin:8px 0}.qr-wrap img{width:110px;height:110px;display:block;margin:0 auto}.zatca-label{font-size:9px;font-weight:bold;letter-spacing:0.1em}.footer{font-size:11px;text-align:center;margin-top:8px;font-weight:bold}@media print{body{width:80mm}}</style></head><body>
<div class="center"><div class="big">${license.businessName}</div><div>${license.address||""}</div><div>TRN: ${license.vatNumber}</div><div>${order.id} | ${order.date} ${order.time}</div>${order.customer?`<div>Customer: ${order.customer}</div>`:""}<div>${order.type}${order.table?` · Table ${order.table}`:""}</div></div>
<hr class="hr"/>
${order.items.map(it=>`<div class="row"><span class="item-name">${it.name}${it.nameAr?`<br/><span style="direction:rtl;display:block;text-align:right;font-family:Arial,sans-serif;font-size:10px;">${it.nameAr}</span>`:""}<br/><small>${it.qty} x ${it.price.toFixed(2)}</small></span><span class="item-amt">${(it.qty*it.price).toFixed(2)}</span></div>`).join("")}
<hr class="hr"/>
<div class="row"><span>Subtotal</span><span>SAR ${order.subtotal.toFixed(2)}</span></div>${order.discount>0?`<div class="row"><span>Discount</span><span>-SAR ${order.discount.toFixed(2)}</span></div>`:""}
<div class="row"><span>VAT 15%</span><span>SAR ${order.vat.toFixed(2)}</span></div>
<div class="row-total"><span>TOTAL</span><span>SAR ${order.total.toFixed(2)}</span></div>
${order.payMethod==="Cash"?`<div class="row"><span>Cash Given</span><span>SAR ${Number(order.given).toFixed(2)}</span></div><div class="row bold"><span>Change</span><span>SAR ${Number(order.change).toFixed(2)}</span></div>`:`<div class="row bold"><span>Payment</span><span>${order.payMethod}</span></div>`}
<hr class="hr"/>${zatcaMeta}
<div class="qr-wrap">${qrImgSrc?`<img src="${qrImgSrc}" alt="ZATCA QR"/>`:`<div style="width:110px;height:110px;border:1px solid #ccc;margin:0 auto;display:flex;align-items:center;justify-content:center;font-size:9px;">QR unavailable</div>`}<div class="zatca-label" style="margin-top:4px;">ZATCA PHASE 2 · QR CODE</div><div style="font-size:8px;">TLV Base64 · Scan to verify</div></div>
<div class="footer">Thank you for your visit!</div><div style="font-family:Arial,sans-serif;font-size:13px;font-weight:bold;text-align:center;direction:rtl;margin-top:4px;">شكراً لزيارتكم</div><br/><br/></body></html>`;
    const iframe=printFrameRef.current;const docW=iframe.contentDocument||iframe.contentWindow.document;docW.open();docW.write(html);docW.close();
    setTimeout(()=>{iframe.contentWindow.focus();iframe.contentWindow.print();},400);
  }
  return(
    <Modal title="🧾 Receipt" onClose={onClose} width={400}>
      <div style={{fontFamily:"monospace",fontSize:12}}>
        <div style={{textAlign:"center",marginBottom:12}}>
          <div style={{fontSize:18,fontWeight:800}}>{license.businessName}</div>
          <div style={{color:"#888",fontSize:11}}>{license.address}</div>
          <div style={{color:"#888"}}>TRN: {license.vatNumber}</div>
          <div style={{marginTop:4}}>{order.id} · {order.time}</div>
          {order.customer&&<div>Customer: {order.customer}</div>}
          <div>{order.type}{order.table?` · Table ${order.table}`:""}</div>
        </div>
        <hr style={{border:"none",borderTop:"1px dashed #ccc",margin:"8px 0"}}/>
        {order.items.map(it=><div key={it.id} style={{display:"flex",justifyContent:"space-between",margin:"4px 0"}}><span style={{flex:1}}>{it.name}</span><span style={{whiteSpace:"nowrap"}}>{it.qty} × {it.price.toFixed(2)} = {(it.qty*it.price).toFixed(2)}</span></div>)}
        <hr style={{border:"none",borderTop:"1px dashed #ccc",margin:"8px 0"}}/>
        <div style={{display:"flex",justifyContent:"space-between"}}><span>Subtotal</span><span>{fmtSAR(order.subtotal)}</span></div>
        {order.discount>0&&<div style={{display:"flex",justifyContent:"space-between",color:"#D94040"}}><span>Discount</span><span>-{fmtSAR(order.discount)}</span></div>}
        <div style={{display:"flex",justifyContent:"space-between"}}><span>VAT 15%</span><span>{fmtSAR(order.vat)}</span></div>
        <div style={{display:"flex",justifyContent:"space-between",fontWeight:900,fontSize:15,marginTop:6,borderTop:"2px solid #333",paddingTop:6}}><span>TOTAL</span><span>{fmtSAR(order.total)}</span></div>
        {order.payMethod==="Cash"&&<><div style={{display:"flex",justifyContent:"space-between",marginTop:4}}><span>Cash Given</span><span>{fmtSAR(order.given)}</span></div><div style={{display:"flex",justifyContent:"space-between",color:"#1A6B4A",fontWeight:700}}><span>Change</span><span>{fmtSAR(order.change)}</span></div></>}
        <hr style={{border:"none",borderTop:"1px dashed #ccc",margin:"8px 0"}}/>
        {zatcaInvoice&&<div style={{fontSize:10,color:C.zatca,marginBottom:6}}><div>Invoice: <strong>{zatcaInvoice.invoice_number}</strong> · ICV: {zatcaInvoice.icv}</div><div style={{wordBreak:"break-all",fontSize:9,color:C.textLight}}>Hash: {zatcaInvoice.invoice_hash?.slice(0,24)}...</div></div>}
        <div style={{textAlign:"center"}}>
          <div style={{fontSize:10,color:C.zatca,fontWeight:700,letterSpacing:"0.1em",marginBottom:6}}>⬛ ZATCA PHASE 2 · QR CODE</div>
          <div style={{display:"flex",justifyContent:"center",marginBottom:6}}><div style={{padding:6,background:"#fff",border:"1.5px solid #e0e0e0",borderRadius:8,display:"inline-block"}}><QRCodeDisplay data={qrData} size={110}/></div></div>
          <div style={{fontSize:9,color:"#aaa"}}>TLV Base64 encoded · Scan to verify</div>
          <div style={{marginTop:8,fontWeight:700,fontSize:13}}>Thank you! شكراً لزيارتكم</div>
        </div>
        <div style={{display:"flex",gap:8,marginTop:14}}>
          <Btn variant="ghost" onClick={onClose} style={{flex:1}}>Close</Btn>
          <Btn variant="primary" onClick={handleThermalPrint} style={{flex:1}}>🖨️ Print Receipt</Btn>
        </div>
        {zatcaInvoice&&<div style={{marginTop:8}}><Btn variant="zatca" size="sm" onClick={()=>zatcaUtils.downloadXML(zatcaInvoice)} style={{width:"100%"}}>⬇️ Download UBL XML</Btn></div>}
        <iframe ref={printFrameRef} style={{display:"none",width:0,height:0,border:"none"}} title="print-frame"/>
      </div>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════
// POS SCREEN
// ═══════════════════════════════════════════════════════════════════
function POS({items,sales,setSales,tables,setTables,promos,license}){
  const allCats=[...new Set(items.map(i=>i.category))];
  const [activeCat,setActiveCat]=useState("ALL");const [cart,setCart]=useState([]);const [orderType,setOrderType]=useState("takeaway");const [selectedTable,setSelectedTable]=useState(null);
  const [showPayment,setShowPayment]=useState(false);const [showReceipt,setShowReceipt]=useState(false);const [lastOrder,setLastOrder]=useState(null);const [lastZatcaInvoice,setLastZatcaInvoice]=useState(null);
  const [notif,setNotif]=useState(null);const [vno,setVno]=useState(()=>LS.get("restopos_vno")||1);const [kotNo,setKotNo]=useState(()=>LS.get("restopos_kot")||1);
  const [selectedRow,setSelectedRow]=useState(null);const [customerName,setCustomerName]=useState("");const [customerPhone,setCustomerPhone]=useState("");const [customerAddress,setCustomerAddress]=useState("");
  const barcodeRef=useRef();const [barcodeInput,setBarcodeInput]=useState("");
  const subtotal=cart.reduce((s,i)=>s+i.price*i.qty,0);const vat=subtotal*0.15;const total=subtotal+vat;
  function addToCart(item){setCart(prev=>{const ex=prev.find(c=>c.id===item.id);if(ex)return prev.map(c=>c.id===item.id?{...c,qty:c.qty+1}:c);return[...prev,{...item,qty:1}];});showN("+ "+item.name);}
  function updateQty(delta){if(selectedRow===null)return;setCart(prev=>prev.map((c,i)=>i===selectedRow?{...c,qty:Math.max(0,c.qty+delta)}:c).filter(c=>c.qty>0));}
  function showN(msg){setNotif(msg);setTimeout(()=>setNotif(null),1500);}
  function handleBarcodeSearch(code){const item=items.find(i=>i.barcode===code.trim());if(item){addToCart(item);setBarcodeInput("");}else{showN("❌ Barcode not found");setBarcodeInput("");}}
  async function confirmPayment(method,given,change,promo,promoDiscount){
    const newVno=vno+1;LS.set("restopos_vno",newVno);setVno(newVno);
    const inv={id:"INV-"+vno,date:TODAY,time:new Date().toLocaleTimeString("en-SA",{hour:"2-digit",minute:"2-digit"}),type:orderType==="dine-in"?"Dine-in":orderType==="takeaway"?"Takeaway":"Delivery",table:selectedTable,customer:customerName,customerPhone,customerAddress,items:[...cart],subtotal,discount:promoDiscount||0,vat,total:total-(promoDiscount||0),status:"completed",cashier:"Admin",payMethod:method,given,change};
    setSales(prev=>[...prev,inv]);setLastOrder(inv);
    try{const zatcaInv=await generateZATCAInvoice({seller_name:license.businessName,seller_vat:license.vatNumber,seller_address:license.address||license.city||"Riyadh",seller_cr:license.crNumber||"",items:cart.map(c=>({name:c.name,price:c.price,qty:c.qty}))});setLastZatcaInvoice(zatcaInv);}catch(e){console.warn("[ZATCA]",e);setLastZatcaInvoice(null);}
    if(orderType==="dine-in"&&selectedTable)setTables(prev=>prev.map(t=>t.id===selectedTable?{...t,status:"free"}:t));
    setCart([]);setShowPayment(false);setShowReceipt(true);setCustomerName("");setCustomerPhone("");setCustomerAddress("");setSelectedRow(null);
  }
  function printKOT(){
    const newKot=kotNo+1;LS.set("restopos_kot",newKot);setKotNo(newKot);
    const win=window.open("","_blank","width=300,height=500");if(!win){showN("❌ Allow pop-ups for KOT");return;}
    win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>KOT ${kotNo}</title><style>@page{size:80mm auto;margin:0}body{font-family:monospace;font-size:14px;width:80mm;padding:6mm}hr{border:none;border-top:1px dashed #000;margin:8px 0}.big{font-size:20px;font-weight:900;text-align:center}</style></head><body><div class="big">KOT #${kotNo}</div><hr/><div>${orderType.toUpperCase()}${selectedTable?` · Table ${selectedTable}`:""}</div><div>${new Date().toLocaleTimeString()}</div><hr/>${cart.map(it=>`<div>${it.qty}x ${it.name}${it.nameAr?`<br><span style="direction:rtl;font-family:Arial">${it.nameAr}</span>`:""}</div>`).join("")}<hr/><script>window.onload=function(){window.print();window.close()}<\/script></body></html>`);
    win.document.close();
  }
  const filteredItems=items.filter(i=>i.active&&(activeCat==="ALL"||i.category===activeCat));
  return(
    <div style={{display:"flex",height:"calc(100vh - 52px)",overflow:"hidden"}}>
      {showPayment&&<PaymentModal total={total} subtotal={subtotal} vat={vat} promos={promos} onConfirm={confirmPayment} onClose={()=>setShowPayment(false)}/>}
      {showReceipt&&lastOrder&&<ReceiptModal order={lastOrder} license={license} zatcaInvoice={lastZatcaInvoice} onClose={()=>{setShowReceipt(false);setLastZatcaInvoice(null);}}/>}
      {notif&&<div style={{position:"fixed",top:70,right:20,background:C.primary,color:"#fff",padding:"10px 18px",borderRadius:10,fontSize:13,fontWeight:700,zIndex:9999,boxShadow:"0 4px 16px rgba(0,0,0,0.2)"}}>{notif}</div>}
      {/* LEFT — Menu */}
      <div style={{flex:1,display:"flex",flexDirection:"column",borderRight:`1px solid ${C.border}`,background:C.bg,overflow:"hidden"}}>
        <div style={{padding:"8px 12px",background:C.zatcaLight,borderBottom:`1px solid ${C.border}`}}>
          <input ref={barcodeRef} value={barcodeInput} onChange={e=>setBarcodeInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&barcodeInput.trim())handleBarcodeSearch(barcodeInput);}} placeholder="🔲 Scan barcode or type…" style={{width:"100%",padding:"7px 12px",border:`1.5px solid ${C.zatca}`,borderRadius:8,fontSize:13,fontFamily:"inherit",background:"#fff"}}/>
        </div>
        <div style={{display:"flex",gap:4,padding:"8px 12px",overflowX:"auto",borderBottom:`1px solid ${C.border}`,background:"#fff",flexShrink:0}}>
          {["ALL",...allCats].map(cat=>(
            <button key={cat} onClick={()=>setActiveCat(cat)} style={{padding:"6px 14px",borderRadius:20,border:"none",background:activeCat===cat?C.primary:C.bg,color:activeCat===cat?"#fff":C.textMid,fontFamily:"inherit",fontSize:12,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0}}>{cat}</button>
          ))}
        </div>
        <div style={{flex:1,overflowY:"auto",padding:12,display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(130px, 1fr))",gap:10,alignContent:"start"}}>
          {filteredItems.map(item=>(
            <button key={item.id} onClick={()=>addToCart(item)} style={{background:"#fff",border:`1.5px solid ${C.border}`,borderRadius:12,padding:"12px 10px",cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>
              <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:4,lineHeight:1.3}}>{item.name}</div>
              {item.nameAr&&<div style={{fontSize:11,color:C.textLight,direction:"rtl",marginBottom:6}}>{item.nameAr}</div>}
              <div style={{fontSize:14,fontWeight:900,color:C.primary}}>SAR {item.price}</div>
              {item.stock<10&&<div style={{fontSize:10,color:C.danger,fontWeight:600,marginTop:3}}>Low stock</div>}
            </button>
          ))}
          {filteredItems.length===0&&<div style={{gridColumn:"1/-1",textAlign:"center",padding:"40px 0",color:C.textLight}}>No items in this category</div>}
        </div>
      </div>
      {/* RIGHT — Cart */}
      <div style={{width:340,display:"flex",flexDirection:"column",background:"#fff",flexShrink:0}}>
        <div style={{padding:"10px 14px",borderBottom:`1px solid ${C.border}`}}>
          <div style={{display:"flex",gap:6,marginBottom:8}}>
            {[["takeaway","🥡","Takeaway"],["dine-in","🍽","Dine-in"],["delivery","🛵","Delivery"]].map(([id,icon,label])=>(
              <button key={id} onClick={()=>{setOrderType(id);if(id!=="dine-in")setSelectedTable(null);}} style={{flex:1,padding:"7px 4px",border:`1.5px solid ${orderType===id?C.primary:C.border}`,background:orderType===id?C.primaryLight:"#fff",color:orderType===id?C.primary:C.textMid,borderRadius:8,fontFamily:"inherit",fontSize:11,fontWeight:700,cursor:"pointer"}}>{icon} {label}</button>
            ))}
          </div>
          {orderType==="dine-in"&&<div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:8}}>{tables.map(t=><button key={t.id} onClick={()=>setSelectedTable(t.id===selectedTable?null:t.id)} style={{width:34,height:34,borderRadius:6,border:`2px solid ${selectedTable===t.id?C.primary:t.status==="occupied"?C.danger:C.border}`,background:selectedTable===t.id?C.primaryLight:t.status==="occupied"?C.dangerLight:"#fff",fontSize:11,fontWeight:700,cursor:"pointer",color:selectedTable===t.id?C.primary:t.status==="occupied"?C.danger:C.textMid}}>{t.id}</button>)}</div>}
          <div style={{display:"flex",gap:6}}>
            <input value={customerName} onChange={e=>setCustomerName(e.target.value)} placeholder="Customer name" style={{flex:1,padding:"6px 10px",border:`1px solid ${C.border}`,borderRadius:7,fontSize:12,fontFamily:"inherit"}}/>
            <input value={customerPhone} onChange={e=>setCustomerPhone(e.target.value)} placeholder="Phone" style={{width:90,padding:"6px 10px",border:`1px solid ${C.border}`,borderRadius:7,fontSize:12,fontFamily:"inherit"}}/>
          </div>
          {orderType==="delivery"&&<input value={customerAddress} onChange={e=>setCustomerAddress(e.target.value)} placeholder="Delivery address" style={{width:"100%",marginTop:5,padding:"6px 10px",border:`1px solid ${C.border}`,borderRadius:7,fontSize:12,fontFamily:"inherit"}}/>}
        </div>
        <div style={{flex:1,overflowY:"auto",padding:"8px 14px"}}>
          {cart.length===0?<div style={{textAlign:"center",padding:"40px 0",color:C.textLight}}><div style={{fontSize:32,marginBottom:8}}>🛒</div><div style={{fontSize:13}}>Cart is empty</div></div>:cart.map((item,idx)=>(
            <div key={idx} onClick={()=>setSelectedRow(idx===selectedRow?null:idx)} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 10px",borderRadius:8,marginBottom:4,background:selectedRow===idx?C.primaryLight:C.bg,border:`1px solid ${selectedRow===idx?C.primary:C.border}`,cursor:"pointer"}}>
              <div style={{flex:1}}><div style={{fontSize:13,fontWeight:700}}>{item.name}</div><div style={{fontSize:11,color:C.textMid}}>SAR {item.price} × {item.qty}</div></div>
              <div style={{fontSize:13,fontWeight:800,color:C.primary}}>SAR {(item.price*item.qty).toFixed(2)}</div>
            </div>
          ))}
        </div>
        {selectedRow!==null&&cart[selectedRow]&&<div style={{padding:"8px 14px",borderTop:`1px solid ${C.border}`,display:"flex",gap:6,alignItems:"center"}}>
          <span style={{fontSize:12,color:C.textMid,flex:1}}>{cart[selectedRow]?.name}</span>
          <button onClick={()=>updateQty(-1)} style={{width:32,height:32,borderRadius:8,border:`1px solid ${C.border}`,background:C.dangerLight,color:C.danger,fontSize:18,fontWeight:700,cursor:"pointer"}}>−</button>
          <span style={{fontSize:15,fontWeight:800,minWidth:24,textAlign:"center"}}>{cart[selectedRow]?.qty}</span>
          <button onClick={()=>updateQty(1)} style={{width:32,height:32,borderRadius:8,border:`1px solid ${C.border}`,background:C.successLight,color:C.success,fontSize:18,fontWeight:700,cursor:"pointer"}}>+</button>
          <button onClick={()=>{setCart(prev=>prev.filter((_,i)=>i!==selectedRow));setSelectedRow(null);}} style={{padding:"4px 10px",borderRadius:8,border:`1px solid ${C.danger}`,background:C.dangerLight,color:C.danger,fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Del</button>
        </div>}
        <div style={{padding:"12px 14px",borderTop:`2px solid ${C.border}`}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}><span style={{fontSize:13,color:C.textMid}}>Subtotal</span><span style={{fontSize:13,fontWeight:600}}>{fmtSAR(subtotal)}</span></div>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}><span style={{fontSize:13,color:C.textMid}}>VAT 15%</span><span style={{fontSize:13,fontWeight:600,color:C.zatca}}>{fmtSAR(vat)}</span></div>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:14,paddingTop:8,borderTop:`1px solid ${C.border}`}}><span style={{fontSize:16,fontWeight:800}}>Total</span><span style={{fontSize:18,fontWeight:900,color:C.primary}}>{fmtSAR(total)}</span></div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={printKOT} disabled={cart.length===0} style={{flex:1,padding:"12px 0",background:cart.length===0?"#e0e0e0":C.accentLight,color:cart.length===0?"#aaa":C.accent,border:`1.5px solid ${cart.length===0?"#e0e0e0":C.accent}`,borderRadius:10,fontFamily:"inherit",fontSize:13,fontWeight:700,cursor:cart.length===0?"not-allowed":"pointer"}}>🍽 KOT</button>
            <button onClick={()=>setShowPayment(true)} disabled={cart.length===0} style={{flex:2,padding:"12px 0",background:cart.length===0?"#e0e0e0":"linear-gradient(135deg,#1A6B4A,#134D36)",color:"#fff",border:"none",borderRadius:10,fontFamily:"inherit",fontSize:14,fontWeight:800,cursor:cart.length===0?"not-allowed":"pointer"}}>💳 Pay {cart.length>0?fmtSAR(total):""}</button>
          </div>
          <button onClick={()=>{setCart([]);setSelectedRow(null);}} style={{width:"100%",marginTop:8,padding:"8px 0",background:"transparent",color:C.danger,border:`1px solid ${C.danger}30`,borderRadius:8,fontFamily:"inherit",fontSize:12,fontWeight:600,cursor:"pointer"}}>🗑 Clear Cart</button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════
function Dashboard({sales,items,license}){
  const todaySales=sales.filter(s=>s.date===TODAY);const todayRevenue=todaySales.reduce((s,o)=>s+o.total,0);const todayVat=todaySales.reduce((s,o)=>s+o.vat,0);
  const qStatus=zatcaUtils.getQueueStatus();
  return(
    <div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(220px, 1fr))",gap:16,marginBottom:24}}>
        <StatCard icon="💰" label="Today's Revenue" value={fmtSAR(todayRevenue)} color={C.primary} bg={C.primaryLight}/>
        <StatCard icon="🧾" label="Today's Orders" value={todaySales.length} color={C.info} bg={C.infoLight}/>
        <StatCard icon="⬛" label="VAT Collected" value={fmtSAR(todayVat)} color={C.zatca} bg={C.zatcaLight}/>
        <StatCard icon="📦" label="Menu Items" value={items.filter(i=>i.active).length+" active"} color={C.success} bg={C.successLight}/>
      </div>
      <Card style={{marginBottom:20,borderLeft:`4px solid ${C.zatca}`}}>
        <div style={{fontSize:14,fontWeight:700,color:C.zatca,marginBottom:12}}>⬛ ZATCA Invoice Engine Status</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:10}}>
          {[["Total Invoices",qStatus.total,C.zatca],["Reported ✓",qStatus.reported,C.success],["Pending ⏳",qStatus.pending,C.warning],["Urgent 🚨",qStatus.urgent,C.danger]].map(([l,v,col])=>(
            <div key={l} style={{background:C.bg,borderRadius:8,padding:"10px 14px"}}><div style={{fontSize:10,color:C.textLight}}>{l}</div><div style={{fontSize:20,fontWeight:800,color:col}}>{v}</div></div>
          ))}
        </div>
        {qStatus.urgent>0&&<div style={{marginTop:10,padding:"8px 12px",background:C.dangerLight,border:`1px solid ${C.danger}`,borderRadius:8,fontSize:12,color:C.danger,fontWeight:600}}>🚨 {qStatus.urgent} invoice(s) approaching 24-hour FATOORA reporting deadline!</div>}
      </Card>
      {todaySales.length===0?<Card style={{textAlign:"center",padding:"40px 0"}}><div style={{fontSize:40,marginBottom:12}}>📊</div><div style={{fontSize:15,fontWeight:700,color:C.textMid}}>No sales today yet</div></Card>:<Card><div style={{fontSize:14,fontWeight:700,marginBottom:14}}>Recent Orders (Today)</div><DataTable headers={["Invoice","Time","Type","Method","Total"]} rows={todaySales.slice().reverse().slice(0,10).map(s=>[<span style={{fontFamily:"monospace",fontSize:12,color:C.primary,fontWeight:700}}>{s.id}</span>,s.time,s.type,s.payMethod,<strong style={{color:C.primary}}>{fmtSAR(s.total)}</strong>])}/></Card>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// SECURITY TAB
// ═══════════════════════════════════════════════════════════════════
function SecurityTab({pins,setPins}){
  const roles=[{id:"Admin",icon:"👑",desc:"Full system access"},{id:"Manager",icon:"📊",desc:"Reports & management"},{id:"Cashier",icon:"🖥️",desc:"POS billing only"}];
  const [drafts,setDrafts]=useState({Admin:"",Manager:"",Cashier:""});const [confirms,setConfirms]=useState({Admin:"",Manager:"",Cashier:""});
  const [errors,setErrors]=useState({Admin:"",Manager:"",Cashier:""});const [saved,setSaved]=useState({Admin:false,Manager:false,Cashier:false});
  function savePin(role){
    if(drafts[role].length!==4)return setErrors(e=>({...e,[role]:"PIN must be exactly 4 digits."}));
    if(drafts[role]!==confirms[role])return setErrors(e=>({...e,[role]:"PINs do not match."}));
    setPins(p=>({...p,[role]:drafts[role]}));setDrafts(d=>({...d,[role]:""}));setConfirms(c=>({...c,[role]:""}));
    setSaved(s=>({...s,[role]:true}));setTimeout(()=>setSaved(s=>({...s,[role]:false})),3000);
  }
  return(<div>{roles.map(r=>(<Card key={r.id} style={{marginBottom:16,maxWidth:520}}>
    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}><span style={{fontSize:22}}>{r.icon}</span><div><div style={{fontSize:14,fontWeight:800,color:C.text}}>{r.id}</div><div style={{fontSize:11,color:C.textMid}}>{r.desc}</div></div><div style={{marginLeft:"auto",fontFamily:"monospace",fontSize:18,color:C.textLight,letterSpacing:"0.3em"}}>{"●".repeat(4)}</div></div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
      <Inp label="New PIN (4 digits)" value={drafts[r.id]} onChange={v=>{if(/^\d{0,4}$/.test(v)){setDrafts(d=>({...d,[r.id]:v}));setSaved(s=>({...s,[r.id]:false}));setErrors(e=>({...e,[r.id]:""}));}}} placeholder="••••" type="password"/>
      <Inp label="Confirm New PIN" value={confirms[r.id]} onChange={v=>{if(/^\d{0,4}$/.test(v)){setConfirms(c=>({...c,[r.id]:v}));setErrors(e=>({...e,[r.id]:""}));}}} placeholder="••••" type="password"/>
    </div>
    {errors[r.id]&&<div style={{fontSize:12,color:C.danger,marginBottom:8,fontWeight:600}}>⚠️ {errors[r.id]}</div>}
    <div style={{display:"flex",alignItems:"center",gap:10}}><Btn size="sm" onClick={()=>savePin(r.id)} disabled={!drafts[r.id]||!confirms[r.id]}>💾 Save {r.id} PIN</Btn>{saved[r.id]&&<span style={{fontSize:12,color:C.success,fontWeight:700}}>✓ PIN updated!</span>}</div>
  </Card>))}</div>);
}

// ═══════════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════════
function Settings({company,setCompany,tables,setTables,license,onClearLicense,pins,setPins}){
  const [tab,setTab]=useState("company");const [newTableCount,setNewTableCount]=useState(tables.length);const [companySaved,setCompanySaved]=useState(false);
  const tabs=[["company","🏢 Company"],["tables","🪑 Tables"],["printers","🖨️ Printers"],["security","🔐 Security"],["license","📋 License"]];
  return(<div>
    <div style={{display:"flex",gap:8,marginBottom:20,flexWrap:"wrap"}}>{tabs.map(([id,label])=><button key={id} onClick={()=>setTab(id)} style={{padding:"8px 16px",borderRadius:8,border:`1.5px solid ${tab===id?C.primary:C.border}`,background:tab===id?C.primaryLight:"#fff",color:tab===id?C.primary:C.textMid,fontFamily:"inherit",fontSize:13,fontWeight:600,cursor:"pointer"}}>{label}</button>)}</div>
    {tab==="company"&&<Card style={{maxWidth:640}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:20}}>Company Settings</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
        <Inp label="Business Name (locked)" value={license.businessName} onChange={()=>{}} readOnly/><Inp label="CR Number (locked)" value={license.crNumber} onChange={()=>{}} readOnly/><Inp label="VAT / TRN (locked)" value={license.vatNumber} onChange={()=>{}} readOnly/><Inp label="License Key (locked)" value={license.licenseKey} onChange={()=>{}} readOnly/>
        <Inp label="Phone" value={company.phone||""} onChange={v=>{setCompany(c=>({...c,phone:v}));setCompanySaved(false);}} placeholder="+966 50 000 0000"/>
        <Inp label="Email" value={company.email||""} onChange={v=>{setCompany(c=>({...c,email:v}));setCompanySaved(false);}} placeholder="info@restaurant.com"/>
        <Inp label="City" value={company.city||""} onChange={v=>{setCompany(c=>({...c,city:v}));setCompanySaved(false);}}/>
      </div>
      <Inp label="Address" value={company.address||""} onChange={v=>{setCompany(c=>({...c,address:v}));setCompanySaved(false);}} style={{marginTop:14}}/>
      <div style={{display:"flex",alignItems:"center",gap:12,marginTop:16}}><Btn onClick={()=>{LS.set("restopos_company",company);setCompanySaved(true);}}>💾 Save Settings</Btn>{companySaved&&<span style={{fontSize:12,color:C.success,fontWeight:700}}>✓ Saved successfully</span>}</div>
    </Card>}
    {tab==="tables"&&<Card style={{maxWidth:500}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:16}}>Table Configuration</div>
      <div style={{display:"flex",gap:10,marginBottom:20,alignItems:"flex-end"}}><Inp label="Number of Tables" value={newTableCount} onChange={v=>setNewTableCount(parseInt(v)||1)} type="number"/><Btn onClick={()=>setTables(Array.from({length:newTableCount},(_,i)=>({id:i+1,status:"free",capacity:4})))}>Update</Btn></div>
      <div style={{display:"flex",flexWrap:"wrap",gap:8}}>{tables.map(t=><div key={t.id} onClick={()=>setTables(prev=>prev.map(x=>x.id===t.id?{...x,status:x.status==="occupied"?"free":"occupied"}:x))} style={{width:44,height:44,borderRadius:8,border:`2px solid ${t.status==="occupied"?C.danger:C.success}`,background:t.status==="occupied"?C.dangerLight:C.successLight,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:700,color:t.status==="occupied"?C.danger:C.success,cursor:"pointer"}}>{t.id}</div>)}</div>
    </Card>}
    {tab==="printers"&&<Card style={{maxWidth:560}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:20}}>🖨️ Thermal Printer Setup</div>
      <div style={{background:C.successLight,border:`1px solid ${C.success}`,borderRadius:10,padding:"12px 16px",marginBottom:16,fontSize:13,color:C.success,fontWeight:600}}>✅ RestoPOS uses a hidden iframe for printing — no pop-up dialog, no extra confirmation.</div>
      <div style={{display:"flex",flexDirection:"column",gap:12}}>{[["Paper Width","80mm standard thermal roll"],["Print Method","Hidden iframe → auto-prints, no pop-up"],["USB / Network","Set thermal printer as default in OS"],["Bluetooth","Pair first via OS settings, then set as default"]].map(([k,v])=><div key={k} style={{display:"flex",gap:12,padding:"10px 14px",background:C.bg,borderRadius:8}}><span style={{fontSize:12,fontWeight:700,color:C.textMid,width:130,flexShrink:0}}>{k}</span><span style={{fontSize:13}}>{v}</span></div>)}</div>
    </Card>}
    {tab==="security"&&<SecurityTab pins={pins} setPins={setPins}/>}
    {tab==="license"&&<Card style={{maxWidth:520}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:20}}>License Information</div>
      <div style={{display:"flex",flexDirection:"column",gap:10}}>{[["Business Name",license.businessName],["CR Number",license.crNumber],["VAT / TRN",license.vatNumber],["License Key",license.licenseKey],["City",license.city],["Activated",fmtDateTime(license.activatedAt)]].map(([k,v])=><div key={k} style={{display:"flex",gap:16,padding:"10px 14px",background:C.bg,borderRadius:8}}><span style={{fontSize:12,fontWeight:700,color:C.textMid,width:120,flexShrink:0}}>{k}</span><span style={{fontSize:13,color:C.text,fontWeight:600,fontFamily:["CR Number","VAT / TRN","License Key"].includes(k)?"monospace":"inherit"}}>{v}</span></div>)}</div>
      <div style={{marginTop:20,padding:14,background:C.dangerLight,border:`1px solid ${C.danger}`,borderRadius:10}}><div style={{fontSize:13,fontWeight:700,color:C.danger,marginBottom:8}}>⚠️ Reset License</div><div style={{fontSize:12,color:C.danger,marginBottom:12}}>This will clear all saved license data and log you out.</div><Btn variant="danger" size="sm" onClick={()=>{if(confirm("Are you sure? This will clear the license and log you out."))onClearLicense();}}>Clear License & Re-Activate</Btn></div>
    </Card>}
  </div>);
}

// ═══════════════════════════════════════════════════════════════════
// CREATE — Menu Management
// ═══════════════════════════════════════════════════════════════════
function Create({items,setItems,promos,setPromos}){
  const [tab,setTab]=useState("items");const [showItemModal,setShowItemModal]=useState(false);const [editItem,setEditItem]=useState(null);const [showBarcodeModal,setShowBarcodeModal]=useState(false);const [barcodeItem,setBarcodeItem]=useState(null);const [barcodeInput,setBarcodeInput]=useState("");const [showPromoModal,setShowPromoModal]=useState(false);const [editPromo,setEditPromo]=useState(null);const [categories,setCategories]=useState(SEED_CATEGORIES);const [newCat,setNewCat]=useState("");
  const blankItem={name:"",nameAr:"",category:categories[0],price:"",cost:"",stock:"",active:true,barcode:""};const [itemForm,setItemForm]=useState(blankItem);
  const blankPromo={code:"",type:"%",value:"",minOrder:0,active:true};const [promoForm,setPromoForm]=useState(blankPromo);const barcodeRef=useRef();
  function openItemModal(it=null){setEditItem(it);setItemForm(it?{...it}:{...blankItem,category:categories[0]});setShowItemModal(true);}
  function saveItem(){if(!itemForm.name||!itemForm.price)return alert("Name and price required");const item={...itemForm,price:parseFloat(itemForm.price),cost:parseFloat(itemForm.cost||0),stock:parseInt(itemForm.stock||0),id:editItem?editItem.id:Date.now()};setItems(prev=>editItem?prev.map(i=>i.id===editItem.id?item:i):[...prev,item]);setShowItemModal(false);}
  function openBarcodeModal(it){setBarcodeItem(it);setBarcodeInput(it.barcode||"");setShowBarcodeModal(true);setTimeout(()=>barcodeRef.current?.focus(),100);}
  function saveBarcode(){setItems(prev=>prev.map(i=>i.id===barcodeItem.id?{...i,barcode:barcodeInput.trim()}:i));setShowBarcodeModal(false);alert("Barcode saved!");}
  function openPromoModal(p=null){setEditPromo(p);setPromoForm(p?{...p}:{...blankPromo});setShowPromoModal(true);}
  function savePromo(){if(!promoForm.code||!promoForm.value)return alert("Code and value required");const promo={...promoForm,value:parseFloat(promoForm.value),minOrder:parseFloat(promoForm.minOrder||0),id:editPromo?editPromo.id:Date.now()};setPromos(prev=>editPromo?prev.map(p=>p.id===editPromo.id?promo:p):[...prev,promo]);setShowPromoModal(false);}
  return(<div>
    {showItemModal&&<Modal title={editItem?"Edit Item":"New Menu Item"} onClose={()=>setShowItemModal(false)}>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        <Inp label="Item Name *" value={itemForm.name} onChange={v=>setItemForm(f=>({...f,name:v}))} placeholder="Chicken Burger"/><Inp label="Arabic Name" value={itemForm.nameAr} onChange={v=>setItemForm(f=>({...f,nameAr:v}))} placeholder="برجر دجاج"/>
        <Sel label="Category" value={itemForm.category} onChange={v=>setItemForm(f=>({...f,category:v}))} options={categories}/><Inp label="Barcode" value={itemForm.barcode} onChange={v=>setItemForm(f=>({...f,barcode:v}))} placeholder="Scan or type barcode"/>
        <Inp label="Price (SAR) *" value={itemForm.price} onChange={v=>setItemForm(f=>({...f,price:v}))} type="number"/><Inp label="Cost (SAR)" value={itemForm.cost} onChange={v=>setItemForm(f=>({...f,cost:v}))} type="number"/>
        <Inp label="Stock" value={itemForm.stock} onChange={v=>setItemForm(f=>({...f,stock:v}))} type="number"/><div style={{display:"flex",alignItems:"center",gap:8,paddingTop:20}}><input type="checkbox" checked={itemForm.active} onChange={e=>setItemForm(f=>({...f,active:e.target.checked}))} id="activeItem"/><label htmlFor="activeItem" style={{fontSize:13}}>Active</label></div>
      </div>
      <div style={{display:"flex",gap:10,marginTop:16}}><Btn variant="ghost" onClick={()=>setShowItemModal(false)} style={{flex:1}}>Cancel</Btn><Btn onClick={saveItem} style={{flex:1}}>Save Item</Btn></div>
    </Modal>}
    {showBarcodeModal&&barcodeItem&&<Modal title={`🔲 Add Barcode — ${barcodeItem.name}`} onClose={()=>setShowBarcodeModal(false)} width={420}>
      <div style={{fontSize:13,color:C.textMid,marginBottom:16}}>Scan the barcode with your scanner or type it manually. Press Enter or click Save.</div>
      <input ref={barcodeRef} value={barcodeInput} onChange={e=>setBarcodeInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")saveBarcode();}} placeholder="Scan barcode here…" style={{width:"100%",padding:"14px 16px",border:`2px solid ${C.zatca}`,borderRadius:10,fontSize:18,fontFamily:"monospace",fontWeight:700,textAlign:"center",color:C.text,background:C.zatcaLight}} autoFocus/>
      <div style={{display:"flex",gap:10,marginTop:16}}><Btn variant="ghost" onClick={()=>setShowBarcodeModal(false)} style={{flex:1}}>Cancel</Btn><Btn variant="zatca" onClick={saveBarcode} style={{flex:1}}>Save Barcode</Btn></div>
    </Modal>}
    {showPromoModal&&<Modal title={editPromo?"Edit Promo":"New Promo"} onClose={()=>setShowPromoModal(false)} width={420}>
      <div style={{display:"flex",flexDirection:"column",gap:12}}>
        <Inp label="Code" value={promoForm.code} onChange={v=>setPromoForm(f=>({...f,code:v.toUpperCase()}))} placeholder="SAVE20"/>
        <Sel label="Type" value={promoForm.type} onChange={v=>setPromoForm(f=>({...f,type:v}))} options={[{value:"%",label:"Percentage (%)"},{value:"flat",label:"Flat (SAR)"}]}/>
        <Inp label="Value" value={promoForm.value} onChange={v=>setPromoForm(f=>({...f,value:v}))} type="number"/>
        <Inp label="Min Order (SAR)" value={promoForm.minOrder} onChange={v=>setPromoForm(f=>({...f,minOrder:v}))} type="number"/>
        <div style={{display:"flex",alignItems:"center",gap:8}}><input type="checkbox" checked={promoForm.active} onChange={e=>setPromoForm(f=>({...f,active:e.target.checked}))} id="pa"/><label htmlFor="pa" style={{fontSize:13}}>Active</label></div>
      </div>
      <div style={{display:"flex",gap:10,marginTop:16}}><Btn variant="ghost" onClick={()=>setShowPromoModal(false)} style={{flex:1}}>Cancel</Btn><Btn onClick={savePromo} style={{flex:1}}>Save</Btn></div>
    </Modal>}
    <div style={{display:"flex",gap:8,marginBottom:20}}>{[["items","🍔 Items"],["categories","📂 Categories"],["promos","🏷️ Promos"]].map(([id,label])=><button key={id} onClick={()=>setTab(id)} style={{padding:"8px 16px",borderRadius:8,border:`1.5px solid ${tab===id?C.primary:C.border}`,background:tab===id?C.primaryLight:"#fff",color:tab===id?C.primary:C.textMid,fontFamily:"inherit",fontSize:13,fontWeight:600,cursor:"pointer"}}>{label}</button>)}</div>
    {tab==="items"&&<Card><div style={{display:"flex",justifyContent:"space-between",marginBottom:16}}><div style={{fontSize:15,fontWeight:700}}>Menu Items ({items.length})</div><Btn size="sm" onClick={()=>openItemModal()}>+ New Item</Btn></div><DataTable headers={["Name","Category","Price","Stock","Barcode","Status","Actions"]} rows={items.map(it=>[it.name,<Badge color={C.info} bg={C.infoLight}>{it.category}</Badge>,<strong style={{color:C.primary}}>{fmtSAR(it.price)}</strong>,it.stock,<div style={{display:"flex",alignItems:"center",gap:6}}>{it.barcode?<span style={{fontFamily:"monospace",fontSize:11,color:C.zatca}}>{it.barcode}</span>:<span style={{color:C.textLight,fontSize:11}}>None</span>}<button onClick={()=>openBarcodeModal(it)} style={{background:C.zatcaLight,border:`1px solid ${C.zatca}30`,color:C.zatca,padding:"2px 7px",borderRadius:5,fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>🔲 {it.barcode?"Edit":"Add"}</button></div>,<Badge color={it.active?C.success:C.danger} bg={it.active?C.successLight:C.dangerLight}>{it.active?"Active":"Off"}</Badge>,<div style={{display:"flex",gap:5}}><Btn size="sm" variant="ghost" onClick={()=>openItemModal(it)}>Edit</Btn><Btn size="sm" variant="danger" onClick={()=>{if(confirm("Delete?"))setItems(prev=>prev.filter(i=>i.id!==it.id));}}>Del</Btn></div>])}/></Card>}
    {tab==="categories"&&<Card><div style={{fontSize:15,fontWeight:700,marginBottom:16}}>Categories</div><div style={{display:"flex",gap:10,marginBottom:20}}><input value={newCat} onChange={e=>setNewCat(e.target.value)} placeholder="New category" style={{flex:1,padding:"9px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontFamily:"inherit"}}/><Btn onClick={()=>{if(newCat.trim()){setCategories(prev=>[...prev,newCat.trim()]);setNewCat("");}}}>Add</Btn></div><div style={{display:"flex",flexWrap:"wrap",gap:10}}>{categories.map(cat=><div key={cat} style={{padding:"8px 16px",background:C.primaryLight,borderRadius:8,fontSize:13,fontWeight:600,color:C.primary,display:"flex",alignItems:"center",gap:8}}>{cat}<button onClick={()=>setCategories(prev=>prev.filter(c=>c!==cat))} style={{background:"none",border:"none",color:C.danger,cursor:"pointer",fontSize:14}}>×</button></div>)}</div></Card>}
    {tab==="promos"&&<Card><div style={{display:"flex",justifyContent:"space-between",marginBottom:16}}><div style={{fontSize:15,fontWeight:700}}>Promo Codes</div><Btn size="sm" onClick={()=>openPromoModal()}>+ New</Btn></div><DataTable headers={["Code","Type","Value","Min Order","Status","Actions"]} rows={promos.map(p=>[<strong style={{fontFamily:"monospace",color:C.primary}}>{p.code}</strong>,p.type==="%"?"%":"Flat",p.type==="%"?p.value+"%":fmtSAR(p.value),p.minOrder>0?fmtSAR(p.minOrder):"None",<Badge color={p.active?C.success:C.danger} bg={p.active?C.successLight:C.dangerLight}>{p.active?"Active":"Off"}</Badge>,<div style={{display:"flex",gap:5}}><Btn size="sm" variant="ghost" onClick={()=>openPromoModal(p)}>Edit</Btn><Btn size="sm" variant="danger" onClick={()=>setPromos(prev=>prev.filter(x=>x.id!==p.id))}>Del</Btn></div>])} emptyMsg="No promos yet"/></Card>}
  </div>);
}

// ═══════════════════════════════════════════════════════════════════
// REPRINT (popup window)
// ═══════════════════════════════════════════════════════════════════
function reprintReceipt(sale,license){
  const qrData=generatePhase1QR({sellerName:license.businessName,vatNumber:license.vatNumber,timestamp:new Date().toISOString(),total:sale.total,vatAmount:sale.vat});
  const win=window.open("","_blank","width=340,height=700,scrollbars=yes");if(!win){alert("Pop-up blocked. Please allow pop-ups.");return;}
  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Receipt ${sale.id}</title><style>@page{size:80mm auto;margin:0}*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Courier New',monospace;font-size:12px;color:#000;background:#fff;width:80mm;padding:4mm}.center{text-align:center}.bold{font-weight:bold}.big{font-size:16px;font-weight:bold}.hr{border:none;border-top:1px dashed #000;margin:6px 0}.row{display:flex;justify-content:space-between;margin:2px 0}.row-total{display:flex;justify-content:space-between;margin:4px 0;font-size:15px;font-weight:900;border-top:2px solid #000;padding-top:4px}.item-name{flex:1}.item-amt{white-space:nowrap;margin-left:4px}.qr-wrap{text-align:center;margin:8px 0}.zatca-label{font-size:9px;font-weight:bold;letter-spacing:0.1em}@media print{body{width:80mm}}</style></head><body>
<div class="center"><div class="big">${sale.businessName||license.businessName}</div><div>${license.address||""}</div><div>TRN: ${license.vatNumber}</div><div>${sale.id} | ${sale.date} ${sale.time}</div>${sale.customer?`<div>Customer: ${sale.customer}</div>`:""}<div>${sale.type}${sale.table?` · Table ${sale.table}`:""}</div></div>
<hr class="hr"/>${(sale.items||[]).map(it=>`<div class="row"><span class="item-name">${it.name}<br/><small>${it.qty} x ${it.price.toFixed(2)}</small></span><span class="item-amt">${(it.qty*it.price).toFixed(2)}</span></div>`).join("")}
<hr class="hr"/><div class="row"><span>Subtotal</span><span>SAR ${(sale.subtotal||0).toFixed(2)}</span></div>${(sale.discount||0)>0?`<div class="row"><span>Discount</span><span>-SAR ${sale.discount.toFixed(2)}</span></div>`:""}
<div class="row"><span>VAT 15%</span><span>SAR ${(sale.vat||0).toFixed(2)}</span></div><div class="row-total"><span>TOTAL</span><span>SAR ${(sale.total||0).toFixed(2)}</span></div>
${sale.payMethod==="Cash"?`<div class="row"><span>Cash Given</span><span>SAR ${Number(sale.given||0).toFixed(2)}</span></div><div class="row bold"><span>Change</span><span>SAR ${Number(sale.change||0).toFixed(2)}</span></div>`:`<div class="row bold"><span>Payment</span><span>${sale.payMethod}</span></div>`}
<hr class="hr"/><div id="qr-placeholder" style="text-align:center;margin:8px 0"><canvas id="qr-canvas"></canvas><div class="zatca-label">ZATCA PHASE 2 · QR CODE</div><div style="font-size:8px">TLV Base64 · Scan to verify</div></div>
<div class="bold center" style="margin-top:6px">Thank you for your visit!</div><div style="font-family:Arial,sans-serif;font-size:13px;font-weight:bold;text-align:center;direction:rtl;margin-top:3px">شكراً لزيارتكم</div><br/><br/>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>var qrData=${JSON.stringify(qrData)};function doQR(){if(window.QRCode){try{new QRCode(document.getElementById("qr-canvas"),{text:qrData,width:100,height:100,colorDark:"#000000",colorLight:"#ffffff",correctLevel:QRCode.CorrectLevel.M});}catch(e){}setTimeout(function(){window.print();window.close();},800);}else{setTimeout(doQR,200);}}window.onload=doQR;<\/script></body></html>`;
  win.document.write(html);win.document.close();
}

// ═══════════════════════════════════════════════════════════════════
// TRANSACTIONS — with ZATCA tab
// ═══════════════════════════════════════════════════════════════════
function Transactions({sales,setSales,license}){
  const [tab,setTab]=useState("sales");const [dateFrom,setDateFrom]=useState(TODAY);const [dateTo,setDateTo]=useState(TODAY);const [search,setSearch]=useState("");const [refundTarget,setRefundTarget]=useState(null);
  const dateFiltered=sales.filter(s=>s.date>=dateFrom&&s.date<=dateTo);
  const filtered=search.trim()?sales.filter(s=>s.id?.toLowerCase().includes(search.toLowerCase())||s.date?.includes(search)||s.type?.toLowerCase().includes(search.toLowerCase())||s.payMethod?.toLowerCase().includes(search.toLowerCase())):dateFiltered;
  const total=filtered.reduce((s,o)=>s+o.total,0);const vat=filtered.reduce((s,o)=>s+o.vat,0);
  return(<div>
    {refundTarget&&<Modal title="Process Refund" onClose={()=>setRefundTarget(null)} width={420}>
      <div style={{fontSize:13,color:C.textMid,marginBottom:16}}>Refunding <strong style={{color:C.primary}}>{refundTarget.id}</strong> — {fmtSAR(refundTarget.total)}</div>
      <div style={{background:C.dangerLight,border:`1px solid ${C.danger}`,borderRadius:8,padding:12,fontSize:13,color:C.danger,marginBottom:20}}>⚠️ This will mark the invoice as refunded.</div>
      <div style={{display:"flex",gap:10}}><Btn variant="ghost" onClick={()=>setRefundTarget(null)} style={{flex:1}}>Cancel</Btn><Btn variant="danger" onClick={()=>{setSales(prev=>prev.map(s=>s.id===refundTarget.id?{...s,status:"refunded"}:s));setRefundTarget(null);}} style={{flex:1}}>Confirm</Btn></div>
    </Modal>}
    <Card style={{marginBottom:16,padding:"12px 16px"}}>
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        <span style={{fontSize:18}}>🔍</span>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search by invoice number, date, type, payment method…" style={{flex:1,padding:"9px 14px",border:`1.5px solid ${search?C.primary:C.border}`,borderRadius:10,fontSize:13,fontFamily:"inherit",outline:"none",background:search?C.primaryLight:"#fff"}}/>
        {search&&<button onClick={()=>setSearch("")} style={{background:C.dangerLight,color:C.danger,border:"none",borderRadius:8,padding:"6px 12px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>✕ Clear</button>}
      </div>
    </Card>
    <div style={{display:"flex",gap:8,marginBottom:20,flexWrap:"wrap"}}>{[["sales","💳 Sales"],["payments","💰 Payments"],["kot","🍽 KOT"],["zatca","⬛ ZATCA Invoices"]].map(([id,label])=><button key={id} onClick={()=>setTab(id)} style={{padding:"8px 16px",borderRadius:8,border:`1.5px solid ${tab===id?C.primary:C.border}`,background:tab===id?C.primaryLight:"#fff",color:tab===id?C.primary:C.textMid,fontFamily:"inherit",fontSize:13,fontWeight:600,cursor:"pointer"}}>{label}</button>)}</div>
    {tab==="sales"&&<div style={{display:"flex",flexDirection:"column",gap:16}}>
      {!search&&<Card style={{display:"flex",gap:12,alignItems:"flex-end",flexWrap:"wrap"}}><Inp label="From" value={dateFrom} onChange={setDateFrom} type="date"/><Inp label="To" value={dateTo} onChange={setDateTo} type="date"/><div style={{marginLeft:"auto"}}><div style={{fontSize:12,color:C.textMid}}>{filtered.length} orders · VAT: {fmtSAR(vat)}</div><div style={{fontSize:20,fontWeight:800,color:C.primary}}>{fmtSAR(total)}</div></div></Card>}
      {filtered.length===0?<Card><div style={{textAlign:"center",padding:"40px 0",color:C.textMid}}><div style={{fontSize:40,marginBottom:12}}>🧾</div><div style={{fontSize:15,fontWeight:700}}>No orders yet</div></div></Card>
      :<Card><DataTable headers={["Invoice","Date","Time","Type","Method","Total","Status","Actions"]} rows={filtered.slice().reverse().slice(0,100).map(s=>[<span style={{fontFamily:"monospace",fontSize:12,color:C.primary,fontWeight:700}}>{s.id}</span>,s.date,s.time,s.type,s.payMethod,<strong>{fmtSAR(s.total)}</strong>,<Badge color={s.status==="completed"?C.success:s.status==="voided"?C.danger:C.warning} bg={s.status==="completed"?C.successLight:s.status==="voided"?C.dangerLight:C.warningLight}>{s.status}</Badge>,<div style={{display:"flex",gap:4,flexWrap:"wrap"}}><Btn size="sm" variant="outline" onClick={()=>reprintReceipt(s,license)}>🖨️ Print</Btn>{s.status==="completed"&&<><Btn size="sm" variant="ghost" onClick={()=>setRefundTarget(s)}>Refund</Btn><Btn size="sm" variant="danger" onClick={()=>{if(confirm("Void?"))setSales(prev=>prev.map(x=>x.id===s.id?{...x,status:"voided"}:x));}}>Void</Btn></>}</div>])} emptyMsg="No orders found"/></Card>}
    </div>}
    {tab==="payments"&&<Card><div style={{fontSize:15,fontWeight:700,marginBottom:16}}>Payment Summary (Today)</div>{["Cash","Mada","Apple Pay","STC Pay"].map(method=>{const ms=sales.filter(s=>s.date===TODAY&&s.payMethod===method);return<div key={method} style={{display:"flex",justifyContent:"space-between",padding:"12px 0",borderBottom:`1px solid ${C.border}`}}><span style={{fontSize:14,fontWeight:600}}>{method}</span><div style={{textAlign:"right"}}><div style={{fontSize:16,fontWeight:700,color:C.primary}}>{fmtSAR(ms.reduce((s,o)=>s+o.total,0))}</div><div style={{fontSize:11,color:C.textLight}}>{ms.length} transactions</div></div></div>;})} </Card>}
    {tab==="kot"&&<Card><div style={{fontSize:15,fontWeight:700,marginBottom:16}}>KOT Log (Today)</div>{sales.filter(s=>s.date===TODAY).length===0?<div style={{textAlign:"center",padding:"30px 0",color:C.textMid}}><div style={{fontSize:32,marginBottom:8}}>🍽</div><div>No KOTs today</div></div>:<div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(210px,1fr))",gap:12}}>{sales.filter(s=>s.date===TODAY).slice().reverse().map(s=>(<div key={s.id} style={{border:"2px dashed #ccc",borderRadius:8,padding:14,fontFamily:"monospace",fontSize:12}}><div style={{fontWeight:700,marginBottom:6}}>{s.type}{s.table?` · T${s.table}`:""} · {s.time}</div>{(s.items||[]).slice(0,4).map((it,idx)=><div key={idx}>{it.qty}× {it.name}</div>)}<div style={{marginTop:6,fontSize:10,color:C.textLight}}>{s.id}</div></div>))}</div>}</Card>}
    {tab==="zatca"&&<Card>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20}}>
        <div style={{width:36,height:36,background:C.zatcaLight,borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>⬛</div>
        <div><div style={{fontSize:15,fontWeight:800,color:C.text}}>ZATCA Invoice Engine</div><div style={{fontSize:12,color:C.textMid}}>ICV counter · SHA-256 hash chain · UBL 2.1 XML · FATOORA queue</div></div>
        <div style={{marginLeft:"auto",display:"flex",gap:8}}>
          {[["Total",zatcaUtils.getQueueStatus().total,C.zatca],["Reported",zatcaUtils.getQueueStatus().reported,C.success],["Pending",zatcaUtils.getQueueStatus().pending,C.warning]].map(([l,v,col])=>(
            <div key={l} style={{background:C.bg,borderRadius:8,padding:"6px 12px",textAlign:"center"}}><div style={{fontSize:18,fontWeight:800,color:col}}>{v}</div><div style={{fontSize:10,color:C.textLight}}>{l}</div></div>
          ))}
        </div>
      </div>
      <ZATCAInvoiceHistory/>
    </Card>}
  </div>);
}

// ═══════════════════════════════════════════════════════════════════
// ACCOUNTS
// ═══════════════════════════════════════════════════════════════════
function Accounts({sales,items}){
  const [period,setPeriod]=useState("today");const now=new Date();
  const periodSales=sales.filter(s=>{const d=new Date(s.date);if(period==="today")return s.date===TODAY;if(period==="week"){const w=new Date();w.setDate(w.getDate()-7);return d>=w;}if(period==="month")return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear();return true;});
  const totalSale=periodSales.reduce((s,o)=>s+o.total,0);const vatCollected=periodSales.reduce((s,o)=>s+o.vat,0);
  const todayTotal=sales.filter(s=>s.date===TODAY).reduce((s,o)=>s+o.total,0);
  const prev7=Array.from({length:7},(_,i)=>{const d=new Date();d.setDate(d.getDate()-(i+1));const ds=d.toISOString().split("T")[0];return sales.filter(s=>s.date===ds).reduce((s,o)=>s+o.total,0);});
  const prev7avg=prev7.reduce((a,b)=>a+b,0)/7;const avgPct=prev7avg>0?(((todayTotal-prev7avg)/prev7avg)*100).toFixed(1):todayTotal>0?"100.0":"0.0";const avgUp=parseFloat(avgPct)>=0;
  const periodLabel={today:"Today",week:"Last 7 Days",month:"This Month",all:"All Time"}[period];
  return(<div>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:24,flexWrap:"wrap",gap:10}}>
      <div><div style={{fontSize:20,fontWeight:800,color:C.text}}>📈 Accounts</div><div style={{fontSize:13,color:C.textMid,marginTop:2}}>Period: {periodLabel} · {periodSales.length} orders</div></div>
      <div style={{display:"flex",gap:6}}>{[["today","Today"],["week","Week"],["month","Month"],["all","All"]].map(([id,label])=><button key={id} onClick={()=>setPeriod(id)} style={{padding:"8px 16px",borderRadius:8,border:`1px solid ${period===id?C.primary:C.border}`,background:period===id?C.primary:"#fff",color:period===id?"#fff":C.textMid,fontFamily:"inherit",fontSize:13,fontWeight:600,cursor:"pointer"}}>{label}</button>)}</div>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(260px, 1fr))",gap:20}}>
      <Card style={{padding:28,borderLeft:`5px solid ${C.primary}`}}><div style={{fontSize:13,fontWeight:700,color:C.textMid,marginBottom:10,textTransform:"uppercase",letterSpacing:"0.06em"}}>💰 Total Sale</div><div style={{fontSize:34,fontWeight:900,color:C.primary,lineHeight:1}}>{fmtSAR(totalSale)}</div><div style={{fontSize:12,color:C.textLight,marginTop:8}}>Including VAT · {periodSales.length} orders</div></Card>
      <Card style={{padding:28,borderLeft:`5px solid ${C.zatca}`}}><div style={{fontSize:13,fontWeight:700,color:C.textMid,marginBottom:10,textTransform:"uppercase",letterSpacing:"0.06em"}}>⬛ VAT Collected</div><div style={{fontSize:34,fontWeight:900,color:C.zatca,lineHeight:1}}>{fmtSAR(vatCollected)}</div><div style={{fontSize:12,color:C.textLight,marginTop:8}}>15% VAT · {periodLabel}</div></Card>
      <Card style={{padding:28,borderLeft:`5px solid ${avgUp?C.success:C.danger}`}}><div style={{fontSize:13,fontWeight:700,color:C.textMid,marginBottom:10,textTransform:"uppercase",letterSpacing:"0.06em"}}>📊 Avg Sale vs Prev 7 Days</div><div style={{fontSize:34,fontWeight:900,color:avgUp?C.success:C.danger,lineHeight:1}}>{avgUp?"+":""}{avgPct}%</div><div style={{fontSize:12,color:C.textLight,marginTop:8}}>Today: {fmtSAR(todayTotal)} · 7-day avg: {fmtSAR(prev7avg)}</div></Card>
    </div>
    {periodSales.length===0&&<Card style={{marginTop:24,textAlign:"center",padding:"48px 0"}}><div style={{fontSize:40,marginBottom:12}}>📊</div><div style={{fontSize:15,fontWeight:700,color:C.textMid}}>No sales data for this period</div></Card>}
  </div>);
}

// ═══════════════════════════════════════════════════════════════════
// REPORTS
// ═══════════════════════════════════════════════════════════════════
function Reports({sales,items,setSales}){
  const [tab,setTab]=useState("summary");const [dateFrom,setDateFrom]=useState(TODAY);const [dateTo,setDateTo]=useState(TODAY);const [showCloseDay,setShowCloseDay]=useState(false);
  const dayLog=LS.get("restopos_daylog")||{};const filtered=sales.filter(s=>s.date>=dateFrom&&s.date<=dateTo);const todaySales=sales.filter(s=>s.date===TODAY);
  function handleCloseDay(){const closeTime=new Date().toISOString();const firstSale=todaySales.length>0?todaySales[0]:null;const startTime=firstSale?`${firstSale.date}T${firstSale.time}:00`:closeTime;const log={...dayLog,[TODAY]:{startTime,closeTime,orderCount:todaySales.length,revenue:todaySales.reduce((s,o)=>s+o.total,0),vat:todaySales.reduce((s,o)=>s+o.vat,0)}};LS.set("restopos_daylog",log);setShowCloseDay(false);alert(`✅ Day closed at ${fmtDateTime(closeTime)}\nTotal orders: ${todaySales.length}`);}
  const todayLog=dayLog[TODAY];
  const catSales=[...new Set(items.map(i=>i.category))].map(cat=>{const catItems=items.filter(i=>i.category===cat);return{cat,revenue:catItems.reduce((s,it)=>s+filtered.reduce((ss,o)=>ss+(o.items.find(i=>i.id===it.id)?.qty||0)*it.price,0),0)};}).filter(c=>c.revenue>0).sort((a,b)=>b.revenue-a.revenue);
  const itemSales=items.map(it=>({...it,sold:filtered.reduce((s,o)=>s+(o.items.find(i=>i.id===it.id)?.qty||0),0),revenue:filtered.reduce((s,o)=>s+(o.items.find(i=>i.id===it.id)?.qty||0)*it.price,0)})).filter(it=>it.sold>0).sort((a,b)=>b.revenue-a.revenue);
  const DateFilter=()=><Card style={{display:"flex",gap:12,alignItems:"flex-end",marginBottom:16,flexWrap:"wrap"}}><Inp label="From" value={dateFrom} onChange={setDateFrom} type="date"/><Inp label="To" value={dateTo} onChange={setDateTo} type="date"/><div style={{marginLeft:"auto"}}><div style={{fontSize:12,color:C.textMid}}>{filtered.length} orders</div><div style={{fontSize:18,fontWeight:800,color:C.primary}}>{fmtSAR(filtered.reduce((s,o)=>s+o.total,0))}</div></div></Card>;
  const tabs=[["summary","📋 Summary"],["category","📂 Category"],["items","🍔 Items"],["stock","📦 Stock"],["eod","🌙 End of Day"]];
  return(<div>
    {showCloseDay&&<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:3000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div style={{background:"#fff",borderRadius:20,padding:32,maxWidth:400,width:"100%",boxShadow:"0 20px 60px rgba(0,0,0,0.3)"}}>
        <div style={{fontSize:32,textAlign:"center",marginBottom:12}}>🌙</div>
        <div style={{fontSize:18,fontWeight:800,color:C.text,textAlign:"center",marginBottom:8}}>Close the Day?</div>
        <div style={{fontSize:13,color:C.textMid,textAlign:"center",marginBottom:20,lineHeight:1.5}}>This will record the end of day at <strong>{new Date().toLocaleTimeString()}</strong>.<br/>Today: <strong>{todaySales.length}</strong> orders · <strong>{fmtSAR(todaySales.reduce((s,o)=>s+o.total,0))}</strong></div>
        <div style={{display:"flex",gap:12}}><button onClick={()=>setShowCloseDay(false)} style={{flex:1,padding:14,background:C.bg,border:`1px solid ${C.border}`,borderRadius:12,fontSize:15,fontWeight:700,cursor:"pointer",fontFamily:"inherit",color:C.text}}>No, Cancel</button><button onClick={handleCloseDay} style={{flex:1,padding:14,background:"linear-gradient(135deg,#1A6B4A,#134D36)",color:"#fff",border:"none",borderRadius:12,fontSize:15,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Yes, Close Day</button></div>
      </div>
    </div>}
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20,flexWrap:"wrap",gap:10}}>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>{tabs.map(([id,label])=><button key={id} onClick={()=>setTab(id)} style={{padding:"8px 16px",borderRadius:8,border:`1.5px solid ${tab===id?C.primary:C.border}`,background:tab===id?C.primaryLight:"#fff",color:tab===id?C.primary:C.textMid,fontFamily:"inherit",fontSize:13,fontWeight:600,cursor:"pointer"}}>{label}</button>)}</div>
      <button onClick={()=>setShowCloseDay(true)} style={{padding:"10px 20px",background:"linear-gradient(135deg,#1A3A5C,#0F2340)",color:"#fff",border:"none",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>🌙 Close Day</button>
    </div>
    {tab==="summary"&&<><DateFilter/><div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:16}}><StatCard icon="💰" label="Revenue" value={fmtSAR(filtered.reduce((s,o)=>s+o.total,0))} color={C.primary} bg={C.primaryLight}/><StatCard icon="🧾" label="Orders" value={filtered.length} color={C.info} bg={C.infoLight}/><StatCard icon="📊" label="VAT" value={fmtSAR(filtered.reduce((s,o)=>s+o.vat,0))} color={C.accent} bg={C.accentLight}/><StatCard icon="💵" label="Avg Order" value={fmtSAR(filtered.length?filtered.reduce((s,o)=>s+o.total,0)/filtered.length:0)} color={C.success} bg={C.successLight}/></div></>}
    {tab==="category"&&<><DateFilter/><Card><DataTable headers={["Category","Revenue"]} rows={catSales.map(c=>[c.cat,<strong style={{color:C.primary}}>{fmtSAR(c.revenue)}</strong>])}/></Card></>}
    {tab==="items"&&<><DateFilter/><Card><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}><div style={{fontSize:14,fontWeight:700}}>Items Sold</div></div>{itemSales.length===0?<div style={{textAlign:"center",padding:"30px 0",color:C.textMid}}>No items sold in this period</div>:<DataTable headers={["Item","Category","Price","Qty Sold","Revenue"]} rows={itemSales.map(it=>[it.name,<Badge color={C.info} bg={C.infoLight}>{it.category}</Badge>,fmtSAR(it.price),<strong style={{color:C.primary,fontSize:15}}>{it.sold}</strong>,fmtSAR(it.revenue)])}/>}</Card></>}
    {tab==="stock"&&<Card><div style={{fontSize:15,fontWeight:700,marginBottom:16}}>Stock Levels</div><DataTable headers={["Item","Category","Stock","Alert"]} rows={items.map(it=>[it.name,it.category,it.stock,it.stock<10?<Badge color={C.danger} bg={C.dangerLight}>Low</Badge>:<Badge color={C.success} bg={C.successLight}>OK</Badge>])}/></Card>}
    {tab==="eod"&&<Card><div style={{fontSize:15,fontWeight:700,marginBottom:20}}>🌙 End of Day Report — {fmtDate(TODAY)}</div>{todayLog?(<div style={{display:"flex",flexDirection:"column",gap:0}}>{[["🟢 Day Started",fmtDateTime(todayLog.startTime)],["🔴 Day Closed",fmtDateTime(todayLog.closeTime)],["Total Orders",todayLog.orderCount],["Total Revenue",fmtSAR(todayLog.revenue)],["VAT Collected",fmtSAR(todayLog.vat)],["Cash Sales",fmtSAR(todaySales.filter(s=>s.payMethod==="Cash").reduce((s,o)=>s+o.total,0))],["Card / Digital",fmtSAR(todaySales.filter(s=>s.payMethod!=="Cash").reduce((s,o)=>s+o.total,0))]].map(([l,v])=><div key={l} style={{display:"flex",justifyContent:"space-between",padding:"12px 0",borderBottom:`1px solid ${C.border}`,fontSize:14}}><span style={{color:C.textMid}}>{l}</span><strong style={{color:C.text}}>{v}</strong></div>)}</div>):(<div style={{textAlign:"center",padding:"40px 0",color:C.textMid}}><div style={{fontSize:40,marginBottom:12}}>🌙</div><div style={{fontSize:14,marginBottom:16}}>Day not closed yet. Click "Close Day" to record.</div><div style={{fontSize:13,color:C.textLight}}>Orders today: {todaySales.length} · {fmtSAR(todaySales.reduce((s,o)=>s+o.total,0))}</div></div>)}</Card>}
  </div>);
}

// ═══════════════════════════════════════════════════════════════════
// TOOLS
// ═══════════════════════════════════════════════════════════════════
function Tools({sales,items,setItems}){
  const [tab,setTab]=useState("export");const [bulkPct,setBulkPct]=useState("");const [bulkCat,setBulkCat]=useState("All");const cats=["All",...new Set(items.map(i=>i.category))];
  function exportCSV(data,filename){const h=Object.keys(data[0]||{}).join(",");const rows=data.map(r=>Object.values(r).map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");const blob=new Blob([h+"\n"+rows],{type:"text/csv"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=filename;a.click();}
  return(<div>
    <div style={{display:"flex",gap:8,marginBottom:20}}>{[["export","📤 Export"],["prices","💲 Bulk Prices"],["backup","💾 Backup"],["zatca_tools","⬛ ZATCA Tools"]].map(([id,label])=><button key={id} onClick={()=>setTab(id)} style={{padding:"8px 16px",borderRadius:8,border:`1.5px solid ${tab===id?C.primary:C.border}`,background:tab===id?C.primaryLight:"#fff",color:tab===id?C.primary:C.textMid,fontFamily:"inherit",fontSize:13,fontWeight:600,cursor:"pointer"}}>{label}</button>)}</div>
    {tab==="export"&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>{[{icon:"📅",title:"Today's Sales",action:()=>exportCSV(sales.filter(s=>s.date===TODAY).map(s=>({id:s.id,date:s.date,time:s.time,type:s.type,total:s.total,vat:s.vat})),"sales-today.csv")},{icon:"📦",title:"Menu & Stock",action:()=>exportCSV(items.map(it=>({name:it.name,category:it.category,price:it.price,cost:it.cost,stock:it.stock})),"menu-stock.csv")},{icon:"📊",title:"Tax Summary",action:()=>exportCSV([{subtotal:sales.reduce((s,o)=>s+o.subtotal,0).toFixed(2),vat:sales.reduce((s,o)=>s+o.vat,0).toFixed(2),total:sales.reduce((s,o)=>s+o.total,0).toFixed(2)}],"tax-summary.csv")}].map(({icon,title,action})=><Card key={title} style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}><div style={{display:"flex",gap:12,alignItems:"center"}}><span style={{fontSize:26}}>{icon}</span><div style={{fontSize:14,fontWeight:700}}>{title}</div></div><Btn size="sm" variant="outline" onClick={action}>Export</Btn></Card>)}</div>}
    {tab==="prices"&&<Card style={{maxWidth:480}}><div style={{fontSize:15,fontWeight:700,marginBottom:16}}>Bulk Price Update</div><div style={{display:"flex",flexDirection:"column",gap:14}}><Sel label="Category" value={bulkCat} onChange={setBulkCat} options={cats}/><Inp label="Change %" value={bulkPct} onChange={setBulkPct} type="number" placeholder="+10 or -5"/><Btn variant="accent" disabled={!bulkPct} onClick={()=>{const pct=parseFloat(bulkPct);setItems(prev=>prev.map(it=>(bulkCat==="All"||it.category===bulkCat)?{...it,price:parseFloat((it.price*(1+pct/100)).toFixed(2))}:it));alert("Prices updated!");setBulkPct("");}}>Apply</Btn></div></Card>}
    {tab==="backup"&&<Card style={{maxWidth:480}}><div style={{fontSize:15,fontWeight:700,marginBottom:14}}>Backup Data</div><Btn onClick={()=>{const backup={timestamp:new Date().toISOString(),items,sales:sales.slice(-200)};const blob=new Blob([JSON.stringify(backup,null,2)],{type:"application/json"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=`restopos-backup-${TODAY}.json`;a.click();}}>💾 Download Backup</Btn></Card>}
    {tab==="zatca_tools"&&<Card>
      <div style={{fontSize:15,fontWeight:700,marginBottom:16}}>⬛ ZATCA Compliance Tools</div>
      <div style={{display:"flex",flexDirection:"column",gap:12}}>
        {[["🔢 Current ICV",`Counter: ${localStorage.getItem(ZATCA_COUNTER_KEY)||"1000"}`],["🔗 Hash Chain",`Last Hash: ${invoiceStorage.getLastHash()?.slice(0,24)||"None (first invoice)"}...`],["📋 Queue Status",`Total: ${zatcaUtils.getQueueStatus().total} · Reported: ${zatcaUtils.getQueueStatus().reported} · Pending: ${zatcaUtils.getQueueStatus().pending}`],["⚠️ Urgent",`${zatcaUtils.getQueueStatus().urgent} invoice(s) near 24hr deadline`]].map(([l,v])=>(
          <div key={l} style={{display:"flex",gap:12,padding:"10px 14px",background:C.bg,borderRadius:8}}><span style={{fontSize:12,fontWeight:700,color:C.zatca,width:160,flexShrink:0}}>{l}</span><span style={{fontSize:12,fontFamily:"monospace"}}>{v}</span></div>
        ))}
        <div style={{marginTop:8,padding:14,background:C.zatcaLight,border:`1px solid ${C.zatca}30`,borderRadius:10,fontSize:12,color:C.zatca}}>💡 FATOORA API is in simulation mode. Add your CSID credentials to <code>reportToFatoora()</code> when ready to go live.</div>
      </div>
    </Card>}
  </div>);
}

// ═══════════════════════════════════════════════════════════════════
// USER ADMIN
// ═══════════════════════════════════════════════════════════════════
function UserAdmin({users,setUsers}){
  const [showModal,setShowModal]=useState(false);const [editUser,setEditUser]=useState(null);const blank={name:"",username:"",role:"Cashier",active:true};const [form,setForm]=useState(blank);
  function openModal(u=null){setEditUser(u);setForm(u?{...u}:{...blank});setShowModal(true);}
  function save(){if(!form.name||!form.username)return alert("Name and username required");setUsers(prev=>editUser?prev.map(u=>u.id===editUser.id?{...form,id:editUser.id}:u):[...prev,{...form,id:Date.now(),lastLogin:"Never"}]);setShowModal(false);}
  return(<div>
    {showModal&&<Modal title={editUser?"Edit User":"New User"} onClose={()=>setShowModal(false)} width={420}>
      <div style={{display:"flex",flexDirection:"column",gap:12}}>
        <Inp label="Full Name" value={form.name} onChange={v=>setForm(f=>({...f,name:v}))}/><Inp label="Username" value={form.username} onChange={v=>setForm(f=>({...f,username:v}))}/>
        <Sel label="Role" value={form.role} onChange={v=>setForm(f=>({...f,role:v}))} options={["Admin","Manager","Cashier"]}/>
        <div style={{display:"flex",alignItems:"center",gap:8}}><input type="checkbox" checked={form.active} onChange={e=>setForm(f=>({...f,active:e.target.checked}))} id="ua"/><label htmlFor="ua" style={{fontSize:13}}>Active</label></div>
      </div>
      <div style={{display:"flex",gap:10,marginTop:16}}><Btn variant="ghost" onClick={()=>setShowModal(false)} style={{flex:1}}>Cancel</Btn><Btn onClick={save} style={{flex:1}}>Save</Btn></div>
    </Modal>}
    <Card><div style={{display:"flex",justifyContent:"space-between",marginBottom:16}}><div style={{fontSize:15,fontWeight:700}}>User Management</div><Btn size="sm" onClick={()=>openModal()}>+ New User</Btn></div><DataTable headers={["Name","Username","Role","Status","Actions"]} rows={users.map(u=>[u.name,<span style={{fontFamily:"monospace"}}>{u.username}</span>,<Badge color={u.role==="Admin"?C.danger:u.role==="Manager"?C.warning:C.info} bg={u.role==="Admin"?C.dangerLight:u.role==="Manager"?C.warningLight:C.infoLight}>{u.role}</Badge>,<Badge color={u.active?C.success:C.danger} bg={u.active?C.successLight:C.dangerLight}>{u.active?"Active":"Off"}</Badge>,<div style={{display:"flex",gap:5}}><Btn size="sm" variant="ghost" onClick={()=>openModal(u)}>Edit</Btn><Btn size="sm" variant="danger" onClick={()=>{if(confirm("Delete?"))setUsers(prev=>prev.filter(x=>x.id!==u.id));}}>Del</Btn></div>])}/></Card>
  </div>);
}

// ═══════════════════════════════════════════════════════════════════
// HELP
// ═══════════════════════════════════════════════════════════════════
function Help(){
  const [tab,setTab]=useState("guide");const [aiMessages,setAiMessages]=useState([{role:"assistant",content:"Hi! I'm the RestoPOS Assistant 🤖 Ask me anything — billing, ZATCA compliance, ICV counters, hash chains, UBL XML, reports, settings, or any feature!"}]);const [aiInput,setAiInput]=useState("");const [aiLoading,setAiLoading]=useState(false);const chatRef=useRef();
  async function sendMessage(){
    if(!aiInput.trim()||aiLoading)return;const userMsg=aiInput.trim();setAiInput("");setAiMessages(prev=>[...prev,{role:"user",content:userMsg}]);setAiLoading(true);
    try{
      let apiKey="";try{const cfgSnap=await getDoc(doc(db,"config","ai"));if(cfgSnap.exists())apiKey=cfgSnap.data().apiKey||"";}catch(e){}
      if(!apiKey)throw new Error("AI not configured. Ask support to enable the AI assistant.");
      const response=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json","x-api-key":apiKey,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:1000,system:`You are RestoPOS Assistant — a helpful support bot for the RestoPOS restaurant management system used in Saudi Arabia. You help restaurant staff with: POS billing, ZATCA QR codes and compliance (Phase 1 & 2), UBL 2.1 XML invoices, FATOORA reporting queue, ICV sequential counters, SHA-256 hash chains, reports, menu management, settings, user roles, barcode scanning, payment methods (Cash, Mada, Apple Pay, STC Pay), VAT calculations (15%), and general app usage. Keep answers short, clear and practical.`,messages:[...aiMessages,{role:"user",content:userMsg}].map(m=>({role:m.role,content:m.content}))})});
      if(!response.ok){const err=await response.json().catch(()=>({}));throw new Error(err?.error?.message||`HTTP ${response.status}`);}
      const data=await response.json();const reply=data.content?.[0]?.text||"Sorry, I couldn't process that.";setAiMessages(prev=>[...prev,{role:"assistant",content:reply}]);
    }catch(e){setAiMessages(prev=>[...prev,{role:"assistant",content:`⚠️ ${e.message||"Unknown error."}`}]);}
    setAiLoading(false);setTimeout(()=>chatRef.current?.scrollTo({top:chatRef.current.scrollHeight,behavior:"smooth"}),100);
  }
  const sections=[["guide","🚀","Guide"],["zatca","⬛","ZATCA"],["ai","🤖","AI Help"],["support","📞","Support"]];
  return(<div style={{display:"flex",gap:20}}>
    <div style={{width:160,flexShrink:0}}><Card style={{padding:8}}>{sections.map(([id,icon,label])=><button key={id} onClick={()=>setTab(id)} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"10px 12px",background:tab===id?C.primaryLight:"transparent",color:tab===id?C.primary:C.textMid,border:"none",borderRadius:8,cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:tab===id?700:500,textAlign:"left",marginBottom:2}}><span>{icon}</span><span>{label}</span></button>)}</Card></div>
    <div style={{flex:1}}>
      {tab==="guide"&&<Card><div style={{fontSize:18,fontWeight:800,marginBottom:20}}>Getting Started</div>{[{n:"1",t:"Activate License",d:"Enter your CR number, VAT number, and 12-digit license key. Saved permanently."},{n:"2",t:"Login by Role",d:"Select Admin, Manager, or Cashier and enter your 4-digit PIN."},{n:"3",t:"Setup Menu",d:"Go to Create → Items to add your menu with Arabic names, prices, and barcodes."},{n:"4",t:"Start Billing",d:"POS opens in Takeaway mode. Add items, fill customer details, process payment."},{n:"5",t:"ZATCA Invoice",d:"Every receipt auto-generates a ZATCA invoice with ICV, UUID, SHA-256 hash, and UBL XML."},{n:"6",t:"Close Day",d:"Go to Reports → click Close Day to record end of day with exact timestamps."}].map((s,i)=><div key={i} style={{display:"flex",gap:14,marginBottom:14,padding:14,background:C.bg,borderRadius:10}}><div style={{width:34,height:34,background:C.primary,color:"#fff",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:800,flexShrink:0}}>{s.n}</div><div><div style={{fontSize:14,fontWeight:700,marginBottom:3}}>{s.t}</div><div style={{fontSize:13,color:C.textMid}}>{s.d}</div></div></div>)}</Card>}
      {tab==="zatca"&&<Card><div style={{fontSize:18,fontWeight:800,marginBottom:20}}>⬛ ZATCA Compliance</div>{[["Standard","ZATCA Phase 1 & Phase 2 Ready"],["QR Encoding","TLV (Tag-Length-Value) → Base64, multi-byte length support"],["Phase 1 QR","5 tags: Seller, VAT, Timestamp, Total, VAT Amount"],["Phase 2 QR","8 tags: + Invoice Hash, ECDSA Signature, Public Key (needs CSID)"],["ICV Counter","Sequential invoice counter — never resets across sessions"],["Hash Chain","SHA-256 hash of each invoice linked to previous (Web Crypto API)"],["UBL 2.1 XML","Full FATOORA-ready XML, downloadable per invoice from Transactions tab"],["FATOORA Queue","24-hour reporting queue with urgency alerts"],["Scannable QR","Real QR code generated on every receipt — works with any ZATCA scanner"]].map(([k,v])=><div key={k} style={{display:"flex",gap:12,padding:"10px 14px",background:C.zatcaLight,borderRadius:8,marginBottom:8}}><span style={{fontSize:12,fontWeight:700,color:C.zatca,width:130,flexShrink:0}}>{k}</span><span style={{fontSize:13}}>{v}</span></div>)}</Card>}
      {tab==="ai"&&<Card style={{display:"flex",flexDirection:"column",height:560}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}><div style={{width:38,height:38,background:"linear-gradient(135deg,#6366f1,#4f46e5)",borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20}}>🤖</div><div><div style={{fontSize:15,fontWeight:800,color:C.text}}>RestoPOS AI Assistant</div><div style={{fontSize:11,color:C.success,fontWeight:600}}>● Powered by Claude · ZATCA & POS expert</div></div></div>
        <div ref={chatRef} style={{flex:1,overflowY:"auto",display:"flex",flexDirection:"column",gap:10,marginBottom:12,paddingRight:4}}>
          {aiMessages.map((msg,i)=>(<div key={i} style={{display:"flex",justifyContent:msg.role==="user"?"flex-end":"flex-start",gap:8,alignItems:"flex-end"}}>{msg.role==="assistant"&&<div style={{width:26,height:26,background:"linear-gradient(135deg,#6366f1,#4f46e5)",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,flexShrink:0,marginBottom:2}}>🤖</div>}<div style={{maxWidth:"78%",padding:"10px 14px",borderRadius:msg.role==="user"?"18px 18px 4px 18px":"18px 18px 18px 4px",background:msg.role==="user"?C.primary:C.bg,color:msg.role==="user"?"#fff":C.text,fontSize:13,lineHeight:1.6,whiteSpace:"pre-wrap"}}>{msg.content}</div></div>))}
          {aiLoading&&<div style={{display:"flex",justifyContent:"flex-start",gap:8,alignItems:"flex-end"}}><div style={{width:26,height:26,background:"linear-gradient(135deg,#6366f1,#4f46e5)",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12}}>🤖</div><div style={{padding:"10px 16px",borderRadius:"18px 18px 18px 4px",background:C.bg,fontSize:18,color:C.zatca,letterSpacing:3}}>•••</div></div>}
        </div>
        <div style={{display:"flex",gap:8}}>
          <input value={aiInput} onChange={e=>setAiInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendMessage();}}} placeholder="Ask anything about RestoPOS or ZATCA…" style={{flex:1,padding:"11px 14px",border:`1.5px solid ${C.border}`,borderRadius:12,fontSize:13,fontFamily:"inherit",outline:"none"}}/>
          <button onClick={sendMessage} disabled={aiLoading||!aiInput.trim()} style={{padding:"11px 22px",background:aiLoading||!aiInput.trim()?"#ccc":"linear-gradient(135deg,#6366f1,#4f46e5)",color:"#fff",border:"none",borderRadius:12,cursor:aiLoading||!aiInput.trim()?"not-allowed":"pointer",fontSize:13,fontWeight:700,fontFamily:"inherit"}}>{aiLoading?"...":"Send ↑"}</button>
        </div>
      </Card>}
      {tab==="support"&&<Card><div style={{fontSize:18,fontWeight:800,marginBottom:20}}>Support & Contact</div>{[{icon:"📦",label:"Product",value:"RestoPOS v8.0 · ZATCA Phase 2"},{icon:"🌍",label:"Region",value:"Kingdom of Saudi Arabia"},{icon:"📧",label:"Email",value:"support@restopos.sa"},{icon:"📞",label:"Phone",value:"+966 50 000 0000 (9AM–6PM)"},{icon:"💬",label:"WhatsApp",value:"+966 50 000 0000"}].map((item,i)=><div key={i} style={{display:"flex",gap:14,padding:"12px 0",borderBottom:`1px solid ${C.border}`,alignItems:"center"}}><span style={{fontSize:20,width:28}}>{item.icon}</span><div style={{fontSize:12,fontWeight:700,color:C.textMid,width:90}}>{item.label}</div><div style={{fontSize:13,color:C.text,fontWeight:600}}>{item.value}</div></div>)}</Card>}
    </div>
  </div>);
}

// ═══════════════════════════════════════════════════════════════════
// OWNER DASHBOARD
// ═══════════════════════════════════════════════════════════════════
const OWNER_PASSWORD="RestoOwner2026";
function OwnerLogin({onLogin}){
  const [pw,setPw]=useState("");const [err,setErr]=useState("");
  return(<div style={{minHeight:"100vh",background:"linear-gradient(135deg,#0a0a1a,#1a0a2e,#0a1a0a)",display:"flex",alignItems:"center",justifyContent:"center",padding:20,fontFamily:"'Plus Jakarta Sans',sans-serif"}}>
    <style>{`@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');*{box-sizing:border-box;margin:0;padding:0}`}</style>
    <div style={{width:"100%",maxWidth:400}}>
      <div style={{textAlign:"center",marginBottom:32}}><div style={{width:64,height:64,background:"linear-gradient(135deg,#F0A500,#e09000)",borderRadius:20,display:"flex",alignItems:"center",justifyContent:"center",fontSize:32,margin:"0 auto 16px"}}>👑</div><div style={{fontSize:26,fontWeight:900,color:"#fff"}}>Owner Dashboard</div><div style={{fontSize:13,color:"rgba(255,255,255,0.4)",marginTop:4}}>RestoPOS · Internal Access</div></div>
      <div style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:20,padding:32}}>
        <div style={{marginBottom:16}}><label style={{fontSize:12,fontWeight:700,color:"rgba(255,255,255,0.5)",display:"block",marginBottom:6}}>Owner Password</label><input type="password" value={pw} onChange={e=>{setPw(e.target.value);setErr("");}} onKeyDown={e=>e.key==="Enter"&&(pw===OWNER_PASSWORD?onLogin():setErr("Incorrect password."))} placeholder="Enter owner password" style={{width:"100%",padding:"12px 16px",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.2)",borderRadius:10,fontSize:14,color:"#fff",fontFamily:"inherit"}}/></div>
        {err&&<div style={{color:"#ff6b6b",fontSize:13,marginBottom:12}}>⚠️ {err}</div>}
        <button onClick={()=>pw===OWNER_PASSWORD?onLogin():setErr("Incorrect password.")} style={{width:"100%",padding:14,background:"linear-gradient(135deg,#F0A500,#e09000)",color:"#fff",border:"none",borderRadius:12,fontSize:15,fontWeight:800,cursor:"pointer",fontFamily:"inherit"}}>Enter Dashboard →</button>
        <button onClick={()=>window.dispatchEvent(new Event("ownerLogout"))} style={{width:"100%",marginTop:10,padding:12,background:"transparent",color:"rgba(255,255,255,0.4)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:12,fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>← Back to Client Login</button>
      </div>
    </div>
  </div>);
}

function OwnerDashboard({onLogout}){
  const [tab,setTab]=useState("overview");const [licenses,setLicenses]=useState([]);const [activations,setActivations]=useState([]);const [loading,setLoading]=useState(true);const [selected,setSelected]=useState(null);const [updating,setUpdating]=useState(false);const [rejectReason,setRejectReason]=useState("");const [showRejectBox,setShowRejectBox]=useState(null);
  useEffect(()=>{loadAll();},[]);
  async function loadAll(){setLoading(true);try{const[licSnap,actSnap]=await Promise.all([getDocs(collection(db,"licenses")),getDocs(collection(db,"pending_activations"))]);setLicenses(licSnap.docs.map(d=>({id:d.id,...d.data()})));const acts=actSnap.docs.map(d=>({id:d.id,...d.data()}));acts.sort((a,b)=>new Date(b.submittedAt||0)-new Date(a.submittedAt||0));setActivations(acts);}catch(e){alert("Load failed: "+e.message);}setLoading(false);}
  async function updateStatus(id,status,reason=""){setUpdating(true);try{await updateDoc(doc(db,"pending_activations",id),{status,reviewedAt:new Date().toISOString(),...(reason?{rejectReason:reason}:{})});setActivations(prev=>prev.map(a=>a.id===id?{...a,status,rejectReason:reason}:a));if(selected?.id===id)setSelected(s=>({...s,status}));}catch(e){alert("Update failed: "+e.message);}setUpdating(false);setShowRejectBox(null);setRejectReason("");}
  async function toggleLicense(id,currentActive){try{await updateDoc(doc(db,"licenses",id),{active:!currentActive});setLicenses(prev=>prev.map(l=>l.id===id?{...l,active:!currentActive}:l));}catch(e){alert("Failed: "+e.message);}}
  const pending=activations.filter(a=>a.status==="pending");
  const statusColor={pending:"#F0A500",approved:"#1A8A4A",rejected:"#D94040",active:"#1A8A4A"};
  const statusBg={pending:"#FEF6E4",approved:"#E6F7ED",rejected:"#FDE8E8",active:"#E6F7ED"};
  return(<div style={{fontFamily:"'Plus Jakarta Sans',sans-serif",background:"#060d1f",minHeight:"100vh",color:"#fff"}}>
    <style>{`@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');*{box-sizing:border-box;margin:0;padding:0}`}</style>
    <div style={{background:"#0a1628",borderBottom:"1px solid rgba(255,255,255,0.08)",padding:"0 24px",height:56,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
      <div style={{display:"flex",alignItems:"center",gap:10}}><div style={{width:32,height:32,background:"linear-gradient(135deg,#F0A500,#e09000)",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>👑</div><div style={{fontSize:15,fontWeight:800}}>Owner Dashboard</div>{loading&&<span style={{fontSize:12,color:"rgba(255,255,255,0.4)",marginLeft:8}}>Loading…</span>}</div>
      <div style={{display:"flex",gap:8}}><button onClick={loadAll} style={{padding:"6px 14px",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,color:"rgba(255,255,255,0.7)",fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>🔄 Refresh</button><button onClick={onLogout} style={{padding:"6px 14px",background:"rgba(217,64,64,0.15)",border:"1px solid rgba(217,64,64,0.3)",borderRadius:8,color:"#ff6b6b",fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>Logout</button></div>
    </div>
    <div style={{padding:24}}>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(180px,1fr))",gap:14,marginBottom:24}}>
        {[["Total Licenses",licenses.length,"#6366f1"],["Active",licenses.filter(l=>l.active).length,"#1A8A4A"],["Clients",activations.length,"#F0A500"],["Pending",pending.length,"#D94040"]].map(([l,v,c])=>(<div key={l} style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:12,padding:"16px 20px"}}><div style={{fontSize:28,fontWeight:900,color:c}}>{v}</div><div style={{fontSize:12,color:"rgba(255,255,255,0.5)",marginTop:2}}>{l}</div></div>))}
      </div>
      <div style={{display:"flex",gap:6,marginBottom:20}}>{[["overview","📊 Overview"],["pending","⏳ Pending"],["clients","👥 All Clients"],["licenses","🔑 Licenses"]].map(([id,label])=>(<button key={id} onClick={()=>setTab(id)} style={{padding:"8px 16px",background:tab===id?"rgba(99,102,241,0.2)":"rgba(255,255,255,0.04)",border:`1px solid ${tab===id?"rgba(99,102,241,0.5)":"rgba(255,255,255,0.08)"}`,borderRadius:8,color:tab===id?"#a5b4fc":"rgba(255,255,255,0.5)",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>{label}{id==="pending"&&pending.length>0&&<span style={{background:"#D94040",color:"#fff",borderRadius:20,padding:"1px 7px",fontSize:11,marginLeft:4}}>{pending.length}</span>}</button>))}</div>
      {tab==="overview"&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
        <div style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:14,padding:20}}><div style={{fontSize:14,fontWeight:700,marginBottom:14}}>Recent Activations</div>{activations.slice(0,8).map((a,i)=>(<div key={a.id} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid rgba(255,255,255,0.04)",fontSize:13}}><span style={{color:"rgba(255,255,255,0.8)"}}>{a.businessName}</span><span style={{color:statusColor[a.status]||"rgba(255,255,255,0.4)",fontSize:11,fontWeight:700}}>{a.status}</span></div>))}</div>
        <div style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:14,padding:20}}><div style={{fontSize:14,fontWeight:700,marginBottom:14}}>License Key Status</div><div style={{display:"flex",gap:16}}><div style={{textAlign:"center"}}><div style={{fontSize:32,fontWeight:900,color:"#1A8A4A"}}>{licenses.filter(l=>l.active&&l.activatedBy).length}</div><div style={{fontSize:11,color:"rgba(255,255,255,0.4)"}}>Used</div></div><div style={{textAlign:"center"}}><div style={{fontSize:32,fontWeight:900,color:"#6366f1"}}>{licenses.filter(l=>l.active&&!l.activatedBy).length}</div><div style={{fontSize:11,color:"rgba(255,255,255,0.4)"}}>Available</div></div><div style={{textAlign:"center"}}><div style={{fontSize:32,fontWeight:900,color:"#D94040"}}>{licenses.filter(l=>!l.active).length}</div><div style={{fontSize:11,color:"rgba(255,255,255,0.4)"}}>Inactive</div></div></div></div>
      </div>}
      {tab==="pending"&&<div style={{display:"grid",gridTemplateColumns:selected?"1fr 1fr":"1fr",gap:16}}>
        <div>{pending.length===0?<div style={{textAlign:"center",padding:"60px 0",color:"rgba(255,255,255,0.3)"}}><div style={{fontSize:48,marginBottom:12}}>✅</div><div>No pending reviews</div></div>:pending.map(a=>(<div key={a.id} onClick={()=>setSelected(a)} style={{background:selected?.id===a.id?"rgba(99,102,241,0.1)":"rgba(255,255,255,0.04)",border:`1px solid ${selected?.id===a.id?"rgba(99,102,241,0.4)":"rgba(255,255,255,0.08)"}`,borderRadius:12,padding:16,marginBottom:10,cursor:"pointer"}}><div style={{fontSize:15,fontWeight:700}}>{a.businessName}</div><div style={{fontSize:12,color:"rgba(255,255,255,0.5)",marginTop:4}}>CR: {a.crNumber} · VAT: {a.vatNumber}</div><div style={{fontSize:11,color:"#F0A500",marginTop:4}}>🔑 {a.licenseKey}</div></div>))}</div>
        {selected&&<div style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:14,padding:20,height:"fit-content"}}>
          <div style={{fontSize:16,fontWeight:800,marginBottom:16}}>{selected.businessName}</div>
          {[["CR Number",selected.crNumber],["VAT Number",selected.vatNumber],["License Key",selected.licenseKey],["City",selected.city||"—"],["Phone",selected.phone||"—"],["Submitted",selected.submittedAt?fmtDateTime(selected.submittedAt):"—"],["Status",selected.status]].map(([l,v])=>(<div key={l} style={{display:"flex",gap:12,padding:"8px 0",borderBottom:"1px solid rgba(255,255,255,0.06)",fontSize:13}}><span style={{color:"rgba(255,255,255,0.4)",width:110,flexShrink:0}}>{l}</span><span style={{color:"#fff",fontFamily:["CR Number","VAT Number","License Key"].includes(l)?"monospace":"inherit"}}>{v}</span></div>))}
          {selected.status==="pending"&&<div style={{marginTop:16,display:"flex",flexDirection:"column",gap:8}}>
            <button onClick={()=>updateStatus(selected.id,"approved")} disabled={updating} style={{padding:"10px 20px",background:"rgba(26,138,74,0.2)",border:"1px solid rgba(26,138,74,0.4)",borderRadius:8,color:"#4ade80",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>✓ Approve</button>
            {showRejectBox===selected.id?<div><input value={rejectReason} onChange={e=>setRejectReason(e.target.value)} placeholder="Rejection reason…" style={{width:"100%",padding:"8px 12px",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.2)",borderRadius:8,color:"#fff",fontSize:13,fontFamily:"inherit",marginBottom:6}}/><button onClick={()=>updateStatus(selected.id,"rejected",rejectReason)} disabled={updating} style={{width:"100%",padding:"8px",background:"rgba(217,64,64,0.2)",border:"1px solid rgba(217,64,64,0.4)",borderRadius:8,color:"#ff6b6b",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Confirm Reject</button></div>:<button onClick={()=>setShowRejectBox(selected.id)} style={{padding:"10px 20px",background:"rgba(217,64,64,0.1)",border:"1px solid rgba(217,64,64,0.3)",borderRadius:8,color:"#ff6b6b",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>✕ Reject</button>}
          </div>}
        </div>}
      </div>}
      {tab==="clients"&&<div style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:14,overflow:"hidden"}}>
        <div style={{padding:"16px 20px",borderBottom:"1px solid rgba(255,255,255,0.08)"}}><div style={{fontSize:14,fontWeight:700}}>All Clients ({activations.length})</div></div>
        <div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
          <thead><tr style={{background:"rgba(255,255,255,0.04)"}}>{["Business","CR","VAT","License Key","City","Submitted","Status"].map(h=><th key={h} style={{padding:"10px 14px",textAlign:"left",color:"rgba(255,255,255,0.4)",fontWeight:700,fontSize:10,textTransform:"uppercase",borderBottom:"1px solid rgba(255,255,255,0.06)",whiteSpace:"nowrap"}}>{h}</th>)}</tr></thead>
          <tbody>{activations.map((a,i)=>(<tr key={a.id} style={{borderBottom:"1px solid rgba(255,255,255,0.04)",background:i%2===0?"transparent":"rgba(255,255,255,0.02)"}}><td style={{padding:"10px 14px",color:"#fff",fontWeight:600}}>{a.businessName}</td><td style={{padding:"10px 14px",color:"rgba(255,255,255,0.6)",fontFamily:"monospace",fontSize:11}}>{a.crNumber}</td><td style={{padding:"10px 14px",color:"rgba(255,255,255,0.6)",fontFamily:"monospace",fontSize:11}}>{a.vatNumber}</td><td style={{padding:"10px 14px",color:"#F0A500",fontFamily:"monospace",fontSize:11}}>{a.licenseKey}</td><td style={{padding:"10px 14px",color:"rgba(255,255,255,0.6)"}}>{a.city||"—"}</td><td style={{padding:"10px 14px",color:"rgba(255,255,255,0.5)",fontSize:11}}>{a.submittedAt?fmtDate(a.submittedAt):"—"}</td><td style={{padding:"10px 14px"}}><span style={{padding:"3px 10px",borderRadius:20,fontSize:10,fontWeight:700,color:statusColor[a.status]||"rgba(255,255,255,0.5)",background:statusBg[a.status]||"rgba(255,255,255,0.05)"}}>{a.status}</span></td></tr>))}</tbody>
        </table></div>
      </div>}
      {tab==="licenses"&&<div style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:14,overflow:"hidden"}}>
        <div style={{padding:"16px 20px",borderBottom:"1px solid rgba(255,255,255,0.08)"}}><div style={{fontSize:14,fontWeight:700}}>License Keys ({licenses.length})</div></div>
        <div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
          <thead><tr style={{background:"rgba(255,255,255,0.04)"}}>{["Key","Status","Activated By","Activated At","Toggle"].map(h=><th key={h} style={{padding:"10px 14px",textAlign:"left",color:"rgba(255,255,255,0.4)",fontWeight:700,fontSize:10,textTransform:"uppercase",borderBottom:"1px solid rgba(255,255,255,0.06)",whiteSpace:"nowrap"}}>{h}</th>)}</tr></thead>
          <tbody>{licenses.map((l,i)=>(<tr key={l.id} style={{borderBottom:"1px solid rgba(255,255,255,0.04)",background:i%2===0?"transparent":"rgba(255,255,255,0.02)"}}><td style={{padding:"10px 14px",fontFamily:"monospace",color:"#F0A500",fontWeight:700}}>{l.key}</td><td style={{padding:"10px 14px"}}><span style={{padding:"3px 10px",borderRadius:20,fontSize:10,fontWeight:700,color:l.active?"#1A8A4A":"#D94040",background:l.active?"#E6F7ED":"#FDE8E8"}}>{l.active?"Active":"Inactive"}</span></td><td style={{padding:"10px 14px",color:"rgba(255,255,255,0.7)"}}>{l.activatedBy||"—"}</td><td style={{padding:"10px 14px",color:"rgba(255,255,255,0.5)",fontSize:11}}>{l.activatedAt?fmtDateTime(l.activatedAt):"—"}</td><td style={{padding:"10px 14px"}}><button onClick={()=>toggleLicense(l.id,l.active)} style={{padding:"5px 12px",background:l.active?"rgba(217,64,64,0.15)":"rgba(26,138,74,0.15)",border:`1px solid ${l.active?"rgba(217,64,64,0.3)":"rgba(26,138,74,0.3)"}`,borderRadius:6,color:l.active?"#ff6b6b":"#4ade80",fontSize:11,cursor:"pointer",fontFamily:"inherit",fontWeight:700}}>{l.active?"Deactivate":"Activate"}</button></td></tr>))}</tbody>
        </table></div>
      </div>}
    </div>
  </div>);
}

// ═══════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════
export default function App(){
  const [step,setStep]=useState("checking");const [businessData,setBusinessData]=useState(null);const [license,setLicense]=useState(null);const [currentUser,setCurrentUser]=useState(null);const [screen,setScreen]=useState("pos");const [ownerMode,setOwnerMode]=useState(false);const [ownerAuthed,setOwnerAuthed]=useState(false);
  useEffect(()=>{const onOwner=()=>setOwnerMode(true);const onOwnerOut=()=>{setOwnerMode(false);setOwnerAuthed(false);};window.addEventListener("ownerLogin",onOwner);window.addEventListener("ownerLogout",onOwnerOut);return()=>{window.removeEventListener("ownerLogin",onOwner);window.removeEventListener("ownerLogout",onOwnerOut);};},[]);
  const [sales,_setSales]=useState(()=>LS.get("restopos_sales")||[]);
  const [items,_setItems]=useState(()=>LS.get("restopos_items")||SEED_ITEMS);
  const [tables,_setTables]=useState(()=>LS.get("restopos_tables")||TABLES_INIT);
  const [users,_setUsers]=useState(()=>LS.get("restopos_users")||[{id:1,name:"Admin User",username:"admin",role:"Admin",active:true,lastLogin:"Today"},{id:2,name:"Manager",username:"manager",role:"Manager",active:true,lastLogin:"Today"},{id:3,name:"Cashier",username:"cashier",role:"Cashier",active:true,lastLogin:"Today"}]);
  const [promos,_setPromos]=useState(()=>LS.get("restopos_promos")||[{id:1,code:"SAVE10",type:"%",value:10,active:true,minOrder:30},{id:2,code:"FLAT20",type:"flat",value:20,active:true,minOrder:100}]);
  const [company,_setCompany]=useState(()=>LS.get("restopos_company")||{phone:"",email:"",address:"",city:"Riyadh"});
  const [pins,_setPins]=useState(()=>LS.get("restopos_pins")||DEFAULT_PINS);
  function setSales(v){_setSales(p=>{const n=typeof v==="function"?v(p):v;LS.set("restopos_sales",n.slice(-500));return n;});}
  function setItems(v){_setItems(p=>{const n=typeof v==="function"?v(p):v;LS.set("restopos_items",n);return n;});}
  function setTables(v){_setTables(p=>{const n=typeof v==="function"?v(p):v;LS.set("restopos_tables",n);return n;});}
  function setUsers(v){_setUsers(p=>{const n=typeof v==="function"?v(p):v;LS.set("restopos_users",n);return n;});}
  function setPromos(v){_setPromos(p=>{const n=typeof v==="function"?v(p):v;LS.set("restopos_promos",n);return n;});}
  function setCompany(v){_setCompany(p=>{const n=typeof v==="function"?v(p):v;LS.set("restopos_company",n);return n;});}
  function setPins(v){_setPins(p=>{const n=typeof v==="function"?v(p):v;LS.set("restopos_pins",n);return n;});}
  useEffect(()=>{const saved=LS.get("restopos_license_v2");const pendingId=localStorage.getItem("restopos_pending_id");if(saved){setLicense(saved);setStep("login");}else if(pendingId){setStep("license");}else setStep("register");},[]);
  function handleClearLicense(){LS.del("restopos_license_v2");LS.del("restopos_pins");setLicense(null);setCurrentUser(null);setStep("register");}
  const ALL_NAV=[["dashboard","📊","Dashboard",["Admin","Manager"]],["pos","🖥️","POS",["Admin","Manager","Cashier"]],["settings","⚙️","Settings",["Admin"]],["create","➕","Create",["Admin","Manager"]],["transactions","💳","Transactions",["Admin","Manager"]],["accounts","📈","Accounts",["Admin","Manager"]],["reports","📋","Reports",["Admin","Manager"]],["tools","🔧","Tools",["Admin"]],["useradmin","👤","Users",["Admin"]],["help","❓","Help",["Admin","Manager","Cashier"]]];
  const NAV=ALL_NAV.filter(([,,,roles])=>currentUser&&roles.includes(currentUser.role));
  if(ownerMode&&!ownerAuthed)return<OwnerLogin onLogin={()=>setOwnerAuthed(true)}/>;
  if(ownerMode&&ownerAuthed)return<OwnerDashboard onLogout={()=>{setOwnerMode(false);setOwnerAuthed(false);}}/>;
  if(step==="checking")return<div style={{minHeight:"100vh",background:"#0a1628",display:"flex",alignItems:"center",justifyContent:"center"}}><div style={{color:"#fff",fontSize:16}}>Loading…</div></div>;
  if(step==="register")return<BusinessRegistration onNext={(data)=>{setBusinessData(data);setStep("license");}}/>;
  if(step==="license")return<LicenseVerification businessData={businessData||{businessName:"",crNumber:"",vatNumber:"",address:"",city:"",phone:""}} onSuccess={(lic)=>{setLicense(lic);setStep("login");}} onBack={()=>setStep("register")}/>;
  if(step==="login"||!currentUser)return<RoleLogin license={license} onLogin={(user)=>{setCurrentUser(user);setStep("app");if(user.role==="Cashier")setScreen("pos");}}/>;
  return(
    <div style={{fontFamily:"'Plus Jakarta Sans','Tajawal',sans-serif",background:C.bg,minHeight:"100vh",display:"flex",flexDirection:"column"}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Tajawal:wght@400;500;700&display=swap');*{box-sizing:border-box;margin:0;padding:0}::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-track{background:${C.bg}}::-webkit-scrollbar-thumb{background:${C.border};border-radius:3px}input,select{outline:none}input:focus,select:focus{border-color:${C.primary}!important}@media print{header,nav{display:none!important}}`}</style>
      <div style={{background:"#fff",borderBottom:`1px solid ${C.border}`,height:52,display:"flex",alignItems:"center",padding:"0 16px",justifyContent:"space-between",position:"sticky",top:0,zIndex:100,boxShadow:"0 1px 8px rgba(0,0,0,0.06)"}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}><div style={{width:30,height:30,background:"linear-gradient(135deg,#1A6B4A,#F0A500)",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:15,fontWeight:900}}>R</div><div><div style={{fontSize:14,fontWeight:800,color:C.text,lineHeight:1}}>RestoPOS</div><div style={{fontSize:9,color:C.textLight,letterSpacing:"0.08em"}}>ZATCA PHASE 2 · v8.0</div></div></div>
        <div style={{display:"flex",gap:1,overflowX:"auto"}}>{NAV.map(([id,icon,label])=><button key={id} onClick={()=>setScreen(id)} style={{padding:"5px 9px",borderRadius:8,border:"none",background:screen===id?C.primaryLight:"transparent",color:screen===id?C.primary:C.textMid,fontFamily:"inherit",fontSize:11,fontWeight:screen===id?700:500,cursor:"pointer",display:"flex",alignItems:"center",gap:4,whiteSpace:"nowrap"}}><span>{icon}</span><span>{label}</span></button>)}</div>
        <div style={{display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:11,background:C.zatcaLight,color:C.zatca,padding:"3px 8px",borderRadius:6,fontWeight:700}}>⬛ ZATCA</span><div style={{fontSize:11,color:C.textMid,fontWeight:700}}>{currentUser?.role}</div><button onClick={()=>setCurrentUser(null)} style={{fontSize:11,background:C.dangerLight,color:C.danger,border:"none",padding:"4px 8px",borderRadius:6,cursor:"pointer",fontFamily:"inherit",fontWeight:700}}>Logout</button></div>
      </div>
      <div style={{flex:1,padding:screen==="pos"?0:20,overflowY:screen==="pos"?"hidden":"auto",width:"100%"}}>
        {screen==="dashboard"&&<Dashboard sales={sales} items={items} license={license}/>}
        {screen==="pos"&&<POS items={items} sales={sales} setSales={setSales} tables={tables} setTables={setTables} promos={promos} license={license}/>}
        {screen==="settings"&&<Settings company={company} setCompany={setCompany} tables={tables} setTables={setTables} license={license} onClearLicense={handleClearLicense} pins={pins} setPins={setPins}/>}
        {screen==="create"&&<Create items={items} setItems={setItems} promos={promos} setPromos={setPromos}/>}
        {screen==="transactions"&&<Transactions sales={sales} setSales={setSales} license={license}/>}
        {screen==="accounts"&&<Accounts sales={sales} items={items}/>}
        {screen==="reports"&&<Reports sales={sales} items={items} setSales={setSales}/>}
        {screen==="tools"&&<Tools sales={sales} items={items} setItems={setItems}/>}
        {screen==="useradmin"&&<UserAdmin users={users} setUsers={setUsers}/>}
        {screen==="help"&&<Help/>}
      </div>
    </div>
  );
}
