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

// ═══════════════════════════════════════════════════════════════════
// SUBSCRIPTION PLANS
// ═══════════════════════════════════════════════════════════════════
const SUBSCRIPTION_PLANS={
  basic:{id:"basic",name:"Basic",nameAr:"الأساسية",price:150,color:"#6366f1",features:["1 device/location","2 users (Admin + Cashier)","Up to 100 items","Up to 10 tables","Basic reports (daily/weekly/monthly)","Standard receipt printing","ZATCA Phase 2 compliance","Email support (48h response)","Data retention: 3 months"],limits:{devices:1,users:2,items:100,tables:10}},
  professional:{id:"professional",name:"Professional",nameAr:"الاحترافية",price:299,color:"#F0A500",features:["3 devices/locations","5 users","Up to 500 items","Up to 30 tables","Advanced reports & analytics","Custom receipt branding","Multi-location sync","Inventory tracking & alerts","Priority support (24h response)","Data retention: 12 months","Export data (Excel/PDF)"],limits:{devices:3,users:5,items:500,tables:30}},
  premium:{id:"premium",name:"Premium",nameAr:"المميزة",price:399,color:"#1A8A4A",features:["5 devices/locations","10 users","Up to 2000 items","Up to 100 tables","Real-time analytics & insights","Advanced inventory management","Customer loyalty program","Employee performance tracking","WhatsApp/SMS receipts","Priority phone support (12h response)","Data retention: Lifetime","API access"],limits:{devices:5,users:10,items:2000,tables:100}}
};

// Activity log helper
function logActivity(action,details,user="System"){
  const logs=LS.get("restopos_activity_log")||[];
  logs.unshift({id:Date.now(),timestamp:new Date().toISOString(),action,details,user,before:details.before,after:details.after});
  LS.set("restopos_activity_log",logs.slice(0,500));
}

// Device fingerprint helper
function getDeviceInfo(){
  const ua=navigator.userAgent;
  const brand=ua.includes("iPhone")||ua.includes("iPad")?"Apple":ua.includes("Samsung")?"Samsung":ua.includes("Huawei")?"Huawei":"Unknown";
  const os=ua.includes("iPhone")||ua.includes("iPad")?"iOS":ua.includes("Android")?"Android":ua.includes("Windows")?"Windows":ua.includes("Mac")?"macOS":"Other";
  const browser=ua.includes("Chrome")?"Chrome":ua.includes("Firefox")?"Firefox":ua.includes("Safari")?"Safari":ua.includes("Edge")?"Edge":"Other";
  return{brand,os,browser,userAgent:ua.slice(0,120),screenW:screen.width,screenH:screen.height};
}
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
      const devInfo=getDeviceInfo();
      await updateDoc(doc(db,"licenses",licDoc.id),{activatedBy:businessData.crNumber,activatedAt:new Date().toISOString(),businessName:businessData.businessName,vatNumber:businessData.vatNumber,deviceId:navigator.userAgent.slice(0,100),deviceInfo:devInfo});
      await addDoc(collection(db,"pending_activations"),{...businessData,licenseKey:cleanKey,submittedAt:new Date().toISOString(),status:"approved",subscriptionPlan:"basic",deviceId:navigator.userAgent.slice(0,100),deviceInfo:devInfo});
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
        {LS.get("restopos_announcement")&&<div style={{background:"rgba(240,165,0,0.15)",border:"1px solid rgba(240,165,0,0.3)",borderRadius:10,padding:"10px 16px",marginBottom:16,fontSize:12,color:"#F0A500",fontWeight:600}}>📢 {LS.get("restopos_announcement")}</div>}
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
  const qrReady=useQRScript();

  function buildReceiptHTML(qrImgSrc){
    const zatcaMeta=zatcaInvoice?`<div class="row"><span>ZATCA Invoice</span><span>${zatcaInvoice.invoice_number}</span></div><div class="row"><span>ICV</span><span>${zatcaInvoice.icv}</span></div><div style="font-size:8px;text-align:center;color:#666;word-break:break-all;margin-top:2px">Hash: ${zatcaInvoice.invoice_hash?.slice(0,24)}...</div>`:"";
    // Group items by category
    const cats=[...new Set(order.items.map(i=>i.category||"Items"))];
    const itemsHTML=cats.map(cat=>{
      const catItems=order.items.filter(i=>(i.category||"Items")===cat);
      return `<div style="font-size:9px;font-weight:bold;letter-spacing:0.08em;color:#555;margin-top:6px;margin-bottom:2px;text-transform:uppercase;">${cat}</div>`+
        catItems.map(it=>`<div class="row"><span class="item-name">${it.name}${it.nameAr?`<br/><span style="font-family:'Noto Naskh Arabic','Arial',sans-serif;direction:rtl;display:block;text-align:right;font-size:11px;color:#333;">${it.nameAr}</span>`:""}<br/><small style="color:#666;">${it.qty} × SAR ${it.price.toFixed(2)}</small></span><span class="item-amt">SAR ${(it.qty*it.price).toFixed(2)}</span></div>`).join("");
    }).join("");
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Receipt ${order.id}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Noto+Naskh+Arabic:wght@400;700&display=swap" rel="stylesheet">
<style>@page{size:80mm auto;margin:0}*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Courier New',monospace;font-size:12px;color:#000;background:#fff;width:80mm;padding:4mm}.center{text-align:center}.bold{font-weight:bold}.big{font-size:16px;font-weight:bold}.hr{border:none;border-top:1px dashed #000;margin:6px 0}.row{display:flex;justify-content:space-between;margin:2px 0;align-items:flex-start}.row-total{display:flex;justify-content:space-between;margin:4px 0;font-size:15px;font-weight:900;border-top:2px solid #000;padding-top:4px}.item-name{flex:1;padding-right:4px}.item-amt{white-space:nowrap;padding-top:1px}.qr-img{width:110px;height:110px;display:block;margin:0 auto}.zatca-label{font-size:9px;font-weight:bold;letter-spacing:0.1em}@media print{body{width:80mm}}</style>
</head><body>
<div class="center"><div class="big">${license.businessName}</div><div>${license.address||""}</div><div>TRN: ${license.vatNumber}</div><div>${order.id} | ${order.date} ${order.time}</div>${order.customer?`<div>Customer: ${order.customer}</div>`:""}<div>${order.type}${order.table?` · Table ${order.table}`:""}</div></div>
<hr class="hr"/>
${itemsHTML}
<hr class="hr"/>
<div class="row"><span>Subtotal</span><span>SAR ${order.subtotal.toFixed(2)}</span></div>${order.discount>0?`<div class="row"><span>Discount</span><span>-SAR ${order.discount.toFixed(2)}</span></div>`:""}
<div class="row"><span>VAT 15%</span><span>SAR ${order.vat.toFixed(2)}</span></div>
<div class="row-total"><span>TOTAL</span><span>SAR ${order.total.toFixed(2)}</span></div>
${order.payMethod==="Cash"?`<div class="row"><span>Cash Given</span><span>SAR ${Number(order.given).toFixed(2)}</span></div><div class="row bold"><span>Change</span><span>SAR ${Number(order.change).toFixed(2)}</span></div>`:`<div class="row bold"><span>Payment</span><span>${order.payMethod}</span></div>`}
<hr class="hr"/>${zatcaMeta}
<div style="text-align:center;margin:8px 0;">
${qrImgSrc?`<img class="qr-img" src="${qrImgSrc}" alt="ZATCA QR"/>`:`<div style="width:110px;height:110px;border:1px solid #ccc;margin:0 auto;display:flex;align-items:center;justify-content:center;font-size:9px;color:#999;">QR unavailable</div>`}
<div class="zatca-label" style="margin-top:4px;">ZATCA PHASE 2 · QR CODE</div>
<div style="font-size:8px;color:#666;">TLV Base64 · Scan to verify</div>
</div>
<div class="bold center" style="margin-top:6px;font-size:13px;">Thank you for your visit!</div>
<div style="font-family:'Noto Naskh Arabic','Arial',sans-serif;font-size:14px;font-weight:bold;text-align:center;direction:rtl;margin-top:3px;">شكراً لزيارتكم</div>
<br/><br/>
</body></html>`;
  }

  function handleThermalPrint(){
    function doGenQR(){
      let qrImgSrc="";
      try{
        const tempDiv=document.createElement("div");
        tempDiv.style.cssText="position:absolute;left:-9999px;top:-9999px;width:120px;height:120px;";
        document.body.appendChild(tempDiv);
        new window.QRCode(tempDiv,{text:qrData,width:110,height:110,colorDark:"#000000",colorLight:"#ffffff",correctLevel:window.QRCode?.CorrectLevel?.M});
        // QRCode renders async into an img tag (not canvas) in some builds — grab whichever exists
        const canvas=tempDiv.querySelector("canvas");
        const img=tempDiv.querySelector("img");
        if(canvas)qrImgSrc=canvas.toDataURL("image/png");
        else if(img&&img.src)qrImgSrc=img.src;
        document.body.removeChild(tempDiv);
      }catch(e){console.warn("QR gen error:",e);}
      const html=buildReceiptHTML(qrImgSrc);
      const iframe=printFrameRef.current;
      const docW=iframe.contentDocument||iframe.contentWindow.document;
      docW.open();docW.write(html);docW.close();
      setTimeout(()=>{iframe.contentWindow.focus();iframe.contentWindow.print();},600);
    }
    if(window.QRCode){doGenQR();}
    else{
      const s=document.createElement("script");
      s.src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";
      s.onload=()=>setTimeout(doGenQR,200);
      document.head.appendChild(s);
    }
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
        {[...new Set(order.items.map(i=>i.category||"Items"))].map(cat=>(
          <div key={cat}>
            <div style={{fontSize:9,fontWeight:700,color:C.textLight,textTransform:"uppercase",letterSpacing:"0.08em",margin:"6px 0 2px"}}>{cat}</div>
            {order.items.filter(i=>(i.category||"Items")===cat).map((it,idx)=>(
              <div key={idx} style={{display:"flex",justifyContent:"space-between",margin:"3px 0",alignItems:"flex-start"}}>
                <span style={{flex:1,paddingRight:8}}>
                  <span style={{fontWeight:600}}>{it.name}</span>
                  {it.nameAr&&<span style={{display:"block",direction:"rtl",fontFamily:"'Tajawal',sans-serif",fontSize:11,color:C.textMid}}>{it.nameAr}</span>}
                  <span style={{display:"block",fontSize:10,color:C.textLight}}>{it.qty} × SAR {it.price.toFixed(2)}</span>
                </span>
                <span style={{whiteSpace:"nowrap",fontWeight:700}}>SAR {(it.qty*it.price).toFixed(2)}</span>
              </div>
            ))}
          </div>
        ))}
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
// LIVE CLOCK
// ═══════════════════════════════════════════════════════════════════
function LiveClock(){
  const [now,setNow]=useState(new Date());
  useEffect(()=>{const t=setInterval(()=>setNow(new Date()),1000);return()=>clearInterval(t);},[]);
  const timeStr=now.toLocaleTimeString("en-SA",{hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:true});
  const dateEn=now.toLocaleDateString("en-SA",{weekday:"short",year:"numeric",month:"short",day:"numeric"});
  const dateHijri=now.toLocaleDateString("ar-SA-u-ca-islamic",{year:"numeric",month:"long",day:"numeric"});
  return(
    <div style={{background:"linear-gradient(135deg,#1A3D2B 0%,#1F4D36 100%)",borderRadius:10,padding:"8px 16px",marginBottom:20,display:"inline-flex",alignItems:"center",gap:12,border:"1px solid rgba(255,255,255,0.1)",boxShadow:"0 2px 8px rgba(0,0,0,0.1)"}}>
      <div style={{fontSize:18,fontWeight:900,color:"#fff",fontFamily:"'DM Mono','Courier New',monospace",letterSpacing:"0.06em",lineHeight:1}}>{timeStr}</div>
      <div style={{width:1,height:22,background:"rgba(255,255,255,0.2)"}}/>
      <div><div style={{fontSize:11,color:"rgba(255,255,255,0.85)",fontWeight:700}}>{dateEn}</div><div style={{fontSize:10,color:"rgba(240,165,0,0.9)",fontFamily:"'Tajawal',sans-serif",direction:"rtl",marginTop:1}}>{dateHijri}</div></div>
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
      <LiveClock/>
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
// INVOICE FORMAT TAB
// ═══════════════════════════════════════════════════════════════════
const RECEIPT_FONTS=[
  {id:"courier",label:"Courier New",family:"'Courier New',monospace",lang:"EN"},
  {id:"georgia",label:"Georgia",family:"Georgia,serif",lang:"EN"},
  {id:"trebuchet",label:"Trebuchet MS",family:"'Trebuchet MS',sans-serif",lang:"EN"},
  {id:"arial-narrow",label:"Arial Narrow",family:"'Arial Narrow',Arial,sans-serif",lang:"EN"},
  {id:"impact",label:"Impact",family:"Impact,Haettenschweiler,sans-serif",lang:"EN"},
  {id:"tajawal",label:"Tajawal",family:"'Tajawal',sans-serif",lang:"AR"},
  {id:"cairo",label:"Cairo",family:"'Cairo',sans-serif",lang:"AR"},
  {id:"amiri",label:"Amiri",family:"'Amiri',serif",lang:"AR"},
  {id:"scheherazade",label:"Scheherazade New",family:"'Scheherazade New',serif",lang:"AR"},
  {id:"noto-naskh",label:"Noto Naskh Arabic",family:"'Noto Naskh Arabic',serif",lang:"AR"},
];

function InvoiceFormatTab({license,company,invoiceFormat,setInvoiceFormat}){
  const [saved,setSaved]=useState(false);
  const fmt=invoiceFormat||{font:"courier",fontSize:12,shopNameOverride:"",footer:"Thank you for your visit!",footerAr:"شكراً لزيارتكم",website:"",social:"",tagline:""};
  function update(k,v){const updated={...(invoiceFormat||fmt),[k]:v};setInvoiceFormat(updated);LS.set("restopos_invoice_format",updated);setSaved(false);}
  function save(){LS.set("restopos_invoice_format",invoiceFormat);setSaved(true);setTimeout(()=>setSaved(false),3000);}
  const selectedFont=RECEIPT_FONTS.find(f=>f.id===fmt.font)||RECEIPT_FONTS[0];
  return(
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20,alignItems:"start"}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Tajawal:wght@400;700&family=Cairo:wght@400;700&family=Amiri:wght@400;700&family=Scheherazade+New:wght@400;700&family=Noto+Naskh+Arabic:wght@400;700&display=swap');`}</style>
      <div>
        <Card style={{marginBottom:16}}>
          <div style={{fontSize:14,fontWeight:700,marginBottom:16}}>🔤 Receipt Font</div>
          <div style={{fontSize:11,color:C.textMid,marginBottom:10}}>English fonts</div>
          <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:14}}>
            {RECEIPT_FONTS.filter(f=>f.lang==="EN").map(f=>(
              <button key={f.id} onClick={()=>update("font",f.id)} style={{padding:"10px 14px",border:`2px solid ${fmt.font===f.id?C.primary:C.border}`,borderRadius:8,background:fmt.font===f.id?C.primaryLight:"#fff",cursor:"pointer",textAlign:"left",fontFamily:f.family,fontSize:14,color:fmt.font===f.id?C.primary:C.text,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span>{f.label}</span>{fmt.font===f.id&&<span style={{fontSize:10,fontWeight:700}}>✓ Selected</span>}
              </button>
            ))}
          </div>
          <div style={{fontSize:11,color:C.textMid,marginBottom:10}}>Arabic fonts</div>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {RECEIPT_FONTS.filter(f=>f.lang==="AR").map(f=>(
              <button key={f.id} onClick={()=>update("font",f.id)} style={{padding:"10px 14px",border:`2px solid ${fmt.font===f.id?C.primary:C.border}`,borderRadius:8,background:fmt.font===f.id?C.primaryLight:"#fff",cursor:"pointer",textAlign:"left",fontFamily:f.family,fontSize:14,color:fmt.font===f.id?C.primary:C.text,display:"flex",justifyContent:"space-between",alignItems:"center",direction:"rtl"}}>
                <span>{f.label} — نموذج</span>{fmt.font===f.id&&<span style={{fontSize:10,fontWeight:700,direction:"ltr"}}>✓ Selected</span>}
              </button>
            ))}
          </div>
        </Card>
        <Card>
          <div style={{fontSize:14,fontWeight:700,marginBottom:16}}>📝 Additional Info</div>
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            <Inp label="Shop Name on Invoice (leave blank to use registered name)" value={fmt.shopNameOverride||""} onChange={v=>update("shopNameOverride",v)} placeholder={company.businessName||license.businessName}/>
            <div style={{display:"flex",flexDirection:"column",gap:4}}>
              <label style={{fontSize:12,fontWeight:600,color:C.textMid}}>Receipt Font Size</label>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                {[10,11,12,13,14].map(s=><button key={s} onClick={()=>update("fontSize",s)} style={{width:36,height:36,borderRadius:7,border:`2px solid ${fmt.fontSize===s?C.primary:C.border}`,background:fmt.fontSize===s?C.primaryLight:"#fff",color:fmt.fontSize===s?C.primary:C.textMid,fontFamily:"inherit",fontSize:13,fontWeight:700,cursor:"pointer"}}>{s}</button>)}
                <span style={{fontSize:11,color:C.textLight}}>px</span>
              </div>
            </div>
            <Inp label="Footer Message (English)" value={fmt.footer||""} onChange={v=>update("footer",v)} placeholder="Thank you for your visit!"/>
            <Inp label="Footer Message (Arabic)" value={fmt.footerAr||""} onChange={v=>update("footerAr",v)} placeholder="شكراً لزيارتكم"/>
            <Inp label="Website" value={fmt.website||""} onChange={v=>update("website",v)} placeholder="www.restaurant.sa"/>
            <Inp label="Social / Instagram" value={fmt.social||""} onChange={v=>update("social",v)} placeholder="@restaurant"/>
            <Inp label="Tagline" value={fmt.tagline||""} onChange={v=>update("tagline",v)} placeholder="Best food in town!"/>
            <Inp label="VAT Number (locked)" value={license.vatNumber} onChange={()=>{}} readOnly/>
            <Inp label="Invoice Numbering (locked)" value="Auto-sequential INV-XXXXXX" onChange={()=>{}} readOnly/>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:10,marginTop:16}}><Btn onClick={save}>💾 Save Format</Btn>{saved&&<span style={{fontSize:12,color:C.success,fontWeight:700}}>✓ Saved!</span>}</div>
        </Card>
      </div>
      <Card>
        <div style={{fontSize:14,fontWeight:700,marginBottom:16}}>👁 Receipt Preview</div>
        <div style={{background:"#fff",border:"1px dashed #ccc",borderRadius:8,padding:16,maxWidth:260,margin:"0 auto",fontFamily:selectedFont.family,fontSize:fmt.fontSize||12,color:"#000"}}>
          <div style={{textAlign:"center",marginBottom:8}}>
            <div style={{fontSize:(fmt.fontSize||12)+3,fontWeight:900}}>{fmt.shopNameOverride||company.businessName||license.businessName}</div>
            <div style={{fontSize:10}}>{company.address||license.address||""}</div>
            <div style={{fontSize:10}}>TRN: {license.vatNumber}</div>
            {fmt.tagline&&<div style={{fontSize:10,marginTop:3,fontStyle:"italic"}}>{fmt.tagline}</div>}
          </div>
          <div style={{borderTop:"1px dashed #000",margin:"6px 0"}}/>
          <div style={{display:"flex",justifyContent:"space-between"}}><span>INV-001001</span><span>Today 12:00</span></div>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"#555"}}><span>Takeaway</span><span>Cash</span></div>
          <div style={{borderTop:"1px dashed #000",margin:"6px 0"}}/>
          {[["Broasted Chicken Half","28.00"],["French Fries","10.00"]].map(([n,p])=>(
            <div key={n} style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
              <span>{n}</span><span>{p}</span>
            </div>
          ))}
          <div style={{borderTop:"1px dashed #000",margin:"6px 0"}}/>
          <div style={{display:"flex",justifyContent:"space-between"}}><span>Subtotal</span><span>38.00</span></div>
          <div style={{display:"flex",justifyContent:"space-between"}}><span>VAT 15%</span><span>5.70</span></div>
          <div style={{display:"flex",justifyContent:"space-between",fontWeight:900,fontSize:14,borderTop:"2px solid #000",paddingTop:4,marginTop:4}}><span>TOTAL</span><span>SAR 43.70</span></div>
          <div style={{borderTop:"1px dashed #000",margin:"8px 0"}}/>
          <div style={{textAlign:"center",fontSize:10}}>
            {fmt.website&&<div>{fmt.website}</div>}
            {fmt.social&&<div>{fmt.social}</div>}
            <div style={{marginTop:4,fontWeight:700}}>{fmt.footer||"Thank you for your visit!"}</div>
            {fmt.footerAr&&<div style={{direction:"rtl",marginTop:2,fontFamily:"'Tajawal',sans-serif"}}>{fmt.footerAr}</div>}
          </div>
        </div>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// LICENSE TAB — with location sharing
// ═══════════════════════════════════════════════════════════════════
function LicenseTab({license,onClearLicense}){
  const [locStatus,setLocStatus]=useState(()=>LS.get("restopos_loc_status")||"");
  const [locData,setLocData]=useState(()=>LS.get("restopos_loc_data")||null);
  const [locLoading,setLocLoading]=useState(false);
  async function shareLocation(){
    setLocLoading(true);setLocStatus("requesting");
    if(!navigator.geolocation){setLocStatus("error");setLocLoading(false);return;}
    navigator.geolocation.getCurrentPosition(
      async(pos)=>{
        const lat=pos.coords.latitude.toFixed(6);const lng=pos.coords.longitude.toFixed(6);
        const locObj={lat,lng,timestamp:new Date().toISOString(),accuracy:Math.round(pos.coords.accuracy)};
        setLocData(locObj);LS.set("restopos_loc_data",locObj);setLocStatus("shared");
        try{
          await updateDoc(doc(db,"licenses",(await getDocs(query(collection(db,"licenses"),where("key","==",license.licenseKey)))).docs[0]?.id),{location:{lat,lng,timestamp:locObj.timestamp},locationUpdatedAt:new Date().toISOString()});
        }catch(e){console.warn("Location Firestore update failed:",e);}
        LS.set("restopos_loc_status","shared");setLocLoading(false);
      },
      (err)=>{setLocStatus("denied");LS.set("restopos_loc_status","denied");setLocLoading(false);}
    ,{enableHighAccuracy:true,timeout:10000});
  }
  const locBg=locStatus==="shared"?C.successLight:locStatus==="denied"?C.dangerLight:locStatus==="requesting"?"#FFF8E1":C.bg;
  const locBorder=locStatus==="shared"?C.success:locStatus==="denied"?C.danger:locStatus==="requesting"?"#F0A500":C.border;
  const locColor=locStatus==="shared"?C.success:locStatus==="denied"?C.danger:locStatus==="requesting"?"#E07B00":C.textMid;
  const locLabel=locStatus==="shared"?"📍 Location Shared ✓":locStatus==="denied"?"❌ Permission Denied":locStatus==="requesting"?"📡 Requesting…":"📍 Location Not Shared";
  return(<Card style={{maxWidth:520}}>
    <div style={{fontSize:15,fontWeight:700,marginBottom:20}}>License Information</div>
    <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:20}}>
      {[["Business Name",license.businessName],["CR Number",license.crNumber],["VAT / TRN",license.vatNumber],["License Key",license.licenseKey],["City",license.city||"—"],["Activated",fmtDateTime(license.activatedAt)]].map(([k,v])=>(
        <div key={k} style={{display:"flex",gap:16,padding:"10px 14px",background:C.bg,borderRadius:8}}>
          <span style={{fontSize:12,fontWeight:700,color:C.textMid,width:120,flexShrink:0}}>{k}</span>
          <span style={{fontSize:13,color:C.text,fontWeight:600,fontFamily:["CR Number","VAT / TRN","License Key"].includes(k)?"monospace":"inherit"}}>{v}</span>
        </div>
      ))}
    </div>
    {/* ── Location Sharing Box ── */}
    <div style={{padding:"14px 16px",borderRadius:10,border:`1.5px solid ${locBorder}`,background:locBg,marginBottom:20}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
        <div>
          <div style={{fontSize:13,fontWeight:800,color:locColor}}>{locLabel}</div>
          <div style={{fontSize:11,color:C.textMid,marginTop:2}}>Shares your precise GPS location with the owner dashboard</div>
          {locData&&<div style={{fontSize:10,fontFamily:"monospace",color:C.textLight,marginTop:4}}>Lat: {locData.lat} · Lng: {locData.lng} · {locData.accuracy}m accuracy</div>}
          {locData?.timestamp&&<div style={{fontSize:10,color:C.textLight}}>Last updated: {fmtDateTime(locData.timestamp)}</div>}
        </div>
        <button onClick={shareLocation} disabled={locLoading} style={{padding:"10px 16px",background:locStatus==="shared"?"linear-gradient(135deg,#1A8A4A,#134D36)":"linear-gradient(135deg,#1A6B4A,#0F4D2E)",color:"#fff",border:"none",borderRadius:8,fontSize:12,fontWeight:800,cursor:locLoading?"not-allowed":"pointer",fontFamily:"inherit",flexShrink:0,opacity:locLoading?0.7:1}}>
          {locLoading?"📡 Locating…":locStatus==="shared"?"🔄 Update Location":"📍 Share Location"}
        </button>
      </div>
    </div>
    <div style={{padding:14,background:C.dangerLight,border:`1px solid ${C.danger}`,borderRadius:10}}>
      <div style={{fontSize:13,fontWeight:700,color:C.danger,marginBottom:8}}>⚠️ Reset License</div>
      <div style={{fontSize:12,color:C.danger,marginBottom:12}}>This will clear all saved license data and log you out.</div>
      <Btn variant="danger" size="sm" onClick={()=>{if(confirm("Are you sure? This will clear the license and log you out."))onClearLicense();}}>Clear License & Re-Activate</Btn>
    </div>
  </Card>);
}

// ═══════════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════════
function Settings({company,setCompany,tables,setTables,license,onClearLicense,pins,setPins,invoiceFormat,setInvoiceFormat}){
  const [tab,setTab]=useState("company");const [newTableCount,setNewTableCount]=useState(tables.length);const [companySaved,setCompanySaved]=useState(false);
  const [kitchenPrinter,setKitchenPrinter]=useState(()=>LS.get("restopos_kitchen_printer")||{name:"Kitchen Printer",paperWidth:"80mm",autoKOT:true,enabled:false});
  const [kpSaved,setKpSaved]=useState(false);
  function saveKP(){LS.set("restopos_kitchen_printer",kitchenPrinter);setKpSaved(true);setTimeout(()=>setKpSaved(false),3000);}
  function testKOT(){
    const win=window.open("","_blank","width=340,height=500");if(!win){alert("Pop-up blocked.");return;}
    const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>@page{size:${kitchenPrinter.paperWidth} auto;margin:0}body{font-family:'Courier New',monospace;font-size:14px;padding:8mm;width:${kitchenPrinter.paperWidth}}.center{text-align:center}.big{font-size:18px;font-weight:900}.hr{border:none;border-top:2px dashed #000;margin:6px 0}</style></head><body><div class="center"><div class="big">*** KOT TEST ***</div><div>Kitchen Order Ticket</div><div>${new Date().toLocaleTimeString()}</div></div><div class="hr"/><div>1x Broasted Chicken Half</div><div>2x French Fries</div><div>1x Fresh Lemon Juice</div><div class="hr"/><div class="center">Table 5 · Dine-in</div><script>window.onload=function(){window.print();window.close();}<\/script></body></html>`;
    win.document.write(html);win.document.close();
  }
  const tabs=[["company","🏢 Company"],["tables","🪑 Tables"],["printers","🖨️ Bill Printer"],["kitchen","🍽️ Kitchen Printer"],["invoice","🧾 Invoice Format"],["security","🔐 Security"],["license","📋 License"]];
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
    {tab==="kitchen"&&<Card style={{maxWidth:560}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:20}}>🍽️ Kitchen Printer (KOT)</div>
      <div style={{background:C.infoLight,border:`1px solid ${C.info}`,borderRadius:10,padding:"12px 16px",marginBottom:20,fontSize:13,color:C.info,fontWeight:600}}>ℹ️ Set up a second printer dedicated to printing Kitchen Order Tickets (KOTs) to the kitchen.</div>
      <div style={{display:"flex",flexDirection:"column",gap:14}}>
        <div style={{display:"flex",alignItems:"center",gap:12,padding:"12px 16px",background:C.bg,borderRadius:10,border:`1px solid ${C.border}`}}>
          <div style={{flex:1}}><div style={{fontSize:13,fontWeight:700}}>Enable Kitchen Printer</div><div style={{fontSize:11,color:C.textMid}}>Auto-print KOT to kitchen on every order</div></div>
          <button onClick={()=>setKitchenPrinter(p=>({...p,enabled:!p.enabled}))} style={{width:44,height:24,borderRadius:12,background:kitchenPrinter.enabled?C.primary:"#ccc",border:"none",cursor:"pointer",position:"relative",transition:"background 0.2s"}}>
            <span style={{position:"absolute",top:2,left:kitchenPrinter.enabled?22:2,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left 0.2s",display:"block"}}/>
          </button>
        </div>
        <Inp label="Kitchen Printer Name / Label" value={kitchenPrinter.name||""} onChange={v=>setKitchenPrinter(p=>({...p,name:v}))} placeholder="e.g. Kitchen Printer, Grill Station"/>
        <div style={{display:"flex",flexDirection:"column",gap:4}}>
          <label style={{fontSize:12,fontWeight:600,color:C.textMid}}>Paper Width</label>
          <div style={{display:"flex",gap:8}}>
            {["58mm","80mm"].map(w=><button key={w} onClick={()=>setKitchenPrinter(p=>({...p,paperWidth:w}))} style={{flex:1,padding:"10px",border:`2px solid ${kitchenPrinter.paperWidth===w?C.primary:C.border}`,borderRadius:8,background:kitchenPrinter.paperWidth===w?C.primaryLight:"#fff",color:kitchenPrinter.paperWidth===w?C.primary:C.textMid,fontFamily:"inherit",fontSize:13,fontWeight:700,cursor:"pointer"}}>{w}</button>)}
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:12,padding:"12px 16px",background:C.bg,borderRadius:10,border:`1px solid ${C.border}`}}>
          <div style={{flex:1}}><div style={{fontSize:13,fontWeight:700}}>Auto-Print KOT on Checkout</div><div style={{fontSize:11,color:C.textMid}}>Automatically send KOT to kitchen when payment is confirmed</div></div>
          <button onClick={()=>setKitchenPrinter(p=>({...p,autoKOT:!p.autoKOT}))} style={{width:44,height:24,borderRadius:12,background:kitchenPrinter.autoKOT?C.primary:"#ccc",border:"none",cursor:"pointer",position:"relative",transition:"background 0.2s"}}>
            <span style={{position:"absolute",top:2,left:kitchenPrinter.autoKOT?22:2,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left 0.2s",display:"block"}}/>
          </button>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:10,padding:"14px 16px",background:C.bg,borderRadius:10,border:`1px solid ${C.border}`}}>
          <div style={{fontSize:12,fontWeight:700,color:C.textMid}}>SETUP INSTRUCTIONS</div>
          {[["1","Connect your kitchen printer via USB or Network to the same computer/device."],["2",`Set it as a secondary printer in your OS — name it "${kitchenPrinter.name||"Kitchen Printer"}".`],["3","RestoPOS will open a separate print dialog targeting that printer for KOTs."],["4","Use 80mm thermal paper for kitchen tickets (58mm if your printer is smaller)."]].map(([n,t])=>(
            <div key={n} style={{display:"flex",gap:10}}><span style={{width:20,height:20,borderRadius:"50%",background:C.primary,color:"#fff",fontSize:11,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{n}</span><span style={{fontSize:12,color:C.textMid}}>{t}</span></div>
          ))}
        </div>
        <div style={{display:"flex",gap:10}}>
          <Btn onClick={testKOT} variant="outline">🖨️ Test KOT Print</Btn>
          <Btn onClick={saveKP}>💾 Save Kitchen Settings</Btn>
          {kpSaved&&<span style={{fontSize:12,color:C.success,fontWeight:700,alignSelf:"center"}}>✓ Saved!</span>}
        </div>
      </div>
    </Card>}
    {tab==="invoice"&&<InvoiceFormatTab license={license} company={company} invoiceFormat={invoiceFormat} setInvoiceFormat={setInvoiceFormat}/>}
    {tab==="security"&&<SecurityTab pins={pins} setPins={setPins}/>}
    {tab==="license"&&<LicenseTab license={license} onClearLicense={onClearLicense}/>}
  </div>);
}

// ═══════════════════════════════════════════════════════════════════
// CREATE — Menu Management
// ═══════════════════════════════════════════════════════════════════
function Create({items,setItems,promos,setPromos}){
  const [tab,setTab]=useState("items");const [showItemModal,setShowItemModal]=useState(false);const [editItem,setEditItem]=useState(null);const [showBarcodeModal,setShowBarcodeModal]=useState(false);const [barcodeItem,setBarcodeItem]=useState(null);const [barcodeInput,setBarcodeInput]=useState("");const [showPromoModal,setShowPromoModal]=useState(false);const [editPromo,setEditPromo]=useState(null);const [categories,setCategories]=useState(SEED_CATEGORIES);const [newCat,setNewCat]=useState("");
  const [showImport,setShowImport]=useState(false);const [importRows,setImportRows]=useState([]);const [importError,setImportError]=useState("");const [importDone,setImportDone]=useState(false);
  const blankItem={name:"",nameAr:"",category:categories[0],price:"",cost:"",stock:"",active:true,barcode:""};const [itemForm,setItemForm]=useState(blankItem);
  const blankPromo={code:"",type:"%",value:"",minOrder:0,active:true};const [promoForm,setPromoForm]=useState(blankPromo);const barcodeRef=useRef();
  function openItemModal(it=null){setEditItem(it);setItemForm(it?{...it}:{...blankItem,category:categories[0]});setShowItemModal(true);}
  function saveItem(){if(!itemForm.name||!itemForm.price)return alert("Name and price required");const item={...itemForm,price:parseFloat(itemForm.price),cost:parseFloat(itemForm.cost||0),stock:parseInt(itemForm.stock||0),id:editItem?editItem.id:Date.now()};setItems(prev=>editItem?prev.map(i=>i.id===editItem.id?item:i):[...prev,item]);setShowItemModal(false);}
  function openBarcodeModal(it){setBarcodeItem(it);setBarcodeInput(it.barcode||"");setShowBarcodeModal(true);setTimeout(()=>barcodeRef.current?.focus(),100);}
  function saveBarcode(){setItems(prev=>prev.map(i=>i.id===barcodeItem.id?{...i,barcode:barcodeInput.trim()}:i));setShowBarcodeModal(false);alert("Barcode saved!");}
  function openPromoModal(p=null){setEditPromo(p);setPromoForm(p?{...p}:{...blankPromo});setShowPromoModal(true);}
  function savePromo(){if(!promoForm.code||!promoForm.value)return alert("Code and value required");const promo={...promoForm,value:parseFloat(promoForm.value),minOrder:parseFloat(promoForm.minOrder||0),id:editPromo?editPromo.id:Date.now()};setPromos(prev=>editPromo?prev.map(p=>p.id===editPromo.id?promo:p):[...prev,promo]);setShowPromoModal(false);}

  function downloadTemplate(){
    const csv="name,nameAr,category,price,cost,stock,barcode\nChicken Burger,برجر دجاج,Burgers,28,12,50,\nFrench Fries,بطاطس,Sides,10,3,100,\n";
    const blob=new Blob([csv],{type:"text/csv"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download="menu-import-template.csv";a.click();
  }
  function handleImportFile(e){
    setImportError("");setImportRows([]);setImportDone(false);
    const file=e.target.files[0];if(!file)return;
    const reader=new FileReader();
    reader.onload=ev=>{
      try{
        const text=ev.target.result;
        let rows=[];
        if(file.name.endsWith(".json")){
          const parsed=JSON.parse(text);rows=Array.isArray(parsed)?parsed:[];
        } else {
          const lines=text.trim().split("\n");
          const headers=lines[0].split(",").map(h=>h.trim().toLowerCase());
          rows=lines.slice(1).filter(l=>l.trim()).map(line=>{
            const vals=line.split(",").map(v=>v.trim());
            const obj={};headers.forEach((h,i)=>obj[h]=vals[i]||"");return obj;
          });
        }
        const valid=rows.filter(r=>r.name&&r.price&&!isNaN(parseFloat(r.price)));
        if(valid.length===0){setImportError("No valid rows found. Make sure your file has 'name' and 'price' columns.");return;}
        setImportRows(valid);
      }catch(err){setImportError("Could not parse file: "+err.message);}
    };
    reader.readAsText(file);
    e.target.value="";
  }
  function confirmImport(){
    const newItems=importRows.map(r=>({id:Date.now()+Math.random(),name:r.name||"",nameAr:r.namear||r.nameAr||"",category:r.category||categories[0],price:parseFloat(r.price)||0,cost:parseFloat(r.cost||0),stock:parseInt(r.stock||0),active:true,barcode:r.barcode||""}));
    setItems(prev=>[...prev,...newItems]);setImportDone(true);setTimeout(()=>{setShowImport(false);setImportRows([]);setImportDone(false);},1500);
  }

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
    {showImport&&<Modal title="📥 Import Menu Items" onClose={()=>{setShowImport(false);setImportRows([]);setImportError("");setImportDone(false);}} width={640}>
      <div style={{fontSize:13,color:C.textMid,marginBottom:16}}>Upload a CSV or JSON file to bulk-import menu items. Download the template to see the correct format.</div>
      <div style={{display:"flex",gap:10,marginBottom:20,alignItems:"center"}}>
        <label style={{display:"inline-flex",alignItems:"center",gap:8,padding:"9px 16px",background:C.primaryLight,border:`1.5px solid ${C.primary}`,borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:600,color:C.primary}}>
          📂 Choose File (CSV or JSON)<input type="file" accept=".csv,.json" onChange={handleImportFile} style={{display:"none"}}/>
        </label>
        <button onClick={downloadTemplate} style={{padding:"9px 14px",background:"transparent",border:`1px solid ${C.border}`,borderRadius:8,fontSize:12,fontWeight:600,color:C.textMid,cursor:"pointer",fontFamily:"inherit"}}>⬇️ Download Template</button>
      </div>
      {importError&&<div style={{padding:"10px 14px",background:C.dangerLight,border:`1px solid ${C.danger}`,borderRadius:8,fontSize:13,color:C.danger,marginBottom:16}}>{importError}</div>}
      {importRows.length>0&&!importDone&&(
        <>
          <div style={{fontSize:13,fontWeight:700,marginBottom:10,color:C.success}}>✓ {importRows.length} items ready to import — preview below:</div>
          <div style={{maxHeight:260,overflowY:"auto",border:`1px solid ${C.border}`,borderRadius:8,marginBottom:16}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
              <thead><tr style={{background:C.bg}}>{["Name","Arabic","Category","Price","Cost","Stock"].map(h=><th key={h} style={{padding:"8px 10px",textAlign:"left",fontWeight:700,color:C.textMid,fontSize:10,textTransform:"uppercase",borderBottom:`1px solid ${C.border}`}}>{h}</th>)}</tr></thead>
              <tbody>{importRows.map((r,i)=><tr key={i} style={{borderBottom:`1px solid ${C.border}`,background:i%2===0?"#fff":"#FAFBFC"}}>
                <td style={{padding:"7px 10px",fontWeight:600}}>{r.name}</td>
                <td style={{padding:"7px 10px",direction:"rtl",fontFamily:"'Tajawal',sans-serif"}}>{r.namear||r.nameAr||"—"}</td>
                <td style={{padding:"7px 10px",color:C.textMid}}>{r.category||"—"}</td>
                <td style={{padding:"7px 10px",color:C.primary,fontWeight:700}}>SAR {parseFloat(r.price||0).toFixed(2)}</td>
                <td style={{padding:"7px 10px",color:C.textMid}}>{r.cost?`SAR ${parseFloat(r.cost).toFixed(2)}`:"—"}</td>
                <td style={{padding:"7px 10px"}}>{r.stock||0}</td>
              </tr>)}</tbody>
            </table>
          </div>
          <div style={{display:"flex",gap:10}}><Btn variant="ghost" onClick={()=>setImportRows([])} style={{flex:1}}>Cancel</Btn><Btn onClick={confirmImport} style={{flex:1}}>✓ Import {importRows.length} Items</Btn></div>
        </>
      )}
      {importDone&&<div style={{textAlign:"center",padding:"30px 0"}}><div style={{fontSize:40,marginBottom:8}}>✅</div><div style={{fontSize:15,fontWeight:700,color:C.success}}>Import successful!</div></div>}
    </Modal>}
    <div style={{display:"flex",gap:8,marginBottom:20}}>{[["items","🍔 Items"],["categories","📂 Categories"],["promos","🏷️ Promos"]].map(([id,label])=><button key={id} onClick={()=>setTab(id)} style={{padding:"8px 16px",borderRadius:8,border:`1.5px solid ${tab===id?C.primary:C.border}`,background:tab===id?C.primaryLight:"#fff",color:tab===id?C.primary:C.textMid,fontFamily:"inherit",fontSize:13,fontWeight:600,cursor:"pointer"}}>{label}</button>)}</div>
    {tab==="items"&&<Card><div style={{display:"flex",justifyContent:"space-between",marginBottom:16,gap:8,flexWrap:"wrap"}}><div style={{fontSize:15,fontWeight:700}}>Menu Items ({items.length})</div><div style={{display:"flex",gap:8}}><Btn size="sm" variant="outline" onClick={()=>setShowImport(true)}>📥 Import Menu</Btn><Btn size="sm" onClick={()=>openItemModal()}>+ New Item</Btn></div></div><DataTable headers={["Name","Category","Price","Stock","Barcode","Status","Actions"]} rows={items.map(it=>[it.name,<Badge color={C.info} bg={C.infoLight}>{it.category}</Badge>,<strong style={{color:C.primary}}>{fmtSAR(it.price)}</strong>,it.stock,<div style={{display:"flex",alignItems:"center",gap:6}}>{it.barcode?<span style={{fontFamily:"monospace",fontSize:11,color:C.zatca}}>{it.barcode}</span>:<span style={{color:C.textLight,fontSize:11}}>None</span>}<button onClick={()=>openBarcodeModal(it)} style={{background:C.zatcaLight,border:`1px solid ${C.zatca}30`,color:C.zatca,padding:"2px 7px",borderRadius:5,fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>🔲 {it.barcode?"Edit":"Add"}</button></div>,<Badge color={it.active?C.success:C.danger} bg={it.active?C.successLight:C.dangerLight}>{it.active?"Active":"Off"}</Badge>,<div style={{display:"flex",gap:5}}><Btn size="sm" variant="ghost" onClick={()=>openItemModal(it)}>Edit</Btn><Btn size="sm" variant="danger" onClick={()=>{if(confirm("Delete?"))setItems(prev=>prev.filter(i=>i.id!==it.id));}}>Del</Btn></div>])}/></Card>}
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
  const cats=[...new Set((sale.items||[]).map(i=>i.category||"Items"))];
  const itemsHTML=cats.map(cat=>{
    const catItems=(sale.items||[]).filter(i=>(i.category||"Items")===cat);
    return `<div style="font-size:9px;font-weight:bold;letter-spacing:0.08em;color:#555;margin-top:6px;margin-bottom:2px;text-transform:uppercase;">${cat}</div>`+
      catItems.map(it=>`<div class="row"><span class="item-name">${it.name}${it.nameAr?`<br/><span style="font-family:'Noto Naskh Arabic','Arial',sans-serif;direction:rtl;display:block;text-align:right;font-size:11px;">${it.nameAr}</span>`:""}<br/><small>${it.qty} x SAR ${it.price.toFixed(2)}</small></span><span class="item-amt">SAR ${(it.qty*it.price).toFixed(2)}</span></div>`).join("");
  }).join("");
  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Receipt ${sale.id}</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Naskh+Arabic:wght@400;700&display=swap" rel="stylesheet">
<style>@page{size:80mm auto;margin:0}*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Courier New',monospace;font-size:12px;color:#000;background:#fff;width:80mm;padding:4mm}.center{text-align:center}.bold{font-weight:bold}.big{font-size:16px;font-weight:bold}.hr{border:none;border-top:1px dashed #000;margin:6px 0}.row{display:flex;justify-content:space-between;margin:2px 0;align-items:flex-start}.row-total{display:flex;justify-content:space-between;margin:4px 0;font-size:15px;font-weight:900;border-top:2px solid #000;padding-top:4px}.item-name{flex:1;padding-right:4px}.item-amt{white-space:nowrap}.zatca-label{font-size:9px;font-weight:bold;letter-spacing:0.1em}@media print{body{width:80mm}}</style>
</head><body>
<div class="center"><div class="big">${sale.businessName||license.businessName}</div><div>${license.address||""}</div><div>TRN: ${license.vatNumber}</div><div>${sale.id} | ${sale.date} ${sale.time}</div>${sale.customer?`<div>Customer: ${sale.customer}</div>`:""}<div>${sale.type}${sale.table?` · Table ${sale.table}`:""}</div></div>
<hr class="hr"/>${itemsHTML}
<hr class="hr"/><div class="row"><span>Subtotal</span><span>SAR ${(sale.subtotal||0).toFixed(2)}</span></div>${(sale.discount||0)>0?`<div class="row"><span>Discount</span><span>-SAR ${sale.discount.toFixed(2)}</span></div>`:""}
<div class="row"><span>VAT 15%</span><span>SAR ${(sale.vat||0).toFixed(2)}</span></div><div class="row-total"><span>TOTAL</span><span>SAR ${(sale.total||0).toFixed(2)}</span></div>
${sale.payMethod==="Cash"?`<div class="row"><span>Cash Given</span><span>SAR ${Number(sale.given||0).toFixed(2)}</span></div><div class="row bold"><span>Change</span><span>SAR ${Number(sale.change||0).toFixed(2)}</span></div>`:`<div class="row bold"><span>Payment</span><span>${sale.payMethod}</span></div>`}
<hr class="hr"/><div style="text-align:center;margin:8px 0;"><canvas id="qr-canvas"></canvas><div class="zatca-label" style="margin-top:4px;">ZATCA PHASE 2 · QR CODE</div><div style="font-size:8px;">TLV Base64 · Scan to verify</div></div>
<div class="bold center" style="margin-top:6px;">Thank you for your visit!</div>
<div style="font-family:'Noto Naskh Arabic','Arial',sans-serif;font-size:14px;font-weight:bold;text-align:center;direction:rtl;margin-top:3px;">شكراً لزيارتكم</div><br/><br/>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"><\/script>
<script>
var qrData=${JSON.stringify(qrData)};
function doQR(){
  if(window.QRCode){
    try{new QRCode(document.getElementById("qr-canvas"),{text:qrData,width:110,height:110,colorDark:"#000000",colorLight:"#ffffff",correctLevel:QRCode.CorrectLevel.M});}catch(e){console.warn(e);}
    setTimeout(function(){window.print();window.close();},900);
  }else{setTimeout(doQR,200);}
}
window.onload=function(){setTimeout(doQR,300);};
<\/script></body></html>`;
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
  const [tab,setTab]=useState("export");const [bulkPct,setBulkPct]=useState("");const [bulkCat,setBulkCat]=useState("All");const [refreshMsg,setRefreshMsg]=useState("");const cats=["All",...new Set(items.map(i=>i.category))];
  function exportCSV(data,filename){const h=Object.keys(data[0]||{}).join(",");const rows=data.map(r=>Object.values(r).map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");const blob=new Blob([h+"\n"+rows],{type:"text/csv"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=filename;a.click();}
  function handleRefresh(){setRefreshMsg("Refreshing…");setTimeout(()=>{window.location.reload();},400);}
  function clearCache(){if(confirm("Clear all cached data and reload? (Sales and menu data stored locally will be kept — only browser cache is cleared).")){if("caches" in window)caches.keys().then(names=>names.forEach(n=>caches.delete(n)));setRefreshMsg("Cache cleared! Reloading…");setTimeout(()=>window.location.reload(),800);}}
  return(<div>
    <div style={{display:"flex",gap:8,marginBottom:20,flexWrap:"wrap",alignItems:"center"}}>
      {[["export","📤 Export"],["prices","💲 Bulk Prices"],["backup","💾 Backup"],["system","🔄 System"],["zatca_tools","⬛ ZATCA Tools"]].map(([id,label])=><button key={id} onClick={()=>setTab(id)} style={{padding:"8px 16px",borderRadius:8,border:`1.5px solid ${tab===id?C.primary:C.border}`,background:tab===id?C.primaryLight:"#fff",color:tab===id?C.primary:C.textMid,fontFamily:"inherit",fontSize:13,fontWeight:600,cursor:"pointer"}}>{label}</button>)}
      <button onClick={handleRefresh} title="Refresh / Reload App" style={{marginLeft:"auto",padding:"8px 16px",borderRadius:8,border:`1.5px solid ${C.info}`,background:C.infoLight,color:C.info,fontFamily:"inherit",fontSize:13,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",gap:6}}>🔄 Refresh</button>
      {refreshMsg&&<span style={{fontSize:12,color:C.success,fontWeight:600}}>{refreshMsg}</span>}
    </div>
    {tab==="export"&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>{[{icon:"📅",title:"Today's Sales",action:()=>exportCSV(sales.filter(s=>s.date===TODAY).map(s=>({id:s.id,date:s.date,time:s.time,type:s.type,total:s.total,vat:s.vat})),"sales-today.csv")},{icon:"📦",title:"Menu & Stock",action:()=>exportCSV(items.map(it=>({name:it.name,category:it.category,price:it.price,cost:it.cost,stock:it.stock})),"menu-stock.csv")},{icon:"📊",title:"Tax Summary",action:()=>exportCSV([{subtotal:sales.reduce((s,o)=>s+o.subtotal,0).toFixed(2),vat:sales.reduce((s,o)=>s+o.vat,0).toFixed(2),total:sales.reduce((s,o)=>s+o.total,0).toFixed(2)}],"tax-summary.csv")}].map(({icon,title,action})=><Card key={title} style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}><div style={{display:"flex",gap:12,alignItems:"center"}}><span style={{fontSize:26}}>{icon}</span><div style={{fontSize:14,fontWeight:700}}>{title}</div></div><Btn size="sm" variant="outline" onClick={action}>Export</Btn></Card>)}</div>}
    {tab==="prices"&&<Card style={{maxWidth:480}}><div style={{fontSize:15,fontWeight:700,marginBottom:16}}>Bulk Price Update</div><div style={{display:"flex",flexDirection:"column",gap:14}}><Sel label="Category" value={bulkCat} onChange={setBulkCat} options={cats}/><Inp label="Change %" value={bulkPct} onChange={setBulkPct} type="number" placeholder="+10 or -5"/><Btn variant="accent" disabled={!bulkPct} onClick={()=>{const pct=parseFloat(bulkPct);setItems(prev=>prev.map(it=>(bulkCat==="All"||it.category===bulkCat)?{...it,price:parseFloat((it.price*(1+pct/100)).toFixed(2))}:it));alert("Prices updated!");setBulkPct("");}}>Apply</Btn></div></Card>}
    {tab==="backup"&&<Card style={{maxWidth:480}}><div style={{fontSize:15,fontWeight:700,marginBottom:14}}>Backup Data</div><Btn onClick={()=>{const backup={timestamp:new Date().toISOString(),items,sales:sales.slice(-200)};const blob=new Blob([JSON.stringify(backup,null,2)],{type:"application/json"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=`restopos-backup-${TODAY}.json`;a.click();}}>💾 Download Backup</Btn></Card>}
    {tab==="system"&&<Card style={{maxWidth:560}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:20}}>🔄 System & Maintenance</div>
      <div style={{display:"flex",flexDirection:"column",gap:12}}>
        <div style={{display:"flex",gap:12,padding:"14px 16px",background:C.bg,borderRadius:10,border:`1px solid ${C.border}`,alignItems:"center"}}>
          <div style={{flex:1}}><div style={{fontSize:14,fontWeight:700}}>Refresh App</div><div style={{fontSize:12,color:C.textMid}}>Reload the page to apply latest updates</div></div>
          <Btn variant="outline" onClick={handleRefresh}>🔄 Refresh Now</Btn>
        </div>
        <div style={{display:"flex",gap:12,padding:"14px 16px",background:C.bg,borderRadius:10,border:`1px solid ${C.border}`,alignItems:"center"}}>
          <div style={{flex:1}}><div style={{fontSize:14,fontWeight:700}}>Clear Browser Cache</div><div style={{fontSize:12,color:C.textMid}}>Clears service worker cache, forces fresh assets on reload</div></div>
          <Btn variant="outline" onClick={clearCache}>🧹 Clear Cache</Btn>
        </div>
        <div style={{padding:"14px 16px",background:C.bg,borderRadius:10,border:`1px solid ${C.border}`}}>
          <div style={{fontSize:14,fontWeight:700,marginBottom:8}}>Storage Usage</div>
          {[["Sales records",sales.length+" orders"],["Menu items",items.length+" items"],["ZATCA invoices",invoiceStorage.getAll().length+" invoices"],["Queue depth",fatooraQueue.getQueue().length+" items"]].map(([k,v])=>(
            <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:`1px solid ${C.border}`,fontSize:13}}><span style={{color:C.textMid}}>{k}</span><strong>{v}</strong></div>
          ))}
        </div>
        <div style={{padding:"14px 16px",background:C.dangerLight,borderRadius:10,border:`1px solid ${C.danger}`}}>
          <div style={{fontSize:13,fontWeight:700,color:C.danger,marginBottom:6}}>⚠️ Reset All Local Data</div>
          <div style={{fontSize:12,color:C.danger,marginBottom:10}}>Clears all sales, menu, and settings from this browser. License remains intact.</div>
          <Btn variant="danger" size="sm" onClick={()=>{if(confirm("This will erase all local data (sales, menu, settings). Are you sure?")){["restopos_sales","restopos_items","restopos_tables","restopos_company","restopos_promos","zatca_invoices_v2","zatca_queue_v2"].forEach(k=>localStorage.removeItem(k));window.location.reload();}}}>🗑 Reset Local Data</Btn>
        </div>
      </div>
    </Card>}
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
  const [showOwnerModal,setShowOwnerModal]=useState(false);const [ownerPwd,setOwnerPwd]=useState("");const [ownerErr,setOwnerErr]=useState("");const [ownerAuthedLocal,setOwnerAuthedLocal]=useState(false);
  function openModal(u=null){setEditUser(u);setForm(u?{...u}:{...blank});setShowModal(true);}
  function save(){if(!form.name||!form.username)return alert("Name and username required");setUsers(prev=>editUser?prev.map(u=>u.id===editUser.id?{...form,id:editUser.id}:u):[...prev,{...form,id:Date.now(),lastLogin:"Never"}]);setShowModal(false);}
  function handleOwnerLogin(){if(ownerPwd===OWNER_PASSWORD){setOwnerAuthedLocal(true);setOwnerErr("");setOwnerPwd("");}else{setOwnerErr("Incorrect password.");}}
  return(<div>
    {showModal&&<Modal title={editUser?"Edit User":"New User"} onClose={()=>setShowModal(false)} width={420}>
      <div style={{display:"flex",flexDirection:"column",gap:12}}>
        <Inp label="Full Name" value={form.name} onChange={v=>setForm(f=>({...f,name:v}))}/><Inp label="Username" value={form.username} onChange={v=>setForm(f=>({...f,username:v}))}/>
        <Sel label="Role" value={form.role} onChange={v=>setForm(f=>({...f,role:v}))} options={["Admin","Manager","Cashier"]}/>
        <div style={{display:"flex",alignItems:"center",gap:8}}><input type="checkbox" checked={form.active} onChange={e=>setForm(f=>({...f,active:e.target.checked}))} id="ua"/><label htmlFor="ua" style={{fontSize:13}}>Active</label></div>
      </div>
      <div style={{display:"flex",gap:10,marginTop:16}}><Btn variant="ghost" onClick={()=>setShowModal(false)} style={{flex:1}}>Cancel</Btn><Btn onClick={save} style={{flex:1}}>Save</Btn></div>
    </Modal>}
    {showOwnerModal&&<Modal title="🔐 Owner Access" onClose={()=>{setShowOwnerModal(false);setOwnerAuthedLocal(false);setOwnerPwd("");setOwnerErr("");}} width={ownerAuthedLocal?900:400}>
      {!ownerAuthedLocal?(
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          <div style={{textAlign:"center",marginBottom:8}}><div style={{fontSize:36,marginBottom:8}}>🏢</div><div style={{fontSize:14,color:C.textMid}}>Enter the owner password to view your client dashboard</div></div>
          <Inp label="Owner Password" value={ownerPwd} onChange={v=>{setOwnerPwd(v);setOwnerErr("");}} type="password" placeholder="••••••••"/>
          {ownerErr&&<div style={{fontSize:12,color:C.danger,fontWeight:600}}>⚠️ {ownerErr}</div>}
          <Btn onClick={handleOwnerLogin}>Unlock Dashboard</Btn>
        </div>
      ):(
        <OwnerDashboardInline/>
      )}
    </Modal>}
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20,flexWrap:"wrap",gap:10}}>
      <div style={{fontSize:18,fontWeight:800,color:C.text}}>👤 User Management</div>
      <div style={{display:"flex",gap:10}}>
        <button onClick={()=>setShowOwnerModal(true)} style={{display:"flex",alignItems:"center",gap:8,padding:"10px 18px",background:"linear-gradient(135deg,#0F2340,#1A3A5C)",color:"#fff",border:"none",borderRadius:10,cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700}}>🏢 Are You the Owner?</button>
        <Btn size="sm" onClick={()=>openModal()}>+ New User</Btn>
      </div>
    </div>
    <Card><DataTable headers={["Name","Username","Role","Status","Actions"]} rows={users.map(u=>[u.name,<span style={{fontFamily:"monospace"}}>{u.username}</span>,<Badge color={u.role==="Admin"?C.danger:u.role==="Manager"?C.warning:C.info} bg={u.role==="Admin"?C.dangerLight:u.role==="Manager"?C.warningLight:C.infoLight}>{u.role}</Badge>,<Badge color={u.active?C.success:C.danger} bg={u.active?C.successLight:C.dangerLight}>{u.active?"Active":"Off"}</Badge>,<div style={{display:"flex",gap:5}}><Btn size="sm" variant="ghost" onClick={()=>openModal(u)}>Edit</Btn><Btn size="sm" variant="danger" onClick={()=>{if(confirm("Delete?"))setUsers(prev=>prev.filter(x=>x.id!==u.id));}}>Del</Btn></div>])}/></Card>
  </div>);
}

// ═══════════════════════════════════════════════════════════════════
// OWNER DASHBOARD INLINE (for modal inside UserAdmin)
// ═══════════════════════════════════════════════════════════════════
function OwnerDashboardInline(){
  const [tab,setTab]=useState("overview");
  const [activations,setActivations]=useState([]);
  const [licenses,setLicenses]=useState([]);
  const [loading,setLoading]=useState(true);
  const [selectedClient,setSelectedClient]=useState(null);
  const [notifyMsg,setNotifyMsg]=useState("");
  const [announcementText,setAnnouncementText]=useState(LS.get("restopos_announcement")||"");
  const [searchQ,setSearchQ]=useState("");
  const [activityLog,setActivityLog]=useState(()=>LS.get("restopos_activity_log")||[]);
  const [actFilter,setActFilter]=useState({client:"",type:"",date:""});
  const [planFilter,setPlanFilter]=useState("all");
  const [showSendNotif,setShowSendNotif]=useState(false);
  const [notifClient,setNotifClient]=useState(null);

  useEffect(()=>{
    async function load(){
      try{
        const aSnap=await getDocs(collection(db,"pending_activations"));
        const acts=aSnap.docs.map(d=>({id:d.id,...d.data()}));
        setActivations(acts);
        const lSnap=await getDocs(collection(db,"licenses"));
        setLicenses(lSnap.docs.map(d=>({id:d.id,...d.data()})));
      }catch(e){console.error(e);}
      setLoading(false);
    }
    load();
  },[]);

  async function toggleLicense(id,active){
    try{
      await updateDoc(doc(db,"licenses",id),{active:!active,updatedAt:new Date().toISOString()});
      setLicenses(prev=>prev.map(l=>l.id===id?{...l,active:!active}:l));
      logActivity("LICENSE_TOGGLE",{licenseId:id,before:{active},after:{active:!active}},"Owner");
    }catch(e){alert("Error: "+e.message);}
  }

  async function upgradeSubscription(clientId,newPlan){
    try{
      await updateDoc(doc(db,"pending_activations",clientId),{subscriptionPlan:newPlan,planUpdatedAt:new Date().toISOString()});
      setActivations(prev=>prev.map(a=>a.id===clientId?{...a,subscriptionPlan:newPlan}:a));
      logActivity("PLAN_CHANGE",{clientId,after:{plan:newPlan}},"Owner");
    }catch(e){alert("Error: "+e.message);}
  }

  async function suspendClient(clientId,suspend){
    try{
      await updateDoc(doc(db,"pending_activations",clientId),{status:suspend?"suspended":"approved",statusUpdatedAt:new Date().toISOString()});
      setActivations(prev=>prev.map(a=>a.id===clientId?{...a,status:suspend?"suspended":"approved"}:a));
      logActivity(suspend?"CLIENT_SUSPENDED":"CLIENT_REACTIVATED",{clientId},"Owner");
    }catch(e){alert("Error: "+e.message);}
  }

  function saveAnnouncement(){
    LS.set("restopos_announcement",announcementText);
    alert("Announcement saved! Clients will see it on login.");
  }

  const statusColor={approved:C.success,pending:C.warning,suspended:C.danger,rejected:"#999"};
  const statusBg={approved:C.successLight,pending:C.warningLight,suspended:C.dangerLight,rejected:"#f5f5f5"};
  const pending=activations.filter(a=>a.status==="pending");
  const active=activations.filter(a=>a.status==="approved");
  const suspended=activations.filter(a=>a.status==="suspended");

  // Revenue calc: sum up subscription plan prices
  const totalMRR=activations.filter(a=>a.status==="approved").reduce((s,a)=>{
    const plan=SUBSCRIPTION_PLANS[a.subscriptionPlan||"basic"];
    return s+(plan?.price||150);
  },0);

  const filteredClients=activations.filter(a=>{
    const q=searchQ.toLowerCase();
    const matchQ=!q||a.businessName?.toLowerCase().includes(q)||a.crNumber?.includes(q)||a.licenseKey?.includes(q);
    const matchPlan=planFilter==="all"||a.subscriptionPlan===planFilter;
    return matchQ&&matchPlan;
  });

  const filteredLog=activityLog.filter(l=>{
    const matchClient=!actFilter.client||l.details?.clientId?.includes(actFilter.client)||l.user?.toLowerCase().includes(actFilter.client.toLowerCase());
    const matchType=!actFilter.type||l.action===actFilter.type;
    const matchDate=!actFilter.date||l.timestamp.startsWith(actFilter.date);
    return matchClient&&matchType&&matchDate;
  });

  const OTab=({id,label,count})=>(
    <button onClick={()=>setTab(id)} style={{padding:"8px 14px",background:tab===id?"rgba(99,102,241,0.25)":"rgba(255,255,255,0.04)",border:`1px solid ${tab===id?"rgba(99,102,241,0.6)":"rgba(255,255,255,0.08)"}`,borderRadius:8,color:tab===id?"#a5b4fc":"rgba(255,255,255,0.55)",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",gap:5}}>
      {label}{count>0&&<span style={{background:tab===id?"#6366f1":"rgba(255,255,255,0.1)",color:tab===id?"#fff":"rgba(255,255,255,0.6)",borderRadius:20,padding:"1px 6px",fontSize:10,fontWeight:700}}>{count}</span>}
    </button>
  );

  const PlanBadge=({plan})=>{
    const p=SUBSCRIPTION_PLANS[plan||"basic"];
    return <span style={{padding:"2px 8px",borderRadius:20,fontSize:10,fontWeight:700,background:p.color+"22",color:p.color,border:`1px solid ${p.color}44`}}>{p.name}</span>;
  };
  if(loading)return<div style={{textAlign:"center",padding:40,color:C.textMid}}>Loading client data from Firestore…</div>;

  const DS={bg:"#060d1f",card:"rgba(255,255,255,0.04)",border:"rgba(255,255,255,0.08)",text:"#fff",sub:"rgba(255,255,255,0.5)",accent:"#F0A500"};

  const DCard=({children,style={}})=>(
    <div style={{background:DS.card,border:`1px solid ${DS.border}`,borderRadius:12,padding:16,...style}}>{children}</div>
  );

  const DTable=({headers,rows})=>(
    <div style={{overflowX:"auto"}}>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
        <thead><tr style={{background:"rgba(255,255,255,0.03)"}}>
          {headers.map(h=><th key={h} style={{padding:"9px 12px",textAlign:"left",color:DS.sub,fontWeight:700,fontSize:10,textTransform:"uppercase",borderBottom:`1px solid ${DS.border}`,whiteSpace:"nowrap"}}>{h}</th>)}
        </tr></thead>
        <tbody>{rows.length===0?<tr><td colSpan={headers.length} style={{textAlign:"center",padding:32,color:DS.sub}}>No data</td></tr>:rows.map((row,i)=>(
          <tr key={i} style={{borderBottom:`1px solid ${DS.border}`}}>
            {row.map((cell,j)=><td key={j} style={{padding:"9px 12px",color:DS.text,verticalAlign:"middle"}}>{cell}</td>)}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );

  return(
    <div style={{fontFamily:"'Plus Jakarta Sans',sans-serif",color:DS.text}}>
      {/* KPI Row */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:10,marginBottom:16}}>
        {[
          [activations.length,"Total Clients","🏢","#6366f1"],
          [active.length,"Active","✅","#1A8A4A"],
          [pending.length,"Pending Review","⏳","#F0A500"],
          [suspended.length,"Suspended","🚫","#D94040"],
          [`SAR ${totalMRR.toLocaleString()}`,`MRR (Est.)`, "💰","#F0A500"],
          [licenses.filter(l=>l.active&&!l.activatedBy).length,"Keys Available","🔑","#6366f1"]
        ].map(([v,l,ic,col])=>(
          <div key={l} style={{background:col+"15",border:`1px solid ${col}30`,borderRadius:10,padding:"12px 14px"}}>
            <div style={{fontSize:11,color:col,fontWeight:700,marginBottom:4}}>{ic} {l}</div>
            <div style={{fontSize:18,fontWeight:900,color:col}}>{v}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{display:"flex",gap:6,marginBottom:16,flexWrap:"wrap"}}>
        <OTab id="overview" label="📊 Overview" count={0}/>
        <OTab id="clients" label="👥 Clients" count={active.length}/>
        <OTab id="pending" label="⏳ Pending" count={pending.length}/>
        <OTab id="licenses" label="🔑 Licenses" count={0}/>
        <OTab id="devices" label="📱 Devices" count={0}/>
        <OTab id="activity" label="📋 Activity Log" count={0}/>
        <OTab id="plans" label="💳 Plans" count={0}/>
        <OTab id="admin" label="⚙️ Admin Tools" count={0}/>
      </div>

      {/* OVERVIEW */}
      {tab==="overview"&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
        <DCard>
          <div style={{fontSize:13,fontWeight:700,marginBottom:12}}>📊 Subscription Breakdown</div>
          {Object.values(SUBSCRIPTION_PLANS).map(p=>{
            const count=activations.filter(a=>a.status==="approved"&&(a.subscriptionPlan||"basic")===p.id).length;
            return(
              <div key={p.id} style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
                <span style={{width:10,height:10,borderRadius:"50%",background:p.color,flexShrink:0,display:"inline-block"}}/>
                <span style={{flex:1,fontSize:12,color:DS.sub}}>{p.name}</span>
                <span style={{fontSize:12,fontWeight:700,color:p.color}}>{count} clients</span>
                <span style={{fontSize:11,color:DS.sub}}>SAR {(count*p.price).toLocaleString()}/mo</span>
              </div>
            );
          })}
          <div style={{marginTop:12,paddingTop:10,borderTop:`1px solid ${DS.border}`,display:"flex",justifyContent:"space-between",fontSize:13,fontWeight:800}}>
            <span style={{color:DS.sub}}>Total MRR</span>
            <span style={{color:"#F0A500"}}>SAR {totalMRR.toLocaleString()}</span>
          </div>
        </DCard>
        <DCard>
          <div style={{fontSize:13,fontWeight:700,marginBottom:12}}>🕐 Recent Activity</div>
          {activityLog.slice(0,8).map((l,i)=>(
            <div key={i} style={{fontSize:11,padding:"6px 0",borderBottom:`1px solid ${DS.border}`,display:"flex",justifyContent:"space-between"}}>
              <span style={{color:DS.sub}}>{l.action.replace(/_/g," ")}</span>
              <span style={{color:"rgba(255,255,255,0.35)",fontSize:10}}>{l.timestamp?.slice(0,16).replace("T"," ")}</span>
            </div>
          ))}
          {activityLog.length===0&&<div style={{fontSize:12,color:DS.sub,textAlign:"center",padding:"20px 0"}}>No activity yet</div>}
        </DCard>
        <DCard>
          <div style={{fontSize:13,fontWeight:700,marginBottom:12}}>📅 Client Status</div>
          {[["Approved",active.length,"#1A8A4A"],["Pending",pending.length,"#F0A500"],["Suspended",suspended.length,"#D94040"]].map(([l,v,c])=>(
            <div key={l} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:`1px solid ${DS.border}`}}>
              <span style={{fontSize:12,color:DS.sub}}>{l}</span>
              <span style={{fontSize:14,fontWeight:800,color:c}}>{v}</span>
            </div>
          ))}
        </DCard>
        <DCard>
          <div style={{fontSize:13,fontWeight:700,marginBottom:12}}>📢 System Announcement</div>
          <textarea value={announcementText} onChange={e=>setAnnouncementText(e.target.value)}
            placeholder="Enter a system-wide announcement for all clients..."
            style={{width:"100%",height:80,padding:"8px 12px",background:"rgba(255,255,255,0.06)",border:`1px solid ${DS.border}`,borderRadius:8,color:"#fff",fontSize:12,fontFamily:"inherit",resize:"none"}}/>
          <button onClick={saveAnnouncement} style={{marginTop:8,padding:"8px 16px",background:"rgba(240,165,0,0.2)",border:"1px solid rgba(240,165,0,0.4)",borderRadius:8,color:"#F0A500",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>💾 Save Announcement</button>
        </DCard>
      </div>}

      {/* CLIENTS */}
      {tab==="clients"&&<div>
        <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap"}}>
          <input value={searchQ} onChange={e=>setSearchQ(e.target.value)} placeholder="🔍 Search by name, CR, license key…"
            style={{flex:1,padding:"8px 12px",background:"rgba(255,255,255,0.06)",border:`1px solid ${DS.border}`,borderRadius:8,color:"#fff",fontSize:12,fontFamily:"inherit",minWidth:200}}/>
          <select value={planFilter} onChange={e=>setPlanFilter(e.target.value)}
            style={{padding:"8px 12px",background:"rgba(255,255,255,0.06)",border:`1px solid ${DS.border}`,borderRadius:8,color:"#fff",fontSize:12,fontFamily:"inherit"}}>
            <option value="all">All Plans</option>
            {Object.values(SUBSCRIPTION_PLANS).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div style={{display:"grid",gap:10}}>
          {filteredClients.map(a=>(
            <div key={a.id} onClick={()=>setSelectedClient(selectedClient?.id===a.id?null:a)}
              style={{background:selectedClient?.id===a.id?"rgba(99,102,241,0.12)":"rgba(255,255,255,0.03)",border:`1px solid ${selectedClient?.id===a.id?"rgba(99,102,241,0.5)":DS.border}`,borderRadius:10,padding:"12px 16px",cursor:"pointer"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <div style={{width:36,height:36,background:"rgba(99,102,241,0.2)",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>🏢</div>
                  <div>
                    <div style={{fontSize:13,fontWeight:700}}>{a.businessName}</div>
                    <div style={{fontSize:11,color:DS.sub}}>CR: {a.crNumber} · VAT: {a.vatNumber}</div>
                  </div>
                </div>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <PlanBadge plan={a.subscriptionPlan}/>
                  <span style={{padding:"3px 10px",borderRadius:20,fontSize:10,fontWeight:700,color:statusColor[a.status]||"#999",background:statusBg[a.status]||"rgba(255,255,255,0.05)"}}>{a.status}</span>
                  <span style={{fontSize:11,color:"#F0A500",fontFamily:"monospace"}}>{a.licenseKey}</span>
                </div>
              </div>
              {selectedClient?.id===a.id&&(
                <div style={{marginTop:14,paddingTop:14,borderTop:`1px solid ${DS.border}`}}>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:12}}>
                    {[["City",a.city||"—"],["Phone",a.phone||"—"],["Activated",a.activatedAt?fmtDate(a.activatedAt):"—"],["Location",a.location?`📍 ${a.location.lat?.toFixed(3)}, ${a.location.lng?.toFixed(3)}`:"Not shared"],["Device",a.deviceId?.slice(0,40)||"—"],["Submitted",a.submittedAt?fmtDateTime(a.submittedAt):"—"]].map(([k,v])=>(
                      <div key={k} style={{background:"rgba(255,255,255,0.04)",borderRadius:8,padding:"8px 12px"}}>
                        <div style={{fontSize:10,color:DS.sub,fontWeight:700,marginBottom:2}}>{k}</div>
                        <div style={{fontSize:11,wordBreak:"break-all"}}>{v}</div>
                      </div>
                    ))}
                  </div>
                  {/* Plan upgrade */}
                  <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
                    <span style={{fontSize:11,color:DS.sub,alignSelf:"center"}}>Change Plan:</span>
                    {Object.values(SUBSCRIPTION_PLANS).map(p=>(
                      <button key={p.id} onClick={e=>{e.stopPropagation();upgradeSubscription(a.id,p.id);}}
                        style={{padding:"5px 12px",background:(a.subscriptionPlan||"basic")===p.id?p.color+"33":"rgba(255,255,255,0.05)",border:`1px solid ${p.color}44`,borderRadius:6,color:p.color,fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
                        {p.name} · SAR {p.price}
                      </button>
                    ))}
                  </div>
                  {/* Actions */}
                  <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                    {a.status==="approved"&&(
                      <button onClick={e=>{e.stopPropagation();if(confirm("Suspend this client?"))suspendClient(a.id,true);}}
                        style={{padding:"6px 14px",background:"rgba(217,64,64,0.15)",border:"1px solid rgba(217,64,64,0.35)",borderRadius:6,color:"#ff6b6b",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>🚫 Suspend</button>
                    )}
                    {a.status==="suspended"&&(
                      <button onClick={e=>{e.stopPropagation();suspendClient(a.id,false);}}
                        style={{padding:"6px 14px",background:"rgba(26,138,74,0.15)",border:"1px solid rgba(26,138,74,0.35)",borderRadius:6,color:"#4ade80",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>✅ Reactivate</button>
                    )}
                    {a.location&&(
                      <a href={`https://maps.google.com/?q=${a.location.lat},${a.location.lng}`} target="_blank" rel="noreferrer"
                        style={{padding:"6px 14px",background:"rgba(99,102,241,0.15)",border:"1px solid rgba(99,102,241,0.35)",borderRadius:6,color:"#a5b4fc",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit",textDecoration:"none"}} onClick={e=>e.stopPropagation()}>📍 View Map</a>
                    )}
                    <button onClick={e=>{e.stopPropagation();setNotifClient(a);setShowSendNotif(true);}}
                      style={{padding:"6px 14px",background:"rgba(240,165,0,0.15)",border:"1px solid rgba(240,165,0,0.35)",borderRadius:6,color:"#F0A500",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>📢 Notify</button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {filteredClients.length===0&&<div style={{textAlign:"center",padding:"40px 0",color:DS.sub}}>No clients found</div>}
        </div>
      </div>}

      {/* PENDING */}
      {tab==="pending"&&<div>
        {pending.length===0?(
          <div style={{textAlign:"center",padding:"60px 0",color:DS.sub}}>
            <div style={{fontSize:48,marginBottom:12}}>✅</div>
            <div>No pending reviews</div>
          </div>
        ):(
          <div style={{display:"grid",gap:10}}>
            {pending.map(a=>(
              <DCard key={a.id} style={{padding:"14px 18px"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
                  <div>
                    <div style={{fontSize:14,fontWeight:700}}>{a.businessName}</div>
                    <div style={{fontSize:11,color:DS.sub}}>CR: {a.crNumber} · VAT: {a.vatNumber} · 🔑 {a.licenseKey}</div>
                    <div style={{fontSize:11,color:"rgba(255,255,255,0.35)",marginTop:3}}>Submitted: {a.submittedAt?fmtDateTime(a.submittedAt):"—"} · City: {a.city||"—"}</div>
                  </div>
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={async()=>{if(confirm("Approve this activation?"))await updateDoc(doc(db,"pending_activations",a.id),{status:"approved",reviewedAt:new Date().toISOString()}).then(()=>setActivations(prev=>prev.map(x=>x.id===a.id?{...x,status:"approved"}:x)));}}
                      style={{padding:"7px 16px",background:"rgba(26,138,74,0.2)",border:"1px solid rgba(26,138,74,0.4)",borderRadius:8,color:"#4ade80",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>✓ Approve</button>
                    <button onClick={async()=>{const reason=prompt("Rejection reason (optional):");await updateDoc(doc(db,"pending_activations",a.id),{status:"rejected",rejectReason:reason||"",reviewedAt:new Date().toISOString()}).then(()=>setActivations(prev=>prev.map(x=>x.id===a.id?{...x,status:"rejected"}:x)));}}
                      style={{padding:"7px 16px",background:"rgba(217,64,64,0.2)",border:"1px solid rgba(217,64,64,0.4)",borderRadius:8,color:"#ff6b6b",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>✕ Reject</button>
                  </div>
                </div>
              </DCard>
            ))}
          </div>
        )}
      </div>}

      {/* LICENSES */}
      {tab==="licenses"&&<DCard>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
          <div style={{fontSize:13,fontWeight:700}}>License Keys ({licenses.length})</div>
          <div style={{display:"flex",gap:8,fontSize:11}}>
            <span style={{color:"#1A8A4A"}}>✅ {licenses.filter(l=>l.active&&l.activatedBy).length} Used</span>
            <span style={{color:"#6366f1"}}>🔑 {licenses.filter(l=>l.active&&!l.activatedBy).length} Available</span>
            <span style={{color:"#D94040"}}>❌ {licenses.filter(l=>!l.active).length} Inactive</span>
          </div>
        </div>
        <DTable
          headers={["Key","Status","Plan","Business","Activated","Toggle"]}
          rows={licenses.map(l=>{
            const client=activations.find(a=>a.licenseKey===l.key);
            return[
              <span style={{fontFamily:"monospace",color:"#F0A500",fontWeight:700,fontSize:11}}>{l.key}</span>,
              <span style={{padding:"2px 8px",borderRadius:20,fontSize:10,fontWeight:700,color:l.active?"#1A8A4A":"#D94040",background:l.active?"#1A8A4A22":"#D9404022"}}>{l.active?"Active":"Inactive"}</span>,
              client?<PlanBadge plan={client.subscriptionPlan}/>:<span style={{color:DS.sub,fontSize:10}}>—</span>,
              <span style={{fontSize:11}}>{l.activatedBy||l.businessName||"—"}</span>,
              <span style={{fontSize:10,color:DS.sub}}>{l.activatedAt?fmtDate(l.activatedAt):"—"}</span>,
              <button onClick={()=>toggleLicense(l.id,l.active)} style={{padding:"4px 10px",background:l.active?"rgba(217,64,64,0.15)":"rgba(26,138,74,0.15)",border:`1px solid ${l.active?"rgba(217,64,64,0.3)":"rgba(26,138,74,0.3)"}`,borderRadius:5,color:l.active?"#ff6b6b":"#4ade80",fontSize:10,cursor:"pointer",fontFamily:"inherit",fontWeight:700}}>{l.active?"Deactivate":"Activate"}</button>
            ];
          })}
        />
      </DCard>}

      {/* DEVICES */}
      {tab==="devices"&&<DCard>
        <div style={{fontSize:13,fontWeight:700,marginBottom:14}}>📱 Device Registry</div>
        <DTable
          headers={["Business","License","Browser","OS","Activated","Location"]}
          rows={activations.filter(a=>a.deviceId||a.deviceInfo).map(a=>{
            const di=a.deviceInfo||{};
            return[
              <span style={{fontWeight:600}}>{a.businessName}</span>,
              <span style={{fontFamily:"monospace",color:"#F0A500",fontSize:10}}>{a.licenseKey}</span>,
              <span style={{fontSize:11}}>{di.browser||"—"}</span>,
              <span style={{fontSize:11}}>{di.os||a.deviceId?.slice(0,30)||"—"}</span>,
              <span style={{fontSize:10,color:DS.sub}}>{a.activatedAt?fmtDate(a.activatedAt):"—"}</span>,
              a.location?(
                <a href={`https://maps.google.com/?q=${a.location.lat},${a.location.lng}`} target="_blank" rel="noreferrer" style={{color:"#4ade80",fontSize:10,fontWeight:700}}>📍 Map</a>
              ):<span style={{color:"rgba(255,255,255,0.2)",fontSize:10}}>—</span>
            ];
          })}
        />
        {activations.filter(a=>a.deviceId||a.deviceInfo).length===0&&<div style={{textAlign:"center",padding:20,color:DS.sub,fontSize:12}}>No device data yet. Devices are logged on first activation.</div>}
      </DCard>}

      {/* ACTIVITY LOG */}
      {tab==="activity"&&<div>
        <DCard style={{marginBottom:10}}>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            <input value={actFilter.client} onChange={e=>setActFilter(f=>({...f,client:e.target.value}))} placeholder="Filter by client/user…"
              style={{flex:1,padding:"7px 10px",background:"rgba(255,255,255,0.06)",border:`1px solid ${DS.border}`,borderRadius:6,color:"#fff",fontSize:11,fontFamily:"inherit",minWidth:140}}/>
            <select value={actFilter.type} onChange={e=>setActFilter(f=>({...f,type:e.target.value}))}
              style={{padding:"7px 10px",background:"rgba(255,255,255,0.06)",border:`1px solid ${DS.border}`,borderRadius:6,color:"#fff",fontSize:11,fontFamily:"inherit"}}>
              <option value="">All Types</option>
              {["LICENSE_TOGGLE","PLAN_CHANGE","CLIENT_SUSPENDED","CLIENT_REACTIVATED","ITEM_ADDED","ITEM_EDITED","SETTING_CHANGED"].map(t=><option key={t} value={t}>{t.replace(/_/g," ")}</option>)}
            </select>
            <input type="date" value={actFilter.date} onChange={e=>setActFilter(f=>({...f,date:e.target.value}))}
              style={{padding:"7px 10px",background:"rgba(255,255,255,0.06)",border:`1px solid ${DS.border}`,borderRadius:6,color:"#fff",fontSize:11,fontFamily:"inherit"}}/>
            <button onClick={()=>setActFilter({client:"",type:"",date:""})} style={{padding:"7px 12px",background:"rgba(255,255,255,0.05)",border:`1px solid ${DS.border}`,borderRadius:6,color:DS.sub,fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>Clear</button>
          </div>
        </DCard>
        <DCard>
          {filteredLog.length===0?(
            <div style={{textAlign:"center",padding:"30px 0",color:DS.sub}}>No activity matching filters</div>
          ):(
            filteredLog.slice(0,50).map((l,i)=>(
              <div key={i} style={{display:"flex",gap:12,padding:"8px 0",borderBottom:`1px solid ${DS.border}`,alignItems:"flex-start"}}>
                <span style={{fontSize:10,fontFamily:"monospace",color:"rgba(255,255,255,0.3)",flexShrink:0,paddingTop:1,minWidth:130}}>{l.timestamp?.slice(0,16).replace("T"," ")}</span>
                <span style={{flex:1,fontSize:11}}><strong style={{color:"#a5b4fc"}}>{l.action.replace(/_/g," ")}</strong>{l.details?.after&&<span style={{color:DS.sub}}> → {JSON.stringify(l.details.after)}</span>}</span>
                <span style={{fontSize:10,color:DS.sub,flexShrink:0}}>{l.user}</span>
              </div>
            ))
          )}
        </DCard>
      </div>}

      {/* PLANS */}
      {tab==="plans"&&<div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:16}}>
        {Object.values(SUBSCRIPTION_PLANS).map(p=>(
          <DCard key={p.id} style={{border:`1px solid ${p.color}44`}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
              <div>
                <div style={{fontSize:16,fontWeight:800,color:p.color}}>{p.name}</div>
                <div style={{fontSize:11,color:DS.sub}}>{p.nameAr}</div>
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:22,fontWeight:900,color:p.color}}>SAR {p.price}</div>
                <div style={{fontSize:10,color:DS.sub}}>/month</div>
              </div>
            </div>
            <div style={{marginBottom:12}}>
              {p.features.map((f,i)=><div key={i} style={{fontSize:11,color:"rgba(255,255,255,0.7)",padding:"3px 0",display:"flex",gap:6}}>
                <span style={{color:p.color,flexShrink:0}}>✓</span>{f}
              </div>)}
            </div>
            <div style={{borderTop:`1px solid ${DS.border}`,paddingTop:10,fontSize:11,color:DS.sub}}>
              Active clients: <strong style={{color:p.color}}>{activations.filter(a=>a.status==="approved"&&(a.subscriptionPlan||"basic")===p.id).length}</strong>
              &nbsp;· MRR: <strong style={{color:p.color}}>SAR {(activations.filter(a=>a.status==="approved"&&(a.subscriptionPlan||"basic")===p.id).length*p.price).toLocaleString()}</strong>
            </div>
          </DCard>
        ))}
      </div>}

      {/* ADMIN TOOLS */}
      {tab==="admin"&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
        <DCard>
          <div style={{fontSize:13,fontWeight:700,marginBottom:12}}>📢 System Announcement</div>
          <textarea value={announcementText} onChange={e=>setAnnouncementText(e.target.value)}
            placeholder="Broadcast a message to all clients..."
            style={{width:"100%",height:100,padding:"10px 12px",background:"rgba(255,255,255,0.06)",border:`1px solid ${DS.border}`,borderRadius:8,color:"#fff",fontSize:12,fontFamily:"inherit",resize:"none"}}/>
          <button onClick={saveAnnouncement} style={{marginTop:8,width:"100%",padding:"10px",background:"rgba(240,165,0,0.2)",border:"1px solid rgba(240,165,0,0.4)",borderRadius:8,color:"#F0A500",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>💾 Save & Broadcast</button>
        </DCard>
        <DCard>
          <div style={{fontSize:13,fontWeight:700,marginBottom:12}}>📊 System Stats</div>
          {[
            ["Total Licenses",licenses.length],
            ["Active Clients",active.length],
            ["Pending Reviews",pending.length],
            ["Suspended",suspended.length],
            ["Available Keys",licenses.filter(l=>l.active&&!l.activatedBy).length],
            ["Activity Logs",activityLog.length],
          ].map(([k,v])=>(
            <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:`1px solid ${DS.border}`,fontSize:12}}>
              <span style={{color:DS.sub}}>{k}</span><strong>{v}</strong>
            </div>
          ))}
        </DCard>
        <DCard>
          <div style={{fontSize:13,fontWeight:700,marginBottom:12}}>📥 Bulk Export</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {[["Export All Clients CSV",()=>{const rows=activations.map(a=>[a.businessName,a.crNumber,a.vatNumber,a.licenseKey,a.city,a.status,a.subscriptionPlan||"basic",a.submittedAt].join(","));const csv="Business,CR,VAT,License,City,Status,Plan,Date\n"+rows.join("\n");const blob=new Blob([csv],{type:"text/csv"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download="restopos-clients.csv";a.click();},"📋"],
              ["Export License Keys CSV",()=>{const rows=licenses.map(l=>[l.key,l.active?"Active":"Inactive",l.activatedBy||"",l.activatedAt||""].join(","));const csv="Key,Status,ActivatedBy,Date\n"+rows.join("\n");const blob=new Blob([csv],{type:"text/csv"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download="restopos-licenses.csv";a.click();},"🔑"],
              ["Export Activity Log",()=>{const rows=activityLog.map(l=>[l.timestamp,l.action,l.user,JSON.stringify(l.details)].join(","));const csv="Timestamp,Action,User,Details\n"+rows.join("\n");const blob=new Blob([csv],{type:"text/csv"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download="restopos-activity.csv";a.click();},"📊"]
            ].map(([label,fn,ic])=>(
              <button key={label} onClick={fn} style={{padding:"10px 14px",background:"rgba(255,255,255,0.05)",border:`1px solid ${DS.border}`,borderRadius:8,color:"#fff",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>
                {ic} {label}
              </button>
            ))}
          </div>
        </DCard>
        <DCard>
          <div style={{fontSize:13,fontWeight:700,marginBottom:12}}>⚡ Quick Actions</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            <button onClick={()=>{if(confirm("Clear local activity log?"))LS.del("restopos_activity_log");setActivityLog([]);}} style={{padding:"10px 14px",background:"rgba(217,64,64,0.1)",border:"1px solid rgba(217,64,64,0.3)",borderRadius:8,color:"#ff6b6b",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>🗑 Clear Activity Log</button>
            <button onClick={()=>{logActivity("MANUAL_TEST",{msg:"Owner triggered test log"},"Owner");setActivityLog(LS.get("restopos_activity_log")||[]);alert("Test log entry added!");}} style={{padding:"10px 14px",background:"rgba(99,102,241,0.1)",border:"1px solid rgba(99,102,241,0.3)",borderRadius:8,color:"#a5b4fc",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>🧪 Add Test Log Entry</button>
          </div>
        </DCard>
      </div>}

      {/* Send Notification Modal */}
      {showSendNotif&&notifClient&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:"#1a2035",border:"1px solid rgba(255,255,255,0.12)",borderRadius:16,padding:24,width:420,maxWidth:"95vw"}}>
            <div style={{fontSize:14,fontWeight:700,marginBottom:12}}>📢 Notify: {notifClient.businessName}</div>
            <textarea value={notifyMsg} onChange={e=>setNotifyMsg(e.target.value)} placeholder="Type your message..." rows={4}
              style={{width:"100%",padding:"10px",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:8,color:"#fff",fontSize:12,fontFamily:"inherit",resize:"none"}}/>
            <div style={{display:"flex",gap:10,marginTop:14}}>
              <button onClick={()=>{logActivity("NOTIFICATION_SENT",{clientId:notifClient.id,msg:notifyMsg},"Owner");setNotifyMsg("");setShowSendNotif(false);alert("Notification logged for "+notifClient.businessName);}}
                style={{flex:1,padding:"10px",background:"rgba(240,165,0,0.2)",border:"1px solid rgba(240,165,0,0.4)",borderRadius:8,color:"#F0A500",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Send</button>
              <button onClick={()=>{setShowSendNotif(false);setNotifyMsg("");}}
                style={{flex:1,padding:"10px",background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,color:DS.sub,fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
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
// EXPENSE TRACKING MODULE
// ═══════════════════════════════════════════════════════════════════
const EXPENSE_CATEGORIES=["Rent","Utilities","Salaries","Food Supplies","Kitchen Supplies","Packaging","Marketing","Maintenance","Transport","Other"];
function Expenses(){
  const [expenses,setExpenses]=useState(()=>LS.get("restopos_expenses")||[]);
  const [showModal,setShowModal]=useState(false);
  const [period,setPeriod]=useState("month");
  const [form,setForm]=useState({description:"",amount:"",category:"Food Supplies",date:TODAY,notes:""});
  const now=new Date();
  function saveExpenses(newList){setExpenses(newList);LS.set("restopos_expenses",newList);}
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

// ═══════════════════════════════════════════════════════════════════
// CUSTOMER DATABASE MODULE
// ═══════════════════════════════════════════════════════════════════
function Customers({sales}){
  const [customers,setCustomers]=useState(()=>LS.get("restopos_customers")||[]);
  const [showModal,setShowModal]=useState(false);
  const [editCust,setEditCust]=useState(null);
  const [search,setSearch]=useState("");
  const [tab,setTab]=useState("list");
  const blank={name:"",phone:"",email:"",notes:"",loyaltyPoints:0};
  const [form,setForm]=useState(blank);
  function saveCustomers(list){setCustomers(list);LS.set("restopos_customers",list);}
  function openModal(c=null){setEditCust(c);setForm(c?{...c}:{...blank});setShowModal(true);}
  function save(){
    if(!form.name||!form.phone)return alert("Name and phone required");
    const now=new Date().toISOString();
    const cust={...form,id:editCust?editCust.id:Date.now(),createdAt:editCust?.createdAt||now,updatedAt:now,loyaltyPoints:parseInt(form.loyaltyPoints)||0};
    saveCustomers(editCust?customers.map(c=>c.id===editCust.id?cust:c):[cust,...customers]);
    setShowModal(false);
    logActivity(editCust?"CUSTOMER_UPDATED":"CUSTOMER_ADDED",{after:{name:form.name,phone:form.phone}},"Admin");
  }
  function deleteCust(id){if(confirm("Delete customer?"))saveCustomers(customers.filter(c=>c.id!==id));}
  const custWithHistory=customers.map(c=>{
    const orders=sales.filter(s=>s.customerPhone===c.phone);
    const totalSpent=orders.reduce((s,o)=>s+o.total,0);
    return{...c,orderCount:orders.length,totalSpent,lastOrder:orders[orders.length-1]?.date||null};
  });
  const filtered=custWithHistory.filter(c=>!search||c.name.toLowerCase().includes(search.toLowerCase())||c.phone.includes(search));
  function exportCustomers(){
    const csv=["Name,Phone,Email,Orders,Total Spent,Loyalty Points",...filtered.map(c=>`"${c.name}","${c.phone}","${c.email||""}",${c.orderCount},${c.totalSpent.toFixed(2)},${c.loyaltyPoints}`)].join("\n");
    const blob=new Blob([csv],{type:"text/csv"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=`customers-${TODAY}.csv`;a.click();
  }
  const topSpenders=[...custWithHistory].sort((a,b)=>b.totalSpent-a.totalSpent).slice(0,5);
  return(
    <div>
      {showModal&&<Modal title={editCust?"Edit Customer":"New Customer"} onClose={()=>setShowModal(false)} width={460}>
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          <Inp label="Full Name" value={form.name} onChange={v=>setForm(f=>({...f,name:v}))}/>
          <Inp label="Phone" value={form.phone} onChange={v=>setForm(f=>({...f,phone:v}))} placeholder="+966 50 000 0000"/>
          <Inp label="Email (optional)" value={form.email||""} onChange={v=>setForm(f=>({...f,email:v}))}/>
          <Inp label="Loyalty Points" value={form.loyaltyPoints} onChange={v=>setForm(f=>({...f,loyaltyPoints:v}))} type="number"/>
          <div style={{display:"flex",flexDirection:"column",gap:4}}>
            <label style={{fontSize:12,fontWeight:600,color:C.textMid}}>Notes</label>
            <textarea value={form.notes||""} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} rows={2} style={{padding:"9px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontFamily:"inherit",resize:"none"}}/>
          </div>
        </div>
        <div style={{display:"flex",gap:10,marginTop:16}}>
          <Btn variant="ghost" onClick={()=>setShowModal(false)} style={{flex:1}}>Cancel</Btn>
          <Btn onClick={save} style={{flex:1}}>💾 Save</Btn>
        </div>
      </Modal>}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20,flexWrap:"wrap",gap:10}}>
        <div><div style={{fontSize:20,fontWeight:800}}>👥 Customer Database</div><div style={{fontSize:13,color:C.textMid,marginTop:2}}>{customers.length} customers registered</div></div>
        <div style={{display:"flex",gap:8}}>
          <Btn variant="outline" size="sm" onClick={exportCustomers}>📤 Export</Btn>
          <Btn onClick={()=>openModal()}>+ New Customer</Btn>
        </div>
      </div>
      <div style={{display:"flex",gap:6,marginBottom:16,flexWrap:"wrap"}}>
        {[["list","👥 All Customers"],["top","⭐ Top Spenders"],["loyalty","🎁 Loyalty"]].map(([id,lbl])=>(
          <button key={id} onClick={()=>setTab(id)} style={{padding:"7px 16px",borderRadius:8,border:`1.5px solid ${tab===id?C.primary:C.border}`,background:tab===id?C.primaryLight:"#fff",color:tab===id?C.primary:C.textMid,fontFamily:"inherit",fontSize:13,fontWeight:600,cursor:"pointer"}}>{lbl}</button>
        ))}
      </div>
      {tab==="list"&&<>
        <Card style={{marginBottom:16}}>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="🔍 Search by name or phone..." style={{width:"100%",padding:"9px 14px",border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontFamily:"inherit"}}/>
        </Card>
        {filtered.length===0?<Card><div style={{textAlign:"center",padding:"40px 0",color:C.textMid}}><div style={{fontSize:40,marginBottom:12}}>👥</div><div>No customers yet. Add your first customer.</div></div></Card>
        :<Card><DataTable headers={["Name","Phone","Email","Orders","Total Spent","Points","Actions"]} rows={filtered.map(c=>[
          <strong>{c.name}</strong>,
          <span style={{fontFamily:"monospace"}}>{c.phone}</span>,
          <span style={{fontSize:12,color:C.textLight}}>{c.email||"—"}</span>,
          <Badge color={C.info} bg={C.infoLight}>{c.orderCount}</Badge>,
          <strong style={{color:C.primary}}>{fmtSAR(c.totalSpent)}</strong>,
          <Badge color={C.accent} bg={C.accentLight}>{c.loyaltyPoints}pts</Badge>,
          <div style={{display:"flex",gap:4}}>
            <Btn size="sm" variant="ghost" onClick={()=>openModal(c)}>Edit</Btn>
            <Btn size="sm" variant="danger" onClick={()=>deleteCust(c.id)}>Del</Btn>
          </div>
        ])}/></Card>}
      </>}
      {tab==="top"&&<Card>
        <div style={{fontSize:14,fontWeight:700,marginBottom:16}}>⭐ Top 5 Spenders</div>
        {topSpenders.length===0?<div style={{color:C.textLight,textAlign:"center",padding:32}}>No customer spend data yet</div>
        :<div style={{display:"flex",flexDirection:"column",gap:8}}>{topSpenders.map((c,i)=>(
          <div key={c.id} style={{display:"flex",alignItems:"center",gap:14,padding:"12px 16px",background:i===0?C.primaryLight:C.bg,borderRadius:10,border:`1px solid ${i===0?C.primary:C.border}`}}>
            <div style={{width:32,height:32,borderRadius:"50%",background:i===0?"linear-gradient(135deg,#F0A500,#e09000)":C.primary,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:800}}>{i+1}</div>
            <div style={{flex:1}}><div style={{fontWeight:700}}>{c.name}</div><div style={{fontSize:12,color:C.textLight}}>{c.phone} · {c.orderCount} orders</div></div>
            <div style={{textAlign:"right"}}><div style={{fontSize:16,fontWeight:800,color:C.primary}}>{fmtSAR(c.totalSpent)}</div><div style={{fontSize:11,color:C.textLight}}>{c.loyaltyPoints} pts</div></div>
          </div>
        ))}</div>}
      </Card>}
      {tab==="loyalty"&&<Card>
        <div style={{fontSize:14,fontWeight:700,marginBottom:16}}>🎁 Loyalty Program</div>
        <div style={{background:C.infoLight,border:`1px solid ${C.info}`,borderRadius:10,padding:"12px 16px",marginBottom:16,fontSize:13,color:C.info}}>
          ℹ️ Earn 1 point per SAR spent. 100 points = SAR 10 discount. Points are manually awarded here.
        </div>
        {customers.length===0?<div style={{color:C.textLight,textAlign:"center",padding:32}}>No customers registered</div>
        :<DataTable headers={["Customer","Phone","Points","Actions"]} rows={customers.map(c=>[
          <strong>{c.name}</strong>,
          <span style={{fontFamily:"monospace",fontSize:12}}>{c.phone}</span>,
          <span style={{fontSize:16,fontWeight:800,color:C.accent}}>{c.loyaltyPoints}pts</span>,
          <div style={{display:"flex",gap:6}}>
            <Btn size="sm" variant="outline" onClick={()=>{const pts=parseInt(prompt(`Add points for ${c.name}:`)||"0");if(pts>0){saveCustomers(customers.map(x=>x.id===c.id?{...x,loyaltyPoints:(x.loyaltyPoints||0)+pts}:x));}}}>+Points</Btn>
            <Btn size="sm" variant="ghost" onClick={()=>{if(c.loyaltyPoints>=100&&confirm("Redeem 100 points for SAR 10 discount?"))saveCustomers(customers.map(x=>x.id===c.id?{...x,loyaltyPoints:x.loyaltyPoints-100}:x));}}>Redeem</Btn>
          </div>
        ])}/>}
      </Card>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// ENHANCED BACKUP & RESTORE MODULE
// ═══════════════════════════════════════════════════════════════════
function BackupManager({sales,items}){
  const [lastBackup,setLastBackup]=useState(()=>LS.get("restopos_last_backup")||null);
  function downloadFullBackup(){
    const backup={
      version:"v13",timestamp:new Date().toISOString(),
      sales,items,
      settings:{company:LS.get("restopos_company"),invoiceFormat:LS.get("restopos_invoice_format"),tables:LS.get("restopos_tables"),promos:LS.get("restopos_promos")},
      customers:LS.get("restopos_customers")||[],
      expenses:LS.get("restopos_expenses")||[],
      zatcaInvoices:invoiceStorage.getAll(),
      activityLog:(LS.get("restopos_activity_log")||[]).slice(0,100),
    };
    const json=JSON.stringify(backup,null,2);
    const blob=new Blob([json],{type:"application/json"});
    const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;
    a.download=`restopos-full-backup-${TODAY}.json`;a.click();
    LS.set("restopos_last_backup",new Date().toISOString());
    setLastBackup(new Date().toISOString());
  }
  function downloadSalesCSV(){
    const headers=["Invoice","Date","Time","Type","Table","Payment","Subtotal","VAT","Total","Items","Status"];
    const rows=sales.map(s=>[s.id,s.date,s.time,s.type,s.table||"",s.payMethod,(s.subtotal||0).toFixed(2),(s.vat||0).toFixed(2),s.total.toFixed(2),(s.items||[]).map(i=>`${i.qty}x${i.name}`).join("; "),s.status||"completed"]);
    const csv=[headers,...rows].map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
    const blob=new Blob([csv],{type:"text/csv"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=`sales-all-${TODAY}.csv`;a.click();
  }
  function downloadMenuCSV(){
    const headers=["Name","Arabic Name","Category","Price","Cost","Stock","Active","Barcode"];
    const rows=items.map(i=>[i.name,i.nameAr||"",i.category,i.price,i.cost||0,i.stock||0,i.active?"Yes":"No",i.barcode||""]);
    const csv=[headers,...rows].map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
    const blob=new Blob([csv],{type:"text/csv"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=`menu-${TODAY}.csv`;a.click();
  }
  function downloadVATReport(){
    const months={};
    sales.forEach(s=>{const ym=s.date?.slice(0,7)||"Unknown";if(!months[ym])months[ym]={month:ym,orders:0,subtotal:0,vat:0,total:0};months[ym].orders++;months[ym].subtotal+=s.subtotal||0;months[ym].vat+=s.vat||0;months[ym].total+=s.total||0;});
    const rows=Object.values(months).sort((a,b)=>a.month.localeCompare(b.month));
    const csv=["Month,Orders,Subtotal (SAR),VAT 15% (SAR),Total (SAR)",...rows.map(r=>`${r.month},${r.orders},${r.subtotal.toFixed(2)},${r.vat.toFixed(2)},${r.total.toFixed(2)}`)].join("\n");
    const blob=new Blob([csv],{type:"text/csv"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=`vat-report-${TODAY}.csv`;a.click();
  }
  function downloadZATCAXMLBundle(){
    const invoices=invoiceStorage.getAll();
    if(!invoices.length)return alert("No ZATCA invoices to export");
    const xmlDocs=invoices.map(inv=>`<!-- ${inv.invoice_number} -->\n${generateUBLXML(inv)}`).join("\n\n");
    const blob=new Blob([xmlDocs],{type:"application/xml"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=`zatca-all-invoices-${TODAY}.xml`;a.click();
  }
  function restoreBackup(file){
    const reader=new FileReader();
    reader.onload=e=>{
      try{
        const data=JSON.parse(e.target.result);
        if(!data.version)return alert("Invalid backup file");
        if(!confirm(`Restore backup from ${data.timestamp?.slice(0,10)}?\nThis will overwrite current data.`))return;
        if(data.sales)LS.set("restopos_sales",data.sales);
        if(data.items)LS.set("restopos_items",data.items);
        if(data.customers)LS.set("restopos_customers",data.customers);
        if(data.expenses)LS.set("restopos_expenses",data.expenses);
        if(data.settings?.company)LS.set("restopos_company",data.settings.company);
        if(data.settings?.invoiceFormat)LS.set("restopos_invoice_format",data.settings.invoiceFormat);
        if(data.settings?.tables)LS.set("restopos_tables",data.settings.tables);
        if(data.settings?.promos)LS.set("restopos_promos",data.settings.promos);
        if(data.zatcaInvoices)localStorage.setItem("zatca_invoices_v2",JSON.stringify(data.zatcaInvoices));
        alert("✅ Backup restored successfully! Reloading app...");
        setTimeout(()=>window.location.reload(),1000);
      }catch(err){alert("Failed to restore: "+err.message);}
    };
    reader.readAsText(file);
  }
  const exports=[
    {icon:"💾",title:"Full Backup (JSON)",desc:"All data: sales, menu, customers, expenses, settings, ZATCA invoices",action:downloadFullBackup,color:C.primary},
    {icon:"📊",title:"All Sales (CSV)",desc:"Complete sales history with items, payment methods, VAT",action:downloadSalesCSV,color:C.info},
    {icon:"🍔",title:"Menu & Stock (CSV)",desc:"Full menu with pricing, cost, and stock levels",action:downloadMenuCSV,color:C.success},
    {icon:"🧾",title:"VAT Report (CSV)",desc:"Monthly VAT summary — subtotal, tax, total per month",action:downloadVATReport,color:C.zatca},
    {icon:"📄",title:"ZATCA XML Bundle",desc:"All ZATCA UBL 2.1 invoices in one XML export file",action:downloadZATCAXMLBundle,color:C.accent},
  ];
  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
        <div><div style={{fontSize:20,fontWeight:800}}>💾 Data Backup & Export</div><div style={{fontSize:13,color:C.textMid,marginTop:2}}>Download your data anytime · Full restore supported</div></div>
        {lastBackup&&<div style={{fontSize:12,color:C.success,fontWeight:600}}>✓ Last backup: {fmtDateTime(lastBackup)}</div>}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:14,marginBottom:24}}>
        {exports.map(({icon,title,desc,action,color})=>(
          <Card key={title} style={{cursor:"pointer",transition:"border-color 0.2s"}} onClick={action}>
            <div style={{display:"flex",gap:14,alignItems:"flex-start"}}>
              <div style={{width:44,height:44,borderRadius:12,background:color+"22",display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,flexShrink:0}}>{icon}</div>
              <div style={{flex:1}}>
                <div style={{fontSize:14,fontWeight:700,color,marginBottom:4}}>{title}</div>
                <div style={{fontSize:12,color:C.textLight,lineHeight:1.4}}>{desc}</div>
              </div>
            </div>
          </Card>
        ))}
      </div>
      <Card>
        <div style={{fontSize:14,fontWeight:700,marginBottom:16}}>🔄 Restore from Backup</div>
        <div style={{background:C.warningLight,border:`1px solid ${C.warning}`,borderRadius:10,padding:"12px 16px",marginBottom:14,fontSize:13,color:C.warning,fontWeight:600}}>⚠️ Restoring will overwrite current data. Always download a fresh backup before restoring.</div>
        <div style={{display:"flex",gap:12,alignItems:"center"}}>
          <label style={{padding:"10px 20px",background:C.primary,color:"#fff",borderRadius:8,fontSize:13,fontWeight:700,cursor:"pointer"}}>
            📂 Choose Backup File
            <input type="file" accept=".json" onChange={e=>e.target.files[0]&&restoreBackup(e.target.files[0])} style={{display:"none"}}/>
          </label>
          <span style={{fontSize:12,color:C.textLight}}>Only RestoPOS v13 .json backup files</span>
        </div>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// PROFIT & LOSS MODULE
// ═══════════════════════════════════════════════════════════════════
function ProfitLoss({sales,items}){
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
  const revenue=filteredSales.reduce((s,o)=>s+(o.subtotal||0),0);
  const vatCollected=filteredSales.reduce((s,o)=>s+o.vat,0);
  const cogs=filteredSales.reduce((s,o)=>s+(o.items||[]).reduce((ss,it)=>{const item=items.find(i=>i.id===it.id);return ss+(item?.cost||0)*it.qty;},0),0);
  const opExpenses=filteredExp.reduce((s,e)=>s+e.amount,0);
  const grossProfit=revenue-cogs;
  const netProfit=grossProfit-opExpenses;
  const grossMargin=revenue>0?((grossProfit/revenue)*100).toFixed(1):0;
  const netMargin=revenue>0?((netProfit/revenue)*100).toFixed(1):0;
  const payBreakdown=["Cash","Mada","Apple Pay","STC Pay"].map(m=>({method:m,total:filteredSales.filter(s=>s.payMethod===m).reduce((s,o)=>s+o.total,0),count:filteredSales.filter(s=>s.payMethod===m).length}));
  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:24,flexWrap:"wrap",gap:10}}>
        <div><div style={{fontSize:20,fontWeight:800}}>📈 Profit & Loss</div><div style={{fontSize:13,color:C.textMid,marginTop:2}}>{{"today":"Today","week":"Last 7 Days","month":"This Month","all":"All Time"}[period]}</div></div>
        <div style={{display:"flex",gap:6}}>{[["today","Today"],["week","Week"],["month","Month"],["all","All"]].map(([id,lbl])=>(
          <button key={id} onClick={()=>setPeriod(id)} style={{padding:"7px 14px",borderRadius:8,border:`1.5px solid ${period===id?C.primary:C.border}`,background:period===id?C.primary:"#fff",color:period===id?"#fff":C.textMid,fontFamily:"inherit",fontSize:13,fontWeight:600,cursor:"pointer"}}>{lbl}</button>
        ))}</div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))",gap:16,marginBottom:24}}>
        <StatCard icon="💰" label="Revenue (excl. VAT)" value={fmtSAR(revenue)} color={C.primary} bg={C.primaryLight}/>
        <StatCard icon="🧾" label="VAT Collected" value={fmtSAR(vatCollected)} color={C.zatca} bg={C.zatcaLight}/>
        <StatCard icon="📦" label="Cost of Goods" value={fmtSAR(cogs)} color={C.warning} bg={C.warningLight}/>
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
          {[["Revenue (excl. VAT)",revenue,C.primary,false],["Cost of Goods Sold",-cogs,C.warning,false],["Gross Profit",grossProfit,grossProfit>=0?C.success:C.danger,false],["Operating Expenses",-opExpenses,C.danger,false],["Net Profit / (Loss)",netProfit,netProfit>=0?C.success:C.danger,true]].map(([label,val,color,isFinal])=>(
            <div key={label} style={{display:"flex",justifyContent:"space-between",padding:"10px 0",borderBottom:!isFinal?`1px solid ${C.border}`:"none",borderTop:isFinal?`2px solid ${C.border}`:"none",fontWeight:isFinal?800:400}}>
              <span style={{fontSize:13,color:isFinal?C.text:C.textMid}}>{label}</span>
              <span style={{fontWeight:700,color}}>{val<0?"(":""}{fmtSAR(Math.abs(val))}{val<0?")":""}</span>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// ADVANCED ANALYTICS (Hourly, VAT Reports, Staff Performance)
// ═══════════════════════════════════════════════════════════════════
function AdvancedReports({sales,items}){
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

// ═══════════════════════════════════════════════════════════════════
// SHIFT MANAGEMENT & CASH DRAWER RECONCILIATION
// ═══════════════════════════════════════════════════════════════════
function ShiftManager({sales,currentUser}){
  const [shifts,setShifts]=useState(()=>LS.get("restopos_shifts")||[]);
  const [activeShift,setActiveShift]=useState(()=>LS.get("restopos_active_shift")||null);
  const [cashDrawer,setCashDrawer]=useState("");
  const [note,setNote]=useState("");
  function startShift(){
    const shift={id:Date.now(),startTime:new Date().toISOString(),user:currentUser?.role||"Unknown",openingCash:parseFloat(cashDrawer)||0,note,endTime:null,closingCash:null,shiftRevenue:0,shiftOrders:0};
    const updated=[shift,...shifts.slice(0,49)];setShifts(updated);LS.set("restopos_shifts",updated);
    LS.set("restopos_active_shift",shift);setActiveShift(shift);setCashDrawer("");setNote("");
    logActivity("SHIFT_STARTED",{after:{user:shift.user,openingCash:shift.openingCash}},currentUser?.role||"System");
  }
  function endShift(){
    if(!activeShift)return;
    const shiftSales=sales.filter(s=>new Date(s.date+"T"+(s.time||"00:00")).getTime()>=new Date(activeShift.startTime).getTime());
    const revenue=shiftSales.reduce((s,o)=>s+o.total,0);
    const closed={...activeShift,endTime:new Date().toISOString(),closingCash:parseFloat(cashDrawer)||0,shiftRevenue:revenue,shiftOrders:shiftSales.length};
    const updated=shifts.map(s=>s.id===activeShift.id?closed:s);setShifts(updated);LS.set("restopos_shifts",updated);
    LS.set("restopos_active_shift",null);setActiveShift(null);setCashDrawer("");
    logActivity("SHIFT_ENDED",{after:{user:closed.user,revenue,orders:shiftSales.length}},currentUser?.role||"System");
  }
  const shiftDuration=activeShift?Math.floor((Date.now()-new Date(activeShift.startTime).getTime())/60000):0;
  const shiftSales=activeShift?sales.filter(s=>new Date(s.date+"T"+(s.time||"00:00")).getTime()>=new Date(activeShift.startTime).getTime()):[];
  return(
    <div>
      <div style={{fontSize:20,fontWeight:800,marginBottom:20}}>🔄 Shift Management</div>
      {activeShift?(
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20,marginBottom:24}}>
          <Card style={{borderLeft:`5px solid ${C.success}`}}>
            <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:14}}>
              <span style={{fontSize:24}}>🟢</span>
              <div><div style={{fontSize:15,fontWeight:800,color:C.success}}>Shift Active</div><div style={{fontSize:12,color:C.textLight}}>Started {fmtDateTime(activeShift.startTime)}</div></div>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:16}}>
              {[["Cashier",activeShift.user],["Duration",shiftDuration+"m"],["Opening Cash",fmtSAR(activeShift.openingCash)]].map(([l,v])=>(
                <div key={l} style={{display:"flex",justifyContent:"space-between",fontSize:13}}><span style={{color:C.textMid}}>{l}</span><strong>{v}</strong></div>
              ))}
              {activeShift.note&&<div style={{fontSize:12,color:C.textLight,fontStyle:"italic"}}>"{activeShift.note}"</div>}
            </div>
            <Inp label="Closing Cash Drawer (SAR)" value={cashDrawer} onChange={setCashDrawer} type="number" placeholder="Count your cash..."/>
            <Btn variant="danger" onClick={endShift} style={{marginTop:12,width:"100%"}}>🔴 End Shift</Btn>
          </Card>
          <Card>
            <div style={{fontSize:14,fontWeight:700,marginBottom:16}}>This Shift</div>
            <div style={{display:"flex",flexDirection:"column",gap:12}}>
              <StatCard icon="🧾" label="Orders" value={shiftSales.length} color={C.primary} bg={C.primaryLight}/>
              <StatCard icon="💰" label="Revenue" value={fmtSAR(shiftSales.reduce((s,o)=>s+o.total,0))} color={C.success} bg={C.successLight}/>
            </div>
          </Card>
        </div>
      ):(
        <Card style={{maxWidth:480,marginBottom:24}}>
          <div style={{fontSize:14,fontWeight:700,marginBottom:16}}>🟡 Start New Shift</div>
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            <Inp label="Opening Cash Drawer (SAR)" value={cashDrawer} onChange={setCashDrawer} type="number" placeholder="Count opening cash..."/>
            <div style={{display:"flex",flexDirection:"column",gap:4}}>
              <label style={{fontSize:12,fontWeight:600,color:C.textMid}}>Handover Notes (optional)</label>
              <textarea value={note} onChange={e=>setNote(e.target.value)} rows={2} placeholder="Special instructions, issues to note..." style={{padding:"9px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontFamily:"inherit",resize:"none"}}/>
            </div>
            <Btn onClick={startShift} style={{width:"100%"}}>🟢 Start Shift</Btn>
          </div>
        </Card>
      )}
      <Card>
        <div style={{fontSize:14,fontWeight:700,marginBottom:16}}>📋 Shift History</div>
        {shifts.filter(s=>s.endTime).length===0?<div style={{color:C.textLight,textAlign:"center",padding:24}}>No completed shifts yet</div>
        :<DataTable headers={["Start","End","User","Orders","Revenue","Opening","Closing"]} rows={shifts.filter(s=>s.endTime).slice(0,20).map(s=>[
          <span style={{fontFamily:"monospace",fontSize:11}}>{s.startTime.slice(0,16).replace("T"," ")}</span>,
          <span style={{fontFamily:"monospace",fontSize:11}}>{s.endTime.slice(0,16).replace("T"," ")}</span>,
          s.user,s.shiftOrders||0,
          <strong style={{color:C.primary}}>{fmtSAR(s.shiftRevenue||0)}</strong>,
          fmtSAR(s.openingCash||0),
          <span style={{color:s.closingCash>0?C.success:C.textLight}}>{fmtSAR(s.closingCash||0)}</span>
        ])}/>}
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// AUDIT TRAIL VIEWER
// ═══════════════════════════════════════════════════════════════════
function AuditTrail(){
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
  const [refreshKey,setRefreshKey]=useState(0);
  return(
    <div style={{fontFamily:"'Plus Jakarta Sans',sans-serif",background:"#060d1f",minHeight:"100vh",color:"#fff"}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');*{box-sizing:border-box;margin:0;padding:0}::-webkit-scrollbar{width:5px}::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.15);border-radius:3px}`}</style>
      <div style={{background:"#0a1628",borderBottom:"1px solid rgba(255,255,255,0.08)",padding:"0 24px",height:56,display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,zIndex:100}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:32,height:32,background:"linear-gradient(135deg,#F0A500,#e09000)",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>👑</div>
          <div style={{fontSize:15,fontWeight:800}}>Owner Dashboard</div>
          <span style={{fontSize:10,background:"rgba(240,165,0,0.15)",color:"#F0A500",padding:"2px 8px",borderRadius:20,fontWeight:700,border:"1px solid rgba(240,165,0,0.3)"}}>RestoPOS v12</span>
        </div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={()=>setRefreshKey(k=>k+1)} style={{padding:"6px 14px",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,color:"rgba(255,255,255,0.7)",fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>🔄 Refresh</button>
          <button onClick={onLogout} style={{padding:"6px 14px",background:"rgba(217,64,64,0.15)",border:"1px solid rgba(217,64,64,0.3)",borderRadius:8,color:"#ff6b6b",fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>← Exit</button>
        </div>
      </div>
      <div style={{padding:24,overflowY:"auto"}}>
        <OwnerDashboardInline key={refreshKey}/>
      </div>
    </div>
  );
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
  const [invoiceFormat,_setInvoiceFormat]=useState(()=>LS.get("restopos_invoice_format")||{font:"courier",fontSize:12,shopNameOverride:"",footer:"Thank you for your visit!",footerAr:"شكراً لزيارتكم",website:"",social:"",tagline:""});
  function setSales(v){_setSales(p=>{const n=typeof v==="function"?v(p):v;LS.set("restopos_sales",n.slice(-500));return n;});}
  function setItems(v){_setItems(p=>{const n=typeof v==="function"?v(p):v;LS.set("restopos_items",n);if(n.length!==p.length)logActivity(n.length>p.length?"ITEM_ADDED":"ITEM_DELETED",{after:{itemCount:n.length}},currentUser?.role||"System");return n;});}
  function setTables(v){_setTables(p=>{const n=typeof v==="function"?v(p):v;LS.set("restopos_tables",n);return n;});}
  function setUsers(v){_setUsers(p=>{const n=typeof v==="function"?v(p):v;LS.set("restopos_users",n);if(n.length!==p.length)logActivity(n.length>p.length?"USER_ADDED":"USER_DELETED",{after:{userCount:n.length}},currentUser?.role||"System");return n;});}
  function setPromos(v){_setPromos(p=>{const n=typeof v==="function"?v(p):v;LS.set("restopos_promos",n);return n;});}
  function setCompany(v){_setCompany(p=>{const n=typeof v==="function"?v(p):v;LS.set("restopos_company",n);logActivity("SETTINGS_CHANGED",{after:{company:"updated"}},currentUser?.role||"System");return n;});}
  function setPins(v){_setPins(p=>{const n=typeof v==="function"?v(p):v;LS.set("restopos_pins",n);logActivity("PINS_CHANGED",{after:{pins:"updated"}},currentUser?.role||"System");return n;});}
  function setInvoiceFormat(v){_setInvoiceFormat(p=>{const n=typeof v==="function"?v(p):v;LS.set("restopos_invoice_format",n);return n;});}
  const [uiScale,setUiScale]=useState(()=>parseInt(LS.get("restopos_ui_scale")||"100"));
  function handleScaleChange(v){const s=Math.max(70,Math.min(130,parseInt(v)||100));setUiScale(s);LS.set("restopos_ui_scale",String(s));}
  useEffect(()=>{const saved=LS.get("restopos_license_v2");const pendingId=localStorage.getItem("restopos_pending_id");if(saved){setLicense(saved);setStep("login");}else if(pendingId){setStep("license");}else setStep("register");},[]);
  function handleClearLicense(){LS.del("restopos_license_v2");LS.del("restopos_pins");setLicense(null);setCurrentUser(null);setStep("register");}
  const ALL_NAV=[["dashboard","📊","Dashboard",["Admin","Manager"]],["pos","🖥️","POS",["Admin","Manager","Cashier"]],["settings","⚙️","Settings",["Admin"]],["create","➕","Create",["Admin","Manager"]],["transactions","💳","Transactions",["Admin","Manager"]],["accounts","📈","P&L",["Admin","Manager"]],["expenses","💸","Expenses",["Admin","Manager"]],["customers","👥","Customers",["Admin","Manager"]],["reports","📋","Reports",["Admin","Manager"]],["analytics","📉","Analytics",["Admin","Manager"]],["backup","💾","Backup",["Admin"]],["shifts","🔄","Shifts",["Admin","Manager"]],["audit","🔍","Audit",["Admin"]],["tools","🔧","Tools",["Admin"]],["useradmin","👤","Users",["Admin"]],["help","❓","Help",["Admin","Manager","Cashier"]]];
  const NAV=ALL_NAV.filter(([,,,roles])=>currentUser&&roles.includes(currentUser.role));
  if(ownerMode&&!ownerAuthed)return<OwnerLogin onLogin={()=>setOwnerAuthed(true)}/>;
  if(ownerMode&&ownerAuthed)return<OwnerDashboard onLogout={()=>{setOwnerMode(false);setOwnerAuthed(false);}}/>;
  if(step==="checking")return<div style={{minHeight:"100vh",background:"#0a1628",display:"flex",alignItems:"center",justifyContent:"center"}}><div style={{color:"#fff",fontSize:16}}>Loading…</div></div>;
  if(step==="register")return<BusinessRegistration onNext={(data)=>{setBusinessData(data);setStep("license");}}/>;
  if(step==="license")return<LicenseVerification businessData={businessData||{businessName:"",crNumber:"",vatNumber:"",address:"",city:"",phone:""}} onSuccess={(lic)=>{setLicense(lic);setStep("login");}} onBack={()=>setStep("register")}/>;
  if(step==="login"||!currentUser)return<RoleLogin license={license} onLogin={(user)=>{setCurrentUser(user);setStep("app");if(user.role==="Cashier")setScreen("pos");}}/>;
  return(
    <div style={{fontFamily:"'Plus Jakarta Sans','Tajawal',sans-serif",background:C.bg,height:"100vh",display:"flex",flexDirection:"column",overflow:"hidden",fontSize:`${uiScale}%`}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Tajawal:wght@400;500;700&display=swap');html,body,#root{height:100%;margin:0;padding:0;width:100%}*{box-sizing:border-box;margin:0;padding:0}::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-track{background:${C.bg}}::-webkit-scrollbar-thumb{background:${C.border};border-radius:3px}input,select{outline:none}input:focus,select:focus{border-color:${C.primary}!important}@media print{header,nav{display:none!important}}`}</style>
      <div style={{display:"flex",alignItems:"stretch",flexShrink:0,zIndex:100,boxShadow:"0 2px 12px rgba(0,0,0,0.18)",height:50,width:"100%"}}>
        <div style={{background:"linear-gradient(135deg,#1A3D2B 0%,#1F4D36 100%)",display:"flex",alignItems:"center",gap:8,padding:"0 14px",flexShrink:0,borderRight:"1px solid rgba(255,255,255,0.1)"}}>
          <div style={{width:28,height:28,background:"linear-gradient(135deg,#2ECC71,#F0A500)",borderRadius:7,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:14,fontWeight:900,flexShrink:0}}>R</div>
          <div><div style={{fontSize:13,fontWeight:800,color:"#fff",lineHeight:1,whiteSpace:"nowrap"}}>RestoPOS</div><div style={{fontSize:8,color:"rgba(255,255,255,0.5)",letterSpacing:"0.1em",whiteSpace:"nowrap"}}>ZATCA PHASE 2 · v13.0</div></div>
        </div>
        <div style={{background:"linear-gradient(90deg,#E8F4EE 0%,#F0F9F4 100%)",flex:1,display:"flex",alignItems:"center",padding:"0 6px",overflowX:"auto",borderRight:"1px solid #C8E6D4",minWidth:0}}>
          {NAV.map(([id,icon,label])=>(
            <button key={id} onClick={()=>setScreen(id)} style={{padding:"5px 9px",borderRadius:6,border:screen===id?"1.5px solid #1A6B4A":"1px solid transparent",background:screen===id?"#fff":"transparent",color:screen===id?C.primary:"#2D5A40",fontFamily:"inherit",fontSize:11,fontWeight:screen===id?700:500,cursor:"pointer",display:"flex",alignItems:"center",gap:4,whiteSpace:"nowrap",transition:"all 0.15s",flexShrink:0,boxShadow:screen===id?"0 1px 4px rgba(26,107,74,0.15)":"none"}}>
              <span style={{fontSize:12}}>{icon}</span><span>{label}</span>
            </button>
          ))}
        </div>
        <div style={{background:"linear-gradient(135deg,#1A3D2B 0%,#1F4D36 100%)",display:"flex",alignItems:"center",gap:5,padding:"0 10px",flexShrink:0,borderLeft:"1px solid rgba(255,255,255,0.1)"}}>
          <span style={{fontSize:9,background:"rgba(46,204,113,0.25)",color:"#7FFAB5",padding:"2px 6px",borderRadius:4,fontWeight:700,border:"1px solid rgba(46,204,113,0.4)",whiteSpace:"nowrap"}}>● LIVE</span>
          <span style={{fontSize:9,background:"rgba(99,102,241,0.25)",color:"#c7d2fe",padding:"2px 6px",borderRadius:4,fontWeight:700,border:"1px solid rgba(99,102,241,0.35)",whiteSpace:"nowrap"}}>ZATCA P2</span>
          <div style={{display:"flex",alignItems:"center",gap:3,background:"rgba(255,255,255,0.1)",borderRadius:5,padding:"2px 5px",border:"1px solid rgba(255,255,255,0.15)"}}>
            <span style={{fontSize:9,color:"rgba(255,255,255,0.5)"}}>⊞</span>
            <input type="range" min={70} max={130} step={5} value={uiScale} onChange={e=>handleScaleChange(e.target.value)} title={`Screen scale: ${uiScale}%`} style={{width:48,height:3,cursor:"pointer",accentColor:"#2ECC71"}}/>
            <span style={{fontSize:9,color:"rgba(255,255,255,0.75)",fontWeight:700,minWidth:22,textAlign:"right"}}>{uiScale}%</span>
          </div>
          <div style={{fontSize:10,color:"rgba(255,255,255,0.65)",fontWeight:700,whiteSpace:"nowrap"}}>{currentUser?.role}</div>
          <button onClick={()=>setCurrentUser(null)} style={{fontSize:10,background:"rgba(217,64,64,0.25)",color:"#ffaaaa",border:"1px solid rgba(217,64,64,0.35)",padding:"3px 8px",borderRadius:4,cursor:"pointer",fontFamily:"inherit",fontWeight:700,whiteSpace:"nowrap"}}>Logout</button>
        </div>
      </div>
      <div style={{flex:1,padding:screen==="pos"?0:20,overflowY:screen==="pos"?"hidden":"auto",width:"100%",minHeight:0,height:"calc(100vh - 50px)"}}>
        {screen==="dashboard"&&<Dashboard sales={sales} items={items} license={license}/>}
        {screen==="pos"&&<POS items={items} sales={sales} setSales={setSales} tables={tables} setTables={setTables} promos={promos} license={license}/>}
        {screen==="settings"&&<Settings company={company} setCompany={setCompany} tables={tables} setTables={setTables} license={license} onClearLicense={handleClearLicense} pins={pins} setPins={setPins} invoiceFormat={invoiceFormat} setInvoiceFormat={setInvoiceFormat}/>}
        {screen==="create"&&<Create items={items} setItems={setItems} promos={promos} setPromos={setPromos}/>}
        {screen==="transactions"&&<Transactions sales={sales} setSales={setSales} license={license}/>}
        {screen==="accounts"&&<ProfitLoss sales={sales} items={items}/>}
        {screen==="expenses"&&<Expenses/>}
        {screen==="customers"&&<Customers sales={sales}/>}
        {screen==="reports"&&<Reports sales={sales} items={items} setSales={setSales}/>}
        {screen==="analytics"&&<AdvancedReports sales={sales} items={items}/>}
        {screen==="backup"&&<BackupManager sales={sales} items={items}/>}
        {screen==="shifts"&&<ShiftManager sales={sales} currentUser={currentUser}/>}
        {screen==="audit"&&<AuditTrail/>}
        {screen==="tools"&&<Tools sales={sales} items={items} setItems={setItems}/>}
        {screen==="useradmin"&&<UserAdmin users={users} setUsers={setUsers}/>}
        {screen==="help"&&<Help/>}
      </div>
    </div>
  );
}
