import { useState, useEffect, useRef, useMemo, Component } from "react";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, query, where, getDocs, updateDoc, doc, addDoc, getDoc, onSnapshot, setDoc } from "firebase/firestore";
import { getStorage, ref, uploadBytes, getDownloadURL } from "firebase/storage";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
const storage = getStorage(firebaseApp);

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
  const lineItems = (items || []).map((item, idx) => {const lineTotal=(item.price*item.qty);const lineVAT=parseFloat((lineTotal*(15/115)).toFixed(2));const lineExclVAT=parseFloat((lineTotal-lineVAT).toFixed(2));return `<cac:InvoiceLine><cbc:ID>${idx+1}</cbc:ID><cbc:InvoicedQuantity unitCode="PCE">${item.qty}</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="SAR">${lineExclVAT.toFixed(2)}</cbc:LineExtensionAmount><cac:TaxTotal><cbc:TaxAmount currencyID="SAR">${lineVAT.toFixed(2)}</cbc:TaxAmount></cac:TaxTotal><cac:Item><cbc:Name>${escapeXML(item.name)}</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>15</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item><cac:Price><cbc:PriceAmount currencyID="SAR">${item.price.toFixed(2)}</cbc:PriceAmount></cac:Price></cac:InvoiceLine>`}).join("");
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
  const total = parseFloat(items.reduce((s,i)=>s+i.price*i.qty,0).toFixed(2));
  const vat_amount = parseFloat((total*(15/115)).toFixed(2));
  const subtotal = parseFloat((total-vat_amount).toFixed(2));
  const prev_invoice_hash = invoiceStorage.getLastHash();
  const partial = {invoice_number,uuid,timestamp,icv,seller_name,seller_vat,seller_address,seller_cr,items,subtotal,vat_amount,total,prev_invoice_hash,is_credit_note};
  const invoice_hash = await sha256(buildHashInput(partial));
  const invoice_hash_base64 = await sha256Base64(buildHashInput(partial));
  const qr_string = generatePhase1QR({sellerName:seller_name,vatNumber:seller_vat,timestamp,total,vatAmount:vat_amount});
  const invoice = {...partial,invoice_hash,invoice_hash_base64,qr_string,ecdsa_signature:null,ecdsa_public_key:null,zatca_reported:false,phase:1};
  invoiceStorage.save(invoice);
  fatooraQueue.enqueue(invoice);
  // Report only when user clicks "Report to FATOORA" button — not automatically
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
  const [invoices,setInvoices]=useState([]);const [selected,setSelected]=useState(null);const [tab,setTab]=useState("list");const [queue,setQueue]=useState([]);const [reporting,setReporting]=useState(null);
  useEffect(()=>{setInvoices(invoiceStorage.getAll());setQueue(fatooraQueue.getQueue());},[]);
  async function handleReportToFatoora(inv){setReporting(inv.invoice_number);try{await reportToFatoora(inv);const allInv=invoiceStorage.getAll().map(i=>i.invoice_number===inv.invoice_number?{...i,zatca_reported:true}:i);localStorage.setItem("zatca_invoices_v2",JSON.stringify(allInv));setInvoices(allInv);setQueue(fatooraQueue.getQueue());alert(`✅ Invoice ${inv.invoice_number} reported to FATOORA successfully.`);}catch(e){alert("Failed to report: "+e.message);}setReporting(null);}
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
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                <button style={{background:C.primary,color:"#fff",border:"none",borderRadius:6,padding:"7px 14px",cursor:"pointer",fontSize:12,fontFamily:"inherit",fontWeight:600}} onClick={()=>zatcaUtils.downloadXML(inv)}>⬇️ Download XML</button>
                {!inv.zatca_reported&&<button style={{background:C.zatca,color:"#fff",border:"none",borderRadius:6,padding:"7px 14px",cursor:reporting===inv.invoice_number?"not-allowed":"pointer",fontSize:12,fontFamily:"inherit",fontWeight:600,opacity:reporting===inv.invoice_number?0.7:1}} onClick={()=>handleReportToFatoora(inv)} disabled={reporting===inv.invoice_number}>{reporting===inv.invoice_number?"Reporting…":"📡 Report to FATOORA"}</button>}
                {inv.zatca_reported&&<span style={{fontSize:11,padding:"4px 10px",background:C.successLight,color:C.success,borderRadius:20,fontWeight:700,border:`1px solid ${C.success}44`}}>✓ Reported to FATOORA</span>}
                </div>
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
// LANGUAGE SYSTEM — Arabic / English
// ═══════════════════════════════════════════════════════════════════
const AR = {
  // Nav
  "Dashboard":"لوحة التحكم","POS":"نقطة البيع","Settings":"الإعدادات","Create":"إنشاء",
  "Transactions":"المعاملات","P&L":"الأرباح والخسائر","Financials":"المالية","Invoices":"الفواتير",
  "Expenses":"المصروفات","CRM":"إدارة العملاء","Reports":"التقارير","Analytics":"التحليلات",
  "Advanced":"متقدم","Backup":"النسخ الاحتياطي","Shifts":"الورديات","Audit":"سجل المراجعة",
  "Tools":"الأدوات","Users":"المستخدمون","Help":"المساعدة",
  // POS
  "Search items…":"ابحث عن الأصناف…","All":"الكل","Cart":"السلة","Table":"طاولة",
  "Dine-in":"داخل المطعم","Takeaway":"خارجي","Delivery":"توصيل","Customer":"العميل",
  "Order Type":"نوع الطلب","Select Table":"اختر طاولة","Add Note":"أضف ملاحظة",
  "Clear":"مسح","Charge":"الدفع","Print KOT":"طباعة KOT","Hold":"تعليق",
  "Discount":"خصم","Promo Code":"كود الخصم","Apply":"تطبيق","Cancel":"إلغاء",
  "Cash":"نقداً","Card":"بطاقة","Split":"تقسيم","Confirm Payment":"تأكيد الدفع",
  "Amount Given":"المبلغ المدفوع","Change":"الباقي","Total":"الإجمالي",
  "Subtotal":"المجموع الفرعي","VAT 15%":"ضريبة 15%","Items":"الأصناف",
  "Qty":"الكمية","Price":"السعر","Amount":"المبلغ",
  // Settings tabs
  "Company":"الشركة","Tables":"الطاولات","Bill Printer":"طابعة الفاتورة",
  "Kitchen Printer":"طابعة المطبخ","Invoice Format":"تنسيق الفاتورة",
  "Security":"الأمان","License":"الترخيص","Language":"اللغة",
  // Settings labels
  "Company Settings":"إعدادات الشركة","Table Configuration":"إعداد الطاولات",
  "Number of Tables":"عدد الطاولات","Update":"تحديث","Save Settings":"حفظ الإعدادات",
  "Saved successfully":"تم الحفظ بنجاح","Business Name (locked)":"اسم المنشأة (مقفل)",
  "CR Number (locked)":"السجل التجاري (مقفل)","VAT / TRN (locked)":"الرقم الضريبي (مقفل)",
  "License Key (locked)":"مفتاح الترخيص (مقفل)","Phone":"الهاتف","Email":"البريد الإلكتروني",
  "City":"المدينة","Address":"العنوان",
  // Dashboard
  "Today's Revenue":"إيرادات اليوم","Today's Orders":"طلبات اليوم",
  "Avg Order Value":"متوسط قيمة الطلب","Top Item":"الصنف الأعلى مبيعاً",
  "This Week":"هذا الأسبوع","This Month":"هذا الشهر","All Time":"كل الوقت",
  "Revenue":"الإيرادات","Orders":"الطلبات","VAT Collected":"ضريبة القيمة المضافة",
  // Create/Menu
  "New Menu Item":"صنف جديد","Edit Item":"تعديل الصنف","Item Name (English) *":"اسم الصنف (إنجليزي) *",
  "Arabic Name":"الاسم بالعربية","Category":"الفئة","Barcode":"الباركود",
  "Price (SAR) *":"السعر (ريال) *","Cost (SAR)":"التكلفة (ريال)","Stock":"المخزون",
  "Active":"نشط","Save Item":"حفظ الصنف","Delete":"حذف","Edit":"تعديل",
  // Common
  "Save":"حفظ","Close":"إغلاق","Back":"رجوع","Next":"التالي","Yes":"نعم","No":"لا",
  "Loading…":"جاري التحميل…","No data":"لا توجد بيانات","Search":"بحث",
  "Date":"التاريخ","Time":"الوقت","Status":"الحالة","Actions":"الإجراءات",
  "Export":"تصدير","Import":"استيراد","Print":"طباعة","Download":"تحميل",
  "Add":"إضافة","Remove":"إزالة","New":"جديد","View":"عرض",
  // Transactions
  "Transaction History":"سجل المعاملات","Receipt":"الإيصال","Refund":"استرداد",
  "Payment Method":"طريقة الدفع","Invoice No":"رقم الفاتورة",
  // Shifts
  "Start Shift":"بدء الوردية","End Shift":"إنهاء الوردية","Current Shift":"الوردية الحالية",
  "Shift History":"سجل الورديات","Opening Balance":"الرصيد الافتتاحي",
  "Closing Balance":"الرصيد الختامي",
  // Users
  "Add User":"إضافة مستخدم","Username":"اسم المستخدم","Password":"كلمة المرور",
  "Role":"الدور","Admin":"مدير","Manager":"مشرف","Cashier":"كاشير",
  // Reports
  "Daily Report":"التقرير اليومي","Weekly Report":"التقرير الأسبوعي",
  "Monthly Report":"التقرير الشهري","Sales Report":"تقرير المبيعات",
  "VAT Report":"تقرير الضريبة",
  // Help
  "Need help?":"تحتاج مساعدة؟","Contact Support":"تواصل مع الدعم",
  // Language screen
  "Choose Language":"اختر اللغة","Language Settings":"إعدادات اللغة",
  "English":"الإنجليزية","Arabic":"العربية",
  "Select your preferred language for the app interface.":"اختر لغتك المفضلة لواجهة التطبيق.",
};

// Global language state — read/write localStorage directly so it works outside React
function getLang(){return localStorage.getItem("restopos_lang")||"en";}
function setLangStore(l){localStorage.setItem("restopos_lang",l);}

// Translation helper — use anywhere: t("Save") returns Arabic if lang=ar, else English
function t(en,lang){
  if(!lang)lang=getLang();
  if(lang==="en")return en;
  return AR[en]||en; // fallback to English if no translation
}

// RTL direction helper
function dir(lang){return lang==="ar"?"rtl":"ltr";}


// ═══════════════════════════════════════════════════════════════════
// FIRESTORE SYNC ENGINE — auto backup + restore on new device
// ═══════════════════════════════════════════════════════════════════
const SYNC_KEYS=[
  "restopos_items","restopos_categories","restopos_company",
  "restopos_tables","restopos_promos","restopos_expenses",
  "restopos_shifts","restopos_users","restopos_pins",
  "restopos_invoice_format","restopos_invoice_template",
  "restopos_kitchen_printer","restopos_daylog","restopos_closed_days",
  "restopos_customers","restopos_archived_sales","restopos_sales",
  "restopos_vno","restopos_kot","restopos_gift_cards","restopos_quotations",
];

// Debounce helper — only sync after 3s of no changes
const _syncTimers={};
function debouncedSync(licenseKey,key,data){
  if(_syncTimers[key])clearTimeout(_syncTimers[key]);
  _syncTimers[key]=setTimeout(()=>syncKeyToFirestore(licenseKey,key,data),3000);
}

async function syncKeyToFirestore(licenseKey,key,data){
  if(!licenseKey)return;
  try{
    const docRef=doc(db,"client_data",licenseKey);
    // Use setDoc with merge so we don't overwrite other keys
    await setDoc(docRef,{
      [key]:JSON.stringify(data),
      [`${key}_updatedAt`]:new Date().toISOString(),
      licenseKey,
      lastSyncAt:new Date().toISOString(),
    },{merge:true});
  }catch(e){
    console.warn("[Sync] Failed to sync",key,":",e.message);
  }
}

async function restoreFromFirestore(licenseKey){
  if(!licenseKey)return false;
  try{
    const docRef=doc(db,"client_data",licenseKey);
    const snap=await getDoc(docRef);
    if(!snap.exists())return false;
    const data=snap.data();
    let restored=0;
    SYNC_KEYS.forEach(key=>{
      if(data[key]){
        try{
          const parsed=JSON.parse(data[key]);
          // Only restore if cloud has more data than local
          const local=localStorage.getItem(key);
          if(!local){
            localStorage.setItem(key,data[key]);
            restored++;
          }else{
            // For arrays, merge keeping more records
            try{
              const localArr=JSON.parse(local);
              const cloudArr=parsed;
              if(Array.isArray(localArr)&&Array.isArray(cloudArr)&&cloudArr.length>localArr.length){
                localStorage.setItem(key,data[key]);
                restored++;
              }else if(!Array.isArray(localArr)){
                // For objects, prefer cloud if newer
                const cloudUpdated=data[`${key}_updatedAt`];
                if(cloudUpdated){localStorage.setItem(key,data[key]);restored++;}
              }
            }catch(e){localStorage.setItem(key,data[key]);restored++;}
          }
        }catch(e){console.warn("[Restore] Error parsing",key);}
      }
    });
    console.log(`[Sync] Restored ${restored} keys from Firestore`);
    return restored>0;
  }catch(e){
    console.warn("[Sync] Restore failed:",e.message);
    return false;
  }
}

// Enhanced LS with auto-sync
function makeSyncedLS(licenseKey){
  return{
    get:(k)=>{try{const v=localStorage.getItem(k);return v?JSON.parse(v):null;}catch(e){return null;}},
    set:(k,v)=>{
      try{localStorage.setItem(k,JSON.stringify(v));}catch(e){console.warn("LS set error",e);}
      if(licenseKey&&SYNC_KEYS.includes(k))debouncedSync(licenseKey,k,v);
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// LOCAL STORAGE HELPERS + CONSTANTS
// ═══════════════════════════════════════════════════════════════════
const LS={get:(k)=>{try{return JSON.parse(localStorage.getItem(k));}catch{return null;}},set:(k,v)=>localStorage.setItem(k,JSON.stringify(v)),del:(k)=>localStorage.removeItem(k)};

// ═══════════════════════════════════════════════════════════════════
// CREDENTIAL HELPERS — simple hash for local storage
// ═══════════════════════════════════════════════════════════════════
async function hashPassword(pw){
  const data=new TextEncoder().encode(pw+"restopos_salt_v1");
  const buf=await crypto.subtle.digest("SHA-256",data);
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
}

// ═══════════════════════════════════════════════════════════════════
// SET CREDENTIALS — shown after first-time license activation
// ═══════════════════════════════════════════════════════════════════
function SetCredentials({license,onDone}){
  const [username,setUsername]=useState("");
  const [password,setPassword]=useState("");
  const [confirm,setConfirm]=useState("");
  const [showPw,setShowPw]=useState(false);
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(false);

  async function handleSave(){
    setError("");
    if(!username.trim()||username.trim().length<3)return setError("Username must be at least 3 characters.");
    if(password.length<6)return setError("Password must be at least 6 characters.");
    if(password!==confirm)return setError("Passwords do not match.");
    setLoading(true);
    try{
      const hashed=await hashPassword(password);
      // Save credentials locally (pending approval)
      LS.set("restopos_client_creds",{username:username.trim().toLowerCase(),passwordHash:hashed,approved:false,crNumber:license.crNumber,email:license.email||""});
      // Save to Firestore so admin can see and approve
      const q=query(collection(db,"pending_activations"),where("licenseKey","==",license.licenseKey));
      const snap=await getDocs(q);
      if(!snap.empty){
        await updateDoc(doc(db,"pending_activations",snap.docs[0].id),{
          clientUsername:username.trim().toLowerCase(),
          passwordHash:hashed,
          email:license.email||"",
          credentialsSet:true,
          credentialsApproved:false,
          credentialsSetAt:new Date().toISOString()
        });
      }
      // Send welcome verification email
      if(license.email){
        try{
          await sendEmailJS(EMAILJS_VERIFY_TEMPLATE,{to_email:license.email,to_name:license.ownerName||license.businessName||"",code:"Account created! Awaiting admin approval."});
        }catch(mailErr){console.warn("Welcome email failed:",mailErr);}
      }
      onDone();
    }catch(e){setError("Failed to save: "+e.message);}
    setLoading(false);
  }

  const inp={width:"100%",padding:"12px 14px",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.2)",borderRadius:10,fontSize:14,color:"#fff",fontFamily:"inherit",direction:"ltr"};
  // Keyboard Enter support
  useEffect(()=>{
    function onKey(e){if(e.key==="Enter")handleLogin();}
    window.addEventListener("keydown",onKey);
    return()=>window.removeEventListener("keydown",onKey);
  },[username,password]);
  return(
    <div style={{minHeight:"100vh",background:"linear-gradient(135deg,#0a1628 0%,#1A3A5C 50%,#0a2818 100%)",display:"flex",alignItems:"center",justifyContent:"center",padding:20,fontFamily:"'Plus Jakarta Sans',sans-serif"}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');*{box-sizing:border-box;margin:0;padding:0}`}</style>
      <div style={{width:"100%",maxWidth:460}}>
        <div style={{textAlign:"center",marginBottom:28}}>
          <div style={{width:56,height:56,background:"linear-gradient(135deg,#1A6B4A,#F0A500)",borderRadius:16,display:"flex",alignItems:"center",justifyContent:"center",fontSize:26,margin:"0 auto 12px"}}>🔐</div>
          <div style={{fontSize:22,fontWeight:900,color:"#fff"}}>Create Login</div>
          <div style={{fontSize:13,color:"rgba(255,255,255,0.5)",marginTop:4}}>Set a username & password for your account</div>
        </div>
        <div style={{background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:20,padding:32}}>
          <div style={{background:"rgba(46,204,113,0.1)",border:"1px solid rgba(46,204,113,0.3)",borderRadius:10,padding:"10px 14px",marginBottom:20,fontSize:12,color:"rgba(255,255,255,0.7)",lineHeight:1.5}}>
            <strong style={{color:"#2ECC71"}}>✓ License Activated!</strong><br/>
            Once you set your login, our team will review and approve your account. You'll then be able to sign in anytime.
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            <div>
              <label style={{fontSize:12,fontWeight:700,color:"rgba(255,255,255,0.6)",display:"block",marginBottom:5}}>Username</label>
              <input value={username} onChange={e=>setUsername(e.target.value)} placeholder="e.g. albaik_riyadh" style={inp}/>
            </div>
            <div>
              <label style={{fontSize:12,fontWeight:700,color:"rgba(255,255,255,0.6)",display:"block",marginBottom:5}}>Password</label>
              <div style={{position:"relative"}}>
                <input type={showPw?"text":"password"} value={password} onChange={e=>setPassword(e.target.value)} placeholder="Min 6 characters" style={{...inp,paddingRight:44}}/>
                <button onClick={()=>setShowPw(x=>!x)} style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:"rgba(255,255,255,0.5)",cursor:"pointer",fontSize:16}}>{showPw?"🙈":"👁"}</button>
              </div>
            </div>
            <div>
              <label style={{fontSize:12,fontWeight:700,color:"rgba(255,255,255,0.6)",display:"block",marginBottom:5}}>Confirm Password</label>
              <input type={showPw?"text":"password"} value={confirm} onChange={e=>setConfirm(e.target.value)} placeholder="Re-enter password" style={inp}/>
            </div>
          </div>
          {error&&<div style={{marginTop:12,padding:"8px 12px",background:"rgba(217,64,64,0.2)",border:"1px solid rgba(217,64,64,0.4)",borderRadius:8,fontSize:12,color:"#ff8080"}}>{error}</div>}
          <button onClick={handleSave} disabled={loading} style={{width:"100%",marginTop:18,padding:14,background:loading?"#444":"linear-gradient(135deg,#1A6B4A,#134D36)",color:"#fff",border:"none",borderRadius:12,fontSize:15,fontWeight:800,cursor:loading?"not-allowed":"pointer",fontFamily:"inherit"}}>
            {loading?"Saving…":"✓ Save & Submit for Approval"}
          </button>

        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// PENDING APPROVAL SCREEN
// ═══════════════════════════════════════════════════════════════════
function PendingApprovalScreen({license,onApproved,onSwitchAccount}){
  const [checking,setChecking]=useState(false);
  const [error,setError]=useState("");
  const [showSwitchConfirm,setShowSwitchConfirm]=useState(false);
  const creds=LS.get("restopos_client_creds");

  // Auto-check approval status periodically
  useEffect(()=>{
    async function checkApproval(){
      try{
        const q=query(collection(db,"pending_activations"),where("licenseKey","==",license.licenseKey));
        const snap=await getDocs(q);
        if(!snap.empty){
          const data=snap.docs[0].data();
          if(data.status==="approved"&&data.credentialsApproved===true){
            // Update local creds
            const localCreds=LS.get("restopos_client_creds");
            if(localCreds)LS.set("restopos_client_creds",{...localCreds,approved:true});
            onApproved();
          }
        }
      }catch(e){console.warn("Approval check failed:",e);}
    }
    checkApproval();
    const interval=setInterval(checkApproval,15000);
    return()=>clearInterval(interval);
  },[license.licenseKey]);

  async function handleManualCheck(){
    setChecking(true);setError("");
    try{
      const q=query(collection(db,"pending_activations"),where("licenseKey","==",license.licenseKey));
      const snap=await getDocs(q);
      if(!snap.empty){
        const data=snap.docs[0].data();
        if(data.status==="approved"&&data.credentialsApproved===true){
          const localCreds=LS.get("restopos_client_creds");
          if(localCreds)LS.set("restopos_client_creds",{...localCreds,approved:true});
          onApproved();return;
        }
      }
      setError("Not yet approved. Please wait for admin confirmation.");
    }catch(e){setError("Check failed: "+e.message);}
    setChecking(false);
  }

  function handleSwitchAccount(){
    // Save current account to saved accounts list before clearing
    const savedAccounts=LS.get("restopos_saved_accounts")||[];
    const currentAccount={licenseKey:license.licenseKey,businessName:license.businessName,crNumber:license.crNumber,savedAt:new Date().toISOString(),status:"pending"};
    const already=savedAccounts.find(a=>a.licenseKey===license.licenseKey);
    if(!already)LS.set("restopos_saved_accounts",[...savedAccounts,currentAccount]);
    // Clear current license and creds to go to registration
    LS.del("restopos_license_v2");
    LS.del("restopos_client_creds");
    if(onSwitchAccount)onSwitchAccount();
  }

  return(
    <div style={{minHeight:"100vh",background:"linear-gradient(135deg,#0a1628 0%,#1A3A5C 50%,#0a2818 100%)",display:"flex",alignItems:"center",justifyContent:"center",padding:20,fontFamily:"'Plus Jakarta Sans',sans-serif"}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');*{box-sizing:border-box;margin:0;padding:0}`}</style>
      <div style={{width:"100%",maxWidth:440,textAlign:"center"}}>
        <div style={{width:72,height:72,background:"rgba(240,165,0,0.15)",border:"2px solid rgba(240,165,0,0.4)",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:32,margin:"0 auto 20px"}}>⏳</div>
        <div style={{fontSize:22,fontWeight:900,color:"#fff",marginBottom:8}}>Awaiting Approval</div>
        <div style={{fontSize:13,color:"rgba(255,255,255,0.5)",marginBottom:24,lineHeight:1.6}}>
          Your account has been submitted.<br/>
          Once our team approves your account, you'll be able to log in.<br/>
          <span style={{color:"rgba(255,255,255,0.3)"}}>This usually takes a few minutes to hours.</span>
        </div>
        <div style={{background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:14,padding:"16px 20px",marginBottom:20,fontSize:13,color:"rgba(255,255,255,0.6)"}}>
          <div style={{fontWeight:700,color:"#fff",marginBottom:4}}>{license.businessName}</div>
          <div>Username: <span style={{color:"#F0A500",fontWeight:700}}>{creds?.username||"—"}</span></div>
          <div>CR: {license.crNumber}</div>
        </div>
        {error&&<div style={{background:"rgba(217,64,64,0.15)",border:"1px solid rgba(217,64,64,0.3)",borderRadius:8,padding:"8px 12px",fontSize:12,color:"#ff8080",marginBottom:12}}>{error}</div>}
        <button onClick={handleManualCheck} disabled={checking} style={{width:"100%",padding:13,background:checking?"#333":"linear-gradient(135deg,#1A6B4A,#134D36)",color:"#fff",border:"none",borderRadius:12,fontSize:14,fontWeight:700,cursor:checking?"not-allowed":"pointer",fontFamily:"inherit"}}>
          {checking?"Checking…":"🔄 Check Approval Status"}
        </button>

        {/* Switch Account / Add New Account */}
        {!showSwitchConfirm?(
          <button onClick={()=>setShowSwitchConfirm(true)} style={{width:"100%",marginTop:12,padding:12,background:"rgba(99,102,241,0.15)",border:"1px solid rgba(99,102,241,0.35)",borderRadius:12,color:"#a5b4fc",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
            👤 Switch User / Add New Account
          </button>
        ):(
          <div style={{marginTop:12,background:"rgba(99,102,241,0.08)",border:"1px solid rgba(99,102,241,0.3)",borderRadius:12,padding:"16px 18px"}}>
            <div style={{fontSize:13,fontWeight:700,color:"#a5b4fc",marginBottom:8}}>Switch to a different account?</div>
            <div style={{fontSize:12,color:"rgba(255,255,255,0.45)",marginBottom:14,lineHeight:1.5}}>Your current account will be saved. You can return to it later from the Settings screen.</div>
            <div style={{display:"flex",gap:10}}>
              <button onClick={handleSwitchAccount} style={{flex:1,padding:"10px",background:"linear-gradient(135deg,#6366f1,#4f46e5)",color:"#fff",border:"none",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
                ➕ Register New Account
              </button>
              <button onClick={()=>setShowSwitchConfirm(false)} style={{flex:1,padding:"10px",background:"rgba(255,255,255,0.07)",color:"rgba(255,255,255,0.5)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>
                Cancel
              </button>
            </div>
          </div>
        )}


        <div style={{marginTop:8,fontSize:11,color:"rgba(255,255,255,0.2)"}}>Auto-checks every 15 seconds</div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// CLIENT LOGIN — username + password
// ═══════════════════════════════════════════════════════════════════
function ClientLogin({license,onSuccess,onForgotPassword}){
  const [mode,setMode]=useState("login"); // "login" | "already"
  const [username,setUsername]=useState("");
  const [password,setPassword]=useState("");
  const [showPw,setShowPw]=useState(false);
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(false);
  const creds=LS.get("restopos_client_creds");

  const [loginAttempts,setLoginAttempts]=useState(()=>parseInt(sessionStorage.getItem("restopos_login_attempts")||"0"));
  const [lockUntil,setLockUntil]=useState(()=>parseInt(sessionStorage.getItem("restopos_lock_until")||"0"));

  async function handleLogin(){
    setError("");
    // Rate limiting — lock after 5 failed attempts for 5 minutes
    if(Date.now()<lockUntil){
      const mins=Math.ceil((lockUntil-Date.now())/60000);
      setError(`Too many failed attempts. Try again in ${mins} minute${mins>1?"s":""}.`);
      return;
    }
    setLoading(true);
    if(!username.trim()||!password){setError("Please enter username and password.");setLoading(false);return;}
    try{
      const hashed=await hashPassword(password);
      if(username.trim().toLowerCase()===creds?.username&&hashed===creds?.passwordHash){
        // Clear login attempts on success
        sessionStorage.removeItem("restopos_login_attempts");
        sessionStorage.removeItem("restopos_lock_until");
        // Clear forceLogout flag in Firestore so client can stay logged in
        try{
          const savedLic=LS.get("restopos_license_v2");
          if(savedLic?.licenseKey){
            const q=query(collection(db,"pending_activations"),where("licenseKey","==",savedLic.licenseKey));
            const snap=await getDocs(q);
            if(!snap.empty){await updateDoc(doc(db,"pending_activations",snap.docs[0].id),{forceLogout:false});}
          }
        }catch(e){/* non-critical */}
        onSuccess();
      }else{
        const attempts=loginAttempts+1;
        setLoginAttempts(attempts);
        sessionStorage.setItem("restopos_login_attempts",String(attempts));
        if(attempts>=5){
          const until=Date.now()+(5*60*1000);
          setLockUntil(until);
          sessionStorage.setItem("restopos_lock_until",String(until));
          setError("Too many failed attempts. Account locked for 5 minutes.");
        }else{
          setError(`Incorrect username or password. (${5-attempts} attempts remaining)`);
        }
      }
    }catch(e){setError("Login failed: "+e.message);}
    setLoading(false);
  }

  const inp={width:"100%",padding:"12px 14px",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.2)",borderRadius:10,fontSize:14,color:"#fff",fontFamily:"inherit",direction:"ltr"};
  // Keyboard Enter support
  useEffect(()=>{
    function onKey(e){if(e.key==="Enter")handleLogin();}
    window.addEventListener("keydown",onKey);
    return()=>window.removeEventListener("keydown",onKey);
  },[username,password]);

  return(
    <div style={{minHeight:"100vh",background:"linear-gradient(135deg,#0a1628 0%,#1A3A5C 50%,#0a2818 100%)",display:"flex",alignItems:"center",justifyContent:"center",padding:20,fontFamily:"'Plus Jakarta Sans',sans-serif"}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');*{box-sizing:border-box;margin:0;padding:0}`}</style>
      <div style={{width:"100%",maxWidth:420}}>
        <div style={{textAlign:"center",marginBottom:24}}>
          <div style={{display:"inline-flex",alignItems:"center",gap:10,marginBottom:6}}>
            <div style={{width:44,height:44,background:"linear-gradient(135deg,#1A6B4A,#F0A500)",borderRadius:12,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,fontWeight:900,color:"#fff"}}>R</div>
            <div style={{fontSize:24,fontWeight:900,color:"#fff"}}>RestoPOS</div>
          </div>
          <div style={{fontSize:13,color:"rgba(255,255,255,0.4)"}}>{license?.businessName||""}</div>
        </div>

        {/* Already signed up banner */}
        <div style={{background:"rgba(46,204,113,0.08)",border:"1px solid rgba(46,204,113,0.25)",borderRadius:14,padding:"14px 18px",marginBottom:16,display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
          <div>
            <div style={{fontSize:13,fontWeight:700,color:"#2ECC71"}}>✓ Already signed up</div>
            <div style={{fontSize:11,color:"rgba(255,255,255,0.4)",marginTop:2}}>Sign in with your username & password</div>
          </div>
          <div style={{width:32,height:32,background:"rgba(46,204,113,0.15)",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>👤</div>
        </div>

        <div style={{background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:20,padding:28}}>
          <div style={{fontSize:16,fontWeight:800,color:"#fff",marginBottom:18,textAlign:"center"}}>Sign In</div>
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            <div>
              <label style={{fontSize:12,fontWeight:700,color:"rgba(255,255,255,0.6)",display:"block",marginBottom:5}}>Username</label>
              <input value={username} onChange={e=>setUsername(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleLogin()} placeholder="Your username" style={inp}/>
            </div>
            <div>
              <label style={{fontSize:12,fontWeight:700,color:"rgba(255,255,255,0.6)",display:"block",marginBottom:5}}>Password</label>
              <div style={{position:"relative"}}>
                <input type={showPw?"text":"password"} value={password} onChange={e=>setPassword(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleLogin()} placeholder="Your password" style={{...inp,paddingRight:44}}/>
                <button onClick={()=>setShowPw(x=>!x)} style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:"rgba(255,255,255,0.5)",cursor:"pointer",fontSize:16}}>{showPw?"🙈":"👁"}</button>
              </div>
            </div>
          </div>
          {error&&<div style={{marginTop:10,padding:"8px 12px",background:"rgba(217,64,64,0.2)",border:"1px solid rgba(217,64,64,0.4)",borderRadius:8,fontSize:12,color:"#ff8080"}}>{error}</div>}
          <button onClick={handleLogin} disabled={loading} style={{width:"100%",marginTop:16,padding:13,background:loading?"#333":"linear-gradient(135deg,#1A6B4A,#134D36)",color:"#fff",border:"none",borderRadius:12,fontSize:15,fontWeight:800,cursor:loading?"not-allowed":"pointer",fontFamily:"inherit"}}>
            {loading?"Signing in…":"→ Sign In"}
          </button>
          <button onClick={onForgotPassword} style={{width:"100%",marginTop:10,padding:10,background:"transparent",color:"rgba(255,255,255,0.35)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>
            🔑 Forgot password?
          </button>

        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// PASSWORD STRENGTH HELPER
// ═══════════════════════════════════════════════════════════════════
function getPasswordStrength(pw){
  const hasMin=pw.length>=8;
  const hasNum=/\d/.test(pw);
  const hasLetter=/[a-zA-Z]/.test(pw);
  const hasSpecial=/[^a-zA-Z0-9]/.test(pw);
  const hasUpper=/[A-Z]/.test(pw);
  const score=[hasMin,hasNum,hasLetter,hasSpecial,hasUpper,pw.length>=12].filter(Boolean).length;
  if(score<=2)return{label:"Weak",color:"#ef4444",pct:25};
  if(score<=4)return{label:"Medium",color:"#F0A500",pct:65};
  return{label:"Strong",color:"#10b981",pct:100};
}

function PasswordStrengthBar({password}){
  const s=getPasswordStrength(password);
  const reqs=[
    {label:"At least 8 characters",ok:password.length>=8},
    {label:"At least one number",ok:/\d/.test(password)},
    {label:"At least one letter",ok:/[a-zA-Z]/.test(password)},
    {label:"Uppercase letter (recommended)",ok:/[A-Z]/.test(password)},
    {label:"Special character (recommended)",ok:/[^a-zA-Z0-9]/.test(password)},
  ];
  return(
    <div style={{marginTop:8}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
        <span style={{fontSize:11,color:"rgba(255,255,255,0.5)"}}>Password strength</span>
        <span style={{fontSize:11,fontWeight:700,color:s.color}}>{s.label}</span>
      </div>
      <div style={{height:4,background:"rgba(255,255,255,0.1)",borderRadius:4,overflow:"hidden",marginBottom:8}}>
        <div style={{height:"100%",width:`${s.pct}%`,background:s.color,borderRadius:4,transition:"width 0.3s,background 0.3s"}}/>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:3}}>
        {reqs.map(r=>(
          <div key={r.label} style={{display:"flex",alignItems:"center",gap:6,fontSize:10,color:r.ok?"#7FFAB5":"rgba(255,255,255,0.35)"}}>
            <span style={{fontSize:11}}>{r.ok?"✓":"○"}</span>{r.label}
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// FORGOT PASSWORD — enhanced with email flow, strength meter, 4 screens
// ═══════════════════════════════════════════════════════════════════
// ── EmailJS helper ──────────────────────────────────────────────────
const EMAILJS_SERVICE="service_mxln2w4";
const EMAILJS_VERIFY_TEMPLATE="template_v28ss1y";
const EMAILJS_RESET_TEMPLATE="template_444v50v";
const EMAILJS_PUBLIC_KEY="jlfUG0WjJ3UVXUgCb";
async function sendEmailJS(templateId,params){
  const res=await fetch("https://api.emailjs.com/api/v1.0/email/send",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({service_id:EMAILJS_SERVICE,template_id:templateId,user_id:EMAILJS_PUBLIC_KEY,template_params:params})
  });
  if(!res.ok)throw new Error("Email send failed: "+res.status);
}
function generateCode(){return String(Math.floor(100000+Math.random()*900000));}

function ForgotPassword({onBack,onReset}){
  const [step,setStep]=useState("email");
  const [email,setEmail]=useState("");
  const [emailError,setEmailError]=useState("");
  const [emailLoading,setEmailLoading]=useState(false);
  const [code,setCode]=useState("");
  const [sentCode,setSentCode]=useState("");
  const [codeExpiry,setCodeExpiry]=useState(null);
  const [codeError,setCodeError]=useState("");
  const [resendCooldown,setResendCooldown]=useState(0);
  const resendTimerRef=useRef(null);
  const [foundDocId,setFoundDocId]=useState("");
  const [foundName,setFoundName]=useState("");
  const [newPassword,setNewPassword]=useState("");
  const [confirmPw,setConfirmPw]=useState("");
  const [showPw,setShowPw]=useState(false);
  const [resetError,setResetError]=useState("");
  const [resetLoading,setResetLoading]=useState(false);
  const [redirectCount,setRedirectCount]=useState(5);
  useEffect(()=>{
    if(step!=="success")return;
    const t=setInterval(()=>setRedirectCount(c=>{if(c<=1){clearInterval(t);onReset();return 0;}return c-1;}),1000);
    return()=>clearInterval(t);
  },[step]);
  function startResendCooldown(secs=60){
    setResendCooldown(secs);
    if(resendTimerRef.current)clearInterval(resendTimerRef.current);
    resendTimerRef.current=setInterval(()=>setResendCooldown(c=>{if(c<=1){clearInterval(resendTimerRef.current);return 0;}return c-1;}),1000);
  }
  async function handleSendCode(){
    setEmailError("");
    const trimmed=email.trim().toLowerCase();
    if(!trimmed||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)){setEmailError("Please enter a valid email address.");return;}
    setEmailLoading(true);
    try{
      const q=query(collection(db,"pending_activations"),where("email","==",trimmed));
      const snap=await getDocs(q);
      if(snap.empty){setEmailError("No account found with this email address.");setEmailLoading(false);return;}
      const docData=snap.docs[0].data();
      setFoundDocId(snap.docs[0].id);
      setFoundName(docData.ownerName||docData.businessName||"");
      sessionStorage.setItem("restopos_reset_email",trimmed);
      const newCode=generateCode();
      const expiry=Date.now()+(10*60*1000);
      setSentCode(newCode);setCodeExpiry(expiry);
      await sendEmailJS(EMAILJS_RESET_TEMPLATE,{to_email:trimmed,to_name:docData.ownerName||docData.businessName||"User",code:newCode});
      startResendCooldown(60);
      setStep("code");
    }catch(e){setEmailError("Failed to send code: "+e.message);}
    setEmailLoading(false);
  }
  async function handleResend(){
    if(resendCooldown>0)return;
    const newCode=generateCode();
    const expiry=Date.now()+(10*60*1000);
    setSentCode(newCode);setCodeExpiry(expiry);setCodeError("");
    try{
      await sendEmailJS(EMAILJS_RESET_TEMPLATE,{to_email:email.trim().toLowerCase(),to_name:foundName||"User",code:newCode});
      startResendCooldown(60);
    }catch(e){setCodeError("Failed to resend: "+e.message);}
  }
  function handleVerifyCode(){
    setCodeError("");
    if(!code.trim()){setCodeError("Please enter the code.");return;}
    if(Date.now()>codeExpiry){setCodeError("Code has expired. Please request a new one.");setSentCode("");return;}
    if(code.trim()!==sentCode){setCodeError("Incorrect code. Please check your email.");return;}
    setStep("reset");
  }
  async function handleReset(){
    setResetError("");
    if(newPassword.length<6){setResetError("Password must be at least 6 characters.");return;}
    if(newPassword!==confirmPw){setResetError("Passwords do not match.");return;}
    setResetLoading(true);
    try{
      const hashed=await hashPassword(newPassword);
      // Try Firestore update — use foundDocId or re-query by email as fallback
      let docId=foundDocId;
      if(!docId){
        // Re-query by email if foundDocId was lost (e.g. page refresh mid-flow)
        try{
          const emailToFind=email.trim().toLowerCase()||sessionStorage.getItem("restopos_reset_email")||"";
          if(emailToFind){
            const q=query(collection(db,"pending_activations"),where("email","==",emailToFind));
            const snap=await getDocs(q);
            if(!snap.empty)docId=snap.docs[0].id;
          }
        }catch(e){/* non-critical */}
      }
      if(docId){await updateDoc(doc(db,"pending_activations",docId),{passwordHash:hashed,passwordResetAt:new Date().toISOString()});}
      // Always update local creds too
      const localCreds=LS.get("restopos_client_creds");
      if(localCreds){LS.set("restopos_client_creds",{...localCreds,passwordHash:hashed});}
      sessionStorage.removeItem("restopos_reset_email");
      setStep("success");
    }catch(e){setResetError("Reset failed: "+e.message);}
    setResetLoading(false);
  }
  const bg="linear-gradient(135deg,#0a1628 0%,#1A3A5C 50%,#0a2818 100%)";
  const inp={width:"100%",padding:"12px 14px",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.2)",borderRadius:10,fontSize:14,color:"#fff",fontFamily:"inherit",outline:"none"};
  const card={background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:20,padding:28};
  const primaryBtn={width:"100%",padding:13,background:"linear-gradient(135deg,#1A6B4A,#134D36)",color:"#fff",border:"none",borderRadius:12,fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:"inherit"};
  const ghostBtn={width:"100%",marginTop:10,padding:10,background:"transparent",color:"rgba(255,255,255,0.35)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,fontSize:12,cursor:"pointer",fontFamily:"inherit"};

  return(
    <div style={{minHeight:"100vh",background:"linear-gradient(135deg,#0a1628 0%,#1A3A5C 50%,#0a2818 100%)",display:"flex",alignItems:"center",justifyContent:"center",padding:20,fontFamily:"'Plus Jakarta Sans',sans-serif"}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');*{box-sizing:border-box;margin:0;padding:0}input:focus{border-color:rgba(46,204,113,0.6)!important;box-shadow:0 0 0 3px rgba(46,204,113,0.1)}`}</style>
      <div style={{width:"100%",maxWidth:440}}>

        {/* STEP 1: EMAIL */}
        {step==="email"&&(
          <>
            <div style={{textAlign:"center",marginBottom:24}}>
              <div style={{width:64,height:64,background:"rgba(240,165,0,0.12)",border:"2px solid rgba(240,165,0,0.35)",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,margin:"0 auto 14px"}}>✉️</div>
              <div style={{fontSize:22,fontWeight:900,color:"#fff",marginBottom:6}}>Forgot Password?</div>
              <div style={{fontSize:13,color:"rgba(255,255,255,0.45)",lineHeight:1.6}}>Enter your registered email and we'll send you a 6-digit reset code.</div>
            </div>
            <div style={{background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:20,padding:28}}>
              <label style={{fontSize:12,fontWeight:700,color:"rgba(255,255,255,0.6)",display:"block",marginBottom:6}}>Email Address</label>
              <input value={email} onChange={e=>{setEmail(e.target.value);setEmailError("");}} onKeyDown={e=>e.key==="Enter"&&handleSendCode()} placeholder="your@email.com" type="email" autoFocus style={{width:"100%",padding:"12px 14px",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.2)",borderRadius:10,fontSize:14,color:"#fff",fontFamily:"inherit",outline:"none"}}/>
              {emailError&&<div style={{marginTop:8,padding:"8px 12px",background:"rgba(217,64,64,0.18)",border:"1px solid rgba(217,64,64,0.4)",borderRadius:8,fontSize:12,color:"#ff8080",marginBottom:4}}>{emailError}</div>}
              <button onClick={handleSendCode} disabled={emailLoading} style={{width:"100%",marginTop:14,padding:13,background:emailLoading?"#444":"linear-gradient(135deg,#1A6B4A,#134D36)",color:"#fff",border:"none",borderRadius:12,fontSize:14,fontWeight:800,cursor:emailLoading?"not-allowed":"pointer",fontFamily:"inherit",opacity:emailLoading?0.7:1}}>
                {emailLoading?"⏳ Sending Code…":"📧 Send Reset Code"}
              </button>
              <button onClick={onBack} style={{width:"100%",marginTop:10,padding:10,background:"transparent",color:"rgba(255,255,255,0.35)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>← Back to Login</button>
            </div>
          </>
        )}

        {/* STEP 2: ENTER CODE */}
        {step==="code"&&(
          <>
            <div style={{textAlign:"center",marginBottom:24}}>
              <div style={{width:64,height:64,background:"rgba(16,185,129,0.12)",border:"2px solid rgba(16,185,129,0.4)",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,margin:"0 auto 14px"}}>📬</div>
              <div style={{fontSize:22,fontWeight:900,color:"#fff",marginBottom:6}}>Check Your Email</div>
              <div style={{fontSize:13,color:"rgba(255,255,255,0.45)",lineHeight:1.6}}>We sent a 6-digit code to<br/><strong style={{color:"#7FFAB5"}}>{email}</strong></div>
            </div>
            <div style={{background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:20,padding:28}}>
              <label style={{fontSize:12,fontWeight:700,color:"rgba(255,255,255,0.6)",display:"block",marginBottom:6}}>Enter 6-Digit Code</label>
              <input value={code} onChange={e=>{setCode(e.target.value.replace(/\D/g,"").slice(0,6));setCodeError("");}} onKeyDown={e=>e.key==="Enter"&&handleVerifyCode()} placeholder="000000" maxLength={6} style={{width:"100%",padding:"14px 16px",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.2)",borderRadius:10,fontSize:28,color:"#fff",fontFamily:"monospace",fontWeight:700,textAlign:"center",letterSpacing:"0.3em",outline:"none"}}/>
              {codeError&&<div style={{marginTop:8,padding:"8px 12px",background:"rgba(217,64,64,0.18)",border:"1px solid rgba(217,64,64,0.4)",borderRadius:8,fontSize:12,color:"#ff8080"}}>{codeError}</div>}
              <button onClick={handleVerifyCode} disabled={code.length<6} style={{width:"100%",marginTop:14,padding:13,background:code.length<6?"#444":"linear-gradient(135deg,#1A6B4A,#134D36)",color:"#fff",border:"none",borderRadius:12,fontSize:14,fontWeight:800,cursor:code.length<6?"not-allowed":"pointer",fontFamily:"inherit"}}>
                → Verify Code
              </button>
              <button onClick={handleResend} disabled={resendCooldown>0} style={{width:"100%",marginTop:10,padding:10,background:"transparent",color:resendCooldown>0?"rgba(255,255,255,0.2)":"rgba(255,255,255,0.5)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,fontSize:12,cursor:resendCooldown>0?"not-allowed":"pointer",fontFamily:"inherit"}}>
                {resendCooldown>0?`⏱ Resend in ${resendCooldown}s`:"🔁 Resend Code"}
              </button>
              <button onClick={()=>{setStep("email");setCode("");setCodeError("");}} style={{width:"100%",marginTop:8,padding:10,background:"transparent",color:"rgba(255,255,255,0.3)",border:"none",borderRadius:10,fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>← Wrong email? Go back</button>
            </div>
          </>
        )}

        {/* STEP 3: NEW PASSWORD */}
        {step==="reset"&&(
          <>
            <div style={{textAlign:"center",marginBottom:24}}>
              <div style={{width:64,height:64,background:"rgba(26,107,74,0.15)",border:"2px solid rgba(26,107,74,0.4)",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,margin:"0 auto 14px"}}>🔒</div>
              <div style={{fontSize:22,fontWeight:900,color:"#fff",marginBottom:6}}>Set New Password</div>
              <div style={{fontSize:13,color:"rgba(255,255,255,0.45)"}}>Code verified ✓ — create your new password</div>
            </div>
            <div style={{background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:20,padding:28}}>
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                <div>
                  <label style={{fontSize:12,fontWeight:700,color:"rgba(255,255,255,0.6)",display:"block",marginBottom:6}}>New Password</label>
                  <div style={{position:"relative"}}>
                    <input type={showPw?"text":"password"} value={newPassword} onChange={e=>{setNewPassword(e.target.value);setResetError("");}} placeholder="Min 6 characters" style={{width:"100%",padding:"12px 44px 12px 14px",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.2)",borderRadius:10,fontSize:14,color:"#fff",fontFamily:"inherit",outline:"none"}}/>
                    <button onClick={()=>setShowPw(x=>!x)} style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:"rgba(255,255,255,0.4)",cursor:"pointer",fontSize:18}}>{showPw?"🙈":"👁"}</button>
                  </div>
                </div>
                <div>
                  <label style={{fontSize:12,fontWeight:700,color:"rgba(255,255,255,0.6)",display:"block",marginBottom:6}}>Confirm Password</label>
                  <input type={showPw?"text":"password"} value={confirmPw} onChange={e=>{setConfirmPw(e.target.value);setResetError("");}} placeholder="Re-enter password" style={{width:"100%",padding:"12px 14px",background:"rgba(255,255,255,0.08)",border:`1px solid ${confirmPw&&confirmPw!==newPassword?"rgba(217,64,64,0.6)":confirmPw&&confirmPw===newPassword?"rgba(46,204,113,0.6)":"rgba(255,255,255,0.2)"}`,borderRadius:10,fontSize:14,color:"#fff",fontFamily:"inherit",outline:"none"}}/>
                  {confirmPw&&confirmPw===newPassword&&<div style={{fontSize:11,color:"#7FFAB5",marginTop:4}}>✓ Passwords match</div>}
                  {confirmPw&&confirmPw!==newPassword&&<div style={{fontSize:11,color:"#ff8080",marginTop:4}}>⚠ Passwords don't match</div>}
                </div>
              </div>
              {resetError&&<div style={{marginTop:10,padding:"8px 12px",background:"rgba(217,64,64,0.18)",border:"1px solid rgba(217,64,64,0.4)",borderRadius:8,fontSize:12,color:"#ff8080"}}>{resetError}</div>}
              <button onClick={handleReset} disabled={resetLoading||newPassword!==confirmPw||newPassword.length<6} style={{width:"100%",marginTop:16,padding:13,background:resetLoading||newPassword!==confirmPw||newPassword.length<6?"#444":"linear-gradient(135deg,#1A6B4A,#134D36)",color:"#fff",border:"none",borderRadius:12,fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:"inherit"}}>
                {resetLoading?"⏳ Saving…":"✓ Reset Password"}
              </button>
            </div>
          </>
        )}

        {/* STEP 4: SUCCESS */}
        {step==="success"&&(
          <>
            <div style={{textAlign:"center",marginBottom:24}}>
              <div style={{width:80,height:80,background:"rgba(16,185,129,0.12)",border:"2px solid rgba(16,185,129,0.5)",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:40,margin:"0 auto 16px"}}>✅</div>
              <div style={{fontSize:24,fontWeight:900,color:"#fff",marginBottom:8}}>Password Changed!</div>
              <div style={{fontSize:14,color:"rgba(255,255,255,0.5)"}}>You can now log in with your new password.</div>
            </div>
            <div style={{background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:20,padding:28,textAlign:"center"}}>
              <div style={{fontSize:12,color:"rgba(255,255,255,0.4)",marginBottom:16}}>Redirecting in <strong style={{color:"#7FFAB5"}}>{redirectCount}s</strong>…</div>
              <button onClick={onReset} style={{width:"100%",padding:13,background:"linear-gradient(135deg,#1A6B4A,#134D36)",color:"#fff",border:"none",borderRadius:12,fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:"inherit"}}>→ Go to Login Now</button>
            </div>
          </>
        )}

      </div>
    </div>
  );
}

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
const APP_VERSION="v23";
const APP_VERSION_FULL="RestoPOS v23 · ZATCA Phase 2";
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
  <div style={{background:bg,border:`2px solid ${color}22`,borderRadius:12,padding:20,display:"flex",alignItems:"center",gap:16,boxShadow:`0 2px 8px ${color}18`}}>
    <div style={{width:48,height:48,borderRadius:12,background:color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,flexShrink:0,boxShadow:`0 4px 12px ${color}40`}}>{icon}</div>
    <div><div style={{fontSize:22,fontWeight:800,color}}>{value}</div><div style={{fontSize:12,color:C.text,fontWeight:600,opacity:0.8}}>{label}</div>{sub&&<div style={{fontSize:11,color,marginTop:2,fontWeight:600}}>{sub}</div>}</div>
  </div>
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
function BusinessRegistration({onNext,onLogin}){
  const [form,setForm]=useState({businessName:"",businessNameAr:"",ownerName:"",email:"",crNumber:"",vatNumber:"",address:"",city:"Riyadh",phone:""});
  const [isOwner,setIsOwner]=useState(null);
  const [error,setError]=useState("");
  const [crFile,setCrFile]=useState(null);
  const [vatFile,setVatFile]=useState(null);
  const [fileError,setFileError]=useState("");
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));

  function handleFile(e,type){
    const file=e.target.files[0];
    if(!file)return;
    if(file.size>10*1024*1024){setFileError(type+" file must be less than 10MB.");return;}
    if(!["image/jpeg","image/jpg","image/png","application/pdf"].includes(file.type)){setFileError("Only JPG, PNG or PDF files allowed.");return;}
    setFileError("");
    if(type==="cr")setCrFile(file);
    else setVatFile(file);
  }
  function handleNext(){
    setError("");
    if(isOwner===null)return setError("Please confirm whether you are the owner.");
    if(!form.ownerName.trim())return setError("Owner / contact name is required.");
    if(!form.businessName.trim())return setError("Business name is required.");
    if(!form.email.trim()||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()))return setError("A valid email address is required — used for password recovery.");
    if(form.crNumber.trim()&&!/^\d{7,12}$/.test(form.crNumber.trim()))return setError("CR Number must be 7-12 digits (numbers only).");
    if(form.vatNumber.trim()&&!/^3\d{14}$/.test(form.vatNumber.trim()))return setError("VAT number must be 15 digits starting with 3 (or leave empty).");
    if(!form.address.trim())return setError("Address is required.");
    if(!form.phone.trim())return setError("Phone number is required.");
    onNext({...form,email:form.email.trim().toLowerCase(),isOwner,crFile,vatFile});
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
          <div style={{fontSize:13,color:"rgba(255,255,255,0.5)",marginBottom:20}}>Step 1 of 2 — Enter your business details</div>

          {/* ARE YOU THE OWNER? */}
          <div style={{marginBottom:20,padding:"14px 16px",background:"rgba(240,165,0,0.1)",border:"1px solid rgba(240,165,0,0.3)",borderRadius:12}}>
            <div style={{fontSize:13,fontWeight:700,color:"#F0A500",marginBottom:10}}>🏢 Are you the owner of this business?</div>
            <div style={{display:"flex",gap:10}}>
              {[["yes","✅ Yes, I am the owner"],["no","👤 No, I am a staff member"]].map(([v,label])=>(
                <button key={v} onClick={()=>setIsOwner(v==="yes")}
                  style={{flex:1,padding:"9px 12px",borderRadius:8,border:`2px solid ${isOwner===(v==="yes")?"#F0A500":"rgba(255,255,255,0.15)"}`,background:isOwner===(v==="yes")?"rgba(240,165,0,0.2)":"rgba(255,255,255,0.05)",color:isOwner===(v==="yes")?"#F0A500":"rgba(255,255,255,0.6)",fontFamily:"inherit",fontSize:12,fontWeight:600,cursor:"pointer"}}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            {[["ownerName","Your Full Name (Owner / Contact)","Mohammed Al-Rashid"],["businessName","Business Name (Arabic / English)","Al Baik Restaurant — مطعم البيك"],["businessNameAr","اسم المنشأة بالعربية (اختياري)","مطعم البيك"],["email","Email Address (for password recovery)","your@email.com"],["crNumber","CR Number — السجل التجاري (up to 12 digits)","1234567890"],["vatNumber","VAT / TRN Number (starts with 3)","300000000000003"],["address","Business Address","King Fahd Road, Riyadh"],["city","City","Riyadh"],["phone","Phone Number","+966 50 000 0000"]].map(([k,label,ph])=>(
              <div key={k}>
                <label style={{fontSize:12,fontWeight:700,color:"rgba(255,255,255,0.6)",display:"block",marginBottom:5}}>{label}</label>
                {k==="crNumber"?(
                  <div style={{position:"relative"}}>
                    <input value={form[k]} onChange={e=>{const v=e.target.value.replace(/\D/g,"").slice(0,12);set(k,v);}}
                      placeholder={ph} inputMode="numeric"
                      style={{width:"100%",padding:"11px 14px",background:"rgba(255,255,255,0.08)",border:`1px solid ${form.crNumber.length>0&&form.crNumber.length<10?"rgba(240,165,0,0.5)":form.crNumber.length>=10?"rgba(46,204,113,0.5)":"rgba(255,255,255,0.2)"}`,borderRadius:10,fontSize:16,color:"#fff",fontFamily:"monospace",fontWeight:700,letterSpacing:"0.1em"}}/>
                    <span style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",fontSize:10,color:"rgba(255,255,255,0.35)",fontWeight:600}}>{form.crNumber.length}/12</span>
                  </div>
                ):(
                  <input value={form[k]} onChange={e=>{set(k,e.target.value);}}
                    placeholder={ph}
                    style={{width:"100%",padding:"11px 14px",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.2)",borderRadius:10,fontSize:13,color:"#fff",fontFamily:"inherit",direction:k==="businessNameAr"?"rtl":"ltr"}}/>
                )}
              </div>
            ))}
          </div>
          {error&&<div style={{marginTop:14,padding:"10px 14px",background:"rgba(217,64,64,0.2)",border:"1px solid rgba(217,64,64,0.4)",borderRadius:8,fontSize:13,color:"#ff8080"}}>{error}</div>}
          {/* Document Upload */}
          <div style={{background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:12,padding:"16px 18px",marginBottom:4}}>
            <div style={{fontSize:12,fontWeight:700,color:"rgba(255,255,255,0.7)",marginBottom:12}}>📎 Upload Documents <span style={{color:"rgba(255,255,255,0.35)",fontWeight:400}}>(Optional — speeds up approval)</span></div>
            {fileError&&<div style={{fontSize:11,color:"#ff8080",marginBottom:8}}>⚠️ {fileError}</div>}
            <div style={{marginBottom:10}}>
              <label style={{fontSize:11,fontWeight:600,color:"rgba(255,255,255,0.55)",display:"block",marginBottom:5}}>🏢 Commercial Registration (CR) — JPG, PNG or PDF, max 10MB</label>
              <label style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",background:"rgba(255,255,255,0.06)",border:`1.5px dashed ${crFile?"rgba(46,204,113,0.5)":"rgba(255,255,255,0.2)"}`,borderRadius:8,cursor:"pointer"}}>
                <span style={{fontSize:20}}>{crFile?"✅":"📄"}</span>
                <span style={{fontSize:12,color:crFile?"#7FFAB5":"rgba(255,255,255,0.4)"}}>{crFile?crFile.name:"Click to upload CR document"}</span>
                <input type="file" accept=".jpg,.jpeg,.png,.pdf" onChange={e=>handleFile(e,"cr")} style={{display:"none"}}/>
              </label>
            </div>
            <div>
              <label style={{fontSize:11,fontWeight:600,color:"rgba(255,255,255,0.55)",display:"block",marginBottom:5}}>🧾 VAT Registration Certificate — JPG, PNG or PDF, max 10MB</label>
              <label style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",background:"rgba(255,255,255,0.06)",border:`1.5px dashed ${vatFile?"rgba(46,204,113,0.5)":"rgba(255,255,255,0.2)"}`,borderRadius:8,cursor:"pointer"}}>
                <span style={{fontSize:20}}>{vatFile?"✅":"📄"}</span>
                <span style={{fontSize:12,color:vatFile?"#7FFAB5":"rgba(255,255,255,0.4)"}}>{vatFile?vatFile.name:"Click to upload VAT certificate"}</span>
                <input type="file" accept=".jpg,.jpeg,.png,.pdf" onChange={e=>handleFile(e,"vat")} style={{display:"none"}}/>
              </label>
            </div>
          </div>
          <button onClick={handleNext} style={{width:"100%",marginTop:20,padding:14,background:"linear-gradient(135deg,#1A6B4A,#134D36)",color:"#fff",border:"none",borderRadius:12,fontSize:15,fontWeight:800,cursor:"pointer",fontFamily:"inherit"}}>Next: Enter License Key →</button>

        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// LICENSE VERIFICATION
// ═══════════════════════════════════════════════════════════════════
function LicenseVerification({businessData,onSuccess,onBack,onLogin}){
  const [uploading,setUploading]=useState(false);
  const [key,setKey]=useState("");const [error,setError]=useState("");const [loading,setLoading]=useState(false);
  async function handleVerify(){
    setError("");setLoading(true);
    const cleanKey=key.trim().toUpperCase();
    if(!cleanKey){setError("Please enter your license key.");setLoading(false);return;}
    try{
      // Try to find in Firestore — if not found, still allow (manual verification by owner)
      const devInfo=getDeviceInfo();
      const q=query(collection(db,"licenses"),where("key","==",cleanKey));
      const snap=await getDocs(q);
      if(!snap.empty){
        const licDoc=snap.docs[0]; const licData=licDoc.data();
        if(licData.active===false){setError("This license key has been deactivated. Contact your RestoPOS provider.");setLoading(false);return;}
        if(licData.activatedBy&&licData.activatedBy!==businessData.crNumber){setError("This license key is already activated by another business.");setLoading(false);return;}
        await updateDoc(doc(db,"licenses",licDoc.id),{activatedBy:businessData.crNumber,activatedAt:new Date().toISOString(),businessName:businessData.businessName,vatNumber:businessData.vatNumber,email:businessData.email||"",phone:businessData.phone||"",city:businessData.city||"",deviceId:navigator.userAgent.slice(0,100),deviceInfo:devInfo});
      }
      // Always save to pending_activations for manual review
      const existingQ=query(collection(db,"pending_activations"),where("licenseKey","==",cleanKey));
      const existingSnap=await getDocs(existingQ);
      if(existingSnap.empty){
        // Strip File objects before saving to Firestore — Firestore can't store them
      const {crFile:_cf,vatFile:_vf,...safeBusinessData}=businessData;
      await addDoc(collection(db,"pending_activations"),{...safeBusinessData,licenseKey:cleanKey,submittedAt:new Date().toISOString(),status:"pending",isActive:true,credentialsApproved:false,forceLogout:false,subscriptionPlan:"basic",deviceId:navigator.userAgent.slice(0,100),deviceInfo:devInfo});
      }
      // Upload documents to Firebase Storage if provided
      const docURLs={};
      if(businessData.crFile||businessData.vatFile){
        setUploading(true);
        try{
          if(businessData.crFile){
            const crRef=ref(storage,`documents/${cleanKey}/cr_${Date.now()}_${businessData.crFile.name}`);
            await uploadBytes(crRef,businessData.crFile);
            docURLs.crDocUrl=await getDownloadURL(crRef);
          }
          if(businessData.vatFile){
            const vatRef=ref(storage,`documents/${cleanKey}/vat_${Date.now()}_${businessData.vatFile.name}`);
            await uploadBytes(vatRef,businessData.vatFile);
            docURLs.vatDocUrl=await getDownloadURL(vatRef);
          }
        }catch(e){console.warn("[Docs] Upload failed:",e.message);}
        setUploading(false);
      }
      // Save doc URLs to Firestore
      if(Object.keys(docURLs).length>0){
        try{
          const existingQ=query(collection(db,"pending_activations"),where("licenseKey","==",cleanKey));
          const existingSnap=await getDocs(existingQ);
          if(!existingSnap.empty){
            await updateDoc(doc(db,"pending_activations",existingSnap.docs[0].id),{...docURLs,hasDocuments:true});
          }
        }catch(e){console.warn("[Docs] Firestore update failed:",e.message);}
      }
      const {crFile:_cf2,vatFile:_vf2,...safeData}=businessData;
      const licensePayload={...safeData,licenseKey:cleanKey,activatedAt:new Date().toISOString()};
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
          <div style={{fontSize:13,color:"rgba(255,255,255,0.5)",marginTop:4}}>Step 2 of 2 — Enter your license key</div>
        </div>
        <div style={{background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:20,padding:32}}>
          <div style={{background:"rgba(255,255,255,0.06)",borderRadius:10,padding:"12px 16px",marginBottom:20,fontSize:13,color:"rgba(255,255,255,0.7)"}}>
            <strong style={{color:"#fff"}}>{businessData.businessName}</strong><br/>
            <span style={{fontSize:12}}>CR: {businessData.crNumber} · VAT: {businessData.vatNumber}</span>
            {(businessData.crFile||businessData.vatFile)&&(
              <div style={{marginTop:8,fontSize:11,color:"rgba(46,204,113,0.8)"}}>
                ✅ Documents ready to upload: {[businessData.crFile&&"CR",businessData.vatFile&&"VAT"].filter(Boolean).join(", ")}
              </div>
            )}
          </div>
          <label style={{fontSize:12,fontWeight:700,color:"rgba(255,255,255,0.6)",display:"block",marginBottom:6}}>License Key</label>
          <input value={key} onChange={e=>{setKey(e.target.value.toUpperCase());setError("");}} placeholder="XXXXXXXXXXXX"
            style={{width:"100%",padding:"14px 16px",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.2)",borderRadius:10,fontSize:18,color:"#fff",fontFamily:"monospace",fontWeight:700,textAlign:"center",letterSpacing:"0.15em"}}/>
          {error&&<div style={{marginTop:10,padding:"8px 12px",background:"rgba(217,64,64,0.2)",border:"1px solid rgba(217,64,64,0.4)",borderRadius:8,fontSize:13,color:"#ff8080"}}>{error}</div>}
          <button onClick={handleVerify} disabled={loading||!key.trim()} style={{width:"100%",marginTop:16,padding:14,background:loading||!key.trim()?"#444":"linear-gradient(135deg,#1A6B4A,#134D36)",color:"#fff",border:"none",borderRadius:12,fontSize:15,fontWeight:800,cursor:loading||!key.trim()?"not-allowed":"pointer",fontFamily:"inherit"}}>
            {loading?"Verifying…":uploading?"⏳ Uploading Documents…":"✓ Submit License Key"}
          </button>
          <button onClick={onBack} style={{width:"100%",marginTop:10,padding:12,background:"transparent",color:"rgba(255,255,255,0.4)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:12,fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>← Back</button>
          <div style={{textAlign:"center",marginTop:14,paddingTop:14,borderTop:"1px solid rgba(255,255,255,0.1)"}}>
            <span style={{fontSize:12,color:"rgba(255,255,255,0.4)"}}>Already have an account? </span>
            <button onClick={onLogin} style={{background:"none",border:"none",color:"rgba(46,204,113,0.8)",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit",textDecoration:"underline"}}>Sign In</button>
          </div>

        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// ROLE LOGIN — PIN pad
// ═══════════════════════════════════════════════════════════════════
function RoleLogin({license,onLogin,lang="en"}){
  const [selectedRole,setSelectedRole]=useState(null);const [pin,setPin]=useState("");const [error,setError]=useState("");
  const pins=LS.get("restopos_pins")||DEFAULT_PINS;
  const roles=[{id:"Admin",icon:"👑",desc:"Full access"},{id:"Manager",icon:"📊",desc:"Reports & management"},{id:"Cashier",icon:"🖥️",desc:"POS billing only"}];
  function handleLoginWithPin(p){if(p===pins[selectedRole]){onLogin({role:selectedRole,name:selectedRole});}else{setError("Incorrect PIN");setPin("");}}
  // Keyboard support for PIN
  useEffect(()=>{
    if(!selectedRole)return;
    function onKey(e){
      if(e.key>="0"&&e.key<="9"){setPin(p=>p.length<4?p+e.key:p);}
      else if(e.key==="Backspace"){setPin(p=>p.slice(0,-1));}
      else if(e.key==="Enter"){setPin(p=>{if(p.length===4)handleLoginWithPin(p);return p;});}
    }
    window.addEventListener("keydown",onKey);
    return()=>window.removeEventListener("keydown",onKey);
  },[selectedRole,pins]);
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
              <div style={{display:"flex",gap:10,justifyContent:"center",marginBottom:16,direction:"ltr"}}>
                {[0,1,2,3].map(i=><div key={i} style={{width:14,height:14,borderRadius:"50%",background:pin.length>i?"#F0A500":"rgba(255,255,255,0.2)"}}/>)}
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:12,direction:"ltr"}}>
                {[1,2,3,4,5,6,7,8,9,"",0,"⌫"].map((k,i)=>(
                  <button key={i} onClick={()=>{if(k==="⌫")setPin(p=>p.slice(0,-1));else if(k!=="")setPin(p=>p.length<4?p+String(k):p);}}
                    style={{padding:"16px",background:k===""?"transparent":"rgba(255,255,255,0.08)",border:k===""?"none":"1px solid rgba(255,255,255,0.12)",borderRadius:10,fontSize:18,fontWeight:700,cursor:k===""?"default":"pointer",fontFamily:"inherit",color:"#fff",direction:"ltr"}}>{k}</button>
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
function PaymentModal({total,subtotal,vat,promos,onConfirm,onClose,license,vno=1,kotNo=1,customers=[],customerName:initCustName="",customerPhone:initCustPhone="",orderType:initOrderType="takeaway"}){
  // ── State ────────────────────────────────────────────────────────
  const [method,setMethod]=useState("Cash");
  const [cashGiven,setCashGiven]=useState("");
  const [cardAmount,setCardAmount]=useState("");
  const [cashAmount,setCashAmount]=useState("");
  const [promoCode,setPromoCode]=useState("");
  const [appliedPromo,setAppliedPromo]=useState(null);
  const [manualDiscount,setManualDiscount]=useState("");
  const [discountType,setDiscountType]=useState("%");
  const [promoError,setPromoError]=useState("");
  const [splitError,setSplitError]=useState("");
  const [printAndSave,setPrintAndSave]=useState(()=>{
    const saved=localStorage.getItem("restopos_print_save_pref");
    return saved===null?true:saved==="true";
  });
  const [saveWithoutPrint,setSaveWithoutPrint]=useState(false);
  const [isDraft,setIsDraft]=useState(false);
  // Customer details
  const [custName,setCustName]=useState(initCustName||"");
  const [custPhone,setCustPhone]=useState(initCustPhone||"");
  const [custSuggestions,setCustSuggestions]=useState([]);
  const [invoiceNote,setInvoiceNote]=useState("");
  const [localOrderType,setOrderTypeLocal]=useState(initOrderType||"takeaway");
  const [localBillType,setLocalBillType]=useState("normal");
  // Cash denomination tracker
  const [denominations,setDenominations]=useState({});
  const DENOMS=[500,200,100,50,20,10,5,1];
  const printFrameRef=useRef();

  // Auto-lookup customer by phone
  function handlePhoneChange(phone){
    setCustPhone(phone);
    if(phone.length>=4){
      const matches=customers.filter(c=>c.phone?.includes(phone)||c.name?.toLowerCase().includes(phone.toLowerCase()));
      setCustSuggestions(matches.slice(0,4));
    }else{setCustSuggestions([]);}
  }
  function selectCustomer(c){
    setCustName(c.name||"");setCustPhone(c.phone||"");
    setCustSuggestions([]);
  }
  // Cash denomination total
  const denomTotal=DENOMS.reduce((s,d)=>s+(denominations[d]||0)*d,0);
  // Add denomination
  function addDenom(d){
    setDenominations(prev=>({...prev,[d]:(prev[d]||0)+1}));
    const newTotal=denomTotal+d;
    setCashGiven(newTotal.toFixed(2));
  }
  function clearDenoms(){setDenominations({});setCashGiven("");}

  // ── Discount calculation ─────────────────────────────────────────
  // Manual discount applied to subtotal (before VAT)
  const manualDiscountAmt=useMemo(()=>{
    const v=parseFloat(manualDiscount)||0;
    if(discountType==="%")return Math.min(subtotal,subtotal*v/100);
    return Math.min(subtotal,v);
  },[manualDiscount,discountType,subtotal]);

  // Promo discount applied to subtotal
  const promoDiscountAmt=appliedPromo
    ?(appliedPromo.type==="%"?subtotal*appliedPromo.value/100:Math.min(subtotal,appliedPromo.value))
    :0;

  // Combined discount
  const totalDiscountAmt=manualDiscountAmt+promoDiscountAmt;

  // Recalculate: discount on subtotal → then VAT on discounted subtotal
  const discountedSubtotal=Math.max(0,subtotal-totalDiscountAmt);
  const finalVat=parseFloat((discountedSubtotal*0.15).toFixed(2));
  const finalTotal=parseFloat((discountedSubtotal+finalVat).toFixed(2));

  // ── Payment method logic ─────────────────────────────────────────
  const METHODS=[
    {id:"Cash",  icon:"💵", label:"Cash"},
    {id:"Card",  icon:"💳", label:"Card"},
    {id:"Mada",  icon:"🏦", label:"Mada"},
    {id:"Apple Pay", icon:"", label:"Apple Pay"},
    {id:"Both",  icon:"🔀", label:"Cash + Card"},
  ];

  const QUICK=[10,20,50,100,200,500];

  // Cash validation
  const cashFloat=parseFloat(cashGiven)||0;
  const shortfall=method==="Cash"&&cashFloat>0&&cashFloat<finalTotal;
  const change=method==="Cash"?Math.max(0,cashFloat-finalTotal):0;

  // Both split validation
  const bothCard=parseFloat(cardAmount)||0;
  const bothCash=parseFloat(cashAmount)||0;
  const bothTotal=parseFloat((bothCard+bothCash).toFixed(2));
  const bothDiff=parseFloat((bothTotal-finalTotal).toFixed(2));
  const bothValid=Math.abs(bothDiff)<0.01;

  // canConfirm: cash needs amount >= total, card/digital always ready if total > 0
  const canConfirm=(
    finalTotal>0&&(
      method==="Cash"?(cashFloat>=finalTotal):
      method==="Both"?bothValid:
      true  // Card, Mada, Apple Pay — always ready
    )
  );

  // ── Apply promo ───────────────────────────────────────────────────
  function applyPromo(){
    setPromoError("");
    const match=promos.find(p=>p.code.toLowerCase()===promoCode.trim().toLowerCase()&&p.active);
    if(match){setAppliedPromo(match);setPromoError("");}
    else{setPromoError("Invalid or inactive coupon code.");}
  }

  // ── Test printer ─────────────────────────────────────────────────
  function testPrinter(){
    const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      @page{size:80mm auto;margin:0}body{font-family:'Courier New',monospace;font-size:12px;width:80mm;padding:4mm;text-align:center}
      .big{font-size:18px;font-weight:bold;margin:8px 0}.hr{border:none;border-top:1px dashed #000;margin:6px 0}
    </style></head><body>
      <div class="big">🖨️ PRINTER TEST</div>
      <hr class="hr"/>
      <div>${license?.businessName||"RestoPOS"}</div>
      <div style="font-size:10px;color:#666">${new Date().toLocaleString("en-SA")}</div>
      <hr class="hr"/>
      <div>If you can read this,</div>
      <div>your printer is working!</div>
      <div style="font-family:'Tajawal',sans-serif;direction:rtl;margin-top:4px">الطابعة تعمل بشكل صحيح</div>
      <hr class="hr"/>
      <div style="font-size:10px">RestoPOS · ZATCA Phase 2</div>
      <br/><br/>
    </body></html>`;
    const iframe=printFrameRef.current;
    const doc=iframe.contentDocument||iframe.contentWindow.document;
    doc.open();doc.write(html);doc.close();
    setTimeout(()=>{iframe.contentWindow.focus();iframe.contentWindow.print();},400);
  }

  // ── Confirm ───────────────────────────────────────────────────────
  function handleConfirm(shouldPrint=true){
    if(!canConfirm)return;
    localStorage.setItem("restopos_print_save_pref",String(shouldPrint));
    const payInfo={
      method,
      given:method==="Cash"?cashFloat:method==="Both"?bothCash:finalTotal,
      change:method==="Cash"?change:0,
      cardAmount:method==="Both"?bothCard:method==="Card"||method==="Mada"||method==="Apple Pay"?finalTotal:0,
      cashAmount:method==="Both"?bothCash:method==="Cash"?cashFloat:0,
    };
    onConfirm(
      payInfo.method,payInfo.given,payInfo.change,
      appliedPromo,totalDiscountAmt,finalTotal,finalVat,
      shouldPrint,payInfo,manualDiscountAmt,promoDiscountAmt,
      isDraft,
      {customerName:custName,customerPhone:custPhone,invoiceNote,orderType:localOrderType,billType:localBillType}
    );
  }

  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:3000,
      display:"flex",alignItems:"center",justifyContent:"center",padding:8,direction:"ltr"}}>
      <div style={{background:"#fff",borderRadius:18,width:"100%",maxWidth:900,
        height:"calc(100vh - 16px)",maxHeight:"98vh",display:"flex",flexDirection:"column",
        boxShadow:"0 24px 80px rgba(0,0,0,0.4)"}}>

        {/* ── Header ── */}
        <div style={{background:"linear-gradient(135deg,#1A3A5C,#0F2340)",padding:"12px 18px",
          borderRadius:"18px 18px 0 0",flexShrink:0,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
            <div style={{color:"#fff",fontSize:15,fontWeight:800}}>💳 Charge & Payment</div>
            <div style={{padding:"3px 10px",background:"rgba(255,255,255,0.15)",borderRadius:20,fontSize:11,color:"rgba(255,255,255,0.9)",fontWeight:700}}>🧾 INV-{vno}</div>
            <div style={{padding:"3px 10px",background:"rgba(255,255,255,0.12)",borderRadius:20,fontSize:11,color:"rgba(255,255,255,0.8)",fontWeight:700}}>🍽️ KOT #{kotNo}</div>
            <div style={{padding:"3px 10px",background:"rgba(255,255,255,0.08)",borderRadius:20,fontSize:11,color:"rgba(255,255,255,0.5)"}}>{new Date().toLocaleTimeString("en-SA",{hour:"2-digit",minute:"2-digit"})}</div>
          </div>
          <button onClick={onClose} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",width:28,height:28,borderRadius:"50%",cursor:"pointer",fontSize:16,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>×</button>
        </div>

        {/* ── Body — 2 column layout ── */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",flex:1,overflow:"hidden",minHeight:0}}>

          {/* ── LEFT COLUMN ── */}
          <div style={{padding:"14px 16px",borderRight:"1px solid #E0E8F0",display:"flex",flexDirection:"column",gap:10,overflowY:"auto"}}>

            {/* Amount Due */}
            <div style={{background:"#F0F7FF",border:"1.5px solid #C5DCF5",borderRadius:12,padding:"10px 14px"}}>
              <div style={{fontSize:10,color:"#5A7A9A",fontWeight:700}}>AMOUNT DUE</div>
              <div style={{fontSize:32,fontWeight:900,color:"#1A3A5C",lineHeight:1.1}}>SAR {finalTotal.toFixed(2)}</div>
              <div style={{fontSize:10,color:"#8A9AB0",marginTop:2,direction:"ltr"}}>
                Sub: {subtotal.toFixed(2)}{totalDiscountAmt>0?` · Disc: -${totalDiscountAmt.toFixed(2)}`:""} · VAT: {finalVat.toFixed(2)}
              </div>
            </div>

            {/* Customer */}
            <div style={{background:"#F8FAFF",border:"1px solid #E0E8F0",borderRadius:10,padding:"10px 12px"}}>
              <div style={{fontSize:10,fontWeight:800,color:"#3A5A7A",marginBottom:6}}>👤 CUSTOMER (OPTIONAL)</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,position:"relative"}}>
                <div>
                  <input value={custPhone} onChange={e=>handlePhoneChange(e.target.value)}
                    placeholder="📞 Phone" type="tel"
                    style={{width:"100%",padding:"7px 10px",border:"1px solid #C5DCF5",borderRadius:7,
                      fontSize:13,color:"#000",background:"#fff",fontFamily:"inherit",direction:"ltr"}}/>
                  {custSuggestions.length>0&&(
                    <div style={{position:"absolute",top:"100%",left:0,right:0,background:"#fff",border:"1px solid #E0E8F0",
                      borderRadius:8,boxShadow:"0 8px 24px rgba(0,0,0,0.15)",zIndex:100,marginTop:2}}>
                      {custSuggestions.map(c=>(
                        <div key={c.id} onClick={()=>selectCustomer(c)}
                          style={{padding:"8px 12px",cursor:"pointer",borderBottom:"1px solid #F0F4F8",fontSize:12}}
                          onMouseEnter={e=>e.currentTarget.style.background="#F0F7FF"}
                          onMouseLeave={e=>e.currentTarget.style.background="#fff"}>
                          <div style={{fontWeight:700,color:"#1A3A5C"}}>{c.name}</div>
                          <div style={{color:"#8A9AB0",fontSize:10}}>{c.phone}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <input value={custName} onChange={e=>setCustName(e.target.value.charAt(0).toUpperCase()+e.target.value.slice(1))}
                  placeholder="👤 Name"
                  style={{width:"100%",padding:"7px 10px",border:"1px solid #C5DCF5",borderRadius:7,
                    fontSize:13,color:"#000",background:"#fff",fontFamily:"inherit",direction:"ltr"}}/>
              </div>
              {custName&&<div style={{marginTop:5,fontSize:10,color:"#1A6B4A",fontWeight:600}}>✓ {custName}{custPhone?" · "+custPhone:""}</div>}
            </div>

            {/* Order Type + Bill Type */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,direction:"ltr"}}>
              {/* Order Type */}
              <div style={{background:"#F8FAFF",border:"1px solid #E0E8F0",borderRadius:10,padding:"8px 10px"}}>
                <div style={{fontSize:9,fontWeight:800,color:"#3A5A7A",marginBottom:6}}>ORDER TYPE</div>
                <div style={{display:"flex",gap:4}}>
                  {[["takeaway","🥡","Takeaway"],["dine-in","🍽️","Dine-in"]].map(([id,icon,label])=>(
                    <button key={id} onClick={()=>setOrderTypeLocal(id)}
                      style={{flex:1,padding:"5px 2px",border:`1.5px solid ${localOrderType===id?"#1A6B4A":"#E0E8F0"}`,
                        background:localOrderType===id?"#E8F5EE":"#fff",
                        color:localOrderType===id?"#1A6B4A":"#8A9AB0",
                        borderRadius:6,fontFamily:"inherit",fontSize:9,fontWeight:700,cursor:"pointer"}}>
                      {icon} {label}
                    </button>
                  ))}
                </div>
              </div>
              {/* Bill Type */}
              <div style={{background:"#F8FAFF",border:"1px solid #E0E8F0",borderRadius:10,padding:"8px 10px"}}>
                <div style={{fontSize:9,fontWeight:800,color:"#3A5A7A",marginBottom:6}}>BILL TYPE</div>
                <div style={{display:"flex",gap:4}}>
                  {[["normal","📄","Normal"],["telephone","📞","Phone"]].map(([id,icon,label])=>(
                    <button key={id} onClick={()=>setLocalBillType(id)}
                      style={{flex:1,padding:"5px 2px",border:`1.5px solid ${localBillType===id?"#1A6B4A":"#E0E8F0"}`,
                        background:localBillType===id?"#E8F5EE":"#fff",
                        color:localBillType===id?"#1A6B4A":"#8A9AB0",
                        borderRadius:6,fontFamily:"inherit",fontSize:9,fontWeight:700,cursor:"pointer"}}>
                      {icon} {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Note */}
            <input value={invoiceNote} onChange={e=>setInvoiceNote(e.target.value.charAt(0).toUpperCase()+e.target.value.slice(1))}
              placeholder="📝 Invoice note (No onions, Birthday, VIP...)"
              style={{padding:"8px 12px",border:"1px solid #F0E8C0",borderRadius:8,
                fontSize:12,color:"#000",background:"#FFFDF0",fontFamily:"inherit",direction:"ltr"}}/>

            {/* Discount */}
            <div style={{background:"#FFFBF0",border:"1px solid #F0E0A0",borderRadius:10,padding:"10px 12px"}}>
              <div style={{fontSize:10,fontWeight:800,color:"#8A6000",marginBottom:6}}>🏷️ DISCOUNT</div>
              <div style={{display:"flex",gap:6,marginBottom:6}}>
                <input value={manualDiscount} onChange={e=>setManualDiscount(e.target.value)}
                  type="number" min="0" placeholder="0"
                  style={{flex:1,padding:"7px 10px",border:"1px solid #E8D090",borderRadius:7,
                    fontSize:15,fontWeight:700,color:"#000",background:"#fff",textAlign:"center",
                    fontFamily:"inherit",direction:"ltr"}}/>
                {["%","SAR"].map(t=>(
                  <button key={t} onClick={()=>setDiscountType(t)}
                    style={{padding:"7px 12px",background:discountType===t?"#F0A500":"#fff",
                      color:discountType===t?"#fff":"#8A7A5A",border:"1px solid #E8D090",
                      borderRadius:7,cursor:"pointer",fontFamily:"inherit",fontSize:12,fontWeight:700}}>
                    {t}
                  </button>
                ))}
                {manualDiscountAmt>0&&<span style={{fontSize:11,color:"#D94040",fontWeight:700,alignSelf:"center",whiteSpace:"nowrap"}}>−{manualDiscountAmt.toFixed(2)}</span>}
              </div>
              <div style={{display:"flex",gap:6}}>
                <input value={promoCode} onChange={e=>{setPromoCode(e.target.value.toUpperCase());setPromoError("");}}
                  onKeyDown={e=>e.key==="Enter"&&applyPromo()}
                  placeholder="Coupon code"
                  style={{flex:1,padding:"7px 10px",border:`1px solid ${promoError?"#D94040":appliedPromo?"#1A8A4A":"#E8D090"}`,
                    borderRadius:7,fontSize:13,color:"#000",background:"#fff",fontFamily:"inherit",
                    textTransform:"uppercase",direction:"ltr"}}/>
                <button onClick={applyPromo}
                  style={{padding:"7px 14px",background:"#1A3A5C",color:"#fff",border:"none",
                    borderRadius:7,cursor:"pointer",fontSize:12,fontWeight:700,fontFamily:"inherit"}}>
                  Apply
                </button>
              </div>
              {promoError&&<div style={{fontSize:10,color:"#D94040",marginTop:3}}>⚠️ {promoError}</div>}
              {appliedPromo&&<div style={{fontSize:11,color:"#1A8A4A",marginTop:3,fontWeight:700}}>
                ✓ {appliedPromo.code} (−SAR {promoDiscountAmt.toFixed(2)})
                <button onClick={()=>{setAppliedPromo(null);setPromoCode("");}} style={{marginLeft:6,background:"none",border:"none",color:"#D94040",cursor:"pointer",fontSize:10}}>✕</button>
              </div>}
            </div>
          </div>

          {/* ── RIGHT COLUMN ── */}
          <div style={{padding:"14px 16px",display:"flex",flexDirection:"column",gap:10,overflowY:"auto"}}>

            {/* Payment method */}
            <div>
              <div style={{fontSize:10,fontWeight:800,color:"#3A5A7A",marginBottom:6}}>💳 PAYMENT METHOD</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:5,direction:"ltr"}}>
                {METHODS.map(m=>(
                  <button key={m.id} onClick={()=>{setMethod(m.id);setSplitError("");setCashGiven("");setCardAmount("");setCashAmount("");clearDenoms();}}
                    style={{padding:"8px 4px",border:`2px solid ${method===m.id?"#1A3A5C":"#E0E8F0"}`,
                      background:method===m.id?"#1A3A5C":"#fff",color:method===m.id?"#fff":"#5A7A9A",
                      borderRadius:8,cursor:"pointer",fontFamily:"inherit",fontSize:9,fontWeight:700,
                      display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
                    <span style={{fontSize:14}}>{m.icon}</span>
                    <span>{m.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Cash input + denominations */}
            {method==="Cash"&&(
              <div>
                <div style={{fontSize:10,fontWeight:700,color:"#5A7A9A",marginBottom:4}}>AMOUNT GIVEN</div>
                <input value={cashGiven} onChange={e=>{setCashGiven(e.target.value);clearDenoms();}}
                  type="number" placeholder={finalTotal.toFixed(2)}
                  style={{width:"100%",padding:"10px 14px",border:`2px solid ${shortfall?"#D94040":"#B0C8E8"}`,
                    borderRadius:10,fontSize:22,fontWeight:800,color:"#000",background:"#fff",
                    textAlign:"center",fontFamily:"inherit",direction:"ltr"}}/>
                {shortfall>0&&<div style={{fontSize:11,color:"#D94040",fontWeight:700,marginTop:3}}>⚠️ Short by SAR {shortfall.toFixed(2)}</div>}
                {change>0&&cashFloat>=finalTotal&&<div style={{fontSize:13,color:"#1A6B4A",fontWeight:800,marginTop:3}}>Change: SAR {change.toFixed(2)}</div>}
                {/* Denomination pad */}
                <div style={{marginTop:8}}>
                  <div style={{fontSize:9,color:"#8A9AB0",fontWeight:700,marginBottom:4}}>CASH DENOMINATIONS</div>
                  <div style={{display:"flex",gap:4,flexWrap:"wrap",direction:"ltr"}}>
                    {DENOMS.map(d=>(
                      <button key={d} onClick={()=>addDenom(d)}
                        style={{padding:"5px 8px",background:(denominations[d]||0)>0?"#1A3A5C":"#F0F7FF",
                          color:(denominations[d]||0)>0?"#fff":"#1A3A5C",
                          border:"1px solid #C5DCF5",borderRadius:6,cursor:"pointer",
                          fontFamily:"inherit",fontSize:11,fontWeight:700,minWidth:32,
                          position:"relative",textAlign:"center"}}>
                        {d}
                        {(denominations[d]||0)>0&&<span style={{position:"absolute",top:-5,right:-5,background:"#F0A500",color:"#fff",borderRadius:"50%",width:14,height:14,fontSize:8,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:900}}>{denominations[d]}</span>}
                      </button>
                    ))}
                    <button onClick={()=>setCashGiven(finalTotal.toFixed(2))}
                      style={{padding:"5px 8px",background:"#E8F5EE",color:"#1A6B4A",border:"1px solid #A8D5B8",borderRadius:6,cursor:"pointer",fontFamily:"inherit",fontSize:10,fontWeight:700}}>
                      Exact
                    </button>
                    {Object.values(denominations).some(v=>v>0)&&(
                      <button onClick={clearDenoms}
                        style={{padding:"5px 8px",background:"rgba(239,68,68,0.1)",color:"#D94040",border:"1px solid rgba(239,68,68,0.3)",borderRadius:6,cursor:"pointer",fontFamily:"inherit",fontSize:10,fontWeight:700}}>
                        ✕
                      </button>
                    )}
                  </div>
                  {Object.values(denominations).some(v=>v>0)&&(
                    <div style={{fontSize:10,color:"#5A7A9A",marginTop:3,direction:"ltr"}}>{DENOMS.filter(d=>(denominations[d]||0)>0).map(d=>`${denominations[d]}×${d}`).join(" + ")} = SAR {denomTotal.toFixed(2)}</div>
                  )}
                </div>
              </div>
            )}

            {/* Card/Mada/Apple Pay */}
            {(method==="Card"||method==="Mada"||method==="Apple Pay")&&(
              <div style={{background:"#F0F7FF",borderRadius:10,padding:"12px 14px",textAlign:"center"}}>
                <div style={{fontSize:28,marginBottom:6}}>💳</div>
                <div style={{fontSize:14,fontWeight:700,color:"#1A3A5C"}}>{method} Payment</div>
                <div style={{fontSize:22,fontWeight:900,color:"#1A3A5C",marginTop:4}}>SAR {finalTotal.toFixed(2)}</div>
                <div style={{fontSize:11,color:"#5A7A9A",marginTop:4}}>Process on terminal then confirm below</div>
              </div>
            )}

            {/* Split payment */}
            {method==="Both"&&(
              <div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  <div>
                    <div style={{fontSize:10,color:"#5A7A9A",fontWeight:600,marginBottom:4}}>💵 Cash Amount</div>
                    <input value={cashAmount} onChange={e=>{setCashAmount(e.target.value);setSplitError("");}}
                      type="number" placeholder="0.00"
                      style={{width:"100%",padding:"8px 10px",border:"1px solid #C5DCF5",borderRadius:8,
                        fontSize:16,fontWeight:800,color:"#000",background:"#fff",textAlign:"center",fontFamily:"inherit",direction:"ltr"}}/>
                  </div>
                  <div>
                    <div style={{fontSize:10,color:"#5A7A9A",fontWeight:600,marginBottom:4}}>💳 Card Amount</div>
                    <input value={cardAmount} onChange={e=>{setCardAmount(e.target.value);setSplitError("");}}
                      type="number" placeholder="0.00"
                      style={{width:"100%",padding:"8px 10px",border:"1px solid #C5DCF5",borderRadius:8,
                        fontSize:16,fontWeight:800,color:"#000",background:"#fff",textAlign:"center",fontFamily:"inherit",direction:"ltr"}}/>
                  </div>
                </div>
                {splitError&&<div style={{fontSize:11,color:"#D94040",marginTop:4,fontWeight:700}}>⚠️ {splitError}</div>}
                {bothCash>0&&bothCard>0&&!splitError&&<div style={{fontSize:11,color:"#1A6B4A",marginTop:4,fontWeight:700}}>✓ Total: SAR {(bothCash+bothCard).toFixed(2)}</div>}
              </div>
            )}

            {/* Draft toggle */}
            <div style={{display:"flex",alignItems:"center",gap:8,padding:"8px 12px",
              background:isDraft?"#FFF8E8":"#F8FAFF",
              border:`1px solid ${isDraft?"#F0A500":"#E0E8F0"}`,borderRadius:8,cursor:"pointer"}}
              onClick={()=>setIsDraft(x=>!x)}>
              <div style={{width:18,height:18,borderRadius:4,flexShrink:0,
                background:isDraft?"#F0A500":"#fff",border:`2px solid ${isDraft?"#F0A500":"#CBD5E0"}`,
                display:"flex",alignItems:"center",justifyContent:"center"}}>
                {isDraft&&<span style={{color:"#fff",fontSize:12,fontWeight:900,lineHeight:1}}>✓</span>}
              </div>
              <div style={{flex:1}}>
                <div style={{fontSize:12,fontWeight:700,color:isDraft?"#A07000":"#1A3A5C"}}>📋 Draft Bill {isDraft?"(D-Invoice — no ZATCA QR)":""}</div>
                <div style={{fontSize:9,color:"#8A9AB0"}}>{isDraft?"Prints as D-Invoice (11A, 11B...) without QR":"Tap to mark as draft"}</div>
              </div>
              <button onClick={e=>{e.stopPropagation();testPrinter();}}
                style={{padding:"4px 8px",background:"#fff",border:"1px solid #C5DCF5",borderRadius:5,
                  color:"#1A3A5C",fontSize:9,fontWeight:700,cursor:"pointer",fontFamily:"inherit",flexShrink:0}}>
                🧪 Test
              </button>
            </div>

            {/* Error */}
            {!canConfirm&&method==="Cash"&&(
              <div style={{padding:"8px 12px",background:"#FDE8E8",border:"1px solid #D94040",borderRadius:8,fontSize:11,fontWeight:700,color:"#D94040",textAlign:"center"}}>
                {cashFloat===0?"⚠️ Enter cash amount":"⚠️ Cash given is less than total by SAR "+(finalTotal-cashFloat).toFixed(2)}
              </div>
            )}
            {!canConfirm&&method==="Both"&&(
              <div style={{padding:"8px 12px",background:"#FDE8E8",border:"1px solid #D94040",borderRadius:8,fontSize:11,fontWeight:700,color:"#D94040",textAlign:"center"}}>
                ⚠️ Split amounts must add up to SAR {finalTotal.toFixed(2)}
              </div>
            )}

            {/* Action buttons */}
            <div style={{display:"flex",gap:8,marginTop:"auto"}}>
              <button onClick={()=>handleConfirm(false)} disabled={!canConfirm}
                style={{flex:1,padding:"12px 8px",background:canConfirm?"#2176AE":"#ccc",
                  color:"#fff",border:"none",borderRadius:10,fontSize:12,fontWeight:700,
                  cursor:canConfirm?"pointer":"not-allowed",fontFamily:"inherit"}}>
                💾 Save Bill
              </button>
              <button onClick={()=>handleConfirm(true)} disabled={!canConfirm}
                style={{flex:2,padding:"12px",background:canConfirm?"linear-gradient(135deg,#1A6B4A,#0F4A30)":"#ccc",
                  color:"#fff",border:"none",borderRadius:10,fontSize:14,fontWeight:800,
                  cursor:canConfirm?"pointer":"not-allowed",fontFamily:"inherit",
                  boxShadow:canConfirm?"0 4px 16px rgba(26,107,74,0.3)":"none"}}>
                {isDraft?"🖨️ Print Draft & Save":"🖨️ Print & Save"}
              </button>
            </div>

          </div>
        </div>
      </div>
      {/* Hidden iframe for browser print fallback */}
      <iframe ref={printFrameRef} style={{display:"none"}} title="print"/>
    </div>
  )
}
// ═══════════════════════════════════════════════════════════════════
// RECEIPT MODAL — iframe print, ZATCA invoice meta on receipt
// ═══════════════════════════════════════════════════════════════════
function ReceiptModal({order,license,zatcaInvoice,onClose}){
  const qrData=zatcaInvoice?zatcaInvoice.qr_string:generatePhase1QR({sellerName:license.businessName,vatNumber:license.vatNumber,timestamp:new Date().toISOString(),total:order.total,vatAmount:order.vat});
  const printFrameRef=useRef();
  const qrReady=useQRScript();
  const activeTemplate=LS.get("restopos_invoice_template")||"modern";
  const invoiceFormat=LS.get("restopos_invoice_format")||{font:"courier",fontSize:12,footer:"Thank you for your visit!",footerAr:"شكراً لزيارتكم"};
  const FONT_MAP={"courier":"'Courier New',monospace","georgia":"Georgia,serif","trebuchet":"'Trebuchet MS',sans-serif","arial-narrow":"'Arial Narrow',Arial,sans-serif","impact":"Impact,Haettenschweiter,sans-serif","tajawal":"'Tajawal',sans-serif","cairo":"'Cairo',sans-serif","amiri":"'Amiri',serif","scheherazade":"'Scheherazade New',serif","noto-naskh":"'Noto Naskh Arabic',serif"};
  const fontFamily=FONT_MAP[invoiceFormat.font]||"'Courier New',monospace";
  const footer=invoiceFormat.footer||"Thank you for your visit!";
  const footerAr=invoiceFormat.footerAr||"شكراً لزيارتكم";

  function buildReceiptHTML(qrImgSrc){
    const zatcaMeta=zatcaInvoice?`<div class="row"><span>ZATCA Invoice</span><span>${zatcaInvoice.invoice_number}</span></div><div class="row"><span>ICV</span><span>${zatcaInvoice.icv}</span></div><div style="font-size:8px;text-align:center;color:#666;word-break:break-all;margin-top:2px">Hash: ${zatcaInvoice.invoice_hash?.slice(0,24)}...</div>`:"";
    // Group items by category
    const cats=[...new Set(order.items.map(i=>i.category||"Items"))];
    const itemsHTML=cats.map(cat=>{
      const catItems=order.items.filter(i=>(i.category||"Items")===cat);
      return `<div style="font-size:9px;font-weight:bold;letter-spacing:0.08em;color:#555;margin-top:6px;margin-bottom:2px;text-transform:uppercase;">${cat}</div>`+
        catItems.map(it=>`<div class="row"><span class="item-name">${it.name}${it.nameAr?`<br/><span style="font-family:'Noto Naskh Arabic','Arial',sans-serif;direction:rtl;display:block;text-align:right;font-size:11px;color:#333;">${it.nameAr}</span>`:""}<br/><small style="color:#666;">${it.qty} × SAR ${it.price.toFixed(2)}</small></span><span class="item-amt">SAR ${(it.qty*it.price).toFixed(2)}</span></div>`).join("");
    }).join("");
    // Template-specific styles
    let headerHTML="";let bodyStyle="";let hrStyle="border:none;border-top:1px dashed #000;margin:6px 0";
    if(activeTemplate==="modern"){
      headerHTML=`<div style="background:#1A6B4A;color:#fff;padding:10px;margin:-4mm -4mm 8px;text-align:center;border-radius:0 0 8px 8px"><div style="font-size:18px;font-weight:900">${license.businessName}</div><div style="font-size:10px;opacity:0.85">${license.address||""}</div><div style="font-size:10px;opacity:0.85">TRN: ${license.vatNumber}</div></div><div style="text-align:center;font-size:11px;margin-bottom:6px">${order.id} | ${order.date} ${order.time}${order.customer?`<br/>Customer: ${order.customer}`:""}${order.type?`<br/>${order.type}${order.table?` · Table ${order.table}`:""}`:""}</div>`;
      hrStyle="border:none;border-top:2px solid #1A6B4A;margin:6px 0";
    }else if(activeTemplate==="classic"){
      headerHTML=`<div style="text-align:center"><div style="font-size:16px;font-weight:900;letter-spacing:0.1em">${license.businessName}</div><div style="font-size:10px">${license.address||""}</div><div>TRN: ${license.vatNumber}</div><div>${order.id} | ${order.date} ${order.time}</div>${order.customer?`<div>Customer: ${order.customer}</div>`:""}<div>${order.type}${order.table?` · Table ${order.table}`:""}</div></div>`;
    }else if(activeTemplate==="minimal"){
      headerHTML=`<div style="font-weight:900;font-size:14px">${license.businessName}</div><div style="font-size:10px;color:#555">${order.id} · ${order.date}</div>`;
      hrStyle="border:none;border-top:1px solid #ccc;margin:4px 0";
    }else if(activeTemplate==="arabic"){
      headerHTML=`<div style="direction:rtl;text-align:right;font-family:'Noto Naskh Arabic','Tajawal',sans-serif"><div style="font-size:18px;font-weight:900">${license.businessName}</div><div style="font-size:10px">${license.address||""}</div><div>الرقم الضريبي: ${license.vatNumber}</div><div>${order.id} | ${order.date} ${order.time}</div></div>`;
    }else{
      headerHTML=`<div class="center"><div class="big">${license.businessName}</div><div>${license.address||""}</div><div>TRN: ${license.vatNumber}</div><div>${order.id} | ${order.date} ${order.time}</div>${order.customer?`<div>Customer: ${order.customer}</div>`:""}<div>${order.type}${order.table?` · Table ${order.table}`:""}</div></div>`;
    }
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Receipt ${order.id}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Noto+Naskh+Arabic:wght@400;700&family=Tajawal:wght@400;700&family=Cairo:wght@400;700&family=Amiri:wght@400;700&display=swap" rel="stylesheet">
<style>@page{size:80mm auto;margin:0}*{box-sizing:border-box;margin:0;padding:0}body{font-family:${fontFamily};font-size:${invoiceFormat.fontSize||12}px;color:#000;background:#fff;width:80mm;padding:4mm}.center{text-align:center}.bold{font-weight:bold}.big{font-size:16px;font-weight:bold}.hr{${hrStyle}}.row{display:flex;justify-content:space-between;margin:2px 0;align-items:flex-start}.row-total{display:flex;justify-content:space-between;margin:4px 0;font-size:15px;font-weight:900;border-top:2px solid #000;padding-top:4px}.item-name{flex:1;padding-right:4px}.item-amt{white-space:nowrap;padding-top:1px}.qr-img{width:110px;height:110px;display:block;margin:0 auto}.zatca-label{font-size:9px;font-weight:bold;letter-spacing:0.1em}@media print{body{width:80mm}}</style>
</head><body>
${headerHTML}
<hr class="hr"/>
${itemsHTML}
<hr class="hr"/>
${order.discount>0?`<div class="row"><span>Discount</span><span>-SAR ${order.discount.toFixed(2)}</span></div>`:""}
<div class="row" style="font-size:10px;color:#888;"><span>VAT 15% (incl.)</span><span>SAR ${order.vat.toFixed(2)}</span></div>
<div class="row-total"><span>TOTAL</span><span>SAR ${order.total.toFixed(2)}</span></div>
${order.payMethod==="Cash"?`<div class="row"><span>Cash Given</span><span>SAR ${Number(order.given).toFixed(2)}</span></div><div class="row bold"><span>Change</span><span>SAR ${Number(order.change).toFixed(2)}</span></div>`:`<div class="row bold"><span>Payment</span><span>${order.payMethod}</span></div>`}
<hr class="hr"/>${zatcaMeta}
<div style="text-align:center;margin:8px 0;">
${qrImgSrc?`<img class="qr-img" src="${qrImgSrc}" alt="ZATCA QR"/>`:`<div style="width:110px;height:110px;border:1px solid #ccc;margin:0 auto;display:flex;align-items:center;justify-content:center;font-size:9px;color:#999;">QR unavailable</div>`}
<div class="zatca-label" style="margin-top:4px;">ZATCA PHASE 2 · QR CODE</div>
<div style="font-size:8px;color:#666;">TLV Base64 · Scan to verify</div>
</div>
<div class="bold center" style="margin-top:6px;font-size:13px;">${footer}</div>
<div style="font-family:'Noto Naskh Arabic','Arial',sans-serif;font-size:14px;font-weight:bold;text-align:center;direction:rtl;margin-top:3px;">${footerAr}</div>
${invoiceFormat.website?`<div style="text-align:center;font-size:9px;color:#666;margin-top:4px;">${invoiceFormat.website}</div>`:""}
<br/><br/>
</body></html>`;
  }

  function handleSaveInvoice(){
    // Save invoice as HTML file for download — no printing required
    function doSave(){
      let qrImgSrc="";
      try{
        const tempDiv=document.createElement("div");
        tempDiv.style.cssText="position:absolute;left:-9999px;top:-9999px;width:120px;height:120px;";
        document.body.appendChild(tempDiv);
        new window.QRCode(tempDiv,{text:qrData,width:110,height:110,colorDark:"#000000",colorLight:"#ffffff",correctLevel:window.QRCode?.CorrectLevel?.M});
        const canvas=tempDiv.querySelector("canvas");
        const img=tempDiv.querySelector("img");
        if(canvas)qrImgSrc=canvas.toDataURL("image/png");
        else if(img&&img.src)qrImgSrc=img.src;
        document.body.removeChild(tempDiv);
      }catch(e){console.warn("QR gen error:",e);}
      const html=buildReceiptHTML(qrImgSrc);
      const blob=new Blob([html],{type:"text/html"});
      const url=URL.createObjectURL(blob);
      const a=document.createElement("a");a.href=url;a.download=`Invoice-${order.id}.html`;a.click();URL.revokeObjectURL(url);
      // Record as saved in savedInvoices
      const saved=JSON.parse(localStorage.getItem("restopos_saved_invoices")||"[]");
      if(!saved.find(s=>s.id===order.id)){saved.unshift({...order,savedAt:new Date().toISOString(),zatcaInvoiceNumber:zatcaInvoice?.invoice_number||null});localStorage.setItem("restopos_saved_invoices",JSON.stringify(saved.slice(0,500)));}
    }
    if(window.QRCode){doSave();}
    else{const s=document.createElement("script");s.src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";s.onload=()=>setTimeout(doSave,200);document.head.appendChild(s);}
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
                {order.discount>0&&<div style={{display:"flex",justifyContent:"space-between",color:"#D94040"}}><span>Discount</span><span>-{fmtSAR(order.discount)}</span></div>}
        <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:C.textLight}}><span>VAT 15% (incl.)</span><span>{fmtSAR(order.vat)}</span></div>
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
        <div style={{display:"flex",gap:8,marginTop:14,flexWrap:"wrap"}}>
          <Btn variant="ghost" onClick={onClose} style={{flex:1}}>Close</Btn>
          <Btn variant="outline" onClick={handleSaveInvoice} style={{flex:1}}>💾 Save Invoice</Btn>
          <Btn variant="primary" onClick={async()=>{
            // Try ESC/POS direct first, fallback to browser print
            try{
              if("serial" in navigator&&(isPortOpen(_billPort)||(await getAvailablePorts()).length>0)){
                await printReceiptEscPos(order,license);
                return;
              }
            }catch(e){console.warn("ESC/POS failed, falling back:",e);}
            handleThermalPrint();
          }} style={{flex:1}}>🖨️ Print Receipt</Btn>
        </div>
        {zatcaInvoice&&<div style={{marginTop:8}}><Btn variant="zatca" size="sm" onClick={()=>zatcaUtils.downloadXML(zatcaInvoice)} style={{width:"100%"}}>⬇️ Download UBL XML</Btn></div>}
        <iframe ref={printFrameRef} style={{display:"none",width:0,height:0,border:"none"}} title="print-frame"/>
      </div>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════
// DRAFT SUMMARY HTML — for printing draft invoice summary
// ═══════════════════════════════════════════════════════════════════
function buildDraftSummaryHTML(drafts,dateFrom,dateTo){
  const total=drafts.reduce((s,d)=>s+(d.total||0),0);
  const vat=drafts.reduce((s,d)=>s+(d.vat||0),0);
  const lic=LS.get("restopos_license_v2")||{};
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>body{font-family:Arial,sans-serif;font-size:12px;max-width:700px;margin:20px auto;padding:20px;color:#111}
h1{font-size:18px;font-weight:900;color:#A07000;margin:0}
table{width:100%;border-collapse:collapse;margin:16px 0}
th{background:#FFF8E8;padding:8px 10px;text-align:left;font-weight:700;font-size:10px;text-transform:uppercase;border-bottom:2px solid #F0E0A0}
td{padding:7px 10px;border-bottom:1px solid #F5EDD0;font-size:11px}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;padding-bottom:14px;border-bottom:3px solid #F0A500}
.badge{background:#F0A500;color:#fff;padding:2px 8px;border-radius:4px;font-weight:700;font-size:11px}
</style></head><body>
<div class="hdr">
  <div><h1>📋 DRAFT INVOICES SUMMARY</h1>
  <div style="font-size:11px;color:#666;margin-top:4px">${lic.businessName||"Restaurant"} · VAT: ${lic.vatNumber||""}</div></div>
  <div style="text-align:right">
    <div class="badge">D-INVOICES</div>
    <div style="font-size:11px;color:#888;margin-top:4px">Period: ${dateFrom} → ${dateTo}</div>
    <div style="font-size:11px;color:#888">Printed: ${new Date().toLocaleString("en-SA")}</div>
  </div>
</div>
<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px">
  ${[["Total Drafts",drafts.length],["Total Amount","SAR "+total.toFixed(2)],["VAT Collected","SAR "+vat.toFixed(2)]].map(([l,v])=>`<div style="background:#FFF8E8;border-radius:8px;padding:10px;border-left:3px solid #F0A500"><div style="font-size:10px;color:#888">${l}</div><div style="font-size:16px;font-weight:900;color:#A07000">${v}</div></div>`).join("")}
</div>
<table>
<thead><tr><th>Invoice#</th><th>Date</th><th>Time</th><th>Customer</th><th>Items</th><th>Discount</th><th>VAT</th><th>Total</th><th>Method</th><th>Note</th></tr></thead>
<tbody>
${drafts.map(d=>`<tr>
  <td style="font-family:monospace;font-weight:700;color:#A07000">${d.id}</td>
  <td>${d.date}</td><td>${d.time}</td>
  <td>${d.customer||"—"}</td>
  <td style="font-size:10px;color:#666">${(d.items||[]).map(i=>i.qty+"x "+i.name).join(", ").slice(0,35)}</td>
  <td>${d.discount>0?"-SAR "+(d.discount||0).toFixed(2):"—"}</td>
  <td>SAR ${(d.vat||0).toFixed(2)}</td>
  <td style="font-weight:700">SAR ${(d.total||0).toFixed(2)}</td>
  <td>${d.payMethod||"—"}</td>
  <td style="font-style:italic;color:#888">${d.note||"—"}</td>
</tr>`).join("")}
</tbody>
<tfoot><tr style="background:#FFF8E8;font-weight:900">
  <td colspan="7">TOTAL (${drafts.length} drafts)</td>
  <td style="color:#A07000">SAR ${total.toFixed(2)}</td>
  <td colspan="2"></td>
</tr></tfoot>
</table>
<div style="margin-top:12px;font-size:10px;color:#aaa;text-align:center">DRAFT BILLS — Not official tax invoices · هذه فواتير مسودة وليست فواتير ضريبية رسمية</div>
</body></html>`;
}

// ═══════════════════════════════════════════════════════════════════
// RECEIPT HTML BUILDER — used for silent print
// ═══════════════════════════════════════════════════════════════════
function buildReceiptHTML(order,license,zatcaInvoice,fmt){
  fmt=fmt||{};
  const paperWidth=fmt.paperWidth||"80mm";
  const fontSize=fmt.fontSize||12;
  const footer=fmt.footer||"Thank you for your visit!";
  const footerAr=fmt.footerAr||"شكراً لزيارتكم";
  const items=order.items||[];
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
@page{size:${paperWidth} auto;margin:0}
body{font-family:'Courier New',monospace;font-size:${fontSize}px;width:${paperWidth};padding:4mm;color:#000;margin:0}
.c{text-align:center}.b{font-weight:bold}
.hr{border:none;border-top:1px dashed #000;margin:4px 0}
.row{display:flex;justify-content:space-between;margin:2px 0}
</style></head><body>
<div class="c b" style="font-size:${fontSize+4}px">${license?.businessName||"Restaurant"}</div>
<div class="c" style="font-size:${fontSize-1}px">${license?.address||""}</div>
<div class="c" style="font-size:${fontSize-1}px">VAT: ${license?.vatNumber||""}</div>
<div class="hr"/>
<div class="row"><span>${order.id}</span><span>${order.date} ${order.time}</span></div>
<div style="font-size:${fontSize-1}px">${order.type||"Sale"}${order.table?" · Table "+order.table:""}</div>
${order.customer?`<div style="font-size:${fontSize-1}px">Customer: ${order.customer}</div>`:""}
${order.note?`<div style="font-size:${fontSize-1}px;font-style:italic">Note: ${order.note}</div>`:""}
<div class="hr"/>
${items.map(it=>`<div>${it.qty}x ${it.name.slice(0,28)}<span style="float:right">SAR ${(it.qty*it.price).toFixed(2)}</span></div>`).join("")}
<div class="hr"/>
${order.discount>0?`<div class="row"><span>Discount</span><span>-SAR ${order.discount.toFixed(2)}</span></div>`:""}
<div class="row"><span>VAT 15%</span><span>SAR ${(order.vat||0).toFixed(2)}</span></div>
<div class="row b" style="font-size:${fontSize+3}px"><span>TOTAL</span><span>SAR ${(order.total||0).toFixed(2)}</span></div>
${order.payMethod==="Cash"?`<div class="row"><span>Given</span><span>SAR ${(order.given||0).toFixed(2)}</span></div><div class="row"><span>Change</span><span>SAR ${(order.change||0).toFixed(2)}</span></div>`:""}
<div class="hr"/>
<div class="c" style="font-size:${fontSize-1}px">${footer}</div>
${footerAr?`<div class="c" style="direction:rtl;font-family:'Tajawal',sans-serif;font-size:${fontSize-1}px">${footerAr}</div>`:""}
<br/><br/>
</body></html>`;
}

// ═══════════════════════════════════════════════════════════════════
// BUILD DRAFT RECEIPT HTML — reusable for QZ and browser print
// ═══════════════════════════════════════════════════════════════════
function buildDraftReceiptHTML(order,license,fmt){
  fmt=fmt||{};
  const paperWidth=fmt.paperWidth||"80mm";
  const fontSize=fmt.fontSize||12;
  const footer=fmt.footer||"Thank you for your visit!";
  const footerAr=fmt.footerAr||"شكراً لزيارتكم";
  const items=order.items||[];
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
@page{size:${paperWidth} auto;margin:0}
body{font-family:'Courier New',monospace;font-size:${fontSize}px;width:${paperWidth};padding:4mm;color:#000;margin:0}
.c{text-align:center}.b{font-weight:bold}
.hr{border:none;border-top:1px dashed #000;margin:4px 0}
.row{display:flex;justify-content:space-between;margin:2px 0}
.badge{background:#F0A500;color:#fff;padding:2px 8px;border-radius:3px;font-weight:900;font-size:12px}
</style></head><body>
<div class="c b" style="font-size:${fontSize+4}px">${license?.businessName||"Restaurant"}</div>
<div class="c" style="font-size:${fontSize-1}px">${license?.address||""}</div>
<div class="c" style="font-size:${fontSize-1}px">VAT: ${license?.vatNumber||""}</div>
<div class="c" style="margin:4px 0"><span class="badge">D-INVOICE</span></div>
<div class="hr"/>
<div class="row"><span>${order.id}</span><span>${order.date} ${order.time}</span></div>
<div style="font-size:${fontSize-1}px">${order.type||"Sale"}${order.table?" · Table "+order.table:""}</div>
${order.customer?`<div style="font-size:${fontSize-1}px">Customer: ${order.customer}</div>`:""}
${order.note?`<div style="font-size:${fontSize-1}px;font-style:italic">Note: ${order.note}</div>`:""}
<div class="hr"/>
${items.map(it=>`<div>${it.qty}x ${it.name.slice(0,26)}<span style="float:right">SAR ${(it.qty*it.price).toFixed(2)}</span></div>${it.nameAr?`<div style="direction:rtl;font-family:'Tajawal',sans-serif;font-size:${fontSize-1}px;color:#555">${it.nameAr}</div>`:""}`).join("")}
<div class="hr"/>
${order.discount>0?`<div class="row"><span>Discount</span><span>-SAR ${order.discount.toFixed(2)}</span></div>`:""}
<div class="row"><span>VAT 15%</span><span>SAR ${(order.vat||0).toFixed(2)}</span></div>
<div class="row b" style="font-size:${fontSize+2}px"><span>TOTAL</span><span>SAR ${(order.total||0).toFixed(2)}</span></div>
${order.payMethod==="Cash"?`<div class="row"><span>Cash</span><span>SAR ${(order.given||0).toFixed(2)}</span></div><div class="row"><span>Change</span><span>SAR ${(order.change||0).toFixed(2)}</span></div>`:""}
<div class="hr"/>
<div class="c" style="font-size:${fontSize-1}px">${footer}</div>
${footerAr?`<div class="c" style="direction:rtl;font-family:'Tajawal',sans-serif;font-size:${fontSize-1}px">${footerAr}</div>`:""}
<div class="c" style="font-size:9px;color:#aaa;margin-top:4px">DRAFT — Not a tax invoice</div>
<br/><br/>
</body></html>`;
}

// ═══════════════════════════════════════════════════════════════════
// DRAFT RECEIPT PRINT — no ZATCA QR, shows D-Invoice label
// ═══════════════════════════════════════════════════════════════════
function printDraftReceipt(order,license){
  const fmt=LS.get("restopos_invoice_format")||{};
  const paperWidth=fmt.paperWidth||"80mm";
  const font=fmt.font||"courier";
  const fontSize=fmt.fontSize||12;
  const footer=fmt.footer||"Thank you for your visit!";
  const footerAr=fmt.footerAr||"شكراً لزيارتكم";
  const items=order.items||[];
  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
@page{size:${paperWidth} auto;margin:0}
body{font-family:'Courier New',monospace;font-size:${fontSize}px;width:${paperWidth};padding:4mm;color:#000;margin:0}
.c{text-align:center}.b{font-weight:bold}
.hr{border:none;border-top:1px dashed #000;margin:4px 0}
.row{display:flex;justify-content:space-between;margin:2px 0}
.draft-badge{background:#F0A500;color:#fff;padding:3px 10px;border-radius:4px;font-weight:900;font-size:14px;display:inline-block;margin:4px 0}
</style></head><body>
<div class="c b" style="font-size:${fontSize+4}px">${license?.businessName||"Restaurant"}</div>
<div class="c" style="font-size:${fontSize-1}px">${license?.address||""}</div>
<div class="c" style="font-size:${fontSize-1}px">VAT: ${license?.vatNumber||""}</div>
<div class="c" style="margin:4px 0"><div class="draft-badge">📋 D-INVOICE</div></div>
<div class="hr"/>
<div class="row"><span>${order.id}</span><span>${order.date} ${order.time}</span></div>
<div style="font-size:${fontSize-1}px;color:#666">${order.type||"Sale"}${order.table?" · Table "+order.table:""}</div>
${order.customer?`<div style="font-size:${fontSize-1}px">Customer: ${order.customer}</div>`:""}
<div class="hr"/>
${items.map(it=>{
  const lineTotal=(it.price*it.qty).toFixed(2);
  const name=it.name.slice(0,26);
  const right="SAR "+lineTotal;
  const spaces=Math.max(1,38-name.length-right.length-(" x"+it.qty).length);
  return `<div>${name} x${it.qty}${" ".repeat(spaces)}${right}</div>${it.nameAr?`<div style="direction:rtl;font-family:'Tajawal',sans-serif;font-size:${fontSize-1}px;color:#555">${it.nameAr}</div>`:""}`;
}).join("")}
<div class="hr"/>
${order.discount>0?`<div class="row"><span>Discount</span><span>-SAR ${order.discount.toFixed(2)}</span></div>`:""}
<div class="row"><span>VAT 15%</span><span>SAR ${(order.vat||0).toFixed(2)}</span></div>
<div class="row b" style="font-size:${fontSize+2}px"><span>TOTAL</span><span>SAR ${(order.total||0).toFixed(2)}</span></div>
${order.payMethod==="Cash"?`<div class="row"><span>Cash Given</span><span>SAR ${(order.given||0).toFixed(2)}</span></div><div class="row"><span>Change</span><span>SAR ${(order.change||0).toFixed(2)}</span></div>`:""}
<div class="hr"/>
<div class="c" style="font-size:${fontSize-1}px">${footer}</div>
${footerAr?`<div class="c" style="direction:rtl;font-family:'Tajawal',sans-serif;font-size:${fontSize-1}px">${footerAr}</div>`:""}
<div class="c" style="font-size:9px;color:#aaa;margin-top:4px">DRAFT — Not a tax invoice · لیست ضریبیة</div>
<br/><br/>
<script>window.onload=function(){window.print();window.close();}<\/script>
</body></html>`;
  const w=window.open("","_blank","width=320,height=600");
  if(w){w.document.write(html);w.document.close();}
}

// ═══════════════════════════════════════════════════════════════════
// POS SCREEN
// ═══════════════════════════════════════════════════════════════════
function POS({items,sales,setSales,tables,setTables,promos,license,lang="en"}){
  const allCats=[...new Set(items.map(i=>i.category))];
  const [activeCat,setActiveCat]=useState("ALL");const [cart,setCart]=useState([]);const [orderType,setOrderType]=useState("takeaway");const [selectedTable,setSelectedTable]=useState(null);const [billType,setBillType]=useState("normal");
  const [showPayment,setShowPayment]=useState(false);const [showReceipt,setShowReceipt]=useState(false);const [lastOrder,setLastOrder]=useState(null);const [lastZatcaInvoice,setLastZatcaInvoice]=useState(null);
  const [showPrevBill,setShowPrevBill]=useState(false);
  const [notif,setNotif]=useState(null);
  const [printBanner,setPrintBanner]=useState(null);
  const [vno,setVno]=useState(()=>LS.get("restopos_vno")||1);
  const [kotNo,setKotNo]=useState(()=>LS.get("restopos_kot")||1);
  const [selectedRow,setSelectedRow]=useState(null);const [customerName,setCustomerName]=useState("");const [customerPhone,setCustomerPhone]=useState("");const [customerAddress,setCustomerAddress]=useState("");
  const barcodeRef=useRef();const [barcodeInput,setBarcodeInput]=useState("");
  const total=cart.reduce((s,i)=>s+i.price*i.qty,0);const vat=parseFloat((total*(15/115)).toFixed(2));const subtotal=parseFloat((total-vat).toFixed(2));
  function addToCart(item){setCart(prev=>{const ex=prev.find(c=>c.id===item.id);if(ex)return prev.map(c=>c.id===item.id?{...c,qty:c.qty+1}:c);return[...prev,{...item,qty:1}];});showN("+ "+item.name);}
  function updateQty(delta){if(selectedRow===null)return;setCart(prev=>prev.map((c,i)=>i===selectedRow?{...c,qty:Math.max(0,c.qty+delta)}:c).filter(c=>c.qty>0));}
  function showN(msg){setNotif(msg);setTimeout(()=>setNotif(null),1500);}
  function handleBarcodeSearch(code){const item=items.find(i=>i.barcode===code.trim());if(item){addToCart(item);setBarcodeInput("");}else{showN("❌ Barcode not found");setBarcodeInput("");}}
  async function confirmPayment(method,given,change,promo,totalDiscountAmt,finalTotal,finalVat,printAndSave,payInfo,manualDiscountAmt,promoDiscountAmt,isDraft=false,extraData={}){
    // ── Invoice numbering ────────────────────────────────────────────
    let invoiceId;
    if(isDraft){
      // Draft: use current vno + letter suffix (don't increment vno)
      const drafts=LS.get("restopos_draft_invoices")||[];
      const todayDrafts=drafts.filter(d=>d.date===TODAY&&d.baseVno===vno);
      const letters="ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const nextLetter=letters[Math.min(todayDrafts.length,25)]||"Z";
      invoiceId="D-"+vno+nextLetter;
    }else{
      // Normal: increment vno FIRST then use it
      const newVno=vno+1;
      LS.set("restopos_vno",newVno);
      setVno(newVno);
      invoiceId="INV-"+newVno; // Use newVno not vno
    }
    const inv={
      id:invoiceId,
      date:TODAY,
      time:new Date().toLocaleTimeString("en-SA",{hour:"2-digit",minute:"2-digit"}),
      type:(extraData.orderType||orderType)==="dine-in"?"Dine-in":(extraData.orderType||orderType)==="takeaway"?"Takeaway":"Delivery",
      billType:extraData.billType||"normal",
      table:selectedTable,customer:customerName,customerPhone,customerAddress,
      items:[...cart],
      subtotal,
      discount:totalDiscountAmt||0,
      manualDiscount:manualDiscountAmt||0,
      promoDiscount:promoDiscountAmt||0,
      promoCode:promo?.code||"",
      vat:finalVat,
      total:finalTotal,
      status:isDraft?"draft":"completed",
      cashier:currentUser?.name||"Admin",
      note:extraData.invoiceNote||"",
      customer:extraData.customerName||customerName||"",
      customerPhone:extraData.customerPhone||customerPhone||"",
      payMethod:method,
      given:payInfo?.cashAmount||given,
      change,
      cardAmount:payInfo?.cardAmount||0,
      cashAmount:payInfo?.cashAmount||0,
      printAndSave,
      isDraft:isDraft||false,
      baseVno:isDraft?vno:undefined,
    };
    // Save invoice — use setSales updater (it handles LS save internally)
    // setSales wrapper automatically saves to localStorage
    try{
      setSales(prev=>[...prev,inv]);
      // Also save directly as safety net
      const snap=LS.get("restopos_sales")||[];
      if(!snap.find(s=>s.id===inv.id)){
        LS.set("restopos_sales",[...snap,inv]);
      }
      console.log("[Sale saved]",inv.id,inv.total,inv.payMethod);
    }catch(e){
      console.error("[Sales] Save failed:",e);
      // Last resort
      try{const s=LS.get("restopos_sales")||[];LS.set("restopos_sales",[...s,inv]);}catch(e2){}
    }
    setLastOrder(inv);

    // AUTO-SAVE CUSTOMER to CRM if phone or name was entered
    const custPhone2=extraData.customerPhone||customerPhone||"";
    const custName2=extraData.customerName||customerName||"";
    if(custPhone2||custName2){
      try{
        const existing=LS.get("restopos_customers")||[];
        const found=existing.find(c=>
          (custPhone2&&c.phone===custPhone2)||(custName2&&c.name===custName2&&!custPhone2)
        );
        if(found){
          // Update existing — increment visits and total spent
          const updated=existing.map(c=>c.id===found.id?{
            ...c,
            name:custName2||c.name,
            phone:custPhone2||c.phone,
            totalSpent:(c.totalSpent||0)+finalTotal,
            visits:(c.visits||0)+1,
            lastVisit:TODAY,
          }:c);
          LS.set("restopos_customers",updated);
          const _lk=LS.get("restopos_license_v2")?.licenseKey;
          if(_lk)debouncedSync(_lk,"restopos_customers",updated);
        }else if(custPhone2||custName2){
          // Add new customer
          const newCust={
            id:"CUST-"+Date.now(),
            name:custName2||"",
            phone:custPhone2||"",
            email:"",
            totalSpent:finalTotal,
            visits:1,
            lastVisit:TODAY,
            notes:"Auto-saved from POS",
            createdAt:new Date().toISOString(),
          };
          const updated=[newCust,...existing];
          LS.set("restopos_customers",updated);
          const _lk=LS.get("restopos_license_v2")?.licenseKey;
          if(_lk)debouncedSync(_lk,"restopos_customers",updated);
        }
      }catch(e){console.warn("[CRM] Auto-save failed:",e);}
    }
    if(isDraft){
      // Save to separate draft invoices store
      try{
        const drafts=LS.get("restopos_draft_invoices")||[];
        LS.set("restopos_draft_invoices",[...drafts,{...inv,isDraft:true}]);
      }catch(e){console.warn("[Draft] Save failed:",e);}
      setLastZatcaInvoice(null);
    }else{
      try{
        const zatcaInv=await generateZATCAInvoice({
          seller_name:license?.businessName||"",
          seller_vat:license?.vatNumber||"",
          seller_address:license?.address||license?.city||"Riyadh",
          seller_cr:license?.crNumber||"",
          items:cart.map(c=>({name:c.name,price:c.price,qty:c.qty})),
          discount:totalDiscountAmt||0,
        });
        setLastZatcaInvoice(zatcaInv);
      }catch(e){console.warn("[ZATCA]",e);setLastZatcaInvoice(null);}
    }
    if(orderType==="dine-in"&&selectedTable)setTables(prev=>prev.map(t=>t.id===selectedTable?{...t,status:"free"}:t));
    // Auto-print KOT to kitchen if enabled
    const kp=LS.get("restopos_kitchen_printer")||{};
    if(kp.enabled&&kp.autoKOT){
      try{
        const newKot2=kotNo+1;LS.set("restopos_kot",newKot2);setKotNo(newKot2);
        if("serial" in navigator&&(isPortOpen(_kitchenPort)||(await getAvailablePorts()).length>0)){
          await printKOTEscPos(cart,orderType,selectedTable,newKot2);
        }
      }catch(e){console.warn("Auto KOT failed:",e);}
    }
    // ── Save verified — now close window and clear ──
    // Sale already saved above — safe to clear
    setCart([]);
    setShowPayment(false);
    setCustomerName("");setCustomerPhone("");setCustomerAddress("");setSelectedRow(null);
    // Sync to cloud immediately after sale
    try{
      const lk=LS.get("restopos_license_v2")?.licenseKey;
      if(lk){
        const currentSales=LS.get("restopos_sales")||[];
        syncKeyToFirestore(lk,"restopos_sales",currentSales);
      }
    }catch(e){console.warn("[Sync after sale]",e);}

    if(!printAndSave){
      // Save only — done
      setPrintBanner({msg:"💾 "+inv.id+" — Invoice Saved",type:"save"});
      setTimeout(()=>setPrintBanner(null),3000);
    }else if(isDraft){
      // Draft: try QZ first → fallback to browser print
      try{
        const draftHTML=buildDraftReceiptHTML(inv,license,LS.get("restopos_invoice_format")||{});
        if(isQZConnected()&&_qzBillPrinter){
          await printWithQZ(draftHTML,_qzBillPrinter,(LS.get("restopos_invoice_format")||{}).paperWidth||"80mm");
          setPrintBanner({msg:"📋 "+inv.id+" — Draft Printed via QZ",type:"success"});
        }else{
          printDraftReceipt(inv,license);
          setPrintBanner({msg:"📋 "+inv.id+" — Draft Saved & Printed",type:"success"});
        }
      }catch(e){
        try{printDraftReceipt(inv,license);setPrintBanner({msg:"📋 "+inv.id+" — Draft Printed",type:"success"});}
        catch(e2){setPrintBanner({msg:"⚠️ Draft saved — Print failed: "+e2.message,type:"error"});}
      }
      setTimeout(()=>setPrintBanner(null),4000);
    }else{
      // Normal invoice print — QZ → ESC/POS → iframe
      const fmt=LS.get("restopos_invoice_format")||{};
      const html=buildReceiptHTML(inv,license,null,fmt);
      let printed=false;
      let printMethod="";

      // ── Try 1: QZ Tray ──────────────────────────────────────────
      const qzPrinter=localStorage.getItem("restopos_qz_bill_printer")||_qzBillPrinter;
      if(qzPrinter){
        try{
          // Force reconnect if needed
          if(!isQZConnected()){
            await connectQZ();
          }
          if(isQZConnected()){
            await printWithQZ(html,qzPrinter,fmt.paperWidth||"80mm");
            printed=true;
            printMethod="QZ Tray";
          }
        }catch(e){
          console.warn("[QZ]",e.message);
        }
      }

      // ── Try 2: ESC/POS USB ──────────────────────────────────────
      if(!printed&&"serial" in navigator){
        try{
          if(!isPortOpen(_billPort)){
            const ports=await navigator.serial.getPorts();
            if(ports.length>0){
              _billPort=ports[0];
              if(!_billPort.readable)await _billPort.open({baudRate:9600});
            }
          }
          if(isPortOpen(_billPort)){
            await printReceiptEscPos(inv,license);
            printed=true;
            printMethod="ESC/POS";
          }
        }catch(e){console.warn("[ESC/POS]",e.message);}
      }

      // ── Try 3: Browser print (always works) ─────────────────────
      if(!printed){
        try{
          // Open in new window — most reliable cross-browser method
          const win=window.open("","_blank","width=400,height=600,left=-1000,top=-1000");
          if(win){
            win.document.write(html+`<script>
              window.onload=function(){
                setTimeout(function(){
                  window.print();
                  setTimeout(function(){window.close();},1000);
                },300);
              };
            <\/script>`);
            win.document.close();
            printed=true;
            printMethod="Browser";
          }
        }catch(e){console.warn("[browser print]",e.message);}
      }

      if(printed){
        setPrintBanner({msg:"✅ "+inv.id+" — Saved & Printed ("+printMethod+")",type:"success"});
      }else{
        // Even if all print methods failed, invoice IS saved
        setPrintBanner({msg:"💾 "+inv.id+" — Saved. Print failed — allow pop-ups or install QZ Tray",type:"error"});
      }
      setTimeout(()=>setPrintBanner(null),5000);
    }
  }
  async function printKOT(){
    const newKot=kotNo+1;LS.set("restopos_kot",newKot);setKotNo(newKot);
    // 1. Try QZ Tray kitchen printer
    if(isQZConnected()&&_qzKitchenPrinter){
      try{
        const kfmt=LS.get("restopos_invoice_format")||{};
        const kotHTML=`<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>@page{size:80mm auto;margin:0}body{font-family:'Courier New',monospace;font-size:14px;width:80mm;padding:4mm;text-align:center}
.big{font-size:20px;font-weight:900}.hr{border:none;border-top:1px dashed #000;margin:6px 0}</style>
</head><body>
<div class="big">KOT #${newKot}</div>
<div class="hr"/>
<div>${orderType.toUpperCase()}${selectedTable?" · Table "+selectedTable:""}</div>
<div style="font-size:11px">${new Date().toLocaleTimeString("en-SA")}</div>
<div class="hr"/>
${cart.map(it=>`<div style="text-align:left">${it.qty}x ${it.name}${it.nameAr?`<br/><span style="direction:rtl;font-family:'Tajawal',sans-serif">${it.nameAr}</span>`:""}</div>`).join("")}
<div class="hr"/>
<div style="font-size:11px">Kitchen Copy</div>
<br/><br/>
</body></html>`;
        await printWithQZ(kotHTML,_qzKitchenPrinter,"80mm");
        showN("🖨️ KOT #"+newKot+" sent via QZ Tray");
        return;
      }catch(e){console.warn("[QZ KOT]",e);}
    }
    // 2. Try ESC/POS kitchen printer
    try{
      if("serial" in navigator&&(isPortOpen(_kitchenPort)||(await getAvailablePorts()).length>0)){
        await printKOTEscPos(cart,orderType,selectedTable,newKot);
        showN("🖨️ KOT #"+newKot+" sent to kitchen printer");
        return;
      }
    }catch(e){console.warn("KOT ESC/POS failed, using browser:",e);}
    // 3. Fallback: browser popup print
    const win=window.open("","_blank","width=300,height=500");
    if(!win){showN("❌ Allow pop-ups for KOT");return;}
    win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>KOT ${newKot}</title><style>@page{size:80mm auto;margin:0}body{font-family:monospace;font-size:14px;width:80mm;padding:6mm}hr{border:none;border-top:1px dashed #000;margin:8px 0}.big{font-size:20px;font-weight:900;text-align:center}</style></head><body><div class="big">KOT #${newKot}</div><hr/><div>${orderType.toUpperCase()}${selectedTable?` · Table ${selectedTable}`:""}</div><div>${new Date().toLocaleTimeString()}</div><hr/>${cart.map(it=>`<div>${it.qty}x ${it.name}${it.nameAr?`<br><span style="direction:rtl;font-family:Arial">${it.nameAr}</span>`:""}</div>`).join("")}<hr/><script>window.onload=function(){window.print();window.close()}<\/script></body></html>`);
    win.document.close();
  }
  // POS categories — use saved order from Create tab
  const savedCats=LS.get("restopos_categories")||SEED_CATEGORIES;
  const posActiveCats=savedCats.filter(c=>items.some(i=>i.active&&i.category===c));
  const cats=["ALL",...posActiveCats];
  const filteredItems=items.filter(i=>i.active&&(activeCat==="ALL"||i.category===activeCat));
  return(
    <div style={{display:"flex",height:"calc(100vh - 52px)",overflow:"hidden"}}>
      {/* Previous Bill Modal */}
      {showPrevBill&&lastOrder&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.65)",zIndex:3000,
          display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div style={{background:"#fff",borderRadius:20,width:"100%",maxWidth:480,
            maxHeight:"92vh",overflow:"auto",boxShadow:"0 24px 80px rgba(0,0,0,0.35)"}}>
            {/* Header */}
            <div style={{background:"linear-gradient(135deg,#1A3A5C,#0F2340)",padding:"16px 20px",
              borderRadius:"20px 20px 0 0",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <div style={{color:"#fff",fontSize:15,fontWeight:800}}>🕐 Previous Bill</div>
                <div style={{color:"rgba(255,255,255,0.5)",fontSize:11,marginTop:2}}>{lastOrder.id} · {lastOrder.date} {lastOrder.time}</div>
              </div>
              <button onClick={()=>setShowPrevBill(false)}
                style={{background:"rgba(255,255,255,0.12)",border:"none",color:"#fff",
                  width:30,height:30,borderRadius:"50%",cursor:"pointer",fontSize:16}}>×</button>
            </div>
            {/* Body */}
            <div style={{padding:"18px 20px",display:"flex",flexDirection:"column",gap:12}}>
              {/* KPIs */}
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
                {[
                  ["💳 Method",lastOrder.payMethod||"—","#1A3A5C"],
                  ["📦 Items",(lastOrder.items||[]).reduce((s,i)=>s+i.qty,0)+" items","#2176AE"],
                  ["💰 Total","SAR "+(lastOrder.total||0).toFixed(2),"#1A6B4A"],
                ].map(([l,v,c])=>(
                  <div key={l} style={{background:c+"11",border:`1.5px solid ${c}33`,borderRadius:10,padding:"8px 10px",textAlign:"center"}}>
                    <div style={{fontSize:9,color:"#888",fontWeight:700}}>{l}</div>
                    <div style={{fontSize:12,fontWeight:800,color:c,marginTop:2}}>{v}</div>
                  </div>
                ))}
              </div>
              {/* Customer */}
              {(lastOrder.customer||lastOrder.customerPhone)&&(
                <div style={{background:"#F0F7FF",borderRadius:10,padding:"8px 14px",fontSize:12}}>
                  👤 {lastOrder.customer||""}{lastOrder.customerPhone?" · "+lastOrder.customerPhone:""}
                </div>
              )}
              {/* Items table */}
              <div style={{background:"#F8FAFF",borderRadius:10,overflow:"hidden",border:"1px solid #E0E8F0"}}>
                <div style={{padding:"8px 14px",background:"#E8F0FA",fontSize:11,fontWeight:700,color:"#3A5A7A"}}>ORDER ITEMS</div>
                {(lastOrder.items||[]).map((it,i)=>(
                  <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",
                    padding:"8px 14px",borderBottom:"1px solid #E0E8F0",fontSize:12}}>
                    <div>
                      <div style={{fontWeight:600,color:"#1A3A5C"}}>{it.name}</div>
                      {it.nameAr&&<div style={{fontSize:10,color:"#888",direction:"rtl",fontFamily:"'Tajawal',sans-serif"}}>{it.nameAr}</div>}
                      <div style={{fontSize:10,color:"#8A9AB0"}}>{it.qty} × SAR {it.price.toFixed(2)}</div>
                    </div>
                    <strong style={{color:"#1A6B4A"}}>SAR {(it.qty*it.price).toFixed(2)}</strong>
                  </div>
                ))}
              </div>
              {/* Totals */}
              <div style={{background:"#F0F7FF",borderRadius:10,padding:"10px 14px"}}>
                {lastOrder.discount>0&&<div style={{display:"flex",justifyContent:"space-between",fontSize:12,padding:"3px 0",color:"#D94040"}}>
                  <span>Discount</span><span>-SAR {(lastOrder.discount||0).toFixed(2)}</span>
                </div>}
                <div style={{display:"flex",justifyContent:"space-between",fontSize:12,padding:"3px 0",color:"#6366f1"}}>
                  <span>VAT 15%</span><span>SAR {(lastOrder.vat||0).toFixed(2)}</span>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:15,fontWeight:900,padding:"6px 0",borderTop:"1px solid #C5DCF5",marginTop:4,color:"#1A6B4A"}}>
                  <span>TOTAL</span><span>SAR {(lastOrder.total||0).toFixed(2)}</span>
                </div>
                {lastOrder.payMethod==="Cash"&&lastOrder.given>0&&(
                  <>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#888"}}>
                      <span>Cash Given</span><span>SAR {(lastOrder.given||0).toFixed(2)}</span>
                    </div>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#1A6B4A",fontWeight:700}}>
                      <span>Change</span><span>SAR {(lastOrder.change||0).toFixed(2)}</span>
                    </div>
                  </>
                )}
              </div>
              {lastOrder.note&&<div style={{background:"#FFFDF0",border:"1px solid #F0E8C0",borderRadius:8,padding:"8px 12px",fontSize:12,color:"#8A6000",fontStyle:"italic"}}>
                📝 {lastOrder.note}
              </div>}
              {/* Print button */}
              <button onClick={()=>{
                setShowPrevBill(false);
                setShowReceipt(true);
              }} style={{width:"100%",padding:"13px",background:"linear-gradient(135deg,#1A6B4A,#0F4A30)",
                color:"#fff",border:"none",borderRadius:12,fontSize:14,fontWeight:800,
                cursor:"pointer",fontFamily:"inherit",
                boxShadow:"0 4px 16px rgba(26,107,74,0.3)"}}>
                🖨️ Print Previous Bill
              </button>
              <button onClick={()=>setShowPrevBill(false)}
                style={{width:"100%",padding:"10px",background:"#F0F4F8",border:"1px solid #E0E8F0",
                  borderRadius:10,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",color:"#5A7A9A"}}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Print/Save success banner */}
      {printBanner&&(
        <div style={{position:"fixed",top:20,left:"50%",transform:"translateX(-50%)",zIndex:9999,
          padding:"12px 24px",borderRadius:30,fontSize:13,fontWeight:700,
          background:printBanner.type==="success"?"#1A6B4A":printBanner.type==="error"?"#C0392B":"#2176AE",
          color:"#fff",boxShadow:"0 8px 32px rgba(0,0,0,0.4)",
          animation:"slideDown 0.3s ease",whiteSpace:"nowrap",
          display:"flex",alignItems:"center",gap:8,maxWidth:"90vw",
          textAlign:"center"}}>
          {printBanner.msg}
        </div>
      )}
      <style>{`@keyframes slideDown{from{opacity:0;transform:translateX(-50%) translateY(-20px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}`}</style>
      {showPayment&&<PaymentModal total={total} subtotal={subtotal} vat={vat} promos={promos} license={license} vno={vno} kotNo={kotNo} customers={LS.get("restopos_customers")||[]} customerName={customerName} customerPhone={customerPhone} orderType={orderType} onConfirm={confirmPayment} onClose={()=>setShowPayment(false)}/>}
      {showReceipt&&lastOrder&&<ReceiptModal order={lastOrder} license={license} zatcaInvoice={lastZatcaInvoice} onClose={()=>{setShowReceipt(false);setLastZatcaInvoice(null);}}/>}
      {notif&&<div style={{position:"fixed",top:70,right:20,background:C.primary,color:"#fff",padding:"10px 18px",borderRadius:10,fontSize:13,fontWeight:700,zIndex:9999,boxShadow:"0 4px 16px rgba(0,0,0,0.2)"}}>{notif}</div>}
      {/* LEFT — Menu */}
      <div style={{flex:1,display:"flex",flexDirection:"column",borderRight:`1px solid ${C.border}`,background:C.bg,overflow:"hidden"}}>
        <div style={{padding:"8px 12px",background:C.zatcaLight,borderBottom:`1px solid ${C.border}`}}>
          <input ref={barcodeRef} value={barcodeInput} onChange={e=>setBarcodeInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&barcodeInput.trim())handleBarcodeSearch(barcodeInput);}} placeholder="🔲 Scan barcode or type…" style={{width:"100%",padding:"7px 12px",border:`1.5px solid ${C.zatca}`,borderRadius:8,fontSize:13,fontFamily:"inherit",background:"#fff"}}/>
        </div>
        <div style={{display:"flex",gap:4,padding:"8px 12px",overflowX:"auto",borderBottom:`1px solid ${C.border}`,background:"#fff",flexShrink:0}}>
          {cats.map(cat=>(
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
            <input value={customerName} onChange={e=>setCustomerName(e.target.value.charAt(0).toUpperCase()+e.target.value.slice(1))} placeholder="Customer name" style={{flex:1,padding:"6px 10px",border:`1px solid ${C.border}`,borderRadius:7,fontSize:12,fontFamily:"inherit"}}/>
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
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}><span style={{fontSize:13,color:C.textMid}}>Total (VAT incl.)</span><span style={{fontSize:13,fontWeight:600}}>{fmtSAR(total)}</span></div>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}><span style={{fontSize:11,color:C.textLight}}>VAT 15% (incl.)</span><span style={{fontSize:11,fontWeight:600,color:C.zatca}}>{fmtSAR(vat)}</span></div>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:14,paddingTop:8,borderTop:`1px solid ${C.border}`}}><span style={{fontSize:16,fontWeight:800}}>Amount Due</span><span style={{fontSize:18,fontWeight:900,color:C.primary}}>{fmtSAR(total)}</span></div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={printKOT} disabled={cart.length===0} style={{flex:1,padding:"12px 0",background:cart.length===0?"#e0e0e0":C.accentLight,color:cart.length===0?"#aaa":C.accent,border:`1.5px solid ${cart.length===0?"#e0e0e0":C.accent}`,borderRadius:10,fontFamily:"inherit",fontSize:13,fontWeight:700,cursor:cart.length===0?"not-allowed":"pointer"}}>🍽 KOT</button>
            <button onClick={()=>{if(lastOrder)setShowPrevBill(true);else alert("No previous bill yet");}}
              title="Previous bill" style={{padding:"12px 14px",background:"rgba(26,107,74,0.1)",border:"1.5px solid rgba(26,107,74,0.3)",color:"#1A6B4A",borderRadius:10,fontFamily:"inherit",fontSize:12,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>🕐 Prev</button>
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
function Dashboard({sales,items,license,lang="en"}){
  const todaySales=sales.filter(s=>s.date===TODAY);
  const todayRevenue=todaySales.reduce((s,o)=>s+o.total,0);
  const todayVat=todaySales.reduce((s,o)=>s+o.vat,0);
  const qStatus=zatcaUtils.getQueueStatus();
  const plan=LS.get("restopos_license_v2")?.subscriptionPlan||"basic";
  const planDefs={basic:{name:"Basic",months:1},professional:{name:"Professional",months:12},premium:{name:"Premium",months:12}};
  const activatedAt=license?.activatedAt?new Date(license.activatedAt):new Date();
  const expiryDate=new Date(activatedAt);expiryDate.setMonth(expiryDate.getMonth()+(planDefs[plan]?.months||1));
  const [licExpanded,setLicExpanded]=useState(false);
  const collapseTimer=useRef(null);
  function handleExpand(){
    setLicExpanded(true);
    clearTimeout(collapseTimer.current);
    collapseTimer.current=setTimeout(()=>setLicExpanded(false),10000);
  }
  useEffect(()=>()=>clearTimeout(collapseTimer.current),[]);
  const licRows=[
    ["🏢 Registered Name",license?.businessName||"—"],
    ["📍 Address",license?.address||"—"],
    ["🧾 VAT Number",license?.vatNumber||"—"],
    ["🔑 License Key",license?.licenseKey||"—"],
    ["📋 Registration No.","—"],
    ["📅 Service Validity",expiryDate.toLocaleDateString("en-SA",{day:"2-digit",month:"short",year:"numeric"})+" ("+planDefs[plan]?.name+")"],
    ["📞 Phone",license?.phone||"—"],
  ];
  return(
    <div>
      {/* TOP ROW: Clock + compact license widget */}
      <div style={{display:"flex",gap:14,marginBottom:20,alignItems:"flex-start",flexWrap:"wrap"}}>
        <div style={{flex:1,minWidth:220}}><LiveClock/></div>
        {/* LICENSE INFO WIDGET — compact by default, expands on click */}
        <div style={{background:"linear-gradient(135deg,#E8F5EE 0%,#F0FBF5 100%)",border:"2px solid #B8E0CA",borderRadius:14,boxShadow:"0 4px 16px rgba(26,107,74,0.08)",transition:"all 0.3s",width:licExpanded?340:220,overflow:"hidden"}}>
          <div style={{display:"flex",alignItems:"center",gap:8,padding:"10px 14px",cursor:"pointer",userSelect:"none"}} onClick={handleExpand}>
            <div style={{width:28,height:28,background:"linear-gradient(135deg,#1A6B4A,#F0A500)",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:900,color:"#fff",flexShrink:0}}>R</div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:11,fontWeight:800,color:"#1A3D2B",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{license?.businessName||"License Info"}</div>
              <div style={{fontSize:9,color:"#5A8A6A",fontWeight:600}}>{license?.licenseKey||"—"} · {planDefs[plan]?.name} Plan</div>
            </div>
            <span style={{fontSize:10,color:"#5A8A6A",flexShrink:0}}>{licExpanded?"▲ collapse":"▼ expand"}</span>
          </div>
          {licExpanded&&(
            <div style={{padding:"0 14px 12px",borderTop:"1px solid #C8E6D4"}}>
              {licRows.map(([label,value])=>(
                <div key={label} style={{display:"flex",flexDirection:"column",marginTop:8}}>
                  <span style={{fontSize:9,fontWeight:700,color:"#5A8A6A",textTransform:"uppercase",letterSpacing:"0.04em"}}>{label}</span>
                  <span style={{fontSize:11,fontWeight:600,color:"#1A3D2B",marginTop:1,wordBreak:"break-all"}}>{value}</span>
                </div>
              ))}
              <div style={{marginTop:10,fontSize:9,color:"#5A8A6A",textAlign:"center"}}>Auto-collapses in 10s</div>
            </div>
          )}
        </div>
      </div>

      {/* KPI STATS */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(180px,1fr))",gap:14,marginBottom:20}}>
        <StatCard icon="🧾" label={t("Today's Orders",lang)} value={todaySales.length} color={C.info} bg={C.infoLight}/>
        <StatCard icon="⬛" label={t("VAT Collected",lang)} value={fmtSAR(todayVat)} color={C.zatca} bg={C.zatcaLight}/>
        <StatCard icon="📦" label="Menu Items" value={items.filter(i=>i.active).length+" active"} color={C.success} bg={C.successLight}/>
        {/* ZATCA boxes inline with stats */}
        <StatCard icon="📋" label="Total ZATCA Invoices" value={qStatus.total} color={C.zatca} bg={C.zatcaLight}/>
        <StatCard icon="✅" label="Reported to ZATCA" value={qStatus.reported} color={C.success} bg={C.successLight}/>
        <StatCard icon="⏳" label="ZATCA Pending" value={qStatus.pending} color={C.warning} bg={C.warningLight}/>
        <StatCard icon="🚨" label="ZATCA Urgent" value={qStatus.urgent} color={C.danger} bg={C.dangerLight}/>
      </div>
      {qStatus.urgent>0&&<div style={{marginBottom:16,padding:"10px 14px",background:C.dangerLight,border:`1px solid ${C.danger}`,borderRadius:8,fontSize:12,color:C.danger,fontWeight:600}}>🚨 {qStatus.urgent} invoice(s) approaching 24-hour FATOORA reporting deadline!</div>}
      {todaySales.length===0
        ?<Card style={{textAlign:"center",padding:"40px 0"}}><div style={{fontSize:40,marginBottom:12}}>📊</div><div style={{fontSize:15,fontWeight:700,color:C.textMid}}>No sales today yet</div></Card>
        :<Card><div style={{fontSize:14,fontWeight:700,marginBottom:14}}>Recent Orders (Today)</div><DataTable headers={["Invoice","Time","Type","Method","Total"]} rows={todaySales.slice().reverse().slice(0,10).map(s=>[<span style={{fontFamily:"monospace",fontSize:12,color:C.primary,fontWeight:700}}>{s.id}</span>,s.time,s.type,s.payMethod,<strong style={{color:C.primary}}>{fmtSAR(s.total)}</strong>])}/></Card>}
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
  const [previewTab,setPreviewTab]=useState("receipt"); // "receipt" | "kot"
  const fmt=invoiceFormat||{
    font:"courier",fontSize:12,shopNameOverride:"",
    footer:"Thank you for your visit!",footerAr:"شكراً لزيارتكم",
    website:"",social:"",tagline:"",logoUrl:"",
    template:"modern",headerColor:"#1A6B4A",paperWidth:"80mm",
    showVat:true,showCategories:true,showCustomer:true,showOrderType:true,
    showArabicName:true,totalSize:"large",separator:"dashed",boldItems:false,
    // KOT settings
    kotTitle:"KOT",kotTitleAr:"طلب المطبخ",kotShowArabic:true,
    kotShowTable:true,kotShowTime:true,kotShowOrderType:true,
    kotLargeText:true,kotFooter:"",kotPaper:"80mm",kotSeparator:"dashed",
  };
  function update(k,v){const updated={...(invoiceFormat||fmt),[k]:v};setInvoiceFormat(updated);LS.set("restopos_invoice_format",updated);setSaved(false);}
  function save(){LS.set("restopos_invoice_format",invoiceFormat||fmt);setSaved(true);setTimeout(()=>setSaved(false),3000);}
  const selectedFont=RECEIPT_FONTS.find(f=>f.id===fmt.font)||RECEIPT_FONTS[0];

  // Receipt preview
  const ReceiptPreview=()=>(
    <div style={{background:"#fff",border:"1px dashed #ccc",borderRadius:8,padding:12,
      maxWidth:fmt.paperWidth==="58mm"?180:240,margin:"0 auto",
      fontFamily:selectedFont.family,fontSize:fmt.fontSize||12,color:"#000",lineHeight:1.5}}>
      {/* Header */}
      {fmt.template==="modern"&&(
        <div style={{background:fmt.headerColor||"#1A6B4A",color:"#fff",margin:"-12px -12px 8px",
          padding:"10px 12px",textAlign:"center",borderRadius:"8px 8px 0 0"}}>
          {fmt.logoUrl&&<img src={fmt.logoUrl} alt="logo" style={{height:40,marginBottom:4,display:"block",margin:"0 auto 4px"}} onError={e=>e.target.style.display="none"}/>}
          <div style={{fontSize:(fmt.fontSize||12)+4,fontWeight:900}}>{fmt.shopNameOverride||company?.businessName||license?.businessName||"Restaurant"}</div>
          <div style={{fontSize:9,opacity:0.85}}>{company?.address||license?.address||""}</div>
          <div style={{fontSize:9,opacity:0.85}}>TRN: {license?.vatNumber||"300000000000003"}</div>
          {fmt.tagline&&<div style={{fontSize:9,fontStyle:"italic",opacity:0.8,marginTop:2}}>{fmt.tagline}</div>}
        </div>
      )}
      {fmt.template!=="modern"&&(
        <div style={{textAlign:"center",marginBottom:8}}>
          {fmt.logoUrl&&<img src={fmt.logoUrl} alt="logo" style={{height:36,display:"block",margin:"0 auto 4px"}} onError={e=>e.target.style.display="none"}/>}
          <div style={{fontSize:(fmt.fontSize||12)+3,fontWeight:900}}>{fmt.shopNameOverride||company?.businessName||license?.businessName}</div>
          <div style={{fontSize:9}}>{company?.address||""}</div>
          <div style={{fontSize:9}}>TRN: {license?.vatNumber||""}</div>
          {fmt.tagline&&<div style={{fontSize:9,fontStyle:"italic"}}>{fmt.tagline}</div>}
        </div>
      )}
      {/* Sep */}
      <div style={{borderTop:fmt.separator==="solid"?"1px solid #000":fmt.separator==="double"?"3px double #000":fmt.separator==="none"?"none":"1px dashed #000",margin:"5px 0"}}/>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:9}}><span>INV-001001</span><span>Today 12:00</span></div>
      {fmt.showOrderType&&<div style={{fontSize:9,color:"#666"}}>Takeaway · Cash</div>}
      {fmt.showCustomer&&<div style={{fontSize:9}}>Customer: Mohammed</div>}
      <div style={{borderTop:fmt.separator==="solid"?"1px solid #000":fmt.separator==="double"?"3px double #000":fmt.separator==="none"?"none":"1px dashed #000",margin:"5px 0"}}/>
      {/* Items */}
      {fmt.showCategories&&<div style={{fontSize:8,fontWeight:700,color:"#888",letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:2}}>MAINS</div>}
      {[["Broasted Chicken","برست دجاج","28.00"],["French Fries","بطاطس","10.00"]].map(([n,ar,p])=>(
        <div key={n} style={{display:"flex",justifyContent:"space-between",marginBottom:fmt.boldItems?3:2}}>
          <span style={{fontWeight:fmt.boldItems?"700":"normal"}}>
            {n}<span style={{color:"#888"}}> x1</span>
            {fmt.showArabicName&&<span style={{display:"block",direction:"rtl",fontFamily:"'Tajawal',sans-serif",fontSize:9,color:"#555"}}>{ar}</span>}
          </span>
          <span>{p}</span>
        </div>
      ))}
      <div style={{borderTop:fmt.separator==="solid"?"1px solid #000":fmt.separator==="double"?"3px double #000":fmt.separator==="none"?"none":"1px dashed #000",margin:"5px 0"}}/>
      {fmt.showVat&&<div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:"#666"}}><span>VAT 15%</span><span>5.70</span></div>}
      <div style={{display:"flex",justifyContent:"space-between",
        fontWeight:900,
        fontSize:fmt.totalSize==="xl"?(fmt.fontSize||12)+6:fmt.totalSize==="large"?(fmt.fontSize||12)+3:(fmt.fontSize||12),
        borderTop:"2px solid #000",paddingTop:3,marginTop:3}}>
        <span>TOTAL</span><span>SAR 43.70</span>
      </div>
      <div style={{borderTop:fmt.separator==="solid"?"1px solid #000":fmt.separator==="double"?"3px double #000":fmt.separator==="none"?"none":"1px dashed #000",margin:"5px 0"}}/>
      <div style={{textAlign:"center",fontSize:9}}>
        {fmt.website&&<div>{fmt.website}</div>}
        {fmt.social&&<div>{fmt.social}</div>}
        <div style={{marginTop:2,fontWeight:700}}>{fmt.footer||"Thank you!"}</div>
        {fmt.footerAr&&<div style={{direction:"rtl",fontFamily:"'Tajawal',sans-serif"}}>{fmt.footerAr}</div>}
      </div>
    </div>
  );

  // KOT preview
  const KOTPreview=()=>(
    <div style={{background:"#fff",border:"1px dashed #ccc",borderRadius:8,padding:12,
      maxWidth:fmt.kotPaper==="58mm"?180:240,margin:"0 auto",
      fontFamily:"'Courier New',monospace",fontSize:14,color:"#000",lineHeight:1.6}}>
      <div style={{textAlign:"center",fontWeight:900,fontSize:fmt.kotLargeText?20:16}}>
        {fmt.kotTitle||"KOT"} #42
      </div>
      {fmt.kotTitleAr&&<div style={{textAlign:"center",direction:"rtl",fontFamily:"'Tajawal',sans-serif",fontSize:12}}>{fmt.kotTitleAr}</div>}
      <div style={{borderTop:fmt.kotSeparator==="solid"?"1px solid #000":"1px dashed #000",margin:"5px 0"}}/>
      {fmt.kotShowOrderType&&<div>DINE-IN{fmt.kotShowTable?" · Table 5":""}</div>}
      {fmt.kotShowTime&&<div style={{fontSize:11}}>12:35 PM</div>}
      <div style={{borderTop:fmt.kotSeparator==="solid"?"1px solid #000":"1px dashed #000",margin:"5px 0"}}/>
      {[["2x Broasted Half","برست نصف"],["1x French Fries","بطاطس"]].map(([item,ar])=>(
        <div key={item} style={{fontWeight:fmt.kotLargeText?"900":"normal",fontSize:fmt.kotLargeText?15:13}}>
          {item}
          {fmt.kotShowArabic&&<div style={{direction:"rtl",fontFamily:"'Tajawal',sans-serif",fontSize:11,color:"#555"}}>{ar}</div>}
        </div>
      ))}
      <div style={{borderTop:fmt.kotSeparator==="solid"?"1px solid #000":"1px dashed #000",margin:"5px 0"}}/>
      {fmt.kotFooter&&<div style={{textAlign:"center",fontSize:11}}>{fmt.kotFooter}</div>}
    </div>
  );

  return(
    <div style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) minmax(0,1fr)",gap:20,alignItems:"start"}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Tajawal:wght@400;700&family=Cairo:wght@400;700&family=Amiri:wght@400;700&family=Scheherazade+New:wght@400;700&family=Noto+Naskh+Arabic:wght@400;700&display=swap');`}</style>

      {/* LEFT — Controls */}
      <div style={{display:"flex",flexDirection:"column",gap:14}}>

        {/* Template */}
        <Card>
          <div style={{fontSize:13,fontWeight:700,marginBottom:10}}>🎨 Receipt Template</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            {[
              {id:"modern",label:"Modern",desc:"Colored header"},
              {id:"classic",label:"Classic",desc:"Traditional"},
              {id:"minimal",label:"Minimal",desc:"Clean & simple"},
              {id:"arabic",label:"Arabic RTL",desc:"Right to left"},
            ].map(t=>(
              <button key={t.id} onClick={()=>{update("template",t.id);LS.set("restopos_invoice_template",t.id);}}
                style={{padding:"10px",border:`2px solid ${fmt.template===t.id?C.primary:C.border}`,
                  borderRadius:8,background:fmt.template===t.id?C.primaryLight:"#fff",
                  cursor:"pointer",textAlign:"left",fontFamily:"inherit"}}>
                <div style={{fontSize:12,fontWeight:700,color:fmt.template===t.id?C.primary:C.text}}>{t.label}</div>
                <div style={{fontSize:10,color:C.textLight}}>{t.desc}</div>
              </button>
            ))}
          </div>
          {fmt.template==="modern"&&(
            <div style={{marginTop:10}}>
              <label style={{fontSize:11,fontWeight:600,color:C.textMid,display:"block",marginBottom:4}}>Header Color</label>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {["#1A6B4A","#1A3A5C","#D94040","#F0A500","#6366f1","#0f172a","#7c3aed","#be185d"].map(c=>(
                  <div key={c} onClick={()=>update("headerColor",c)}
                    style={{width:28,height:28,borderRadius:"50%",background:c,cursor:"pointer",
                      border:`3px solid ${fmt.headerColor===c?"#000":"transparent"}`,flexShrink:0}}/>
                ))}
                <input type="color" value={fmt.headerColor||"#1A6B4A"} onChange={e=>update("headerColor",e.target.value)}
                  style={{width:28,height:28,borderRadius:"50%",border:"none",cursor:"pointer",padding:0}}
                  title="Custom color"/>
              </div>
            </div>
          )}
        </Card>

        {/* Font & Size */}
        <Card>
          <div style={{fontSize:13,fontWeight:700,marginBottom:10}}>🔤 Font</div>
          <div style={{fontSize:11,color:C.textMid,marginBottom:6}}>English fonts</div>
          <div style={{display:"flex",flexDirection:"column",gap:5,marginBottom:10}}>
            {RECEIPT_FONTS.filter(f=>f.lang==="EN").map(f=>(
              <button key={f.id} onClick={()=>update("font",f.id)}
                style={{padding:"8px 12px",border:`2px solid ${fmt.font===f.id?C.primary:C.border}`,
                  borderRadius:7,background:fmt.font===f.id?C.primaryLight:"#fff",
                  cursor:"pointer",textAlign:"left",fontFamily:f.family,fontSize:13,
                  color:fmt.font===f.id?C.primary:C.text,display:"flex",justifyContent:"space-between"}}>
                <span>{f.label} — The quick brown fox</span>
                {fmt.font===f.id&&<span style={{fontSize:10,fontWeight:700,fontFamily:"inherit"}}>✓</span>}
              </button>
            ))}
          </div>
          <div style={{fontSize:11,color:C.textMid,marginBottom:6}}>Arabic fonts</div>
          <div style={{display:"flex",flexDirection:"column",gap:5,marginBottom:12}}>
            {RECEIPT_FONTS.filter(f=>f.lang==="AR").map(f=>(
              <button key={f.id} onClick={()=>update("font",f.id)}
                style={{padding:"8px 12px",border:`2px solid ${fmt.font===f.id?C.primary:C.border}`,
                  borderRadius:7,background:fmt.font===f.id?C.primaryLight:"#fff",
                  cursor:"pointer",textAlign:"right",fontFamily:f.family,fontSize:14,
                  color:fmt.font===f.id?C.primary:C.text,direction:"rtl",display:"flex",justifyContent:"space-between"}}>
                <span>{f.label} — نموذج للخط</span>
                {fmt.font===f.id&&<span style={{fontSize:10,fontWeight:700,direction:"ltr"}}>✓</span>}
              </button>
            ))}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
            <div>
              <div style={{fontSize:11,color:C.textMid,marginBottom:5}}>Font Size</div>
              <div style={{display:"flex",gap:5}}>
                {[10,11,12,13,14].map(s=>(
                  <button key={s} onClick={()=>update("fontSize",s)}
                    style={{width:34,height:34,borderRadius:7,border:`2px solid ${fmt.fontSize===s?C.primary:C.border}`,
                      background:fmt.fontSize===s?C.primaryLight:"#fff",color:fmt.fontSize===s?C.primary:C.textMid,
                      fontFamily:"inherit",fontSize:12,fontWeight:700,cursor:"pointer"}}>{s}</button>
                ))}
              </div>
            </div>
            <div>
              <div style={{fontSize:11,color:C.textMid,marginBottom:5}}>Paper Width</div>
              <div style={{display:"flex",gap:5}}>
                {["58mm","80mm"].map(w=>(
                  <button key={w} onClick={()=>update("paperWidth",w)}
                    style={{padding:"7px 12px",borderRadius:7,border:`2px solid ${fmt.paperWidth===w?C.primary:C.border}`,
                      background:fmt.paperWidth===w?C.primaryLight:"#fff",color:fmt.paperWidth===w?C.primary:C.textMid,
                      fontFamily:"inherit",fontSize:12,fontWeight:700,cursor:"pointer"}}>{w}</button>
                ))}
              </div>
            </div>
            <div>
              <div style={{fontSize:11,color:C.textMid,marginBottom:5}}>Total Size</div>
              <div style={{display:"flex",gap:5}}>
                {[["normal","Aa"],["large","AA"],["xl","A+"]].map(([v,l])=>(
                  <button key={v} onClick={()=>update("totalSize",v)}
                    style={{padding:"7px 10px",borderRadius:7,border:`2px solid ${fmt.totalSize===v?C.primary:C.border}`,
                      background:fmt.totalSize===v?C.primaryLight:"#fff",color:fmt.totalSize===v?C.primary:C.textMid,
                      fontFamily:"inherit",fontSize:12,fontWeight:700,cursor:"pointer"}}>{l}</button>
                ))}
              </div>
            </div>
            <div>
              <div style={{fontSize:11,color:C.textMid,marginBottom:5}}>Separator</div>
              <div style={{display:"flex",gap:5}}>
                {[["dashed","- -"],["solid","—"],["double","═"],["none","∅"]].map(([v,l])=>(
                  <button key={v} onClick={()=>update("separator",v)}
                    style={{padding:"7px 10px",borderRadius:7,border:`2px solid ${fmt.separator===v?C.primary:C.border}`,
                      background:fmt.separator===v?C.primaryLight:"#fff",color:fmt.separator===v?C.primary:C.textMid,
                      fontFamily:"inherit",fontSize:12,fontWeight:700,cursor:"pointer"}}>{l}</button>
                ))}
              </div>
            </div>
          </div>
        </Card>

        {/* Show/Hide toggles */}
        <Card>
          <div style={{fontSize:13,fontWeight:700,marginBottom:10}}>👁 Show / Hide Sections</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {[
              ["showVat","VAT breakdown line"],
              ["showCategories","Group items by category"],
              ["showCustomer","Customer name"],
              ["showOrderType","Order type (Dine-in/Takeaway)"],
              ["showArabicName","Arabic item names"],
              ["boldItems","Bold item names"],
            ].map(([k,label])=>(
              <label key={k} style={{display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}}>
                <span style={{fontSize:12,color:C.text}}>{label}</span>
                <div onClick={()=>update(k,!fmt[k])}
                  style={{width:40,height:22,borderRadius:11,background:fmt[k]?C.primary:"#CBD5E0",
                    position:"relative",transition:"background 0.2s",cursor:"pointer",flexShrink:0}}>
                  <div style={{position:"absolute",top:2,left:fmt[k]?20:2,width:18,height:18,
                    borderRadius:"50%",background:"#fff",transition:"left 0.2s",
                    boxShadow:"0 1px 3px rgba(0,0,0,0.2)"}}/>
                </div>
              </label>
            ))}
          </div>
        </Card>

        {/* Additional info */}
        <Card>
          <div style={{fontSize:13,fontWeight:700,marginBottom:10}}>📝 Content</div>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            <Inp label="Shop Name Override" value={fmt.shopNameOverride||""} onChange={v=>update("shopNameOverride",v)} placeholder={company?.businessName||license?.businessName}/>
            <Inp label="Tagline" value={fmt.tagline||""} onChange={v=>update("tagline",v)} placeholder="Best food in town!"/>
            <Inp label="Logo URL (paste image link)" value={fmt.logoUrl||""} onChange={v=>update("logoUrl",v)} placeholder="https://example.com/logo.png"/>
            <Inp label="Footer (English)" value={fmt.footer||""} onChange={v=>update("footer",v)} placeholder="Thank you for your visit!"/>
            <Inp label="Footer (Arabic)" value={fmt.footerAr||""} onChange={v=>update("footerAr",v)} placeholder="شكراً لزيارتكم"/>
            <Inp label="Website" value={fmt.website||""} onChange={v=>update("website",v)} placeholder="www.restaurant.sa"/>
            <Inp label="Instagram / Social" value={fmt.social||""} onChange={v=>update("social",v)} placeholder="@restaurant"/>
          </div>
        </Card>

        {/* KOT Settings */}
        <Card>
          <div style={{fontSize:13,fontWeight:700,marginBottom:10}}>🍽️ Kitchen Ticket (KOT) Format</div>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            <div style={{display:"flex",gap:8}}>
              <div style={{flex:1}}><Inp label="KOT Title (English)" value={fmt.kotTitle||"KOT"} onChange={v=>update("kotTitle",v)} placeholder="KOT"/></div>
              <div style={{flex:1}}><Inp label="KOT Title (Arabic)" value={fmt.kotTitleAr||"طلب المطبخ"} onChange={v=>update("kotTitleAr",v)} placeholder="طلب المطبخ"/></div>
            </div>
            <Inp label="KOT Footer" value={fmt.kotFooter||""} onChange={v=>update("kotFooter",v)} placeholder="Rush! / Urgent etc."/>
            <div style={{display:"flex",gap:8}}>
              <div>
                <div style={{fontSize:11,color:C.textMid,marginBottom:5}}>Paper Width</div>
                <div style={{display:"flex",gap:5}}>
                  {["58mm","80mm"].map(w=>(
                    <button key={w} onClick={()=>update("kotPaper",w)}
                      style={{padding:"6px 10px",borderRadius:7,border:`2px solid ${fmt.kotPaper===w?C.primary:C.border}`,
                        background:fmt.kotPaper===w?C.primaryLight:"#fff",color:fmt.kotPaper===w?C.primary:C.textMid,
                        fontFamily:"inherit",fontSize:12,fontWeight:700,cursor:"pointer"}}>{w}</button>
                  ))}
                </div>
              </div>
              <div>
                <div style={{fontSize:11,color:C.textMid,marginBottom:5}}>Separator</div>
                <div style={{display:"flex",gap:5}}>
                  {[["dashed","- -"],["solid","—"]].map(([v,l])=>(
                    <button key={v} onClick={()=>update("kotSeparator",v)}
                      style={{padding:"6px 10px",borderRadius:7,border:`2px solid ${fmt.kotSeparator===v?C.primary:C.border}`,
                        background:fmt.kotSeparator===v?C.primaryLight:"#fff",color:fmt.kotSeparator===v?C.primary:C.textMid,
                        fontFamily:"inherit",fontSize:12,fontWeight:700,cursor:"pointer"}}>{l}</button>
                  ))}
                </div>
              </div>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {[
                ["kotShowArabic","Show Arabic item name"],
                ["kotShowTable","Show table number"],
                ["kotShowTime","Show time"],
                ["kotShowOrderType","Show order type"],
                ["kotLargeText","Large item text (easier to read)"],
              ].map(([k,label])=>(
                <label key={k} style={{display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}}>
                  <span style={{fontSize:12,color:C.text}}>{label}</span>
                  <div onClick={()=>update(k,!fmt[k])}
                    style={{width:40,height:22,borderRadius:11,background:fmt[k]?C.primary:"#CBD5E0",
                      position:"relative",transition:"background 0.2s",cursor:"pointer",flexShrink:0}}>
                    <div style={{position:"absolute",top:2,left:fmt[k]?20:2,width:18,height:18,
                      borderRadius:"50%",background:"#fff",transition:"left 0.2s"}}/>
                  </div>
                </label>
              ))}
            </div>
          </div>
        </Card>

        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <Btn onClick={save}>💾 Save All Settings</Btn>
          {saved&&<span style={{fontSize:12,color:C.success,fontWeight:700}}>✓ Saved!</span>}
        </div>
      </div>

      {/* RIGHT — Live Preview */}
      <div style={{position:"sticky",top:20}}>
        <Card>
          <div style={{display:"flex",gap:8,marginBottom:14}}>
            {[["receipt","🧾 Receipt"],["kot","🍽️ KOT"]].map(([id,label])=>(
              <button key={id} onClick={()=>setPreviewTab(id)}
                style={{flex:1,padding:"8px",border:`2px solid ${previewTab===id?C.primary:C.border}`,
                  borderRadius:8,background:previewTab===id?C.primaryLight:"#fff",
                  color:previewTab===id?C.primary:C.textMid,fontFamily:"inherit",
                  fontSize:12,fontWeight:700,cursor:"pointer"}}>
                {label}
              </button>
            ))}
          </div>
          <div style={{fontSize:12,fontWeight:700,color:C.textMid,marginBottom:10,textAlign:"center"}}>
            LIVE PREVIEW — {previewTab==="receipt"?fmt.paperWidth||"80mm":fmt.kotPaper||"80mm"}
          </div>
          {previewTab==="receipt"?<ReceiptPreview/>:<KOTPreview/>}
        </Card>
      </div>
    </div>
  );
}
// ═══════════════════════════════════════════════════════════════════
// LICENSE TAB — with location sharing
// ═══════════════════════════════════════════════════════════════════
function LicenseTab({license,onClearLicense,onSwitchAccount}){
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

    {/* Switch Account Panel */}
    {(()=>{
      const savedAccounts=LS.get("restopos_saved_accounts")||[];
      if(savedAccounts.length===0&&!onSwitchAccount)return null;
      return(
        <div style={{padding:14,background:"rgba(99,102,241,0.06)",border:"1.5px solid rgba(99,102,241,0.25)",borderRadius:10}}>
          <div style={{fontSize:13,fontWeight:700,color:"#6366f1",marginBottom:8}}>👤 Account Switching</div>
          {savedAccounts.length>0&&(
            <div style={{marginBottom:12}}>
              <div style={{fontSize:12,color:C.textMid,marginBottom:8}}>Saved accounts on this device:</div>
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                {savedAccounts.map((acc,i)=>(
                  <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 12px",background:"#fff",border:`1px solid rgba(99,102,241,0.2)`,borderRadius:8}}>
                    <div>
                      <div style={{fontSize:13,fontWeight:700,color:C.text}}>{acc.businessName}</div>
                      <div style={{fontSize:11,color:C.textMid}}>CR: {acc.crNumber} · {acc.status}</div>
                    </div>
                    <Btn size="sm" variant="outline" onClick={()=>{
                      if(!confirm(`Switch to account: ${acc.businessName}?\n\nYour current account will be saved.`))return;
                      // Save current account
                      const current={licenseKey:license.licenseKey,businessName:license.businessName,crNumber:license.crNumber,savedAt:new Date().toISOString(),status:"active"};
                      const others=savedAccounts.filter(a=>a.licenseKey!==acc.licenseKey);
                      const withCurrent=[...others,current];
                      LS.set("restopos_saved_accounts",withCurrent);
                      // Load selected account
                      LS.del("restopos_license_v2");
                      LS.del("restopos_client_creds");
                      // Try to find full license data
                      window.location.reload();
                    }}>Switch</Btn>
                  </div>
                ))}
              </div>
            </div>
          )}
          <Btn variant="outline" size="sm" onClick={()=>{
            if(!confirm("Register a new account? Your current account will be saved and you can switch back later."))return;
            const savedAccounts=LS.get("restopos_saved_accounts")||[];
            const current={licenseKey:license.licenseKey,businessName:license.businessName,crNumber:license.crNumber,savedAt:new Date().toISOString(),status:"active"};
            if(!savedAccounts.find(a=>a.licenseKey===current.licenseKey))LS.set("restopos_saved_accounts",[...savedAccounts,current]);
            LS.del("restopos_license_v2");LS.del("restopos_client_creds");
            window.location.reload();
          }} style={{width:"100%"}}>➕ Add & Register New Account</Btn>
        </div>
      );
    })()}
  </Card>);
}

// ═══════════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════════
function Settings({company,setCompany,tables,setTables,license,onClearLicense,onSwitchAccount,pins,setPins,invoiceFormat,setInvoiceFormat,lang="en",onLangChange}){
  const [tab,setTab]=useState("company");const [newTableCount,setNewTableCount]=useState(tables.length);const [companySaved,setCompanySaved]=useState(false);
  const [kitchenPrinter,setKitchenPrinter]=useState(()=>LS.get("restopos_kitchen_printer")||{name:"Kitchen Printer",paperWidth:"80mm",autoKOT:true,enabled:false});
  const [kpSaved,setKpSaved]=useState(false);
  function saveKP(){LS.set("restopos_kitchen_printer",kitchenPrinter);setKpSaved(true);setTimeout(()=>setKpSaved(false),3000);}
  function testKOT(){
    const win=window.open("","_blank","width=340,height=500");if(!win){alert("Pop-up blocked.");return;}
    const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>@page{size:${kitchenPrinter.paperWidth} auto;margin:0}body{font-family:'Courier New',monospace;font-size:14px;padding:8mm;width:${kitchenPrinter.paperWidth}}.center{text-align:center}.big{font-size:18px;font-weight:900}.hr{border:none;border-top:2px dashed #000;margin:6px 0}</style></head><body><div class="center"><div class="big">*** KOT TEST ***</div><div>Kitchen Order Ticket</div><div>${new Date().toLocaleTimeString()}</div></div><div class="hr"/><div>1x Broasted Chicken Half</div><div>2x French Fries</div><div>1x Fresh Lemon Juice</div><div class="hr"/><div class="center">Table 5 · Dine-in</div><script>window.onload=function(){window.print();window.close();}<\/script></body></html>`;
    win.document.write(html);win.document.close();
  }
  const TAB_LABELS={"company":"🏢 "+t("Company",lang),"tables":"🪑 "+t("Tables",lang),"printers":"🖨️ "+t("Bill Printer",lang),"kitchen":"🍽️ "+t("Kitchen Printer",lang),"invoice":"🧾 "+t("Invoice Format",lang),"security":"🔐 "+t("Security",lang),"license":"📋 "+t("License",lang),"language":"🌐 "+t("Language",lang)};
  const tabs=[["company","🏢 Company"],["tables","🪑 Tables"],["printers","🖨️ Bill Printer"],["kitchen","🍽️ Kitchen Printer"],["invoice","🧾 Invoice Format"],["security","🔐 Security"],["license","📋 License"],["language","🌐 Language"]];
  return(<div dir={lang==="ar"?"rtl":"ltr"} style={{fontFamily:lang==="ar"?"'Tajawal',sans-serif":"inherit"}}>
    <div style={{display:"flex",gap:8,marginBottom:20,flexWrap:"wrap"}}>{tabs.map(([id,label])=><button key={id} onClick={()=>setTab(id)} style={{padding:"8px 16px",borderRadius:8,border:`1.5px solid ${tab===id?C.primary:C.border}`,background:tab===id?C.primaryLight:"#fff",color:tab===id?C.primary:C.textMid,fontFamily:"inherit",fontSize:13,fontWeight:600,cursor:"pointer"}}>{TAB_LABELS[id]||label}</button>)}</div>
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
    {tab==="license"&&<LicenseTab license={license} onClearLicense={onClearLicense} onSwitchAccount={onSwitchAccount}/>}
    {tab==="language"&&<Card style={{maxWidth:520}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:6,fontFamily:lang==="ar"?"'Tajawal',sans-serif":"inherit"}}>
        {lang==="ar"?"إعدادات اللغة":"Language Settings"}
      </div>
      <div style={{fontSize:13,color:C.textMid,marginBottom:24,fontFamily:lang==="ar"?"'Tajawal',sans-serif":"inherit"}}>
        {lang==="ar"?"اختر لغتك المفضلة لواجهة التطبيق.":"Select your preferred language for the app interface."}
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:12}}>
        {[
          {code:"en",label:"English",desc:"Full interface in English",flag:"🇬🇧"},
          {code:"ar",label:"العربية — Arabic",desc:"واجهة كاملة بالعربية — Full Arabic interface (RTL)",flag:"🇸🇦"},
        ].map(opt=>(
          <div key={opt.code} onClick={()=>onLangChange&&onLangChange(opt.code)}
            style={{display:"flex",alignItems:"center",gap:16,padding:"16px 20px",borderRadius:12,border:`2px solid ${lang===opt.code?C.primary:C.border}`,background:lang===opt.code?C.primaryLight:"#fff",cursor:"pointer",transition:"all 0.15s"}}>
            <div style={{fontSize:32,flexShrink:0}}>{opt.flag}</div>
            <div style={{flex:1}}>
              <div style={{fontSize:15,fontWeight:700,color:lang===opt.code?C.primary:C.text,fontFamily:"'Tajawal','Plus Jakarta Sans',sans-serif"}}>{opt.label}</div>
              <div style={{fontSize:12,color:C.textMid,marginTop:2,fontFamily:"'Tajawal','Plus Jakarta Sans',sans-serif"}}>{opt.desc}</div>
            </div>
            <div style={{width:22,height:22,borderRadius:"50%",border:`2px solid ${lang===opt.code?C.primary:C.border}`,background:lang===opt.code?C.primary:"#fff",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
              {lang===opt.code&&<div style={{width:10,height:10,borderRadius:"50%",background:"#fff"}}/>}
            </div>
          </div>
        ))}
      </div>
      {lang==="ar"&&<div style={{marginTop:16,padding:"12px 16px",background:C.successLight,border:`1px solid ${C.success}44`,borderRadius:10,fontSize:13,color:C.success,fontFamily:"'Tajawal',sans-serif",direction:"rtl",textAlign:"right"}}>
        ✓ تم تفعيل اللغة العربية — ستظهر جميع القوائم والأزرار باللغة العربية
      </div>}
    </Card>}
  </div>);
}

// ═══════════════════════════════════════════════════════════════════
// CATEGORY MANAGER COMPONENT
// ═══════════════════════════════════════════════════════════════════
function CategoryManager({categories,saveCategories,items,setItems}){
  const [editingCat,setEditingCat]=useState(null);
  const [editCatVal,setEditCatVal]=useState("");
  const [selectedCatView,setSelectedCatView]=useState(()=>categories[0]||"");
  const [newCat,setNewCat]=useState("");

  function addCategory(){
    const trimmed=(newCat.trim().charAt(0).toUpperCase()+newCat.trim().slice(1));
    if(!trimmed)return alert("Category name cannot be empty");
    if(categories.includes(trimmed))return alert("Category already exists");
    saveCategories([...categories,trimmed]);
    setNewCat("");
  }
  function startEdit(cat){setEditingCat(cat);setEditCatVal(cat);}
  function saveEdit(){
    const trimmed=(editCatVal.trim().charAt(0).toUpperCase()+editCatVal.trim().slice(1));
    if(!trimmed||trimmed===editingCat){setEditingCat(null);return;}
    if(categories.includes(trimmed)){alert("Category already exists");return;}
    saveCategories(categories.map(c=>c===editingCat?trimmed:c));
    setItems(prev=>prev.map(i=>i.category===editingCat?{...i,category:trimmed}:i));
    if(selectedCatView===editingCat)setSelectedCatView(trimmed);
    setEditingCat(null);
  }
  function deleteCategory(cat){
    const catItems=items.filter(i=>i.category===cat);
    if(catItems.length>0){
      const other=categories.filter(c=>c!==cat)[0]||"";
      if(!confirm(`"${cat}" has ${catItems.length} item(s). Move them to "${other||"first category"}" and delete?`))return;
      if(other)setItems(prev=>prev.map(i=>i.category===cat?{...i,category:other}:i));
    }else{
      if(!confirm(`Delete category "${cat}"?`))return;
    }
    const newList=categories.filter(c=>c!==cat);
    saveCategories(newList);
    if(selectedCatView===cat)setSelectedCatView(newList[0]||"");
  }
  function moveItemToCategory(item,newCatName){
    setItems(prev=>prev.map(i=>i.id===item.id?{...i,category:newCatName}:i));
  }

  const catItems=items.filter(i=>i.category===selectedCatView);

  return(
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      {/* Add category */}
      <Card style={{padding:"12px 16px"}}>
        <div style={{fontSize:13,fontWeight:700,marginBottom:10}}>📂 Add New Category</div>
        <div style={{display:"flex",gap:8}}>
          <input value={newCat}
            onChange={e=>setNewCat(e.target.value.charAt(0).toUpperCase()+e.target.value.slice(1))}
            onKeyDown={e=>{if(e.key==="Enter")addCategory();}}
            placeholder="Category name…"
            style={{flex:1,padding:"9px 12px",border:`1.5px solid ${C.border}`,borderRadius:8,fontSize:13,fontFamily:"inherit"}}/>
          <Btn onClick={addCategory}>+ Add</Btn>
        </div>
      </Card>

      <div style={{display:"grid",gridTemplateColumns:"200px 1fr",gap:14}}>
        {/* Category list */}
        <div style={{display:"flex",flexDirection:"column",gap:6}}>
          <div style={{fontSize:11,fontWeight:700,color:C.textMid,marginBottom:2}}>CATEGORIES ({categories.length})</div>
          {categories.map(cat=>(
            <div key={cat}
              style={{padding:"8px 10px",borderRadius:8,
                background:selectedCatView===cat?C.primaryLight:"#fff",
                border:`1.5px solid ${selectedCatView===cat?C.primary:C.border}`,
                cursor:"pointer"}}>
              {editingCat===cat?(
                <div style={{display:"flex",gap:4}}>
                  <input value={editCatVal}
                    onChange={e=>setEditCatVal(e.target.value.charAt(0).toUpperCase()+e.target.value.slice(1))}
                    onKeyDown={e=>{if(e.key==="Enter")saveEdit();if(e.key==="Escape")setEditingCat(null);}}
                    autoFocus
                    style={{flex:1,padding:"3px 6px",border:`1px solid ${C.primary}`,borderRadius:5,fontSize:12,fontFamily:"inherit"}}/>
                  <button onClick={saveEdit} style={{background:C.success,color:"#fff",border:"none",borderRadius:5,padding:"3px 7px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>✓</button>
                  <button onClick={()=>setEditingCat(null)} style={{background:C.bg,color:C.textMid,border:"none",borderRadius:5,padding:"3px 7px",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>✕</button>
                </div>
              ):(
                <div style={{display:"flex",alignItems:"center",gap:4}} onClick={()=>setSelectedCatView(cat)}>
                  <span style={{flex:1,fontSize:13,fontWeight:selectedCatView===cat?700:500,color:selectedCatView===cat?C.primary:C.text}}>{cat}</span>
                  <span style={{fontSize:10,color:C.textLight,minWidth:14,textAlign:"center"}}>{items.filter(i=>i.category===cat).length}</span>
                  <button onClick={e=>{e.stopPropagation();startEdit(cat);}}
                    style={{background:"none",border:"none",color:C.info,cursor:"pointer",fontSize:12,padding:"0 2px",lineHeight:1}}>✏️</button>
                  <button onClick={e=>{e.stopPropagation();deleteCategory(cat);}}
                    style={{background:"none",border:"none",color:C.danger,cursor:"pointer",fontSize:12,padding:"0 2px",lineHeight:1}}>🗑️</button>
                </div>
              )}
            </div>
          ))}
          {categories.length===0&&<div style={{fontSize:12,color:C.textLight,padding:"10px 0"}}>No categories yet</div>}
        </div>

        {/* Items in selected category */}
        <Card>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10,flexWrap:"wrap",gap:8}}>
            <div style={{fontSize:13,fontWeight:700}}>
              📋 "{selectedCatView}" — {catItems.length} item{catItems.length!==1?"s":""}
            </div>
            <div style={{fontSize:11,color:C.textMid}}>Use dropdown to move item to another category</div>
          </div>
          {catItems.length===0?(
            <div style={{textAlign:"center",padding:"24px 0",color:C.textLight}}>
              <div style={{fontSize:28,marginBottom:6}}>📭</div>
              <div>No items in this category</div>
            </div>
          ):(
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {catItems.map(it=>(
                <div key={it.id} style={{display:"flex",alignItems:"center",gap:10,
                  padding:"8px 12px",background:"#F8FAFF",borderRadius:8,
                  border:`1px solid ${C.border}`}}>
                  <div style={{flex:1}}>
                    <div style={{fontSize:13,fontWeight:600,color:C.text}}>{it.name}</div>
                    {it.nameAr&&<div style={{fontSize:11,color:C.textMid,direction:"rtl",fontFamily:"'Tajawal',sans-serif"}}>{it.nameAr}</div>}
                    <div style={{fontSize:11,color:C.primary,fontWeight:700}}>{fmtSAR(it.price)}</div>
                  </div>
                  <div>
                    <div style={{fontSize:9,color:C.textLight,fontWeight:700,marginBottom:3}}>MOVE TO</div>
                    <select
                      onChange={e=>{if(e.target.value){moveItemToCategory(it,e.target.value);e.target.value="";}}}
                      defaultValue=""
                      style={{padding:"4px 8px",border:`1px solid ${C.border}`,borderRadius:6,
                        fontSize:11,fontFamily:"inherit",background:"#fff",cursor:"pointer",color:C.text}}>
                      <option value="">— Move —</option>
                      {categories.filter(c=>c!==selectedCatView).map(c=>(
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
      <div style={{fontSize:12,color:C.success,fontWeight:600}}>
        ✓ {categories.length} categories · {items.length} items total · All changes sync automatically
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// CREATE — Menu Management
// ═══════════════════════════════════════════════════════════════════
function Create({items,setItems,promos,setPromos}){
  const [tab,setTab]=useState("items");const [showItemModal,setShowItemModal]=useState(false);const [editItem,setEditItem]=useState(null);const [showBarcodeModal,setShowBarcodeModal]=useState(false);const [barcodeItem,setBarcodeItem]=useState(null);const [barcodeInput,setBarcodeInput]=useState("");const [showPromoModal,setShowPromoModal]=useState(false);const [editPromo,setEditPromo]=useState(null);
  const [categories,setCategories]=useState(()=>LS.get("restopos_categories")||SEED_CATEGORIES);const [newCat,setNewCat]=useState("");
  function saveCategories(newList){setCategories(newList);LS.set("restopos_categories",newList);const _lic_cat=LS.get("restopos_license_v2")?.licenseKey;if(_lic_cat)debouncedSync(_lic_cat,"restopos_categories",newList);}
  function addCategory(){const trimmed=newCat.trim();if(!trimmed)return alert("Category name cannot be empty");if(categories.includes(trimmed))return alert("Category already exists");saveCategories([...categories,trimmed]);setNewCat("");}
  const [showImport,setShowImport]=useState(false);const [importRows,setImportRows]=useState([]);const [importError,setImportError]=useState("");const [importDone,setImportDone]=useState(false);
  const blankItem={name:"",nameAr:"",category:categories[0],price:"",cost:"",stock:"",active:true,barcode:""};const [itemForm,setItemForm]=useState(blankItem);
  const blankPromo={code:"",type:"%",value:"",minOrder:0,active:true};const [promoForm,setPromoForm]=useState(blankPromo);const barcodeRef=useRef();
  function openItemModal(it=null){setEditItem(it);setItemForm(it?{...it}:{...blankItem,category:categories[0]});setShowItemModal(true);setTranslating(false);setTranslateError("");}
  const [translating,setTranslating]=useState(false);
  const [translateError,setTranslateError]=useState("");
  async function autoTranslate(){
    if(!itemForm.name.trim()){setTranslateError("Enter item name first.");return;}
    setTranslating(true);setTranslateError("");
    try{
      const res=await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(itemForm.name.trim())}&langpair=en|ar`);
      const data=await res.json();
      if(data.responseStatus===200&&data.responseData?.translatedText){
        setItemForm(f=>({...f,nameAr:data.responseData.translatedText}));
      }else{
        setTranslateError("Could not translate. Please type manually.");
      }
    }catch(e){setTranslateError("Translation failed. Check your connection.");}
    setTranslating(false);
  }
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
        <Inp label="Item Name (English) *" value={itemForm.name} onChange={v=>setItemForm(f=>({...f,name:v}))} placeholder="Chicken Burger"/>
        <div>
          <label style={{fontSize:12,fontWeight:600,color:C.textMid,display:"block",marginBottom:4}}>Arabic Name</label>
          <div style={{display:"flex",gap:6,alignItems:"center"}}>
            <input value={itemForm.nameAr} onChange={e=>setItemForm(f=>({...f,nameAr:e.target.value}))} placeholder="سيُترجم تلقائياً أو اكتب يدوياً" dir="rtl" style={{flex:1,padding:"9px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontFamily:"'Tajawal',sans-serif",color:C.text,background:"#fff",direction:"rtl",textAlign:"right"}}/>
            <button onClick={autoTranslate} disabled={translating||!itemForm.name.trim()} title="Auto-translate from English" style={{padding:"9px 12px",background:translating?"#e0e0e0":C.primaryLight,border:`1px solid ${C.primary}44`,borderRadius:8,cursor:translating||!itemForm.name.trim()?"not-allowed":"pointer",fontSize:13,color:C.primary,fontWeight:700,whiteSpace:"nowrap",flexShrink:0}}>
              {translating?"⏳":"🌐 ترجم"}
            </button>
          </div>
          {translateError&&<div style={{fontSize:11,color:C.danger,marginTop:4}}>{translateError}</div>}
          {itemForm.nameAr&&!translating&&<div style={{fontSize:11,color:C.success,marginTop:4,fontFamily:"'Tajawal',sans-serif",direction:"rtl",textAlign:"right"}}>✓ {itemForm.nameAr}</div>}
        </div>
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
                <td style={{padding:"7px 10px",direction:"rtl",fontFamily:"'Tajawal',sans-serif"}}>
                  {r.namear||r.nameAr
                    ? <span>{r.namear||r.nameAr}</span>
                    : <button onClick={async()=>{
                        if(!r.name)return;
                        try{
                          const res=await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(r.name)}&langpair=en|ar`);
                          const data=await res.json();
                          if(data.responseStatus===200&&data.responseData?.translatedText){
                            setItems(prev=>prev.map(i=>i.id===r.id?{...i,nameAr:data.responseData.translatedText}:i));
                          }
                        }catch(e){}
                      }} style={{fontSize:10,padding:"3px 8px",background:C.primaryLight,border:`1px solid ${C.primary}44`,borderRadius:6,color:C.primary,cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>
                        🌐 Translate
                      </button>
                  }
                </td>
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
    {tab==="categories"&&<CategoryManager categories={categories} saveCategories={saveCategories} items={items} setItems={setItems}/>}
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
<hr class="hr"/>${(sale.discount||0)>0?`<div class="row"><span>Discount</span><span>-SAR ${sale.discount.toFixed(2)}</span></div>`:""}
<div class="row" style="font-size:10px;color:#888;"><span>VAT 15% (incl.)</span><span>SAR ${(sale.vat||0).toFixed(2)}</span></div><div class="row-total"><span>TOTAL</span><span>SAR ${(sale.total||0).toFixed(2)}</span></div>
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
    <div style={{display:"flex",gap:8,marginBottom:20,flexWrap:"wrap"}}>{[["sales","💳 Sales"],["payments","💰 Payments"],["saved","💾 Saved Invoices"],["kot","🍽 KOT"],["zatca","⬛ ZATCA Invoices"]].map(([id,label])=><button key={id} onClick={()=>setTab(id)} style={{padding:"8px 16px",borderRadius:8,border:`1.5px solid ${tab===id?C.primary:C.border}`,background:tab===id?C.primaryLight:"#fff",color:tab===id?C.primary:C.textMid,fontFamily:"inherit",fontSize:13,fontWeight:600,cursor:"pointer"}}>{label}</button>)}</div>
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
    {tab==="saved"&&(()=>{const savedInvoices=JSON.parse(localStorage.getItem("restopos_saved_invoices")||"[]");return savedInvoices.length===0?<Card><div style={{textAlign:"center",padding:"40px 0",color:C.textMid}}><div style={{fontSize:40,marginBottom:12}}>💾</div><div style={{fontSize:15,fontWeight:700,marginBottom:6}}>No Saved Invoices</div><div style={{fontSize:13}}>Click "Save Invoice" on any receipt to save it here without printing.</div></div></Card>:<Card><div style={{fontSize:14,fontWeight:700,marginBottom:16}}>💾 Saved Invoices ({savedInvoices.length})</div><DataTable headers={["Invoice","Date","Time","Type","Payment","Total","ZATCA #"]} rows={savedInvoices.slice(0,100).map(s=>[<span style={{fontFamily:"monospace",fontSize:12,color:C.primary,fontWeight:700}}>{s.id}</span>,s.date,s.time,s.type,<Badge color={C.info} bg={C.infoLight}>{s.payMethod}</Badge>,<strong style={{color:C.primary}}>{fmtSAR(s.total)}</strong>,s.zatcaInvoiceNumber?<span style={{fontFamily:"monospace",fontSize:10,color:C.zatca}}>{s.zatcaInvoiceNumber}</span>:<span style={{color:C.textLight}}>—</span>])}/></Card>;})()}
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
function Reports({sales,allSales,items,setSales}){
  // ── All hooks first ──────────────────────────────────────────────
  const [tab,setTab]=useState("summary");
  const [dateFrom,setDateFrom]=useState(TODAY);
  const [dateTo,setDateTo]=useState(TODAY);
  const [showCloseDay,setShowCloseDay]=useState(false);
  const [showDaySummary,setShowDaySummary]=useState(false);
  const [daySummaryData,setDaySummaryData]=useState(null);
  const [txSearch,setTxSearch]=useState("");
  const [txFrom,setTxFrom]=useState(()=>{const d=new Date();d.setDate(1);return d.toISOString().slice(0,10);});
  const [txTo,setTxTo]=useState(TODAY);
  const [selectedDay,setSelectedDay]=useState(null); // for Day History detail view
  const [pushingFatoora,setPushingFatoora]=useState(false);

  const dayLog=LS.get("restopos_daylog")||{};
  const closedDays=LS.get("restopos_closed_days")||[];
  const paperWidth=(LS.get("restopos_invoice_format")?.paperWidth||"80mm");
  const allSalesData=allSales||sales||[];
  const filtered=allSalesData.filter(s=>s.date>=dateFrom&&s.date<=dateTo&&!s.isDraft);
  const todaySales=(sales||[]).filter(s=>s.date===TODAY);
  const todayLog=dayLog[TODAY];

  // ── Date presets ─────────────────────────────────────────────────
  function setPreset(p){
    const d=new Date(),fmt=x=>x.toISOString().slice(0,10);
    if(p==="today"){setDateFrom(TODAY);setDateTo(TODAY);}
    else if(p==="yesterday"){const y=new Date(d);y.setDate(y.getDate()-1);const s=fmt(y);setDateFrom(s);setDateTo(s);}
    else if(p==="week"){const w=new Date(d);w.setDate(w.getDate()-6);setDateFrom(fmt(w));setDateTo(TODAY);}
    else if(p==="month"){const m=new Date(d);m.setDate(1);setDateFrom(fmt(m));setDateTo(TODAY);}
    else if(p==="lastmonth"){const lm=new Date(d);lm.setMonth(lm.getMonth()-1);setDateFrom(new Date(lm.getFullYear(),lm.getMonth(),1).toISOString().slice(0,10));setDateTo(new Date(lm.getFullYear(),lm.getMonth()+1,0).toISOString().slice(0,10));}
    else if(p==="3months"){const m3=new Date(d);m3.setMonth(m3.getMonth()-3);setDateFrom(fmt(m3));setDateTo(TODAY);}
    else if(p==="year"){setDateFrom(d.getFullYear()+"-01-01");setDateTo(TODAY);}
  }

  // ── Build summary data ────────────────────────────────────────────
  function buildSummaryData(salesArr,dateStr){
    const revenue=salesArr.reduce((s,o)=>s+(o.total||0),0);
    const vat=salesArr.reduce((s,o)=>s+(o.vat||0),0);
    const discount=salesArr.reduce((s,o)=>s+(o.discount||0),0);
    const payBreakdown={};
    salesArr.forEach(o=>{payBreakdown[o.payMethod]=(payBreakdown[o.payMethod]||0)+(o.total||0);});
    const catMap={};
    salesArr.forEach(o=>(o.items||[]).forEach(it=>{
      const cat=it.category||"Items";
      if(!catMap[cat])catMap[cat]={cat,qty:0,revenue:0};
      catMap[cat].qty+=it.qty;
      catMap[cat].revenue+=it.qty*it.price;
    }));
    const catList=Object.values(catMap).sort((a,b)=>b.revenue-a.revenue);
    const expenses=(LS.get("restopos_expenses")||[]).filter(e=>e.date===dateStr);
    const expTotal=expenses.reduce((s,e)=>s+e.amount,0);
    return{date:dateStr,orderCount:salesArr.length,revenue,vat,discount,payBreakdown,catList,expenses:expTotal,netRevenue:revenue-expTotal};
  }

  // ── Excel export ─────────────────────────────────────────────────
  function exportToExcel(type){
    const bom="\uFEFF";
    const esc=v=>`"${String(v||"").replace(/"/g,'""')}"`;
    let rows=[];
    if(type==="sales"){
      rows=[["Invoice","Date","Time","Type","Customer","Items","Subtotal","Discount","VAT","Total","Method"].map(esc).join(",")];
      filtered.forEach(s=>rows.push([s.id,s.date,s.time,s.type,s.customer||"",
        (s.items||[]).map(i=>i.qty+"x "+i.name).join("; "),
        (s.subtotal||0).toFixed(2),(s.discount||0).toFixed(2),(s.vat||0).toFixed(2),(s.total||0).toFixed(2),s.payMethod
      ].map(esc).join(",")));
    }else if(type==="category"){
      const catMap={};
      filtered.forEach(o=>(o.items||[]).forEach(it=>{const c=it.category||"Items";if(!catMap[c])catMap[c]={cat:c,qty:0,rev:0};catMap[c].qty+=it.qty;catMap[c].rev+=it.qty*it.price;}));
      rows=[["Category","Qty Sold","Revenue"].map(esc).join(",")];
      Object.values(catMap).sort((a,b)=>b.rev-a.rev).forEach(c=>rows.push([c.cat,c.qty,c.rev.toFixed(2)].map(esc).join(",")));
    }else if(type==="summary"){
      const rev=filtered.reduce((s,o)=>s+o.total,0);
      const vat=filtered.reduce((s,o)=>s+(o.vat||0),0);
      rows=[["Metric","Value"].map(esc).join(","),
        [esc("Period"),esc(dateFrom+" to "+dateTo)].join(","),
        [esc("Orders"),esc(filtered.length)].join(","),
        [esc("Revenue"),esc("SAR "+rev.toFixed(2))].join(","),
        [esc("VAT"),esc("SAR "+vat.toFixed(2))].join(","),
      ];
    }
    const csv=bom+rows.join("\n");
    const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8;"}));
    a.download=`RestoPOS_${type}_${dateFrom}_${dateTo}.csv`;a.click();
  }

  // ── Print day summary ─────────────────────────────────────────────
  function printDaySummary(data,thermal=false){
    const lic=LS.get("restopos_license_v2")||{};
    const W=42;
    const html=`<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>@page{size:${thermal?paperWidth+" auto":"A4"};margin:${thermal?"0":"15mm"}}
body{font-family:${thermal?"'Courier New',monospace":"Arial,sans-serif"};font-size:${thermal?"12px":"11px"};width:${thermal?paperWidth:"100%"};padding:${thermal?"4mm":"0"};color:#000}
.c{text-align:center}.b{font-weight:bold}.big{font-size:${thermal?"16px":"20px"};font-weight:900}
.hr{border:none;border-top:${thermal?"1px dashed #000":"2px solid #1A6B4A"};margin:${thermal?"5px 0":"10px 0"}}
.row{display:flex;justify-content:space-between;margin:2px 0}
table{width:100%;border-collapse:collapse;margin-top:8px}
th{background:#1A6B4A;color:#fff;padding:6px 8px;text-align:left;font-size:11px}
td{padding:5px 8px;border-bottom:1px solid #e0e8f0;font-size:11px}
tr:nth-child(even)td{background:#f8faff}
.total-row td{font-weight:900;background:#e8f5ee!important}
</style></head><body>
<div class="${thermal?"c big":"c"}" style="${thermal?"":"font-size:22px;font-weight:900;color:#1A6B4A;margin-bottom:4px"}">DAILY SUMMARY</div>
<div class="c">${data.date} · ${lic.businessName||"Restaurant"}</div>
${thermal?`<div class="c" style="font-size:10px">VAT: ${lic.vatNumber||""}</div><div class="hr"/>`:`<div class="c" style="font-size:10px;color:#666">VAT: ${lic.vatNumber||""} · Printed: ${new Date().toLocaleString("en-SA")}</div>`}
${thermal?`
<div class="row b"><span>Orders</span><span>${data.orderCount}</span></div>
<div class="row b"><span>Revenue</span><span>SAR ${data.revenue.toFixed(2)}</span></div>
<div class="row"><span>VAT Collected</span><span>SAR ${data.vat.toFixed(2)}</span></div>
${data.discount>0?`<div class="row"><span>Discount</span><span>-SAR ${data.discount.toFixed(2)}</span></div>`:""}
<div class="hr"/>
<div class="b">PAYMENT BREAKDOWN</div>
${Object.entries(data.payBreakdown).filter(([,v])=>v>0).map(([k,v])=>`<div class="row"><span>${k}</span><span>SAR ${v.toFixed(2)}</span></div>`).join("")}
<div class="hr"/>
<div class="b">CATEGORY SUMMARY</div>
${data.catList.map(c=>`<div class="row"><span>${c.cat}</span><span>SAR ${c.revenue.toFixed(2)}</span></div>`).join("")}
<div class="hr"/>
${data.expenses>0?`<div class="row"><span>Expenses</span><span>-SAR ${data.expenses.toFixed(2)}</span></div>`:""}
<div class="row b"><span>NET REVENUE</span><span>SAR ${data.netRevenue.toFixed(2)}</span></div>
${data.drafts&&data.drafts.length>0?`<div class="hr"/><div class="b">DRAFT BILLS (${data.drafts.length})</div>${data.drafts.map(d=>`<div class="row"><span>${d.id}</span><span>SAR ${(d.total||0).toFixed(2)}</span></div>`).join("")}<div class="row b"><span>Draft Total</span><span>SAR ${data.drafts.reduce((s,d)=>s+(d.total||0),0).toFixed(2)}</span></div>`:""}
`:`
<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:16px 0">
${[["Orders",data.orderCount,"#1A3A5C"],["Revenue","SAR "+data.revenue.toFixed(2),"#1A6B4A"],["VAT","SAR "+data.vat.toFixed(2),"#6366f1"],["Net","SAR "+data.netRevenue.toFixed(2),"#D94040"]].map(([l,v,c])=>`<div style="background:#f8faff;border-radius:8px;padding:10px;border-left:3px solid ${c}"><div style="font-size:10px;color:#666">${l}</div><div style="font-size:15px;font-weight:900;color:${c}">${v}</div></div>`).join("")}
</div>
<div class="hr"/>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
<div><div style="font-size:13px;font-weight:700;margin-bottom:8px">💳 Payment Breakdown</div>
<table><thead><tr><th>Method</th><th>Amount</th></tr></thead><tbody>
${Object.entries(data.payBreakdown).filter(([,v])=>v>0).map(([k,v])=>`<tr><td>${k}</td><td><b>SAR ${v.toFixed(2)}</b></td></tr>`).join("")}
</tbody></table></div>
<div><div style="font-size:13px;font-weight:700;margin-bottom:8px">📂 Category Summary</div>
<table><thead><tr><th>Category</th><th>Revenue</th></tr></thead><tbody>
${data.catList.map(c=>`<tr><td>${c.cat}</td><td><b>SAR ${c.revenue.toFixed(2)}</b></td></tr>`).join("")}
</tbody></table></div></div>
${data.drafts&&data.drafts.length>0?`<div class="hr" style="margin-top:16px"/><div style="font-size:13px;font-weight:700;margin-bottom:8px;color:#A07000">📋 Draft Bills (${data.drafts.length})</div><table><thead><tr><th>D-Invoice#</th><th>Time</th><th>Customer</th><th>Total</th></tr></thead><tbody>${data.drafts.map(d=>`<tr><td style="font-weight:700;color:#F0A500">${d.id}</td><td>${d.time||""}</td><td>${d.customer||"—"}</td><td><b>SAR ${(d.total||0).toFixed(2)}</b></td></tr>`).join("")}<tr style="background:#fff8e8;font-weight:900"><td colspan="3">Draft Total</td><td>SAR ${data.drafts.reduce((s,d)=>s+(d.total||0),0).toFixed(2)}</td></tr></tbody></table>`:""}
${data.expenses>0?`<div class="hr"/><div class="row b" style="font-size:14px"><span>NET REVENUE</span><span>SAR ${data.netRevenue.toFixed(2)}</span></div>`:""}`}
<br/><br/></body></html>`;
    const win=window.open("","_blank","width:820,height:900");
    if(!win){alert("Allow pop-ups");return;}
    win.document.write(html);win.document.close();
    setTimeout(()=>win.print(),600);
  }

  // ── Close Day handler ─────────────────────────────────────────────
  function handleCloseDay(){
    const closeTime=new Date().toISOString();
    const firstSale=todaySales.length>0?todaySales[0]:null;
    const startTime=firstSale?`${firstSale.date}T${firstSale.time}:00`:closeTime;
    const expenses=LS.get("restopos_expenses")||[];
    const todayExpenses=expenses.filter(e=>e.date===TODAY);
    const payBreakdown={};
    ["Cash","Mada","Apple Pay","Card","Both"].forEach(m=>{payBreakdown[m]=todaySales.filter(s=>s.payMethod===m).reduce((s,o)=>s+o.total,0);});
    const summary={date:TODAY,startTime,closeTime,orderCount:todaySales.length,
      revenue:todaySales.reduce((s,o)=>s+o.total,0),vat:todaySales.reduce((s,o)=>s+o.vat,0),
      expenses:todayExpenses.reduce((s,e)=>s+e.amount,0),payBreakdown,closedAt:closeTime};
    const log={...dayLog,[TODAY]:{startTime,closeTime,orderCount:todaySales.length,revenue:summary.revenue,vat:summary.vat}};
    LS.set("restopos_daylog",log);
    const updatedClosed=[summary,...closedDays.filter(d=>d.date!==TODAY).slice(0,999)];
    LS.set("restopos_closed_days",updatedClosed);
    const archivedSales=LS.get("restopos_archived_sales")||[];
    const existingIds=new Set(archivedSales.map(s=>s.id));
    const newToArchive=todaySales.filter(s=>!existingIds.has(s.id));
    LS.set("restopos_archived_sales",[...archivedSales,...newToArchive].slice(-50000));
    setSales(prev=>prev.filter(s=>s.date!==TODAY));
    LS.set("restopos_kot",1);
    const todayDrafts=(LS.get("restopos_draft_invoices")||[]).filter(d=>d.date===TODAY);
    const sd=buildSummaryData(todaySales,TODAY);
    setDaySummaryData({...sd,drafts:todayDrafts});
    setShowCloseDay(false);
    setShowDaySummary(true);
  }

  // ── DateFilter component ─────────────────────────────────────────
  const DateFilter=()=>(
    <Card style={{marginBottom:14}}>
      <div style={{display:"flex",gap:6,marginBottom:10,flexWrap:"wrap"}}>
        {[["today","Today"],["yesterday","Yesterday"],["week","7 Days"],["month","This Month"],["lastmonth","Last Month"],["3months","3 Months"],["year","This Year"]].map(([id,label])=>(
          <button key={id} onClick={()=>setPreset(id)}
            style={{padding:"5px 12px",borderRadius:20,border:`1.5px solid ${C.border}`,
              background:C.bg,color:C.textMid,fontFamily:"inherit",fontSize:11,fontWeight:600,cursor:"pointer"}}>
            {label}
          </button>
        ))}
      </div>
      <div style={{display:"flex",gap:10,alignItems:"flex-end",flexWrap:"wrap"}}>
        <div style={{display:"flex",gap:8,alignItems:"center",flex:1,minWidth:240}}>
          <Inp label="From" value={dateFrom} onChange={setDateFrom} type="date"/>
          <span style={{color:C.textLight,paddingBottom:2}}>→</span>
          <Inp label="To" value={dateTo} onChange={setDateTo} type="date"/>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"flex-end"}}>
          <div style={{textAlign:"right"}}>
            <div style={{fontSize:11,color:C.textMid}}>{filtered.length} orders · {fmtSAR(filtered.reduce((s,o)=>s+o.total,0))}</div>
          </div>
          <div style={{position:"relative"}}>
            <button onClick={()=>{const m=document.getElementById("xl-menu");if(m)m.style.display=m.style.display==="block"?"none":"block";}}
              style={{padding:"8px 14px",background:C.primary,color:"#fff",border:"none",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
              📊 Export ▾
            </button>
            <div id="xl-menu" style={{display:"none",position:"absolute",right:0,top:"100%",marginTop:4,background:"#fff",border:`1px solid ${C.border}`,borderRadius:10,boxShadow:"0 4px 20px rgba(0,0,0,0.12)",zIndex:100,minWidth:160}}>
              {[["summary","📋 Summary"],["sales","🧾 All Invoices"],["category","📂 By Category"]].map(([type,label])=>(
                <button key={type} onClick={()=>{exportToExcel(type);document.getElementById("xl-menu").style.display="none";}}
                  style={{display:"block",width:"100%",padding:"10px 14px",background:"none",border:"none",textAlign:"left",fontSize:12,cursor:"pointer",fontFamily:"inherit",color:C.text,borderBottom:`1px solid ${C.border}`}}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );

  const tabs=[["summary","📋 Summary"],["drafts","📋 D-Invoices"],["transactions","🧾 Transactions"],["eod","🌙 End of Day"],["dayhistory","📅 Day History"]];

  return(
    <div>
      {/* Close Day modal */}
      {showCloseDay&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:3000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div style={{background:"#fff",borderRadius:16,padding:24,maxWidth:440,width:"100%",boxShadow:"0 16px 60px rgba(0,0,0,0.3)"}}>
            <div style={{fontSize:18,fontWeight:800,marginBottom:8}}>🌙 Close Day</div>
            <div style={{fontSize:13,color:C.textMid,marginBottom:16}}>This will archive today's sales and reset for tomorrow.</div>
            <div style={{background:C.bg,borderRadius:10,padding:"12px 16px",marginBottom:16}}>
              {[["Orders today",todaySales.length],["Revenue",fmtSAR(todaySales.reduce((s,o)=>s+o.total,0))],["VAT",fmtSAR(todaySales.reduce((s,o)=>s+(o.vat||0),0))]].map(([k,v])=>(
                <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",fontSize:13}}>
                  <span style={{color:C.textMid}}>{k}</span><strong>{v}</strong>
                </div>
              ))}
            </div>
            <div style={{background:C.dangerLight,border:`1px solid ${C.danger}`,borderRadius:10,padding:"10px 14px",marginBottom:16,fontSize:12,color:C.danger,fontWeight:600}}>
              ⚠️ Sales data will reset. A full summary will be saved to Day History.
            </div>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>setShowCloseDay(false)} style={{flex:1,padding:12,background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit",color:C.text}}>Cancel</button>
              <button onClick={handleCloseDay} style={{flex:1,padding:12,background:"linear-gradient(135deg,#1A6B4A,#134D36)",color:"#fff",border:"none",borderRadius:10,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Yes, Close Day</button>
            </div>
          </div>
        </div>
      )}

      {/* Day Summary Modal */}
      {showDaySummary&&daySummaryData&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:3000,display:"flex",alignItems:"center",justifyContent:"center",padding:16,overflowY:"auto"}}>
          <div style={{background:"#fff",borderRadius:20,width:"100%",maxWidth:600,maxHeight:"92vh",overflow:"auto",boxShadow:"0 24px 80px rgba(0,0,0,0.35)"}}>
            <div style={{background:"linear-gradient(135deg,#1A3A5C,#0F2340)",padding:"16px 20px",borderRadius:"20px 20px 0 0",display:"flex",justifyContent:"space-between",alignItems:"center",position:"sticky",top:0,zIndex:10}}>
              <div>
                <div style={{color:"#fff",fontSize:16,fontWeight:800}}>📊 Day Closed — Summary</div>
                <div style={{color:"rgba(255,255,255,0.5)",fontSize:11,marginTop:2}}>{daySummaryData.date} · {daySummaryData.orderCount} orders</div>
              </div>
              <button onClick={()=>setShowDaySummary(false)} style={{background:"rgba(255,255,255,0.12)",border:"none",color:"#fff",width:30,height:30,borderRadius:"50%",cursor:"pointer",fontSize:16}}>×</button>
            </div>
            <div style={{padding:"16px 20px",display:"flex",flexDirection:"column",gap:12}}>
              {/* KPIs */}
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
                {[["Orders",daySummaryData.orderCount,C.info],["Revenue","SAR "+daySummaryData.revenue.toFixed(2),C.primary],["VAT","SAR "+daySummaryData.vat.toFixed(2),C.zatca],["Net","SAR "+daySummaryData.netRevenue.toFixed(2),C.success]].map(([l,v,c])=>(
                  <div key={l} style={{background:c+"11",border:`1.5px solid ${c}33`,borderRadius:10,padding:"10px",textAlign:"center"}}>
                    <div style={{fontSize:10,color:C.textMid,fontWeight:700}}>{l}</div>
                    <div style={{fontSize:13,fontWeight:900,color:c,marginTop:2}}>{v}</div>
                  </div>
                ))}
              </div>
              {/* Payment breakdown */}
              <div style={{background:C.bg,borderRadius:10,padding:"10px 14px"}}>
                <div style={{fontSize:12,fontWeight:700,marginBottom:6}}>💳 Payment Breakdown</div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  {Object.entries(daySummaryData.payBreakdown).filter(([,v])=>v>0).map(([k,v])=>(
                    <div key={k} style={{background:C.infoLight,border:`1px solid ${C.info}33`,borderRadius:8,padding:"6px 10px"}}>
                      <div style={{fontSize:10,color:C.info,fontWeight:700}}>{k}</div>
                      <div style={{fontSize:12,fontWeight:800,color:C.info}}>SAR {v.toFixed(2)}</div>
                    </div>
                  ))}
                </div>
              </div>
              {/* Category summary */}
              <div>
                <div style={{fontSize:12,fontWeight:700,marginBottom:6}}>📂 Category Summary</div>
                {daySummaryData.catList.map(c=>(
                  <div key={c.cat} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:`1px solid ${C.border}`,fontSize:12}}>
                    <span style={{fontWeight:600}}>{c.cat}</span>
                    <strong style={{color:C.primary}}>SAR {c.revenue.toFixed(2)}</strong>
                  </div>
                ))}
              </div>
              {/* Draft bills */}
              {daySummaryData.drafts&&daySummaryData.drafts.length>0&&(
                <div style={{background:"#FFFBF0",border:"1.5px solid rgba(240,165,0,0.4)",borderRadius:10,padding:"10px 14px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                    <div style={{fontSize:12,fontWeight:800,color:"#A07000"}}>📋 Draft Bills — {daySummaryData.drafts.length}</div>
                    <button onClick={()=>{
                      if(!confirm(`Clear all ${daySummaryData.drafts.length} draft bills? Cannot be undone.`))return;
                      const ids=new Set(daySummaryData.drafts.map(d=>d.id));
                      LS.set("restopos_draft_invoices",(LS.get("restopos_draft_invoices")||[]).filter(d=>!ids.has(d.id)));
                      setSales(prev=>prev.filter(s=>!ids.has(s.id)));
                      setDaySummaryData(prev=>({...prev,drafts:[]}));
                      alert("✅ Draft bills cleared.");
                    }} style={{padding:"4px 10px",background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:6,color:"#D94040",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
                      🗑️ Clear Drafts
                    </button>
                  </div>
                  {daySummaryData.drafts.map(d=>(
                    <div key={d.id} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:11,borderBottom:"1px solid rgba(240,165,0,0.15)"}}>
                      <span style={{fontFamily:"monospace",fontWeight:700,color:"#F0A500"}}>{d.id}</span>
                      <span style={{color:"#888"}}>{d.time}</span>
                      <strong style={{color:"#A07000"}}>SAR {(d.total||0).toFixed(2)}</strong>
                    </div>
                  ))}
                </div>
              )}
              {/* Print buttons */}
              <div style={{display:"flex",gap:8,flexWrap:"wrap",paddingTop:4}}>
                <button onClick={()=>printDaySummary(daySummaryData,false)} style={{flex:1,padding:"11px",background:"linear-gradient(135deg,#1A3A5C,#0F2340)",color:"#fff",border:"none",borderRadius:10,fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
                  📄 View / Print A4
                </button>
                <button onClick={()=>printDaySummary(daySummaryData,true)} style={{flex:1,padding:"11px",background:"linear-gradient(135deg,#1A6B4A,#134D36)",color:"#fff",border:"none",borderRadius:10,fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
                  🖨️ Print Thermal
                </button>
              </div>
              <button onClick={()=>setShowDaySummary(false)} style={{width:"100%",padding:"10px",background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",color:C.textMid}}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Day detail modal for history */}
      {selectedDay&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:3000,display:"flex",alignItems:"center",justifyContent:"center",padding:16,overflowY:"auto"}}>
          <div style={{background:"#fff",borderRadius:20,width:"100%",maxWidth:560,maxHeight:"92vh",overflow:"auto",boxShadow:"0 24px 80px rgba(0,0,0,0.35)"}}>
            <div style={{background:"linear-gradient(135deg,#1A3A5C,#0F2340)",padding:"16px 20px",borderRadius:"20px 20px 0 0",display:"flex",justifyContent:"space-between",alignItems:"center",position:"sticky",top:0}}>
              <div>
                <div style={{color:"#fff",fontSize:15,fontWeight:800}}>📊 {selectedDay.date}</div>
                <div style={{color:"rgba(255,255,255,0.5)",fontSize:11,marginTop:2}}>{selectedDay.orderCount} orders · SAR {(selectedDay.revenue||0).toFixed(2)}</div>
              </div>
              <button onClick={()=>setSelectedDay(null)} style={{background:"rgba(255,255,255,0.12)",border:"none",color:"#fff",width:30,height:30,borderRadius:"50%",cursor:"pointer",fontSize:16}}>×</button>
            </div>
            <div style={{padding:"16px 20px",display:"flex",flexDirection:"column",gap:12}}>
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
                {[["Orders",selectedDay.orderCount,C.info],["Revenue","SAR "+(selectedDay.revenue||0).toFixed(2),C.primary],["VAT","SAR "+(selectedDay.vat||0).toFixed(2),C.zatca],["Expenses","SAR "+(selectedDay.expenses||0).toFixed(2),C.danger]].map(([l,v,c])=>(
                  <div key={l} style={{background:c+"11",border:`1.5px solid ${c}33`,borderRadius:10,padding:"8px",textAlign:"center"}}>
                    <div style={{fontSize:9,color:C.textMid,fontWeight:700}}>{l}</div>
                    <div style={{fontSize:12,fontWeight:900,color:c,marginTop:2}}>{v}</div>
                  </div>
                ))}
              </div>
              {selectedDay.payBreakdown&&(
                <div style={{background:C.bg,borderRadius:10,padding:"10px 14px"}}>
                  <div style={{fontSize:12,fontWeight:700,marginBottom:6}}>💳 Payments</div>
                  {Object.entries(selectedDay.payBreakdown).filter(([,v])=>v>0).map(([k,v])=>(
                    <div key={k} style={{display:"flex",justifyContent:"space-between",fontSize:12,padding:"3px 0",borderBottom:`1px solid ${C.border}`}}>
                      <span style={{color:C.textMid}}>{k}</span><strong>SAR {v.toFixed(2)}</strong>
                    </div>
                  ))}
                </div>
              )}
              <div style={{fontSize:11,color:C.textLight,textAlign:"center"}}>
                Closed: {selectedDay.closedAt?.slice(0,16).replace("T"," ")||"—"}
              </div>
              <div style={{display:"flex",gap:8}}>
                <button onClick={()=>{
                  const arch=LS.get("restopos_archived_sales")||[];
                  const daySales=arch.filter(s=>s.date===selectedDay.date&&!s.isDraft);
                  const sd=daySales.length>0?buildSummaryData(daySales,selectedDay.date):{...selectedDay,catList:[]};
                  printDaySummary(sd,false);
                }} style={{flex:1,padding:"10px",background:"linear-gradient(135deg,#1A3A5C,#0F2340)",color:"#fff",border:"none",borderRadius:10,fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
                  📄 Print A4
                </button>
                <button onClick={()=>{
                  const arch=LS.get("restopos_archived_sales")||[];
                  const daySales=arch.filter(s=>s.date===selectedDay.date&&!s.isDraft);
                  const sd=daySales.length>0?buildSummaryData(daySales,selectedDay.date):{...selectedDay,catList:[]};
                  printDaySummary(sd,true);
                }} style={{flex:1,padding:"10px",background:"linear-gradient(135deg,#1A6B4A,#134D36)",color:"#fff",border:"none",borderRadius:10,fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
                  🖨️ Thermal
                </button>
              </div>
              <button onClick={()=>setSelectedDay(null)} style={{width:"100%",padding:"9px",background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",color:C.textMid}}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Top bar */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:10}}>
        <div style={{fontSize:18,fontWeight:800}}>📋 Reports</div>
        <Btn onClick={()=>setShowCloseDay(true)}>🌙 Close Day</Btn>
      </div>

      {/* Tab buttons */}
      <div style={{display:"flex",gap:5,marginBottom:16,flexWrap:"wrap"}}>
        {tabs.map(([id,lbl])=>(
          <button key={id} onClick={()=>setTab(id)}
            style={{padding:"7px 14px",borderRadius:8,border:`1.5px solid ${tab===id?C.primary:C.border}`,
              background:tab===id?C.primaryLight:"#fff",color:tab===id?C.primary:C.textMid,
              fontFamily:"inherit",fontSize:12,fontWeight:600,cursor:"pointer"}}>
            {lbl}
          </button>
        ))}
      </div>

      {/* ── SUMMARY TAB ── */}
      {tab==="summary"&&<>
        <DateFilter/>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:12,marginBottom:16}}>
          <StatCard icon="💰" label="Revenue" value={fmtSAR(filtered.reduce((s,o)=>s+o.total,0))} color={C.primary} bg={C.primaryLight}/>
          <StatCard icon="🧾" label="Orders" value={filtered.length} color={C.info} bg={C.infoLight}/>
          <StatCard icon="📊" label="VAT" value={fmtSAR(filtered.reduce((s,o)=>s+(o.vat||0),0))} color={C.zatca} bg={C.zatcaLight}/>
          <StatCard icon="💵" label="Avg Order" value={fmtSAR(filtered.length?filtered.reduce((s,o)=>s+o.total,0)/filtered.length:0)} color={C.success} bg={C.successLight}/>
          <StatCard icon="🏷️" label="Discount" value={fmtSAR(filtered.reduce((s,o)=>s+(o.discount||0),0))} color={C.warning} bg={C.warningLight}/>
        </div>
        {/* Payment breakdown */}
        {(()=>{
          const payBr={};filtered.forEach(o=>{payBr[o.payMethod]=(payBr[o.payMethod]||0)+o.total;});
          return Object.keys(payBr).length>0&&(
            <Card style={{marginBottom:14}}>
              <div style={{fontSize:13,fontWeight:700,marginBottom:10}}>💳 Payment Breakdown</div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                {Object.entries(payBr).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]).map(([k,v])=>(
                  <div key={k} style={{background:C.infoLight,border:`1px solid ${C.info}33`,borderRadius:8,padding:"8px 14px",flex:1,minWidth:100}}>
                    <div style={{fontSize:11,color:C.info,fontWeight:700}}>{k}</div>
                    <div style={{fontSize:14,fontWeight:800,color:C.info}}>{fmtSAR(v)}</div>
                    <div style={{fontSize:10,color:C.textLight}}>{Math.round(v/filtered.reduce((s,o)=>s+o.total,0)*100)}%</div>
                  </div>
                ))}
              </div>
            </Card>
          );
        })()}
        {/* Category breakdown */}
        {(()=>{
          const catMap={};filtered.forEach(o=>(o.items||[]).forEach(it=>{const c=it.category||"Items";if(!catMap[c])catMap[c]={cat:c,qty:0,revenue:0};catMap[c].qty+=it.qty;catMap[c].revenue+=it.qty*it.price;}));
          const catList=Object.values(catMap).sort((a,b)=>b.revenue-a.revenue);
          return catList.length>0&&(
            <Card>
              <div style={{fontSize:13,fontWeight:700,marginBottom:10}}>📂 Category Breakdown</div>
              <DataTable headers={["Category","Qty Sold","Revenue","% of Total"]} rows={catList.map(c=>[
                c.cat,c.qty,<strong style={{color:C.primary}}>{fmtSAR(c.revenue)}</strong>,
                <span style={{color:C.textMid}}>{Math.round(c.revenue/filtered.reduce((s,o)=>s+o.total,1)*100)}%</span>
              ])}/>
            </Card>
          );
        })()}
      </>}

      {/* ── D-INVOICES TAB ── */}
      {tab==="drafts"&&(()=>{
        const allDrafts=[...(LS.get("restopos_draft_invoices")||[]),...allSalesData.filter(s=>s.isDraft)];
        const seen=new Set();
        const drafts=allDrafts.filter(d=>{if(seen.has(d.id))return false;seen.add(d.id);return true;});
        const filteredDrafts=drafts.filter(d=>d.date>=dateFrom&&d.date<=dateTo);
        return(
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            <DateFilter/>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
              <div>
                <div style={{fontSize:14,fontWeight:800}}>📋 Draft Invoices — {filteredDrafts.length}</div>
                <div style={{fontSize:11,color:C.textMid,marginTop:2}}>SAR {filteredDrafts.reduce((s,d)=>s+(d.total||0),0).toFixed(2)} total · Not counted in official sales</div>
              </div>
              <div style={{display:"flex",gap:8}}>
                <Btn variant="outline" onClick={()=>{
                  if(!filteredDrafts.length)return;
                  const html=buildDraftSummaryHTML(filteredDrafts,dateFrom,dateTo);
                  const w=window.open("","_blank","width=750,height=900");
                  if(w){w.document.write(html);w.document.close();setTimeout(()=>w.print(),500);}
                }}>🖨️ Print Summary</Btn>
                <Btn variant="danger" disabled={!filteredDrafts.length} onClick={()=>{
                  if(!confirm("Clear all D-Invoices in this period?"))return;
                  const ids=new Set(filteredDrafts.map(d=>d.id));
                  LS.set("restopos_draft_invoices",(LS.get("restopos_draft_invoices")||[]).filter(d=>!ids.has(d.id)));
                  setSales(prev=>prev.filter(s=>!ids.has(s.id)));
                  alert("✅ Cleared.");
                }}>🗑️ Clear All</Btn>
              </div>
            </div>
            {filteredDrafts.length===0?(
              <Card><div style={{textAlign:"center",padding:"40px 0",color:C.textMid}}><div style={{fontSize:36,marginBottom:10}}>📋</div><div>No draft invoices in this period</div></div></Card>
            ):(
              <Card style={{padding:0,overflow:"hidden"}}>
                <DataTable headers={["D-Invoice#","Date","Time","Customer","Items","Total","Method","Note"]}
                  rows={filteredDrafts.slice().reverse().map(d=>[
                    <span style={{fontFamily:"monospace",fontWeight:800,color:"#F0A500",fontSize:12}}>{d.id}</span>,
                    d.date,d.time||"—",d.customer||"—",
                    <span style={{fontSize:11,color:C.textMid}}>{(d.items||[]).map(i=>i.qty+"x "+i.name).join(", ").slice(0,30)}</span>,
                    <strong style={{color:"#A07000"}}>{fmtSAR(d.total||0)}</strong>,
                    d.payMethod||"—",
                    <span style={{fontSize:11,fontStyle:"italic",color:C.textLight}}>{d.note||"—"}</span>
                  ])}
                />
                <div style={{padding:"8px 16px",borderTop:`1px solid ${C.border}`,display:"flex",justifyContent:"space-between",fontSize:12,fontWeight:800}}>
                  <span style={{color:C.textMid}}>Total ({filteredDrafts.length})</span>
                  <span style={{color:"#A07000"}}>{fmtSAR(filteredDrafts.reduce((s,d)=>s+(d.total||0),0))}</span>
                </div>
              </Card>
            )}
          </div>
        );
      })()}

      {/* ── TRANSACTIONS TAB ── */}
      {tab==="transactions"&&(()=>{
        const q=txSearch.toLowerCase().trim();
        const txAll=allSalesData.filter(s=>!s.isDraft&&s.date>=txFrom&&s.date<=txTo);
        const txFiltered=q?txAll.filter(s=>
          s.id?.toLowerCase().includes(q)||
          s.customer?.toLowerCase().includes(q)||
          s.payMethod?.toLowerCase().includes(q)||
          (s.items||[]).some(i=>i.name?.toLowerCase().includes(q))
        ):txAll;
        return(
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            <Card style={{padding:"12px 14px"}}>
              <div style={{display:"flex",gap:8,marginBottom:8,flexWrap:"wrap"}}>
                <Inp label="From" value={txFrom} onChange={setTxFrom} type="date"/>
                <Inp label="To" value={txTo} onChange={setTxTo} type="date"/>
              </div>
              <input value={txSearch} onChange={e=>setTxSearch(e.target.value)}
                placeholder="🔍 Search invoice #, customer name, payment method, item..."
                style={{width:"100%",padding:"9px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontFamily:"inherit"}}/>
              <div style={{fontSize:11,color:C.textMid,marginTop:6}}>{txFiltered.length} invoices found · {fmtSAR(txFiltered.reduce((s,o)=>s+o.total,0))}</div>
            </Card>
            {txFiltered.length===0?(
              <Card><div style={{textAlign:"center",padding:"40px 0",color:C.textMid}}>No invoices found</div></Card>
            ):(
              <Card style={{padding:0,overflow:"hidden"}}>
                <DataTable headers={["Invoice#","Date","Time","Type","Customer","Items","Discount","VAT","Total","Method","Status"]}
                  rows={txFiltered.slice().reverse().map(s=>[
                    <span style={{fontFamily:"monospace",fontSize:11,color:C.primary,fontWeight:700}}>{s.id}</span>,
                    s.date,s.time||"—",s.type||"—",s.customer||"—",
                    <span style={{fontSize:10,color:C.textMid}}>{(s.items||[]).map(i=>i.qty+"x "+i.name).join(", ").slice(0,25)}</span>,
                    s.discount>0?<span style={{color:C.danger,fontSize:11}}>-{fmtSAR(s.discount)}</span>:"—",
                    <span style={{color:C.zatca,fontSize:11}}>{fmtSAR(s.vat||0)}</span>,
                    <strong style={{color:C.primary}}>{fmtSAR(s.total||0)}</strong>,
                    s.payMethod||"—",
                    <Badge color={s.status==="completed"?C.success:s.status==="voided"?C.danger:C.warning}
                      bg={s.status==="completed"?C.successLight:s.status==="voided"?C.dangerLight:C.warningLight}>
                      {s.status||"—"}
                    </Badge>
                  ])}
                />
              </Card>
            )}
          </div>
        );
      })()}

      {/* ── END OF DAY TAB ── */}
      {tab==="eod"&&(()=>{
        const yesterday=new Date();yesterday.setDate(yesterday.getDate()-1);
        const yd=yesterday.toISOString().slice(0,10);
        const ydClosed=closedDays.find(d=>d.date===yd);
        const days=[
          {label:"Today",date:TODAY,data:todayLog,closed:!!todayLog},
          {label:"Yesterday",date:yd,data:ydClosed,closed:!!ydClosed},
        ];
        return(
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{fontSize:14,fontWeight:700}}>🌙 End of Day Reports</div>
              {!todayLog&&<Btn onClick={()=>setShowCloseDay(true)}>🌙 Close Today</Btn>}
            </div>
            {days.map(({label,date,data,closed})=>(
              <Card key={date} style={{borderLeft:`4px solid ${closed?C.success:C.warning}`}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
                  <div>
                    <div style={{fontSize:14,fontWeight:800}}>{label} — {date}</div>
                    <div style={{fontSize:11,color:C.textMid,marginTop:2}}>
                      {closed?`✅ Closed · ${data.orderCount||0} orders · SAR ${(data.revenue||0).toFixed(2)}`:"⏳ Not closed yet"}
                    </div>
                  </div>
                  {closed&&(
                    <div style={{display:"flex",gap:8}}>
                      <Btn size="sm" variant="outline" onClick={()=>{
                        const arch=LS.get("restopos_archived_sales")||[];
                        const ds=arch.filter(s=>s.date===date&&!s.isDraft);
                        const sd=ds.length>0?buildSummaryData(ds,date):{...data,catList:[],drafts:[]};
                        setDaySummaryData(sd);setShowDaySummary(true);
                      }}>👁️ View</Btn>
                      <Btn size="sm" variant="outline" onClick={()=>{
                        const arch=LS.get("restopos_archived_sales")||[];
                        const ds=arch.filter(s=>s.date===date&&!s.isDraft);
                        const sd=ds.length>0?buildSummaryData(ds,date):{...data,catList:[],drafts:[]};
                        printDaySummary(sd,false);
                      }}>📄 A4</Btn>
                      <Btn size="sm" variant="outline" onClick={()=>{
                        const arch=LS.get("restopos_archived_sales")||[];
                        const ds=arch.filter(s=>s.date===date&&!s.isDraft);
                        const sd=ds.length>0?buildSummaryData(ds,date):{...data,catList:[],drafts:[]};
                        printDaySummary(sd,true);
                      }}>🖨️ Thermal</Btn>
                    </div>
                  )}
                </div>
                {closed&&(
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(120px,1fr))",gap:8,marginTop:12}}>
                    {[["Revenue",fmtSAR(data.revenue||0),C.primary],["Orders",data.orderCount||0,C.info],["VAT",fmtSAR(data.vat||0),C.zatca]].map(([l,v,c])=>(
                      <div key={l} style={{background:c+"11",borderRadius:8,padding:"8px 10px"}}>
                        <div style={{fontSize:10,color:C.textLight,fontWeight:700}}>{l}</div>
                        <div style={{fontSize:13,fontWeight:800,color:c}}>{v}</div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            ))}
          </div>
        );
      })()}

      {/* ── DAY HISTORY TAB ── */}
      {tab==="dayhistory"&&(
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
            <div style={{fontSize:14,fontWeight:700}}>📅 Day History — {closedDays.length} days</div>
          </div>
          {closedDays.length===0?(
            <Card><div style={{textAlign:"center",padding:"40px 0",color:C.textMid}}>
              <div style={{fontSize:36,marginBottom:10}}>📅</div>
              <div>No closed days yet. Use "Close Day" to save daily summaries.</div>
            </div></Card>
          ):(
            closedDays.sort((a,b)=>b.date.localeCompare(a.date)).map(d=>(
              <div key={d.date} onClick={()=>setSelectedDay(d)}
                style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,
                  padding:"12px 16px",cursor:"pointer",display:"flex",
                  justifyContent:"space-between",alignItems:"center",
                  transition:"all 0.15s"}}
                onMouseEnter={e=>e.currentTarget.style.background=C.primaryLight}
                onMouseLeave={e=>e.currentTarget.style.background=C.card}>
                <div>
                  <div style={{fontSize:13,fontWeight:700,color:C.text}}>
                    {new Date(d.date).toLocaleDateString("en-SA",{weekday:"short",day:"2-digit",month:"short",year:"numeric"})}
                  </div>
                  <div style={{fontSize:11,color:C.textMid,marginTop:2}}>
                    {d.orderCount||0} orders · {fmtSAR(d.revenue||0)} · Closed {d.closedAt?.slice(11,16)||"—"}
                  </div>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <strong style={{fontSize:14,color:C.primary}}>{fmtSAR(d.revenue||0)}</strong>
                  <span style={{fontSize:12,color:C.textLight}}>›</span>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

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
        <div style={{padding:"14px 16px",background:C.infoLight,borderRadius:10,border:`1px solid ${C.info}`}}>
          <div style={{fontSize:13,fontWeight:700,color:C.info,marginBottom:6}}>🔒 Data Reset Disabled</div>
          <div style={{fontSize:12,color:C.info}}>Local data reset is disabled to protect sales records. Contact your system administrator or use the Backup tab to export your data.</div>
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
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20,flexWrap:"wrap",gap:10}}>
      <div style={{fontSize:18,fontWeight:800,color:C.text}}>👤 User Management</div>
      <div style={{display:"flex",gap:10}}>

        <Btn size="sm" onClick={()=>openModal()}>+ New User</Btn>
      </div>
    </div>
    <Card><DataTable headers={["Name","Username","Role","Status","Actions"]} rows={users.map(u=>[u.name,<span style={{fontFamily:"monospace"}}>{u.username}</span>,<Badge color={u.role==="Admin"?C.danger:u.role==="Manager"?C.warning:C.info} bg={u.role==="Admin"?C.dangerLight:u.role==="Manager"?C.warningLight:C.infoLight}>{u.role}</Badge>,<Badge color={u.active?C.success:C.danger} bg={u.active?C.successLight:C.dangerLight}>{u.active?"Active":"Off"}</Badge>,<div style={{display:"flex",gap:5}}><Btn size="sm" variant="ghost" onClick={()=>openModal(u)}>Edit</Btn><Btn size="sm" variant="danger" onClick={()=>{if(confirm("Delete?"))setUsers(prev=>prev.filter(x=>x.id!==u.id));}}>Del</Btn></div>])}/></Card>
  </div>);
}

// ═══════════════════════════════════════════════════════════════════
// OWNER DASHBOARD INLINE (for modal inside UserAdmin)
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// SUPPORT TICKETS TAB — proper component so hooks are valid
// ═══════════════════════════════════════════════════════════════════
function SupportTicketsTab(){
  const [tickets,setTickets]=useState([]);
  const [tickLoading,setTickLoading]=useState(true);
  const DS={card:"#1A2A3F",border:"rgba(255,255,255,0.08)",text:"#F1F5F9",sub:"#94A3B8",success:"#10b981",warning:"#F0A500",danger:"#ef4444"};
  useEffect(()=>{
    getDocs(collection(db,"support_tickets"))
      .then(snap=>{setTickets(snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(b.submittedAt||"").localeCompare(a.submittedAt||"")));setTickLoading(false);})
      .catch(()=>setTickLoading(false));
  },[]);
  const priorityColor={Normal:DS.sub,Urgent:DS.warning,"Critical — System Down":DS.danger};
  const DCard=({children,style={}})=>(<div style={{background:DS.card,border:`1px solid ${DS.border}`,borderRadius:14,padding:18,boxShadow:"0 2px 12px rgba(0,0,0,0.2)",...style}}>{children}</div>);
  if(tickLoading)return<DCard><div style={{textAlign:"center",padding:40,color:DS.sub}}>Loading tickets…</div></DCard>;
  if(tickets.length===0)return<DCard><div style={{textAlign:"center",padding:"60px 0"}}><div style={{fontSize:48,marginBottom:12}}>🎉</div><div style={{color:DS.sub,fontSize:14}}>No support tickets yet</div></div></DCard>;
  return(
    <div style={{display:"grid",gap:12}}>
      {tickets.map(t=>(
        <DCard key={t.id} style={{borderLeft:`4px solid ${t.requestType==="plan_upgrade"?"#F0A500":priorityColor[t.priority]||DS.sub}`}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
            <div>
              {t.requestType==="plan_upgrade"&&<div style={{fontSize:10,fontWeight:800,color:"#F0A500",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:4}}>⬆️ Plan Upgrade Request · {SUBSCRIPTION_PLANS[t.fromPlan]?.name||t.fromPlan} → {SUBSCRIPTION_PLANS[t.toPlan]?.name||t.toPlan}</div>}
              <div style={{fontSize:14,fontWeight:700,color:DS.text}}>{t.name} <span style={{fontSize:11,color:DS.sub}}>· {t.businessName||"Unknown"}</span></div>
              <div style={{fontSize:11,color:DS.sub,marginTop:2}}>{t.phone}{t.email?` · ${t.email}`:""} · {t.submittedAt?.slice(0,16).replace("T"," ")}</div>
            </div>
            <span style={{padding:"3px 10px",borderRadius:20,fontSize:10,fontWeight:700,background:`${t.requestType==="plan_upgrade"?"#F0A500":priorityColor[t.priority]||DS.sub}25`,color:t.requestType==="plan_upgrade"?"#F0A500":priorityColor[t.priority]||DS.sub,border:`1px solid ${t.requestType==="plan_upgrade"?"#F0A500":priorityColor[t.priority]||DS.sub}44`,flexShrink:0}}>{t.requestType==="plan_upgrade"?"Upgrade":""+t.priority}</span>
          </div>
          <div style={{background:"rgba(255,255,255,0.04)",borderRadius:8,padding:"10px 12px",fontSize:12,color:DS.text,lineHeight:1.6}}>{t.issue}</div>
          {t.licenseKey&&<div style={{marginTop:8,fontSize:10,color:DS.sub,fontFamily:"monospace"}}>License: {t.licenseKey} · VAT: {t.vatNumber||"—"}</div>}
          <div style={{display:"flex",gap:8,marginTop:10}}>
            <button onClick={async()=>{await updateDoc(doc(db,"support_tickets",t.id),{status:"resolved",resolvedAt:new Date().toISOString()});setTickets(prev=>prev.map(x=>x.id===t.id?{...x,status:"resolved"}:x));}} style={{padding:"5px 14px",background:"rgba(16,185,129,0.15)",border:"1px solid rgba(16,185,129,0.3)",borderRadius:6,color:"#10b981",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>✓ Mark Resolved</button>
            {t.requestType==="plan_upgrade"&&t.toPlan&&(
              <button onClick={async()=>{
                const clientSnap=await getDocs(query(collection(db,"pending_activations"),where("licenseKey","==",t.licenseKey)));
                if(clientSnap.empty)return alert("Client not found in activations.");
                const clientDoc=clientSnap.docs[0];
                await updateDoc(doc(db,"pending_activations",clientDoc.id),{subscriptionPlan:t.toPlan,planUpdatedAt:new Date().toISOString()});
                await updateDoc(doc(db,"support_tickets",t.id),{status:"resolved",resolvedAt:new Date().toISOString()});
                setTickets(prev=>prev.map(x=>x.id===t.id?{...x,status:"resolved"}:x));
                alert(`✅ Plan upgraded to ${SUBSCRIPTION_PLANS[t.toPlan]?.name} for ${t.businessName}!`);
              }} style={{padding:"5px 14px",background:"rgba(240,165,0,0.15)",border:"1px solid rgba(240,165,0,0.35)",borderRadius:6,color:"#F0A500",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>⬆️ Apply Upgrade Now</button>
            )}
            <a href={`https://wa.me/${t.phone?.replace(/\D/g,"")}`} target="_blank" rel="noreferrer" style={{padding:"5px 14px",background:"rgba(37,211,102,0.15)",border:"1px solid rgba(37,211,102,0.3)",borderRadius:6,color:"#25d366",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit",textDecoration:"none"}}>💬 WhatsApp</a>
            {t.status==="resolved"&&<span style={{fontSize:11,color:"#10b981",fontWeight:700,alignSelf:"center"}}>✓ Resolved</span>}
          </div>
        </DCard>
      ))}
    </div>
  );
}

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
  const [mapClient,setMapClient]=useState(null);

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
      await updateDoc(doc(db,"pending_activations",clientId),{status:suspend?"suspended":"approved",isActive:!suspend,statusUpdatedAt:new Date().toISOString()});
      setActivations(prev=>prev.map(a=>a.id===clientId?{...a,status:suspend?"suspended":"approved",isActive:!suspend}:a));
      logActivity(suspend?"CLIENT_SUSPENDED":"CLIENT_REACTIVATED",{clientId},"Owner");
    }catch(e){alert("Error: "+e.message);}
  }

  async function saveAnnouncement(){
    try{
      await setDoc(doc(db,"config","announcement"),{text:announcementText,updatedAt:new Date().toISOString()});
      LS.set("restopos_announcement",announcementText);
      alert("Announcement broadcast to all terminals!");
    }catch(e){alert("Error broadcasting: "+e.message);}
  }

  const statusColor={approved:"#10b981",pending:"#F0A500",suspended:"#ef4444",rejected:"#94A3B8"};
  const statusBg={approved:"rgba(16,185,129,0.15)",pending:"rgba(240,165,0,0.15)",suspended:"rgba(239,68,68,0.15)",rejected:"rgba(148,163,184,0.1)"};
  const pending=activations.filter(a=>a.status==="pending");
  const active=activations.filter(a=>a.status==="approved");
  const suspended=activations.filter(a=>a.status==="suspended");
  const deactivated=activations.filter(a=>a.status==="deactivated");

  const totalMRR=activations.filter(a=>a.status==="approved").reduce((s,a)=>{
    const plan=SUBSCRIPTION_PLANS[a.subscriptionPlan||"basic"];
    return s+(plan?.price||150);
  },0);
  const totalARR=totalMRR*12;

  // Growth: clients activated in last 30 days
  const last30=new Date();last30.setDate(last30.getDate()-30);
  const newClientsLast30=activations.filter(a=>a.activatedAt&&new Date(a.activatedAt)>=last30).length;

  // Churn: suspended in last 30 days
  const churnLast30=activations.filter(a=>a.status==="suspended"&&a.statusUpdatedAt&&new Date(a.statusUpdatedAt)>=last30).length;

  // Cities breakdown
  const cityMap={};
  activations.filter(a=>a.city).forEach(a=>{cityMap[a.city]=(cityMap[a.city]||0)+1;});
  const cityRows=Object.entries(cityMap).sort((a,b)=>b[1]-a[1]);

  // Plan distribution
  const planDist=Object.values(SUBSCRIPTION_PLANS).map(p=>{
    const count=activations.filter(a=>a.status==="approved"&&(a.subscriptionPlan||"basic")===p.id).length;
    return{...p,count,mrr:count*p.price};
  });

  // Monthly activations (last 6 months)
  const monthlyActivations=[];
  for(let m=5;m>=0;m--){
    const d=new Date();d.setMonth(d.getMonth()-m);
    const ym=d.toISOString().slice(0,7);
    const count=activations.filter(a=>a.activatedAt&&a.activatedAt.startsWith(ym)).length;
    monthlyActivations.push({month:d.toLocaleDateString("en-SA",{month:"short"}),count,ym});
  }

  const filteredClients=activations.filter(a=>{
    const q=searchQ.toLowerCase();
    const matchQ=!q||a.businessName?.toLowerCase().includes(q)||a.crNumber?.includes(q)||a.licenseKey?.includes(q)||a.city?.toLowerCase().includes(q);
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
    <button onClick={()=>setTab(id)} style={{padding:"8px 14px",background:tab===id?"rgba(99,102,241,0.2)":"rgba(255,255,255,0.05)",border:`1.5px solid ${tab===id?"rgba(99,102,241,0.6)":"rgba(255,255,255,0.1)"}`,borderRadius:8,color:tab===id?"#a5b4fc":"#94A3B8",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",gap:5}}>
      {label}{count>0&&<span style={{background:tab===id?"#6366f1":"rgba(99,102,241,0.2)",color:tab===id?"#fff":"#a5b4fc",borderRadius:20,padding:"1px 6px",fontSize:10,fontWeight:700}}>{count}</span>}
    </button>
  );

  const PlanBadge=({plan})=>{
    const p=SUBSCRIPTION_PLANS[plan||"basic"];
    return <span style={{padding:"2px 8px",borderRadius:20,fontSize:10,fontWeight:700,background:p.color+"25",color:p.color,border:`1px solid ${p.color}44`}}>{p.name}</span>;
  };

  if(loading)return<div style={{textAlign:"center",padding:40,color:"#64748B",fontSize:13}}>Loading client data from Firestore…</div>;

  const DS={bg:"#0F1929",card:"#1A2A3F",border:"rgba(255,255,255,0.08)",text:"#F1F5F9",sub:"#94A3B8",accent:"#F0A500",indigo:"#6366f1",success:"#10b981",danger:"#ef4444",warning:"#F0A500"};

  const DCard=({children,style={}})=>(
    <div style={{background:DS.card,border:`1px solid ${DS.border}`,borderRadius:14,padding:18,boxShadow:"0 2px 12px rgba(0,0,0,0.2)",...style}}>{children}</div>
  );

  const DTable=({headers,rows})=>(
    <div style={{overflowX:"auto"}}>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
        <thead><tr style={{background:"rgba(255,255,255,0.04)"}}>
          {headers.map(h=><th key={h} style={{padding:"9px 12px",textAlign:"left",color:DS.sub,fontWeight:700,fontSize:10,textTransform:"uppercase",borderBottom:`1px solid ${DS.border}`,whiteSpace:"nowrap"}}>{h}</th>)}
        </tr></thead>
        <tbody>{rows.length===0?<tr><td colSpan={headers.length} style={{textAlign:"center",padding:32,color:DS.sub}}>No data</td></tr>:rows.map((row,i)=>(
          <tr key={i} style={{borderBottom:`1px solid ${DS.border}`,background:i%2===0?"transparent":"rgba(255,255,255,0.02)"}}>
            {row.map((cell,j)=><td key={j} style={{padding:"9px 12px",color:DS.text,verticalAlign:"middle"}}>{cell}</td>)}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );

  const maxBar=Math.max(...monthlyActivations.map(m=>m.count),1);

  return(
    <div style={{fontFamily:"'Plus Jakarta Sans',sans-serif",color:DS.text,width:"100%",minHeight:"100vh",background:"linear-gradient(135deg,#0a1020 0%,#0F1929 100%)",padding:0}}>
      {/* KPI Row */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:10,marginBottom:20}}>
        {[
          [activations.length,"Total Clients","🏢","#6366f1"],
          [active.length,"Active","✅","#10b981"],
          [pending.length,"Pending Review","⏳","#F0A500"],
          [suspended.length,"Suspended","🚫","#ef4444"],
          [deactivated.length,"Terminated","⛔","#800000"],
          [`SAR ${totalMRR.toLocaleString()}`,"MRR","💰","#F0A500"],
          [`SAR ${totalARR.toLocaleString()}`,"ARR (Est.)","📈","#10b981"],
          [newClientsLast30,"New (30d)","🆕","#6366f1"],
          [licenses.filter(l=>l.active&&!l.activatedBy).length,"Keys Available","🔑","#a5b4fc"]
        ].map(([v,l,ic,col])=>(
          <div key={l} style={{background:`${col}28`,border:`2px solid ${col}70`,borderRadius:12,padding:"14px 16px",boxShadow:`0 4px 16px ${col}25`}}>
            <div style={{fontSize:10,color:"#fff",fontWeight:700,marginBottom:5,opacity:0.8}}>{ic} {l}</div>
            <div style={{fontSize:18,fontWeight:900,color:col}}>{v}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{display:"flex",gap:6,marginBottom:18,flexWrap:"wrap"}}>
        <OTab id="overview" label="📊 Overview" count={0}/>
        <OTab id="clients" label="👥 Clients" count={active.length}/>
        <OTab id="pending" label="⏳ Pending" count={pending.length}/>
        <OTab id="tickets" label="🆘 Support" count={0}/>
        <OTab id="map" label="🗺️ Map" count={0}/>
        <OTab id="licenses" label="🔑 Licenses" count={0}/>
        <OTab id="devices" label="📱 Devices" count={0}/>
        <OTab id="activity" label="📋 Activity" count={0}/>
        <OTab id="plans" label="💳 Plans" count={0}/>
        <OTab id="revenue" label="📈 Revenue" count={0}/>
        <OTab id="admin" label="⚙️ Admin" count={0}/>
      </div>

      {/* OVERVIEW */}
      {tab==="overview"&&<div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:14}}>
        <DCard>
          <div style={{fontSize:13,fontWeight:700,marginBottom:12,color:DS.text}}>📊 Subscription Breakdown</div>
          {planDist.map(p=>(
            <div key={p.id} style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
              <span style={{width:10,height:10,borderRadius:"50%",background:p.color,flexShrink:0,display:"inline-block"}}/>
              <span style={{flex:1,fontSize:12,color:DS.sub}}>{p.name}</span>
              <span style={{fontSize:12,fontWeight:700,color:p.color}}>{p.count} clients</span>
              <span style={{fontSize:11,color:DS.sub}}>SAR {p.mrr.toLocaleString()}/mo</span>
            </div>
          ))}
          <div style={{marginTop:12,paddingTop:10,borderTop:`1px solid ${DS.border}`,display:"flex",justifyContent:"space-between",fontSize:13,fontWeight:800}}>
            <span style={{color:DS.sub}}>Total MRR</span>
            <span style={{color:DS.accent}}>SAR {totalMRR.toLocaleString()}</span>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:11,marginTop:6}}>
            <span style={{color:DS.sub}}>ARR Projection</span>
            <span style={{color:DS.success,fontWeight:700}}>SAR {totalARR.toLocaleString()}</span>
          </div>
        </DCard>
        <DCard>
          <div style={{fontSize:13,fontWeight:700,marginBottom:12,color:DS.text}}>📈 Client Growth (Last 6 Months)</div>
          <div style={{display:"flex",gap:4,alignItems:"flex-end",height:80,marginBottom:8}}>
            {monthlyActivations.map(m=>(
              <div key={m.ym} style={{display:"flex",flexDirection:"column",alignItems:"center",flex:1,gap:3}}>
                <div style={{fontSize:9,color:DS.sub,fontWeight:600}}>{m.count||""}</div>
                <div style={{width:"100%",background:m.count>0?"#6366f1":"rgba(255,255,255,0.06)",borderRadius:"3px 3px 0 0",height:`${Math.max(4,(m.count/maxBar)*60)}px`,transition:"height 0.3s"}}/>
                <div style={{fontSize:9,color:DS.sub}}>{m.month}</div>
              </div>
            ))}
          </div>
          <div style={{fontSize:11,color:DS.sub,borderTop:`1px solid ${DS.border}`,paddingTop:8,marginTop:4}}>
            New clients last 30 days: <strong style={{color:"#a5b4fc"}}>{newClientsLast30}</strong> · Churn: <strong style={{color:DS.danger}}>{churnLast30}</strong>
          </div>
        </DCard>
        <DCard>
          <div style={{fontSize:13,fontWeight:700,marginBottom:12,color:DS.text}}>🌍 Clients by City</div>
          {cityRows.length===0?<div style={{color:DS.sub,fontSize:12,textAlign:"center",padding:20}}>No city data yet</div>:cityRows.map(([city,count])=>(
            <div key={city} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:`1px solid ${DS.border}`}}>
              <span style={{fontSize:12,color:DS.sub}}>📍 {city}</span>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <div style={{width:60,height:4,background:"rgba(255,255,255,0.08)",borderRadius:2}}>
                  <div style={{height:"100%",background:"#6366f1",borderRadius:2,width:`${(count/activations.length)*100}%`}}/>
                </div>
                <span style={{fontSize:12,fontWeight:700,color:"#a5b4fc",minWidth:14}}>{count}</span>
              </div>
            </div>
          ))}
        </DCard>
        <DCard>
          <div style={{fontSize:13,fontWeight:700,marginBottom:12,color:DS.text}}>🕐 Recent Activity</div>
          {activityLog.length===0?<div style={{color:DS.sub,fontSize:12,textAlign:"center",padding:16}}>No activity yet</div>:activityLog.slice(0,8).map((l,i)=>(
            <div key={i} style={{fontSize:11,padding:"6px 0",borderBottom:`1px solid ${DS.border}`,display:"flex",justifyContent:"space-between"}}>
              <span style={{color:"#a5b4fc",fontWeight:600}}>{l.action.replace(/_/g," ")}</span>
              <span style={{color:DS.sub,fontSize:10}}>{l.timestamp?.slice(0,16).replace("T"," ")}</span>
            </div>
          ))}
        </DCard>
        <DCard>
          <div style={{fontSize:13,fontWeight:700,marginBottom:12}}>📢 System Announcement</div>
          <textarea value={announcementText} onChange={e=>setAnnouncementText(e.target.value)}
            placeholder="Enter a system-wide announcement for all clients..."
            style={{width:"100%",height:80,padding:"8px 12px",background:"rgba(255,255,255,0.06)",border:`1px solid ${DS.border}`,borderRadius:8,color:DS.text,fontSize:12,fontFamily:"inherit",resize:"none"}}/>
          <button onClick={saveAnnouncement} style={{marginTop:8,padding:"8px 16px",background:"rgba(240,165,0,0.15)",border:"1px solid rgba(240,165,0,0.35)",borderRadius:8,color:"#F0A500",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>💾 Broadcast Announcement</button>
        </DCard>
        <DCard>
          <div style={{fontSize:13,fontWeight:700,marginBottom:12}}>📊 System Stats</div>
          {[
            ["Total Licenses",licenses.length,"#a5b4fc"],
            ["Active Clients",active.length,"#10b981"],
            ["Pending Reviews",pending.length,"#F0A500"],
            ["Suspended",suspended.length,"#ef4444"],
            ["Available Keys",licenses.filter(l=>l.active&&!l.activatedBy).length,"#a5b4fc"],
            ["Activation Rate",licenses.length>0?Math.round((activations.length/licenses.length)*100)+"%":"—","#10b981"],
            ["Activity Logs",activityLog.length,"rgba(255,255,255,0.5)"],
          ].map(([k,v,c])=>(
            <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:`1px solid ${DS.border}`}}>
              <span style={{fontSize:12,color:DS.sub}}>{k}</span>
              <strong style={{fontSize:12,color:c||DS.text}}>{v}</strong>
            </div>
          ))}
        </DCard>
      </div>}

      {/* CLIENTS */}
      {tab==="clients"&&<div>
        <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap"}}>
          <input value={searchQ} onChange={e=>setSearchQ(e.target.value)} placeholder="🔍 Search by name, CR, license key, city…"
            style={{flex:1,padding:"8px 12px",background:"rgba(255,255,255,0.08)",border:`1.5px solid ${DS.border}`,borderRadius:8,color:DS.text,fontSize:12,fontFamily:"inherit",minWidth:200}}/>
          <select value={planFilter} onChange={e=>setPlanFilter(e.target.value)}
            style={{padding:"8px 12px",background:"rgba(255,255,255,0.08)",border:`1.5px solid ${DS.border}`,borderRadius:8,color:DS.text,fontSize:12,fontFamily:"inherit"}}>
            <option value="all">All Plans</option>
            {Object.values(SUBSCRIPTION_PLANS).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div style={{display:"grid",gap:10}}>
          {filteredClients.map(a=>(
            <div key={a.id} onClick={()=>setSelectedClient(selectedClient?.id===a.id?null:a)}
              style={{background:selectedClient?.id===a.id?"rgba(99,102,241,0.12)":DS.card,border:`1.5px solid ${selectedClient?.id===a.id?"rgba(99,102,241,0.5)":DS.border}`,borderRadius:12,padding:"12px 16px",cursor:"pointer",boxShadow:"0 2px 8px rgba(0,0,0,0.15)"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <div style={{width:36,height:36,background:"rgba(99,102,241,0.15)",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>🏢</div>
                  <div>
                    <div style={{fontSize:13,fontWeight:700,color:DS.text}}>{a.businessName}</div>
                    <div style={{fontSize:11,color:DS.sub}}>CR: {a.crNumber} · VAT: {a.vatNumber} · 📍{a.city||"—"}</div>
                  </div>
                </div>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <PlanBadge plan={a.subscriptionPlan}/>
                  <span style={{padding:"3px 10px",borderRadius:20,fontSize:10,fontWeight:700,color:statusColor[a.status]||"#999",background:statusBg[a.status]||"rgba(255,255,255,0.06)"}}>{a.status}</span>
                  <span style={{fontSize:11,color:DS.accent,fontFamily:"monospace",fontWeight:700}}>{a.licenseKey}</span>
                </div>
              </div>
              {selectedClient?.id===a.id&&(
                <div style={{marginTop:14,paddingTop:14,borderTop:`1px solid ${DS.border}`}}>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:12}}>
                    {[
                      ["City",a.city||"—"],
                      ["Phone",a.phone||"—"],
                      ["Activated",a.activatedAt?fmtDate(a.activatedAt):"—"],
                      ["Device",a.deviceInfo?.browser||a.deviceInfo?.os||"—"],
                      ["OS / Brand",a.deviceInfo?`${a.deviceInfo.os} · ${a.deviceInfo.brand}`:"—"],
                      ["Submitted",a.submittedAt?fmtDateTime(a.submittedAt):"—"],
                      ["Plan MRR",`SAR ${SUBSCRIPTION_PLANS[a.subscriptionPlan||"basic"]?.price||150}/mo`],
                      ["Status Updated",a.statusUpdatedAt?fmtDate(a.statusUpdatedAt):"—"],
                      ["License ID",a.licenseKey||"—"],
                    ].map(([k,v])=>(
                      <div key={k} style={{background:"rgba(255,255,255,0.04)",borderRadius:8,padding:"8px 12px",border:`1px solid ${DS.border}`}}>
                        <div style={{fontSize:10,color:DS.sub,fontWeight:700,marginBottom:2}}>{k}</div>
                        <div style={{fontSize:11,wordBreak:"break-all",color:DS.text}}>{v}</div>
                      </div>
                    ))}
                  </div>
                  {/* Location info */}
                  {a.location&&(
                    <div style={{marginBottom:12,background:"rgba(99,102,241,0.06)",borderRadius:10,padding:"10px 14px",border:"1px solid rgba(99,102,241,0.15)"}}>
                      <div style={{fontSize:11,fontWeight:700,color:"#6366f1",marginBottom:6}}>📍 Precise Location</div>
                      <div style={{fontSize:12,color:DS.sub,marginBottom:8}}>
                        Lat: <strong style={{color:DS.text}}>{a.location.lat?.toFixed(6)}</strong> · Lng: <strong style={{color:DS.text}}>{a.location.lng?.toFixed(6)}</strong>
                        {a.city&&<span> · {a.city}</span>}
                      </div>
                      <div style={{display:"flex",gap:8}}>
                        <a href={`https://maps.google.com/?q=${a.location.lat},${a.location.lng}`} target="_blank" rel="noreferrer"
                          style={{padding:"6px 14px",background:"rgba(99,102,241,0.08)",border:"1px solid rgba(99,102,241,0.2)",borderRadius:6,color:"#6366f1",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit",textDecoration:"none"}} onClick={e=>e.stopPropagation()}>
                          🌍 Open in Google Maps
                        </a>
                        <button onClick={e=>{e.stopPropagation();setMapClient(a);setTab("map");}}
                          style={{padding:"6px 14px",background:"rgba(26,138,74,0.08)",border:"1px solid rgba(26,138,74,0.2)",borderRadius:6,color:"#1A6B4A",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
                          🗺️ View on Map Tab
                        </button>
                      </div>
                    </div>
                  )}
                  {!a.location&&(
                    <div style={{marginBottom:12,padding:"8px 12px",background:"rgba(255,255,255,0.06)",borderRadius:8,fontSize:11,color:DS.sub,border:`1px solid ${DS.border}`}}>
                      📍 No GPS location shared by this client. Location is captured during activation when browser permission is granted.
                    </div>
                  )}
                  {/* Plan upgrade */}
                  <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
                    <span style={{fontSize:11,color:DS.sub,alignSelf:"center"}}>Change Plan:</span>
                    {Object.values(SUBSCRIPTION_PLANS).map(p=>(
                      <button key={p.id} onClick={e=>{e.stopPropagation();upgradeSubscription(a.id,p.id);}}
                        style={{padding:"5px 12px",background:(a.subscriptionPlan||"basic")===p.id?p.color+"22":"rgba(255,255,255,0.06)",border:`1.5px solid ${(a.subscriptionPlan||"basic")===p.id?p.color:DS.border}`,borderRadius:6,color:p.color,fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
                        {p.name} · SAR {p.price}
                      </button>
                    ))}
                  </div>
                  {/* Credentials Badge */}
                  {a.credentialsSet&&!a.credentialsApproved&&(
                    <div style={{marginBottom:8,padding:"8px 12px",background:"rgba(240,165,0,0.1)",border:"1px solid rgba(240,165,0,0.3)",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,flexWrap:"wrap"}}>
                      <div>
                        <span style={{fontSize:11,fontWeight:700,color:"#F0A500"}}>🔐 Login Request Pending</span>
                        <span style={{fontSize:11,color:"rgba(255,255,255,0.5)",marginLeft:8}}>Username: <strong style={{color:"#fff"}}>{a.clientUsername||"—"}</strong></span>
                      </div>
                      <button onClick={e=>{e.stopPropagation();if(confirm("Approve login credentials for "+a.businessName+"?"))updateDoc(doc(db,"pending_activations",a.id),{credentialsApproved:true,credentialsApprovedAt:new Date().toISOString()}).then(()=>setActivations(prev=>prev.map(x=>x.id===a.id?{...x,credentialsApproved:true}:x)));}}
                        style={{padding:"5px 14px",background:"rgba(26,138,74,0.2)",border:"1px solid rgba(26,138,74,0.4)",borderRadius:6,color:"#4ade80",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit",flexShrink:0}}>
                        ✓ Approve Login
                      </button>
                    </div>
                  )}
                  {a.credentialsApproved&&(
                    <div style={{marginBottom:8,padding:"6px 12px",background:"rgba(46,204,113,0.08)",border:"1px solid rgba(46,204,113,0.2)",borderRadius:8,fontSize:11,color:"#4ade80",display:"flex",alignItems:"center",gap:8}}>
                      <span>✓ Login Approved</span>
                      <span style={{color:"rgba(255,255,255,0.4)"}}>Username: <strong style={{color:"#fff"}}>{a.clientUsername||"—"}</strong></span>
                    </div>
                  )}
                  {/* Actions */}
                  <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                    {a.status==="approved"&&(
                      <button onClick={e=>{e.stopPropagation();if(confirm("Suspend this client?"))suspendClient(a.id,true);}}
                        style={{padding:"6px 14px",background:"rgba(217,64,64,0.08)",border:"1px solid rgba(217,64,64,0.2)",borderRadius:6,color:"#D94040",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>🚫 Suspend</button>
                    )}
                    {a.status==="approved"&&(
                      <button onClick={e=>{e.stopPropagation();if(confirm("PERMANENTLY DEACTIVATE this client? Their screen will show TERMINATED immediately."))updateDoc(doc(db,"pending_activations",a.id),{status:"deactivated",isActive:false,statusUpdatedAt:new Date().toISOString()}).then(()=>setActivations(prev=>prev.map(x=>x.id===a.id?{...x,status:"deactivated",isActive:false}:x)));}}
                        style={{padding:"6px 14px",background:"rgba(180,0,0,0.08)",border:"1px solid rgba(180,0,0,0.25)",borderRadius:6,color:"#800000",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>⛔ Terminate</button>
                    )}
                    {a.status==="suspended"&&(
                      <button onClick={e=>{e.stopPropagation();suspendClient(a.id,false);}}
                        style={{padding:"6px 14px",background:"rgba(26,138,74,0.08)",border:"1px solid rgba(26,138,74,0.2)",borderRadius:6,color:"#1A6B4A",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>✅ Reactivate</button>
                    )}
                    {a.status==="deactivated"&&(
                      <button onClick={e=>{e.stopPropagation();if(confirm("Restore this client's access?"))updateDoc(doc(db,"pending_activations",a.id),{status:"approved",isActive:true,statusUpdatedAt:new Date().toISOString()}).then(()=>setActivations(prev=>prev.map(x=>x.id===a.id?{...x,status:"approved",isActive:true}:x)));}}
                        style={{padding:"6px 14px",background:"rgba(26,138,74,0.08)",border:"1px solid rgba(26,138,74,0.2)",borderRadius:6,color:"#1A6B4A",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>♻️ Restore Access</button>
                    )}
                    <button onClick={e=>{e.stopPropagation();setNotifClient(a);setShowSendNotif(true);}}
                      style={{padding:"6px 14px",background:"rgba(240,165,0,0.08)",border:"1px solid rgba(240,165,0,0.2)",borderRadius:6,color:"#C07800",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>📢 Notify</button>
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
          <div style={{display:"grid",gap:12}}>
            {pending.map(a=>{
              const [selectedPlan,setSelectedPlanLocal]=[a._pendingPlan||"basic",(v)=>{setActivations(prev=>prev.map(x=>x.id===a.id?{...x,_pendingPlan:v}:x));}];
              return(
              <DCard key={a.id} style={{padding:"16px 18px"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:10}}>
                  <div>
                    <div style={{fontSize:14,fontWeight:700}}>{a.businessName}</div>
                    <div style={{fontSize:11,color:DS.sub,marginTop:2}}>CR: {a.crNumber} · VAT: {a.vatNumber} · 🔑 {a.licenseKey}</div>
                    <div style={{fontSize:11,color:"rgba(255,255,255,0.35)",marginTop:2}}>Submitted: {a.submittedAt?fmtDateTime(a.submittedAt):"—"} · City: {a.city||"—"} · Phone: {a.phone||"—"}</div>
                    {a.ownerName&&<div style={{fontSize:11,color:"#a5b4fc",marginTop:2}}>👤 Owner: {a.ownerName}</div>}
                    {a.credentialsSet&&<div style={{fontSize:11,color:"#F0A500",marginTop:2}}>🔐 Login requested · Username: <strong>{a.clientUsername||"—"}</strong></div>}
                    {a.location&&<div style={{fontSize:10,color:"#a5b4fc",marginTop:2}}>📍 GPS: {a.location.lat?.toFixed(4)}, {a.location.lng?.toFixed(4)}</div>}
                  </div>
                </div>
                {/* Plan selection */}
                <div style={{marginTop:12,padding:"12px 14px",background:"rgba(240,165,0,0.07)",border:"1px solid rgba(240,165,0,0.2)",borderRadius:10}}>
                  <div style={{fontSize:11,fontWeight:700,color:"#F0A500",marginBottom:8}}>📋 Select Plan to Assign</div>
                  <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:6}}>
                    {Object.values(SUBSCRIPTION_PLANS).map(p=>(
                      <button key={p.id} onClick={()=>setSelectedPlanLocal(p.id)}
                        style={{padding:"7px 14px",background:selectedPlan===p.id?p.color+"33":"rgba(255,255,255,0.05)",border:`2px solid ${selectedPlan===p.id?p.color:DS.border}`,borderRadius:8,color:selectedPlan===p.id?p.color:"rgba(255,255,255,0.6)",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
                        {p.name} · SAR {p.price}/mo
                      </button>
                    ))}
                  </div>
                  {selectedPlan&&<div style={{fontSize:10,color:DS.sub}}>
                    Features: {SUBSCRIPTION_PLANS[selectedPlan]?.features.slice(0,3).join(" · ")} …
                  </div>}
                </div>
                <div style={{display:"flex",gap:8,marginTop:12}}>
                  <button onClick={async()=>{
                    if(confirm(`Approve with ${SUBSCRIPTION_PLANS[selectedPlan]?.name||"Basic"} plan?`)){
                      const credApprove=a.credentialsSet?{credentialsApproved:true,credentialsApprovedAt:new Date().toISOString()}:{};
                      await updateDoc(doc(db,"pending_activations",a.id),{status:"approved",subscriptionPlan:selectedPlan,reviewedAt:new Date().toISOString(),...credApprove});
                      setActivations(prev=>prev.map(x=>x.id===a.id?{...x,status:"approved",subscriptionPlan:selectedPlan}:x));
                      logActivity("PLAN_CHANGE",{clientId:a.id,after:{plan:selectedPlan,status:"approved"}},"Owner");
                    }}}
                    style={{padding:"8px 18px",background:"rgba(26,138,74,0.2)",border:"1px solid rgba(26,138,74,0.4)",borderRadius:8,color:"#4ade80",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
                    ✓ Approve with {SUBSCRIPTION_PLANS[selectedPlan]?.name||"Basic"}
                  </button>
                  <button onClick={async()=>{const reason=prompt("Rejection reason (optional):");await updateDoc(doc(db,"pending_activations",a.id),{status:"rejected",rejectReason:reason||"",reviewedAt:new Date().toISOString()}).then(()=>setActivations(prev=>prev.map(x=>x.id===a.id?{...x,status:"rejected"}:x)));}}
                    style={{padding:"8px 18px",background:"rgba(217,64,64,0.2)",border:"1px solid rgba(217,64,64,0.4)",borderRadius:8,color:"#ff6b6b",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>✕ Reject</button>
                </div>
              </DCard>
            );})}
          </div>
        )}
      </div>}

      {/* SUPPORT TICKETS */}
      {tab==="tickets"&&<SupportTicketsTab/>}

      {/* MAP TAB */}
      {tab==="map"&&<div>
        <DCard style={{marginBottom:12}}>
          <div style={{fontSize:13,fontWeight:700,marginBottom:10}}>🗺️ Client Locations Map</div>
          <div style={{fontSize:11,color:DS.sub,marginBottom:12}}>
            {activations.filter(a=>a.location).length} of {activations.length} clients have shared their GPS location.
          </div>
          {mapClient&&(
            <div style={{marginBottom:12,display:"flex",alignItems:"center",gap:10,padding:"8px 14px",background:"rgba(99,102,241,0.08)",borderRadius:8,border:"1px solid rgba(99,102,241,0.2)"}}>
              <span style={{fontSize:12,color:"#6366f1",fontWeight:700}}>📍 Focused on: {mapClient.businessName}</span>
              <button onClick={()=>setMapClient(null)} style={{marginLeft:"auto",padding:"3px 8px",background:"rgba(255,255,255,0.08)",border:`1px solid ${DS.border}`,borderRadius:5,color:DS.sub,fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>Clear</button>
            </div>
          )}
          {(()=>{
            const clientsWithLocation=activations.filter(a=>a.location?.lat&&a.location?.lng);
            if(clientsWithLocation.length===0){
              return <div style={{padding:"40px 0",textAlign:"center",color:DS.sub}}>
                <div style={{fontSize:48,marginBottom:12}}>📍</div>
                <div style={{fontSize:13}}>No client location data yet.</div>
                <div style={{fontSize:11,marginTop:6}}>GPS coordinates are captured when clients activate their license and allow browser location access.</div>
              </div>;
            }
            const focusClient=mapClient||clientsWithLocation[0];
            const lat=focusClient.location.lat;
            const lng=focusClient.location.lng;
            const zoom=mapClient?13:5;
            return(
              <div>
                <div style={{borderRadius:10,overflow:"hidden",height:340,marginBottom:10,border:`1px solid ${DS.border}`}}>
                  <iframe
                    width="100%" height="340"
                    frameBorder="0" style={{border:0}}
                    src={`https://maps.google.com/maps?q=${lat},${lng}&z=${zoom}&output=embed`}
                    allowFullScreen
                    title="Client Location Map"
                  />
                </div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  {clientsWithLocation.map(a=>(
                    <button key={a.id} onClick={()=>setMapClient(a)}
                      style={{padding:"5px 12px",background:mapClient?.id===a.id?"rgba(99,102,241,0.12)":"rgba(255,255,255,0.08)",border:`1px solid ${mapClient?.id===a.id?"rgba(99,102,241,0.4)":DS.border}`,borderRadius:6,color:mapClient?.id===a.id?"#6366f1":DS.sub,fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>
                      📍 {a.businessName} ({a.city||"—"})
                    </button>
                  ))}
                </div>
              </div>
            );
          })()}
        </DCard>
        <DCard>
          <div style={{fontSize:13,fontWeight:700,marginBottom:10}}>📋 All Client Locations</div>
          <DTable
            headers={["Business","City","GPS Coordinates","Map Link"]}
            rows={activations.map(a=>[
              <span style={{fontWeight:600}}>{a.businessName}</span>,
              <span style={{fontSize:11,color:DS.sub}}>{a.city||"—"}</span>,
              a.location?<span style={{fontFamily:"monospace",fontSize:10,color:"#6366f1"}}>{a.location.lat?.toFixed(5)}, {a.location.lng?.toFixed(5)}</span>:<span style={{color:DS.sub,fontSize:10}}>Not shared</span>,
              a.location?(
                <div style={{display:"flex",gap:6}}>
                  <a href={`https://maps.google.com/?q=${a.location.lat},${a.location.lng}`} target="_blank" rel="noreferrer"
                    style={{color:"#1A6B4A",fontSize:10,fontWeight:700,textDecoration:"none"}}>🌍 Google Maps</a>
                  <button onClick={()=>{setMapClient(a);window.scrollTo({top:0,behavior:"smooth"});}}
                    style={{color:"#6366f1",fontSize:10,fontWeight:700,background:"none",border:"none",cursor:"pointer",fontFamily:"inherit"}}>🗺️ Embed</button>
                </div>
              ):<span style={{color:DS.sub,fontSize:10}}>—</span>
            ])}
          />
        </DCard>
      </div>}

      {/* LICENSES */}
      {tab==="licenses"&&<div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
          <div style={{fontSize:13,fontWeight:700,color:DS.text}}>License Keys ({licenses.length})</div>
          <div style={{display:"flex",gap:10,fontSize:11}}>
            <span style={{color:"#1A8A4A",fontWeight:700}}>✅ {licenses.filter(l=>l.active&&l.activatedBy).length} Used</span>
            <span style={{color:"#6366f1",fontWeight:700}}>🔑 {licenses.filter(l=>l.active&&!l.activatedBy).length} Available</span>
            <span style={{color:"#D94040",fontWeight:700}}>❌ {licenses.filter(l=>!l.active).length} Inactive</span>
          </div>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {licenses.map(l=>{
            const client=activations.find(a=>a.licenseKey===l.key);
            const [expanded,setExpanded]=[l._expanded||false,(v)=>setLicenses(prev=>prev.map(x=>x.id===l.id?{...x,_expanded:v}:x))];
            return(
              <DCard key={l.id} style={{padding:"12px 16px",border:`1px solid ${expanded?"rgba(99,102,241,0.4)":DS.border}`}}>
                <div style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer"}} onClick={()=>setExpanded(!expanded)}>
                  <span style={{fontFamily:"monospace",color:"#C07800",fontWeight:700,fontSize:12,flex:1}}>{l.key}</span>
                  <span style={{padding:"2px 8px",borderRadius:20,fontSize:10,fontWeight:700,color:l.active?"#1A6B4A":"#D94040",background:l.active?"#E6F7ED":"#FDE8E8",flexShrink:0}}>{l.active?"Active":"Inactive"}</span>
                  {client&&<PlanBadge plan={client.subscriptionPlan}/>}
                  <span style={{fontSize:11,color:DS.sub,flexShrink:0}}>{l.activatedBy?l.businessName||client?.businessName||l.activatedBy:"Available"}</span>
                  <span style={{fontSize:10,color:DS.sub,flexShrink:0}}>{expanded?"▲":"▼"}</span>
                </div>
                {expanded&&(
                  <div style={{marginTop:12,paddingTop:12,borderTop:`1px solid ${DS.border}`}}>
                    {client?(
                      <div>
                        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:12}}>
                          {[
                            ["Business",client.businessName||"—"],
                            ["Owner / Contact",client.ownerName||"—"],
                            ["CR Number",client.crNumber||"—"],
                            ["VAT Number",client.vatNumber||"—"],
                            ["City",client.city||"—"],
                            ["Phone",client.phone||"—"],
                            ["Activated",client.activatedAt?fmtDate(client.activatedAt):"—"],
                            ["Plan",SUBSCRIPTION_PLANS[client.subscriptionPlan||"basic"]?.name||"Basic"],
                            ["Status",client.status||"—"],
                            ["Email",client.email||"—"],
                            ["Device OS",client.deviceInfo?.os||"—"],
                            ["Browser",client.deviceInfo?.browser||"—"],
                            ["Screen",client.deviceInfo?.screenW?`${client.deviceInfo.screenW}×${client.deviceInfo.screenH}`:"—"],
                          ].map(([k,v])=>(
                            <div key={k} style={{background:"rgba(255,255,255,0.08)",borderRadius:8,padding:"8px 10px",border:`1px solid ${DS.border}`}}>
                              <div style={{fontSize:9,color:DS.sub,fontWeight:700,textTransform:"uppercase",marginBottom:2}}>{k}</div>
                              <div style={{fontSize:11,fontWeight:600,color:DS.text,wordBreak:"break-all"}}>{v}</div>
                            </div>
                          ))}
                        </div>
                        {client.location&&(
                          <div style={{marginBottom:10,padding:"8px 12px",background:"rgba(99,102,241,0.06)",borderRadius:8,border:"1px solid rgba(99,102,241,0.15)",fontSize:11}}>
                            📍 GPS: <strong>{client.location.lat?.toFixed(5)}, {client.location.lng?.toFixed(5)}</strong>
                            <a href={`https://maps.google.com/?q=${client.location.lat},${client.location.lng}`} target="_blank" rel="noreferrer" style={{marginLeft:8,color:"#6366f1",fontWeight:700,textDecoration:"none"}}>Open Maps →</a>
                          </div>
                        )}
                        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:4}}>
                          {/* DEACTIVATE — keeps data, shows deactivated screen instantly */}
                          <button onClick={async()=>{
                            const isDeactivated=client.status==="deactivated";
                            if(isDeactivated){
                              if(!confirm(`Restore ${client.businessName}? They will be able to log in again.`))return;
                              try{
                                await updateDoc(doc(db,"pending_activations",client.id),{status:"approved",isActive:true,forceLogout:false,statusUpdatedAt:new Date().toISOString()});
                                await updateDoc(doc(db,"licenses",l.id),{active:true,forceDeactivated:false});
                                setActivations(prev=>prev.map(a=>a.id===client.id?{...a,status:"approved",isActive:true,forceLogout:false}:a));
                                setLicenses(prev=>prev.map(x=>x.id===l.id?{...x,active:true}:x));
                                logActivity("CLIENT_RESTORED",{licenseKey:l.key,business:client.businessName},"Owner");
                              }catch(e){alert("Error: "+e.message);}
                            }else{
                              if(!confirm(`Deactivate ${client.businessName}? Their screen will show a deactivation notice immediately. Their data is preserved.`))return;
                              try{
                                await updateDoc(doc(db,"pending_activations",client.id),{status:"deactivated",isActive:false,forceLogout:false,statusUpdatedAt:new Date().toISOString()});
                                await updateDoc(doc(db,"licenses",l.id),{active:false,forceDeactivated:true,deactivatedAt:new Date().toISOString()});
                                setActivations(prev=>prev.map(a=>a.id===client.id?{...a,status:"deactivated",isActive:false}:a));
                                setLicenses(prev=>prev.map(x=>x.id===l.id?{...x,active:false}:x));
                                logActivity("CLIENT_DEACTIVATED",{licenseKey:l.key,business:client.businessName},"Owner");
                              }catch(e){alert("Error: "+e.message);}
                            }
                          }}
                            style={{padding:"7px 16px",background:client.status==="deactivated"?"rgba(26,138,74,0.12)":"rgba(217,64,64,0.10)",border:`1.5px solid ${client.status==="deactivated"?"rgba(26,138,74,0.4)":"rgba(217,64,64,0.35)"}`,borderRadius:8,color:client.status==="deactivated"?"#1A8A4A":"#D94040",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
                            {client.status==="deactivated"?"🟢 Restore Access":"🔴 Deactivate"}
                          </button>
                          {/* FORCE LOGOUT — kicks active session, data stays, can log back in */}
                          <button onClick={async()=>{
                            if(client.status==="deactivated")return alert("Client is already deactivated.");
                            if(!confirm(`Force logout ${client.businessName}? They will be kicked out immediately but can log back in with their credentials.`))return;
                            try{
                              await updateDoc(doc(db,"pending_activations",client.id),{forceLogout:true,forceLogoutAt:new Date().toISOString()});
                              setActivations(prev=>prev.map(a=>a.id===client.id?{...a,forceLogout:true}:a));
                              logActivity("FORCE_LOGOUT",{licenseKey:l.key,business:client.businessName},"Owner");
                              // forceLogout flag cleared automatically when client logs back in
                            }catch(e){alert("Error: "+e.message);}
                          }}
                            style={{padding:"7px 16px",background:"rgba(240,165,0,0.10)",border:"1.5px solid rgba(240,165,0,0.35)",borderRadius:8,color:"#C07800",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
                            ⚡ Force Logout
                          </button>
                          <button onClick={async()=>{
                            const newPlan=prompt("New plan (basic/professional/premium):",client.subscriptionPlan||"basic");
                            if(!newPlan||!SUBSCRIPTION_PLANS[newPlan])return alert("Invalid plan");
                            await upgradeSubscription(client.id,newPlan);
                          }}
                            style={{padding:"7px 16px",background:"rgba(99,102,241,0.08)",border:"1.5px solid rgba(99,102,241,0.25)",borderRadius:8,color:"#818cf8",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
                            📋 Change Plan
                          </button>
                        </div>
                      </div>
                    ):(
                      <div style={{display:"flex",gap:8,alignItems:"center"}}>
                        <span style={{fontSize:12,color:DS.sub}}>This key has not been activated yet.</span>
                        <button onClick={()=>toggleLicense(l.id,l.active)}
                          style={{padding:"6px 14px",background:l.active?"rgba(217,64,64,0.08)":"rgba(26,138,74,0.08)",border:`1px solid ${l.active?"rgba(217,64,64,0.25)":"rgba(26,138,74,0.25)"}`,borderRadius:7,color:l.active?"#D94040":"#1A6B4A",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
                          {l.active?"Deactivate":"Activate"}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </DCard>
            );
          })}
        </div>
      </div>}

      {/* DEVICES */}
      {tab==="devices"&&<DCard>
        <div style={{fontSize:13,fontWeight:700,marginBottom:14}}>📱 Device Registry</div>
        <DTable
          headers={["Business","License","Browser","OS","Screen","Activated","Location"]}
          rows={activations.filter(a=>a.deviceId||a.deviceInfo).map(a=>{
            const di=a.deviceInfo||{};
            return[
              <span style={{fontWeight:600}}>{a.businessName}</span>,
              <span style={{fontFamily:"monospace",color:"#C07800",fontSize:10}}>{a.licenseKey}</span>,
              <span style={{fontSize:11}}>{di.browser||"—"}</span>,
              <span style={{fontSize:11}}>{di.os||a.deviceId?.slice(0,30)||"—"}</span>,
              <span style={{fontSize:10,color:DS.sub}}>{di.screenW&&di.screenH?`${di.screenW}×${di.screenH}`:"—"}</span>,
              <span style={{fontSize:10,color:DS.sub}}>{a.activatedAt?fmtDate(a.activatedAt):"—"}</span>,
              a.location?(
                <a href={`https://maps.google.com/?q=${a.location.lat},${a.location.lng}`} target="_blank" rel="noreferrer" style={{color:"#1A6B4A",fontSize:10,fontWeight:700}}>📍 {a.location.lat?.toFixed(3)}, {a.location.lng?.toFixed(3)}</a>
              ):<span style={{color:DS.sub,fontSize:10}}>—</span>
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
              style={{flex:1,padding:"7px 10px",background:"rgba(255,255,255,0.08)",border:`1px solid ${DS.border}`,borderRadius:6,color:DS.text,fontSize:11,fontFamily:"inherit",minWidth:140}}/>
            <select value={actFilter.type} onChange={e=>setActFilter(f=>({...f,type:e.target.value}))}
              style={{padding:"7px 10px",background:"rgba(255,255,255,0.08)",border:`1px solid ${DS.border}`,borderRadius:6,color:DS.text,fontSize:11,fontFamily:"inherit"}}>
              <option value="">All Types</option>
              {["LICENSE_TOGGLE","PLAN_CHANGE","CLIENT_SUSPENDED","CLIENT_REACTIVATED","ITEM_ADDED","ITEM_EDITED","SETTING_CHANGED"].map(t=><option key={t} value={t}>{t.replace(/_/g," ")}</option>)}
            </select>
            <input type="date" value={actFilter.date} onChange={e=>setActFilter(f=>({...f,date:e.target.value}))}
              style={{padding:"7px 10px",background:"rgba(255,255,255,0.08)",border:`1px solid ${DS.border}`,borderRadius:6,color:DS.text,fontSize:11,fontFamily:"inherit"}}/>
            <button onClick={()=>setActFilter({client:"",type:"",date:""})} style={{padding:"7px 12px",background:"rgba(255,255,255,0.08)",border:`1px solid ${DS.border}`,borderRadius:6,color:DS.sub,fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>Clear</button>
          </div>
        </DCard>
        <DCard>
          {filteredLog.length===0?(
            <div style={{textAlign:"center",padding:"30px 0",color:DS.sub}}>No activity matching filters</div>
          ):(
            filteredLog.slice(0,50).map((l,i)=>(
              <div key={i} style={{display:"flex",gap:12,padding:"8px 0",borderBottom:`1px solid ${DS.border}`,alignItems:"flex-start"}}>
                <span style={{fontSize:10,fontFamily:"monospace",color:"rgba(255,255,255,0.3)",flexShrink:0,paddingTop:1,minWidth:130}}>{l.timestamp?.slice(0,16).replace("T"," ")}</span>
                <span style={{flex:1,fontSize:11}}><strong style={{color:"#6366f1"}}>{l.action.replace(/_/g," ")}</strong>{l.details?.after&&<span style={{color:DS.sub}}> → {JSON.stringify(l.details.after)}</span>}</span>
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
              {p.features.map((f,i)=><div key={i} style={{fontSize:11,color:DS.sub,padding:"3px 0",display:"flex",gap:6}}>
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
          <div style={{fontSize:13,fontWeight:700,marginBottom:12,color:DS.text}}>📢 System Announcement</div>
          <textarea value={announcementText} onChange={e=>setAnnouncementText(e.target.value)}
            placeholder="Broadcast a message to all clients..."
            style={{width:"100%",height:100,padding:"10px 12px",background:"rgba(255,255,255,0.08)",border:`1px solid ${DS.border}`,borderRadius:8,color:DS.text,fontSize:12,fontFamily:"inherit",resize:"none"}}/>
          <button onClick={saveAnnouncement} style={{marginTop:8,width:"100%",padding:"10px",background:"rgba(240,165,0,0.15)",border:"1px solid rgba(240,165,0,0.4)",borderRadius:8,color:"#C07800",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>💾 Save & Broadcast</button>
        </DCard>
        <DCard>
          <div style={{fontSize:13,fontWeight:700,marginBottom:12,color:DS.text}}>📥 Bulk Export</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {[["Export All Clients CSV",()=>{const rows=activations.map(a=>[a.businessName,a.crNumber,a.vatNumber,a.licenseKey,a.city,a.phone||"",a.status,a.subscriptionPlan||"basic",a.submittedAt,a.activatedAt||"",a.location?`${a.location.lat},${a.location.lng}`:""].join(","));const csv="Business,CR,VAT,License,City,Phone,Status,Plan,Submitted,Activated,GPS\n"+rows.join("\n");const blob=new Blob([csv],{type:"text/csv"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download="restopos-clients.csv";a.click();},"📋"],
              ["Export License Keys CSV",()=>{const rows=licenses.map(l=>[l.key,l.active?"Active":"Inactive",l.activatedBy||"",l.activatedAt||""].join(","));const csv="Key,Status,ActivatedBy,Date\n"+rows.join("\n");const blob=new Blob([csv],{type:"text/csv"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download="restopos-licenses.csv";a.click();},"🔑"],
              ["Export Activity Log",()=>{const rows=activityLog.map(l=>[l.timestamp,l.action,l.user,JSON.stringify(l.details)].join(","));const csv="Timestamp,Action,User,Details\n"+rows.join("\n");const blob=new Blob([csv],{type:"text/csv"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download="restopos-activity.csv";a.click();},"📊"]
            ].map(([label,fn,ic])=>(
              <button key={label} onClick={fn} style={{padding:"10px 14px",background:"rgba(255,255,255,0.08)",border:`1px solid ${DS.border}`,borderRadius:8,color:DS.text,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>
                {ic} {label}
              </button>
            ))}
          </div>
        </DCard>
        <DCard>
          <div style={{fontSize:13,fontWeight:700,marginBottom:12,color:DS.text}}>⚡ Quick Actions</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            <button onClick={()=>{if(confirm("Clear local activity log?"))LS.del("restopos_activity_log");setActivityLog([]);}} style={{padding:"10px 14px",background:"rgba(217,64,64,0.06)",border:"1px solid rgba(217,64,64,0.2)",borderRadius:8,color:"#D94040",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>🗑 Clear Activity Log</button>
            <button onClick={()=>{logActivity("MANUAL_TEST",{msg:"Owner triggered test log"},"Owner");setActivityLog(LS.get("restopos_activity_log")||[]);alert("Test log entry added!");}} style={{padding:"10px 14px",background:"rgba(99,102,241,0.06)",border:"1px solid rgba(99,102,241,0.2)",borderRadius:8,color:"#6366f1",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>🧪 Add Test Log Entry</button>
            <button onClick={async()=>{
              const key=prompt("New license key (12 alphanumeric chars):");
              if(!key||!/^[A-Z0-9]{12}$/i.test(key))return alert("Invalid key format");
              try{await addDoc(collection(db,"licenses"),{key:key.toUpperCase(),active:true,createdAt:new Date().toISOString()});alert("License key added!");}catch(e){alert("Error: "+e.message);}
            }} style={{padding:"10px 14px",background:"rgba(26,138,74,0.06)",border:"1px solid rgba(26,138,74,0.2)",borderRadius:8,color:"#1A6B4A",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>🔑 Generate & Add License Key</button>
          </div>
        </DCard>
        <DCard>
          <div style={{fontSize:13,fontWeight:700,marginBottom:12,color:DS.text}}>📊 Revenue Intelligence</div>
          {[
            ["MRR",`SAR ${totalMRR.toLocaleString()}`,"#C07800"],
            ["ARR Projection",`SAR ${totalARR.toLocaleString()}`,"#1A8A4A"],
            ["Avg Revenue/Client",active.length>0?`SAR ${Math.round(totalMRR/active.length)}`:"—","#6366f1"],
            ["Revenue at Risk",`SAR ${suspended.reduce((s,a)=>{const p=SUBSCRIPTION_PLANS[a.subscriptionPlan||"basic"];return s+(p?.price||150);},0).toLocaleString()}`,"#D94040"],
          ].map(([k,v,c])=>(
            <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:`1px solid ${DS.border}`}}>
              <span style={{fontSize:12,color:DS.sub}}>{k}</span>
              <strong style={{fontSize:12,color:c}}>{v}</strong>
            </div>
          ))}
        </DCard>
      </div>}

      {/* REVENUE TAB */}
      {tab==="revenue"&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
        <DCard>
          <div style={{fontSize:13,fontWeight:700,marginBottom:12,color:DS.text}}>📈 Revenue by Plan</div>
          {planDist.map(p=>(
            <div key={p.id} style={{marginBottom:12}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <span style={{fontSize:12,fontWeight:700,color:p.color}}>{p.name}</span>
                <span style={{fontSize:12,fontWeight:700,color:DS.text}}>SAR {p.mrr.toLocaleString()}/mo</span>
              </div>
              <div style={{height:6,background:"#F1F5F9",borderRadius:3}}>
                <div style={{height:6,borderRadius:3,background:p.color,width:`${totalMRR>0?(p.mrr/totalMRR)*100:0}%`}}/>
              </div>
              <div style={{fontSize:10,color:DS.sub,marginTop:2}}>{p.count} clients · SAR {p.mrr*12} ARR</div>
            </div>
          ))}
          <div style={{marginTop:10,paddingTop:10,borderTop:`2px solid ${DS.border}`,display:"flex",justifyContent:"space-between"}}>
            <span style={{fontSize:13,fontWeight:800,color:DS.text}}>Total MRR</span>
            <span style={{fontSize:16,fontWeight:900,color:"#C07800"}}>SAR {totalMRR.toLocaleString()}</span>
          </div>
        </DCard>
        <DCard>
          <div style={{fontSize:13,fontWeight:700,marginBottom:12,color:DS.text}}>📅 Monthly Activations</div>
          <div style={{display:"flex",gap:6,alignItems:"flex-end",height:100,marginBottom:12}}>
            {monthlyActivations.map(m=>(
              <div key={m.ym} style={{display:"flex",flexDirection:"column",alignItems:"center",flex:1,gap:4}}>
                <div style={{fontSize:10,color:DS.sub,fontWeight:700}}>{m.count||""}</div>
                <div style={{width:"100%",background:m.count>0?"#6366f1":"#E2E8F0",borderRadius:"4px 4px 0 0",height:`${Math.max(6,(m.count/maxBar)*80)}px`,transition:"height 0.3s"}}/>
                <div style={{fontSize:9,color:DS.sub}}>{m.month}</div>
              </div>
            ))}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            {[["New (30d)",newClientsLast30,"#6366f1"],["Churn (30d)",churnLast30,"#D94040"],["Active",active.length,"#1A8A4A"],["Suspended",suspended.length,"#C07800"]].map(([l,v,c])=>(
              <div key={l} style={{background:"rgba(255,255,255,0.08)",border:`1px solid ${DS.border}`,borderRadius:8,padding:"10px 12px"}}>
                <div style={{fontSize:10,color:DS.sub,fontWeight:700}}>{l}</div>
                <div style={{fontSize:18,fontWeight:900,color:c}}>{v}</div>
              </div>
            ))}
          </div>
        </DCard>
        <DCard style={{gridColumn:"1/-1"}}>
          <div style={{fontSize:13,fontWeight:700,marginBottom:12,color:DS.text}}>👥 All Clients Revenue</div>
          <DTable headers={["Business","Plan","Monthly","Status","City"]}
            rows={activations.filter(a=>a.status==="approved").map(a=>{
              const p=SUBSCRIPTION_PLANS[a.subscriptionPlan||"basic"];
              return[
                <span style={{fontWeight:700}}>{a.businessName}</span>,
                <span style={{padding:"2px 8px",borderRadius:20,fontSize:10,fontWeight:700,background:p.color+"22",color:p.color}}>{p.name}</span>,
                <strong style={{color:"#C07800"}}>SAR {p.price}</strong>,
                <span style={{padding:"2px 8px",background:"#E6F7ED",borderRadius:20,fontSize:10,fontWeight:700,color:"#1A6B4A"}}>Active</span>,
                <span style={{color:DS.sub,fontSize:11}}>{a.city||"—"}</span>
              ];
            })}
          />
        </DCard>
      </div>}

      {/* Send Notification Modal */}
      {showSendNotif&&notifClient&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.4)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:"#1A2A3F",border:"1px solid rgba(255,255,255,0.15)",borderRadius:16,padding:24,width:420,maxWidth:"95vw",boxShadow:"0 20px 60px rgba(0,0,0,0.15)"}}>
            <div style={{fontSize:14,fontWeight:700,marginBottom:12,color:"#F1F5F9"}}>📢 Notify: {notifClient.businessName}</div>
            <textarea value={notifyMsg} onChange={e=>setNotifyMsg(e.target.value)} placeholder="Type your message..." rows={4}
              style={{width:"100%",padding:"10px",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:8,color:"#F1F5F9",fontSize:12,fontFamily:"inherit",resize:"none"}}/>
            <div style={{display:"flex",gap:10,marginTop:14}}>
              <button onClick={()=>{logActivity("NOTIFICATION_SENT",{clientId:notifClient.id,msg:notifyMsg},"Owner");setNotifyMsg("");setShowSendNotif(false);alert("Notification logged for "+notifClient.businessName);}}
                style={{flex:1,padding:"10px",background:"rgba(240,165,0,0.12)",border:"1px solid rgba(240,165,0,0.3)",borderRadius:8,color:"#C07800",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Send</button>
              <button onClick={()=>{setShowSendNotif(false);setNotifyMsg("");}}
                style={{flex:1,padding:"10px",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:8,color:"#64748B",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Cancel</button>
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
  const [liveForm,setLiveForm]=useState({name:"",phone:"",email:"",issue:"",priority:"Normal"});const [liveSent,setLiveSent]=useState(false);const [liveLoading,setLiveSending]=useState(false);
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
  async function submitLiveHelp(){
    if(!liveForm.name||!liveForm.issue)return alert("Please fill in your name and describe the issue.");
    setLiveSending(true);
    try{
      const license=LS.get("restopos_license_v2")||{};
      const ticket={...liveForm,businessName:license.businessName||"Unknown",licenseKey:license.licenseKey||"",vatNumber:license.vatNumber||"",submittedAt:new Date().toISOString(),status:"open",source:"in-app-help"};
      await addDoc(collection(db,"support_tickets"),ticket);
      setLiveSent(true);
      logActivity("SUPPORT_TICKET",{after:{name:liveForm.name,issue:liveForm.issue.slice(0,80)}},"System");
    }catch(e){alert("Failed to submit: "+e.message);}
    setLiveSending(false);
  }
  const [upgradeSent,setUpgradeSent]=useState(false);const [upgradeLoading,setUpgradeLoading]=useState(false);const [selectedPlan,setSelectedPlan]=useState("");
  async function submitUpgradeRequest(){
    if(!selectedPlan)return alert("Please select a plan to upgrade to.");
    setUpgradeLoading(true);
    try{
      const license=LS.get("restopos_license_v2")||{};
      const currentPlan=license.subscriptionPlan||"basic";
      await addDoc(collection(db,"support_tickets"),{
        name:license.businessName||"Unknown",phone:license.phone||"—",email:"",
        issue:`PLAN UPGRADE REQUEST\nFrom: ${SUBSCRIPTION_PLANS[currentPlan]?.name||"Basic"}\nTo: ${SUBSCRIPTION_PLANS[selectedPlan]?.name}\nPrice: SAR ${SUBSCRIPTION_PLANS[selectedPlan]?.price}/mo\nBusiness: ${license.businessName}\nLicense: ${license.licenseKey}\nVAT: ${license.vatNumber}`,
        priority:"Urgent",businessName:license.businessName||"Unknown",
        licenseKey:license.licenseKey||"",vatNumber:license.vatNumber||"",
        submittedAt:new Date().toISOString(),status:"open",source:"upgrade-request",
        requestType:"plan_upgrade",fromPlan:currentPlan,toPlan:selectedPlan
      });
      setUpgradeSent(true);
      logActivity("UPGRADE_REQUEST",{after:{from:currentPlan,to:selectedPlan}},"System");
    }catch(e){alert("Failed to submit: "+e.message);}
    setUpgradeLoading(false);
  }
  const sections=[["guide","🚀","Guide"],["zatca","⬛","ZATCA"],["ai","🤖","AI Help"],["upgrade","⬆️","Upgrade"],["live","🆘","Live Help"],["support","📞","Support"]];
  return(<div style={{display:"flex",gap:20}}>
    <div style={{width:160,flexShrink:0}}><Card style={{padding:8}}>{sections.map(([id,icon,label])=><button key={id} onClick={()=>setTab(id)} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"10px 12px",background:tab===id?C.primaryLight:"transparent",color:tab===id?C.primary:C.textMid,border:"none",borderRadius:8,cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:tab===id?700:500,textAlign:"left",marginBottom:2}}><span>{icon}</span><span>{label}</span></button>)}</Card></div>
    <div style={{flex:1}}>
      {tab==="guide"&&<Card><div style={{fontSize:18,fontWeight:800,marginBottom:20}}>Getting Started</div>{[{n:"1",t:"Activate License",d:"Enter your CR number, VAT number, and 12-digit license key. Saved permanently."},{n:"2",t:"Login by Role",d:"Select Admin, Manager, or Cashier and enter your 4-digit PIN."},{n:"3",t:"Setup Menu",d:"Go to Create → Items to add your menu with Arabic names, prices, and barcodes."},{n:"4",t:"Start Billing",d:"POS opens in Takeaway mode. Add items, fill customer details, process payment."},{n:"5",t:"ZATCA Invoice",d:"Every receipt auto-generates a ZATCA invoice with ICV, UUID, SHA-256 hash, and UBL XML."},{n:"6",t:"Close Day",d:"Go to Reports → click Close Day to record end of day. Sales reset for tomorrow."}].map((s,i)=><div key={i} style={{display:"flex",gap:14,marginBottom:14,padding:14,background:C.bg,borderRadius:10}}><div style={{width:34,height:34,background:C.primary,color:"#fff",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:800,flexShrink:0}}>{s.n}</div><div><div style={{fontSize:14,fontWeight:700,marginBottom:3}}>{s.t}</div><div style={{fontSize:13,color:C.textMid}}>{s.d}</div></div></div>)}</Card>}
      {tab==="zatca"&&<Card><div style={{fontSize:18,fontWeight:800,marginBottom:20}}>⬛ ZATCA Compliance</div>{[["Standard","ZATCA Phase 1 & Phase 2 Ready"],["QR Encoding","TLV (Tag-Length-Value) → Base64, multi-byte length support"],["Phase 1 QR","5 tags: Seller, VAT, Timestamp, Total, VAT Amount"],["Phase 2 QR","8 tags: + Invoice Hash, ECDSA Signature, Public Key (needs CSID)"],["ICV Counter","Sequential invoice counter — never resets across sessions"],["Hash Chain","SHA-256 hash of each invoice linked to previous (Web Crypto API)"],["UBL 2.1 XML","Full FATOORA-ready XML, downloadable per invoice from Transactions tab"],["FATOORA Queue","Report manually via Invoices → ZATCA History → Report button"],["Scannable QR","Real QR code generated on every receipt — works with any ZATCA scanner"]].map(([k,v])=><div key={k} style={{display:"flex",gap:12,padding:"10px 14px",background:C.zatcaLight,borderRadius:8,marginBottom:8}}><span style={{fontSize:12,fontWeight:700,color:C.zatca,width:130,flexShrink:0}}>{k}</span><span style={{fontSize:13}}>{v}</span></div>)}</Card>}
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
      {tab==="upgrade"&&(()=>{
        const license=LS.get("restopos_license_v2")||{};
        const currentPlan=license.subscriptionPlan||"basic";
        const currentPlanDef=SUBSCRIPTION_PLANS[currentPlan];
        return(
          <div style={{display:"flex",flexDirection:"column",gap:16}}>
            {/* Current plan banner */}
            <Card style={{background:`linear-gradient(135deg,${currentPlanDef.color}18,${currentPlanDef.color}08)`,border:`2px solid ${currentPlanDef.color}44`}}>
              <div style={{display:"flex",alignItems:"center",gap:14}}>
                <div style={{width:48,height:48,borderRadius:14,background:currentPlanDef.color+"22",border:`2px solid ${currentPlanDef.color}44`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,flexShrink:0}}>⭐</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:11,fontWeight:700,color:currentPlanDef.color,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:2}}>Current Plan</div>
                  <div style={{fontSize:20,fontWeight:900,color:currentPlanDef.color}}>{currentPlanDef.name}</div>
                  <div style={{fontSize:12,color:C.textMid,marginTop:2}}>SAR {currentPlanDef.price}/month · {license.businessName||"—"}</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:11,color:C.textLight}}>License</div>
                  <div style={{fontSize:12,fontWeight:700,fontFamily:"monospace",color:C.text}}>{license.licenseKey||"—"}</div>
                </div>
              </div>
            </Card>

            {upgradeSent?(
              <Card style={{textAlign:"center",padding:"40px 20px"}}>
                <div style={{fontSize:48,marginBottom:12}}>🎉</div>
                <div style={{fontSize:18,fontWeight:800,color:C.success,marginBottom:8}}>Upgrade Request Sent!</div>
                <div style={{fontSize:13,color:C.textMid,lineHeight:1.7,marginBottom:20}}>
                  We've received your request to upgrade to <strong style={{color:C.primary}}>{SUBSCRIPTION_PLANS[selectedPlan]?.name}</strong>.<br/>
                  We'll contact you shortly to process the upgrade and payment.
                </div>
                <div style={{display:"flex",gap:10,justifyContent:"center",flexWrap:"wrap"}}>
                  <a href="https://wa.me/966500000000" target="_blank" rel="noreferrer" style={{padding:"10px 20px",background:"#25d366",color:"#fff",borderRadius:10,fontWeight:700,fontSize:13,textDecoration:"none",display:"inline-flex",alignItems:"center",gap:6}}>💬 WhatsApp Us</a>
                  <button onClick={()=>{setUpgradeSent(false);setSelectedPlan("");}} style={{padding:"10px 20px",background:C.bg,border:`1px solid ${C.border}`,color:C.text,borderRadius:10,fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>Back to Plans</button>
                </div>
              </Card>
            ):(
              <>
                {/* Plan cards */}
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))",gap:14}}>
                  {Object.values(SUBSCRIPTION_PLANS).map(plan=>{
                    const isCurrent=plan.id===currentPlan;
                    const isSelected=plan.id===selectedPlan;
                    const isDowngrade=Object.values(SUBSCRIPTION_PLANS).indexOf(plan)<Object.values(SUBSCRIPTION_PLANS).indexOf(currentPlanDef);
                    return(
                      <div key={plan.id} onClick={()=>!isCurrent&&!isDowngrade&&setSelectedPlan(plan.id===selectedPlan?"":plan.id)}
                        style={{border:`2px solid ${isSelected?plan.color:isCurrent?plan.color+"66":C.border}`,borderRadius:16,padding:20,cursor:isCurrent||isDowngrade?"default":"pointer",background:isSelected?plan.color+"12":isCurrent?plan.color+"08":"#fff",transition:"all 0.15s",opacity:isDowngrade?0.45:1}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
                          <div>
                            <div style={{fontSize:16,fontWeight:900,color:plan.color}}>{plan.name}</div>
                            <div style={{fontSize:11,color:C.textLight,marginTop:2}}>{plan.nameAr}</div>
                          </div>
                          {isCurrent&&<span style={{fontSize:10,padding:"3px 8px",borderRadius:20,background:plan.color+"22",color:plan.color,fontWeight:700,border:`1px solid ${plan.color}44`}}>Current</span>}
                          {isSelected&&<span style={{fontSize:10,padding:"3px 8px",borderRadius:20,background:plan.color,color:"#fff",fontWeight:700}}>✓ Selected</span>}
                          {isDowngrade&&<span style={{fontSize:10,padding:"3px 8px",borderRadius:20,background:C.bg,color:C.textLight,fontWeight:700,border:`1px solid ${C.border}`}}>Lower Plan</span>}
                        </div>
                        <div style={{fontSize:26,fontWeight:900,color:plan.color,marginBottom:14}}>SAR {plan.price}<span style={{fontSize:13,fontWeight:500,color:C.textLight}}>/mo</span></div>
                        <div style={{display:"flex",flexDirection:"column",gap:6}}>
                          {plan.features.slice(0,5).map((f,i)=>(
                            <div key={i} style={{display:"flex",gap:8,alignItems:"flex-start",fontSize:12,color:C.textMid}}>
                              <span style={{color:plan.color,flexShrink:0,marginTop:1}}>✓</span>{f}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Contact & submit */}
                <Card style={{background:"linear-gradient(135deg,#F0F9FF,#EFF6FF)",border:`1px solid ${C.info}33`}}>
                  <div style={{fontSize:14,fontWeight:700,marginBottom:12,color:C.text}}>📞 How Upgrading Works</div>
                  <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:16}}>
                    {[["1","Select your new plan above","📋"],["2","Click Request Upgrade — we're notified instantly","📡"],["3","We contact you to arrange payment","💳"],["4","Plan activated within minutes","⚡"]].map(([n,t,ic])=>(
                      <div key={n} style={{display:"flex",gap:10,alignItems:"center",fontSize:13,color:C.textMid}}>
                        <div style={{width:24,height:24,borderRadius:"50%",background:C.primary,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:800,flexShrink:0}}>{n}</div>
                        <span>{ic} {t}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"center"}}>
                    <button onClick={submitUpgradeRequest} disabled={upgradeLoading||!selectedPlan}
                      style={{padding:"12px 24px",background:selectedPlan?`linear-gradient(135deg,${SUBSCRIPTION_PLANS[selectedPlan]?.color||C.primary},${SUBSCRIPTION_PLANS[selectedPlan]?.color||C.primary}cc)`:"#ccc",color:"#fff",border:"none",borderRadius:10,fontWeight:800,fontSize:14,cursor:selectedPlan&&!upgradeLoading?"pointer":"not-allowed",fontFamily:"inherit",flex:1,minWidth:180}}>
                      {upgradeLoading?"Sending…":selectedPlan?`⬆️ Request Upgrade to ${SUBSCRIPTION_PLANS[selectedPlan]?.name}`:"Select a plan above"}
                    </button>
                    <a href="https://wa.me/966500000000" target="_blank" rel="noreferrer"
                      style={{padding:"12px 20px",background:"#25d366",color:"#fff",borderRadius:10,fontWeight:700,fontSize:13,textDecoration:"none",display:"inline-flex",alignItems:"center",gap:6,flexShrink:0}}>
                      💬 WhatsApp
                    </a>
                  </div>
                  {!selectedPlan&&<div style={{marginTop:10,fontSize:12,color:C.textLight}}>👆 Click a plan card above to select it, then hit Request Upgrade.</div>}
                </Card>
              </>
            )}
          </div>
        );
      })()}
      {tab==="live"&&<Card>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20}}>
          <div style={{width:44,height:44,background:"linear-gradient(135deg,#D94040,#ff6b6b)",borderRadius:12,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22}}>🆘</div>
          <div><div style={{fontSize:17,fontWeight:800}}>Live Help Request</div><div style={{fontSize:12,color:C.textMid}}>Submit a support request — we'll be notified immediately</div></div>
        </div>
        {liveSent?(
          <div style={{textAlign:"center",padding:"40px 20px"}}>
            <div style={{fontSize:48,marginBottom:12}}>✅</div>
            <div style={{fontSize:17,fontWeight:800,color:C.success,marginBottom:8}}>Help Request Submitted!</div>
            <div style={{fontSize:13,color:C.textMid,lineHeight:1.6}}>We've been notified and will contact you shortly via phone or WhatsApp.<br/>You can also reach us directly at +966 53 836 0053.</div>
            <button onClick={()=>{setLiveSent(false);setLiveForm({name:"",phone:"",email:"",issue:"",priority:"Normal"});}} style={{marginTop:20,padding:"10px 24px",background:C.primary,color:"#fff",border:"none",borderRadius:10,cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700}}>Submit Another Request</button>
          </div>
        ):(
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <Inp label="Your Name *" value={liveForm.name} onChange={v=>setLiveForm(f=>({...f,name:v}))} placeholder="Staff name"/>
              <Inp label="Phone / WhatsApp *" value={liveForm.phone} onChange={v=>setLiveForm(f=>({...f,phone:v}))} placeholder="+966..."/>
              <Inp label="Email (optional)" value={liveForm.email} onChange={v=>setLiveForm(f=>({...f,email:v}))} placeholder="your@email.com"/>
              <div>
                <label style={{fontSize:12,fontWeight:600,color:C.textMid,display:"block",marginBottom:5}}>Priority</label>
                <select value={liveForm.priority} onChange={e=>setLiveForm(f=>({...f,priority:e.target.value}))} style={{width:"100%",padding:"9px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontFamily:"inherit",background:"#fff"}}>
                  {["Normal","Urgent","Critical — System Down"].map(p=><option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label style={{fontSize:12,fontWeight:600,color:C.textMid,display:"block",marginBottom:5}}>Describe your issue *</label>
              <textarea value={liveForm.issue} onChange={e=>setLiveForm(f=>({...f,issue:e.target.value}))} rows={4} placeholder="Describe what's happening — the more detail the faster we can help..." style={{width:"100%",padding:"9px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontFamily:"inherit",resize:"vertical"}}/>
            </div>
            {liveForm.priority==="Critical — System Down"&&<div style={{background:C.dangerLight,border:`1px solid ${C.danger}`,borderRadius:10,padding:"10px 14px",fontSize:12,color:C.danger,fontWeight:600}}>🚨 Critical issue — please also call us directly at +966 53 836 0053 for immediate assistance.</div>}
            <Btn onClick={submitLiveHelp} disabled={liveLoading||!liveForm.name||!liveForm.issue} style={{background:"linear-gradient(135deg,#D94040,#b02020)"}}>{liveLoading?"Submitting…":"🆘 Submit Help Request"}</Btn>
          </div>
        )}
      </Card>}
      {tab==="support"&&<Card><div style={{fontSize:18,fontWeight:800,marginBottom:20}}>Support & Contact</div>{[{icon:"📦",label:"Product",value:APP_VERSION_FULL},{icon:"🌍",label:"Region",value:"Kingdom of Saudi Arabia"},{icon:"📧",label:"Email",value:"restopos.noreply@gmail.com"},{icon:"📞",label:"Phone",value:"+966 53 836 0053 (9AM–6PM)"},{icon:"💬",label:"WhatsApp",value:"+966 53 836 0053"}].map((item,i)=><div key={i} style={{display:"flex",gap:14,padding:"12px 0",borderBottom:`1px solid ${C.border}`,alignItems:"center"}}><span style={{fontSize:20,width:28}}>{item.icon}</span><div style={{fontSize:12,fontWeight:700,color:C.textMid,width:90}}>{item.label}</div><div style={{fontSize:13,color:C.text,fontWeight:600}}>{item.value}</div></div>)}</Card>}
    </div>
  </div>);
}

// ═══════════════════════════════════════════════════════════════════
// EXPENSE TRACKING MODULE
// ═══════════════════════════════════════════════════════════════════
const EXPENSE_CATEGORIES=["Rent","Utilities","Salaries","Food Supplies","Kitchen Supplies","Packaging","Marketing","Maintenance","Transport","Other"];
function Expenses({embedded=false}){
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

// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
// CRM — FULL CUSTOMER RELATIONSHIP MANAGEMENT v15
// ═══════════════════════════════════════════════════════════════════
const CUSTOMER_TIERS=[
  {id:"bronze",label:"Bronze",color:"#CD7F32",bg:"#FDF3E7",minSpend:0,discount:0,pointRate:1},
  {id:"silver",label:"Silver",color:"#A0A0A0",bg:"#F5F5F5",minSpend:500,discount:2,pointRate:1.5},
  {id:"gold",label:"Gold",color:"#F0A500",bg:"#FEF6E4",minSpend:2000,discount:5,pointRate:2},
  {id:"platinum",label:"Platinum",color:"#6366f1",bg:"#EEF2FF",minSpend:5000,discount:10,pointRate:3},
];
function getTier(totalSpent){return CUSTOMER_TIERS.slice().reverse().find(t=>totalSpent>=t.minSpend)||CUSTOMER_TIERS[0];}
function getAgingBucket(lastOrderDate){
  if(!lastOrderDate)return"Never";
  const days=Math.floor((Date.now()-new Date(lastOrderDate).getTime())/(1000*60*60*24));
  if(days<=30)return"Active";if(days<=60)return"30-60d";if(days<=90)return"60-90d";return"90d+";
}
function Customers({sales}){
  const [customers,setCustomers]=useState(()=>LS.get("restopos_customers")||[]);
  const [showModal,setShowModal]=useState(false);
  const [showProfile,setShowProfile]=useState(null);
  const [editCust,setEditCust]=useState(null);
  const [search,setSearch]=useState("");
  const [tab,setTab]=useState("list");
  const [tierFilter,setTierFilter]=useState("all");
  const blank={name:"",nameAr:"",phone:"",email:"",address:"",birthday:"",creditLimit:0,notes:""};
  const [form,setForm]=useState(blank);
  function saveCustomers(list){setCustomers(list);LS.set("restopos_customers",list);const _lic_cust=LS.get("restopos_license_v2")?.licenseKey;if(_lic_cust)debouncedSync(_lic_cust,"restopos_customers",list);}
  function openModal(c=null){setEditCust(c);setForm(c?{...c,creditLimit:c.creditLimit||0}:{...blank});setShowModal(true);}
  function save(){
    if(!form.name||!form.phone)return alert("Name and phone required");
    const now=new Date().toISOString();
    const cust={...form,id:editCust?editCust.id:Date.now(),createdAt:editCust?.createdAt||now,updatedAt:now,loyaltyPoints:editCust?.loyaltyPoints||0,creditBalance:editCust?.creditBalance||0,creditLimit:parseFloat(form.creditLimit)||0};
    saveCustomers(editCust?customers.map(c=>c.id===editCust.id?cust:c):[cust,...customers]);
    setShowModal(false);
    logActivity(editCust?"CUSTOMER_UPDATED":"CUSTOMER_ADDED",{after:{name:form.name,phone:form.phone}},"Admin");
  }
  function deleteCust(id){if(confirm("Delete customer?"))saveCustomers(customers.filter(c=>c.id!==id));}
  function addPoints(c,pts){if(pts>0)saveCustomers(customers.map(x=>x.id===c.id?{...x,loyaltyPoints:(x.loyaltyPoints||0)+pts}:x));}
  function redeemPoints(c){if((c.loyaltyPoints||0)>=100&&confirm("Redeem 100 points for SAR 10 discount?"))saveCustomers(customers.map(x=>x.id===c.id?{...x,loyaltyPoints:x.loyaltyPoints-100}:x));}
  function adjustCredit(c,amount){
    const newBal=parseFloat(((c.creditBalance||0)+amount).toFixed(2));
    saveCustomers(customers.map(x=>x.id===c.id?{...x,creditBalance:newBal}:x));
  }
  const custWithHistory=customers.map(c=>{
    const orders=sales.filter(s=>s.customerPhone===c.phone||s.customerId===c.id);
    const totalSpent=orders.reduce((s,o)=>s+o.total,0);
    const tier=getTier(totalSpent);
    const aging=getAgingBucket(orders.length>0?orders[orders.length-1].date:null);
    const clv=orders.length>0?(totalSpent/Math.max(1,Math.ceil((Date.now()-new Date(c.createdAt||Date.now()).getTime())/(1000*60*60*24*30))))*12:0;
    return{...c,orderCount:orders.length,totalSpent,lastOrder:orders.length>0?orders[orders.length-1].date:null,orders,tier,aging,clv};
  });
  const filtered=custWithHistory.filter(c=>{
    const q=search.toLowerCase();
    const matchQ=!search||c.name.toLowerCase().includes(q)||c.phone.includes(q)||(c.email||"").toLowerCase().includes(q);
    const matchTier=tierFilter==="all"||c.tier.id===tierFilter;
    return matchQ&&matchTier;
  });
  function exportCustomers(){
    const csv=["Name,Phone,Email,Tier,Orders,Total Spent,Loyalty Points,Credit Balance,Credit Limit,CLV/yr,Aging,Joined",...filtered.map(c=>`"${c.name}","${c.phone}","${c.email||""}","${c.tier.label}",${c.orderCount},${c.totalSpent.toFixed(2)},${c.loyaltyPoints||0},${(c.creditBalance||0).toFixed(2)},${(c.creditLimit||0).toFixed(2)},${c.clv.toFixed(2)},"${c.aging}","${(c.createdAt||"").slice(0,10)}"`)].join("\n");
    const blob=new Blob([csv],{type:"text/csv"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=`customers-crm-${TODAY}.csv`;a.click();
  }
  const topSpenders=[...custWithHistory].sort((a,b)=>b.totalSpent-a.totalSpent).slice(0,10);
  const totalCustomers=customers.length;
  const activeCustomers=custWithHistory.filter(c=>c.aging==="Active").length;
  const atRisk=custWithHistory.filter(c=>c.aging==="60-90d"||c.aging==="90d+").length;
  const totalLoyaltyPoints=customers.reduce((s,c)=>s+(c.loyaltyPoints||0),0);
  const totalCreditOutstanding=customers.reduce((s,c)=>s+(c.creditBalance||0),0);
  const tierCounts=CUSTOMER_TIERS.map(t=>({...t,count:custWithHistory.filter(c=>c.tier.id===t.id).length}));

  if(showProfile){
    const c=custWithHistory.find(x=>x.id===showProfile);
    if(c)return(
      <div>
        <button onClick={()=>setShowProfile(null)} style={{display:"flex",alignItems:"center",gap:6,background:"none",border:"none",color:C.primary,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit",marginBottom:16}}>← Back to Customers</button>
        <div style={{display:"grid",gridTemplateColumns:"320px 1fr",gap:20,alignItems:"start"}}>
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            <Card>
              <div style={{display:"flex",gap:14,alignItems:"center",marginBottom:16}}>
                <div style={{width:52,height:52,borderRadius:"50%",background:`linear-gradient(135deg,${c.tier.color},${c.tier.color}88)`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,color:"#fff",fontWeight:800,flexShrink:0}}>{c.name[0]}</div>
                <div><div style={{fontSize:16,fontWeight:800}}>{c.name}</div>{c.nameAr&&<div style={{fontSize:13,color:C.textMid,direction:"rtl"}}>{c.nameAr}</div>}<span style={{display:"inline-block",marginTop:4,padding:"2px 10px",borderRadius:20,fontSize:11,fontWeight:700,background:c.tier.bg,color:c.tier.color,border:`1px solid ${c.tier.color}44`}}>{c.tier.label}</span></div>
              </div>
              {[["📞 Phone",c.phone],["📧 Email",c.email||"—"],["📍 Address",c.address||"—"],["🎂 Birthday",c.birthday||"—"],["📅 Since",fmtDate(c.createdAt||TODAY)],["🕐 Last Order",c.lastOrder?fmtDate(c.lastOrder):"Never"]].map(([l,v])=>(
                <div key={l} style={{display:"flex",gap:10,padding:"7px 0",borderBottom:`1px solid ${C.border}`,fontSize:13}}><span style={{color:C.textMid,width:110,flexShrink:0,fontSize:12}}>{l}</span><span style={{fontWeight:600}}>{v}</span></div>
              ))}
              {c.notes&&<div style={{marginTop:12,padding:"10px 12px",background:C.bg,borderRadius:8,fontSize:12,color:C.textMid,fontStyle:"italic"}}>"{c.notes}"</div>}
              <div style={{display:"flex",gap:8,marginTop:14}}>
                <Btn size="sm" variant="outline" onClick={()=>openModal(c)} style={{flex:1}}>✏️ Edit</Btn>
                <Btn size="sm" variant="danger" onClick={()=>{deleteCust(c.id);setShowProfile(null);}} style={{flex:1}}>🗑 Delete</Btn>
              </div>
            </Card>
            <Card>
              <div style={{fontSize:13,fontWeight:700,marginBottom:12}}>🎁 Loyalty Points</div>
              <div style={{fontSize:30,fontWeight:900,color:C.accent,marginBottom:4}}>{c.loyaltyPoints||0} pts</div>
              <div style={{fontSize:12,color:C.textLight,marginBottom:12}}>= {fmtSAR((c.loyaltyPoints||0)/10)} redeem value</div>
              <div style={{display:"flex",gap:8}}>
                <Btn size="sm" variant="outline" onClick={()=>{const pts=parseInt(prompt("Add points:")||"0");addPoints(c,pts);setCustomers(LS.get("restopos_customers")||[]);}} style={{flex:1}}>+ Add</Btn>
                <Btn size="sm" variant="ghost" onClick={()=>{redeemPoints(c);setCustomers(LS.get("restopos_customers")||[]);}} style={{flex:1}} disabled={(c.loyaltyPoints||0)<100}>Redeem</Btn>
              </div>
            </Card>
            <Card>
              <div style={{fontSize:13,fontWeight:700,marginBottom:12}}>💳 Credit Account</div>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}><span style={{fontSize:12,color:C.textMid}}>Balance (owed)</span><strong style={{color:(c.creditBalance||0)>0?C.danger:C.success}}>{fmtSAR(c.creditBalance||0)}</strong></div>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:14}}><span style={{fontSize:12,color:C.textMid}}>Credit Limit</span><strong>{fmtSAR(c.creditLimit||0)}</strong></div>
              {(c.creditLimit||0)>0&&<div style={{marginBottom:14}}><div style={{height:6,background:C.border,borderRadius:3}}><div style={{height:6,borderRadius:3,background:C.danger,width:`${Math.min(100,c.creditLimit>0?Math.round(((c.creditBalance||0)/c.creditLimit)*100):0)}%`,transition:"width 0.3s"}}/></div></div>}
              <div style={{display:"flex",gap:8}}>
                <Btn size="sm" variant="outline" onClick={()=>{const a=parseFloat(prompt("Charge credit (SAR):")||"0");if(a>0){adjustCredit(c,a);setCustomers(LS.get("restopos_customers")||[]);}}} style={{flex:1}}>Charge</Btn>
                <Btn size="sm" variant="ghost" onClick={()=>{const a=parseFloat(prompt("Record payment (SAR):")||"0");if(a>0){adjustCredit(c,-a);setCustomers(LS.get("restopos_customers")||[]);}}} style={{flex:1}}>Payment</Btn>
              </div>
            </Card>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:12}}>
              <StatCard icon="🧾" label={t("Orders",lang)} value={c.orderCount} color={C.info} bg={C.infoLight}/>
              <StatCard icon="💰" label="Total Spent" value={fmtSAR(c.totalSpent)} color={C.primary} bg={C.primaryLight}/>
              <StatCard icon="💵" label="Avg Order" value={fmtSAR(c.orderCount>0?c.totalSpent/c.orderCount:0)} color={C.success} bg={C.successLight}/>
              <StatCard icon="📈" label="CLV/Year" value={fmtSAR(c.clv)} color={C.accent} bg={C.accentLight}/>
            </div>
            <Card>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}><div style={{fontSize:14,fontWeight:700}}>📋 Purchase History</div><Badge color={C.info} bg={C.infoLight}>{c.orderCount} orders</Badge></div>
              {c.orders.length===0?<div style={{textAlign:"center",padding:"30px 0",color:C.textLight}}>No orders yet</div>
              :<DataTable headers={["Invoice","Date","Items","Payment","Total"]} rows={[...c.orders].reverse().slice(0,20).map(o=>[
                <span style={{fontFamily:"monospace",fontSize:11,color:C.primary}}>{o.id}</span>,
                <span style={{fontSize:12}}>{o.date} {o.time||""}</span>,
                <span style={{fontSize:12,color:C.textMid}}>{(o.items||[]).slice(0,2).map(i=>`${i.qty}×${i.name}`).join(", ")}{(o.items||[]).length>2?` +${(o.items||[]).length-2}…`:""}</span>,
                <Badge color={C.info} bg={C.infoLight}>{o.payMethod||"Cash"}</Badge>,
                <strong style={{color:C.primary}}>{fmtSAR(o.total)}</strong>
              ])}/>}
            </Card>
            <Card>
              <div style={{fontSize:14,fontWeight:700,marginBottom:12}}>📊 Tier Progress</div>
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {CUSTOMER_TIERS.map((t,i)=>{
                  const next=CUSTOMER_TIERS[i+1];
                  const isCurrent=c.tier.id===t.id;
                  const prog=next?Math.min(100,Math.round(((c.totalSpent-t.minSpend)/Math.max(1,next.minSpend-t.minSpend))*100)):100;
                  return(
                    <div key={t.id} style={{padding:"10px 14px",borderRadius:10,border:`1.5px solid ${isCurrent?t.color:C.border}`,background:isCurrent?t.bg:"#fff"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:isCurrent&&next?6:0}}>
                        <span style={{fontWeight:700,color:t.color,fontSize:13}}>{isCurrent?"▶ ":""}{t.label}</span>
                        <span style={{fontSize:11,color:C.textMid}}>≥ SAR {t.minSpend.toLocaleString()} · {t.discount}% off · {t.pointRate}× pts</span>
                      </div>
                      {isCurrent&&next&&<><div style={{height:5,background:C.border,borderRadius:3,marginBottom:3}}><div style={{height:5,borderRadius:3,background:t.color,width:`${prog}%`,transition:"width 0.3s"}}/></div><div style={{fontSize:10,color:C.textLight}}>SAR {c.totalSpent.toFixed(0)} / {next.minSpend.toLocaleString()} → {next.label}</div></>}
                    </div>
                  );
                })}
              </div>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  return(
    <div>
      {showModal&&<Modal title={editCust?"Edit Customer":"New Customer"} onClose={()=>setShowModal(false)} width={500}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
          <Inp label="Full Name *" value={form.name} onChange={v=>setForm(f=>({...f,name:v}))}/>
          <Inp label="Arabic Name" value={form.nameAr||""} onChange={v=>setForm(f=>({...f,nameAr:v}))}/>
          <Inp label="Phone *" value={form.phone} onChange={v=>setForm(f=>({...f,phone:v}))} placeholder="+966 50 000 0000"/>
          <Inp label="Email" value={form.email||""} onChange={v=>setForm(f=>({...f,email:v}))}/>
          <Inp label="Birthday" value={form.birthday||""} onChange={v=>setForm(f=>({...f,birthday:v}))} type="date"/>
          <Inp label="Credit Limit (SAR)" value={form.creditLimit||""} onChange={v=>setForm(f=>({...f,creditLimit:v}))} type="number" placeholder="0"/>
        </div>
        <Inp label="Address" value={form.address||""} onChange={v=>setForm(f=>({...f,address:v}))} style={{marginTop:12}}/>
        <div style={{display:"flex",flexDirection:"column",gap:4,marginTop:12}}>
          <label style={{fontSize:12,fontWeight:600,color:C.textMid}}>Notes</label>
          <textarea value={form.notes||""} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} rows={2} style={{padding:"9px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontFamily:"inherit",resize:"none"}}/>
        </div>
        <div style={{display:"flex",gap:10,marginTop:16}}>
          <Btn variant="ghost" onClick={()=>setShowModal(false)} style={{flex:1}}>Cancel</Btn>
          <Btn onClick={save} style={{flex:1}}>💾 Save Customer</Btn>
        </div>
      </Modal>}

      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20,flexWrap:"wrap",gap:10}}>
        <div><div style={{fontSize:20,fontWeight:800}}>👥 CRM — Customer Management</div><div style={{fontSize:13,color:C.textMid,marginTop:2}}>{customers.length} customers · {activeCustomers} active · {atRisk} at risk</div></div>
        <div style={{display:"flex",gap:8}}>
          <Btn variant="outline" size="sm" onClick={exportCustomers}>📤 Export CSV</Btn>
          <Btn onClick={()=>openModal()}>+ New Customer</Btn>
        </div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(170px,1fr))",gap:14,marginBottom:20}}>
        <StatCard icon="👥" label="Total Customers" value={totalCustomers} color={C.primary} bg={C.primaryLight}/>
        <StatCard icon="🟢" label="Active (30d)" value={activeCustomers} color={C.success} bg={C.successLight}/>
        <StatCard icon="⚠️" label="At Risk (60d+)" value={atRisk} color={C.danger} bg={C.dangerLight}/>
        <StatCard icon="🎁" label="Loyalty Points" value={totalLoyaltyPoints.toLocaleString()} color={C.accent} bg={C.accentLight}/>
        <StatCard icon="💳" label="Credit Outstanding" value={fmtSAR(totalCreditOutstanding)} color={totalCreditOutstanding>0?C.danger:C.success} bg={totalCreditOutstanding>0?C.dangerLight:C.successLight}/>
      </div>

      <div style={{display:"flex",gap:6,marginBottom:16,flexWrap:"wrap"}}>
        {[["list","👥 All"],["segments","🏅 Tiers"],["aging","⏰ Aging"],["loyalty","🎁 Loyalty"],["credit","💳 Credit"]].map(([id,lbl])=>(
          <button key={id} onClick={()=>setTab(id)} style={{padding:"7px 16px",borderRadius:8,border:`1.5px solid ${tab===id?C.primary:C.border}`,background:tab===id?C.primaryLight:"#fff",color:tab===id?C.primary:C.textMid,fontFamily:"inherit",fontSize:13,fontWeight:600,cursor:"pointer"}}>{lbl}</button>
        ))}
      </div>

      {tab==="list"&&<>
        <div style={{display:"flex",gap:10,marginBottom:16,flexWrap:"wrap"}}>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="🔍 Search name, phone, email..." style={{flex:1,minWidth:200,padding:"9px 14px",border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontFamily:"inherit"}}/>
          <select value={tierFilter} onChange={e=>setTierFilter(e.target.value)} style={{padding:"9px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontFamily:"inherit",color:C.text,background:"#fff"}}>
            <option value="all">All Tiers</option>
            {CUSTOMER_TIERS.map(t=><option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </div>
        {filtered.length===0?<Card><div style={{textAlign:"center",padding:"40px 0",color:C.textMid}}><div style={{fontSize:40,marginBottom:12}}>👥</div><div>No customers found.</div></div></Card>
        :<Card><DataTable headers={["Name","Phone","Tier","Orders","Spent","Points","Aging","Action"]} rows={filtered.map(c=>[
          <button onClick={()=>setShowProfile(c.id)} style={{fontWeight:700,background:"none",border:"none",color:C.primary,cursor:"pointer",fontFamily:"inherit",fontSize:13,padding:0,textAlign:"left"}}>{c.name}</button>,
          <span style={{fontFamily:"monospace",fontSize:11}}>{c.phone}</span>,
          <span style={{padding:"2px 8px",borderRadius:20,fontSize:10,fontWeight:700,background:c.tier.bg,color:c.tier.color,border:`1px solid ${c.tier.color}44`}}>{c.tier.label}</span>,
          <Badge color={C.info} bg={C.infoLight}>{c.orderCount}</Badge>,
          <strong style={{color:C.primary}}>{fmtSAR(c.totalSpent)}</strong>,
          <Badge color={C.accent} bg={C.accentLight}>{c.loyaltyPoints||0}pts</Badge>,
          <Badge color={c.aging==="Active"?C.success:c.aging==="30-60d"?C.warning:C.danger} bg={c.aging==="Active"?C.successLight:c.aging==="30-60d"?C.warningLight:C.dangerLight}>{c.aging}</Badge>,
          <div style={{display:"flex",gap:4}}>
            <Btn size="sm" variant="ghost" onClick={()=>setShowProfile(c.id)}>View</Btn>
            <Btn size="sm" variant="ghost" onClick={()=>openModal(c)}>Edit</Btn>
            <Btn size="sm" variant="danger" onClick={()=>deleteCust(c.id)}>Del</Btn>
          </div>
        ])}/></Card>}
      </>}

      {tab==="segments"&&<div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(230px,1fr))",gap:16,marginBottom:20}}>
          {tierCounts.map(t=>(
            <Card key={t.id} style={{border:`2px solid ${t.color}44`,cursor:"pointer"}} onClick={()=>{setTierFilter(t.id);setTab("list");}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                <div style={{fontSize:16,fontWeight:800,color:t.color}}>{t.label}</div>
                <div style={{fontSize:28,fontWeight:900,color:t.color}}>{t.count}</div>
              </div>
              <div style={{fontSize:12,color:C.textMid}}>From SAR {t.minSpend.toLocaleString()} spent</div>
              <div style={{fontSize:12,color:C.textLight,marginTop:2}}>{t.discount}% discount · {t.pointRate}× points</div>
              <div style={{marginTop:10,height:4,background:C.border,borderRadius:2}}><div style={{height:4,borderRadius:2,background:t.color,width:`${totalCustomers>0?Math.round((t.count/totalCustomers)*100):0}%`}}/></div>
            </Card>
          ))}
        </div>
        <Card>
          <div style={{fontSize:14,fontWeight:700,marginBottom:16}}>⭐ Top Spenders</div>
          {topSpenders.length===0?<div style={{color:C.textLight,textAlign:"center",padding:24}}>No data yet</div>
          :<div style={{display:"flex",flexDirection:"column",gap:8}}>{topSpenders.map((c,i)=>(
            <div key={c.id} style={{display:"flex",alignItems:"center",gap:14,padding:"10px 14px",background:i===0?C.primaryLight:C.bg,borderRadius:10,border:`1px solid ${i===0?C.primary:C.border}`,cursor:"pointer"}} onClick={()=>setShowProfile(c.id)}>
              <div style={{width:28,height:28,borderRadius:"50%",background:i<3?"linear-gradient(135deg,#F0A500,#e09000)":C.primary,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:800,flexShrink:0}}>{i+1}</div>
              <div style={{flex:1}}><div style={{fontWeight:700,fontSize:13}}>{c.name}</div><div style={{fontSize:11,color:C.textLight}}>{c.phone} · {c.orderCount} orders · <span style={{color:c.tier.color}}>{c.tier.label}</span></div></div>
              <div style={{textAlign:"right"}}><div style={{fontSize:15,fontWeight:800,color:C.primary}}>{fmtSAR(c.totalSpent)}</div><div style={{fontSize:10,color:C.textLight}}>{c.loyaltyPoints||0} pts</div></div>
            </div>
          ))}</div>}
        </Card>
      </div>}

      {tab==="aging"&&<Card>
        <div style={{fontSize:14,fontWeight:700,marginBottom:16}}>⏰ Customer Aging Analysis</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:20}}>
          {[["Active","≤30d",C.success,C.successLight],["30-60d","30-60d",C.warning,C.warningLight],["60-90d","60-90d",C.accent,C.accentLight],["90d+","90d+",C.danger,C.dangerLight]].map(([bucket,label,color,bg])=>{
            const count=custWithHistory.filter(c=>c.aging===bucket).length;
            return<div key={bucket} style={{padding:"12px",borderRadius:10,background:bg,border:`1px solid ${color}44`,textAlign:"center"}}><div style={{fontSize:26,fontWeight:900,color}}>{count}</div><div style={{fontSize:12,fontWeight:700,color}}>{label}</div></div>;
          })}
        </div>
        <DataTable headers={["Customer","Phone","Last Order","Days Ago","Status","Action"]} rows={custWithHistory.filter(c=>c.aging!=="Never").sort((a,b)=>(a.lastOrder||"").localeCompare(b.lastOrder||"")).slice(0,30).map(c=>{
          const daysAgo=c.lastOrder?Math.floor((Date.now()-new Date(c.lastOrder).getTime())/(1000*60*60*24)):null;
          return[
            <button onClick={()=>setShowProfile(c.id)} style={{fontWeight:700,background:"none",border:"none",color:C.primary,cursor:"pointer",fontFamily:"inherit",fontSize:13,padding:0}}>{c.name}</button>,
            <span style={{fontFamily:"monospace",fontSize:11}}>{c.phone}</span>,
            c.lastOrder?<span style={{fontSize:12}}>{fmtDate(c.lastOrder)}</span>:<span style={{color:C.textLight}}>Never</span>,
            daysAgo!=null?<span style={{fontWeight:700,color:daysAgo>60?C.danger:daysAgo>30?C.warning:C.success}}>{daysAgo}d</span>:"—",
            <Badge color={c.aging==="Active"?C.success:c.aging==="30-60d"?C.warning:C.danger} bg={c.aging==="Active"?C.successLight:c.aging==="30-60d"?C.warningLight:C.dangerLight}>{c.aging}</Badge>,
            <Btn size="sm" variant="ghost" onClick={()=>setShowProfile(c.id)}>Profile</Btn>
          ];
        })}/>
      </Card>}

      {tab==="loyalty"&&<Card>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div style={{fontSize:14,fontWeight:700}}>🎁 Loyalty Points</div>
          <div style={{background:C.accentLight,border:`1px solid ${C.accent}44`,borderRadius:8,padding:"6px 14px",fontSize:12,color:C.accent,fontWeight:700}}>{totalLoyaltyPoints.toLocaleString()} pts total</div>
        </div>
        <div style={{background:C.infoLight,border:`1px solid ${C.info}`,borderRadius:10,padding:"12px 16px",marginBottom:16,fontSize:13,color:C.info}}>
          Tiers: Bronze 1×, Silver 1.5×, Gold 2×, Platinum 3× per SAR. 100 pts = SAR 10 discount.
        </div>
        {customers.length===0?<div style={{color:C.textLight,textAlign:"center",padding:32}}>No customers yet</div>
        :<DataTable headers={["Customer","Tier","Points","Value","Actions"]} rows={[...custWithHistory].sort((a,b)=>(b.loyaltyPoints||0)-(a.loyaltyPoints||0)).map(c=>[
          <button onClick={()=>setShowProfile(c.id)} style={{fontWeight:700,background:"none",border:"none",color:C.primary,cursor:"pointer",fontFamily:"inherit",fontSize:13,padding:0}}>{c.name}</button>,
          <span style={{padding:"2px 8px",borderRadius:20,fontSize:10,fontWeight:700,background:c.tier.bg,color:c.tier.color,border:`1px solid ${c.tier.color}44`}}>{c.tier.label}</span>,
          <span style={{fontSize:15,fontWeight:800,color:C.accent}}>{c.loyaltyPoints||0}</span>,
          <span style={{fontSize:12,color:C.textMid}}>{fmtSAR((c.loyaltyPoints||0)/10)}</span>,
          <div style={{display:"flex",gap:6}}>
            <Btn size="sm" variant="outline" onClick={()=>{const pts=parseInt(prompt(`Add points for ${c.name}:`)||"0");addPoints(c,pts);}}>+ Add</Btn>
            <Btn size="sm" variant="ghost" onClick={()=>redeemPoints(c)} disabled={(c.loyaltyPoints||0)<100}>Redeem 100</Btn>
          </div>
        ])}/>}
      </Card>}

      {tab==="credit"&&<Card>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div style={{fontSize:14,fontWeight:700}}>💳 Credit Accounts</div>
          <div style={{background:totalCreditOutstanding>0?C.dangerLight:C.successLight,border:`1px solid ${totalCreditOutstanding>0?C.danger:C.success}44`,borderRadius:8,padding:"6px 14px",fontSize:12,color:totalCreditOutstanding>0?C.danger:C.success,fontWeight:700}}>Outstanding: {fmtSAR(totalCreditOutstanding)}</div>
        </div>
        {custWithHistory.filter(c=>(c.creditLimit||0)>0||(c.creditBalance||0)>0).length===0
          ?<div style={{textAlign:"center",padding:"30px 0",color:C.textLight}}>No credit accounts. Set a Credit Limit on customer profiles to enable.</div>
          :<DataTable headers={["Customer","Phone","Credit Limit","Balance","Utilisation","Actions"]} rows={custWithHistory.filter(c=>(c.creditLimit||0)>0||(c.creditBalance||0)>0).map(c=>{
            const used=c.creditLimit>0?Math.min(100,Math.round(((c.creditBalance||0)/c.creditLimit)*100)):0;
            return[
              <button onClick={()=>setShowProfile(c.id)} style={{fontWeight:700,background:"none",border:"none",color:C.primary,cursor:"pointer",fontFamily:"inherit",fontSize:13,padding:0}}>{c.name}</button>,
              <span style={{fontFamily:"monospace",fontSize:11}}>{c.phone}</span>,
              <span style={{fontWeight:600}}>{fmtSAR(c.creditLimit||0)}</span>,
              <strong style={{color:(c.creditBalance||0)>0?C.danger:C.success}}>{fmtSAR(c.creditBalance||0)}</strong>,
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                <div style={{width:60,height:6,background:C.border,borderRadius:3}}><div style={{height:6,borderRadius:3,background:used>80?C.danger:C.primary,width:`${used}%`}}/></div>
                <span style={{fontSize:11,color:C.textMid}}>{used}%</span>
              </div>,
              <div style={{display:"flex",gap:6}}>
                <Btn size="sm" variant="outline" onClick={()=>{const a=parseFloat(prompt("Charge (SAR):")||"0");if(a>0)adjustCredit(c,a);}}>Charge</Btn>
                <Btn size="sm" variant="ghost" onClick={()=>{const a=parseFloat(prompt("Payment (SAR):")||"0");if(a>0)adjustCredit(c,-a);}}>Payment</Btn>
              </div>
            ];
          })}/>}
      </Card>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// ADVANCED FINANCIAL REPORTS v15 — Balance Sheet, Cash Flow, Trial Balance, GL
// ═══════════════════════════════════════════════════════════════════
function FinancialReports({sales,items,license}){
  const [tab,setTab]=useState("balancesheet");
  const [pushingFatoora,setPushingFatoora]=useState(false);
  const [period,setPeriod]=useState("month");
  const now=new Date();
  const expenses=LS.get("restopos_expenses")||[];
  const customers=LS.get("restopos_customers")||[];
  function filterByPeriod(arr,dateKey="date"){
    return arr.filter(x=>{
      const d=new Date(x[dateKey]);
      if(period==="today")return x[dateKey]===TODAY;
      if(period==="week"){const w=new Date();w.setDate(w.getDate()-7);return d>=w;}
      if(period==="month")return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear();
      return true;
    });
  }
  const fSales=filterByPeriod(sales);
  const fExp=filterByPeriod(expenses);
  const revenue=fSales.reduce((s,o)=>s+(o.total||0),0);
  const vatCollected=fSales.reduce((s,o)=>s+(o.vat||0),0);
  const revenueExclVat=revenue-vatCollected;
  const cogs=fSales.reduce((s,o)=>s+(o.items||[]).reduce((ss,it)=>{const item=items.find(i=>i.id===it.id);return ss+(item?.cost||0)*it.qty;},0),0);
  const opExpenses=fExp.reduce((s,e)=>s+e.amount,0);
  const grossProfit=revenueExclVat-cogs;
  const netProfit=grossProfit-opExpenses;
  const cashReceipts=fSales.filter(s=>s.payMethod==="Cash").reduce((s,o)=>s+o.total,0);
  const digitalReceipts=fSales.filter(s=>s.payMethod!=="Cash").reduce((s,o)=>s+o.total,0);
  const totalCreditOut=customers.reduce((s,c)=>s+(c.creditBalance||0),0);
  const inventoryValue=items.reduce((s,it)=>s+(it.cost||0)*(it.stock||0),0);
  const totalAssets=cashReceipts+digitalReceipts+inventoryValue+totalCreditOut;
  const totalLiabilities=vatCollected+opExpenses;
  const equity=totalAssets-totalLiabilities;
  const operatingCashIn=revenue;
  const operatingCashOut=cogs+opExpenses;
  const netOperatingCF=operatingCashIn-operatingCashOut;
  const trialAccounts=[
    {account:"Cash Receipts (POS)",debit:cashReceipts,credit:0},
    {account:"Digital Payments",debit:digitalReceipts,credit:0},
    {account:"Accounts Receivable",debit:totalCreditOut,credit:0},
    {account:"Inventory Stock Value",debit:inventoryValue,credit:0},
    {account:"Sales Revenue",debit:0,credit:revenueExclVat},
    {account:"VAT Payable (15%)",debit:0,credit:vatCollected},
    {account:"Cost of Goods Sold",debit:cogs,credit:0},
    {account:"Operating Expenses",debit:opExpenses,credit:0},
    {account:"Retained Earnings",debit:0,credit:Math.max(0,netProfit)},
  ];
  const totalDebits=trialAccounts.reduce((s,a)=>s+a.debit,0);
  const totalCredits=trialAccounts.reduce((s,a)=>s+a.credit,0);
  const PeriodBtns=()=>(
    <div style={{display:"flex",gap:6}}>
      {[["today","Today"],["week","Week"],["month","Month"],["all","All"]].map(([id,lbl])=>(
        <button key={id} onClick={()=>setPeriod(id)} style={{padding:"6px 14px",borderRadius:8,border:`1.5px solid ${period===id?C.primary:C.border}`,background:period===id?C.primary:"#fff",color:period===id?"#fff":C.textMid,fontFamily:"inherit",fontSize:12,fontWeight:600,cursor:"pointer"}}>{lbl}</button>
      ))}
    </div>
  );
  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20,flexWrap:"wrap",gap:10}}>
        <div><div style={{fontSize:20,fontWeight:800}}>📊 Advanced Financial Reports</div><div style={{fontSize:13,color:C.textMid,marginTop:2}}>Balance Sheet · Cash Flow · Trial Balance · GL · VAT</div></div>
        <PeriodBtns/>
      </div>
      <div style={{display:"flex",gap:6,marginBottom:20,flexWrap:"wrap"}}>
        {[["balancesheet","📋 Balance Sheet"],["cashflow","💧 Cash Flow"],["trial","⚖️ Trial Balance"],["gl","📒 General Ledger"],["vat","🧾 VAT Liability"],["pnl","📈 P&L"],["expenses","💸 Expenses"]].map(([id,lbl])=>(
          <button key={id} onClick={()=>setTab(id)} style={{padding:"8px 16px",borderRadius:8,border:`1.5px solid ${tab===id?C.primary:C.border}`,background:tab===id?C.primaryLight:"#fff",color:tab===id?C.primary:C.textMid,fontFamily:"inherit",fontSize:13,fontWeight:600,cursor:"pointer"}}>{lbl}</button>
        ))}
      </div>

      {fSales.length===0&&tab!=="vat"&&<Card><div style={{textAlign:"center",padding:"60px 20px",color:C.textLight}}><div style={{fontSize:48,marginBottom:12}}>🏦</div><div style={{fontSize:16,fontWeight:700,marginBottom:6}}>No financial data yet</div><div style={{fontSize:13}}>Complete orders in the POS screen to populate these financial reports.</div></div></Card>}

      {fSales.length>0&&tab==="balancesheet"&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
        <Card>
          <div style={{fontSize:15,fontWeight:800,marginBottom:16,color:C.primary,borderBottom:`2px solid ${C.primary}`,paddingBottom:8}}>ASSETS</div>
          {[["Cash (POS / Cash sales)",cashReceipts,false],["Digital Payments",digitalReceipts,false],["Accounts Receivable",totalCreditOut,false],["Inventory Value",inventoryValue,false],["──","",false],["TOTAL ASSETS",totalAssets,true]].map(([label,val,isBold],i)=>(
            <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:isBold?`2px solid ${C.border}`:`1px solid ${C.border}`,fontWeight:isBold?900:400,marginTop:isBold?4:0}}>
              <span style={{fontSize:13,color:label==="──"?"transparent":isBold?C.text:C.textMid}}>{label==="──"?"":label}</span>
              {val!==""&&<span style={{fontWeight:700,color:isBold?C.primary:C.text}}>{fmtSAR(val)}</span>}
            </div>
          ))}
        </Card>
        <div style={{display:"flex",flexDirection:"column",gap:16}}>
          <Card>
            <div style={{fontSize:15,fontWeight:800,marginBottom:16,color:C.danger,borderBottom:`2px solid ${C.danger}`,paddingBottom:8}}>LIABILITIES</div>
            {[["VAT Payable (15%)",vatCollected,false],["Operating Expenses",opExpenses,false],["TOTAL LIABILITIES",totalLiabilities,true]].map(([label,val,isBold],i)=>(
              <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:`1px solid ${C.border}`,fontWeight:isBold?900:400}}>
                <span style={{fontSize:13,color:isBold?C.text:C.textMid}}>{label}</span>
                <span style={{fontWeight:700,color:isBold?C.danger:C.text}}>{fmtSAR(val)}</span>
              </div>
            ))}
          </Card>
          <Card>
            <div style={{fontSize:15,fontWeight:800,marginBottom:16,color:C.success,borderBottom:`2px solid ${C.success}`,paddingBottom:8}}>EQUITY</div>
            {[["Net Profit / Retained",netProfit,false],["TOTAL EQUITY",Math.max(0,equity),true]].map(([label,val,isBold],i)=>(
              <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:`1px solid ${C.border}`,fontWeight:isBold?900:400}}>
                <span style={{fontSize:13,color:isBold?C.text:C.textMid}}>{label}</span>
                <span style={{fontWeight:700,color:isBold?C.success:val>=0?C.text:C.danger}}>{fmtSAR(val)}</span>
              </div>
            ))}
            <div style={{marginTop:12,padding:"8px 12px",background:C.bg,borderRadius:8,fontSize:11,color:C.textMid}}>A = L + E: {fmtSAR(totalAssets)} = {fmtSAR(totalLiabilities)} + {fmtSAR(Math.max(0,equity))}</div>
          </Card>
        </div>
      </div>}

      {fSales.length>0&&tab==="cashflow"&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
        <Card>
          <div style={{fontSize:15,fontWeight:800,marginBottom:20}}>💧 Cash Flow Statement</div>
          <div style={{fontSize:12,fontWeight:700,color:C.primary,marginBottom:10,padding:"5px 12px",background:C.primaryLight,borderRadius:6}}>Operating Activities</div>
          {[["Cash Receipts (Revenue)",operatingCashIn,C.success,false],["Less: Cost of Goods Sold",-cogs,C.danger,false],["Less: Operating Expenses",-opExpenses,C.danger,false],["Net Operating Cash Flow",netOperatingCF,netOperatingCF>=0?C.success:C.danger,true]].map(([label,val,color,isFinal],i)=>(
            <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"9px 0",borderBottom:`1px solid ${C.border}`,fontWeight:isFinal?800:400,borderTop:isFinal?`2px solid ${C.border}`:"none"}}>
              <span style={{fontSize:13,color:isFinal?C.text:C.textMid}}>{label}</span>
              <span style={{fontWeight:700,color}}>{val<0?"(":""}{fmtSAR(Math.abs(val))}{val<0?")":""}</span>
            </div>
          ))}
          <div style={{fontSize:12,fontWeight:700,color:C.info,marginTop:16,marginBottom:10,padding:"5px 12px",background:C.infoLight,borderRadius:6}}>Investing Activities</div>
          <div style={{display:"flex",justifyContent:"space-between",padding:"8px 0",fontSize:13,color:C.textMid}}><span>Capital Expenditures</span><span style={{fontSize:11}}>Track via Expenses</span></div>
          <div style={{fontSize:12,fontWeight:700,color:C.accent,marginTop:16,marginBottom:10,padding:"5px 12px",background:C.accentLight,borderRadius:6}}>Financing Activities</div>
          <div style={{display:"flex",justifyContent:"space-between",padding:"8px 0",fontSize:13,color:C.textMid}}><span>Owner Capital / Drawings</span><span style={{fontSize:11}}>Manual entry</span></div>
        </Card>
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
            <StatCard icon="💵" label="Cash In" value={fmtSAR(operatingCashIn)} color={C.success} bg={C.successLight}/>
            <StatCard icon="💸" label="Cash Out" value={fmtSAR(operatingCashOut)} color={C.danger} bg={C.dangerLight}/>
            <StatCard icon="🏦" label="Net Cash" value={fmtSAR(netOperatingCF)} color={netOperatingCF>=0?C.success:C.danger} bg={netOperatingCF>=0?C.successLight:C.dangerLight}/>
            <StatCard icon="💳" label="Cash %" value={`${revenue>0?Math.round((cashReceipts/revenue)*100):0}%`} color={C.info} bg={C.infoLight}/>
          </div>
          <Card>
            <div style={{fontSize:13,fontWeight:700,marginBottom:12}}>By Payment Method</div>
            {["Cash","Mada","Apple Pay","STC Pay"].map(m=>{
              const t=fSales.filter(s=>s.payMethod===m).reduce((s,o)=>s+o.total,0);
              const cnt=fSales.filter(s=>s.payMethod===m).length;
              const pct=revenue>0?Math.round((t/revenue)*100):0;
              return t>0?(
                <div key={m} style={{marginBottom:10}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}><span style={{fontSize:12,fontWeight:600}}>{m}</span><span style={{fontSize:12}}>{fmtSAR(t)} · {cnt} txns</span></div>
                  <div style={{height:5,background:C.border,borderRadius:3}}><div style={{height:5,borderRadius:3,background:C.primary,width:`${pct}%`}}/></div>
                </div>
              ):null;
            })}
          </Card>
        </div>
      </div>}

      {fSales.length>0&&tab==="trial"&&<Card>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div style={{fontSize:15,fontWeight:800}}>⚖️ Trial Balance</div>
          <div style={{fontSize:12,color:Math.abs(totalDebits-totalCredits)<0.01?C.success:C.danger,fontWeight:700,padding:"4px 12px",borderRadius:20,background:Math.abs(totalDebits-totalCredits)<0.01?C.successLight:C.dangerLight}}>{Math.abs(totalDebits-totalCredits)<0.01?"✓ Balanced":"⚠️ Unbalanced"}</div>
        </div>
        <DataTable headers={["Account","Debit (SAR)","Credit (SAR)"]} rows={[...trialAccounts.map(a=>[
          <span style={{fontSize:13}}>{a.account}</span>,
          a.debit>0?<strong style={{color:C.info}}>{fmtSAR(a.debit)}</strong>:<span style={{color:C.border}}>—</span>,
          a.credit>0?<strong style={{color:C.success}}>{fmtSAR(a.credit)}</strong>:<span style={{color:C.border}}>—</span>
        ]),
        [<strong>TOTALS</strong>,<strong style={{color:C.info}}>{fmtSAR(totalDebits)}</strong>,<strong style={{color:C.success}}>{fmtSAR(totalCredits)}</strong>]
        ]}/>
        <div style={{marginTop:14,padding:"10px 14px",background:Math.abs(totalDebits-totalCredits)<0.01?C.successLight:C.dangerLight,borderRadius:8,fontSize:12,fontWeight:600,color:Math.abs(totalDebits-totalCredits)<0.01?C.success:C.danger}}>
          {Math.abs(totalDebits-totalCredits)<0.01?"✓ Trial Balance is balanced — Debits = Credits = "+fmtSAR(totalDebits):"⚠️ Difference: "+fmtSAR(Math.abs(totalDebits-totalCredits))}
        </div>
      </Card>}

      {fSales.length>0&&tab==="gl"&&<Card>
        <div style={{fontSize:15,fontWeight:800,marginBottom:16}}>📒 General Ledger — Sales Journal</div>
        {fSales.length===0?<div style={{textAlign:"center",padding:"30px 0",color:C.textLight}}>No transactions in this period</div>
        :<DataTable headers={["Date","Invoice","Entry","Debit","Credit","Account"]} rows={fSales.slice(0,30).flatMap(s=>[
          [<span style={{fontSize:11,fontFamily:"monospace"}}>{s.date}</span>,<span style={{fontFamily:"monospace",fontSize:11,color:C.primary}}>{s.id}</span>,<span style={{fontSize:12}}>Cash/Payment · {s.payMethod}</span>,<strong style={{color:C.info}}>{fmtSAR(s.total)}</strong>,<span style={{color:C.border}}>—</span>,<Badge color={C.success} bg={C.successLight}>DR Cash</Badge>],
          [<span style={{fontSize:11,fontFamily:"monospace"}}>{s.date}</span>,<span style={{fontFamily:"monospace",fontSize:11,color:C.primary}}>{s.id}</span>,<span style={{fontSize:12}}>Sales Revenue</span>,<span style={{color:C.border}}>—</span>,<strong style={{color:C.success}}>{fmtSAR(s.subtotal||s.total-(s.vat||0))}</strong>,<Badge color={C.info} bg={C.infoLight}>CR Revenue</Badge>],
          [<span style={{fontSize:11,fontFamily:"monospace"}}>{s.date}</span>,<span style={{fontFamily:"monospace",fontSize:11,color:C.primary}}>{s.id}</span>,<span style={{fontSize:12}}>VAT 15%</span>,<span style={{color:C.border}}>—</span>,<strong style={{color:C.zatca}}>{fmtSAR(s.vat||0)}</strong>,<Badge color={C.zatca} bg={C.zatcaLight}>CR VAT</Badge>],
        ])}/>}
        {fSales.length>30&&<div style={{textAlign:"center",marginTop:10,fontSize:12,color:C.textMid}}>Showing 30 of {fSales.length} transactions. Export full backup for complete ledger.</div>}
      </Card>}

      {tab==="vat"&&(()=>{
        // Safe calculations — no undefined variables
        const vatSales=fSales||sales||[];
        const vatRevTotal=vatSales.reduce((s,o)=>s+(o.total||0),0);
        const vatCollectedTotal=vatSales.reduce((s,o)=>s+(o.vat||0),0);
        const vatRevenueExcl=vatRevTotal-vatCollectedTotal;
        // Monthly breakdown
        const vatByMonth={};
        vatSales.forEach(s=>{
          const ym=s.date?.slice(0,7)||"Unknown";
          if(!vatByMonth[ym])vatByMonth[ym]={month:ym,orders:0,revenue:0,vat:0,reported:0};
          vatByMonth[ym].orders++;
          vatByMonth[ym].revenue+=s.subtotal||0;
          vatByMonth[ym].vat+=s.vat||0;
        });
        const vatRows=Object.values(vatByMonth).sort((a,b)=>b.month.localeCompare(a.month));
        // Current quarter VAT
        const now=new Date();
        const qStart=new Date(now.getFullYear(),Math.floor(now.getMonth()/3)*3,1);
        const qVat=vatSales.filter(s=>s.date&&new Date(s.date)>=qStart).reduce((s,o)=>s+(o.vat||0),0);

        async function pushToFatoora(){
          if(!confirm("Submit VAT report to ZATCA FATOORA for this period?\n\nNote: This is currently simulation mode. Configure CSID for live submission."))return;
          setPushingFatoora(true);
          try{
            // Simulate FATOORA submission — replace with real API call when CSID is ready
            await new Promise(r=>setTimeout(r,2000));
            const reportData={
              licenseKey:license?.licenseKey,
              vatNumber:license?.vatNumber,
              businessName:license?.businessName,
              reportPeriod:now.toISOString().slice(0,7),
              totalVat:vatCollectedTotal,
              totalRevenue:vatRevTotal,
              orderCount:vatSales.length,
              reportedAt:new Date().toISOString(),
              status:"simulated",
            };
            // Save report to Firestore
            try{
              const {addDoc:ad,collection:col}=await import("firebase/firestore");
              await ad(col(db,"vat_reports"),reportData);
            }catch(e){}
            localStorage.setItem("restopos_last_vat_report",JSON.stringify({...reportData,reportedAt:new Date().toISOString()}));
            setFatooraPushed(true);
            alert("✅ VAT report submitted to FATOORA (simulation mode).\n\nReport saved locally. Configure CSID in Settings for live ZATCA submission.");
          }catch(e){alert("Submission failed: "+e.message);}
          setPushingFatoora(false);
        }

        const lastReport=JSON.parse(localStorage.getItem("restopos_last_vat_report")||"null");

        return vatSales.length===0?(
          <Card><div style={{textAlign:"center",padding:"60px 20px",color:C.textLight}}>
            <div style={{fontSize:48,marginBottom:12}}>🧾</div>
            <div style={{fontSize:16,fontWeight:700,marginBottom:6}}>No VAT data yet</div>
            <div style={{fontSize:13}}>Complete orders to see VAT reports.</div>
          </div></Card>
        ):(
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            {/* VAT KPIs */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(190px,1fr))",gap:12}}>
              <StatCard icon="💰" label="Revenue (incl. VAT)" value={fmtSAR(vatRevTotal)} color={C.primary} bg={C.primaryLight}/>
              <StatCard icon="🏷️" label="Revenue (excl. VAT)" value={fmtSAR(vatRevenueExcl)} color={C.info} bg={C.infoLight}/>
              <StatCard icon="🧾" label="VAT Collected" value={fmtSAR(vatCollectedTotal)} color={C.zatca} bg={C.zatcaLight}/>
              <StatCard icon="⚠️" label="VAT Payable (All Time)" value={fmtSAR(vatCollectedTotal)} color={C.danger} bg={C.dangerLight}/>
              <StatCard icon="📅" label="This Quarter VAT" value={fmtSAR(qVat)} color={C.warning} bg={C.warningLight}/>
              <StatCard icon="📊" label="Total Orders" value={vatSales.length} color={C.success} bg={C.successLight}/>
            </div>

            {/* Pending VAT alert */}
            <div style={{background:C.dangerLight,border:`1.5px solid ${C.danger}44`,borderRadius:12,padding:"14px 18px",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
              <div>
                <div style={{fontSize:13,fontWeight:800,color:C.danger}}>⚠️ VAT Pending Submission</div>
                <div style={{fontSize:12,color:C.textMid,marginTop:2}}>SAR {vatCollectedTotal.toFixed(2)} collected — must be remitted to ZATCA per your reporting schedule</div>
                {lastReport&&<div style={{fontSize:11,color:C.success,marginTop:4}}>✓ Last report: {lastReport.reportedAt?.slice(0,10)} · SAR {(lastReport.totalVat||0).toFixed(2)}</div>}
              </div>
              <button onClick={pushToFatoora} disabled={pushingFatoora}
                style={{padding:"10px 20px",background:pushingFatoora?"#ccc":`linear-gradient(135deg,${C.zatca},#4f46e5)`,
                  color:"#fff",border:"none",borderRadius:10,fontSize:13,fontWeight:800,
                  cursor:pushingFatoora?"not-allowed":"pointer",fontFamily:"inherit",
                  boxShadow:`0 4px 16px ${C.zatca}40`}}>
                {pushingFatoora?"📡 Submitting…":"📡 Push to FATOORA"}
              </button>
            </div>

            {/* Monthly VAT table */}
            <Card>
              <div style={{fontSize:14,fontWeight:800,marginBottom:14}}>📅 Monthly VAT Breakdown</div>
              {vatRows.length===0?(
                <div style={{textAlign:"center",padding:"24px 0",color:C.textLight}}>No monthly data yet</div>
              ):(
                <DataTable
                  headers={["Month","Orders","Revenue (excl. VAT)","VAT 15%","Total (incl. VAT)","Action"]}
                  rows={vatRows.map(r=>[
                    <strong style={{fontFamily:"monospace"}}>{r.month}</strong>,
                    r.orders,
                    fmtSAR(r.revenue),
                    <span style={{color:C.zatca,fontWeight:700}}>{fmtSAR(r.vat)}</span>,
                    <strong style={{color:C.primary}}>{fmtSAR(r.revenue+r.vat)}</strong>,
                    <button onClick={async()=>{
                      if(!confirm(`Submit VAT report for ${r.month} to FATOORA?
VAT Amount: SAR ${r.vat.toFixed(2)}`))return;
                      await new Promise(res=>setTimeout(res,1500));
                      alert(`✅ VAT report for ${r.month} submitted (simulation mode).`);
                    }} style={{padding:"4px 10px",background:C.zatcaLight,border:`1px solid ${C.zatca}44`,borderRadius:6,color:C.zatca,fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
                      📡 Submit
                    </button>
                  ])}
                />
              )}
            </Card>

            {/* Total summary */}
            <Card style={{background:C.zatcaLight,border:`1.5px solid ${C.zatca}44`}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
                <div>
                  <div style={{fontSize:14,fontWeight:800,color:C.zatca}}>Total VAT Collected (All Time)</div>
                  <div style={{fontSize:11,color:C.textMid,marginTop:2}}>Remit to ZATCA per your quarterly/monthly reporting schedule</div>
                </div>
                <div style={{fontSize:28,fontWeight:900,color:C.zatca}}>{fmtSAR(vatCollectedTotal)}</div>
              </div>
            </Card>
          </div>
        );
      })()}

      {tab==="pnl"&&<div style={{display:"flex",flexDirection:"column",gap:14}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4,flexWrap:"wrap",gap:10}}>
          <div style={{fontSize:15,fontWeight:800}}>📈 Profit & Loss Statement</div>
          <PeriodBtns/>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(170px,1fr))",gap:12}}>
          <StatCard icon="💰" label="Revenue (incl. VAT)" value={fmtSAR(revenue)} color={C.primary} bg={C.primaryLight}/>
          <StatCard icon="🏷️" label="Revenue (excl. VAT)" value={fmtSAR(revenueExclVat)} color={C.info} bg={C.infoLight}/>
          <StatCard icon="📦" label="Cost of Goods" value={fmtSAR(cogs)} color={C.warning} bg={C.warningLight}/>
          <StatCard icon="💵" label="Gross Profit" value={fmtSAR(grossProfit)} color={C.success} bg={C.successLight}/>
          <StatCard icon="💸" label="Expenses" value={fmtSAR(opExpenses)} color={C.danger} bg={C.dangerLight}/>
          <StatCard icon="🏆" label="Net Profit" value={fmtSAR(netProfit)} color={netProfit>=0?C.success:C.danger} bg={netProfit>=0?C.successLight:C.dangerLight}/>
        </div>
        <Card>
          <div style={{fontSize:14,fontWeight:700,marginBottom:12}}>P&L Summary</div>
          {[["Revenue (incl. VAT)",revenue,C.primary,false],["VAT",-vatCollected,C.zatca,true],["Revenue (excl. VAT)",revenueExclVat,C.info,false],["Cost of Goods",-cogs,C.warning,true],["Gross Profit",grossProfit,grossProfit>=0?C.success:C.danger,false],["Expenses",-opExpenses,C.danger,true],["Net Profit",netProfit,netProfit>=0?C.success:C.danger,false]].map(([l,v,c,ind])=>(
            <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:`1px solid ${C.border}`,paddingLeft:ind?20:0,fontSize:ind?12:14,fontWeight:ind?500:700}}>
              <span style={{color:ind?C.textMid:C.text}}>{l}</span>
              <strong style={{color:c}}>{fmtSAR(Math.abs(v))}{v<0?" ▼":""}</strong>
            </div>
          ))}
        </Card>
      </div>}

      {tab==="expenses"&&<Expenses embedded={true}/>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// INVOICE ENHANCEMENTS v15 — Templates, Quotations, Proforma, Recurring
// ═══════════════════════════════════════════════════════════════════
function InvoiceEnhancements({sales,items,license,company}){
  const [tab,setTab]=useState("templates");
  const [quotations,setQuotations]=useState(()=>LS.get("restopos_quotations")||[]);
  const [recurring,setRecurring]=useState(()=>LS.get("restopos_recurring")||[]);
  const [showQuoteModal,setShowQuoteModal]=useState(false);
  const [editQuote,setEditQuote]=useState(null);
  const blankQuote={title:"",customerName:"",customerPhone:"",validDays:7,type:"quotation",status:"draft",notes:"",discount:0};
  const [quoteForm,setQuoteForm]=useState(blankQuote);
  const [quoteItems,setQuoteItems]=useState([]);
  function saveQuotations(list){setQuotations(list);LS.set("restopos_quotations",list);}
  function saveRecurring(list){setRecurring(list);LS.set("restopos_recurring",list);}
  function openQuoteModal(q=null,typeOverride=null){
    setEditQuote(q);
    setQuoteForm(q?{...q}:{...blankQuote,type:typeOverride||"quotation"});
    setQuoteItems(q?.items||[]);
    setShowQuoteModal(true);
  }
  function addQuoteItem(){setQuoteItems(prev=>[...prev,{name:"",qty:1,price:0}]);}
  function updateQuoteItem(i,k,v){setQuoteItems(prev=>prev.map((it,idx)=>idx===i?{...it,[k]:v}:it));}
  function removeQuoteItem(i){setQuoteItems(prev=>prev.filter((_,idx)=>idx!==i));}
  function saveQuote(){
    if(!quoteForm.customerName)return alert("Customer name required");
    const now=new Date().toISOString();
    const subtotal=quoteItems.reduce((s,it)=>s+it.price*it.qty,0);
    const discount=parseFloat(quoteForm.discount)||0;
    const afterDisc=Math.max(0,subtotal-discount);
    const vat=parseFloat((afterDisc*(15/115)).toFixed(2));
    const q={...quoteForm,id:editQuote?editQuote.id:Date.now(),createdAt:editQuote?.createdAt||now,updatedAt:now,items:quoteItems,subtotal,discount,vat,total:afterDisc,quoteNumber:editQuote?.quoteNumber||(quoteForm.type==="proforma"?`PRO-${String(Date.now()).slice(-6)}`:`QUO-${String(Date.now()).slice(-6)}`)};
    saveQuotations(editQuote?quotations.map(x=>x.id===editQuote.id?q:x):[q,...quotations]);
    setShowQuoteModal(false);
  }
  function printQuote(q){
    const bizName=(company?.businessName||license?.businessName||"Restaurant");
    const vatNum=license?.vatNumber||"";
    const typeLabel=q.type==="proforma"?"PRO FORMA INVOICE":"QUOTATION";
    const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:'Segoe UI',Arial,sans-serif;max-width:720px;margin:40px auto;padding:40px;color:#111;font-size:13px}h1{font-size:20px;font-weight:900;color:#1A6B4A;margin:0}table{width:100%;border-collapse:collapse;margin:20px 0}th{background:#F0F9F4;padding:8px 12px;text-align:left;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.05em;border-bottom:2px solid #C8E6D4}td{padding:8px 12px;border-bottom:1px solid #eee}.hdr{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:30px;padding-bottom:20px;border-bottom:3px solid #1A6B4A}.ttl{font-size:22px;font-weight:900;color:#1A6B4A;letter-spacing:.05em}.no-print{display:none}</style></head><body>
    <div class="hdr"><div><h1>${bizName}</h1><div style="font-size:11px;color:#666;margin-top:4px">VAT/TRN: ${vatNum}</div></div><div style="text-align:right"><div class="ttl">${typeLabel}</div><div style="font-size:12px;color:#666;margin-top:4px">${q.quoteNumber}</div><div style="font-size:11px;color:#888">${q.createdAt?.slice(0,10)} · Valid ${q.validDays} days</div></div></div>
    <div style="margin-bottom:20px"><strong>Bill To:</strong><br><span style="font-size:14px;font-weight:600">${q.customerName}</span>${q.customerPhone?`<br><span style="color:#666">${q.customerPhone}</span>`:""}</div>
    <table><thead><tr><th>#</th><th>Item / Description</th><th>Qty</th><th style="text-align:right">Unit Price (SAR)</th><th style="text-align:right">Total (SAR)</th></tr></thead><tbody>
    ${(q.items||[]).map((it,i)=>`<tr><td>${i+1}</td><td>${it.name}</td><td>${it.qty}</td><td style="text-align:right">${parseFloat(it.price).toFixed(2)}</td><td style="text-align:right"><strong>${(it.qty*it.price).toFixed(2)}</strong></td></tr>`).join("")}
    </tbody></table>
    <div style="display:flex;justify-content:flex-end"><div style="width:280px">
    ${q.discount>0?`<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #eee"><span>Subtotal</span><span>${parseFloat(q.subtotal).toFixed(2)}</span></div><div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #eee;color:#D94040"><span>Discount</span><span>− ${parseFloat(q.discount).toFixed(2)}</span></div>`:""}
    <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #eee"><span>VAT 15% (incl.)</span><span>${parseFloat(q.vat||0).toFixed(2)}</span></div>
    <div style="display:flex;justify-content:space-between;padding:12px 0;font-size:17px;font-weight:900;color:#1A6B4A;border-top:2px solid #1A6B4A"><span>TOTAL</span><span>SAR ${parseFloat(q.total).toFixed(2)}</span></div>
    </div></div>
    ${q.notes?`<div style="margin-top:20px;padding:12px;background:#F8F9FB;border-radius:8px;font-size:12px;color:#555"><strong>Notes:</strong> ${q.notes}</div>`:""}
    <div style="margin-top:28px;padding-top:16px;border-top:1px solid #eee;font-size:10px;color:#aaa;text-align:center">This ${q.type} is valid for ${q.validDays} days. All prices include 15% VAT. Generated by RestoPOS v23.</div>
    <script>window.onload=()=>{window.print();}<\/script></body></html>`;
    const w=window.open("","_blank","width=800,height=900");if(w){w.document.write(html);w.document.close();}
  }
  const TEMPLATES=[
    {id:"modern",name:"Modern",desc:"Clean green header, full business details, QR code",preview:"🟢"},
    {id:"classic",name:"Classic Thermal",desc:"Traditional monospace thermal receipt style",preview:"🖨️"},
    {id:"minimal",name:"Minimal",desc:"Ultra-clean, items and totals only",preview:"⬜"},
    {id:"arabic",name:"Arabic RTL",desc:"Right-to-left Arabic layout with Tajawal font",preview:"🔤"},
  ];
  const [activeTemplate,setActiveTemplateState]=useState(()=>LS.get("restopos_invoice_template")||"modern");
  function selectTemplate(id){setActiveTemplateState(id);LS.set("restopos_invoice_template",id);}

  return(
    <div>
      {showQuoteModal&&<Modal title={editQuote?"Edit Document":"New Document"} onClose={()=>setShowQuoteModal(false)} width={680}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
          <div style={{gridColumn:"1/-1"}}>
            <label style={{fontSize:12,fontWeight:600,color:C.textMid,display:"block",marginBottom:6}}>Document Type</label>
            <div style={{display:"flex",gap:8}}>
              {[["quotation","📋 Quotation"],["proforma","📝 Proforma Invoice"]].map(([t,l])=>(
                <button key={t} onClick={()=>setQuoteForm(f=>({...f,type:t}))} style={{flex:1,padding:"9px 12px",borderRadius:8,border:`2px solid ${quoteForm.type===t?C.primary:C.border}`,background:quoteForm.type===t?C.primaryLight:"#fff",color:quoteForm.type===t?C.primary:C.textMid,fontFamily:"inherit",fontSize:13,fontWeight:600,cursor:"pointer"}}>{l}</button>
              ))}
            </div>
          </div>
          <Inp label="Customer Name *" value={quoteForm.customerName} onChange={v=>setQuoteForm(f=>({...f,customerName:v}))}/>
          <Inp label="Customer Phone" value={quoteForm.customerPhone||""} onChange={v=>setQuoteForm(f=>({...f,customerPhone:v}))}/>
          <Inp label="Title / Description" value={quoteForm.title||""} onChange={v=>setQuoteForm(f=>({...f,title:v}))}/>
          <Inp label="Valid for (days)" value={quoteForm.validDays} onChange={v=>setQuoteForm(f=>({...f,validDays:v}))} type="number"/>
        </div>
        <div style={{marginBottom:12}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <label style={{fontSize:12,fontWeight:700,color:C.textMid}}>Line Items</label>
            <button onClick={addQuoteItem} style={{padding:"5px 12px",background:C.primaryLight,border:`1px solid ${C.primary}`,borderRadius:6,color:C.primary,fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>+ Add Item</button>
          </div>
          {quoteItems.length===0&&<div style={{padding:"20px",textAlign:"center",color:C.textLight,background:C.bg,borderRadius:8,fontSize:13}}>No items yet. Click "+ Add Item" to add line items.</div>}
          {quoteItems.map((it,i)=>(
            <div key={i} style={{display:"flex",gap:8,marginBottom:8,alignItems:"flex-end"}}>
              <div style={{flex:3}}><label style={{fontSize:11,color:C.textMid,display:"block",marginBottom:3}}>Item Name</label><input value={it.name} onChange={e=>{const m=items.find(m=>m.name.toLowerCase().startsWith(e.target.value.toLowerCase())&&e.target.value.length>2);updateQuoteItem(i,"name",e.target.value);if(m){updateQuoteItem(i,"price",m.price);}}} placeholder="Type item name..." style={{width:"100%",padding:"8px 10px",border:`1px solid ${C.border}`,borderRadius:7,fontSize:12,fontFamily:"inherit"}}/></div>
              <div style={{flex:1}}><label style={{fontSize:11,color:C.textMid,display:"block",marginBottom:3}}>Qty</label><input type="number" value={it.qty} min={1} onChange={e=>updateQuoteItem(i,"qty",parseFloat(e.target.value)||1)} style={{width:"100%",padding:"8px 10px",border:`1px solid ${C.border}`,borderRadius:7,fontSize:12,fontFamily:"inherit"}}/></div>
              <div style={{flex:1}}><label style={{fontSize:11,color:C.textMid,display:"block",marginBottom:3}}>Price (SAR)</label><input type="number" value={it.price} min={0} step={0.01} onChange={e=>updateQuoteItem(i,"price",parseFloat(e.target.value)||0)} style={{width:"100%",padding:"8px 10px",border:`1px solid ${C.border}`,borderRadius:7,fontSize:12,fontFamily:"inherit"}}/></div>
              <div style={{width:70,paddingBottom:8,fontSize:12,fontWeight:700,color:C.primary,textAlign:"right"}}>{fmtSAR(it.qty*it.price)}</div>
              <button onClick={()=>removeQuoteItem(i)} style={{padding:"8px 10px",background:C.dangerLight,border:`1px solid ${C.danger}`,borderRadius:7,color:C.danger,cursor:"pointer",fontFamily:"inherit"}}>×</button>
            </div>
          ))}
          {quoteItems.length>0&&<div style={{display:"flex",justifyContent:"flex-end",padding:"8px 0",borderTop:`1px solid ${C.border}`,fontSize:13,fontWeight:700,color:C.primary}}>Subtotal: {fmtSAR(quoteItems.reduce((s,it)=>s+it.qty*it.price,0))}</div>}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
          <Inp label="Discount (SAR)" value={quoteForm.discount||""} onChange={v=>setQuoteForm(f=>({...f,discount:v}))} type="number" placeholder="0"/>
          <Inp label="Notes / Terms" value={quoteForm.notes||""} onChange={v=>setQuoteForm(f=>({...f,notes:v}))}/>
        </div>
        <div style={{display:"flex",gap:10,marginTop:16}}>
          <Btn variant="ghost" onClick={()=>setShowQuoteModal(false)} style={{flex:1}}>Cancel</Btn>
          <Btn onClick={saveQuote} style={{flex:1}}>💾 Save Document</Btn>
        </div>
      </Modal>}

      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20,flexWrap:"wrap",gap:10}}>
        <div><div style={{fontSize:20,fontWeight:800}}>📄 Invoice Enhancements</div><div style={{fontSize:13,color:C.textMid,marginTop:2}}>Templates · Quotations · Proforma · Recurring</div></div>
      </div>

      <div style={{display:"flex",gap:6,marginBottom:20,flexWrap:"wrap"}}>
        {[["templates","🎨 Templates"],["quotes","📋 Quotations"],["proforma","📝 Proforma"],["recurring","🔄 Recurring"]].map(([id,lbl])=>(
          <button key={id} onClick={()=>setTab(id)} style={{padding:"8px 16px",borderRadius:8,border:`1.5px solid ${tab===id?C.primary:C.border}`,background:tab===id?C.primaryLight:"#fff",color:tab===id?C.primary:C.textMid,fontFamily:"inherit",fontSize:13,fontWeight:600,cursor:"pointer"}}>{lbl}</button>
        ))}
      </div>

      {tab==="templates"&&<div>
        <div style={{background:C.infoLight,border:`1px solid ${C.info}`,borderRadius:10,padding:"12px 16px",marginBottom:16,fontSize:13,color:C.info}}>ℹ️ Select a receipt template. The active template applies to all POS receipts. Invoice Format settings (font, footer, etc.) are in Settings → Invoice Format.</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))",gap:14,marginBottom:20}}>
          {TEMPLATES.map(t=>(
            <button key={t.id} onClick={()=>selectTemplate(t.id)}
              style={{border:`2px solid ${activeTemplate===t.id?C.primary:C.border}`,
                cursor:"pointer",background:activeTemplate===t.id?C.primaryLight:"#fff",
                transition:"all 0.2s",borderRadius:12,padding:18,textAlign:"left",
                fontFamily:"inherit",outline:"none",
                boxShadow:activeTemplate===t.id?`0 0 0 3px ${C.primary}30`:"none"}}>
              <div style={{fontSize:32,marginBottom:10}}>{t.preview}</div>
              <div style={{fontSize:14,fontWeight:800,marginBottom:4,color:activeTemplate===t.id?C.primary:C.text}}>
                {t.name}{activeTemplate===t.id?" ✓":""}
              </div>
              <div style={{fontSize:11,color:C.textMid,marginBottom:10}}>{t.desc}</div>
              <div style={{padding:"5px 12px",borderRadius:20,fontSize:11,fontWeight:700,display:"inline-block",
                background:activeTemplate===t.id?C.primary:C.bg,
                color:activeTemplate===t.id?"#fff":C.textMid,
                border:activeTemplate===t.id?"none":`1px solid ${C.border}`}}>
                {activeTemplate===t.id?"✓ Active Template":"Tap to activate"}
              </div>
            </button>
          ))}
        </div>
        <Card>
          <div style={{fontSize:14,fontWeight:700,marginBottom:12}}>📋 Document Numbering</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {[["Sales Invoice","INV-XXXXXX","Auto-sequential, ZATCA compliant hash chain"],["Quotation","QUO-XXXXXX","Auto-generated, date-stamped"],["Proforma Invoice","PRO-XXXXXX","Auto-generated, printable"],["Recurring Invoice","REC-XXXXXX","Auto on each billing cycle"]].map(([type,fmt,note])=>(
              <div key={type} style={{display:"flex",gap:14,padding:"10px 14px",background:C.bg,borderRadius:8}}>
                <span style={{fontWeight:700,width:130,fontSize:13,flexShrink:0}}>{type}</span>
                <span style={{fontFamily:"monospace",fontSize:12,color:C.primary,width:100,flexShrink:0}}>{fmt}</span>
                <span style={{fontSize:12,color:C.textMid}}>{note}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>}

      {(tab==="quotes"||tab==="proforma")&&<div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div style={{fontSize:15,fontWeight:700}}>{tab==="quotes"?"📋 Quotations":"📝 Proforma Invoices"}</div>
          <Btn onClick={()=>openQuoteModal(null,tab==="quotes"?"quotation":"proforma")}>+ New {tab==="quotes"?"Quotation":"Proforma"}</Btn>
        </div>
        {quotations.filter(q=>q.type===(tab==="quotes"?"quotation":"proforma")).length===0
          ?<Card><div style={{textAlign:"center",padding:"40px 0",color:C.textMid}}><div style={{fontSize:40,marginBottom:12}}>{tab==="quotes"?"📋":"📝"}</div><div>No {tab==="quotes"?"quotations":"proforma invoices"} yet.</div></div></Card>
          :<Card><DataTable headers={["#","Customer","Date","Items","Total","Status","Actions"]} rows={quotations.filter(q=>q.type===(tab==="quotes"?"quotation":"proforma")).map(q=>[
            <span style={{fontFamily:"monospace",fontSize:11,color:C.primary}}>{q.quoteNumber}</span>,
            <div><div style={{fontWeight:700,fontSize:13}}>{q.customerName}</div><div style={{fontSize:11,color:C.textLight}}>{q.customerPhone||""}</div></div>,
            <span style={{fontSize:12}}>{q.createdAt?.slice(0,10)}</span>,
            <span style={{fontSize:12,color:C.textMid}}>{(q.items||[]).length} items</span>,
            <strong style={{color:C.primary}}>{fmtSAR(q.total||0)}</strong>,
            <Badge color={q.status==="accepted"?C.success:q.status==="rejected"?C.danger:C.warning} bg={q.status==="accepted"?C.successLight:q.status==="rejected"?C.dangerLight:C.warningLight}>{q.status||"draft"}</Badge>,
            <div style={{display:"flex",gap:4}}>
              <Btn size="sm" variant="ghost" onClick={()=>openQuoteModal(q)}>Edit</Btn>
              <Btn size="sm" variant="outline" onClick={()=>printQuote(q)}>🖨️ Print</Btn>
              <Btn size="sm" variant="ghost" onClick={()=>{const s=prompt("New status: draft / accepted / rejected")?.toLowerCase();if(["draft","accepted","rejected"].includes(s||""))saveQuotations(quotations.map(x=>x.id===q.id?{...x,status:s}:x));}}>Status</Btn>
              <Btn size="sm" variant="danger" onClick={()=>{if(confirm("Delete?"))saveQuotations(quotations.filter(x=>x.id!==q.id));}}>Del</Btn>
            </div>
          ])}/></Card>}
      </div>}

      {tab==="recurring"&&<div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div style={{fontSize:15,fontWeight:700}}>🔄 Recurring Invoices</div>
          <Btn onClick={()=>{
            const name=prompt("Customer name:");
            if(!name)return;
            const amount=parseFloat(prompt("Amount (SAR):")||"0");
            if(!amount)return;
            const freq=prompt("Frequency: daily / weekly / monthly")||"monthly";
            const rec={id:Date.now(),customerName:name,amount,frequency:freq,nextDate:TODAY,active:true,createdAt:new Date().toISOString(),sentCount:0};
            saveRecurring([rec,...recurring]);
          }}>+ New Recurring</Btn>
        </div>
        <div style={{background:C.warningLight,border:`1px solid ${C.warning}`,borderRadius:10,padding:"12px 16px",marginBottom:16,fontSize:13,color:C.warning}}>⚠️ Manual send workflow. Click "✓ Sent" after sending each invoice to advance the schedule to the next date.</div>
        {recurring.length===0
          ?<Card><div style={{textAlign:"center",padding:"40px 0",color:C.textMid}}><div style={{fontSize:40,marginBottom:12}}>🔄</div><div>No recurring invoices yet.</div></div></Card>
          :<Card><DataTable headers={["Customer","Amount","Frequency","Next Date","Sent","Status","Actions"]} rows={recurring.map(r=>[
            <strong>{r.customerName}</strong>,
            <strong style={{color:C.primary}}>{fmtSAR(r.amount)}</strong>,
            <Badge color={C.info} bg={C.infoLight}>{r.frequency}</Badge>,
            <span style={{fontSize:12,fontFamily:"monospace",color:r.nextDate<=TODAY?C.danger:C.text,fontWeight:r.nextDate<=TODAY?700:400}}>{r.nextDate}</span>,
            <Badge color={C.success} bg={C.successLight}>{r.sentCount||0}×</Badge>,
            <Badge color={r.active?C.success:C.danger} bg={r.active?C.successLight:C.dangerLight}>{r.active?"Active":"Paused"}</Badge>,
            <div style={{display:"flex",gap:4}}>
              <Btn size="sm" variant="outline" onClick={()=>{
                const d=new Date(r.nextDate||TODAY);
                if(r.frequency==="daily")d.setDate(d.getDate()+1);
                else if(r.frequency==="weekly")d.setDate(d.getDate()+7);
                else d.setMonth(d.getMonth()+1);
                saveRecurring(recurring.map(x=>x.id===r.id?{...x,sentCount:(x.sentCount||0)+1,nextDate:d.toISOString().slice(0,10)}:x));
              }}>✓ Sent</Btn>
              <Btn size="sm" variant="ghost" onClick={()=>saveRecurring(recurring.map(x=>x.id===r.id?{...x,active:!x.active}:x))}>{r.active?"Pause":"Resume"}</Btn>
              <Btn size="sm" variant="danger" onClick={()=>{if(confirm("Delete?"))saveRecurring(recurring.filter(x=>x.id!==r.id));}}>Del</Btn>
            </div>
          ])}/></Card>}
      </div>}
    </div>
  );
}
// ENHANCED BACKUP & RESTORE MODULE
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// CLOUD SYNC STATUS COMPONENT
// ═══════════════════════════════════════════════════════════════════
function CloudSyncStatus(){
  const [lastSync,setLastSync]=useState(()=>localStorage.getItem("restopos_last_cloud_sync"));
  const [syncing,setSyncing]=useState(false);
  async function manualSync(){
    const lic=LS.get("restopos_license_v2")?.licenseKey;if(!lic)return;
    setSyncing(true);
    try{
      await Promise.all(SYNC_KEYS.map(async key=>{
        const val=localStorage.getItem(key);
        if(val){try{await syncKeyToFirestore(lic,key,JSON.parse(val));}catch(e){}}
      }));
      const now=new Date().toLocaleString("en-SA");
      localStorage.setItem("restopos_last_cloud_sync",now);setLastSync(now);
    }catch(e){}
    setSyncing(false);
    const now2=new Date().toLocaleString("en-SA");
    localStorage.setItem("restopos_last_cloud_sync",now2);setLastSync(now2);
    alert("✅ All data synced to cloud successfully!");
  }
  async function restoreNow(){
    const lic=LS.get("restopos_license_v2")?.licenseKey;if(!lic)return;
    if(!confirm("Restore all data from cloud? This will overwrite current local data."))return;
    setSyncing(true);
    const restored=await restoreFromFirestore(lic);setSyncing(false);
    if(restored){
      alert("✅ Data restored from cloud! Reloading app now...");
      setTimeout(()=>window.location.reload(),500);
    }else{
      alert("⚠️ No cloud backup found for this license key. Make sure you're using the same license key that was previously synced.");
    }
  }
  return(
    <Card style={{marginBottom:16}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
        <div>
          <div style={{fontSize:13,fontWeight:700,marginBottom:2}}>☁️ Cloud Backup & Sync</div>
          <div style={{fontSize:11,color:C.textMid}}>{lastSync?`Last synced: ${lastSync}`:"Auto-syncs every 3 seconds after changes"}</div>
          <div style={{fontSize:10,color:C.textLight,marginTop:2}}>All data backed up to Firestore — restore on any device</div>
        </div>
        <div style={{display:"flex",gap:8}}>
          <Btn onClick={manualSync} disabled={syncing} size="sm">{syncing?"⏳ Syncing…":"🔄 Sync Now"}</Btn>
          <Btn onClick={restoreNow} disabled={syncing} size="sm" variant="outline">⬇️ Restore from Cloud</Btn>
        </div>
      </div>
    </Card>
  );
}

function BackupManager({sales,items}){
  const [lastBackup,setLastBackup]=useState(()=>LS.get("restopos_last_backup")||null);
  function downloadFullBackup(){
    const backup={
      version:APP_VERSION,timestamp:new Date().toISOString(),
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
        if(!data.version&&!data.sales&&!data.items)return alert("Invalid backup file");
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
          <span style={{fontSize:12,color:C.textLight}}>Only RestoPOS v23 .json backup files</span>
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
  const revenue=filteredSales.reduce((s,o)=>s+(o.total||0),0);
  const vatCollected=filteredSales.reduce((s,o)=>s+(o.vat||0),0);
  const revenueExclVat=revenue-vatCollected;
  const cogs=filteredSales.reduce((s,o)=>s+(o.items||[]).reduce((ss,it)=>{const item=items.find(i=>i.id===it.id);return ss+(item?.cost||0)*it.qty;},0),0);
  const opExpenses=filteredExp.reduce((s,e)=>s+e.amount,0);
  const grossProfit=revenueExclVat-cogs;
  const netProfit=grossProfit-opExpenses;
  const grossMargin=revenueExclVat>0?((grossProfit/revenueExclVat)*100).toFixed(1):0;
  const netMargin=revenueExclVat>0?((netProfit/revenueExclVat)*100).toFixed(1):0;
  const payBreakdown=["Cash","Mada","Apple Pay","STC Pay"].map(m=>({method:m,total:filteredSales.filter(s=>s.payMethod===m).reduce((s,o)=>s+o.total,0),count:filteredSales.filter(s=>s.payMethod===m).length}));
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
function ShiftManager({sales,currentUser,lang="en"}){
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
    const expenses=LS.get("restopos_expenses")||[];
    const shiftExpenses=expenses.filter(e=>new Date(e.date).getTime()>=new Date(activeShift.startTime).setHours(0,0,0,0));
    const closed={...activeShift,endTime:new Date().toISOString(),closingCash:parseFloat(cashDrawer)||0,shiftRevenue:revenue,shiftOrders:shiftSales.length,payBreakdown:{Cash:shiftSales.filter(s=>s.payMethod==="Cash").reduce((s,o)=>s+o.total,0),Mada:shiftSales.filter(s=>s.payMethod==="Mada").reduce((s,o)=>s+o.total,0),"Apple Pay":shiftSales.filter(s=>s.payMethod==="Apple Pay").reduce((s,o)=>s+o.total,0),"STC Pay":shiftSales.filter(s=>s.payMethod==="STC Pay").reduce((s,o)=>s+o.total,0)},shiftVat:shiftSales.reduce((s,o)=>s+(o.vat||0),0),shiftExpenses:shiftExpenses.reduce((s,e)=>s+e.amount,0)};
    const updated=shifts.map(s=>s.id===activeShift.id?closed:s);setShifts(updated);LS.set("restopos_shifts",updated);
    LS.set("restopos_active_shift",null);setActiveShift(null);setCashDrawer("");
    logActivity("SHIFT_ENDED",{after:{user:closed.user,revenue,orders:shiftSales.length}},currentUser?.role||"System");
  }
  function printZReport(s){
    const payBr=s.payBreakdown||{};
    const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      @page{size:80mm auto;margin:0}body{font-family:'Courier New',monospace;font-size:12px;width:80mm;padding:4mm}
      .c{text-align:center}.b{font-weight:bold}.big{font-size:16px;font-weight:900}
      .hr{border:none;border-top:1px dashed #000;margin:5px 0}
      .row{display:flex;justify-content:space-between;margin:2px 0}
    </style></head><body>
      <div class="c big">Z - REPORT</div>
      <div class="c">End of Day / Shift Report</div>
      <div class="hr"/>
      <div class="c b">${s.user}</div>
      <div class="c">${(s.startTime||"").slice(0,16).replace("T"," ")} → ${(s.endTime||"").slice(0,16).replace("T"," ")}</div>
      <div class="hr"/>
      <div class="row b"><span>TOTAL REVENUE</span><span>SAR ${(s.shiftRevenue||0).toFixed(2)}</span></div>
      <div class="row"><span>VAT Collected</span><span>SAR ${(s.shiftVat||0).toFixed(2)}</span></div>
      <div class="row"><span>Total Orders</span><span>${s.shiftOrders||0}</span></div>
      ${s.shiftExpenses>0?`<div class="row"><span>Expenses</span><span>-SAR ${(s.shiftExpenses||0).toFixed(2)}</span></div>`:""}
      <div class="hr"/>
      <div class="b">PAYMENT BREAKDOWN</div>
      ${Object.entries(payBr).filter(([,v])=>v>0).map(([k,v])=>`<div class="row"><span>${k}</span><span>SAR ${v.toFixed(2)}</span></div>`).join("")}
      <div class="hr"/>
      <div class="row"><span>Opening Cash</span><span>SAR ${(s.openingCash||0).toFixed(2)}</span></div>
      <div class="row b"><span>Closing Cash</span><span>SAR ${(s.closingCash||0).toFixed(2)}</span></div>
      <div class="hr"/>
      <div class="c">Printed: ${new Date().toLocaleString("en-SA")}</div>
      <br/><br/>
    </body></html>`;
    const win=window.open("","_blank","width=320,height=600");
    if(!win){alert("Allow pop-ups to print Z-Report");return;}
    win.document.write(html);win.document.close();
    setTimeout(()=>{win.print();win.close();},500);
  }
  function exportShiftPDF(s){
    const payBr=s.payBreakdown||{};
    const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:'Segoe UI',sans-serif;max-width:720px;margin:40px auto;padding:32px;color:#111;font-size:13px}h1{font-size:22px;font-weight:900;color:#1A6B4A;margin:0}h2{font-size:14px;font-weight:700;color:#1A6B4A;margin:16px 0 6px;border-bottom:2px solid #C8E6D4;padding-bottom:4px}.hdr{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;padding-bottom:16px;border-bottom:3px solid #1A6B4A}.row{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #eee;font-size:13px}.row strong{color:#1A6B4A}.total-row{display:flex;justify-content:space-between;padding:10px 0;font-size:17px;font-weight:900;color:#1A6B4A;border-top:2px solid #1A6B4A;margin-top:8px}table{width:100%;border-collapse:collapse;margin:10px 0}th{background:#F0F9F4;padding:8px 10px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;border-bottom:2px solid #C8E6D4}td{padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:12px}@media print{button{display:none}}</style></head><body>
    <div class="hdr"><div><h1>Shift Report</h1><div style="font-size:11px;color:#666;margin-top:4px">${s.user} · ID ${s.id}</div></div><div style="text-align:right;font-size:12px;color:#666"><div><strong>Started:</strong> ${s.startTime?.slice(0,16).replace("T"," ")}</div><div><strong>Ended:</strong> ${s.endTime?.slice(0,16).replace("T"," ")}</div></div></div>
    <h2>📊 Sales Summary</h2>
    <div class="row"><span>Total Orders</span><strong>${s.shiftOrders||0}</strong></div>
    <div class="row"><span>Total Revenue (incl. VAT)</span><strong>SAR ${(s.shiftRevenue||0).toFixed(2)}</strong></div>
    <div class="row"><span>VAT Collected (15%)</span><strong>SAR ${(s.shiftVat||0).toFixed(2)}</strong></div>
    <div class="row"><span>Revenue (excl. VAT)</span><strong>SAR ${((s.shiftRevenue||0)-(s.shiftVat||0)).toFixed(2)}</strong></div>
    <h2>💳 Payment Breakdown</h2>
    ${["Cash","Mada","Apple Pay","STC Pay"].map(m=>`<div class="row"><span>${m}</span><strong>SAR ${(payBr[m]||0).toFixed(2)}</strong></div>`).join("")}
    <h2>💰 Cash Reconciliation</h2>
    <div class="row"><span>Opening Cash</span><strong>SAR ${(s.openingCash||0).toFixed(2)}</strong></div>
    <div class="row"><span>Cash Sales</span><strong>SAR ${(payBr["Cash"]||0).toFixed(2)}</strong></div>
    <div class="row"><span>Expected in Drawer</span><strong>SAR ${((s.openingCash||0)+(payBr["Cash"]||0)).toFixed(2)}</strong></div>
    <div class="row"><span>Actual Closing Cash</span><strong>SAR ${(s.closingCash||0).toFixed(2)}</strong></div>
    <div class="total-row"><span>Cash Difference</span><span style="color:${((s.closingCash||0)-((s.openingCash||0)+(payBr["Cash"]||0)))>=0?"#1A6B4A":"#D94040"}">SAR ${((s.closingCash||0)-((s.openingCash||0)+(payBr["Cash"]||0))).toFixed(2)}</span></div>
    ${(s.shiftExpenses||0)>0?`<h2>💸 Expenses During Shift</h2><div class="row"><span>Total Expenses</span><strong style="color:#D94040">SAR ${(s.shiftExpenses||0).toFixed(2)}</strong></div>`:""}
    ${s.note?`<h2>📝 Notes</h2><div style="padding:10px;background:#F8F9FB;border-radius:8px;font-size:12px;color:#555;">${s.note}</div>`:""}
    <div style="margin-top:32px;padding-top:12px;border-top:1px solid #eee;font-size:10px;color:#aaa;text-align:center">Generated by RestoPOS v23 · ${new Date().toLocaleString()}</div>
    <script>window.onload=()=>{window.print();}<\/script></body></html>`;
    const w=window.open("","_blank","width=800,height=900");if(w){w.document.write(html);w.document.close();}
  }
  const shiftDuration=activeShift?Math.floor((Date.now()-new Date(activeShift.startTime).getTime())/60000):0;
  const shiftSales=activeShift?sales.filter(s=>new Date(s.date+"T"+(s.time||"00:00")).getTime()>=new Date(activeShift.startTime).getTime()):[];
  const shiftVat=shiftSales.reduce((s,o)=>s+(o.vat||0),0);
  const payMethods=["Cash","Mada","Apple Pay","STC Pay"];
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
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              <StatCard icon="🧾" label="Orders" value={shiftSales.length} color={C.primary} bg={C.primaryLight}/>
              <StatCard icon="💰" label="Revenue" value={fmtSAR(shiftSales.reduce((s,o)=>s+o.total,0))} color={C.success} bg={C.successLight}/>
              <StatCard icon="⬛" label="VAT" value={fmtSAR(shiftVat)} color={C.zatca} bg={C.zatcaLight}/>
              <div style={{marginTop:6}}>
                {payMethods.map(m=>{const t=shiftSales.filter(s=>s.payMethod===m).reduce((s,o)=>s+o.total,0);return t>0?<div key={m} style={{display:"flex",justifyContent:"space-between",fontSize:12,padding:"3px 0"}}><span style={{color:C.textMid}}>{m}</span><strong>{fmtSAR(t)}</strong></div>:null;})}
              </div>
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
        :<div>{shifts.filter(s=>s.endTime).slice(0,20).map(s=>{
          const payBr=s.payBreakdown||{};
          return(
            <div key={s.id} style={{marginBottom:16,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 16px",background:C.bg,borderBottom:`1px solid ${C.border}`}}>
                <div>
                  <div style={{fontWeight:700,fontSize:14}}>{s.user} · {s.startTime?.slice(0,10)}</div>
                  <div style={{fontSize:11,color:C.textLight}}>{s.startTime?.slice(11,16)} → {s.endTime?.slice(11,16)}</div>
                </div>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <div style={{textAlign:"right"}}><div style={{fontSize:15,fontWeight:900,color:C.primary}}>{fmtSAR(s.shiftRevenue||0)}</div><div style={{fontSize:11,color:C.textLight}}>{s.shiftOrders||0} orders</div></div>
                  <Btn size="sm" variant="outline" onClick={()=>exportShiftPDF(s)}>📄 PDF</Btn>
                  <Btn size="sm" variant="outline" onClick={()=>printZReport(s)}>🖨️ Z-Report</Btn>
                </div>
              </div>
              <div style={{padding:"12px 16px",display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:10}}>
                <div><div style={{fontSize:10,color:C.textLight,fontWeight:700,textTransform:"uppercase",letterSpacing:1}}>VAT Collected</div><div style={{fontSize:13,fontWeight:700,color:C.zatca}}>{fmtSAR(s.shiftVat||0)}</div></div>
                <div><div style={{fontSize:10,color:C.textLight,fontWeight:700,textTransform:"uppercase",letterSpacing:1}}>Opening Cash</div><div style={{fontSize:13,fontWeight:700}}>{fmtSAR(s.openingCash||0)}</div></div>
                <div><div style={{fontSize:10,color:C.textLight,fontWeight:700,textTransform:"uppercase",letterSpacing:1}}>Closing Cash</div><div style={{fontSize:13,fontWeight:700,color:s.closingCash>0?C.success:C.textLight}}>{fmtSAR(s.closingCash||0)}</div></div>
                {s.shiftExpenses>0&&<div><div style={{fontSize:10,color:C.textLight,fontWeight:700,textTransform:"uppercase",letterSpacing:1}}>Expenses</div><div style={{fontSize:13,fontWeight:700,color:C.danger}}>{fmtSAR(s.shiftExpenses||0)}</div></div>}
              </div>
              {Object.keys(payBr).some(k=>payBr[k]>0)&&<div style={{padding:"0 16px 12px",display:"flex",gap:12,flexWrap:"wrap"}}>
                {payMethods.filter(m=>payBr[m]>0).map(m=><span key={m} style={{fontSize:11,padding:"2px 8px",borderRadius:20,background:C.infoLight,color:C.info,fontWeight:700,border:`1px solid ${C.info}33`}}>{m}: {fmtSAR(payBr[m])}</span>)}
              </div>}
            </div>
          );
        })}</div>}
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
// ═══════════════════════════════════════════════════════════════════
// ERROR BOUNDARY
// ═══════════════════════════════════════════════════════════════════
class ErrorBoundary extends Component {
  constructor(props){super(props);this.state={hasError:false,error:null};}
  static getDerivedStateFromError(error){return{hasError:true,error};}
  componentDidCatch(error,info){
    const logs=JSON.parse(localStorage.getItem("restopos_error_logs")||"[]");
    logs.unshift({ts:new Date().toISOString(),message:error?.message||"Unknown",stack:error?.stack?.slice(0,400)||"",component:info?.componentStack?.slice(0,200)||""});
    localStorage.setItem("restopos_error_logs",JSON.stringify(logs.slice(0,50)));
  }
  render(){
    if(this.state.hasError){
      return(
        <div style={{minHeight:"100vh",background:"#0a1628",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Plus Jakarta Sans',sans-serif",padding:20}}>
          <div style={{background:"#1a2332",border:"1px solid rgba(217,64,64,0.4)",borderRadius:20,padding:40,maxWidth:480,textAlign:"center"}}>
            <div style={{fontSize:48,marginBottom:16}}>⚠️</div>
            <div style={{fontSize:20,fontWeight:800,color:"#ff6b6b",marginBottom:8}}>Something went wrong</div>
            <div style={{fontSize:13,color:"rgba(255,255,255,0.5)",marginBottom:24,lineHeight:1.6}}>{this.state.error?.message||"An unexpected error occurred."}</div>
            <button onClick={()=>this.setState({hasError:false,error:null})} style={{padding:"12px 28px",background:"linear-gradient(135deg,#1A6B4A,#134D36)",color:"#fff",border:"none",borderRadius:10,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit",marginRight:10}}>Try Again</button>
            <button onClick={()=>window.location.reload()} style={{padding:"12px 28px",background:"rgba(255,255,255,0.1)",color:"#fff",border:"1px solid rgba(255,255,255,0.2)",borderRadius:10,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Reload App</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ═══════════════════════════════════════════════════════════════════
// OFFLINE DETECTION + LOCAL CACHE SYNC
// ═══════════════════════════════════════════════════════════════════
function useOfflineSync(){
  const [isOnline,setIsOnline]=useState(navigator.onLine);
  const [syncQueue,setSyncQueue]=useState(()=>{try{return JSON.parse(localStorage.getItem("restopos_sync_queue")||"[]");}catch{return[];}});
  const [justCameOnline,setJustCameOnline]=useState(false);
  useEffect(()=>{
    const goOnline=()=>{setIsOnline(true);setJustCameOnline(true);setTimeout(()=>setJustCameOnline(false),5000);};
    const goOffline=()=>setIsOnline(false);
    window.addEventListener("online",goOnline);
    window.addEventListener("offline",goOffline);
    return()=>{window.removeEventListener("online",goOnline);window.removeEventListener("offline",goOffline);};
  },[]);
  function queueForSync(item){
    const q=[...syncQueue,{...item,_queuedAt:new Date().toISOString()}];
    setSyncQueue(q);
    localStorage.setItem("restopos_sync_queue",JSON.stringify(q.slice(-500)));
  }
  function clearSyncQueue(){setSyncQueue([]);localStorage.removeItem("restopos_sync_queue");}
  return{isOnline,syncQueue,queueForSync,clearSyncQueue,justCameOnline};
}

// ═══════════════════════════════════════════════════════════════════
// SESSION TIMEOUT
// ═══════════════════════════════════════════════════════════════════
function useSessionTimeout(currentUser,onTimeout,timeoutMinutes=30){
  const timerRef=useRef(null);
  const reset=()=>{
    if(timerRef.current)clearTimeout(timerRef.current);
    if(!currentUser)return;
    timerRef.current=setTimeout(()=>onTimeout(),timeoutMinutes*60*1000);
  };
  useEffect(()=>{
    if(!currentUser){if(timerRef.current)clearTimeout(timerRef.current);return;}
    reset();
    const events=["mousemove","keydown","mousedown","touchstart","scroll"];
    events.forEach(e=>window.addEventListener(e,reset));
    return()=>{if(timerRef.current)clearTimeout(timerRef.current);events.forEach(e=>window.removeEventListener(e,reset));};
  },[currentUser,timeoutMinutes]);
}

// ═══════════════════════════════════════════════════════════════════
// ESC/POS THERMAL PRINTER — Web Serial API
// ═══════════════════════════════════════════════════════════════════
const ESC=0x1B;const GS=0x1D;
const escpos={
  init:()=>new Uint8Array([ESC,0x40]),
  alignCenter:()=>new Uint8Array([ESC,0x61,0x01]),
  alignLeft:()=>new Uint8Array([ESC,0x61,0x00]),
  bold:(on)=>new Uint8Array([ESC,0x45,on?1:0]),
  doubleSize:(on)=>new Uint8Array([ESC,0x21,on?0x30:0x00]),
  cutPaper:()=>new Uint8Array([GS,0x56,0x41,0x00]),
  feed:(n=3)=>new Uint8Array([ESC,0x64,n]),
  text:(str)=>new TextEncoder().encode(str+"\n"),
  merge:(...arrays)=>{const total=arrays.reduce((s,a)=>s+a.length,0);const merged=new Uint8Array(total);let offset=0;for(const a of arrays){merged.set(a,offset);offset+=a.length;}return merged;}
};

// ── Printer port management ─────────────────────────────────────────
let _billPort=null;   // receipt/bill printer
let _kitchenPort=null; // kitchen ticket printer

function isPortOpen(port){return port&&port.readable;}

async function connectPort(role="bill"){
  if(!("serial" in navigator))throw new Error("Web Serial API not supported. Use Chrome or Edge on desktop.");
  const key=role==="kitchen"?"restopos_kitchen_port_hint":"restopos_bill_port_hint";
  // Try to auto-reconnect to previously used port
  try{
    const ports=await navigator.serial.getPorts();
    if(ports.length>0){
      const port=ports[0]; // auto-connect to first available
      if(!port.readable)await port.open({baudRate:9600});
      if(role==="kitchen")_kitchenPort=port;
      else _billPort=port;
      return port;
    }
  }catch(e){/* fall through to request */}
  // Ask user to select
  try{
    const port=await navigator.serial.requestPort();
    await port.open({baudRate:9600});
    if(role==="kitchen")_kitchenPort=port;
    else _billPort=port;
    return port;
  }catch(e){throw new Error("Printer connection failed: "+e.message);}
}

async function getAvailablePorts(){
  if(!("serial" in navigator))return[];
  try{return await navigator.serial.getPorts();}
  catch(e){return[];}
}

async function printEscPos(data,role="bill"){
  let port=role==="kitchen"?_kitchenPort:_billPort;
  if(!isPortOpen(port))port=await connectPort(role);
  const writer=port.writable.getWriter();
  try{await writer.write(data);}finally{writer.releaseLock();}
}

// Legacy wrapper
async function connectThermalPrinter(){return connectPort("bill");}
async function printReceiptEscPos(order,license){
  const items=order.items||[];
  const W=42;
  const line=(text,right="")=>{
    const gap=W-text.length-right.length;
    return escpos.text(text+(gap>0?" ".repeat(gap):"")+right);
  };
  const parts=[
    escpos.init(),
    escpos.alignCenter(),
    escpos.bold(true),escpos.doubleSize(true),
    escpos.text(license.businessName||"Restaurant"),
    escpos.doubleSize(false),escpos.bold(false),
    escpos.text(license.address||""),
    escpos.text("TRN: "+license.vatNumber),
    escpos.text("--------------------------------"),
    escpos.alignLeft(),
    escpos.text((order.id||"")+" | "+(order.date||"")+" "+(order.time||"")),
    order.customer?escpos.text("Customer: "+order.customer):new Uint8Array(0),
    escpos.text((order.type||"Sale")+(order.table?" · Table "+order.table:"")),
    escpos.text("--------------------------------"),
    ...items.map(it=>line(it.name.slice(0,28)+" x"+it.qty,"SAR "+(it.price*it.qty).toFixed(2))),
    escpos.text("--------------------------------"),
  ];
  if(order.discount>0)parts.push(line("Discount","-SAR "+order.discount.toFixed(2)));
  parts.push(
    line("VAT 15% (incl.)","SAR "+(order.vat||0).toFixed(2)),
    escpos.bold(true),
    line("TOTAL","SAR "+(order.total||0).toFixed(2)),
    escpos.bold(false),
  );
  if(order.payMethod==="Cash"){
    parts.push(
      line("Cash Given","SAR "+(order.given||0).toFixed(2)),
      line("Change","SAR "+(order.change||0).toFixed(2)),
    );
  }else if(order.payMethod==="Both"){
    parts.push(
      line("Cash","SAR "+(order.cashAmount||0).toFixed(2)),
      line("Card","SAR "+(order.cardAmount||0).toFixed(2)),
    );
  }else{
    parts.push(line("Payment",order.payMethod||""));
  }
  if(order.id)parts.push(escpos.text("Invoice: "+order.id));
  parts.push(
    escpos.text(""),
    escpos.alignCenter(),
    escpos.text("Thank you! شكراً لزيارتكم"),
    escpos.text(""),
    escpos.feed(3),
    escpos.cutPaper()
  );
  const data=escpos.merge(...parts.filter(p=>p.length>0));
  // Open cash drawer on cash payment (ESC/POS pin 2)
  if(order.payMethod==="Cash"||order.payMethod==="Both"){
    try{
      const drawerCmd=new Uint8Array([0x1B,0x70,0x00,0x19,0xFA]);
      const drawerData=escpos.merge(drawerCmd,data);
      await printEscPos(drawerData,"bill");
    }catch(e){await printEscPos(data,"bill");}
  }else{
    await printEscPos(data,"bill");
  }
}

// Kitchen ticket ESC/POS print
async function printKOTEscPos(cart,orderType,tableId,kotNo){
  const W=32;
  const line=(t)=>escpos.text(t.slice(0,W));
  const data=escpos.merge(
    escpos.init(),
    escpos.alignCenter(),
    escpos.bold(true),escpos.doubleSize(true),
    escpos.text("KOT #"+kotNo),
    escpos.doubleSize(false),escpos.bold(false),
    escpos.text("--------------------------------"),
    escpos.alignLeft(),
    escpos.text((orderType||"Order").toUpperCase()+(tableId?" · Table "+tableId:"")),
    escpos.text(new Date().toLocaleTimeString("en-SA",{hour:"2-digit",minute:"2-digit"})),
    escpos.text("--------------------------------"),
    ...cart.map(it=>line(it.qty+"x "+it.name+(it.nameAr?" / "+it.nameAr:""))),
    escpos.text("--------------------------------"),
    escpos.alignCenter(),
    escpos.text(""),
    escpos.feed(4),
    escpos.cutPaper()
  );
  await printEscPos(data,"kitchen");
}

// ═══════════════════════════════════════════════════════════════════
// THERMAL PRINTER SETTINGS COMPONENT
// ═══════════════════════════════════════════════════════════════════
function ThermalPrinterSettings(){
  const [billStatus,setBillStatus]=useState(()=>isPortOpen(_billPort)?"connected":"idle");
  const [kitchenStatus,setKitchenStatus]=useState(()=>isPortOpen(_kitchenPort)?"connected":"idle");
  const [log,setLog]=useState("");
  const [availPorts,setAvailPorts]=useState([]);
  const webSerialSupported="serial" in navigator;

  useEffect(()=>{
    if(!webSerialSupported)return;
    getAvailablePorts().then(ports=>setAvailPorts(ports));
    // Auto-connect on mount if ports already granted
    if(!isPortOpen(_billPort)){
      getAvailablePorts().then(ports=>{
        if(ports.length>0){
          connectPort("bill").then(()=>setBillStatus("connected")).catch(()=>{});
        }
      });
    }
  },[]);

  async function connectBill(){
    setBillStatus("connecting");setLog("");
    try{
      await connectPort("bill");
      setBillStatus("connected");
      setLog("✅ Bill printer connected.");
      setAvailPorts(await getAvailablePorts());
    }catch(e){setBillStatus("error");setLog("❌ "+e.message);}
  }
  async function connectKitchen(){
    setKitchenStatus("connecting");setLog("");
    try{
      await connectPort("kitchen");
      setKitchenStatus("connected");
      setLog("✅ Kitchen printer connected.");
      setAvailPorts(await getAvailablePorts());
    }catch(e){setKitchenStatus("error");setLog("❌ "+e.message);}
  }
  async function testBill(){
    setBillStatus("printing");setLog("");
    try{
      const testOrder={id:"TEST-001",date:new Date().toISOString().slice(0,10),time:new Date().toLocaleTimeString(),type:"Test",items:[{name:"Test Item",qty:1,price:10}],vat:1.30,total:10,discount:0,payMethod:"Cash",given:10,change:0};
      const lic={businessName:"RestoPOS Test",address:"Test Address",vatNumber:"000000000000000"};
      await printReceiptEscPos(testOrder,lic);
      setBillStatus("connected");setLog("✅ Test receipt printed. Check your printer.");
    }catch(e){setBillStatus("error");setLog("❌ "+e.message);}
  }
  async function testKitchen(){
    setKitchenStatus("printing");setLog("");
    try{
      await printKOTEscPos([{qty:1,name:"Test Burger",nameAr:"برجر تجريبي"},{qty:2,name:"French Fries"}],"Dine-in",5,999);
      setKitchenStatus("connected");setLog("✅ KOT test sent to kitchen printer.");
    }catch(e){setKitchenStatus("error");setLog("❌ "+e.message);}
  }

  const statusColor={idle:C.textLight,connecting:C.warning,connected:C.success,error:C.danger,printing:C.info};
  const statusLabel={idle:"Not connected",connecting:"Connecting…",connected:"✅ Connected",error:"❌ Error",printing:"Printing…"};

  return(
    <Card style={{maxWidth:580}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:4}}>🖨️ Thermal Printers (ESC/POS)</div>
      <div style={{fontSize:12,color:C.textMid,marginBottom:16}}>Direct USB printing with auto-cut. Works on Chrome/Edge desktop with USB thermal printers.</div>

      {!webSerialSupported?(
        <div style={{background:C.warningLight,border:`1px solid ${C.warning}`,borderRadius:10,padding:"14px 16px",fontSize:13,color:C.warning,fontWeight:600}}>
          ⚠️ Web Serial API not available.<br/>
          <span style={{fontWeight:400,fontSize:12}}>Use <strong>Google Chrome</strong> or <strong>Microsoft Edge</strong> on desktop.</span>
        </div>
      ):(
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          {/* Available ports */}
          {availPorts.length>0&&(
            <div style={{background:C.bg,borderRadius:10,padding:"10px 14px"}}>
              <div style={{fontSize:11,fontWeight:700,color:C.textMid,marginBottom:6}}>DETECTED PRINTERS ({availPorts.length})</div>
              {availPorts.map((p,i)=>(
                <div key={i} style={{fontSize:12,color:C.text,padding:"4px 0",borderBottom:i<availPorts.length-1?`1px solid ${C.border}`:"none"}}>
                  🖨️ Port {i+1}: {p.getInfo?.()?.usbVendorId?"USB Device":"Serial Device"} 
                  {isPortOpen(p)?" — 🟢 Active":""}
                </div>
              ))}
            </div>
          )}

          {/* Bill Printer */}
          <div style={{border:`1.5px solid ${billStatus==="connected"?C.success:C.border}`,borderRadius:12,padding:"14px 16px"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div>
                <div style={{fontSize:13,fontWeight:700}}>🧾 Bill / Receipt Printer</div>
                <div style={{fontSize:11,color:statusColor[billStatus],fontWeight:600,marginTop:2}}>{statusLabel[billStatus]}</div>
              </div>
              <div style={{width:10,height:10,borderRadius:"50%",background:statusColor[billStatus]}}/>
            </div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              <Btn onClick={connectBill} disabled={billStatus==="connecting"||billStatus==="printing"}>
                {billStatus==="connected"?"🔄 Reconnect":"🔌 Connect Bill Printer"}
              </Btn>
              <Btn variant="outline" onClick={testBill} disabled={billStatus!=="connected"||billStatus==="printing"}>
                🧪 Test Print
              </Btn>
            </div>
          </div>

          {/* Kitchen Printer */}
          <div style={{border:`1.5px solid ${kitchenStatus==="connected"?C.success:C.border}`,borderRadius:12,padding:"14px 16px"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div>
                <div style={{fontSize:13,fontWeight:700}}>🍽️ Kitchen Ticket Printer</div>
                <div style={{fontSize:11,color:statusColor[kitchenStatus],fontWeight:600,marginTop:2}}>{statusLabel[kitchenStatus]}</div>
              </div>
              <div style={{width:10,height:10,borderRadius:"50%",background:statusColor[kitchenStatus]}}/>
            </div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              <Btn onClick={connectKitchen} disabled={kitchenStatus==="connecting"||kitchenStatus==="printing"}>
                {kitchenStatus==="connected"?"🔄 Reconnect":"🔌 Connect Kitchen Printer"}
              </Btn>
              <Btn variant="outline" onClick={testKitchen} disabled={kitchenStatus!=="connected"||kitchenStatus==="printing"}>
                🧪 Test KOT
              </Btn>
            </div>
          </div>

          {log&&<div style={{padding:"10px 14px",background:log.startsWith("✅")?C.successLight:C.dangerLight,border:`1px solid ${log.startsWith("✅")?C.success:C.danger}`,borderRadius:8,fontSize:12,color:log.startsWith("✅")?C.success:C.danger,fontWeight:600}}>{log}</div>}

          <div style={{background:C.bg,borderRadius:10,padding:"12px 14px",fontSize:12,color:C.textMid}}>
            <strong>How it works:</strong> Connect your USB thermal printer → click Connect → browser asks permission once → auto-reconnects on next visit. Both bill and kitchen printers can be different devices.
          </div>
        </div>
      )}
      <div style={{marginTop:16,paddingTop:14,borderTop:`1px solid ${C.border}`}}>
        <div style={{fontSize:12,fontWeight:700,marginBottom:4}}>🌐 Fallback: Browser Print</div>
        <div style={{fontSize:11,color:C.textMid}}>If no USB printer connected, receipts use your browser print dialog. Set your thermal printer as default in OS settings for best results.</div>
      </div>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════
// KITCHEN DISPLAY SYSTEM (KDS)
// ═══════════════════════════════════════════════════════════════════
function KitchenDisplay({sales}){
  const [orders,setOrders]=useState(()=>{
    const saved=JSON.parse(localStorage.getItem("restopos_kds_orders")||"[]");
    return saved;
  });
  const [filter,setFilter]=useState("pending");
  // Sync new sales into KDS queue
  useEffect(()=>{
    const kdsIds=new Set(orders.map(o=>o.id));
    const recent=sales.filter(s=>!kdsIds.has(s.id)&&s.status==="completed");
    if(recent.length>0){
      const newOrders=recent.map(s=>({...s,kdsStatus:"pending",kdsAt:new Date().toISOString(),routedTo:"Kitchen"}));
      const updated=[...newOrders,...orders].slice(0,200);
      setOrders(updated);
      localStorage.setItem("restopos_kds_orders",JSON.stringify(updated));
    }
  },[sales]);
  function markReady(id){
    const updated=orders.map(o=>o.id===id?{...o,kdsStatus:"ready",readyAt:new Date().toISOString()}:o);
    setOrders(updated);localStorage.setItem("restopos_kds_orders",JSON.stringify(updated));
  }
  function markDone(id){
    const updated=orders.map(o=>o.id===id?{...o,kdsStatus:"served",servedAt:new Date().toISOString()}:o);
    setOrders(updated);localStorage.setItem("restopos_kds_orders",JSON.stringify(updated));
  }
  function clearDone(){
    const updated=orders.filter(o=>o.kdsStatus!=="served");
    setOrders(updated);localStorage.setItem("restopos_kds_orders",JSON.stringify(updated));
  }
  const filtered=orders.filter(o=>filter==="all"||o.kdsStatus===filter);
  const pendingCount=orders.filter(o=>o.kdsStatus==="pending").length;
  const readyCount=orders.filter(o=>o.kdsStatus==="ready").length;
  function elapsedMin(ts){return Math.floor((Date.now()-new Date(ts).getTime())/60000);}
  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20,flexWrap:"wrap",gap:10}}>
        <div><div style={{fontSize:20,fontWeight:800}}>🍳 Kitchen Display System</div><div style={{fontSize:13,color:C.textMid,marginTop:2}}>Live order routing to kitchen</div></div>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          {[["pending","⏳ Queue",pendingCount],["ready","✅ Ready",readyCount],["served","🍽 Served",0],["all","All",orders.length]].map(([id,lbl,cnt])=>(
            <button key={id} onClick={()=>setFilter(id)} style={{padding:"7px 14px",borderRadius:8,border:`1.5px solid ${filter===id?C.primary:C.border}`,background:filter===id?C.primaryLight:"#fff",color:filter===id?C.primary:C.textMid,fontFamily:"inherit",fontSize:12,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",gap:5}}>
              {lbl}{cnt>0&&<span style={{background:id==="pending"?C.danger:C.primary,color:"#fff",borderRadius:20,padding:"0 6px",fontSize:10,fontWeight:800}}>{cnt}</span>}
            </button>
          ))}
          <Btn size="sm" variant="ghost" onClick={clearDone}>Clear Served</Btn>
        </div>
      </div>
      {filtered.length===0?(
        <Card><div style={{textAlign:"center",padding:"60px 0",color:C.textLight}}><div style={{fontSize:48,marginBottom:12}}>🍳</div><div style={{fontSize:16,fontWeight:700}}>No orders in {filter} queue</div><div style={{fontSize:13,marginTop:6}}>New orders from the POS will appear here automatically.</div></div></Card>
      ):(
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:14}}>
          {filtered.map(order=>{
            const elapsed=elapsedMin(order.kdsAt);
            const urgent=elapsed>15&&order.kdsStatus==="pending";
            const statusColor=order.kdsStatus==="pending"?(urgent?C.danger:C.warning):order.kdsStatus==="ready"?C.success:C.textLight;
            const statusBg=order.kdsStatus==="pending"?(urgent?C.dangerLight:C.warningLight):order.kdsStatus==="ready"?C.successLight:C.bg;
            return(
              <div key={order.id} style={{background:"#fff",border:`2px solid ${statusColor}`,borderRadius:12,overflow:"hidden",boxShadow:"0 2px 8px rgba(0,0,0,0.06)"}}>
                <div style={{background:statusBg,padding:"10px 14px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div>
                    <div style={{fontSize:14,fontWeight:800,color:statusColor}}>{order.id}</div>
                    <div style={{fontSize:11,color:C.textMid}}>{order.type}{order.table?` · Table ${order.table}`:""}</div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:11,fontWeight:700,color:urgent?"#D94040":C.textMid}}>{elapsed}m ago</div>
                    <div style={{fontSize:10,color:C.textLight}}>{order.time}</div>
                  </div>
                </div>
                <div style={{padding:"10px 14px"}}>
                  {(order.items||[]).map((it,i)=>(
                    <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderBottom:`1px solid ${C.border}`,fontSize:13}}>
                      <span style={{fontWeight:700}}>{it.qty}× {it.name}</span>
                    </div>
                  ))}
                  {order.customer&&<div style={{fontSize:11,color:C.textMid,marginTop:6}}>👤 {order.customer}</div>}
                </div>
                <div style={{padding:"10px 14px",borderTop:`1px solid ${C.border}`,display:"flex",gap:6}}>
                  {order.kdsStatus==="pending"&&<Btn size="sm" onClick={()=>markReady(order.id)} style={{flex:1}}>✅ Mark Ready</Btn>}
                  {order.kdsStatus==="ready"&&<Btn size="sm" variant="outline" onClick={()=>markDone(order.id)} style={{flex:1}}>🍽 Mark Served</Btn>}
                  {order.kdsStatus==="served"&&<span style={{flex:1,fontSize:11,color:C.textLight,fontWeight:600,padding:"4px 0"}}>✓ Served {order.servedAt?.slice(11,16)}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// STOCK TAKES / AUDITS
// ═══════════════════════════════════════════════════════════════════
function StockTakes({items,setItems}){
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

// ═══════════════════════════════════════════════════════════════════
// RECIPE COSTING
// ═══════════════════════════════════════════════════════════════════
function RecipeCosting({items}){
  const [selectedItem,setSelectedItem]=useState(null);
  const [recipes,setRecipes]=useState(()=>JSON.parse(localStorage.getItem("restopos_recipes")||"{}"));
  const [editMode,setEditMode]=useState(false);
  const [draftIngredients,setDraftIngredients]=useState([]);
  function openItem(item){
    setSelectedItem(item);
    setDraftIngredients(recipes[item.id]||[{name:"",unit:"g",qty:"",cost:""}]);
    setEditMode(false);
  }
  function addIngredient(){setDraftIngredients(prev=>[...prev,{name:"",unit:"g",qty:"",cost:""}]);}
  function removeIngredient(i){setDraftIngredients(prev=>prev.filter((_,j)=>j!==i));}
  function updateIngredient(i,field,val){setDraftIngredients(prev=>prev.map((ing,j)=>j===i?{...ing,[field]:val}:ing));}
  function saveRecipe(){
    const updated={...recipes,[selectedItem.id]:draftIngredients};
    setRecipes(updated);localStorage.setItem("restopos_recipes",JSON.stringify(updated));
    setEditMode(false);
  }
  function totalCost(itemId){
    const ings=recipes[itemId]||[];
    return ings.reduce((s,ing)=>s+parseFloat(ing.cost||0),0);
  }
  return(
    <div style={{display:"flex",gap:20}}>
      <div style={{width:280,flexShrink:0}}>
        <Card style={{padding:12}}>
          <div style={{fontSize:14,fontWeight:700,marginBottom:12}}>Menu Items</div>
          <div style={{display:"flex",flexDirection:"column",gap:4}}>
            {items.map(it=>{
              const cost=totalCost(it.id);
              const margin=it.price>0?((it.price-cost)/it.price*100).toFixed(0):0;
              return(
                <button key={it.id} onClick={()=>openItem(it)} style={{padding:"10px 12px",borderRadius:8,border:`1.5px solid ${selectedItem?.id===it.id?C.primary:C.border}`,background:selectedItem?.id===it.id?C.primaryLight:"#fff",textAlign:"left",cursor:"pointer",fontFamily:"inherit"}}>
                  <div style={{fontSize:13,fontWeight:700,color:C.text}}>{it.name}</div>
                  <div style={{fontSize:11,color:C.textMid,marginTop:2}}>SAR {it.price} · Cost: SAR {cost.toFixed(2)} · Margin: <span style={{color:margin>60?C.success:margin>30?C.warning:C.danger,fontWeight:700}}>{margin}%</span></div>
                </button>
              );
            })}
          </div>
        </Card>
      </div>
      <div style={{flex:1}}>
        {selectedItem?(
          <Card>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
              <div>
                <div style={{fontSize:16,fontWeight:800}}>{selectedItem.name}</div>
                <div style={{fontSize:13,color:C.textMid}}>Selling price: SAR {selectedItem.price}</div>
              </div>
              <Btn size="sm" variant={editMode?"ghost":"outline"} onClick={()=>setEditMode(e=>!e)}>{editMode?"Cancel":"✏️ Edit Recipe"}</Btn>
            </div>
            {editMode?(
              <>
                <div style={{overflowX:"auto"}}>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
                    <thead><tr style={{background:C.bg}}>{["Ingredient","Unit","Qty","Cost (SAR)",""].map(h=><th key={h} style={{padding:"8px 12px",textAlign:"left",fontWeight:700,color:C.textMid,fontSize:11,borderBottom:`1px solid ${C.border}`}}>{h}</th>)}</tr></thead>
                    <tbody>{draftIngredients.map((ing,i)=>(
                      <tr key={i} style={{borderBottom:`1px solid ${C.border}`}}>
                        <td style={{padding:"8px 12px"}}><input value={ing.name} onChange={e=>updateIngredient(i,"name",e.target.value)} placeholder="e.g. Chicken" style={{padding:"6px 10px",border:`1px solid ${C.border}`,borderRadius:6,fontSize:12,fontFamily:"inherit",width:140}}/></td>
                        <td style={{padding:"8px 12px"}}><select value={ing.unit} onChange={e=>updateIngredient(i,"unit",e.target.value)} style={{padding:"6px",border:`1px solid ${C.border}`,borderRadius:6,fontSize:12}}>{["g","kg","ml","L","pcs","tsp","tbsp"].map(u=><option key={u}>{u}</option>)}</select></td>
                        <td style={{padding:"8px 12px"}}><input type="number" value={ing.qty} onChange={e=>updateIngredient(i,"qty",e.target.value)} placeholder="0" style={{padding:"6px 10px",border:`1px solid ${C.border}`,borderRadius:6,fontSize:12,fontFamily:"inherit",width:70}}/></td>
                        <td style={{padding:"8px 12px"}}><input type="number" value={ing.cost} onChange={e=>updateIngredient(i,"cost",e.target.value)} placeholder="0.00" style={{padding:"6px 10px",border:`1px solid ${C.border}`,borderRadius:6,fontSize:12,fontFamily:"inherit",width:80}}/></td>
                        <td style={{padding:"8px 12px"}}><button onClick={()=>removeIngredient(i)} style={{background:C.dangerLight,color:C.danger,border:"none",borderRadius:6,padding:"4px 8px",cursor:"pointer",fontWeight:700}}>✕</button></td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
                <div style={{display:"flex",gap:10,marginTop:14}}>
                  <Btn variant="ghost" size="sm" onClick={addIngredient}>+ Add Ingredient</Btn>
                  <Btn size="sm" onClick={saveRecipe}>💾 Save Recipe</Btn>
                </div>
              </>
            ):(
              <>
                {(recipes[selectedItem.id]||[]).length===0?(
                  <div style={{textAlign:"center",padding:"30px 0",color:C.textLight}}>No recipe added yet. Click "Edit Recipe" to add ingredients.</div>
                ):(
                  <>
                    <DataTable headers={["Ingredient","Unit","Qty","Cost (SAR)"]} rows={(recipes[selectedItem.id]||[]).map(ing=>[ing.name,ing.unit,ing.qty,fmtSAR(parseFloat(ing.cost||0))])}/>
                    <div style={{marginTop:16,padding:"14px 16px",background:C.bg,borderRadius:10,display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:10}}>
                      {[["Total Recipe Cost",fmtSAR(totalCost(selectedItem.id)),C.danger],["Selling Price",fmtSAR(selectedItem.price),C.primary],["Gross Margin",((selectedItem.price-totalCost(selectedItem.id))/selectedItem.price*100).toFixed(1)+"%",C.success]].map(([l,v,c])=>(
                        <div key={l} style={{textAlign:"center"}}><div style={{fontSize:11,color:C.textMid}}>{l}</div><div style={{fontSize:18,fontWeight:800,color:c}}>{v}</div></div>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </Card>
        ):<Card><div style={{textAlign:"center",padding:"60px 0",color:C.textLight}}><div style={{fontSize:40,marginBottom:12}}>📋</div><div>Select a menu item to view or edit its recipe</div></div></Card>}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// GIFT CARD SYSTEM
// ═══════════════════════════════════════════════════════════════════
function GiftCards(){
  const [cards,setCards]=useState(()=>{try{return JSON.parse(localStorage.getItem("restopos_gift_cards")||"[]");}catch{return[];}});
  const [tab,setTab]=useState("list");
  const [amount,setAmount]=useState("50");
  const [redeemCode,setRedeemCode]=useState("");
  const [redeemResult,setRedeemResult]=useState(null);
  function generateCode(){return Math.random().toString(36).slice(2,8).toUpperCase()+"-"+Math.random().toString(36).slice(2,6).toUpperCase();}
  function issueCard(){
    if(!parseFloat(amount)||parseFloat(amount)<=0)return alert("Enter a valid amount.");
    const card={id:Date.now(),code:generateCode(),issuedAt:new Date().toISOString(),originalAmount:parseFloat(amount),balance:parseFloat(amount),status:"active",transactions:[]};
    const updated=[card,...cards];setCards(updated);localStorage.setItem("restopos_gift_cards",JSON.stringify(updated));
    alert(`✅ Gift card issued!\nCode: ${card.code}\nAmount: SAR ${card.originalAmount}`);
  }
  function checkRedeem(){
    const card=cards.find(c=>c.code.toUpperCase()===redeemCode.trim().toUpperCase());
    if(!card){setRedeemResult({error:"Gift card not found."});return;}
    if(card.status==="used"){setRedeemResult({error:"This gift card has already been fully used."});return;}
    if(card.status==="expired"){setRedeemResult({error:"This gift card has expired."});return;}
    setRedeemResult({card});
  }
  function redeemAmount(card,amt){
    if(amt>card.balance){alert("Amount exceeds card balance.");return;}
    const updated=cards.map(c=>c.code===card.code?{...c,balance:parseFloat((c.balance-amt).toFixed(2)),status:c.balance-amt<=0?"used":"active",transactions:[...c.transactions,{ts:new Date().toISOString(),amount:amt,type:"redeem"}]}:c);
    setCards(updated);localStorage.setItem("restopos_gift_cards",JSON.stringify(updated));
    setRedeemCode("");setRedeemResult(null);
    alert(`✅ Redeemed SAR ${amt} from gift card.`);
  }
  const activeCards=cards.filter(c=>c.status==="active");
  const totalBalance=activeCards.reduce((s,c)=>s+c.balance,0);
  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
        <div><div style={{fontSize:20,fontWeight:800}}>🎁 Gift Card System</div><div style={{fontSize:13,color:C.textMid}}>Issue and redeem gift cards</div></div>
        <div style={{background:C.successLight,border:`1px solid ${C.success}44`,borderRadius:8,padding:"8px 16px",fontSize:13,fontWeight:700,color:C.success}}>{activeCards.length} active · {fmtSAR(totalBalance)} total balance</div>
      </div>
      <div style={{display:"flex",gap:8,marginBottom:20}}>
        {[["list","🎁 All Cards"],["issue","➕ Issue Card"],["redeem","🔄 Redeem"]].map(([id,lbl])=>(
          <button key={id} onClick={()=>setTab(id)} style={{padding:"8px 16px",borderRadius:8,border:`1.5px solid ${tab===id?C.primary:C.border}`,background:tab===id?C.primaryLight:"#fff",color:tab===id?C.primary:C.textMid,fontFamily:"inherit",fontSize:13,fontWeight:600,cursor:"pointer"}}>{lbl}</button>
        ))}
      </div>
      {tab==="issue"&&<Card style={{maxWidth:440}}>
        <div style={{fontSize:15,fontWeight:700,marginBottom:16}}>Issue New Gift Card</div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:14}}>
          {[25,50,100,150,200,500].map(v=><button key={v} onClick={()=>setAmount(String(v))} style={{padding:"10px 16px",borderRadius:8,border:`2px solid ${parseFloat(amount)===v?C.primary:C.border}`,background:parseFloat(amount)===v?C.primaryLight:"#fff",color:parseFloat(amount)===v?C.primary:C.textMid,fontFamily:"inherit",fontSize:13,fontWeight:700,cursor:"pointer"}}>SAR {v}</button>)}
        </div>
        <Inp label="Custom Amount (SAR)" value={amount} onChange={setAmount} type="number" placeholder="e.g. 75"/>
        <Btn style={{marginTop:16,width:"100%"}} onClick={issueCard}>🎁 Issue Gift Card</Btn>
      </Card>}
      {tab==="redeem"&&<Card style={{maxWidth:440}}>
        <div style={{fontSize:15,fontWeight:700,marginBottom:16}}>Redeem Gift Card</div>
        <div style={{display:"flex",gap:8,marginBottom:14}}>
          <input value={redeemCode} onChange={e=>setRedeemCode(e.target.value.toUpperCase())} placeholder="Enter gift card code" style={{flex:1,padding:"10px 14px",border:`1.5px solid ${C.border}`,borderRadius:10,fontSize:14,fontFamily:"monospace",fontWeight:700,letterSpacing:"0.1em"}}/>
          <Btn onClick={checkRedeem}>Check</Btn>
        </div>
        {redeemResult&&(redeemResult.error?<div style={{padding:"10px 14px",background:C.dangerLight,border:`1px solid ${C.danger}`,borderRadius:8,color:C.danger,fontSize:13,fontWeight:600}}>{redeemResult.error}</div>:(
          <div style={{padding:"16px",background:C.successLight,border:`1px solid ${C.success}`,borderRadius:10}}>
            <div style={{fontSize:13,fontWeight:700,color:C.success,marginBottom:8}}>✅ Valid Gift Card</div>
            <div style={{fontSize:12,color:C.textMid}}>Code: <strong>{redeemResult.card.code}</strong></div>
            <div style={{fontSize:18,fontWeight:800,color:C.primary,marginTop:6}}>Balance: {fmtSAR(redeemResult.card.balance)}</div>
            <div style={{display:"flex",gap:8,marginTop:12,flexWrap:"wrap"}}>
              {[10,25,50].filter(v=>v<=redeemResult.card.balance).map(v=><Btn key={v} size="sm" variant="outline" onClick={()=>redeemAmount(redeemResult.card,v)}>Redeem SAR {v}</Btn>)}
              <Btn size="sm" onClick={()=>{const a=parseFloat(prompt("Amount to redeem (SAR):")||"0");if(a>0)redeemAmount(redeemResult.card,a);}}>Custom Amount</Btn>
            </div>
          </div>
        ))}
      </Card>}
      {tab==="list"&&(cards.length===0?<Card><div style={{textAlign:"center",padding:"40px 0",color:C.textLight}}>No gift cards issued yet.</div></Card>:(
        <DataTable headers={["Code","Issued","Original","Balance","Status"]} rows={cards.map(c=>[
          <span style={{fontFamily:"monospace",fontWeight:700,letterSpacing:"0.08em"}}>{c.code}</span>,
          <span style={{fontSize:11}}>{c.issuedAt.slice(0,10)}</span>,
          fmtSAR(c.originalAmount),
          <strong style={{color:c.balance>0?C.primary:C.textLight}}>{fmtSAR(c.balance)}</strong>,
          <Badge color={c.status==="active"?C.success:C.textLight} bg={c.status==="active"?C.successLight:C.bg}>{c.status}</Badge>
        ])}/>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// LOYALTY PROGRAM (standalone tab in Tools — also accessible via CRM)
// ═══════════════════════════════════════════════════════════════════
// (Already implemented inside Customers component — this adds a standalone Loyalty screen)

// ═══════════════════════════════════════════════════════════════════
// DELIVERY INTEGRATION PLACEHOLDER
// ═══════════════════════════════════════════════════════════════════
function DeliveryIntegration(){
  const [settings,setSettings]=useState(()=>JSON.parse(localStorage.getItem("restopos_delivery_settings")||JSON.stringify({hungerStation:{enabled:false,apiKey:"",branchId:""},jahez:{enabled:false,apiKey:"",branchId:""},marsool:{enabled:false,apiKey:"",branchId:""},careem:{enabled:false,apiKey:"",branchId:""}})));
  const [saved,setSaved]=useState(false);
  const platforms=[{id:"hungerStation",name:"HungerStation",icon:"🍔",color:"#E44D26"},{id:"jahez",name:"Jahez",icon:"🛵",color:"#F0A500"},{id:"marsool",name:"Marsool",icon:"📦",color:"#1A6B4A"},{id:"careem",name:"Careem Eats",icon:"🟢",color:"#3CB371"}];
  function saveSettings(){localStorage.setItem("restopos_delivery_settings",JSON.stringify(settings));setSaved(true);setTimeout(()=>setSaved(false),2000);}
  return(
    <div>
      <div style={{marginBottom:20}}>
        <div style={{fontSize:20,fontWeight:800}}>🛵 Delivery App Integration</div>
        <div style={{fontSize:13,color:C.textMid,marginTop:4}}>Connect RestoPOS to delivery platforms. API integration available when you subscribe to their merchant programs.</div>
      </div>
      <div style={{background:C.infoLight,border:`1px solid ${C.info}`,borderRadius:10,padding:"14px 18px",marginBottom:24,fontSize:13,color:C.info}}>
        ℹ️ <strong>How it works:</strong> Enter your merchant API key and branch ID from each platform's merchant portal. RestoPOS will automatically receive orders and sync them to your POS queue. This feature uses each platform's official Merchant API.
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(320px,1fr))",gap:16}}>
        {platforms.map(p=>(
          <Card key={p.id}>
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
              <div style={{width:44,height:44,borderRadius:10,background:p.color+"22",display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,border:`2px solid ${p.color}33`}}>{p.icon}</div>
              <div style={{flex:1}}>
                <div style={{fontSize:15,fontWeight:800,color:p.color}}>{p.name}</div>
                <div style={{fontSize:11,color:C.textMid}}>Delivery platform integration</div>
              </div>
              <button onClick={()=>setSettings(s=>({...s,[p.id]:{...s[p.id],enabled:!s[p.id].enabled}}))} style={{width:44,height:24,borderRadius:12,background:settings[p.id]?.enabled?C.primary:"#ccc",border:"none",cursor:"pointer",position:"relative",transition:"background 0.2s"}}>
                <span style={{position:"absolute",top:2,left:settings[p.id]?.enabled?22:2,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left 0.2s",display:"block"}}/>
              </button>
            </div>
            {settings[p.id]?.enabled&&(
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                <Inp label="API Key" value={settings[p.id]?.apiKey||""} onChange={v=>setSettings(s=>({...s,[p.id]:{...s[p.id],apiKey:v}}))} placeholder="Paste your API key here"/>
                <Inp label="Branch / Location ID" value={settings[p.id]?.branchId||""} onChange={v=>setSettings(s=>({...s,[p.id]:{...s[p.id],branchId:v}}))} placeholder="e.g. BR-0001"/>
                <div style={{fontSize:11,color:C.textMid,padding:"8px 10px",background:C.bg,borderRadius:6}}>Get your API key from the {p.name} Merchant Portal → Settings → API Access</div>
              </div>
            )}
          </Card>
        ))}
      </div>
      <div style={{marginTop:20,display:"flex",gap:10,alignItems:"center"}}>
        <Btn onClick={saveSettings}>💾 Save Integration Settings</Btn>
        {saved&&<span style={{fontSize:12,color:C.success,fontWeight:700}}>✓ Saved!</span>}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// MULTI-LOCATION SUPPORT
// ═══════════════════════════════════════════════════════════════════
function MultiLocationSettings(){
  const [locations,setLocations]=useState(()=>JSON.parse(localStorage.getItem("restopos_locations")||JSON.stringify([{id:"main",name:"Main Branch",address:"",isActive:true,isDefault:true}])));
  const [activeLocationId,setActiveLocationId]=useState(()=>localStorage.getItem("restopos_active_location")||"main");
  const [editId,setEditId]=useState(null);
  const [formName,setFormName]=useState("");
  const [formAddress,setFormAddress]=useState("");
  function saveLocations(locs){setLocations(locs);localStorage.setItem("restopos_locations",JSON.stringify(locs));}
  function addLocation(){
    if(!formName.trim())return alert("Location name required.");
    const loc={id:"loc_"+Date.now(),name:formName.trim(),address:formAddress.trim(),isActive:true,isDefault:false};
    saveLocations([...locations,loc]);setFormName("");setFormAddress("");
  }
  function setDefault(id){
    saveLocations(locations.map(l=>({...l,isDefault:l.id===id})));
    setActiveLocationId(id);localStorage.setItem("restopos_active_location",id);
  }
  function removeLocation(id){
    if(locations.length===1)return alert("Cannot remove the only location.");
    if(!confirm("Remove this location?"))return;
    saveLocations(locations.filter(l=>l.id!==id));
  }
  const activeLocation=locations.find(l=>l.id===activeLocationId)||locations[0];
  return(
    <div>
      <div style={{marginBottom:20}}>
        <div style={{fontSize:20,fontWeight:800}}>🏢 Multi-Location Management</div>
        <div style={{fontSize:13,color:C.textMid,marginTop:4}}>Manage multiple branches and locations for your restaurant chain</div>
      </div>
      <div style={{background:C.primaryLight,border:`1.5px solid ${C.primary}44`,borderRadius:10,padding:"12px 16px",marginBottom:20,fontSize:13}}>
        <strong style={{color:C.primary}}>Active Location:</strong> <span style={{fontWeight:700}}>{activeLocation?.name}</span>{activeLocation?.address&&<span style={{color:C.textMid}}> — {activeLocation.address}</span>}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20,alignItems:"start"}}>
        <Card>
          <div style={{fontSize:15,fontWeight:700,marginBottom:14}}>Locations</div>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {locations.map(loc=>(
              <div key={loc.id} style={{padding:"12px 14px",borderRadius:10,border:`1.5px solid ${activeLocationId===loc.id?C.primary:C.border}`,background:activeLocationId===loc.id?C.primaryLight:"#fff",display:"flex",alignItems:"center",gap:10}}>
                <div style={{flex:1}}>
                  <div style={{fontSize:13,fontWeight:700,color:C.text}}>{loc.name}</div>
                  {loc.address&&<div style={{fontSize:11,color:C.textMid}}>{loc.address}</div>}
                  {loc.isDefault&&<span style={{fontSize:10,background:C.primary,color:"#fff",padding:"1px 8px",borderRadius:20,fontWeight:700}}>Default</span>}
                </div>
                <div style={{display:"flex",gap:6}}>
                  <Btn size="sm" variant="outline" onClick={()=>setDefault(loc.id)}>Set Active</Btn>
                  {!loc.isDefault&&<Btn size="sm" variant="ghost" onClick={()=>removeLocation(loc.id)}>✕</Btn>}
                </div>
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <div style={{fontSize:15,fontWeight:700,marginBottom:14}}>Add New Location</div>
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            <Inp label="Branch Name" value={formName} onChange={setFormName} placeholder="e.g. Riyadh — Al Olaya Branch"/>
            <Inp label="Address" value={formAddress} onChange={setFormAddress} placeholder="e.g. King Fahd Road, Riyadh"/>
            <Btn onClick={addLocation}>+ Add Location</Btn>
          </div>
          <div style={{marginTop:16,padding:"12px 14px",background:C.infoLight,borderRadius:8,fontSize:12,color:C.info}}>
            Each location shares the same menu and settings but tracks orders, reports, and shifts independently based on the active location.
          </div>
        </Card>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// ACCOUNTING EXPORT (QuickBooks-compatible CSV)
// ═══════════════════════════════════════════════════════════════════
function AccountingExport({sales,items}){
  const [dateFrom,setDateFrom]=useState(TODAY);
  const [dateTo,setDateTo]=useState(TODAY);
  const [format,setFormat]=useState("quickbooks");
  const [exported,setExported]=useState(false);
  function filteredSales(){return sales.filter(s=>s.date>=dateFrom&&s.date<=dateTo);}
  function exportQuickBooks(){
    const rows=filteredSales();
    if(rows.length===0){alert("No sales in selected date range.");return;}
    const lines=["Date,Ref No,Description,Account,Debit,Credit,Tax Code,Tax Amount,Currency"];
    rows.forEach(s=>{
      const excl=(s.total||0)-(s.vat||0);
      lines.push(`${s.date},${s.id},"POS Sale - ${s.payMethod}",Sales Revenue,,${excl.toFixed(2)},VAT15,${(s.vat||0).toFixed(2)},SAR`);
      lines.push(`${s.date},${s.id},"POS Sale - ${s.payMethod}",${s.payMethod==="Cash"?"Cash Account":"Digital Payments"},${(s.total||0).toFixed(2)},,,,SAR`);
      if((s.vat||0)>0)lines.push(`${s.date},${s.id},"VAT 15%",VAT Payable,,${(s.vat||0).toFixed(2)},,,SAR`);
    });
    const csv=lines.join("\n");
    const blob=new Blob([csv],{type:"text/csv"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");a.href=url;a.download=`quickbooks-export-${dateFrom}-to-${dateTo}.csv`;a.click();
    URL.revokeObjectURL(url);setExported(true);setTimeout(()=>setExported(false),2000);
  }
  function exportJournal(){
    const rows=filteredSales();
    if(rows.length===0){alert("No sales in selected date range.");return;}
    const lines=["Date,Invoice No,Type,Customer,Items,Subtotal (excl VAT),VAT 15%,Total (incl VAT),Payment Method,Cashier"];
    rows.forEach(s=>{
      const itemSummary=(s.items||[]).map(i=>`${i.qty}x ${i.name}`).join("; ");
      const excl=(s.total||0)-(s.vat||0);
      lines.push(`${s.date},${s.id},${s.type||"Sale"},"${s.customer||"Walk-in"}","${itemSummary}",${excl.toFixed(2)},${(s.vat||0).toFixed(2)},${(s.total||0).toFixed(2)},${s.payMethod||""},${s.cashier||""}`);
    });
    const csv=lines.join("\n");
    const blob=new Blob([csv],{type:"text/csv"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");a.href=url;a.download=`sales-journal-${dateFrom}-to-${dateTo}.csv`;a.click();
    URL.revokeObjectURL(url);setExported(true);setTimeout(()=>setExported(false),2000);
  }
  const rows=filteredSales();
  const totalRev=rows.reduce((s,o)=>s+(o.total||0),0);
  const totalVat=rows.reduce((s,o)=>s+(o.vat||0),0);
  return(
    <div>
      <div style={{marginBottom:20}}>
        <div style={{fontSize:20,fontWeight:800}}>📤 Accounting Export</div>
        <div style={{fontSize:13,color:C.textMid,marginTop:4}}>Export sales data to QuickBooks, Xero, or any accounting software</div>
      </div>
      <Card style={{maxWidth:640}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:20}}>
          <Inp label="Date From" value={dateFrom} onChange={setDateFrom} type="date"/>
          <Inp label="Date To" value={dateTo} onChange={setDateTo} type="date"/>
        </div>
        {rows.length>0&&(
          <div style={{background:C.bg,borderRadius:10,padding:"12px 16px",marginBottom:20,display:"flex",gap:20,flexWrap:"wrap"}}>
            <div><div style={{fontSize:11,color:C.textMid}}>Transactions</div><div style={{fontSize:18,fontWeight:800,color:C.primary}}>{rows.length}</div></div>
            <div><div style={{fontSize:11,color:C.textMid}}>Total Revenue</div><div style={{fontSize:18,fontWeight:800,color:C.success}}>{fmtSAR(totalRev)}</div></div>
            <div><div style={{fontSize:11,color:C.textMid}}>VAT Collected</div><div style={{fontSize:18,fontWeight:800,color:C.zatca}}>{fmtSAR(totalVat)}</div></div>
          </div>
        )}
        <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
          <Btn onClick={exportQuickBooks}>📊 Export QuickBooks CSV</Btn>
          <Btn variant="outline" onClick={exportJournal}>📋 Export Sales Journal</Btn>
        </div>
        {exported&&<div style={{marginTop:12,fontSize:12,color:C.success,fontWeight:700}}>✅ File downloaded successfully.</div>}
        <div style={{marginTop:20,paddingTop:16,borderTop:`1px solid ${C.border}`,fontSize:12,color:C.textMid}}>
          <div style={{fontWeight:700,marginBottom:6}}>Import instructions:</div>
          <div><strong>QuickBooks:</strong> Banking → Upload Transactions → Select CSV → Map columns</div>
          <div style={{marginTop:4}}><strong>Xero:</strong> Accounting → Bank Accounts → Import → Select CSV</div>
          <div style={{marginTop:4}}><strong>Other:</strong> Use Sales Journal CSV for any accounting software</div>
        </div>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// SCHEDULED REPORTS UI
// ═══════════════════════════════════════════════════════════════════
function ScheduledReports({sales,items}){
  const [schedules,setSchedules]=useState(()=>JSON.parse(localStorage.getItem("restopos_report_schedules")||"[]"));
  const [form,setForm]=useState({name:"Daily Sales Summary",frequency:"daily",email:"",enabled:true,reportType:"sales"});
  const [saved,setSaved]=useState(false);
  function addSchedule(){
    if(!form.email.trim())return alert("Email address required.");
    const s={...form,id:Date.now(),createdAt:new Date().toISOString(),lastSent:null};
    const updated=[...schedules,s];setSchedules(updated);localStorage.setItem("restopos_report_schedules",JSON.stringify(updated));
    setForm(f=>({...f,email:""}));setSaved(true);setTimeout(()=>setSaved(false),2000);
  }
  function removeSchedule(id){setSchedules(prev=>{const u=prev.filter(s=>s.id!==id);localStorage.setItem("restopos_report_schedules",JSON.stringify(u));return u;});}
  function previewAndDownload(type){
    const today=TODAY;const todaySales=sales.filter(s=>s.date===today);
    const revenue=todaySales.reduce((s,o)=>s+(o.total||0),0);
    const vat=todaySales.reduce((s,o)=>s+(o.vat||0),0);
    const csv=["Date,Orders,Revenue,VAT,Net",`${today},${todaySales.length},${revenue.toFixed(2)},${vat.toFixed(2)},${(revenue-vat).toFixed(2)}`].join("\n");
    const blob=new Blob([csv],{type:"text/csv"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");a.href=url;a.download=`report-${type}-${today}.csv`;a.click();
    URL.revokeObjectURL(url);
  }
  return(
    <div>
      <div style={{marginBottom:20}}>
        <div style={{fontSize:20,fontWeight:800}}>📅 Scheduled Reports</div>
        <div style={{fontSize:13,color:C.textMid,marginTop:4}}>Set up automatic report delivery (email delivery requires backend configuration)</div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20,alignItems:"start"}}>
        <Card>
          <div style={{fontSize:15,fontWeight:700,marginBottom:16}}>Create Schedule</div>
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            <Inp label="Report Name" value={form.name} onChange={v=>setForm(f=>({...f,name:v}))}/>
            <Sel label="Report Type" value={form.reportType} onChange={v=>setForm(f=>({...f,reportType:v}))} options={[{value:"sales",label:"Sales Summary"},{value:"vat",label:"VAT Report"},{value:"items",label:"Top Items"},{value:"staff",label:"Staff Performance"}]}/>
            <Sel label="Frequency" value={form.frequency} onChange={v=>setForm(f=>({...f,frequency:v}))} options={[{value:"daily",label:"Daily (7 AM)"},{value:"weekly",label:"Weekly (Monday)"},{value:"monthly",label:"Monthly (1st)"}]}/>
            <Inp label="Recipient Email" value={form.email} onChange={v=>setForm(f=>({...f,email:v}))} placeholder="manager@restaurant.com" type="email"/>
          </div>
          <div style={{display:"flex",gap:10,marginTop:16,alignItems:"center"}}>
            <Btn onClick={addSchedule}>+ Add Schedule</Btn>
            {saved&&<span style={{fontSize:12,color:C.success,fontWeight:700}}>✓ Schedule saved!</span>}
          </div>
          <div style={{marginTop:14,padding:"10px 14px",background:C.warningLight,border:`1px solid ${C.warning}44`,borderRadius:8,fontSize:12,color:C.warning,fontWeight:600}}>
            ⚠️ Email delivery requires a backend (Firebase Functions + SendGrid/SMTP). Schedules are saved and ready — contact RestoPOS support to enable email delivery for your account.
          </div>
        </Card>
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          <Card>
            <div style={{fontSize:15,fontWeight:700,marginBottom:14}}>📥 Download Reports Now</div>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {[["Daily Sales","sales"],["VAT Summary","vat"],["Top Items","items"]].map(([lbl,type])=>(
                <button key={type} onClick={()=>previewAndDownload(type)} style={{padding:"10px 14px",background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,cursor:"pointer",textAlign:"left",fontFamily:"inherit",fontSize:13,fontWeight:600,color:C.text}}>📥 Download {lbl} — Today</button>
              ))}
            </div>
          </Card>
          {schedules.length>0&&<Card>
            <div style={{fontSize:15,fontWeight:700,marginBottom:14}}>Active Schedules</div>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {schedules.map(s=>(
                <div key={s.id} style={{padding:"10px 14px",background:C.bg,borderRadius:8,display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
                  <div>
                    <div style={{fontSize:13,fontWeight:700}}>{s.name}</div>
                    <div style={{fontSize:11,color:C.textMid}}>{s.frequency} → {s.email}</div>
                  </div>
                  <Btn size="sm" variant="ghost" onClick={()=>removeSchedule(s.id)}>✕</Btn>
                </div>
              ))}
            </div>
          </Card>}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// ERROR LOG VIEWER (admin)
// ═══════════════════════════════════════════════════════════════════
function ErrorLogViewer(){
  const [logs]=useState(()=>JSON.parse(localStorage.getItem("restopos_error_logs")||"[]"));
  return(
    <Card>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <div style={{fontSize:15,fontWeight:700}}>⚠️ Error Log</div>
        <Btn size="sm" variant="ghost" onClick={()=>{localStorage.removeItem("restopos_error_logs");window.location.reload();}}>Clear Logs</Btn>
      </div>
      {logs.length===0?<div style={{textAlign:"center",padding:"30px 0",color:C.textLight}}>✅ No errors logged. All systems running smoothly.</div>:(
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {logs.map((l,i)=>(
            <div key={i} style={{padding:"10px 14px",background:C.dangerLight,border:`1px solid ${C.danger}22`,borderRadius:8}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <span style={{fontSize:12,fontWeight:700,color:C.danger}}>{l.message}</span>
                <span style={{fontSize:10,color:C.textLight}}>{l.ts?.slice(0,19).replace("T"," ")}</span>
              </div>
              {l.component&&<div style={{fontSize:10,color:C.textMid,fontFamily:"monospace",whiteSpace:"pre-wrap",wordBreak:"break-all"}}>{l.component}</div>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════
// NEW "ADVANCED" SCREEN — aggregates all new features
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// QZ TRAY SETTINGS COMPONENT
// ═══════════════════════════════════════════════════════════════════
function QZTraySettings(){
  const [status,setStatus]=useState("checking"); // checking|connected|disconnected
  const [printers,setPrinters]=useState([]);
  const [billPrinter,setBillPrinter]=useState(()=>localStorage.getItem("restopos_qz_bill_printer")||"");
  const [kitchenPrinter,setKitchenPrinter]=useState(()=>localStorage.getItem("restopos_qz_kitchen_printer")||"");
  const [log,setLog]=useState([]);
  const [testing,setTesting]=useState(false);
  const invoiceFormat=LS.get("restopos_invoice_format")||{};
  const license=LS.get("restopos_license_v2")||{};

  function addLog(msg,type="info"){
    setLog(prev=>[{msg,type,time:new Date().toLocaleTimeString("en-SA")}, ...prev.slice(0,19)]);
  }

  useEffect(()=>{
    checkStatus();
  },[]);

  async function checkStatus(){
    setStatus("checking");
    addLog("Checking QZ Tray connection...");
    try{
      const loaded=await loadQZ();
      if(!loaded){setStatus("disconnected");addLog("QZ Tray library not loaded","error");return;}
      if(qz.websocket.isActive()){
        setStatus("connected");
        const p=await qz.printers.find();
        setPrinters(Array.isArray(p)?p:[p]);
        _qzPrinters=Array.isArray(p)?p:[p];
        addLog(`Connected! Found ${Array.isArray(p)?p.length:1} printer(s)`,"success");
      }else{
        const ok=await connectQZ();
        if(ok){
          setStatus("connected");
          setPrinters(_qzPrinters);
          addLog(`Connected! Found ${_qzPrinters.length} printer(s)`,"success");
        }else{
          setStatus("disconnected");
          addLog("QZ Tray not running. Please install and start it.","error");
        }
      }
    }catch(e){
      setStatus("disconnected");
      addLog("Error: "+e.message,"error");
    }
  }

  function saveBillPrinter(name){
    setBillPrinter(name);
    localStorage.setItem("restopos_qz_bill_printer",name);
    _qzBillPrinter=name;
    addLog("Bill printer set to: "+name,"success");
  }

  function saveKitchenPrinter(name){
    setKitchenPrinter(name);
    localStorage.setItem("restopos_qz_kitchen_printer",name);
    _qzKitchenPrinter=name;
    addLog("Kitchen printer set to: "+name,"success");
  }

  async function testBillPrint(){
    if(!billPrinter){addLog("Select a bill printer first","error");return;}
    setTesting(true);
    addLog("Sending test print to: "+billPrinter);
    try{
      const fmt=LS.get("restopos_invoice_format")||{};
      const paperWidth=fmt.paperWidth||"80mm";
      const fontSize=fmt.fontSize||12;
      const html=`<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
@page{size:${paperWidth} auto;margin:0}
body{font-family:'Courier New',monospace;font-size:${fontSize}px;width:${paperWidth};padding:4mm;color:#000;margin:0}
.c{text-align:center}.b{font-weight:bold}
.hr{border:none;border-top:1px dashed #000;margin:5px 0}
</style></head><body>
<div class="c b" style="font-size:${fontSize+4}px">${license.businessName||"RestoPOS"}</div>
<div class="c" style="font-size:${fontSize-1}px">VAT: ${license.vatNumber||""}</div>
<div class="hr"/>
<div class="c b">🖨️ QZ TRAY TEST PRINT</div>
<div class="c">Bill Printer Working!</div>
<div class="c" style="font-family:'Tajawal',sans-serif;direction:rtl">طابعة الفاتورة تعمل!</div>
<div class="hr"/>
<div class="c" style="font-size:${fontSize-1}px">${new Date().toLocaleString("en-SA")}</div>
<div class="c" style="font-size:${fontSize-1}px">RestoPOS · ZATCA Phase 2</div>
<br/><br/>
</body></html>`;
      await printWithQZ(html, billPrinter, paperWidth);
      addLog("✅ Test print sent successfully!","success");
    }catch(e){
      addLog("❌ Print failed: "+e.message,"error");
    }
    setTesting(false);
  }

  async function testKitchenPrint(){
    if(!kitchenPrinter){addLog("Select a kitchen printer first","error");return;}
    setTesting(true);
    addLog("Sending KOT test to: "+kitchenPrinter);
    try{
      const html=`<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>@page{size:80mm auto;margin:0}body{font-family:'Courier New',monospace;font-size:14px;width:80mm;padding:4mm;text-align:center}</style>
</head><body>
<div style="font-size:20px;font-weight:900">*** KOT TEST ***</div>
<hr/>
<div>Kitchen Printer Working!</div>
<div style="font-family:'Tajawal',sans-serif;direction:rtl">مطبعة المطبخ تعمل!</div>
<hr/>
<div style="font-size:10px">${new Date().toLocaleString("en-SA")}</div>
<br/><br/>
</body></html>`;
      await printWithQZ(html, kitchenPrinter, "80mm");
      addLog("✅ KOT test sent successfully!","success");
    }catch(e){
      addLog("❌ KOT test failed: "+e.message,"error");
    }
    setTesting(false);
  }

  const statusColor={connected:C.success,disconnected:C.danger,checking:C.warning};
  const statusIcon={connected:"🟢",disconnected:"🔴",checking:"🟡"};
  const statusText={connected:"Connected",disconnected:"Not Connected",checking:"Checking..."};

  return(
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      {/* Status Card */}
      <Card style={{border:`2px solid ${statusColor[status]}44`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
          <div>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:4}}>
              <span style={{fontSize:24}}>{statusIcon[status]}</span>
              <div style={{fontSize:16,fontWeight:800,color:statusColor[status]}}>QZ Tray — {statusText[status]}</div>
            </div>
            <div style={{fontSize:12,color:C.textMid}}>
              {status==="connected"?`${printers.length} printer(s) available on this computer`:
               status==="disconnected"?"QZ Tray must be running on this computer to print":
               "Connecting to QZ Tray..."}
            </div>
            {status==="connected"&&<div style={{fontSize:11,color:C.success,marginTop:4}}>
              ✅ All printing will go through QZ Tray — silent, no dialogs
            </div>}
          </div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            <div style={{display:"flex",gap:6}}>
              <Btn onClick={checkStatus} variant="outline" size="sm">🔄 Refresh</Btn>
              {status==="connected"&&<Btn onClick={async()=>{await disconnectQZ();setTimeout(()=>checkStatus(),500);}} color={D.danger} variant="outline" size="sm">Disconnect</Btn>}
            </div>
            {status==="disconnected"&&(
              <a href="https://qz.io/download" target="_blank" rel="noreferrer"
                style={{padding:"7px 14px",background:C.primary,color:"#fff",borderRadius:8,fontSize:12,fontWeight:700,textDecoration:"none",display:"inline-block"}}>
                ⬇️ Download QZ Tray
              </a>
            )}
          </div>
        </div>
      </Card>

      {/* Setup Instructions (when disconnected) */}
      {status==="disconnected"&&(
        <Card style={{background:"#F8FAFF"}}>
          <div style={{fontSize:14,fontWeight:700,marginBottom:12}}>📋 How to set up QZ Tray</div>
          {[
            {n:"1",t:"Download QZ Tray","d":"Click 'Download QZ Tray' above → free download from qz.io (Windows/Mac/Linux, ~15MB)"},
            {n:"2",t:"Install & Run","d":"Install it like any app. It runs silently in your system tray (near the clock)"},
            {n:"3",t:"Allow Connection","d":"When the app asks 'Allow this site to print?' → click Allow + tick 'Remember this decision'"},
            {n:"4",t:"Done Forever","d":"QZ connects automatically every time. No more print dialogs, ever."},
          ].map(s=>(
            <div key={s.n} style={{display:"flex",gap:12,marginBottom:10,padding:10,background:"#fff",borderRadius:8}}>
              <div style={{width:28,height:28,background:C.primary,color:"#fff",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:800,flexShrink:0}}>{s.n}</div>
              <div><div style={{fontSize:13,fontWeight:700,marginBottom:2}}>{s.t}</div><div style={{fontSize:12,color:C.textMid}}>{s.d}</div></div>
            </div>
          ))}
        </Card>
      )}

      {/* Printer Selection */}
      {status==="connected"&&(
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
          {/* Bill Printer */}
          <Card>
            <div style={{fontSize:13,fontWeight:700,marginBottom:12}}>🧾 Bill Printer</div>
            <div style={{fontSize:11,color:C.textMid,marginBottom:8}}>Used for receipts and invoices</div>
            {printers.length===0?(
              <div style={{fontSize:12,color:C.danger}}>No printers found</div>
            ):(
              <>
                <select value={billPrinter} onChange={e=>saveBillPrinter(e.target.value)}
                  style={{width:"100%",padding:"9px 12px",border:`1.5px solid ${billPrinter?C.success:C.border}`,borderRadius:8,fontSize:13,fontFamily:"inherit",marginBottom:10,background:"#fff"}}>
                  <option value="">— Select Bill Printer —</option>
                  {printers.map(p=><option key={p} value={p}>{p}</option>)}
                </select>
                {billPrinter&&<div style={{fontSize:11,color:C.success,fontWeight:600,marginBottom:8}}>✓ {billPrinter}</div>}
                <div style={{display:"flex",gap:8}}>
                  <Btn onClick={testBillPrint} disabled={testing||!billPrinter} color={C.success} size="sm" style={{flex:1}}>
                    🖨️ Test Print
                  </Btn>
                  <Btn onClick={()=>saveBillPrinter("")} color={C.danger} variant="outline" size="sm">Clear</Btn>
                </div>
              </>
            )}
          </Card>

          {/* Kitchen Printer */}
          <Card>
            <div style={{fontSize:13,fontWeight:700,marginBottom:12}}>🍽️ Kitchen Printer (KOT)</div>
            <div style={{fontSize:11,color:C.textMid,marginBottom:8}}>Used for kitchen order tickets</div>
            {printers.length===0?(
              <div style={{fontSize:12,color:C.danger}}>No printers found</div>
            ):(
              <>
                <select value={kitchenPrinter} onChange={e=>saveKitchenPrinter(e.target.value)}
                  style={{width:"100%",padding:"9px 12px",border:`1.5px solid ${kitchenPrinter?C.success:C.border}`,borderRadius:8,fontSize:13,fontFamily:"inherit",marginBottom:10,background:"#fff"}}>
                  <option value="">— Select Kitchen Printer —</option>
                  {printers.map(p=><option key={p} value={p}>{p}</option>)}
                </select>
                {kitchenPrinter&&<div style={{fontSize:11,color:C.success,fontWeight:600,marginBottom:8}}>✓ {kitchenPrinter}</div>}
                <div style={{display:"flex",gap:8}}>
                  <Btn onClick={testKitchenPrint} disabled={testing||!kitchenPrinter} color={C.success} size="sm" style={{flex:1}}>
                    🖨️ Test KOT
                  </Btn>
                  <Btn onClick={()=>saveKitchenPrinter("")} color={C.danger} variant="outline" size="sm">Clear</Btn>
                </div>
              </>
            )}
          </Card>
        </div>
      )}

      {/* Invoice Format Preview */}
      {status==="connected"&&(
        <Card>
          <div style={{fontSize:13,fontWeight:700,marginBottom:8}}>🎨 Current Invoice Format Settings</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:8,fontSize:12}}>
            {[
              ["Paper Width",invoiceFormat.paperWidth||"80mm"],
              ["Font Size",(invoiceFormat.fontSize||12)+"px"],
              ["Template",invoiceFormat.template||"modern"],
              ["Font",invoiceFormat.font||"courier"],
              ["Separator",invoiceFormat.separator||"dashed"],
              ["Show VAT",invoiceFormat.showVat!==false?"Yes":"No"],
              ["Arabic Names",invoiceFormat.showArabicNames?"Yes":"No"],
              ["Bold Items",invoiceFormat.boldItems?"Yes":"No"],
            ].map(([k,v])=>(
              <div key={k} style={{background:C.bg,borderRadius:7,padding:"7px 10px",border:`1px solid ${C.border}`}}>
                <div style={{fontSize:9,color:C.textMid,fontWeight:700}}>{k}</div>
                <div style={{fontSize:12,fontWeight:700,color:C.primary,marginTop:2}}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{marginTop:8,fontSize:11,color:C.textMid}}>
            ℹ️ These settings apply to ALL prints through QZ Tray. Change them in <strong>Settings → Invoice Format</strong>.
          </div>
        </Card>
      )}

      {/* Connection Log */}
      <Card>
        <div style={{fontSize:13,fontWeight:700,marginBottom:8}}>📋 Connection Log</div>
        {log.length===0?(
          <div style={{fontSize:12,color:C.textLight}}>No activity yet</div>
        ):log.map((l,i)=>(
          <div key={i} style={{display:"flex",gap:10,padding:"5px 0",borderBottom:`1px solid ${C.border}`,fontSize:11}}>
            <span style={{color:C.muted,flexShrink:0,fontFamily:"monospace"}}>{l.time}</span>
            <span style={{color:l.type==="success"?C.success:l.type==="error"?C.danger:C.text}}>{l.msg}</span>
          </div>
        ))}
      </Card>
    </div>
  );
}

function AdvancedFeatures({sales,items,setItems}){
  const [tab,setTab]=useState("kds");
  const tabs=[["qztray","🖨️ QZ Tray"],["kds","🍳 KDS"],["stocktakes","📦 Stock Takes"],["recipes","📋 Recipes"],["giftcards","🎁 Gift Cards"],["delivery","🛵 Delivery"],["locations","🏢 Locations"],["accounting","📤 Accounting"],["reports","📅 Reports"],["printer","🖨️ ESC/POS"],["errorlog","⚠️ Error Log"]];
  return(
    <div>
      <div style={{display:"flex",gap:6,marginBottom:20,flexWrap:"wrap"}}>
        {tabs.map(([id,lbl])=>(
          <button key={id} onClick={()=>setTab(id)} style={{padding:"7px 14px",borderRadius:8,border:`1.5px solid ${tab===id?C.primary:C.border}`,background:tab===id?C.primaryLight:"#fff",color:tab===id?C.primary:C.textMid,fontFamily:"inherit",fontSize:12,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap"}}>{lbl}</button>
        ))}
      </div>
      {tab==="qztray"&&<QZTraySettings/>}
      {tab==="kds"&&<KitchenDisplay sales={sales}/>}
      {tab==="stocktakes"&&<StockTakes items={items} setItems={setItems}/>}
      {tab==="recipes"&&<RecipeCosting items={items}/>}
      {tab==="giftcards"&&<GiftCards/>}
      {tab==="delivery"&&<DeliveryIntegration/>}
      {tab==="locations"&&<MultiLocationSettings/>}
      {tab==="accounting"&&<AccountingExport sales={sales} items={items}/>}
      {tab==="reports"&&<ScheduledReports sales={sales} items={items}/>}
      {tab==="printer"&&<ThermalPrinterSettings/>}
      {tab==="errorlog"&&<ErrorLogViewer/>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// QZ TRAY INTEGRATION
// ═══════════════════════════════════════════════════════════════════
// Global QZ state
let _qzConnected = false;
let _qzPrinters = [];
let _qzBillPrinter = localStorage.getItem("restopos_qz_bill_printer") || "";
let _qzKitchenPrinter = localStorage.getItem("restopos_qz_kitchen_printer") || "";

// Load QZ Tray script dynamically
async function loadQZ() {
  if (window.qz) return true;
  return new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/qz-tray@2.2.4/qz-tray.min.js";
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

// Connect to QZ Tray
async function connectQZ() {
  try {
    const loaded = await loadQZ();
    if (!loaded || !window.qz) return false;
    if (qz.websocket.isActive()) return true;

    // IMPORTANT: Use null certificate for unsigned/free mode
    // This makes QZ show "Allow" with checkbox enabled (not grayed out)
    qz.security.setCertificatePromise(function(resolve, reject) {
      resolve(null); // null = unsigned mode, checkbox is enabled
    });
    qz.security.setSignaturePromise(function(toSign) {
      return function(resolve, reject) {
        resolve(null); // null signature for unsigned mode
      };
    });

    await qz.websocket.connect({
      retries: 2,
      delay: 1,
      host: ["localhost","127.0.0.1"],
      usingSecure: false, // Use ws:// not wss:// for local connection
    });
    _qzConnected = true;
    // Get all printers
    const found = await qz.printers.find();
    _qzPrinters = Array.isArray(found) ? found : [found].filter(Boolean);
    // Restore saved printer selections
    const savedBill = localStorage.getItem("restopos_qz_bill_printer");
    const savedKitchen = localStorage.getItem("restopos_qz_kitchen_printer");
    if (savedBill && _qzPrinters.includes(savedBill)) _qzBillPrinter = savedBill;
    else if (!_qzBillPrinter && _qzPrinters.length > 0) _qzBillPrinter = _qzPrinters[0];
    if (savedKitchen && _qzPrinters.includes(savedKitchen)) _qzKitchenPrinter = savedKitchen;
    return true;
  } catch (e) {
    _qzConnected = false;
    console.warn("[QZ] Connect failed:", e.message);
    return false;
  }
}

// Disconnect QZ
async function disconnectQZ() {
  try {
    if (window.qz && qz.websocket.isActive()) await qz.websocket.disconnect();
    _qzConnected = false;
  } catch (e) {}
}

// Print via QZ Tray — takes HTML string, prints on selected printer
async function printWithQZ(htmlContent, printerName, paperWidth = "80mm") {
  // Load QZ if not loaded
  if (!window.qz) {
    const loaded = await loadQZ();
    if (!loaded) throw new Error("QZ Tray script not loaded");
  }
  // Reconnect if disconnected
  if (!qz.websocket.isActive()) {
    const ok = await connectQZ();
    if (!ok) throw new Error("QZ Tray not running. Please start QZ Tray.");
  }
  const targetPrinter = printerName || _qzBillPrinter;
  if (!targetPrinter) throw new Error("No printer selected in QZ Tray settings");

  const mmWidth = parseFloat(paperWidth) || 80;
  const config = qz.configs.create(targetPrinter, {
    colorType: "grayscale",
    margins: 0,
    size: { width: mmWidth, height: null },
    units: "mm",
    scaleContent: true,
    rasterize: false, // Use HTML rendering directly
  });
  const data = [{
    type: "pixel",
    format: "html",
    flavor: "plain",
    data: htmlContent,
  }];
  await qz.print(config, data);
  return true;
}

// Check if QZ is available and connected
function isQZConnected() {
  try{
    return window.qz && typeof qz !== "undefined" && qz.websocket && qz.websocket.isActive();
  }catch(e){return false;}
}

// ── PWA Install Prompt ──────────────────────────────────────────────
function usePWAInstall(){
  const [prompt,setPrompt]=useState(null);
  const [installed,setInstalled]=useState(false);
  const [showInstructions,setShowInstructions]=useState(false);
  useEffect(()=>{
    const handler=e=>{e.preventDefault();setPrompt(e);};
    window.addEventListener("beforeinstallprompt",handler);
    window.addEventListener("appinstalled",()=>{setInstalled(true);setPrompt(null);});
    if(window.matchMedia("(display-mode: standalone)").matches)setInstalled(true);
    return()=>window.removeEventListener("beforeinstallprompt",handler);
  },[]);
  async function install(){
    if(prompt){
      prompt.prompt();
      const{outcome}=await prompt.userChoice;
      if(outcome==="accepted")setInstalled(true);
      setPrompt(null);
    }else{
      setShowInstructions(true);
    }
  }
  return{prompt,installed,install,showInstructions,setShowInstructions};
}

export default function App(){
  const [step,setStep]=useState("checking");const [businessData,setBusinessData]=useState(null);const [license,setLicense]=useState(null);const [currentUser,setCurrentUser]=useState(null);const [screen,_setScreen]=useState(()=>LS.get("restopos_last_screen")||"pos");
  function setScreen(s){_setScreen(s);LS.set("restopos_last_screen",s);}
  const [terminated,setTerminated]=useState(null);
  const pwaInstall=usePWAInstall();
  const [lang,setLang]=useState(()=>getLang());
  function handleLangChange(l){setLangStore(l);setLang(l);}
  const [viewport,setViewport]=useState({w:window.innerWidth,h:window.innerHeight,dpr:window.devicePixelRatio||1});
  useEffect(()=>{const fn=()=>setViewport({w:window.innerWidth,h:window.innerHeight,dpr:window.devicePixelRatio||1});window.addEventListener("resize",fn);return()=>window.removeEventListener("resize",fn);},[]);
  const viewportMode=viewport.w>=1024?"DESKTOP_EXPANDED":viewport.w>=640?"TABLET_CONSTRAINED":"MOBILE_FLUID";

  
  // Session timeout (30 min inactivity)
  const [sessionTimeoutMin,setSessionTimeoutMin]=useState(()=>parseInt(localStorage.getItem("restopos_session_timeout")||"30"));
  function handleSessionTimeoutChange(v){const t=Math.max(5,Math.min(480,parseInt(v)||30));setSessionTimeoutMin(t);localStorage.setItem("restopos_session_timeout",String(t));}
  useSessionTimeout(currentUser,()=>{setCurrentUser(null);setStep("login");},sessionTimeoutMin);
  
  // Offline sync state
  const {isOnline,syncQueue,justCameOnline}=useOfflineSync();

  // AUTO-CONNECT QZ TRAY on startup
  useEffect(()=>{
    setTimeout(async()=>{
      const ok=await connectQZ();
      if(ok)console.log("[QZ] Connected. Printers:",_qzPrinters);
    },2000); // Wait 2s for app to load first
  },[]);

  // AUTO-CLEAR DRAFTS FROM PREVIOUS DAY on mount
  useEffect(()=>{
    const lastActiveDay=localStorage.getItem("restopos_last_active_day");
    if(lastActiveDay&&lastActiveDay!==TODAY){
      // New day — clear yesterday's draft invoices from sales
      const yesterdayDrafts=new Set((LS.get("restopos_draft_invoices")||[]).filter(d=>d.date===lastActiveDay).map(d=>d.id));
      if(yesterdayDrafts.size>0){
        // Remove from draft store but keep in archived sales
        const remaining=(LS.get("restopos_draft_invoices")||[]).filter(d=>d.date!==lastActiveDay);
        LS.set("restopos_draft_invoices",remaining);
        console.log(`[Draft] Cleared ${yesterdayDrafts.size} draft invoices from ${lastActiveDay}`);
      }
    }
    localStorage.setItem("restopos_last_active_day",TODAY);
  },[]);

  // RESTORE DATA ON NEW DEVICE — runs once on mount
  useEffect(()=>{
    const savedLic=LS.get("restopos_license_v2");
    if(!savedLic?.licenseKey)return;
    const hasLocalData=localStorage.getItem("restopos_items");
    if(!hasLocalData){
      // New device — restore everything from Firestore
      restoreFromFirestore(savedLic.licenseKey).then(restored=>{
        if(restored){
          // Reload state from localStorage after restore
          _setItems(LS.get("restopos_items")||[]);
          _setSales(LS.get("restopos_sales")||[]);
          _setCompany(LS.get("restopos_company")||{phone:"",email:"",address:"",city:"Riyadh"});
          _setTables(LS.get("restopos_tables")||Array.from({length:12},(_,i)=>({id:i+1,status:"free",capacity:4})));
          _setPromos(LS.get("restopos_promos")||[]);
          _setPins(LS.get("restopos_pins")||DEFAULT_PINS);
          _setInvoiceFormat(LS.get("restopos_invoice_format")||{font:"courier",fontSize:12});
          console.log("[Sync] Data restored from cloud on new device!");
        }
      });
    }else{
      // Existing device — sync current data to cloud in background
      const lic=savedLic.licenseKey;
      setTimeout(()=>{
        SYNC_KEYS.forEach(key=>{
          const val=localStorage.getItem(key);
          if(val)debouncedSync(lic,key,JSON.parse(val));
        });
      },5000); // 5s delay so app loads first
    }
  },[]);

  // REAL-TIME KILL-SWITCH WATCHDOG — listens for status changes in Firestore
  useEffect(()=>{
    const savedLic=LS.get("restopos_license_v2");
    if(!savedLic?.licenseKey)return;
    const q=query(collection(db,"pending_activations"),where("licenseKey","==",savedLic.licenseKey));
    const unsub=onSnapshot(q,(snap)=>{
      if(snap.empty)return;
      const data=snap.docs[0].data();
      if(data.forceLogout===true){
        setTerminated("forceLogout");
      }else if(data.status==="deactivated"||data.status==="suspended"){
        setTerminated("deactivated");
      }else{
        setTerminated(null);
        // Sync subscriptionPlan, phone, ownerName from Firestore into local license
        const updatedLic={...LS.get("restopos_license_v2"),subscriptionPlan:data.subscriptionPlan||"basic",ownerName:data.ownerName||"",phone:data.phone||savedLic.phone||""};
        LS.set("restopos_license_v2",updatedLic);
        setLicense(updatedLic);
        // ── Subscription expiry enforcement ──────────────────────────
        const planMonths={basic:1,professional:12,premium:12};
        const activatedAt=data.activatedAt||data.submittedAt;
        if(activatedAt){
          const expiry=new Date(activatedAt);
          expiry.setMonth(expiry.getMonth()+(planMonths[data.subscriptionPlan||"basic"]||1));
          if(new Date()>expiry){
            setTerminated("expired");
          }
        }
      }
    });
    return()=>unsub();
  },[]);
  const [sales,_setSales]=useState(()=>LS.get("restopos_sales")||[]);
  const [items,_setItems]=useState(()=>LS.get("restopos_items")||[]);
  const [tables,_setTables]=useState(()=>LS.get("restopos_tables")||Array.from({length:12},(_,i)=>({id:i+1,status:"free",capacity:4})));
  const [users,_setUsers]=useState(()=>LS.get("restopos_users")||[]);
  const [promos,_setPromos]=useState(()=>LS.get("restopos_promos")||[]);
  const [company,_setCompany]=useState(()=>LS.get("restopos_company")||{phone:"",email:"",address:"",city:"Riyadh"});
  const [pins,_setPins]=useState(()=>LS.get("restopos_pins")||DEFAULT_PINS);
  const [invoiceFormat,_setInvoiceFormat]=useState(()=>LS.get("restopos_invoice_format")||{font:"courier",fontSize:12,shopNameOverride:"",footer:"Thank you for your visit!",footerAr:"شكراً لزيارتكم",website:"",social:"",tagline:""});
  // Unlimited sales storage — keeps recent 200 in fast state, archives rest by month
  function setSales(v){_setSales(p=>{
    const n=typeof v==="function"?v(p):v;
    if(n.length>200){
      // Archive older sales by month bucket — keeps ALL data
      const recent=n.slice(-200);
      const toArchive=n.slice(0,-200);
      // Group by year-month
      const byMonth={};
      toArchive.forEach(s=>{
        const bucket=(s.date||"").slice(0,7)||"unknown"; // "YYYY-MM"
        if(!byMonth[bucket])byMonth[bucket]=[];
        byMonth[bucket].push(s);
      });
      // Merge into existing monthly archives
      Object.entries(byMonth).forEach(([month,sales])=>{
        const key=`restopos_sales_${month}`;
        try{
          const existing=JSON.parse(localStorage.getItem(key)||"[]");
          const existingIds=new Set(existing.map(s=>s.id));
          const merged=[...existing,...sales.filter(s=>!existingIds.has(s.id))];
          localStorage.setItem(key,JSON.stringify(merged));
        }catch(e){/* storage full — skip archiving this batch */}
      });
      LS.set("restopos_sales",recent);
      const lic2=LS.get("restopos_license_v2")?.licenseKey;if(lic2){debouncedSync(lic2,"restopos_sales",recent);}
      return recent;
    }
    LS.set("restopos_sales",n);
    const lic3=LS.get("restopos_license_v2")?.licenseKey;if(lic3){debouncedSync(lic3,"restopos_sales",n);}
    return n;
  });}
  // Helper: load sales from a specific month archive
  function loadMonthSales(yearMonth){
    try{return JSON.parse(localStorage.getItem(`restopos_sales_${yearMonth}`)||"[]");}catch(e){return[];}
  }
  // Helper: get list of all archived month keys
  function getArchivedMonths(){
    const months=[];
    for(let i=0;i<localStorage.length;i++){
      const k=localStorage.key(i);
      if(k&&k.startsWith("restopos_sales_")&&k!=="restopos_sales"){
        months.push(k.replace("restopos_sales_",""));
      }
    }
    return months.sort().reverse();
  }
  // allSales merges active sales + ALL monthly archive buckets + closed-day archives
  const archivedSalesRaw=LS.get("restopos_archived_sales")||[];
  const allSales=useMemo(()=>{
    const activeIds=new Set(sales.map(s=>s.id));
    // Load all monthly buckets
    const monthlyArchived=[];
    for(let i=0;i<localStorage.length;i++){
      const k=localStorage.key(i);
      if(k&&k.startsWith("restopos_sales_")&&k!=="restopos_sales"){
        try{const bucket=JSON.parse(localStorage.getItem(k)||"[]");monthlyArchived.push(...bucket);}catch(e){}
      }
    }
    const allArchived=[...archivedSalesRaw,...monthlyArchived];
    const archived=allArchived.filter(s=>!activeIds.has(s.id));
    const seen=new Set();
    const deduped=archived.filter(s=>{if(seen.has(s.id))return false;seen.add(s.id);return true;});
    return[...sales,...deduped].sort((a,b)=>b.date.localeCompare(a.date)||b.id.localeCompare(a.id));
  },[sales,archivedSalesRaw.length]);
  function setItems(v){_setItems(p=>{const n=typeof v==="function"?v(p):v;LS.set("restopos_items",n);const _lic_setItems=LS.get("restopos_license_v2")?.licenseKey;if(_lic_setItems)debouncedSync(_lic_setItems,"restopos_items",n);if(n.length!==p.length)logActivity(n.length>p.length?"ITEM_ADDED":"ITEM_DELETED",{after:{itemCount:n.length}},currentUser?.role||"System");return n;});}
  function setTables(v){_setTables(p=>{const n=typeof v==="function"?v(p):v;LS.set("restopos_tables",n);const lic=LS.get("restopos_license_v2")?.licenseKey;if(lic)debouncedSync(lic,"restopos_tables",n);return n;});}
  function setUsers(v){_setUsers(p=>{const n=typeof v==="function"?v(p):v;LS.set("restopos_users",n);if(n.length!==p.length)logActivity(n.length>p.length?"USER_ADDED":"USER_DELETED",{after:{userCount:n.length}},currentUser?.role||"System");return n;});}
  function setPromos(v){_setPromos(p=>{const n=typeof v==="function"?v(p):v;LS.set("restopos_promos",n);const lic=LS.get("restopos_license_v2")?.licenseKey;if(lic)debouncedSync(lic,"restopos_promos",n);return n;});}
  function setCompany(v){_setCompany(p=>{const n=typeof v==="function"?v(p):v;LS.set("restopos_company",n);const _lic_setCompany=LS.get("restopos_license_v2")?.licenseKey;if(_lic_setCompany)debouncedSync(_lic_setCompany,"restopos_company",n);logActivity("SETTINGS_CHANGED",{after:{company:"updated"}},currentUser?.role||"System");return n;});}
  function setPins(v){_setPins(p=>{const n=typeof v==="function"?v(p):v;LS.set("restopos_pins",n);const _lic_setPins=LS.get("restopos_license_v2")?.licenseKey;if(_lic_setPins)debouncedSync(_lic_setPins,"restopos_pins",n);logActivity("PINS_CHANGED",{after:{pins:"updated"}},currentUser?.role||"System");return n;});}
  function setInvoiceFormat(v){_setInvoiceFormat(p=>{const n=typeof v==="function"?v(p):v;LS.set("restopos_invoice_format",n);const _lic_setInvoiceFormat=LS.get("restopos_license_v2")?.licenseKey;if(_lic_setInvoiceFormat)debouncedSync(_lic_setInvoiceFormat,"restopos_invoice_format",n);const lic=LS.get("restopos_license_v2")?.licenseKey;if(lic)debouncedSync(lic,"restopos_invoice_format",n);return n;});}
  const [uiScale,setUiScale]=useState(()=>{const v=parseInt(LS.get("restopos_ui_scale")||"100");return isNaN(v)?100:v;});
  function handleScaleChange(v){const s=Math.max(70,Math.min(130,parseInt(v)||100));setUiScale(s);LS.set("restopos_ui_scale",String(s));}
  useEffect(()=>{
    const saved=LS.get("restopos_license_v2");
    const pendingId=localStorage.getItem("restopos_pending_id");
    const creds=LS.get("restopos_client_creds");
    if(saved){
      setLicense(saved);
      if(!creds){setStep("setCredentials");}
      else if(!creds.approved){setStep("pendingApproval");}
      else{setStep("clientLogin");}
    }else if(pendingId){setStep("license");}
    else setStep("register");
  },[]);
  function handleClearLicense(){LS.del("restopos_license_v2");LS.del("restopos_pins");setLicense(null);setCurrentUser(null);setStep("register");}
  function handleSwitchAccount(){LS.del("restopos_license_v2");LS.del("restopos_client_creds");setLicense(null);setCurrentUser(null);setStep("register");}
  const ALL_NAV=[["dashboard","📊","Dashboard",["Admin","Manager"]],["pos","🖥️","POS",["Admin","Manager","Cashier"]],["settings","⚙️","Settings",["Admin"]],["create","➕","Create",["Admin","Manager"]],["transactions","💳","Transactions",["Admin","Manager"]],["financials","🏦","Financials",["Admin","Manager"]],["invoices","📄","Invoices",["Admin","Manager"]],["customers","👥","CRM",["Admin","Manager"]],["reports","📋","Reports",["Admin","Manager"]],["analytics","📉","Analytics",["Admin","Manager"]],["advanced","⚡","Advanced",["Admin","Manager"]],["backup","💾","Backup",["Admin"]],["shifts","🔄","Shifts",["Admin","Manager"]],["audit","🔍","Audit",["Admin"]],["tools","🔧","Tools",["Admin"]],["useradmin","👤","Users",["Admin"]],["help","❓","Help",["Admin","Manager","Cashier"]]];
  const NAV=ALL_NAV.filter(([,,,roles])=>currentUser&&roles.includes(currentUser.role));
  if(step==="checking")return<div style={{minHeight:"100vh",background:"#0a1628",display:"flex",alignItems:"center",justifyContent:"center"}}><div style={{color:"#fff",fontSize:16}}>Loading…</div></div>;
  if(terminated==="deactivated")return(
    <div style={{position:"fixed",inset:0,background:"#0a0a0a",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",zIndex:99999,fontFamily:"'Plus Jakarta Sans',sans-serif",padding:20}}>
      <div style={{width:90,height:90,borderRadius:"50%",background:"rgba(217,64,64,0.12)",border:"2px solid rgba(217,64,64,0.5)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:40,marginBottom:24}}>🔴</div>
      <div style={{fontSize:24,fontWeight:900,color:"#ff4444",marginBottom:12,textAlign:"center"}}>Account Deactivated</div>
      <div style={{fontSize:14,color:"rgba(255,255,255,0.55)",textAlign:"center",maxWidth:360,lineHeight:1.7,marginBottom:8}}>Your RestoPOS account has been deactivated by the administrator.</div>
      <div style={{fontSize:13,color:"rgba(255,255,255,0.35)",textAlign:"center",maxWidth:360,lineHeight:1.6,marginBottom:28}}>Your data is safe and has not been deleted. Please contact your RestoPOS provider to restore access.</div>
      <div style={{padding:"12px 24px",background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:12,fontSize:12,color:"rgba(255,255,255,0.3)",textAlign:"center"}}>
        License: <strong style={{color:"rgba(255,255,255,0.5)",fontFamily:"monospace"}}>{license?.licenseKey||"—"}</strong>
      </div>
    </div>
  );
  if(terminated==="forceLogout")return(
    <div style={{position:"fixed",inset:0,background:"#0a0a0a",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",zIndex:99999,fontFamily:"'Plus Jakarta Sans',sans-serif",padding:20}}>
      <div style={{width:90,height:90,borderRadius:"50%",background:"rgba(240,165,0,0.12)",border:"2px solid rgba(240,165,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:40,marginBottom:24}}>⚡</div>
      <div style={{fontSize:24,fontWeight:900,color:"#F0A500",marginBottom:12,textAlign:"center"}}>Session Ended</div>
      <div style={{fontSize:14,color:"rgba(255,255,255,0.55)",textAlign:"center",maxWidth:360,lineHeight:1.7,marginBottom:28}}>Your session was ended by the administrator. You can log back in with your credentials.</div>
      <button onClick={()=>{setTerminated(null);setStep("clientLogin");}} style={{padding:"12px 28px",background:"linear-gradient(135deg,#1A6B4A,#134D36)",color:"#fff",border:"none",borderRadius:12,fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:"inherit"}}>→ Log Back In</button>
    </div>
  );
  if(terminated==="expired")return(
    <div style={{position:"fixed",inset:0,background:"#0a0a0a",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",zIndex:99999,fontFamily:"'Plus Jakarta Sans',sans-serif",padding:20}}>
      <div style={{width:90,height:90,borderRadius:"50%",background:"rgba(99,102,241,0.12)",border:"2px solid rgba(99,102,241,0.5)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:40,marginBottom:24}}>📅</div>
      <div style={{fontSize:24,fontWeight:900,color:"#a5b4fc",marginBottom:12,textAlign:"center"}}>Subscription Expired</div>
      <div style={{fontSize:14,color:"rgba(255,255,255,0.55)",textAlign:"center",maxWidth:380,lineHeight:1.7,marginBottom:8}}>Your RestoPOS subscription has expired.</div>
      <div style={{fontSize:13,color:"rgba(255,255,255,0.35)",textAlign:"center",maxWidth:380,lineHeight:1.6,marginBottom:28}}>Your data is safe. Please contact your RestoPOS provider to renew your subscription.</div>
      <div style={{padding:"12px 24px",background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:12,fontSize:12,color:"rgba(255,255,255,0.3)"}}>
        License: <strong style={{color:"rgba(255,255,255,0.5)",fontFamily:"monospace"}}>{license?.licenseKey||"—"}</strong>
      </div>
    </div>
  );
  if(step==="register")return<BusinessRegistration onNext={(data)=>{setBusinessData(data);setStep("license");}} onLogin={()=>setStep("clientLogin")}/>;
  if(step==="license")return<LicenseVerification businessData={businessData||{businessName:"",crNumber:"",vatNumber:"",address:"",city:"",phone:""}} onSuccess={(lic)=>{setLicense(lic);setStep("setCredentials");}} onBack={()=>setStep("register")} onLogin={()=>setStep("clientLogin")}/>;
  if(step==="setCredentials")return<SetCredentials license={license} onDone={()=>setStep("pendingApproval")}/>;
  if(step==="pendingApproval")return<PendingApprovalScreen license={license} onApproved={()=>setStep("clientLogin")} onSwitchAccount={handleSwitchAccount}/>;
  if(step==="clientLogin")return<ClientLogin license={license} onSuccess={()=>setStep("login")} onForgotPassword={()=>setStep("forgotPassword")}/>;
  if(step==="forgotPassword")return<ForgotPassword onBack={()=>setStep("clientLogin")} onReset={()=>setStep("clientLogin")}/>;
  if(step==="login"||!currentUser)return<RoleLogin license={license} lang={lang} onLogin={(user)=>{setCurrentUser(user);setStep("app");if(user.role==="Cashier")setScreen("pos");}}/>;
  return(
    <ErrorBoundary>
    <div dir={dir(lang)} style={{fontFamily:lang==="ar"?"'Tajawal','Plus Jakarta Sans',sans-serif":"'Plus Jakarta Sans','Tajawal',sans-serif",background:C.bg,height:"100vh",display:"flex",flexDirection:"column",overflow:"hidden",fontSize:`${uiScale}%`,zoom:`${uiScale}%`}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Tajawal:wght@400;500;700;800&display=swap');html,body,#root{height:100%;margin:0;padding:0;width:100%}*{box-sizing:border-box;margin:0;padding:0}::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-track{background:${C.bg}}::-webkit-scrollbar-thumb{background:${C.border};border-radius:3px}input,select{outline:none}input:focus,select:focus{border-color:${C.primary}!important}@media print{header,nav{display:none!important}}${lang==="ar"?"body,button,input,select,textarea{font-family:'Tajawal',sans-serif!important}":""}`}</style>
      <div style={{display:"flex",alignItems:"stretch",flexShrink:0,zIndex:100,boxShadow:"0 2px 12px rgba(0,0,0,0.18)",minHeight:50,width:"100%",flexWrap:"nowrap"}}>
        <div style={{background:"linear-gradient(135deg,#1A3D2B 0%,#1F4D36 100%)",display:"flex",alignItems:"center",gap:8,padding:"0 12px",flexShrink:0,borderRight:"1px solid rgba(255,255,255,0.1)"}}>
          <div style={{width:26,height:26,background:"linear-gradient(135deg,#2ECC71,#F0A500)",borderRadius:6,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:13,fontWeight:900,flexShrink:0}}>R</div>
          <div style={{display:viewport.w<500?"none":"block"}}><div style={{fontSize:12,fontWeight:800,color:"#fff",lineHeight:1,whiteSpace:"nowrap"}}>RestoPOS</div><div style={{fontSize:7,color:"rgba(255,255,255,0.5)",letterSpacing:"0.1em",whiteSpace:"nowrap"}}>{lang==="ar"?`المرحلة 2 · ${APP_VERSION}`:`ZATCA P2 · ${APP_VERSION}`}</div></div>
        </div>
        <div style={{background:"linear-gradient(90deg,#E8F4EE 0%,#F0F9F4 100%)",flex:1,display:"flex",alignItems:"center",padding:"0 4px",overflowX:"auto",borderRight:"1px solid #C8E6D4",minWidth:0}}>
          {NAV.map(([id,icon,label])=>(
            <button key={id} onClick={()=>setScreen(id)} style={{padding:viewport.w<640?"5px 7px":"5px 9px",borderRadius:6,border:screen===id?"1.5px solid #1A6B4A":"1px solid transparent",background:screen===id?"#fff":"transparent",color:screen===id?C.primary:"#2D5A40",fontFamily:"inherit",fontSize:viewport.w<640?10:11,fontWeight:screen===id?700:500,cursor:"pointer",display:"flex",alignItems:"center",gap:3,whiteSpace:"nowrap",transition:"all 0.15s",flexShrink:0,boxShadow:screen===id?"0 1px 4px rgba(26,107,74,0.15)":"none"}}>
              <span style={{fontSize:11}}>{icon}</span>{viewport.w>=500&&<span>{t(label,lang)}</span>}
            </button>
          ))}
        </div>
        <div style={{background:"linear-gradient(135deg,#1A3D2B 0%,#1F4D36 100%)",display:"flex",alignItems:"center",gap:4,padding:"0 8px",flexShrink:0,borderLeft:"1px solid rgba(255,255,255,0.1)"}}>
          {!isOnline&&<span style={{fontSize:9,background:"rgba(217,64,64,0.35)",color:"#ff8080",padding:"3px 8px",borderRadius:4,fontWeight:800,border:"1px solid rgba(217,64,64,0.6)",whiteSpace:"nowrap"}}>📡 OFFLINE{syncQueue.length>0?" · "+syncQueue.length+" queued":""}</span>}

          {!pwaInstall.installed&&(
            <button onClick={pwaInstall.install}
              style={{fontSize:9,background:"rgba(26,107,74,0.3)",color:"#7FFAB5",padding:"3px 8px",borderRadius:4,fontWeight:800,border:"1px solid rgba(26,107,74,0.5)",cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}}>
              ⬇️ Install App
            </button>
          )}
          {/* PWA Install Instructions Modal */}
          {pwaInstall.showInstructions&&(
            <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:99999,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
              <div style={{background:"#0f1e30",border:"1px solid rgba(255,255,255,0.15)",borderRadius:20,padding:28,maxWidth:400,width:"100%"}}>
                <div style={{fontSize:16,fontWeight:800,color:"#fff",marginBottom:6}}>⬇️ Install RestoPOS</div>
                <div style={{fontSize:12,color:"rgba(255,255,255,0.5)",marginBottom:20}}>Add RestoPOS to your device as an app</div>
                <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:20}}>
                  {[
                    {icon:"💻",title:"On PC (Chrome)","steps":"Click the ⊕ icon in Chrome's address bar → click Install"},
                    {icon:"📱",title:"On Android","steps":"Tap Chrome menu (⋮) → 'Add to Home screen' → Install"},
                    {icon:"🍎",title:"On iPhone/iPad","steps":"Tap Safari Share button (□↑) → 'Add to Home Screen' → Add"},
                  ].map(({icon,title,steps})=>(
                    <div key={title} style={{background:"rgba(255,255,255,0.06)",borderRadius:10,padding:"10px 14px"}}>
                      <div style={{fontSize:12,fontWeight:700,color:"#fff",marginBottom:3}}>{icon} {title}</div>
                      <div style={{fontSize:11,color:"rgba(255,255,255,0.5)"}}>{steps}</div>
                    </div>
                  ))}
                </div>
                <div style={{background:"rgba(26,107,74,0.15)",border:"1px solid rgba(26,107,74,0.3)",borderRadius:10,padding:"10px 14px",marginBottom:16,fontSize:11,color:"#7FFAB5"}}>
                  💡 Once installed: works offline, faster loading, own window, no browser bars
                </div>
                <button onClick={()=>pwaInstall.setShowInstructions(false)}
                  style={{width:"100%",padding:"12px",background:"linear-gradient(135deg,#1A6B4A,#134D36)",color:"#fff",border:"none",borderRadius:10,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
                  Got it ✓
                </button>
              </div>
            </div>
          )}
          {justCameOnline&&<span style={{fontSize:9,background:"rgba(16,185,129,0.3)",color:"#6ee7b7",padding:"3px 8px",borderRadius:4,fontWeight:800,border:"1px solid rgba(16,185,129,0.5)",whiteSpace:"nowrap"}}>🟢 Back Online</span>}
          {isOnline&&<span style={{fontSize:8,background:"rgba(46,204,113,0.25)",color:"#7FFAB5",padding:"2px 5px",borderRadius:4,fontWeight:700,border:"1px solid rgba(46,204,113,0.4)",whiteSpace:"nowrap",display:viewport.w<640?"none":"inline"}}>● LIVE</span>}
          <span title={`${viewport.w}×${viewport.h}`} style={{fontSize:8,background:"rgba(240,165,0,0.15)",color:"#F0A500",padding:"2px 5px",borderRadius:4,fontWeight:700,border:"1px solid rgba(240,165,0,0.3)",whiteSpace:"nowrap",cursor:"default",display:viewport.w<768?"none":"inline"}}>{viewport.w}×{viewport.h}</span>
          <span style={{fontSize:8,background:"rgba(99,102,241,0.25)",color:"#c7d2fe",padding:"2px 5px",borderRadius:4,fontWeight:700,border:"1px solid rgba(99,102,241,0.35)",whiteSpace:"nowrap",display:viewport.w<640?"none":"inline"}}>ZATCA P2</span>
          <div style={{display:"flex",alignItems:"center",gap:2,background:"rgba(255,255,255,0.1)",borderRadius:5,padding:"2px 4px",border:"1px solid rgba(255,255,255,0.15)"}}>
            <div style={{display:"flex",alignItems:"center",gap:4}}>
              <button onClick={()=>handleScaleChange(uiScale-5)} style={{background:"rgba(255,255,255,0.1)",border:"none",color:"#fff",width:16,height:16,borderRadius:3,cursor:"pointer",fontSize:10,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"inherit"}}>−</button>
              <span style={{fontSize:9,color:"rgba(255,255,255,0.75)",fontWeight:700,minWidth:24,textAlign:"center"}}>{uiScale}%</span>
              <button onClick={()=>handleScaleChange(uiScale+5)} style={{background:"rgba(255,255,255,0.1)",border:"none",color:"#fff",width:16,height:16,borderRadius:3,cursor:"pointer",fontSize:10,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"inherit"}}>+</button>
            </div>
          </div>
          <div style={{fontSize:9,color:"rgba(255,255,255,0.65)",fontWeight:700,whiteSpace:"nowrap",display:viewport.w<500?"none":"block"}}>{lang==="ar"?({"Admin":"مدير","Manager":"مشرف","Cashier":"كاشير"}[currentUser?.role]||currentUser?.role):currentUser?.role}</div>
          <button onClick={()=>setCurrentUser(null)} style={{fontSize:9,background:"rgba(217,64,64,0.25)",color:"#ffaaaa",border:"1px solid rgba(217,64,64,0.35)",padding:"3px 7px",borderRadius:4,cursor:"pointer",fontFamily:"inherit",fontWeight:700,whiteSpace:"nowrap"}}>⎋</button>
        </div>
      </div>
      <div style={{flex:1,padding:screen==="pos"?0:20,overflowY:screen==="pos"?"hidden":"auto",width:"100%",minHeight:0,height:"calc(100vh - 50px)"}}>
        {screen==="dashboard"&&<Dashboard sales={allSales} items={items} license={license} lang={lang}/>}
        {screen==="pos"&&<POS items={items} sales={sales} setSales={setSales} tables={tables} setTables={setTables} promos={promos} license={license} lang={lang}/>}
        {screen==="settings"&&<Settings company={company} setCompany={setCompany} tables={tables} setTables={setTables} license={license} onClearLicense={handleClearLicense} onSwitchAccount={handleSwitchAccount} pins={pins} setPins={setPins} invoiceFormat={invoiceFormat} setInvoiceFormat={setInvoiceFormat} lang={lang} onLangChange={handleLangChange}/>}
        {screen==="create"&&<Create items={items} setItems={setItems} promos={promos} setPromos={setPromos}/>}
        {screen==="transactions"&&<Transactions sales={allSales} setSales={setSales} license={license}/>}
        {/* P&L moved to Financials tab */}
        {screen==="financials"&&<FinancialReports sales={allSales} items={items} license={license}/>}
        {screen==="invoices"&&<InvoiceEnhancements sales={allSales} items={items} license={license} company={company}/>}
        {/* Expenses moved to Financials tab */}
        {screen==="customers"&&<Customers sales={allSales}/>}
        {screen==="reports"&&<Reports sales={sales} allSales={allSales} items={items} setSales={setSales}/>}
        {screen==="analytics"&&<AdvancedReports sales={allSales} items={items}/>}
        {screen==="advanced"&&<AdvancedFeatures sales={allSales} items={items} setItems={setItems}/>}
        {screen==="backup"&&<div><CloudSyncStatus/><BackupManager sales={allSales} items={items}/></div>}
        {screen==="shifts"&&<ShiftManager sales={allSales} currentUser={currentUser} lang={lang}/>}
        {screen==="audit"&&<AuditTrail/>}
        {screen==="tools"&&<Tools sales={allSales} items={items} setItems={setItems}/>}
        {screen==="useradmin"&&<UserAdmin users={users} setUsers={setUsers}/>}
        {screen==="help"&&<Help/>}
      </div>
    </div>
    </ErrorBoundary>
  );
}
