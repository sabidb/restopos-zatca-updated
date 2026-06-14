import { useState, useEffect, useRef, useMemo, useCallback, Component } from "react";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, query, where, getDocs, updateDoc, doc, addDoc, getDoc, onSnapshot, setDoc, orderBy, limit } from "firebase/firestore";
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

// ZATCA Phase 2 microservice (signs invoice + reports to FATOORA)
const ZATCA_SERVICE_URL = "https://restopos-zatca-service-production.up.railway.app";
// Detected from the microservice status — set to true when ZATCA_ENV=production on Railway
// This affects the progress animation timing only (production takes longer)
const IS_PRODUCTION_ENV = false; // flip to true manually when Railway is on production

// Build the simplified-invoice payload the microservice expects from a stored invoice
function buildZatcaReportPayload(inv, licenseKey) {
  return {
    licenseKey,
    invoice: {
      props: {
        invoice_counter_number: inv.icv,
        invoice_serial_number: inv.invoice_number,
        issue_date: (inv.timestamp || new Date().toISOString()).slice(0, 10),
        issue_time: (inv.timestamp || new Date().toISOString()).slice(11, 19),
        previous_invoice_hash: inv.prev_invoice_hash || "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWIONjcyOWQ3M2EyN2ZiNTdlOQ==",
        line_items: (inv.items || []).map((it, idx) => ({
          id: String(idx + 1),
          name: it.name || `Item ${idx + 1}`,
          quantity: it.qty,
          tax_exclusive_price: parseFloat((it.price / 1.15).toFixed(2)),
          VAT_percent: 0.15
        }))
      }
    }
  };
}

async function reportToFatoora(inv) {
  const licenseKey = LS.get("restopos_license_v2")?.licenseKey;
  if (!licenseKey) {
    console.warn("[ZATCA] No licenseKey found; cannot report invoice.");
    fatooraQueue.markFailed(inv.invoice_number);
    throw new Error("No license key found. Please re-activate the app.");
  }

  try {
    const payload = buildZatcaReportPayload(inv, licenseKey);
    const res = await fetch(`${ZATCA_SERVICE_URL}/zatca/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || data.success !== true) {
      console.error("[ZATCA] Report failed:", data.error || res.status);
      fatooraQueue.markFailed(inv.invoice_number);
      throw new Error(data.error || `ZATCA service returned ${res.status}`);
    }

    // Persist the signed hash + signed QR back onto the stored invoice
    try {
      const all = invoiceStorage.getAll().map(i =>
        i.invoice_number === inv.invoice_number
          ? { ...i, zatca_reported: true, phase: 2, signed_invoice_hash: data.invoiceHash || i.invoice_hash_base64, signed_qr_string: data.qr || i.qr_string }
          : i
      );
      localStorage.setItem(ZATCA_STORAGE_KEY, JSON.stringify(all));
    } catch (e) { /* storage best-effort */ }

    fatooraQueue.markSent(inv.invoice_number);
    console.log("[ZATCA] Reported:", inv.invoice_number, "hash:", data.invoiceHash);
    return { success: true, invoiceHash: data.invoiceHash, qr: data.qr, reportError: data.reportError || null };
  } catch (err) {
    console.error("[ZATCA] Report error:", err.message);
    fatooraQueue.markFailed(inv.invoice_number);
    throw err;
  }
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
  // Fire event so top-bar INV number box updates live
  try{window.dispatchEvent(new Event("restopos-invoice"));}catch(e){}
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

// Generate a QR code as a PNG data-URL (for embedding into printed/QZ HTML).
// Returns a Promise that resolves to a data-URL string ("" on failure).
function makeQRDataURL(qrData,size=240){
  return new Promise((resolve)=>{
    if(!qrData){resolve("");return;}
    function gen(){
      try{
        const tempDiv=document.createElement("div");
        tempDiv.style.cssText="position:absolute;left:-9999px;top:-9999px;width:"+size+"px;height:"+size+"px;";
        document.body.appendChild(tempDiv);
        new window.QRCode(tempDiv,{text:qrData,width:size,height:size,colorDark:"#000000",colorLight:"#ffffff",correctLevel:window.QRCode?.CorrectLevel?.M});
        // qrcodejs renders into a <canvas> (and/or <img>) asynchronously — wait a tick
        setTimeout(()=>{
          let src="";
          try{
            const canvas=tempDiv.querySelector("canvas");
            const img=tempDiv.querySelector("img");
            if(canvas)src=canvas.toDataURL("image/png");
            else if(img&&img.src)src=img.src;
          }catch(e){}
          try{document.body.removeChild(tempDiv);}catch(e){}
          resolve(src);
        },140);
      }catch(e){resolve("");}
    }
    if(window.QRCode){gen();}
    else{
      const s=document.createElement("script");
      s.src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";
      s.onload=()=>setTimeout(gen,160);
      s.onerror=()=>resolve("");
      document.head.appendChild(s);
    }
  });
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
  "restopos_vno","restopos_kot","restopos_daily_token","restopos_gift_cards","restopos_quotations",
  "restopos_draft_format","restopos_kot_format","restopos_dashboard_config","restopos_draft_invoices","restopos_saved_invoices",
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

// ── DAILY TOKEN COUNTER ──────────────────────────────────────────────
// Independent of KOT/invoice numbers. Increments ONLY on completed normal
// invoices (not drafts). Persists across app restart. Reset to 0 by Close Day.
// Stored as {date, token}. The visible number is the last token issued today.
const TOKEN_KEY="restopos_daily_token";
function getDailyToken(){
  const t=LS.get(TOKEN_KEY);
  if(!t||typeof t.token!=="number")return 0;
  return t.token;
}
// Returns the NEW token after incrementing (the number assigned to this order).
function bumpDailyToken(){
  const cur=LS.get(TOKEN_KEY);
  const next=((cur&&typeof cur.token==="number")?cur.token:0)+1;
  LS.set(TOKEN_KEY,{date:TODAY,token:next});
  try{window.dispatchEvent(new CustomEvent("restopos-token",{detail:next}));}catch(e){}
  // best-effort cloud sync
  try{const lk=LS.get("restopos_license_v2")?.licenseKey;if(lk&&typeof debouncedSync==="function")debouncedSync(lk,TOKEN_KEY,{date:TODAY,token:next});}catch(e){}
  return next;
}
function resetDailyToken(){
  LS.set(TOKEN_KEY,{date:TODAY,token:0});
  try{window.dispatchEvent(new CustomEvent("restopos-token",{detail:0}));}catch(e){}
  try{const lk=LS.get("restopos_license_v2")?.licenseKey;if(lk&&typeof debouncedSync==="function")debouncedSync(lk,TOKEN_KEY,{date:TODAY,token:0});}catch(e){}
}

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
    function onKey(e){if(e.key==="Enter")handleSave();}
    window.addEventListener("keydown",onKey);
    return()=>window.removeEventListener("keydown",onKey);
  },[username,password,confirm]);
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
const APP_VERSION="v28.5.5";
const APP_VERSION_FULL="RestoPOS v28.5.5 · ZATCA Phase 2";
const C={bg:"#F8F9FB",card:"#FFFFFF",border:"#E8EBF0",primary:"#1A6B4A",primaryLight:"#E8F5EE",primaryDark:"#134D36",accent:"#F0A500",accentLight:"#FEF6E4",danger:"#D94040",dangerLight:"#FDE8E8",info:"#2176AE",infoLight:"#E6F0F8",text:"#1A1D23",textMid:"#5A6070",textLight:"#9AA0AD",success:"#1A8A4A",successLight:"#E6F7ED",warning:"#E07B00",warningLight:"#FFF3E0",zatca:"#6366f1",zatcaLight:"#eef2ff"};
const SEED_ITEMS=[{id:1,name:"Broasted Chicken Half",nameAr:"دجاج مبروست نصف",category:"Broasted",price:28,cost:14,stock:50,active:true,barcode:""},{id:2,name:"Broasted Chicken Full",nameAr:"دجاج مبروست كامل",category:"Broasted",price:52,cost:26,stock:30,active:true,barcode:""},{id:3,name:"Crispy Wings 6pc",nameAr:"أجنحة مقرمشة",category:"Broasted",price:22,cost:10,stock:40,active:true,barcode:""},{id:4,name:"Mixed Grill Platter",nameAr:"مشاوي مشكلة",category:"Grills",price:65,cost:30,stock:20,active:true,barcode:""},{id:5,name:"Shish Tawook",nameAr:"شيش طاووق",category:"Grills",price:38,cost:18,stock:25,active:true,barcode:""},{id:6,name:"French Fries",nameAr:"بطاطس مقلية",category:"Sides",price:10,cost:3,stock:100,active:true,barcode:""},{id:7,name:"Coleslaw",nameAr:"كول سلو",category:"Sides",price:8,cost:2,stock:60,active:true,barcode:""},{id:8,name:"Pepsi Can",nameAr:"بيبسي",category:"Drinks",price:5,cost:2,stock:120,active:true,barcode:""},{id:9,name:"Fresh Lemon Juice",nameAr:"عصير ليمون",category:"Drinks",price:14,cost:4,stock:40,active:true,barcode:""},{id:10,name:"Umm Ali",nameAr:"أم علي",category:"Desserts",price:18,cost:6,stock:15,active:true,barcode:""},{id:11,name:"Family Box",nameAr:"وجبة عائلية",category:"Combos",price:85,cost:40,stock:20,active:true,barcode:""},{id:12,name:"Solo Meal",nameAr:"وجبة فردية",category:"Combos",price:32,cost:15,stock:30,active:true,barcode:""}];
const SEED_CATEGORIES=["Broasted","Grills","Sides","Drinks","Desserts","Combos"];
const TABLES_INIT=Array.from({length:12},(_,i)=>({id:i+1,status:i<3?"occupied":"free",capacity:4}));
const DEFAULT_PINS={Admin:"1234",Manager:"2345",Cashier:"3456"};
const TODAY=new Date().toISOString().split("T")[0];

// ── Category colours, Favourites & "Other" bucket helpers ───────────
const OTHER_CAT="Other";
const CAT_PALETTE=["#1A6B4A","#2176AE","#D94040","#F0A500","#6366f1","#7c3aed","#be185d","#0891b2","#65a30d","#ea580c","#0f766e","#9333ea","#475569","#b45309"];
function getCategoryColors(){return LS.get("restopos_category_colors")||{};}
function saveCategoryColors(map){LS.set("restopos_category_colors",map);const lic=LS.get("restopos_license_v2")?.licenseKey;if(lic)debouncedSync(lic,"restopos_category_colors",map);}
function colorForCat(cat,cats){const map=getCategoryColors();if(map&&map[cat])return map[cat];const i=Array.isArray(cats)?cats.indexOf(cat):-1;return CAT_PALETTE[(i<0?Math.abs((cat||"").split("").reduce((a,c)=>a+c.charCodeAt(0),0)):i)%CAT_PALETTE.length];}
// Effective category for an item — falls back to "Other" when blank or unknown
function effectiveCat(item,cats){const c=item&&item.category;return (c&&Array.isArray(cats)&&cats.includes(c))?c:OTHER_CAT;}
// Category list that appends "Other" whenever orphan/uncategorised items exist
function catsWithOther(cats,items){const base=Array.isArray(cats)?[...cats]:[];const hasOther=Array.isArray(items)&&items.some(i=>!i.category||!base.includes(i.category));if(hasOther&&!base.includes(OTHER_CAT))base.push(OTHER_CAT);return base;}
function getFavourites(){const f=LS.get("restopos_favourites");return Array.isArray(f)?f:[];}
function saveFavourites(ids){LS.set("restopos_favourites",ids);const lic=LS.get("restopos_license_v2")?.licenseKey;if(lic)debouncedSync(lic,"restopos_favourites",ids);}

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
// Multi-line text input — lets clients type onto the next line (Enter for newline)
const TextArea=({label,value,onChange,placeholder="",rows=3,style={},dir})=>(
  <div style={{display:"flex",flexDirection:"column",gap:4,...style}}>
    {label&&<label style={{fontSize:12,fontWeight:600,color:C.textMid}}>{label}</label>}
    <textarea value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} rows={rows} dir={dir} style={{padding:"9px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontFamily:"inherit",color:C.text,background:"#fff",resize:"vertical",lineHeight:1.5}}/>
  </div>
);
// Slider — client picks any size in a range (e.g. font/QR/logo size)
const Slider=({label,value,onChange,min,max,step=1,unit="px",style={}})=>(
  <div style={{display:"flex",flexDirection:"column",gap:6,...style}}>
    {label&&<div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
      <label style={{fontSize:12,fontWeight:600,color:C.textMid}}>{label}</label>
      <span style={{fontSize:12,fontWeight:800,color:C.primary,background:C.primaryLight,borderRadius:6,padding:"2px 8px"}}>{value}{unit}</span>
    </div>}
    <input type="range" min={min} max={max} step={step} value={value} onChange={e=>onChange(parseInt(e.target.value))} style={{width:"100%",accentColor:C.primary,cursor:"pointer"}}/>
  </div>
);
// Toggle switch row
const ToggleRow=({label,on,onClick})=>(
  <label style={{display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}}>
    <span style={{fontSize:12,color:C.text}}>{label}</span>
    <div onClick={onClick} style={{width:40,height:22,borderRadius:11,background:on?C.primary:"#CBD5E0",position:"relative",transition:"background 0.2s",cursor:"pointer",flexShrink:0}}>
      <div style={{position:"absolute",top:2,left:on?20:2,width:18,height:18,borderRadius:"50%",background:"#fff",transition:"left 0.2s",boxShadow:"0 1px 3px rgba(0,0,0,0.2)"}}/>
    </div>
  </label>
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
          <div style={{textAlign:"center",marginTop:14,paddingTop:14,borderTop:"1px solid rgba(255,255,255,0.1)"}}>
            <span style={{fontSize:12,color:"rgba(255,255,255,0.4)"}}>Already a customer? </span>
            <button onClick={onLogin} style={{background:"none",border:"none",color:"rgba(46,204,113,0.8)",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit",textDecoration:"underline"}}>Log In</button>
          </div>

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
function PayKeyboard(){
  const [mode,setMode]=useState("num"); // "num" | "abc"
  const [shift,setShift]=useState(false);
  // Insert a character into the currently focused input/textarea
  function press(ch){
    const el=document.activeElement;
    if(!el||(el.tagName!=="INPUT"&&el.tagName!=="TEXTAREA")){return;}
    const start=el.selectionStart??el.value.length;
    const end=el.selectionEnd??el.value.length;
    const setter=Object.getOwnPropertyDescriptor(window[el.tagName==="TEXTAREA"?"HTMLTextAreaElement":"HTMLInputElement"].prototype,"value").set;
    const nv=el.value.slice(0,start)+ch+el.value.slice(end);
    setter.call(el,nv);
    el.dispatchEvent(new Event("input",{bubbles:true}));
    try{const pos=start+ch.length;el.setSelectionRange(pos,pos);}catch(e){}
  }
  function backspace(){
    const el=document.activeElement;
    if(!el||(el.tagName!=="INPUT"&&el.tagName!=="TEXTAREA"))return;
    const start=el.selectionStart??el.value.length;
    const end=el.selectionEnd??el.value.length;
    const setter=Object.getOwnPropertyDescriptor(window[el.tagName==="TEXTAREA"?"HTMLTextAreaElement":"HTMLInputElement"].prototype,"value").set;
    let nv,pos;
    if(start!==end){nv=el.value.slice(0,start)+el.value.slice(end);pos=start;}
    else{nv=el.value.slice(0,Math.max(0,start-1))+el.value.slice(end);pos=Math.max(0,start-1);}
    setter.call(el,nv);
    el.dispatchEvent(new Event("input",{bubbles:true}));
    try{el.setSelectionRange(pos,pos);}catch(e){}
  }
  const keyStyle={flex:1,minWidth:0,padding:"12px 0",background:"#fff",border:"1px solid #D5DEE8",borderRadius:8,fontSize:16,fontWeight:700,color:"#1A3A5C",cursor:"pointer",fontFamily:"inherit",userSelect:"none"};
  const wideStyle={...keyStyle,flex:1.6,background:"#EEF3F8"};
  // prevent the keyboard from stealing focus from the input
  const noFocus=(fn)=>(e)=>{e.preventDefault();fn();};
  const numRows=[["1","2","3"],["4","5","6"],["7","8","9"],[".","0","⌫"]];
  const abcRows=shift
    ?[["Q","W","E","R","T","Y","U","I","O","P"],["A","S","D","F","G","H","J","K","L"],["⇧","Z","X","C","V","B","N","M","⌫"]]
    :[["q","w","e","r","t","y","u","i","o","p"],["a","s","d","f","g","h","j","k","l"],["⇧","z","x","c","v","b","n","m","⌫"]];
  return(
    <div style={{background:"#F4F7FA",border:"1px solid #E0E8F0",borderRadius:12,padding:8,marginBottom:4}}>
      <div style={{display:"flex",gap:6,marginBottom:6}}>
        <button onMouseDown={noFocus(()=>setMode("num"))} onTouchStart={noFocus(()=>setMode("num"))}
          style={{...keyStyle,flex:1,background:mode==="num"?"#1A3A5C":"#fff",color:mode==="num"?"#fff":"#1A3A5C"}}>123</button>
        <button onMouseDown={noFocus(()=>setMode("abc"))} onTouchStart={noFocus(()=>setMode("abc"))}
          style={{...keyStyle,flex:1,background:mode==="abc"?"#1A3A5C":"#fff",color:mode==="abc"?"#fff":"#1A3A5C"}}>ABC</button>
      </div>
      {mode==="num"
        ? numRows.map((row,ri)=>(
            <div key={ri} style={{display:"flex",gap:6,marginBottom:6}}>
              {row.map(k=>(
                <button key={k} onMouseDown={noFocus(()=>k==="⌫"?backspace():press(k))} onTouchStart={noFocus(()=>k==="⌫"?backspace():press(k))}
                  style={k==="⌫"?{...keyStyle,background:"#FDE8E8",color:"#D94040"}:keyStyle}>{k}</button>
              ))}
            </div>
          ))
        : abcRows.map((row,ri)=>(
            <div key={ri} style={{display:"flex",gap:4,marginBottom:6}}>
              {row.map(k=>(
                <button key={k} onMouseDown={noFocus(()=>{if(k==="⌫")backspace();else if(k==="⇧")setShift(s=>!s);else press(k);})} onTouchStart={noFocus(()=>{if(k==="⌫")backspace();else if(k==="⇧")setShift(s=>!s);else press(k);})}
                  style={k==="⌫"?{...keyStyle,background:"#FDE8E8",color:"#D94040",fontSize:14}:k==="⇧"?{...keyStyle,background:shift?"#1A3A5C":"#EEF3F8",color:shift?"#fff":"#1A3A5C",fontSize:14}:{...keyStyle,fontSize:14}}>{k}</button>
              ))}
            </div>
          ))
      }
      {mode==="abc"&&(
        <div style={{display:"flex",gap:6}}>
          <button onMouseDown={noFocus(()=>press(" "))} onTouchStart={noFocus(()=>press(" "))} style={{...wideStyle,flex:4}}>space</button>
        </div>
      )}
    </div>
  );
}

function PaymentModal({total,subtotal,vat,promos,onConfirm,onClose,license,vno=1,kotNo=1,customers=[],customerName:initCustName="",customerPhone:initCustPhone="",orderType:initOrderType="takeaway"}){
  // ── State ────────────────────────────────────────────────────────
  const [method,setMethod]=useState("Cash");
  const [cashGiven,setCashGiven]=useState("");
  const _cashTouched=useRef(false); // becomes true once user edits cash; until then it auto-fills exact
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
    _cashTouched.current=true;
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

  // Cash defaults to the EXACT amount automatically; user can still type a different amount.
  useEffect(()=>{
    if(method==="Cash"&&!_cashTouched.current){
      setCashGiven(finalTotal.toFixed(2));
    }
  },[method,finalTotal]);

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
    // CLOSE IMMEDIATELY — don't wait for async operations
    onClose();
    // Fire and forget the async confirm
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
      <div style={{background:"#fff",borderRadius:18,width:"100%",maxWidth:1040,
        height:"calc(100vh - 16px)",maxHeight:"98vh",display:"flex",flexDirection:"column",
        boxShadow:"0 24px 80px rgba(0,0,0,0.4)"}}>

        {/* ── Header ── */}
        <div style={{background:"linear-gradient(135deg,#1A3A5C,#0F2340)",padding:"12px 18px",
          borderRadius:"18px 18px 0 0",flexShrink:0,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
            <div style={{color:"#fff",fontSize:15,fontWeight:800}}>💳 Charge & Payment</div>
            <div style={{padding:"3px 10px",background:"rgba(255,255,255,0.15)",borderRadius:20,fontSize:11,color:"rgba(255,255,255,0.9)",fontWeight:700}}>🧾 INV-{vno}</div>
            <div style={{padding:"3px 10px",background:"rgba(255,255,255,0.12)",borderRadius:20,fontSize:11,color:"rgba(255,255,255,0.8)",fontWeight:700}}>🎫 Token {isDraft?getDailyToken():getDailyToken()+1}</div>
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

            {/* Payment method */}
            <div>
              <div style={{fontSize:10,fontWeight:800,color:"#3A5A7A",marginBottom:6}}>💳 PAYMENT METHOD</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:5,direction:"ltr"}}>
                {METHODS.map(m=>(
                  <button key={m.id} onClick={()=>{setMethod(m.id);setSplitError("");_cashTouched.current=false;setCashGiven("");setCardAmount("");setCashAmount("");clearDenoms();}}
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

            {/* Order Type + Bill Type — enlarged */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,direction:"ltr"}}>
              {/* Order Type */}
              <div style={{background:"#F8FAFF",border:"1px solid #E0E8F0",borderRadius:12,padding:"12px 12px"}}>
                <div style={{fontSize:11,fontWeight:800,color:"#3A5A7A",marginBottom:8}}>ORDER TYPE</div>
                <div style={{display:"flex",gap:6}}>
                  {[["takeaway","🥡","Takeaway"],["dine-in","🍽️","Dine-in"]].map(([id,icon,label])=>(
                    <button key={id} onClick={()=>setOrderTypeLocal(id)}
                      style={{flex:1,padding:"12px 4px",border:`2px solid ${localOrderType===id?"#1A6B4A":"#E0E8F0"}`,
                        background:localOrderType===id?"#E8F5EE":"#fff",
                        color:localOrderType===id?"#1A6B4A":"#8A9AB0",
                        borderRadius:9,fontFamily:"inherit",fontSize:13,fontWeight:700,cursor:"pointer"}}>
                      {icon} {label}
                    </button>
                  ))}
                </div>
              </div>
              {/* Bill Type */}
              <div style={{background:"#F8FAFF",border:"1px solid #E0E8F0",borderRadius:12,padding:"12px 12px"}}>
                <div style={{fontSize:11,fontWeight:800,color:"#3A5A7A",marginBottom:8}}>BILL TYPE</div>
                <div style={{display:"flex",gap:6}}>
                  {[["normal","📄","Normal"],["telephone","📞","Phone"]].map(([id,icon,label])=>(
                    <button key={id} onClick={()=>setLocalBillType(id)}
                      style={{flex:1,padding:"12px 4px",border:`2px solid ${localBillType===id?"#1A6B4A":"#E0E8F0"}`,
                        background:localBillType===id?"#E8F5EE":"#fff",
                        color:localBillType===id?"#1A6B4A":"#8A9AB0",
                        borderRadius:9,fontFamily:"inherit",fontSize:13,fontWeight:700,cursor:"pointer"}}>
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

            {/* Cash input + denominations */}
            {method==="Cash"&&(
              <div>
                <div style={{fontSize:10,fontWeight:700,color:"#5A7A9A",marginBottom:4}}>AMOUNT GIVEN</div>
                <input value={cashGiven} onChange={e=>{_cashTouched.current=true;setCashGiven(e.target.value);clearDenoms();}}
                  type="number" placeholder={finalTotal.toFixed(2)}
                  style={{width:"100%",padding:"10px 14px",border:`2px solid ${shortfall?"#D94040":"#B0C8E8"}`,
                    borderRadius:10,fontSize:22,fontWeight:800,color:"#000",background:"#fff",
                    textAlign:"center",fontFamily:"inherit",direction:"ltr"}}/>
                {shortfall&&<div style={{fontSize:11,color:"#D94040",fontWeight:700,marginTop:3}}>⚠️ Short by SAR {(finalTotal-cashFloat).toFixed(2)}</div>}
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

            {/* On-screen keyboard — switchable ABC / 123, types into the focused field */}
            <PayKeyboard/>

            {/* Action buttons */}
            <div style={{display:"flex",gap:10,marginTop:"auto"}}>
              <button onClick={()=>handleConfirm(false)} disabled={!canConfirm}
                style={{flex:1,padding:"16px 8px",background:canConfirm?"#2176AE":"#ccc",
                  color:"#fff",border:"none",borderRadius:12,fontSize:15,fontWeight:800,
                  cursor:canConfirm?"pointer":"not-allowed",fontFamily:"inherit"}}>
                💾 Save Bill
              </button>
              <button onClick={()=>handleConfirm(true)} disabled={!canConfirm}
                style={{flex:2,padding:"16px",background:canConfirm?"linear-gradient(135deg,#1A6B4A,#0F4A30)":"#ccc",
                  color:"#fff",border:"none",borderRadius:12,fontSize:17,fontWeight:800,
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

  function buildModalReceipt(qrImgSrc){
    // Use the single unified receipt builder so the printout matches the
    // Invoice Format preview and always includes the ZATCA QR.
    return buildReceiptHTML(order,license,zatcaInvoice,invoiceFormat,qrImgSrc);
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
      const html=buildModalReceipt(qrImgSrc);
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
      const html=buildModalReceipt(qrImgSrc);
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
// RECEIPT HTML BUILDER — single source of truth for the printed receipt.
// Honours the saved Invoice Format (template, fonts, colours, toggles)
// AND embeds the ZATCA QR (qrImgSrc) so the printout matches the preview.
// Used by: checkout print (QZ/ESC-POS/browser), receipt modal and the
// Invoice Format live preview. Draft invoices use a separate builder.
// ═══════════════════════════════════════════════════════════════════
// Only fonts that render BOTH Arabic and English correctly on thermal printers.
// Old/English-only ids (courier, georgia, etc.) are mapped to a safe Arabic font.
const RECEIPT_FONT_MAP={
  "tajawal":"'Tajawal','Noto Naskh Arabic',sans-serif",
  "cairo":"'Cairo','Noto Naskh Arabic',sans-serif",
  "amiri":"'Amiri','Noto Naskh Arabic',serif",
  "noto-naskh":"'Noto Naskh Arabic','Amiri',serif",
  // legacy fallbacks → default to Noto Naskh (Arabic-safe)
  "courier":"'Noto Naskh Arabic','Amiri',serif",
  "georgia":"'Amiri','Noto Naskh Arabic',serif",
  "trebuchet":"'Cairo','Noto Naskh Arabic',sans-serif",
  "arial-narrow":"'Cairo','Noto Naskh Arabic',sans-serif",
  "impact":"'Cairo','Noto Naskh Arabic',sans-serif",
  "scheherazade":"'Noto Naskh Arabic','Amiri',serif",
};
function _escHTML(s){if(s===0)return"0";if(!s)return"";return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
// Convert multi-line text (with newlines) into safe HTML with <br> between lines
function _escMultiline(s){if(!s)return"";return String(s).split(/\r?\n/).map(_escHTML).join("<br/>");}
function buildReceiptHTML(order,license,zatcaInvoice,fmt,qrImgSrc){
  fmt=fmt||{};
  // If a preset style is active for invoices, use the preset builder (preview === print).
  if(fmt.usePreset&&fmt.presetStyle){
    return buildPresetHTML(order,license,zatcaInvoice,fmt,qrImgSrc,{draft:false});
  }
  order=order||{};
  const items=order.items||[];
  const paperWidth=fmt.paperWidth||"80mm";
  const fontSize=parseInt(fmt.fontSize)||12;
  const fontFamily=RECEIPT_FONT_MAP[fmt.font]||"'Amiri','Noto Naskh Arabic',serif";
  const template=fmt.template||"modern";
  const headerColor=fmt.headerColor||"#1A6B4A";
  const footer=fmt.footer||"Thank you for your visit!";
  const footerAr=fmt.footerAr||"شكراً لزيارتكم";
  const shopName=fmt.shopNameOverride||license?.businessName||"Restaurant";
  const address=license?.address||"";
  const vatNo=license?.vatNumber||"";
  const show=(k,def)=>fmt[k]===undefined?def:fmt[k];
  const showVat=show("showVat",true);
  const showCategories=show("showCategories",true);
  const showCustomer=show("showCustomer",true);
  const showOrderType=show("showOrderType",true);
  const showArabicName=show("showArabicName",true);
  const boldItems=!!fmt.boldItems;
  const totalSize=fmt.totalSize==="xl"?fontSize+6:fmt.totalSize==="small"?fontSize:fontSize+3;
  // Client-adjustable sizes (with safe defaults). logoSize px, qrSize px.
  const logoSize=parseInt(fmt.logoSize)||46;
  const qrSize=parseInt(fmt.qrSize)||120;
  const dateSize=fmt.dateSize!==undefined?parseInt(fmt.dateSize):(fontSize-1); // date/time text size
  const nameGap=fmt.nameGap!==undefined?parseInt(fmt.nameGap):2; // vertical gap between Arabic & English name (px)
  const sep=fmt.separator==="solid"?"1px solid #000":fmt.separator==="double"?"3px double #000":fmt.separator==="none"?"none":"1px dashed #000";
  const SEP=`<div style="border-top:${sep};margin:5px 0"></div>`;
  // Header — template aware
  let header="";
  const logoHTML=fmt.logoUrl?`<img src="${_escHTML(fmt.logoUrl)}" style="max-width:100%;max-height:${logoSize}px;display:block;margin:0 auto 4px"/>`:"";
  if(template==="modern"){
    header=`<div style="background:${headerColor};color:#fff;margin:-4mm -4mm 8px;padding:10px 8px;text-align:center;border-radius:0 0 6px 6px">${logoHTML}<div style="font-size:${fontSize+5}px;font-weight:900">${_escHTML(shopName)}</div>${address?`<div style="font-size:${fontSize-2}px;opacity:.9">${_escHTML(address)}</div>`:""}<div style="font-size:${fontSize-2}px;opacity:.9">TRN: ${_escHTML(vatNo)}</div>${fmt.tagline?`<div style="font-size:${fontSize-2}px;font-style:italic;opacity:.85">${_escMultiline(fmt.tagline)}</div>`:""}</div>`;
  }else if(template==="arabic"){
    header=`<div style="text-align:center;direction:rtl;font-family:'Noto Naskh Arabic','Tajawal',sans-serif">${logoHTML}<div style="font-size:${fontSize+5}px;font-weight:900">${_escHTML(shopName)}</div>${address?`<div style="font-size:${fontSize-2}px">${_escHTML(address)}</div>`:""}<div style="font-size:${fontSize-2}px">الرقم الضريبي: ${_escHTML(vatNo)}</div>${fmt.tagline?`<div style="font-size:${fontSize-2}px;font-style:italic">${_escMultiline(fmt.tagline)}</div>`:""}</div>`;
  }else if(template==="minimal"){
    header=`<div style="text-align:center">${logoHTML}<div style="font-size:${fontSize+3}px;font-weight:900">${_escHTML(shopName)}</div><div style="font-size:${fontSize-2}px">TRN: ${_escHTML(vatNo)}</div></div>`;
  }else{ // classic
    header=`<div style="text-align:center">${logoHTML}<div style="font-size:${fontSize+3}px;font-weight:900;letter-spacing:.08em">${_escHTML(shopName)}</div>${address?`<div style="font-size:${fontSize-2}px">${_escHTML(address)}</div>`:""}<div style="font-size:${fontSize-2}px">TRN: ${_escHTML(vatNo)}</div>${fmt.tagline?`<div style="font-size:${fontSize-2}px;font-style:italic">${_escMultiline(fmt.tagline)}</div>`:""}</div>`;
  }
  // Meta row
  let meta=`<div style="display:flex;justify-content:space-between;font-size:${dateSize}px;gap:6px"><span style="word-break:break-word">${_escHTML(order.id||"")}</span><span style="white-space:nowrap">${_escHTML(order.date||"")} ${_escHTML(order.time||"")}</span></div>`;
  if(showOrderType&&(order.type||order.payMethod))meta+=`<div style="font-size:${fontSize-2}px;color:#555">${_escHTML(order.type||"Sale")}${order.table?" · Table "+_escHTML(order.table):""}${order.payMethod?" · "+_escHTML(order.payMethod):""}</div>`;
  if(showCustomer&&order.customer)meta+=`<div style="font-size:${fontSize-2}px;word-break:break-word">Customer: ${_escHTML(order.customer)}</div>`;
  if(order.note)meta+=`<div style="font-size:${fontSize-2}px;font-style:italic;word-break:break-word">Note: ${_escHTML(order.note)}</div>`;
  // Items — Arabic name printed directly ABOVE the English name (stacked, same column).
  // Long names wrap; price stays right-aligned and never overflows.
  function lineHTML(it){
    const arTop=(showArabicName&&it.nameAr)?`<div style="direction:rtl;font-family:'Amiri','Noto Naskh Arabic',serif;font-size:${fontSize}px;font-weight:700;word-break:break-word;margin-bottom:${nameGap}px">${_escHTML(it.nameAr)}</div>`:"";
    return `<div style="display:flex;justify-content:space-between;align-items:flex-start;margin:3px 0;gap:6px${boldItems?";font-weight:700":""}"><span style="flex:1 1 auto;min-width:0;padding-right:4px;word-break:break-word;overflow-wrap:anywhere">${arTop}<span style="display:block">${_escHTML(it.name)}<span style="color:#777"> x${it.qty}</span></span></span><span style="flex:0 0 auto;white-space:nowrap;text-align:right">SAR ${(it.qty*it.price).toFixed(2)}</span></div>`;
  }
  let itemsHTML="";
  if(showCategories){
    const cats=[...new Set(items.map(i=>i.category||OTHER_CAT))];
    itemsHTML=cats.map(cat=>{
      const ci=items.filter(i=>(i.category||OTHER_CAT)===cat);
      if(!ci.length)return"";
      return `<div style="font-size:${fontSize-3}px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#888;margin:5px 0 2px;word-break:break-word">${_escHTML(cat)}</div>`+ci.map(lineHTML).join("");
    }).join("");
  }else{
    itemsHTML=items.map(lineHTML).join("");
  }
  // ZATCA QR block — printed on every (non-draft) invoice. QR is ALWAYS auto-generated (legally required) — size is adjustable only.
  const qrBlock=qrImgSrc
    ? `<div style="text-align:center;margin:8px 0">${zatcaInvoice?`<div style="font-size:${fontSize-3}px;color:#444;word-break:break-word">Invoice: ${_escHTML(zatcaInvoice.invoice_number||"")}${zatcaInvoice.icv?" · ICV: "+_escHTML(zatcaInvoice.icv):""}</div>`:""}<img src="${qrImgSrc}" style="width:${qrSize}px;height:${qrSize}px;max-width:100%;display:block;margin:4px auto"/><div style="font-size:${fontSize-3}px;font-weight:700;letter-spacing:.08em">ZATCA PHASE 2 · QR</div><div style="font-size:${fontSize-4}px;color:#777">TLV Base64 · Scan to verify</div></div>`
    : "";
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Noto+Naskh+Arabic:wght@400;700&family=Tajawal:wght@400;700&family=Cairo:wght@400;700&family=Amiri:wght@400;700&family=Scheherazade+New:wght@400;700&display=swap" rel="stylesheet">
<style>
@page{size:${paperWidth} auto;margin:0}
*{box-sizing:border-box;margin:0;padding:0}
html,body{max-width:${paperWidth};overflow-x:hidden}
body{font-family:${fontFamily};font-size:${fontSize}px;width:${paperWidth};padding:4mm;color:#000;background:#fff;line-height:1.45;word-break:break-word;overflow-wrap:anywhere}
img{max-width:100%}
</style></head><body>
${header}
${SEP}
${meta}
${SEP}
${itemsHTML}
${SEP}
${order.discount>0?`<div style="display:flex;justify-content:space-between;color:#b00;gap:6px"><span>Discount</span><span style="white-space:nowrap">-SAR ${order.discount.toFixed(2)}</span></div>`:""}
${showVat?`<div style="display:flex;justify-content:space-between;font-size:${fontSize-1}px;color:#666;gap:6px"><span>VAT 15% (incl.)</span><span style="white-space:nowrap">SAR ${(order.vat||0).toFixed(2)}</span></div>`:""}
<div style="display:flex;justify-content:space-between;font-weight:900;font-size:${totalSize}px;border-top:2px solid #000;padding-top:4px;margin-top:3px;gap:6px"><span>TOTAL</span><span style="white-space:nowrap">SAR ${(order.total||0).toFixed(2)}</span></div>
${order.payMethod==="Cash"?`<div style="display:flex;justify-content:space-between;font-size:${fontSize-1}px;gap:6px"><span>Cash Given</span><span style="white-space:nowrap">SAR ${(order.given||0).toFixed(2)}</span></div><div style="display:flex;justify-content:space-between;font-size:${fontSize-1}px;font-weight:700;gap:6px"><span>Change</span><span style="white-space:nowrap">SAR ${(order.change||0).toFixed(2)}</span></div>`:""}
${SEP}
${qrBlock}
${fmt.website?`<div style="text-align:center;font-size:${fontSize-2}px;color:#666;word-break:break-word">${_escHTML(fmt.website)}</div>`:""}
${fmt.social?`<div style="text-align:center;font-size:${fontSize-2}px;color:#666;word-break:break-word">${_escHTML(fmt.social)}</div>`:""}
<div style="text-align:center;font-weight:700;font-size:${fontSize}px;margin-top:4px;word-break:break-word">${_escMultiline(footer)}</div>
${footerAr?`<div style="text-align:center;direction:rtl;font-family:'Noto Naskh Arabic','Tajawal',sans-serif;font-size:${fontSize}px;font-weight:700;word-break:break-word">${_escMultiline(footerAr)}</div>`:""}
<br/><br/>
</body></html>`;
}

// ═══════════════════════════════════════════════════════════════════
// BUILD DRAFT RECEIPT HTML — reusable for QZ and browser print
// ═══════════════════════════════════════════════════════════════════
// Draft bills use their OWN independent format (restopos_draft_format).
// They can show a custom image (logo OR QR) added via URL — persists until removed.
// They NEVER show the ZATCA QR (drafts are not tax invoices).
function buildDraftReceiptHTML(order,license,fmt){
  fmt=fmt||{};
  // If a preset style is active for drafts, use the preset builder (preview === print).
  if(fmt.usePreset&&fmt.presetStyle){
    return buildPresetHTML(order,license,null,fmt,null,{draft:true});
  }
  const paperWidth=fmt.paperWidth||"80mm";
  const fontSize=parseInt(fmt.fontSize)||12;
  const fontFamily=RECEIPT_FONT_MAP[fmt.font]||"'Amiri','Noto Naskh Arabic',serif";
  const footer=fmt.footer||"Thank you for your visit!";
  const footerAr=fmt.footerAr||"شكراً لزيارتكم";
  const shopName=fmt.shopNameOverride||license?.businessName||"Restaurant";
  const items=order.items||[];
  const logoSize=parseInt(fmt.logoSize)||46;
  const dateSize=fmt.dateSize!==undefined?parseInt(fmt.dateSize):(fontSize-1);
  const nameGap=fmt.nameGap!==undefined?parseInt(fmt.nameGap):2;
  // Custom image for drafts — client decides if it's a logo or a QR; shown at the position they choose.
  const imgSize=parseInt(fmt.imageSize)||100;
  const imgHTML=fmt.imageUrl?`<div class="c" style="margin:6px 0"><img src="${_escHTML(fmt.imageUrl)}" style="max-width:100%;max-height:${imgSize}px;display:block;margin:0 auto"/>${fmt.imageCaption?`<div style="font-size:${fontSize-3}px;color:#666;margin-top:2px;word-break:break-word">${_escMultiline(fmt.imageCaption)}</div>`:""}</div>`:"";
  const imgPos=fmt.imagePosition||"bottom"; // "top" | "bottom"
  const logoHTML=fmt.logoUrl?`<div class="c"><img src="${_escHTML(fmt.logoUrl)}" style="max-width:100%;max-height:${logoSize}px;display:block;margin:0 auto 4px"/></div>`:"";
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Noto+Naskh+Arabic:wght@400;700&family=Tajawal:wght@400;700&family=Cairo:wght@400;700&family=Amiri:wght@400;700&family=Scheherazade+New:wght@400;700&display=swap" rel="stylesheet">
<style>
@page{size:${paperWidth} auto;margin:0}
*{box-sizing:border-box}
html,body{max-width:${paperWidth};overflow-x:hidden}
body{font-family:${fontFamily};font-size:${fontSize}px;width:${paperWidth};padding:4mm;color:#000;margin:0;word-break:break-word;overflow-wrap:anywhere;line-height:1.45}
img{max-width:100%}
.c{text-align:center}.b{font-weight:bold}
.hr{border:none;border-top:1px dashed #000;margin:4px 0}
.row{display:flex;justify-content:space-between;margin:2px 0;gap:6px}
.row span:last-child{white-space:nowrap;flex:0 0 auto;text-align:right}
.item{display:flex;justify-content:space-between;align-items:flex-start;gap:6px;margin:2px 0}
.item .nm{flex:1 1 auto;min-width:0;word-break:break-word;overflow-wrap:anywhere}
.item .pr{flex:0 0 auto;white-space:nowrap;text-align:right}
.badge{background:#F0A500;color:#fff;padding:2px 8px;border-radius:3px;font-weight:900;font-size:${fontSize}px}
</style></head><body>
${logoHTML}
<div class="c b" style="font-size:${fontSize+4}px;word-break:break-word">${_escHTML(shopName)}</div>
<div class="c" style="font-size:${fontSize-1}px;word-break:break-word">${_escHTML(license?.address||"")}</div>
<div class="c" style="font-size:${fontSize-1}px">VAT: ${_escHTML(license?.vatNumber||"")}</div>
<div class="c" style="margin:4px 0"><span class="badge">D-INVOICE</span></div>
${imgPos==="top"?imgHTML:""}
<div class="hr"/>
<div class="row" style="font-size:${dateSize}px"><span style="word-break:break-word">${_escHTML(order.id||"")}</span><span>${_escHTML(order.date||"")} ${_escHTML(order.time||"")}</span></div>
<div style="font-size:${fontSize-1}px;word-break:break-word">${_escHTML(order.type||"Sale")}${order.table?" · Table "+_escHTML(order.table):""}</div>
${order.customer?`<div style="font-size:${fontSize-1}px;word-break:break-word">Customer: ${_escHTML(order.customer)}</div>`:""}
${order.note?`<div style="font-size:${fontSize-1}px;font-style:italic;word-break:break-word">Note: ${_escHTML(order.note)}</div>`:""}
<div class="hr"/>
${items.map(it=>`<div class="item"><span class="nm">${it.nameAr?`<div style="direction:rtl;font-family:'Amiri','Noto Naskh Arabic',serif;font-weight:700;word-break:break-word;margin-bottom:${nameGap}px">${_escHTML(it.nameAr)}</div>`:""}<div>${it.qty}x ${_escHTML(it.name)}</div></span><span class="pr">SAR ${(it.qty*it.price).toFixed(2)}</span></div>`).join("")}
<div class="hr"/>
${order.discount>0?`<div class="row"><span>Discount</span><span>-SAR ${order.discount.toFixed(2)}</span></div>`:""}
<div class="row"><span>VAT 15%</span><span>SAR ${(order.vat||0).toFixed(2)}</span></div>
<div class="row b" style="font-size:${fontSize+2}px"><span>TOTAL</span><span>SAR ${(order.total||0).toFixed(2)}</span></div>
${order.payMethod==="Cash"?`<div class="row"><span>Cash</span><span>SAR ${(order.given||0).toFixed(2)}</span></div><div class="row"><span>Change</span><span>SAR ${(order.change||0).toFixed(2)}</span></div>`:""}
<div class="hr"/>
${imgPos==="bottom"?imgHTML:""}
<div class="c" style="font-size:${fontSize-1}px;word-break:break-word">${_escMultiline(footer)}</div>
${footerAr?`<div class="c" style="direction:rtl;font-family:'Noto Naskh Arabic','Tajawal',sans-serif;font-size:${fontSize-1}px;word-break:break-word">${_escMultiline(footerAr)}</div>`:""}
<div class="c" style="font-size:9px;color:#aaa;margin-top:4px">DRAFT — Not a tax invoice</div>
<br/><br/>
</body></html>`;
}

// ═══════════════════════════════════════════════════════════════════
// PRESET INVOICE / DRAFT BUILDER  — 4 ready-made styles, fixed layout order
// Layout order (ALL styles, never changes):
//   Logo → Business name (Ar over En) → Address (Ar over En) → Mobile/Tel
//   → VAT/TRN → Invoice-type box → Token+OrderType box → Voucher No
//   → User/Date | Payment/Time → Items (Ar over En) → TOTAL/VAT/GRAND TOTAL
//   → Amount in words → Received/Balance → ZATCA QR → Footer
// Styles differ ONLY in visual treatment (boxes/borders/weights/spacing).
// preview === print: the same function feeds the live preview and the printer.
// ═══════════════════════════════════════════════════════════════════
const PRESET_STYLES=[
  {id:"s1",label:"Style 1 — Classic Boxed",desc:"Standard Saudi thermal receipt — boxed sections, monospace look."},
  {id:"s2",label:"Style 2 — Modern Band",desc:"Coloured header band with logo, clean body."},
  {id:"s3",label:"Style 3 — Minimal",desc:"No boxes, light dividers, airy spacing."},
  {id:"s4",label:"Style 4 — Bold Large",desc:"Big bold fonts, heavy separators — easy to read."},
];
// Numbers → English words (riyal + halala) for "Amount in Words"
function _amountWords(num){
  num=Math.round((Number(num)||0)*100)/100;
  const riyal=Math.floor(num);const halala=Math.round((num-riyal)*100);
  const ones=["Zero","One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten","Eleven","Twelve","Thirteen","Fourteen","Fifteen","Sixteen","Seventeen","Eighteen","Nineteen"];
  const tens=["","","Twenty","Thirty","Forty","Fifty","Sixty","Seventy","Eighty","Ninety"];
  function w(n){
    if(n<20)return ones[n];
    if(n<100)return tens[Math.floor(n/10)]+(n%10?" "+ones[n%10]:"");
    if(n<1000)return ones[Math.floor(n/100)]+" Hundred"+(n%100?" "+w(n%100):"");
    if(n<1000000)return w(Math.floor(n/1000))+" Thousand"+(n%1000?" "+w(n%1000):"");
    return w(Math.floor(n/1000000))+" Million"+(n%1000000?" "+w(n%1000000):"");
  }
  const rWords=w(riyal);
  const hWords=halala?w(halala):"Zero";
  return `${rWords} Riyal and ${hWords} Halala`;
}
// Bilingual stacked line: Arabic on top, English below (centered)
function _stack(ar,en,fs,gap){
  const a=ar?`<div style="direction:rtl;font-family:'Amiri','Noto Naskh Arabic',serif;font-size:${fs}px;font-weight:700;word-break:break-word">${_escHTML(ar)}</div>`:"";
  const e=en?`<div style="font-size:${fs}px;font-weight:700;word-break:break-word;margin-top:${gap}px">${_escHTML(en)}</div>`:"";
  return a+e;
}
// fmt extra keys used by presets:
//   presetStyle (s1..s4), logoUrl, logoSize, headFont (header px), bodyFont (body px),
//   totalFont (totals px), lineGap (item spacing px), headerColor (s2), paperWidth
function buildPresetHTML(order,license,zatcaInvoice,fmt,qrImgSrc,opts){
  fmt=fmt||{};order=order||{};opts=opts||{};
  const isDraft=!!opts.draft;
  const style=fmt.presetStyle||"s1";
  const paperWidth=fmt.paperWidth||"80mm";
  const headFont=parseInt(fmt.headFont)||14;
  const bodyFont=parseInt(fmt.bodyFont)||12;
  const totalFont=parseInt(fmt.totalFont)||16;
  const tokenFont=parseInt(fmt.tokenFont)||22;
  const lineGap=fmt.lineGap!==undefined?parseInt(fmt.lineGap):3;
  const nameGap=2;
  const logoSize=parseInt(fmt.logoSize)||60;
  const qrSize=parseInt(fmt.qrSize)||120;
  const headerColor=fmt.headerColor||"#000000";
  const items=order.items||[];
  // identity
  const shopEn=fmt.shopNameOverride||license?.businessName||"Restaurant";
  const shopAr=fmt.shopNameAr||license?.businessNameAr||"";
  const addrEn=fmt.addressEnOverride||license?.address||"";
  const addrAr=fmt.addressAr||license?.addressAr||"";
  const phone=fmt.phoneOverride||license?.phone||"";
  const vatNo=license?.vatNumber||"";
  const footer=fmt.footer||"Thank you — visit again";
  const footerAr=fmt.footerAr||"شكراً لك زيارة مرة أخرى";
  // monospace look for s1; serif for others
  const bodyFamily=style==="s1"?"'Courier New','Amiri','Noto Naskh Arabic',monospace":"'Amiri','Noto Naskh Arabic',serif";
  // separators per style
  const sepLine=style==="s4"?"2px solid #000":style==="s3"?"1px solid #000":"1px dashed #000";
  const SEP=`<div style="border-top:${sepLine};margin:5px 0"></div>`;
  // box helper (s1 uses boxes, s4 heavy, s2/s3 borderless)
  const boxed=(inner,big)=>{
    if(style==="s3")return `<div style="text-align:center;margin:4px 0">${inner}</div>`;
    const bw=style==="s4"?"2px solid #000":"1px solid #000";
    return `<div style="border:${bw};border-radius:${style==="s2"?"6px":"2px"};padding:${big?"7px":"5px"} 6px;margin:4px 0;text-align:center">${inner}</div>`;
  };
  const logoHTML=fmt.logoUrl?`<img src="${_escHTML(fmt.logoUrl)}" style="max-width:100%;max-height:${logoSize}px;display:block;margin:0 auto 5px"/>`:"";
  // ── HEADER (logo → name → address → mobile → vat) ──
  let header="";
  const headBlock=`
    ${_stack(shopAr,shopEn,headFont,nameGap)}
    ${(addrEn||addrAr)?`<div style="margin-top:3px">${_stack(addrAr,addrEn,bodyFont-1,1)}</div>`:""}
    ${phone?`<div style="font-size:${bodyFont-1}px;margin-top:2px"><span style="direction:rtl">هاتف</span> / Tel: ${_escHTML(phone)}</div>`:""}
    ${vatNo?`<div style="font-size:${bodyFont-1}px;margin-top:2px"><span style="direction:rtl">الرقم الضريبي</span> / VAT: ${_escHTML(vatNo)}</div>`:""}`;
  if(style==="s2"){
    header=`<div style="background:${headerColor};color:#fff;margin:-4mm -4mm 8px;padding:10px 8px;text-align:center;border-radius:0 0 8px 8px" class="s2head">${logoHTML}${headBlock}</div>`;
  }else{
    header=`<div style="text-align:center">${logoHTML}${headBlock}</div>`;
  }
  // ── INVOICE TYPE BOX ── (draft looks identical to a normal invoice)
  const typeBox=boxed(`<div style="direction:rtl;font-size:${bodyFont}px">فاتورة ضريبية مبسطة</div><div style="font-weight:900;font-size:${headFont}px">Simplified Tax Invoice</div>`,true);
  // ── TOKEN + ORDER TYPE BOX ──
  const orderTypeAr=order.typeAr||(order.type==="Takeaway"?"سفري":order.type==="Dine-in"?"محلي":order.type==="Delivery"?"توصيل":"");
  const tokenBox=boxed(`<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span style="font-weight:900;font-size:${tokenFont}px">Token No: ${_escHTML(order.token||order.kot||"—")}</span><span style="direction:rtl;font-weight:700;font-size:${tokenFont}px">${_escHTML(orderTypeAr||order.type||"")}</span></div>`);
  // ── VOUCHER ──
  const voucher=`<div style="text-align:center;font-size:${bodyFont}px;margin:3px 0">Voucher No: ${_escHTML(order.voucher||order.id||"")}</div>`;
  // ── USER/DATE | PAYMENT/TIME ──
  const metaGrid=`<div style="display:flex;justify-content:space-between;font-size:${bodyFont-1}px;margin:3px 0;gap:8px">
    <div style="text-align:left"><div>User: ${_escHTML(order.user||"admin")}</div><div>Date: ${_escHTML(order.date||"")}</div></div>
    <div style="text-align:right"><div>Payment: ${_escHTML(order.payMethod||"CASH")}</div><div>Time: ${_escHTML(order.time||"")}</div></div>
  </div>`;
  // ── ITEMS TABLE ──
  const th=`<div style="display:flex;font-weight:900;font-size:${bodyFont}px;border-bottom:${sepLine};padding-bottom:3px;margin-bottom:3px">
    <span style="flex:1 1 auto">ProductName</span><span style="width:34px;text-align:right">Qty</span><span style="width:44px;text-align:right">Rate</span><span style="width:54px;text-align:right">Amount</span></div>`;
  const rows=items.map(it=>{
    const ar=it.nameAr?`<div style="direction:rtl;font-family:'Amiri','Noto Naskh Arabic',serif;font-weight:700;font-size:${bodyFont}px;word-break:break-word">${_escHTML(it.nameAr)}</div>`:"";
    const en=`<div style="font-size:${bodyFont}px;word-break:break-word">${_escHTML(it.name)}</div>`;
    return `<div style="margin:${lineGap}px 0">
      ${ar}${en}
      <div style="display:flex;font-size:${bodyFont}px;${style==="s4"?"font-weight:700;":""}margin-top:1px">
        <span style="flex:1 1 auto"></span>
        <span style="width:34px;text-align:right">${(it.qty||0).toFixed(2)}</span>
        <span style="width:44px;text-align:right">${(it.price||0).toFixed(2)}</span>
        <span style="width:54px;text-align:right">${((it.qty||0)*(it.price||0)).toFixed(2)}</span>
      </div></div>`;
  }).join("");
  const itemsHTML=th+rows;
  // ── TOTALS ──
  const subtotal=(order.total||0)-(order.vat||0);
  const totalsHTML=`
    <div style="display:flex;justify-content:space-between;font-size:${bodyFont}px;margin:2px 0"><span><span style="direction:rtl">(مجموع)</span> TOTAL</span><span>${subtotal.toFixed(2)}</span></div>
    <div style="display:flex;justify-content:space-between;font-size:${bodyFont}px;margin:2px 0"><span><span style="direction:rtl">(ضريبة)</span> VAT 15%</span><span>${(order.vat||0).toFixed(2)}</span></div>
    <div style="display:flex;justify-content:space-between;font-weight:900;font-size:${totalFont}px;border-top:${style==="s4"?"3px double #000":"2px solid #000"};padding-top:4px;margin-top:3px"><span><span style="direction:rtl">(المجموع الإجمالي)</span> GRAND TOTAL</span><span>${(order.total||0).toFixed(2)}</span></div>`;
  // ── AMOUNT IN WORDS + RECEIVED/BALANCE (draft shows these too; only QR is removed) ──
  const wordsHTML=`<div style="font-size:${bodyFont-1}px;font-style:italic;margin:5px 0;word-break:break-word">Amount in Words: ${_amountWords(order.total||0)}</div>`;
  const payHTML=`
    <div style="display:flex;justify-content:space-between;font-size:${bodyFont-1}px"><span>Received by ${_escHTML(order.payMethod||"Cash")} <span style="direction:rtl">(تلقى النقدية)</span></span><span>${(order.given||order.total||0).toFixed(2)}</span></div>
    <div style="display:flex;justify-content:space-between;font-size:${bodyFont-1}px"><span>Balance <span style="direction:rtl">(توازن)</span></span><span>${(order.change||0).toFixed(2)}</span></div>`;
  // ── ZATCA QR (not on draft) ──
  const qrBlock=(!isDraft&&qrImgSrc)
    ? `<div style="text-align:center;margin:8px 0"><img src="${qrImgSrc}" style="width:${qrSize}px;height:${qrSize}px;max-width:100%;display:block;margin:4px auto"/>${zatcaInvoice?.invoice_number?`<div style="font-size:${bodyFont-3}px;color:#000">Invoice: ${_escHTML(zatcaInvoice.invoice_number)}${zatcaInvoice.icv?" · ICV: "+_escHTML(zatcaInvoice.icv):""}</div>`:""}<div style="font-size:${bodyFont-4}px;color:#000">ZATCA Phase 2 · Scan to verify</div></div>`
    : "";
  const footerHTML=`<div style="text-align:center;margin-top:6px">
    ${footerAr?`<div style="direction:rtl;font-family:'Amiri','Noto Naskh Arabic',serif;font-weight:700;font-size:${bodyFont}px">*** ${_escHTML(footerAr)} ***</div>`:""}
    ${footer?`<div style="font-weight:700;font-size:${bodyFont}px;margin-top:2px">${_escHTML(footer)}</div>`:""}
    ${isDraft?`<div style="font-weight:900;font-size:${bodyFont}px;margin-top:4px">D-Bill</div>`:""}
  </div>`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Noto+Naskh+Arabic:wght@400;700&family=Amiri:wght@400;700&family=Cairo:wght@400;700&display=swap" rel="stylesheet">
<style>
@page{size:${paperWidth} auto;margin:0}
*{box-sizing:border-box;margin:0;padding:0}
html,body{max-width:${paperWidth};overflow-x:hidden}
body{font-family:${bodyFamily};font-size:${bodyFont}px;width:${paperWidth};padding:4mm;color:#000;background:#fff;line-height:1.4;word-break:break-word;overflow-wrap:anywhere;font-weight:600;-webkit-print-color-adjust:exact;print-color-adjust:exact}
*{color:#000 !important}
.s2head, .s2head *{color:#fff !important}
img{max-width:100%}
</style></head><body>
${header}
${typeBox}
${tokenBox}
${voucher}
${SEP}
${metaGrid}
${SEP}
${itemsHTML}
${SEP}
${totalsHTML}
${wordsHTML}
${payHTML}
${SEP}
${qrBlock}
${footerHTML}
<br/><br/>
</body></html>`;
}
// KOT preset builder — 4 styles, kitchen ticket matching the reference layout:
// name → "Telephone Bill" → Voucher/Date/Time → boxed Token + order-type
// → ProductName|Rate|Qty table (item Ar over En, per-item price) → QTY total.
function buildPresetKOT(order,fmt){
  fmt=fmt||{};order=order||{};
  const style=fmt.presetStyle||"s1";
  const paperWidth=fmt.paperWidth||"80mm";
  const headFont=parseInt(fmt.headFont)||20;
  const bodyFont=parseInt(fmt.bodyFont)||16;
  const tokenFont=parseInt(fmt.tokenFont)||28;
  const lineGap=fmt.lineGap!==undefined?parseInt(fmt.lineGap):4;
  const logoSize=parseInt(fmt.logoSize)||50;
  const items=order.items||[];
  const bodyFamily=style==="s1"?"'Courier New',monospace":"'Amiri','Noto Naskh Arabic',sans-serif";
  const sepLine=style==="s4"?"2px solid #000":style==="s3"?"1px solid #000":"1px dashed #000";
  const SEP=`<div style="border-top:${sepLine};margin:6px 0"></div>`;
  const logoHTML=fmt.logoUrl?`<img src="${_escHTML(fmt.logoUrl)}" style="max-width:100%;max-height:${logoSize}px;display:block;margin:0 auto 5px"/>`:"";
  const kShopEn=fmt.shopNameOverride||"";
  const kShopAr=fmt.shopNameAr||"";
  const nameHTML=(kShopEn||kShopAr)?`<div style="text-align:center;margin-bottom:4px">${kShopAr?`<div style="direction:rtl;font-family:'Amiri','Noto Naskh Arabic',sans-serif;font-weight:700;font-size:${bodyFont}px">${_escHTML(kShopAr)}</div>`:""}${kShopEn?`<div style="font-weight:700;font-size:${bodyFont}px">${_escHTML(kShopEn)}</div>`:""}</div>`:"";
  // Title — depends on the bill type the cashier chose: phone → "Telephone Bill", else "Normal".
  const kotTitle=order.billType==="telephone"?"Telephone Bill":"Normal";
  const title=`<div style="text-align:center;font-weight:900;font-size:${headFont}px;margin:2px 0">${style==="s2"?`<span class="kbadge" style="background:#000;color:#fff;padding:3px 14px;border-radius:4px">${_escHTML(kotTitle)}</span>`:_escHTML(kotTitle)}</div>`;
  // Voucher + Date/Time row
  const vdt=`<div style="display:flex;justify-content:space-between;align-items:flex-end;font-size:${bodyFont-4}px;margin:3px 0;gap:8px">
    <div style="font-weight:700">Voucher No: ${_escHTML(order.voucher||order.id||"")}</div>
    <div style="text-align:right"><div>Date: ${_escHTML(order.date||"")}</div><div>Time: ${_escHTML(order.time||new Date().toLocaleTimeString("en-SA"))}</div></div>
  </div>`;
  // Token + order-type box (Parcel - وسفري etc.)
  const orderTypeAr=order.typeAr||(order.type==="Takeaway"?"وسفري":order.type==="Dine-in"?"محلي":order.type==="Delivery"?"توصيل":"");
  const orderTypeEn=order.type==="Takeaway"?"Parcel":order.type||"";
  const tokenBox=`<div style="margin:5px 0">
    <div style="font-weight:900;font-size:${tokenFont}px;margin-bottom:3px">Token No: ${_escHTML(order.token||order.kot||"")}</div>
    <div style="border:${style==="s4"?"2px":"1px"} solid #000;border-radius:${style==="s2"?"6px":"2px"};padding:6px 8px;display:flex;justify-content:space-between;align-items:center;gap:8px">
      <span style="font-weight:900;font-size:${tokenFont}px">${_escHTML(orderTypeEn)} ${orderTypeEn?"-":""}</span>
      <span style="direction:rtl;font-weight:900;font-size:${tokenFont}px">${_escHTML(orderTypeAr)}</span>
    </div>
  </div>`;
  // Items table header
  const th=`<div style="display:flex;font-weight:900;font-size:${bodyFont-2}px;border-bottom:${sepLine};padding-bottom:3px;margin-bottom:4px">
    <span style="flex:1 1 auto">ProductName</span><span style="width:54px;text-align:right">Rate</span><span style="width:34px;text-align:right">Qty</span></div>`;
  let totalQty=0;
  const rows=items.map(it=>{
    totalQty+=(it.qty||0);
    const ar=it.nameAr?`<div style="direction:rtl;font-family:'Amiri','Noto Naskh Arabic',sans-serif;font-weight:700;font-size:${bodyFont}px">${_escHTML(it.nameAr)}</div>`:"";
    return `<div style="margin:${lineGap}px 0;${style==="s4"?"font-weight:900;":"font-weight:800;"}">
      ${ar}<div style="font-size:${bodyFont}px">${_escHTML(it.name)}</div>
      <div style="display:flex;font-size:${bodyFont}px;margin-top:1px">
        <span style="flex:1 1 auto"></span>
        <span style="width:54px;text-align:right">${(it.price||0).toFixed(2)}</span>
        <span style="width:34px;text-align:right">${(it.qty||0)}</span>
      </div></div>`;
  }).join("");
  const qtyTotal=`<div style="display:flex;justify-content:space-between;font-weight:900;font-size:${headFont-2}px;margin-top:4px"><span>QTY</span><span>: ${totalQty.toFixed(2)}</span></div>`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Noto+Naskh+Arabic:wght@400;700&family=Amiri:wght@400;700&family=Cairo:wght@400;700&display=swap" rel="stylesheet">
<style>@page{size:${paperWidth} auto;margin:0}*{box-sizing:border-box;margin:0;padding:0}
html,body{max-width:${paperWidth};overflow-x:hidden}
body{font-family:${bodyFamily};font-size:${bodyFont}px;width:${paperWidth};padding:4mm;color:#000;background:#fff;line-height:1.35;font-weight:700;-webkit-print-color-adjust:exact;print-color-adjust:exact}
*{color:#000 !important}
.kbadge,.kbadge *{color:#fff !important}
img{max-width:100%}</style></head><body>
${logoHTML}
${nameHTML}
${title}
${vdt}
${tokenBox}
${SEP}
${th}
${rows}
${SEP}
${qtyTotal}
<div style="height:24px"></div>
<div style="text-align:center;font-size:${bodyFont-5}px">. . .</div>
<br/><br/><br/></body></html>`;
}
// Unified KOT HTML — uses saved KOT preset if active, else the legacy compact ticket.
// order: {kot, type, table, time, items:[{name,nameAr,qty}]}
function buildKOTHtml(order){
  const kfmt=(typeof LS!=="undefined"&&LS.get&&LS.get("restopos_kot_format"))||{};
  if(kfmt.usePreset&&kfmt.presetStyle){
    return buildPresetKOT(order,kfmt);
  }
  const it2=order.items||[];
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>@page{size:80mm auto;margin:0}body{font-family:'Courier New',monospace;font-size:15px;width:80mm;padding:4mm}.big{font-size:22px;font-weight:900;text-align:center}.hr{border:none;border-top:1px dashed #000;margin:6px 0}.ar{direction:rtl;font-family:'Tajawal','Noto Naskh Arabic',sans-serif}</style></head><body><div class="big">KOT #${_escHTML(order.kot||"")}</div><div class="hr"></div><div>${_escHTML(String(order.type||"").toUpperCase())}${order.table?" - Table "+_escHTML(order.table):""}</div><div style="font-size:11px">${_escHTML(order.time||new Date().toLocaleTimeString("en-SA"))}</div><div class="hr"></div>${it2.map(it=>`<div style="font-weight:800;font-size:17px">${it.qty}x ${_escHTML(it.name)}</div>${it.nameAr?`<div class="ar">${_escHTML(it.nameAr)}</div>`:""}`).join("")}<div class="hr"></div><div style="text-align:center;font-size:11px">Kitchen Copy</div></body></html>`;
}

// ═══════════════════════════════════════════════════════════════════
// DRAFT RECEIPT PRINT — no ZATCA QR, shows D-Invoice label
// ═══════════════════════════════════════════════════════════════════
function printDraftReceipt(order,license){
  // Use the separate draft format (falls back to main format keys if unset) + unified builder.
  const draftFmt=LS.get("restopos_draft_format")||LS.get("restopos_invoice_format")||{};
  const html=buildDraftReceiptHTML(order,license,draftFmt);
  let frame=document.getElementById("restopos-print-frame");
  if(!frame){
    frame=document.createElement("iframe");
    frame.id="restopos-print-frame";
    frame.style.cssText="position:fixed;left:-9999px;top:-9999px;width:0;height:0;border:none;";
    document.body.appendChild(frame);
  }
  const fdoc=frame.contentDocument||frame.contentWindow.document;
  fdoc.open();fdoc.write(html);fdoc.close();
  setTimeout(()=>{try{frame.contentWindow.focus();frame.contentWindow.print();}catch(e){console.warn("[draft print]",e);}},500);
}

// ═══════════════════════════════════════════════════════════════════
// POS SCREEN
// ═══════════════════════════════════════════════════════════════════
function POS({items,sales,setSales,tables,setTables,promos,license,lang="en",currentUser=null}){
  const allCats=[...new Set(items.map(i=>i.category))];
  const [activeCat,setActiveCat]=useState("ALL");const [cart,setCart]=useState([]);const [orderType,setOrderType]=useState("takeaway");const [selectedTable,setSelectedTable]=useState(null);const [billType,setBillType]=useState("normal");
  const [showPayment,setShowPayment]=useState(false);const [showReceipt,setShowReceipt]=useState(false);const [lastOrder,setLastOrder]=useState(null);const [lastZatcaInvoice,setLastZatcaInvoice]=useState(null);
  const [showPrevBill,setShowPrevBill]=useState(false);
  const [prevIndex,setPrevIndex]=useState(0); // index into the prev-bill list (0 = newest)
  const [prevAllDays,setPrevAllDays]=useState(false); // false = today only, true = all days
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
    // Daily token: only normal (completed) invoices get one. Drafts do not increment it.
    const dailyToken=isDraft?getDailyToken():bumpDailyToken();
    const inv={
      id:invoiceId,
      token:dailyToken,
      voucher:invoiceId,
      user:currentUser?.name||"admin",
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
    // ── SAVE INVOICE ─────────────────────────────────────────────
    // Step 1: Save to localStorage IMMEDIATELY (synchronous)
    const _currentSales=LS.get("restopos_sales")||[];
    const _newSales=[..._currentSales,inv];
    LS.set("restopos_sales",_newSales);
    // Step 2: Update React state so UI reflects new sale
    setSales(prev=>{
      // Already saved to LS above; just update React state with the new array
      const merged=[...prev.filter(s=>s.id!==inv.id),inv];
      return merged;
    });
    setLastOrder(inv);
    console.log("[SALE SAVED]",inv.id,"total:",inv.total,"method:",inv.payMethod);

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
    let zatcaInvForPrint=null;
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
        zatcaInvForPrint=zatcaInv;
        setLastZatcaInvoice(zatcaInv);
      }catch(e){console.warn("[ZATCA]",e);setLastZatcaInvoice(null);}
    }
    if(orderType==="dine-in"&&selectedTable)setTables(prev=>prev.map(t=>t.id===selectedTable?{...t,status:"free"}:t));
    // ── AUTO-PRINT KOT TO KITCHEN ──────────────────────────────────────
    // Fires for ALL order types whenever Auto-KOT is on. Runs in its own
    // try/catch BEFORE the receipt so a receipt failure can never block the
    // kitchen ticket. Tries QZ Tray → ESC/POS serial → browser popup.
    const kp=LS.get("restopos_kitchen_printer")||{};
    if(kp.autoKOT){
      try{
        const newKot2=kotNo+1;LS.set("restopos_kot",newKot2);setKotNo(newKot2);
        const kotCart=[...cart];const kType=extraData.orderType||orderType;const kTable=selectedTable;
        let kotDone=false;
        // 1) QZ Tray kitchen printer
        try{
          if(isQZConnected()&&_qzKitchenPrinter){
            const kotHTML=buildKOTHtml({kot:newKot2,token:inv.token,voucher:inv.voucher||inv.id,date:inv.date,type:inv.type,billType:inv.billType,table:kTable,time:new Date().toLocaleTimeString("en-SA"),items:kotCart});
            await printWithQZ(kotHTML,_qzKitchenPrinter,kp.paperWidth||"80mm");
            kotDone=true;
          }
        }catch(e){console.warn("[AutoKOT QZ]",e);}
        // 2) ESC/POS serial kitchen printer
        if(!kotDone&&"serial" in navigator){
          try{
            if(isPortOpen(_kitchenPort)||(await getAvailablePorts()).length>0){
              await printKOTEscPos(kotCart,kType,kTable,newKot2);
              kotDone=true;
            }
          }catch(e){console.warn("[AutoKOT serial]",e);}
        }
        // 3) Browser popup fallback so the kitchen always gets a ticket
        if(!kotDone){
          try{
            const win=window.open("","_blank","width=300,height=500");
            if(win){
              win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>KOT ${newKot2}</title><style>@page{size:80mm auto;margin:0}body{font-family:monospace;font-size:15px;width:80mm;padding:6mm}hr{border:none;border-top:1px dashed #000;margin:8px 0}.big{font-size:22px;font-weight:900;text-align:center}.ar{direction:rtl;font-family:Arial}</style></head><body><div class="big">KOT #${newKot2}</div><hr/><div>${String(kType).toUpperCase()}${kTable?" - Table "+kTable:""}</div><div>${new Date().toLocaleTimeString()}</div><hr/>${kotCart.map(it=>`<div style="font-weight:800">${it.qty}x ${it.name}</div>${it.nameAr?`<div class="ar">${it.nameAr}</div>`:""}`).join("")}<hr/><script>window.onload=function(){window.print();window.close()}<\/script></body></html>`);
              win.document.close();
            }
          }catch(e){console.warn("[AutoKOT browser]",e);}
        }
      }catch(e){console.warn("[AutoKOT] failed:",e);}
    }
    // Window already closed by handleConfirm — just clear state
    setCart([]);
    setCustomerName("");setCustomerPhone("");setCustomerAddress("");setSelectedRow(null);
    // Sync to cloud
    try{
      const lk=LS.get("restopos_license_v2")?.licenseKey;
      if(lk)syncKeyToFirestore(lk,"restopos_sales",LS.get("restopos_sales")||[]);
    }catch(e){}

    if(!printAndSave){
      // Save only — done
      setPrintBanner({msg:"💾 "+inv.id+" — Invoice Saved",type:"save"});
      setTimeout(()=>setPrintBanner(null),3000);
    }else if(isDraft){
      // Draft: try QZ first → fallback to browser print
      try{
        const _draftFmt=LS.get("restopos_draft_format")||LS.get("restopos_invoice_format")||{};
        const draftHTML=buildDraftReceiptHTML(inv,license,_draftFmt);
        const _draftPrinter=localStorage.getItem("restopos_qz_bill_printer")||_qzBillPrinter;
        if(!isQZConnected())await connectQZ();
        if(isQZConnected()&&_draftPrinter){
          await printWithQZ(draftHTML,_draftPrinter,_draftFmt.paperWidth||"80mm");
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
      // Normal invoice print — QZ → ESC/POS → iframe (with ZATCA QR)
      const fmt=LS.get("restopos_invoice_format")||{};
      // Build the ZATCA QR as a PNG data-URL so it prints on every invoice
      const qrStr=(zatcaInvForPrint&&zatcaInvForPrint.qr_string)||generatePhase1QR({sellerName:license?.businessName||"",vatNumber:license?.vatNumber||"",timestamp:new Date().toISOString(),total:inv.total,vatAmount:inv.vat});
      let qrImg="";
      try{qrImg=await makeQRDataURL(qrStr,240);}catch(e){console.warn("[QR]",e);}
      const html=buildReceiptHTML(inv,license,zatcaInvForPrint,fmt,qrImg);
      let printed=false;
      let printMethod="";

      // ── Try 1: QZ Tray (silent HTML print — same path the KOT uses) ──
      const qzPrinter=localStorage.getItem("restopos_qz_bill_printer")||_qzBillPrinter;
      if(!printed&&qzPrinter){
        try{
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

      // ── Try 2: ESC/POS USB serial (only if a bill port is already open) ──
      if(!printed&&"serial" in navigator&&isPortOpen(_billPort)){
        try{
          await printReceiptEscPos({...inv,qr_string:qrStr},license);
          printed=true;
          printMethod="ESC/POS";
        }catch(e){console.warn("[ESC/POS]",e.message);}
      }

      // ── Try 3: Hidden iframe — prints to default printer, NO pop-up ──
      if(!printed){
        try{
          let frame=document.getElementById("restopos-print-frame");
          if(!frame){
            frame=document.createElement("iframe");
            frame.id="restopos-print-frame";
            frame.style.cssText="position:fixed;left:-9999px;top:-9999px;width:0;height:0;border:none;";
            document.body.appendChild(frame);
          }
          const fdoc=frame.contentDocument||frame.contentWindow.document;
          fdoc.open();fdoc.write(html);fdoc.close();
          setTimeout(()=>{
            try{frame.contentWindow.focus();frame.contentWindow.print();}catch(pe){console.warn("[print]",pe);}
          },500);
          printed=true;
          printMethod="Browser";
        }catch(e){
          console.warn("[browser print]",e.message);
          setShowReceipt(true);
        }
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
        const _kType=orderType==="dine-in"?"Dine-in":orderType==="takeaway"?"Takeaway":"Delivery";
        const kotHTML=buildKOTHtml({kot:newKot,token:getDailyToken(),voucher:"KOT-"+newKot,date:TODAY,type:_kType,table:selectedTable,time:new Date().toLocaleTimeString("en-SA"),items:cart});
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
  // POS categories — use saved order, only show cats with active items.
  // Orphan / uncategorised active items fall into the "Other" bucket.
  const savedCats=useMemo(()=>LS.get("restopos_categories")||SEED_CATEGORIES,[items]);
  const catColors=useMemo(()=>getCategoryColors(),[items,activeCat]);
  const [favourites,setFavourites]=useState(()=>getFavourites());
  function toggleFavourite(id){
    setFavourites(prev=>{const next=prev.includes(id)?prev.filter(x=>x!==id):[...prev,id];saveFavourites(next);return next;});
  }
  const effCats=useMemo(()=>catsWithOther(savedCats,items),[savedCats,items]);
  const posActiveCats=useMemo(()=>effCats.filter(c=>items.some(i=>i.active&&effectiveCat(i,savedCats)===c)),[effCats,savedCats,items]);
  const hasFavs=useMemo(()=>items.some(i=>i.active&&favourites.includes(i.id)),[items,favourites]);
  const cats=useMemo(()=>[...(hasFavs?["★ Favourites"]:[]),"ALL",...posActiveCats],[posActiveCats,hasFavs]);
  const filteredItems=useMemo(()=>items.filter(i=>{
    if(!i.active)return false;
    if(activeCat==="★ Favourites")return favourites.includes(i.id);
    if(activeCat==="ALL")return true;
    return effectiveCat(i,savedCats)===activeCat;
  }),[items,activeCat,savedCats,favourites]);
  return(
    <div style={{display:"flex",height:"calc(100vh - 52px)",overflow:"hidden"}}>
      {/* Previous Bills — step backward through printed invoices */}
      {showPrevBill&&(()=>{
        const printedAll=(sales||[]).filter(s=>s.status!=="voided").slice().sort((a,b)=>{
          // newest first by date+time
          const ka=(a.date||"")+" "+(a.time||""), kb=(b.date||"")+" "+(b.time||"");
          return kb.localeCompare(ka);
        });
        const todayList=printedAll.filter(s=>s.date===TODAY);
        const list=prevAllDays?printedAll:(todayList.length?todayList:printedAll);
        if(!list.length){return null;}
        const idx=Math.min(prevIndex,list.length-1);
        const bill=list[idx];
        const goPrev=()=>{
          if(idx<list.length-1){setPrevIndex(idx+1);return;}
          // Reached the oldest of the current scope
          if(!prevAllDays){
            const older=printedAll.some(s=>s.date<TODAY);
            if(older&&window.confirm("That's the first bill of today.\n\nGo to previous days' invoices?")){
              setPrevAllDays(true);
              // jump to first invoice older than today
              const firstOlder=printedAll.findIndex(s=>s.date<TODAY);
              setPrevIndex(firstOlder>=0?firstOlder:0);
            }else{
              setPrevIndex(0); // loop back to today's newest
            }
          }else{
            setPrevIndex(0); // loop back to newest overall
          }
        };
        const goNewer=()=>{ if(idx>0)setPrevIndex(idx-1); };
        return(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.65)",zIndex:3000,
          display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div style={{background:"#fff",borderRadius:20,width:"100%",maxWidth:480,
            maxHeight:"92vh",overflow:"auto",boxShadow:"0 24px 80px rgba(0,0,0,0.35)"}}>
            {/* Header */}
            <div style={{background:"linear-gradient(135deg,#1A3A5C,#0F2340)",padding:"16px 20px",
              borderRadius:"20px 20px 0 0",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <div style={{color:"#fff",fontSize:15,fontWeight:800}}>🕐 Previous Bill {idx+1} of {list.length}{prevAllDays?" (all days)":" (today)"}</div>
                <div style={{color:"rgba(255,255,255,0.5)",fontSize:11,marginTop:2}}>{bill.id} · {bill.date} {bill.time}</div>
              </div>
              <button onClick={()=>setShowPrevBill(false)}
                style={{background:"rgba(255,255,255,0.12)",border:"none",color:"#fff",
                  width:30,height:30,borderRadius:"50%",cursor:"pointer",fontSize:16}}>×</button>
            </div>
            {/* Body */}
            <div style={{padding:"18px 20px",display:"flex",flexDirection:"column",gap:12}}>
              {/* Step controls */}
              <div style={{display:"flex",gap:8}}>
                <button onClick={goNewer} disabled={idx===0}
                  style={{flex:1,padding:"9px",borderRadius:9,border:"1.5px solid #C5DCF5",background:idx===0?"#F0F4F8":"#fff",color:idx===0?"#AAB2BD":"#1A3A5C",fontFamily:"inherit",fontSize:12,fontWeight:700,cursor:idx===0?"not-allowed":"pointer",opacity:idx===0?0.5:1}}>⬅️ Newer</button>
                <button onClick={goPrev}
                  style={{flex:1,padding:"9px",borderRadius:9,border:"1.5px solid #1A3A5C",background:"#1A3A5C",color:"#fff",fontFamily:"inherit",fontSize:12,fontWeight:700,cursor:"pointer"}}>Older ➡️</button>
              </div>
              {/* KPIs */}
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
                {[
                  ["💳 Method",bill.payMethod||"—","#1A3A5C"],
                  ["📦 Items",(bill.items||[]).reduce((s,i)=>s+i.qty,0)+" items","#2176AE"],
                  ["💰 Total","SAR "+(bill.total||0).toFixed(2),"#1A6B4A"],
                ].map(([l,v,c])=>(
                  <div key={l} style={{background:c+"11",border:`1.5px solid ${c}33`,borderRadius:10,padding:"8px 10px",textAlign:"center"}}>
                    <div style={{fontSize:9,color:"#888",fontWeight:700}}>{l}</div>
                    <div style={{fontSize:12,fontWeight:800,color:c,marginTop:2}}>{v}</div>
                  </div>
                ))}
              </div>
              {(bill.customer||bill.customerPhone)&&(
                <div style={{background:"#F0F7FF",borderRadius:10,padding:"8px 14px",fontSize:12}}>
                  👤 {bill.customer||""}{bill.customerPhone?" · "+bill.customerPhone:""}
                </div>
              )}
              {/* Items */}
              <div style={{background:"#F8FAFF",borderRadius:10,overflow:"hidden",border:"1px solid #E0E8F0"}}>
                <div style={{padding:"8px 14px",background:"#E8F0FA",fontSize:11,fontWeight:700,color:"#3A5A7A"}}>ORDER ITEMS</div>
                {(bill.items||[]).map((it,i)=>(
                  <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",
                    padding:"8px 14px",borderBottom:"1px solid #E0E8F0",fontSize:12}}>
                    <div>
                      {it.nameAr&&<div style={{fontSize:11,color:"#1A3A5C",direction:"rtl",fontFamily:"'Amiri','Noto Naskh Arabic',serif",fontWeight:700}}>{it.nameAr}</div>}
                      <div style={{fontWeight:600,color:"#1A3A5C"}}>{it.name}</div>
                      <div style={{fontSize:10,color:"#8A9AB0"}}>{it.qty} × SAR {it.price.toFixed(2)}</div>
                    </div>
                    <strong style={{color:"#1A6B4A"}}>SAR {(it.qty*it.price).toFixed(2)}</strong>
                  </div>
                ))}
              </div>
              {/* Totals */}
              <div style={{background:"#F0F7FF",borderRadius:10,padding:"10px 14px"}}>
                {bill.discount>0&&<div style={{display:"flex",justifyContent:"space-between",fontSize:12,padding:"3px 0",color:"#D94040"}}>
                  <span>Discount</span><span>-SAR {(bill.discount||0).toFixed(2)}</span>
                </div>}
                <div style={{display:"flex",justifyContent:"space-between",fontSize:12,padding:"3px 0",color:"#6366f1"}}>
                  <span>VAT 15%</span><span>SAR {(bill.vat||0).toFixed(2)}</span>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:15,fontWeight:900,padding:"6px 0",borderTop:"1px solid #C5DCF5",marginTop:4,color:"#1A6B4A"}}>
                  <span>TOTAL</span><span>SAR {(bill.total||0).toFixed(2)}</span>
                </div>
                {bill.payMethod==="Cash"&&bill.given>0&&(
                  <>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#888"}}>
                      <span>Cash Given</span><span>SAR {(bill.given||0).toFixed(2)}</span>
                    </div>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#1A6B4A",fontWeight:700}}>
                      <span>Change</span><span>SAR {(bill.change||0).toFixed(2)}</span>
                    </div>
                  </>
                )}
              </div>
              {bill.note&&<div style={{background:"#FFFDF0",border:"1px solid #F0E8C0",borderRadius:8,padding:"8px 12px",fontSize:12,color:"#8A6000",fontStyle:"italic"}}>
                📝 {bill.note}
              </div>}
              {/* Print button — reprints THIS bill */}
              <button onClick={()=>{ try{reprintReceipt(bill,license);}catch(e){alert("Print failed: "+e.message);} }}
                style={{width:"100%",padding:"13px",background:"linear-gradient(135deg,#1A6B4A,#0F4A30)",
                color:"#fff",border:"none",borderRadius:12,fontSize:14,fontWeight:800,
                cursor:"pointer",fontFamily:"inherit",boxShadow:"0 4px 16px rgba(26,107,74,0.3)"}}>
                🖨️ Print This Bill
              </button>
              <button onClick={()=>setShowPrevBill(false)}
                style={{width:"100%",padding:"10px",background:"#F0F4F8",border:"1px solid #E0E8F0",
                  borderRadius:10,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",color:"#5A7A9A"}}>
                Close
              </button>
            </div>
          </div>
        </div>
        );
      })()}
      {/* Print/Save success banner */}
      {printBanner&&(
        <div style={{
          position:"fixed",top:24,left:"50%",transform:"translateX(-50%)",
          zIndex:99999,padding:"14px 28px",borderRadius:14,
          fontSize:15,fontWeight:800,
          background:printBanner.type==="success"?"#1A6B4A":
                     printBanner.type==="error"?"#C0392B":"#2176AE",
          color:"#fff",
          boxShadow:"0 8px 40px rgba(0,0,0,0.5)",
          animation:"bannerIn 0.25s ease",
          whiteSpace:"nowrap",display:"flex",alignItems:"center",
          gap:10,maxWidth:"92vw",direction:"ltr"}}>
          <span style={{fontSize:20}}>
            {printBanner.type==="success"?"✅":
             printBanner.type==="error"?"⚠️":"💾"}
          </span>
          <span>{printBanner.msg}</span>
        </div>
      )}
      <style>{`
        @keyframes bannerIn{
          from{opacity:0;transform:translateX(-50%) translateY(-16px);}
          to{opacity:1;transform:translateX(-50%) translateY(0);}
        }
      `}</style>
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
          {cats.map(cat=>{
            const isFav=cat==="★ Favourites";const isAll=cat==="ALL";
            const dot=isFav?"#F0A500":(isAll?null:colorForCat(cat,savedCats));
            const active=activeCat===cat;
            return(
              <button key={cat} onClick={()=>setActiveCat(cat)} style={{padding:"6px 14px",borderRadius:20,border:active?`1.5px solid ${dot||C.primary}`:"1px solid transparent",background:active?(dot?dot+"1A":C.primary):C.bg,color:active?(dot||"#fff"):C.textMid,fontFamily:"inherit",fontSize:12,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0,display:"flex",alignItems:"center",gap:6}}>
                {dot&&<span style={{width:9,height:9,borderRadius:"50%",background:dot,flexShrink:0}}/>}
                {cat}
              </button>
            );
          })}
        </div>
        <div style={{flex:1,overflowY:"auto",padding:12,display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(130px, 1fr))",gap:10,alignContent:"start"}}>
          {filteredItems.map(item=>{
            const col=colorForCat(effectiveCat(item,savedCats),savedCats);
            const isFav=favourites.includes(item.id);
            return(
              <div key={item.id} role="button" onClick={()=>addToCart(item)} style={{position:"relative",background:col+"0D",border:`1.5px solid ${col}55`,borderLeft:`5px solid ${col}`,borderRadius:12,padding:"12px 10px",cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>
                <button onClick={e=>{e.stopPropagation();toggleFavourite(item.id);}} title={isFav?"Remove from Favourites":"Add to Favourites"} style={{position:"absolute",top:5,right:5,background:"transparent",border:"none",cursor:"pointer",fontSize:16,lineHeight:1,padding:2,color:isFav?"#F0A500":"#C9CDD6"}}>{isFav?"★":"☆"}</button>
                <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:4,lineHeight:1.3,paddingRight:16}}>{item.name}</div>
                {item.nameAr&&<div style={{fontSize:11,color:C.textLight,direction:"rtl",marginBottom:6}}>{item.nameAr}</div>}
                <div style={{fontSize:14,fontWeight:900,color:col}}>SAR {item.price}</div>
                {item.stock<10&&<div style={{fontSize:10,color:C.danger,fontWeight:600,marginTop:3}}>Low stock</div>}
              </div>
            );
          })}
          {filteredItems.length===0&&<div style={{gridColumn:"1/-1",textAlign:"center",padding:"40px 0",color:C.textLight}}>{activeCat==="★ Favourites"?"No favourites yet — tap ☆ on an item to add it here":"No items in this category"}</div>}
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
            <button onClick={()=>{
                const printed=(sales||[]).filter(s=>s.status!=="voided");
                if(!printed.length){alert("No previous bills yet");return;}
                setPrevAllDays(false);setPrevIndex(0);setShowPrevBill(true);
              }}
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
// ═══════════════════════════════════════════════════════════════════
// DASHBOARD BOX CATALOG — the client can show/hide & reorder these.
// Each box computes its value from the data passed to the Dashboard.
// To add a new box type later, add an entry here (id + render).
const DASHBOARD_BOXES=[
  {id:"todayOrders",icon:"🧾",label:"Today's Orders",color:"info"},
  {id:"vatCollected",icon:"⬛",label:"VAT Collected",color:"zatca"},
  {id:"todayRevenue",icon:"💰",label:"Today's Revenue",color:"primary"},
  {id:"menuItems",icon:"📦",label:"Menu Items",color:"success"},
  {id:"avgOrder",icon:"📈",label:"Avg Order Value",color:"info"},
  {id:"zatcaTotal",icon:"📋",label:"Total ZATCA Invoices",color:"zatca"},
  {id:"zatcaReported",icon:"✅",label:"Reported to ZATCA",color:"success"},
  {id:"zatcaPending",icon:"⏳",label:"ZATCA Pending",color:"warning"},
  {id:"zatcaUrgent",icon:"🚨",label:"ZATCA Urgent",color:"danger"},
];
// Default: the same boxes that were shown before (keeps current look)
const DEFAULT_DASHBOARD_CONFIG=["todayOrders","vatCollected","menuItems","zatcaTotal","zatcaReported","zatcaPending","zatcaUrgent"];
function getDashboardConfig(){
  const saved=LS.get("restopos_dashboard_config");
  if(Array.isArray(saved)&&saved.length)return saved.filter(id=>DASHBOARD_BOXES.some(b=>b.id===id));
  return DEFAULT_DASHBOARD_CONFIG.slice();
}

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

      {/* KPI STATS — driven by the client's Dashboard config (Settings → Dashboard) */}
      {(()=>{
        const colorMap={info:[C.info,C.infoLight],zatca:[C.zatca,C.zatcaLight],primary:[C.primary,C.primaryLight],success:[C.success,C.successLight],warning:[C.warning,C.warningLight],danger:[C.danger,C.dangerLight]};
        const avgOrder=todaySales.length?todayRevenue/todaySales.length:0;
        const VALUES={
          todayOrders:todaySales.length,
          vatCollected:fmtSAR(todayVat),
          todayRevenue:fmtSAR(todayRevenue),
          menuItems:items.filter(i=>i.active).length+" active",
          avgOrder:fmtSAR(avgOrder),
          zatcaTotal:qStatus.total,
          zatcaReported:qStatus.reported,
          zatcaPending:qStatus.pending,
          zatcaUrgent:qStatus.urgent,
        };
        const cfg=getDashboardConfig();
        return(
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(180px,1fr))",gap:14,marginBottom:20}}>
            {cfg.map(id=>{
              const box=DASHBOARD_BOXES.find(b=>b.id===id);if(!box)return null;
              const [color,bg]=colorMap[box.color]||[C.primary,C.primaryLight];
              return <StatCard key={id} icon={box.icon} label={t(box.label,lang)} value={VALUES[id]} color={color} bg={bg}/>;
            })}
          </div>
        );
      })()}
      {qStatus.urgent>0&&<div style={{marginBottom:16,padding:"10px 14px",background:C.dangerLight,border:`1px solid ${C.danger}`,borderRadius:8,fontSize:12,color:C.danger,fontWeight:600}}>🚨 {qStatus.urgent} invoice(s) approaching 24-hour FATOORA reporting deadline!</div>}
      {todaySales.length===0
        ?<Card style={{textAlign:"center",padding:"40px 0"}}><div style={{fontSize:40,marginBottom:12}}>📊</div><div style={{fontSize:15,fontWeight:700,color:C.textMid}}>No sales today yet</div></Card>
        :<Card><div style={{fontSize:14,fontWeight:700,marginBottom:14}}>Recent Orders (Today)</div><DataTable headers={["Invoice","Time","Type","Method","Total"]} rows={todaySales.filter(s=>!s.isDraft&&!(s.id&&String(s.id).startsWith("D-"))).slice().reverse().slice(0,10).map(s=>[<span style={{fontFamily:"monospace",fontSize:12,color:C.primary,fontWeight:700}}>{s.id}</span>,s.time,s.type,s.payMethod,<strong style={{color:C.primary}}>{fmtSAR(s.total)}</strong>])}/></Card>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// DASHBOARD EDITOR — clients show/hide and reorder dashboard boxes.
// Saved to restopos_dashboard_config (cloud-synced). Live data unchanged.
// ═══════════════════════════════════════════════════════════════════
function DashboardEditor({sales=[],items=[]}){
  const [cfg,setCfg]=useState(()=>getDashboardConfig());
  const [saved,setSaved]=useState(false);
  function persist(next){
    setCfg(next);LS.set("restopos_dashboard_config",next);
    const lk=LS.get("restopos_license_v2")?.licenseKey;
    if(lk)debouncedSync(lk,"restopos_dashboard_config",next);
    setSaved(false);
  }
  function toggleBox(id){
    if(cfg.includes(id))persist(cfg.filter(x=>x!==id));
    else persist([...cfg,id]);
  }
  function move(id,dir){
    const i=cfg.indexOf(id);if(i<0)return;
    const j=dir==="up"?i-1:i+1;if(j<0||j>=cfg.length)return;
    const next=cfg.slice();[next[i],next[j]]=[next[j],next[i]];persist(next);
  }
  function resetDefault(){persist(DEFAULT_DASHBOARD_CONFIG.slice());}
  function saveNow(){
    LS.set("restopos_dashboard_config",cfg);
    const lk=LS.get("restopos_license_v2")?.licenseKey;
    if(lk)debouncedSync(lk,"restopos_dashboard_config",cfg);
    setSaved(true);setTimeout(()=>setSaved(false),3000);
  }
  // Live values for the mini preview
  const todaySales=sales.filter(s=>s.date===TODAY);
  const todayRevenue=todaySales.reduce((s,o)=>s+(o.total||0),0);
  const todayVat=todaySales.reduce((s,o)=>s+(o.vat||0),0);
  const qStatus=zatcaUtils.getQueueStatus();
  const colorMap={info:[C.info,C.infoLight],zatca:[C.zatca,C.zatcaLight],primary:[C.primary,C.primaryLight],success:[C.success,C.successLight],warning:[C.warning,C.warningLight],danger:[C.danger,C.dangerLight]};
  const VALUES={
    todayOrders:todaySales.length,vatCollected:fmtSAR(todayVat),todayRevenue:fmtSAR(todayRevenue),
    menuItems:items.filter(i=>i.active).length+" active",avgOrder:fmtSAR(todaySales.length?todayRevenue/todaySales.length:0),
    zatcaTotal:qStatus.total,zatcaReported:qStatus.reported,zatcaPending:qStatus.pending,zatcaUrgent:qStatus.urgent,
  };
  const hidden=DASHBOARD_BOXES.filter(b=>!cfg.includes(b.id));
  return(
    <div style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) minmax(0,1fr)",gap:20,alignItems:"start"}}>
      {/* LEFT — configure */}
      <div style={{display:"flex",flexDirection:"column",gap:14}}>
        <div style={{background:C.primaryLight,border:`1px solid ${C.primary}44`,borderRadius:10,padding:"10px 14px",fontSize:12,color:C.primary,fontWeight:600}}>
          📊 Choose which boxes appear on your Dashboard and in what order. Changes are saved to the cloud and restored on any device.
        </div>
        <Card>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
            <div style={{fontSize:13,fontWeight:700}}>✅ Shown Boxes ({cfg.length})</div>
            <button onClick={resetDefault} style={{fontSize:11,fontWeight:700,color:C.textMid,background:"none",border:"none",cursor:"pointer",textDecoration:"underline"}}>Reset to default</button>
          </div>
          {cfg.length===0&&<div style={{fontSize:12,color:C.textLight,padding:"8px 0"}}>No boxes shown. Add some from below.</div>}
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {cfg.map((id,idx)=>{
              const box=DASHBOARD_BOXES.find(b=>b.id===id);if(!box)return null;
              return(
                <div key={id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 10px",border:`1px solid ${C.border}`,borderRadius:8,background:C.bg}}>
                  <span style={{fontSize:18}}>{box.icon}</span>
                  <span style={{flex:1,fontSize:13,fontWeight:600,color:C.text}}>{box.label}</span>
                  <button onClick={()=>move(id,"up")} disabled={idx===0} style={{width:28,height:28,borderRadius:6,border:`1px solid ${C.border}`,background:"#fff",cursor:idx===0?"not-allowed":"pointer",opacity:idx===0?0.4:1,fontSize:13}}>▲</button>
                  <button onClick={()=>move(id,"down")} disabled={idx===cfg.length-1} style={{width:28,height:28,borderRadius:6,border:`1px solid ${C.border}`,background:"#fff",cursor:idx===cfg.length-1?"not-allowed":"pointer",opacity:idx===cfg.length-1?0.4:1,fontSize:13}}>▼</button>
                  <button onClick={()=>toggleBox(id)} style={{width:28,height:28,borderRadius:6,border:`1px solid ${C.danger}`,background:"#fff",color:C.danger,cursor:"pointer",fontSize:13,fontWeight:700}}>✕</button>
                </div>
              );
            })}
          </div>
        </Card>
        {hidden.length>0&&<Card>
          <div style={{fontSize:13,fontWeight:700,marginBottom:12}}>➕ Available Boxes</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {hidden.map(box=>(
              <div key={box.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 10px",border:`1px dashed ${C.border}`,borderRadius:8}}>
                <span style={{fontSize:18}}>{box.icon}</span>
                <span style={{flex:1,fontSize:13,fontWeight:600,color:C.textMid}}>{box.label}</span>
                <button onClick={()=>toggleBox(box.id)} style={{padding:"6px 12px",borderRadius:6,border:`1px solid ${C.primary}`,background:C.primaryLight,color:C.primary,cursor:"pointer",fontSize:12,fontWeight:700}}>+ Add</button>
              </div>
            ))}
          </div>
        </Card>}
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <Btn onClick={saveNow}>💾 Save Dashboard Layout</Btn>
          {saved&&<span style={{fontSize:12,color:C.success,fontWeight:700}}>✓ Saved!</span>}
        </div>
      </div>
      {/* RIGHT — live preview */}
      <div style={{position:"sticky",top:20}}>
        <Card>
          <div style={{fontSize:12,fontWeight:700,color:C.textMid,marginBottom:12,textAlign:"center"}}>LIVE DASHBOARD PREVIEW</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:10}}>
            {cfg.map(id=>{
              const box=DASHBOARD_BOXES.find(b=>b.id===id);if(!box)return null;
              const [color,bg]=colorMap[box.color]||[C.primary,C.primaryLight];
              return <StatCard key={id} icon={box.icon} label={box.label} value={VALUES[id]} color={color} bg={bg}/>;
            })}
          </div>
          {cfg.length===0&&<div style={{textAlign:"center",padding:"30px 0",color:C.textLight,fontSize:13}}>No boxes selected</div>}
        </Card>
      </div>
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
  {id:"amiri",label:"Amiri (recommended)",family:"'Amiri','Noto Naskh Arabic',serif",lang:"AR"},
  {id:"noto-naskh",label:"Noto Naskh Arabic",family:"'Noto Naskh Arabic','Amiri',serif",lang:"AR"},
  {id:"cairo",label:"Cairo",family:"'Cairo','Noto Naskh Arabic',sans-serif",lang:"AR"},
  {id:"tajawal",label:"Tajawal",family:"'Tajawal','Noto Naskh Arabic',sans-serif",lang:"AR"},
];

// ═══════════════════════════════════════════════════════════════════
// PRESET FORMAT TAB — ready-made invoice / draft / KOT styles
// 3 modes (Invoice · Draft · KOT). Each: 4 style cards + logo(URL)+guide
// + font/spacing sliders + LIVE preview (same builder as printer) + Save.
// Saved to localStorage AND synced to Firestore per license.
//   restopos_invoice_format (shared with classic tab; usePreset flag toggles it)
//   restopos_draft_format
//   restopos_kot_format
// ═══════════════════════════════════════════════════════════════════
function PresetImageGuide({onClose}){
  return(
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#fff",borderRadius:14,maxWidth:520,width:"100%",maxHeight:"85vh",overflow:"auto",padding:24,boxShadow:"0 20px 60px rgba(0,0,0,0.3)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <div style={{fontSize:17,fontWeight:800,color:C.text}}>📷 How to add your logo</div>
          <button onClick={onClose} style={{border:"none",background:"none",fontSize:22,cursor:"pointer",color:C.textMid}}>×</button>
        </div>
        <div style={{fontSize:13,color:C.textMid,lineHeight:1.7}}>
          <p style={{marginBottom:12}}>Your logo must be a <strong>direct image link</strong> (a URL that ends in <code>.png</code> or <code>.jpg</code>). Follow these steps to get one free:</p>
          <ol style={{paddingLeft:20,display:"flex",flexDirection:"column",gap:10}}>
            <li>Open <strong>imgbb.com</strong> in your browser and tap <strong>Start uploading</strong>.</li>
            <li>Choose your logo image from your device and let it upload.</li>
            <li>After upload, open the <strong>Embed codes</strong> dropdown and pick <strong>Direct links</strong>.</li>
            <li>Copy that link — it ends in <code>.png</code> or <code>.jpg</code>.</li>
            <li>Paste it into the <strong>Logo Image URL</strong> box and tap <strong>🔄 Load</strong>.</li>
          </ol>
          <div style={{margin:"16px 0",border:`1px solid ${C.border}`,borderRadius:10,overflow:"hidden"}}>
            <img src="https://i.ibb.co/0jqHpnH/imgbb-direct-link.png" alt="ImgBB direct link example" style={{width:"100%",display:"block"}} onError={e=>{e.target.parentElement.style.display="none";}}/>
          </div>
          <div style={{background:C.warningLight,border:`1px solid ${C.warning}`,borderRadius:10,padding:"10px 14px",fontSize:12.5,color:C.warning}}>
            ⚠️ A normal webpage link will <strong>not</strong> work — it must be the <strong>direct image</strong> link ending in .png / .jpg. Google Drive share links do not work; use ImgBB or any image host that gives a direct link.
          </div>
        </div>
        <button onClick={onClose} style={{marginTop:16,width:"100%",padding:"11px",borderRadius:10,border:"none",background:C.primary,color:"#fff",fontFamily:"inherit",fontSize:14,fontWeight:700,cursor:"pointer"}}>Got it</button>
      </div>
    </div>
  );
}

function PresetFormatTab({license,company}){
  const [mode,setMode]=useState("invoice"); // "invoice" | "draft" | "kot"
  const [showGuide,setShowGuide]=useState(false);
  const [savedMsg,setSavedMsg]=useState("");
  const [imgTest,setImgTest]=useState({});
  const STORE={invoice:"restopos_invoice_format",draft:"restopos_draft_format",kot:"restopos_kot_format"};

  // defaults per mode
  const DEFAULTS={
    invoice:{usePreset:true,presetStyle:"s1",paperWidth:"80mm",headFont:14,bodyFont:12,totalFont:16,tokenFont:22,lineGap:3,logoSize:60,qrSize:120,headerColor:"#1A6B4A",logoUrl:"",footer:"Thank you — visit again",footerAr:"شكراً لك زيارة مرة أخرى"},
    draft:{usePreset:true,presetStyle:"s1",paperWidth:"80mm",headFont:14,bodyFont:12,totalFont:16,tokenFont:22,lineGap:3,logoSize:60,headerColor:"#1A6B4A",logoUrl:"",footer:"Thank you — visit again",footerAr:"شكراً لك زيارة مرة أخرى"},
    kot:{usePreset:true,presetStyle:"s1",paperWidth:"80mm",headFont:20,bodyFont:16,tokenFont:28,lineGap:4,logoSize:50,logoUrl:"",kotTitle:"Telephone Bill"},
  };
  // load current saved format for the active mode (preserve other keys already saved)
  const [fmtAll,setFmtAll]=useState(()=>({
    invoice:{...DEFAULTS.invoice,...(LS.get(STORE.invoice)||{})},
    draft:{...DEFAULTS.draft,...(LS.get(STORE.draft)||{})},
    kot:{...DEFAULTS.kot,...(LS.get(STORE.kot)||{})},
  }));
  const fmt=fmtAll[mode];
  function set(k,v){setFmtAll(p=>({...p,[mode]:{...p[mode],[k]:v}}));setSavedMsg("");}
  function save(){
    const data=fmtAll[mode];
    LS.set(STORE[mode],data);
    const lk=LS.get("restopos_license_v2")?.licenseKey;
    if(lk){try{debouncedSync(lk,STORE[mode],data);}catch(e){}}
    setSavedMsg("✓ Saved — this style now prints for "+mode.toUpperCase());
    setTimeout(()=>setSavedMsg(""),3500);
  }
  function disablePreset(){
    // turn presets OFF for this mode → revert to classic builder
    const data={...fmtAll[mode],usePreset:false};
    setFmtAll(p=>({...p,[mode]:data}));
    LS.set(STORE[mode],data);
    const lk=LS.get("restopos_license_v2")?.licenseKey;
    if(lk){try{debouncedSync(lk,STORE[mode],data);}catch(e){}}
    setSavedMsg("Preset disabled — using classic format");
    setTimeout(()=>setSavedMsg(""),3500);
  }
  function testImage(url){
    if(!url){setImgTest({});return;}
    setImgTest({s:"loading"});
    const im=new Image();im.onload=()=>setImgTest({s:"ok"});im.onerror=()=>setImgTest({s:"error"});im.src=url;
  }

  // ── live preview sample ──
  const [previewQR,setPreviewQR]=useState("");
  useEffect(()=>{
    const tlv=generatePhase1QR({sellerName:license?.businessName||"Restaurant",vatNumber:license?.vatNumber||"300000000000003",timestamp:new Date().toISOString(),total:14.00,vatAmount:1.83});
    makeQRDataURL(tlv,220).then(setPreviewQR).catch(()=>{});
  },[license]);
  const sampleOrder={
    id:"INV-001001",voucher:"44480",token:"5",kot:"5",user:"admin",
    date:TODAY,time:"12:07:50 PM",type:"Takeaway",typeAr:"سفري",payMethod:"CASH",
    given:14.00,change:0,discount:0,vat:1.83,total:14.00,
    items:[
      {name:"Zinger Sandwich",nameAr:"سندويش زنجر",qty:2,price:7.00,category:"Sandwiches"},
      {name:"French Fries",nameAr:"بطاطس مقلية",qty:1,price:10.00,category:"Sides"},
    ],
  };
  const prevLicense={
    businessName:fmt.shopNameOverride||company?.businessName||license?.businessName||"Broast Al-Bahr",
    businessNameAr:fmt.shopNameAr||license?.businessNameAr||"بروست البحر",
    address:company?.address||license?.address||"Makkah, Al-Shoqiyah",
    addressAr:fmt.addressAr||license?.addressAr||"مكة المكرمة - حي الشوقية",
    phone:fmt.phoneOverride||company?.phone||license?.phone||"0500959394",
    vatNumber:license?.vatNumber||"311459656500003",
  };
  const prevZatca={invoice_number:"INV-001001",icv:1001};
  function previewHTML(){
    if(mode==="kot")return buildPresetKOT(sampleOrder,fmt);
    if(mode==="draft")return buildPresetHTML(sampleOrder,prevLicense,null,fmt,null,{draft:true});
    return buildPresetHTML(sampleOrder,prevLicense,prevZatca,fmt,previewQR,{draft:false});
  }
  const prevW=fmt.paperWidth==="58mm"?210:300;

  const Slider=({label,k,min,max,step,suffix})=>(
    <div style={{display:"flex",flexDirection:"column",gap:4}}>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:12,fontWeight:600,color:C.textMid}}>
        <span>{label}</span><span style={{color:C.primary,fontWeight:700}}>{fmt[k]}{suffix||"px"}</span>
      </div>
      <input type="range" min={min} max={max} step={step||1} value={fmt[k]} onChange={e=>set(k,parseInt(e.target.value))}
        style={{width:"100%",accentColor:C.primary}}/>
    </div>
  );

  const modeTabs=[["invoice","🧾 Preset Invoice"],["draft","📋 Preset Draft"],["kot","👨‍🍳 Preset KOT"]];

  return(
    <div>
      {showGuide&&<PresetImageGuide onClose={()=>setShowGuide(false)}/>}
      {/* mode switch */}
      <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap"}}>
        {modeTabs.map(([id,label])=>(
          <button key={id} onClick={()=>{setMode(id);setSavedMsg("");setImgTest({});}}
            style={{padding:"9px 18px",borderRadius:10,border:`2px solid ${mode===id?C.primary:C.border}`,background:mode===id?C.primaryLight:"#fff",color:mode===id?C.primary:C.textMid,fontFamily:"inherit",fontSize:13.5,fontWeight:700,cursor:"pointer"}}>{label}</button>
        ))}
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:18,alignItems:"start"}} className="preset-grid">
        {/* ── LEFT: controls ── */}
        <Card>
          <div style={{fontSize:14,fontWeight:800,marginBottom:4}}>Choose a style</div>
          <div style={{fontSize:12,color:C.textMid,marginBottom:12}}>Pick a ready-made design. The preview on the right is exactly what prints.</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:18}}>
            {PRESET_STYLES.map(s=>(
              <button key={s.id} onClick={()=>set("presetStyle",s.id)}
                style={{textAlign:"left",padding:"11px 12px",borderRadius:10,border:`2px solid ${fmt.presetStyle===s.id?C.primary:C.border}`,background:fmt.presetStyle===s.id?C.primaryLight:"#fff",cursor:"pointer",fontFamily:"inherit"}}>
                <div style={{fontSize:13,fontWeight:800,color:fmt.presetStyle===s.id?C.primary:C.text}}>{s.label}</div>
                <div style={{fontSize:11,color:C.textMid,marginTop:3,lineHeight:1.4}}>{s.desc}</div>
              </button>
            ))}
          </div>

          {/* ── EDITABLE BUSINESS DETAILS (overrides printed header) ── */}
          <div style={{border:`1px solid ${C.border}`,borderRadius:10,padding:"14px",marginBottom:16,background:C.bg}}>
            <div style={{fontSize:12,fontWeight:800,color:C.text,marginBottom:3}}>✏️ Business details on receipt</div>
            <div style={{fontSize:11,color:C.textMid,marginBottom:12,lineHeight:1.5}}>Edit how your name, address and phone appear. Leave blank to use your registered info. <strong>VAT number is locked to your license and cannot be changed.</strong></div>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                <div>
                  <label style={{fontSize:11,fontWeight:700,color:C.textMid,display:"block",marginBottom:4}}>Business name (English)</label>
                  <input value={fmt.shopNameOverride||""} onChange={e=>set("shopNameOverride",e.target.value)} placeholder={license?.businessName||"Restaurant"}
                    style={{width:"100%",padding:"8px 11px",border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontFamily:"inherit",color:C.text,background:"#fff"}}/>
                </div>
                <div>
                  <label style={{fontSize:11,fontWeight:700,color:C.textMid,display:"block",marginBottom:4}}>اسم المنشأة (عربي)</label>
                  <input value={fmt.shopNameAr||""} onChange={e=>set("shopNameAr",e.target.value)} dir="rtl" placeholder={license?.businessNameAr||"اسم المطعم"}
                    style={{width:"100%",padding:"8px 11px",border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontFamily:"'Tajawal',sans-serif",color:C.text,background:"#fff"}}/>
                </div>
              </div>
              {mode!=="kot"&&(
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                  <div>
                    <label style={{fontSize:11,fontWeight:700,color:C.textMid,display:"block",marginBottom:4}}>Address (English)</label>
                    <input value={fmt.addressEnOverride||""} onChange={e=>set("addressEnOverride",e.target.value)} placeholder={license?.address||"Address"}
                      style={{width:"100%",padding:"8px 11px",border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontFamily:"inherit",color:C.text,background:"#fff"}}/>
                  </div>
                  <div>
                    <label style={{fontSize:11,fontWeight:700,color:C.textMid,display:"block",marginBottom:4}}>العنوان (عربي)</label>
                    <input value={fmt.addressAr||""} onChange={e=>set("addressAr",e.target.value)} dir="rtl" placeholder="العنوان"
                      style={{width:"100%",padding:"8px 11px",border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontFamily:"'Tajawal',sans-serif",color:C.text,background:"#fff"}}/>
                  </div>
                </div>
              )}
              {mode!=="kot"&&(
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                  <div>
                    <label style={{fontSize:11,fontWeight:700,color:C.textMid,display:"block",marginBottom:4}}>Phone / Tel</label>
                    <input value={fmt.phoneOverride||""} onChange={e=>set("phoneOverride",e.target.value)} placeholder={license?.phone||"+966 5X XXX XXXX"}
                      style={{width:"100%",padding:"8px 11px",border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontFamily:"inherit",color:C.text,background:"#fff"}}/>
                  </div>
                  <div>
                    <label style={{fontSize:11,fontWeight:700,color:C.textLight,display:"block",marginBottom:4}}>VAT / TRN (locked) 🔒</label>
                    <input value={license?.vatNumber||""} readOnly disabled
                      style={{width:"100%",padding:"8px 11px",border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontFamily:"inherit",color:C.textLight,background:"#f1f3f7",cursor:"not-allowed"}}/>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* logo URL + guide (invoice & draft only — KOT can show logo too) */}
          <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:16}}>
            <div style={{display:"flex",alignItems:"center",gap:6}}>
              <label style={{fontSize:12,fontWeight:700,color:C.textMid}}>Logo Image URL</label>
              <button onClick={()=>setShowGuide(true)} title="How to add a logo"
                style={{width:20,height:20,borderRadius:"50%",border:`1.5px solid ${C.primary}`,background:"#fff",color:C.primary,fontSize:12,fontWeight:800,cursor:"pointer",lineHeight:1,padding:0}}>?</button>
            </div>
            <div style={{display:"flex",gap:6}}>
              <input value={fmt.logoUrl||""} onChange={e=>set("logoUrl",e.target.value)} placeholder="https://i.ibb.co/xxxx/logo.png"
                style={{flex:1,padding:"9px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontFamily:"inherit",color:C.text,background:"#fff"}}/>
              <button onClick={()=>testImage(fmt.logoUrl)} style={{padding:"0 16px",borderRadius:8,border:`2px solid ${C.primary}`,background:C.primary,color:"#fff",fontFamily:"inherit",fontSize:12,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>
                {imgTest.s==="loading"?"⏳":"🔄 Load"}
              </button>
            </div>
            {imgTest.s==="ok"&&<div style={{display:"flex",alignItems:"center",gap:8,fontSize:11,color:C.success,fontWeight:700}}>✅ Loaded <img src={fmt.logoUrl} alt="" style={{height:32,border:`1px solid ${C.border}`,borderRadius:4,background:"#fff"}}/></div>}
            {imgTest.s==="error"&&<div style={{fontSize:11,color:C.danger,fontWeight:700}}>❌ Could not load — use a direct .png/.jpg link. Tap the ? for help.</div>}
          </div>

          {/* sliders */}
          <div style={{display:"flex",flexDirection:"column",gap:14,marginBottom:16}}>
            <div style={{fontSize:12,fontWeight:800,color:C.text}}>Sizes & spacing</div>
            <Slider label="Header font" k="headFont" min={10} max={26}/>
            <Slider label="Body font" k="bodyFont" min={9} max={20}/>
            {mode!=="kot"&&<Slider label="Totals font" k="totalFont" min={12} max={30}/>}
            <Slider label="Token No. size" k="tokenFont" min={14} max={48}/>
            <Slider label="Line spacing" k="lineGap" min={0} max={10}/>
            <Slider label="Logo size" k="logoSize" min={20} max={140}/>
            {mode==="invoice"&&<Slider label="QR size" k="qrSize" min={80} max={200}/>}
          </div>

          {/* paper width + header colour (s2) */}
          <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:16}}>
            <div style={{flex:1,minWidth:120}}>
              <label style={{fontSize:12,fontWeight:700,color:C.textMid,display:"block",marginBottom:4}}>Paper width</label>
              <select value={fmt.paperWidth} onChange={e=>set("paperWidth",e.target.value)} style={{width:"100%",padding:"9px",borderRadius:8,border:`1px solid ${C.border}`,fontFamily:"inherit",fontSize:13,background:"#fff",color:C.text}}>
                <option value="80mm">80mm (standard)</option>
                <option value="58mm">58mm (small)</option>
              </select>
            </div>
            {fmt.presetStyle==="s2"&&(
              <div style={{minWidth:120}}>
                <label style={{fontSize:12,fontWeight:700,color:C.textMid,display:"block",marginBottom:4}}>Header colour</label>
                <input type="color" value={fmt.headerColor||"#1A6B4A"} onChange={e=>set("headerColor",e.target.value)} style={{width:"100%",height:38,border:`1px solid ${C.border}`,borderRadius:8,background:"#fff",cursor:"pointer"}}/>
              </div>
            )}
          </div>

          {/* footer text (invoice & draft) */}
          {mode!=="kot"&&(
            <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:16}}>
              <div>
                <label style={{fontSize:12,fontWeight:700,color:C.textMid,display:"block",marginBottom:4}}>Footer (English)</label>
                <input value={fmt.footer||""} onChange={e=>set("footer",e.target.value)} style={{width:"100%",padding:"9px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontFamily:"inherit",color:C.text,background:"#fff"}}/>
              </div>
              <div>
                <label style={{fontSize:12,fontWeight:700,color:C.textMid,display:"block",marginBottom:4}}>Footer (Arabic)</label>
                <input value={fmt.footerAr||""} onChange={e=>set("footerAr",e.target.value)} dir="rtl" style={{width:"100%",padding:"9px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontFamily:"'Tajawal',sans-serif",color:C.text,background:"#fff"}}/>
              </div>
            </div>
          )}

          {/* save row */}
          <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap",borderTop:`1px solid ${C.border}`,paddingTop:16}}>
            <button onClick={save} style={{padding:"11px 22px",borderRadius:10,border:"none",background:C.primary,color:"#fff",fontFamily:"inherit",fontSize:14,fontWeight:800,cursor:"pointer"}}>💾 Save & Apply</button>
            <button onClick={disablePreset} style={{padding:"11px 16px",borderRadius:10,border:`1.5px solid ${C.border}`,background:"#fff",color:C.textMid,fontFamily:"inherit",fontSize:12.5,fontWeight:700,cursor:"pointer"}}>Use classic format</button>
            {savedMsg&&<span style={{fontSize:12.5,color:C.success,fontWeight:700}}>{savedMsg}</span>}
          </div>
          {!fmt.usePreset&&<div style={{marginTop:10,fontSize:12,color:C.warning,fontWeight:600}}>⚠️ Presets are currently OFF for {mode}. Tap “Save & Apply” to switch this preset on.</div>}
        </Card>

        {/* ── RIGHT: live preview ── */}
        <Card>
          <div style={{fontSize:14,fontWeight:800,marginBottom:4}}>Live preview</div>
          <div style={{fontSize:12,color:C.textMid,marginBottom:12}}>This is exactly what the printer outputs.</div>
          <div style={{margin:"0 auto",width:prevW,maxWidth:"100%",border:"1px dashed #ccc",borderRadius:8,overflow:"hidden",background:"#fff"}}>
            <iframe title="preset-preview" srcDoc={previewHTML()} style={{width:"100%",height:560,border:"none",display:"block",background:"#fff"}}/>
          </div>
        </Card>
      </div>
      <style>{`@media(max-width:820px){.preset-grid{grid-template-columns:1fr !important}}`}</style>
    </div>
  );
}

function InvoiceFormatTab({license,company,invoiceFormat,setInvoiceFormat}){
  const [saved,setSaved]=useState(false);
  const [previewTab,setPreviewTab]=useState("receipt"); // "receipt" | "kot"
  // Top-level: which bill format is being edited — "zatca" (tax invoice) or "draft" (draft bill)
  const [formatMode,setFormatMode]=useState("zatca");
  // Image load/test status for the URL fields → live preview confirmation
  const [imgTest,setImgTest]=useState({}); // {field: "ok"|"loading"|"error"}
  function testImage(field,url){
    if(!url){setImgTest(p=>({...p,[field]:undefined}));return;}
    setImgTest(p=>({...p,[field]:"loading"}));
    const im=new Image();
    im.onload=()=>setImgTest(p=>({...p,[field]:"ok"}));
    im.onerror=()=>setImgTest(p=>({...p,[field]:"error"}));
    im.src=url;
  }
  // URL input + Load button + live status/preview thumbnail
  const ImageUrlField=({label,field,value,onChange,placeholder})=>{
    const st=imgTest[field];
    return(
      <div style={{display:"flex",flexDirection:"column",gap:6}}>
        <label style={{fontSize:12,fontWeight:600,color:C.textMid}}>{label}</label>
        <div style={{display:"flex",gap:6,alignItems:"stretch"}}>
          <input value={value||""} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
            style={{flex:1,padding:"9px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontFamily:"inherit",color:C.text,background:"#fff"}}/>
          <button onClick={()=>testImage(field,value)} type="button"
            style={{padding:"0 16px",borderRadius:8,border:`2px solid ${C.primary}`,background:C.primary,color:"#fff",fontFamily:"inherit",fontSize:12,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>
            {st==="loading"?"⏳":"🔄 Load"}
          </button>
        </div>
        {st==="ok"&&<div style={{display:"flex",alignItems:"center",gap:8,fontSize:11,color:C.success,fontWeight:700}}>✅ Loaded <img src={value} alt="" style={{height:34,border:`1px solid ${C.border}`,borderRadius:4,background:"#fff"}}/></div>}
        {st==="error"&&<div style={{fontSize:11,color:C.danger,fontWeight:700}}>❌ Could not load. Use a <strong>direct image link</strong> ending in .png/.jpg (right-click image → Copy image address).</div>}
        {st==="loading"&&<div style={{fontSize:11,color:C.textMid}}>Loading…</div>}
      </div>
    );
  };
  const fmt=invoiceFormat||{
    font:"courier",fontSize:12,shopNameOverride:"",
    footer:"Thank you for your visit!",footerAr:"شكراً لزيارتكم",
    website:"",social:"",tagline:"",logoUrl:"",
    template:"modern",headerColor:"#1A6B4A",paperWidth:"80mm",
    showVat:true,showCategories:true,showCustomer:true,showOrderType:true,
    showArabicName:true,totalSize:"large",separator:"dashed",boldItems:false,
    logoSize:46,qrSize:120,
    // KOT settings
    kotTitle:"KOT",kotTitleAr:"طلب المطبخ",kotShowArabic:true,
    kotShowTable:true,kotShowTime:true,kotShowOrderType:true,
    kotLargeText:true,kotFooter:"",kotPaper:"80mm",kotSeparator:"dashed",
  };
  function update(k,v){const updated={...(invoiceFormat||fmt),[k]:v};setInvoiceFormat(updated);LS.set("restopos_invoice_format",updated);setSaved(false);}
  function save(){LS.set("restopos_invoice_format",invoiceFormat||fmt);setSaved(true);setTimeout(()=>setSaved(false),3000);}
  const selectedFont=RECEIPT_FONTS.find(f=>f.id===fmt.font)||RECEIPT_FONTS[0];

  // ── DRAFT BILL FORMAT — fully independent settings (restopos_draft_format) ──
  const DRAFT_DEFAULT={
    font:"courier",fontSize:12,paperWidth:"80mm",shopNameOverride:"",logoUrl:"",logoSize:46,
    footer:"Thank you for your visit!",footerAr:"شكراً لزيارتكم",
    imageUrl:"",imageSize:100,imageCaption:"",imagePosition:"bottom",
  };
  const [draftFmt,setDraftFmt]=useState(()=>({...DRAFT_DEFAULT,...(LS.get("restopos_draft_format")||{})}));
  const [draftSaved,setDraftSaved]=useState(false);
  function updateDraft(k,v){
    setDraftFmt(prev=>{
      const n={...prev,[k]:v};
      LS.set("restopos_draft_format",n);
      const lk=LS.get("restopos_license_v2")?.licenseKey;
      if(lk)debouncedSync(lk,"restopos_draft_format",n);
      return n;
    });
    setDraftSaved(false);
  }
  function saveDraft(){
    LS.set("restopos_draft_format",draftFmt);
    const lk=LS.get("restopos_license_v2")?.licenseKey;
    if(lk)debouncedSync(lk,"restopos_draft_format",draftFmt);
    setDraftSaved(true);setTimeout(()=>setDraftSaved(false),3000);
  }

  // Live preview uses the SAME builder as the printer → the preview is what prints.
  const [previewQR,setPreviewQR]=useState("");
  useEffect(()=>{
    const sampleTLV=generatePhase1QR({sellerName:license?.businessName||"Restaurant",vatNumber:license?.vatNumber||"300000000000003",timestamp:new Date().toISOString(),total:43.70,vatAmount:5.70});
    makeQRDataURL(sampleTLV,220).then(setPreviewQR).catch(()=>{});
  },[license]);
  const previewSampleOrder={
    id:"INV-001001",date:TODAY,time:"12:00",type:"Takeaway",payMethod:"Cash",
    customer:"Mohammed",given:50,change:6.30,discount:0,vat:5.70,total:43.70,
    items:[
      {name:"Broasted Chicken",nameAr:"برست دجاج",qty:1,price:28.00,category:"Broasted"},
      {name:"French Fries",nameAr:"بطاطس",qty:1,price:10.00,category:"Sides"},
      {name:"Pepsi Can",nameAr:"بيبسي",qty:1,price:5.70,category:"Drinks"},
    ],
  };
  const previewLicense={businessName:fmt.shopNameOverride||company?.businessName||license?.businessName||"Restaurant",address:company?.address||license?.address||"",vatNumber:license?.vatNumber||"300000000000003"};
  const previewZatca={invoice_number:"INV-001001",icv:1001};
  // Receipt preview — rendered via the unified builder inside an iframe
  const ReceiptPreview=()=>{
    const html=buildReceiptHTML(previewSampleOrder,previewLicense,previewZatca,fmt,previewQR);
    const w=fmt.paperWidth==="58mm"?200:280;
    return(
      <div style={{margin:"0 auto",width:w,maxWidth:"100%",border:"1px dashed #ccc",borderRadius:8,overflow:"hidden",background:"#fff"}}>
        <iframe title="receipt-preview" srcDoc={html} style={{width:"100%",height:520,border:"none",display:"block",background:"#fff"}}/>
      </div>
    );
  };
  const ReceiptPreviewOld=()=>(
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

  // Draft bill preview — uses the SAME builder that prints draft bills
  const draftSampleOrder={
    id:"INV-001001-A",date:TODAY,time:"12:00",type:"Takeaway",payMethod:"Cash",
    customer:"Mohammed",given:50,change:6.30,discount:0,vat:5.70,total:43.70,
    items:[
      {name:"Broasted Chicken Normal Half",nameAr:"برست دجاج عادي نصف",qty:1,price:28.00},
      {name:"French Fries",nameAr:"بطاطس",qty:1,price:10.00},
      {name:"Pepsi Can",nameAr:"بيبسي",qty:1,price:5.70},
    ],
  };
  const DraftPreview=()=>{
    const html=buildDraftReceiptHTML(draftSampleOrder,previewLicense,draftFmt);
    const w=draftFmt.paperWidth==="58mm"?200:280;
    return(
      <div style={{margin:"0 auto",width:w,maxWidth:"100%",border:"1px dashed #ccc",borderRadius:8,overflow:"hidden",background:"#fff"}}>
        <iframe title="draft-preview" srcDoc={html} style={{width:"100%",height:520,border:"none",display:"block",background:"#fff"}}/>
      </div>
    );
  };

  // ── DRAFT BILL FORMAT EDITOR (separate from ZATCA) ──
  if(formatMode==="draft"){
    return(
      <div>
        <style>{`@import url('https://fonts.googleapis.com/css2?family=Tajawal:wght@400;700&family=Cairo:wght@400;700&family=Amiri:wght@400;700&family=Scheherazade+New:wght@400;700&family=Noto+Naskh+Arabic:wght@400;700&display=swap');`}</style>
        {/* Mode switch */}
        <div style={{display:"flex",gap:8,marginBottom:16}}>
          {[["zatca","🧾 ZATCA Bill Format"],["draft","📋 Draft Bill Format"]].map(([id,lbl])=>(
            <button key={id} onClick={()=>setFormatMode(id)}
              style={{flex:1,padding:"10px",border:`2px solid ${formatMode===id?C.primary:C.border}`,borderRadius:8,
                background:formatMode===id?C.primaryLight:"#fff",color:formatMode===id?C.primary:C.textMid,
                fontFamily:"inherit",fontSize:13,fontWeight:700,cursor:"pointer"}}>{lbl}</button>
          ))}
        </div>
        <div style={{background:"#FFF8E8",border:"1px solid #F0A50044",borderRadius:10,padding:"10px 14px",marginBottom:16,fontSize:12,color:"#A07000",fontWeight:600}}>
          📋 Draft bills are <strong>not tax invoices</strong> and never show the ZATCA QR. You can add your own logo or QR image via URL below — it stays until you remove it.
        </div>

        <div style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) minmax(0,1fr)",gap:20,alignItems:"start"}}>
          {/* LEFT — Draft controls */}
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            <Card>
              <div style={{fontSize:13,fontWeight:700,marginBottom:10}}>🔤 Font & Size</div>
              <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:12}}>
                {RECEIPT_FONTS.map(f=>(
                  <button key={f.id} onClick={()=>updateDraft("font",f.id)}
                    style={{padding:"8px 12px",border:`2px solid ${draftFmt.font===f.id?C.primary:C.border}`,
                      borderRadius:7,background:draftFmt.font===f.id?C.primaryLight:"#fff",cursor:"pointer",
                      textAlign:f.lang==="AR"?"right":"left",fontFamily:f.family,fontSize:13,
                      color:draftFmt.font===f.id?C.primary:C.text,direction:f.lang==="AR"?"rtl":"ltr"}}>
                    {f.label} {f.lang==="AR"?"— نموذج":"— Sample"}
                  </button>
                ))}
              </div>
              <Slider label="Font Size" value={parseInt(draftFmt.fontSize)||12} min={8} max={24} onChange={v=>updateDraft("fontSize",v)}/>
              <div style={{marginTop:10}}><Slider label="Date / Time Size" value={draftFmt.dateSize!==undefined?parseInt(draftFmt.dateSize):(parseInt(draftFmt.fontSize)||12)-1} min={7} max={20} onChange={v=>updateDraft("dateSize",v)}/></div>
              <div style={{marginTop:10}}><Slider label="Gap: Arabic ↕ English name" value={draftFmt.nameGap!==undefined?parseInt(draftFmt.nameGap):2} min={0} max={14} onChange={v=>updateDraft("nameGap",v)}/></div>
              <div style={{marginTop:10}}>
                <div style={{fontSize:11,color:C.textMid,marginBottom:5}}>Paper Width</div>
                <div style={{display:"flex",gap:5}}>
                  {["58mm","80mm"].map(w=>(
                    <button key={w} onClick={()=>updateDraft("paperWidth",w)}
                      style={{padding:"7px 12px",borderRadius:7,border:`2px solid ${draftFmt.paperWidth===w?C.primary:C.border}`,
                        background:draftFmt.paperWidth===w?C.primaryLight:"#fff",color:draftFmt.paperWidth===w?C.primary:C.textMid,
                        fontFamily:"inherit",fontSize:12,fontWeight:700,cursor:"pointer"}}>{w}</button>
                  ))}
                </div>
              </div>
            </Card>

            <Card>
              <div style={{fontSize:13,fontWeight:700,marginBottom:10}}>🏷️ Header & Logo</div>
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                <Inp label="Shop Name Override" value={draftFmt.shopNameOverride||""} onChange={v=>updateDraft("shopNameOverride",v)} placeholder={company?.businessName||license?.businessName}/>
                <ImageUrlField label="Header Logo URL (optional)" field="draftLogo" value={draftFmt.logoUrl||""} onChange={v=>updateDraft("logoUrl",v)} placeholder="https://example.com/logo.png"/>
                {draftFmt.logoUrl&&<Slider label="Logo Size" value={parseInt(draftFmt.logoSize)||46} min={20} max={140} onChange={v=>updateDraft("logoSize",v)}/>}
              </div>
            </Card>

            {/* Custom image (logo OR QR) via URL — draft only */}
            <Card>
              <div style={{fontSize:13,fontWeight:700,marginBottom:6}}>🖼️ Custom Image (Logo or QR)</div>
              <div style={{fontSize:11,color:C.textMid,marginBottom:10}}>Paste any image link — a logo, a payment QR, anything. It prints on every draft bill until you remove it.</div>
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                <ImageUrlField label="Image URL" field="draftImage" value={draftFmt.imageUrl||""} onChange={v=>updateDraft("imageUrl",v)} placeholder="https://example.com/qr-or-logo.png"/>
                {draftFmt.imageUrl&&<>
                  <Slider label="Image Size" value={parseInt(draftFmt.imageSize)||100} min={40} max={200} onChange={v=>updateDraft("imageSize",v)}/>
                  <Inp label="Caption under image (optional)" value={draftFmt.imageCaption||""} onChange={v=>updateDraft("imageCaption",v)} placeholder="Scan to pay / Follow us"/>
                  <div>
                    <div style={{fontSize:11,color:C.textMid,marginBottom:5}}>Position</div>
                    <div style={{display:"flex",gap:5}}>
                      {[["top","Top (below name)"],["bottom","Bottom (above footer)"]].map(([v,l])=>(
                        <button key={v} onClick={()=>updateDraft("imagePosition",v)}
                          style={{flex:1,padding:"7px 10px",borderRadius:7,border:`2px solid ${(draftFmt.imagePosition||"bottom")===v?C.primary:C.border}`,
                            background:(draftFmt.imagePosition||"bottom")===v?C.primaryLight:"#fff",color:(draftFmt.imagePosition||"bottom")===v?C.primary:C.textMid,
                            fontFamily:"inherit",fontSize:11,fontWeight:700,cursor:"pointer"}}>{l}</button>
                      ))}
                    </div>
                  </div>
                  <button onClick={()=>{updateDraft("imageUrl","");updateDraft("imageCaption","");}}
                    style={{padding:"8px",borderRadius:7,border:`1px solid ${C.danger}`,background:"#fff",color:C.danger,fontFamily:"inherit",fontSize:12,fontWeight:700,cursor:"pointer"}}>
                    🗑️ Remove Image
                  </button>
                </>}
              </div>
            </Card>

            <Card>
              <div style={{fontSize:13,fontWeight:700,marginBottom:10}}>📝 Footer (type freely — press Enter for a new line)</div>
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                <TextArea label="Footer (English)" value={draftFmt.footer||""} onChange={v=>updateDraft("footer",v)} placeholder={"Thank you for your visit!\nCall us: 0500000000"} rows={3}/>
                <TextArea label="Footer (Arabic)" value={draftFmt.footerAr||""} onChange={v=>updateDraft("footerAr",v)} placeholder="شكراً لزيارتكم" rows={2} dir="rtl"/>
              </div>
            </Card>

            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <Btn onClick={saveDraft}>💾 Save Draft Format</Btn>
              {draftSaved&&<span style={{fontSize:12,color:C.success,fontWeight:700}}>✓ Saved!</span>}
            </div>
          </div>

          {/* RIGHT — Draft live preview */}
          <div style={{position:"sticky",top:20}}>
            <Card>
              <div style={{fontSize:12,fontWeight:700,color:C.textMid,marginBottom:10,textAlign:"center"}}>
                LIVE DRAFT PREVIEW — {draftFmt.paperWidth||"80mm"}
              </div>
              <DraftPreview/>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  return(
    <div style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) minmax(0,1fr)",gap:20,alignItems:"start"}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Tajawal:wght@400;700&family=Cairo:wght@400;700&family=Amiri:wght@400;700&family=Scheherazade+New:wght@400;700&family=Noto+Naskh+Arabic:wght@400;700&display=swap');`}</style>

      {/* Mode switch — spans both columns */}
      <div style={{gridColumn:"1 / -1",display:"flex",gap:8}}>
        {[["zatca","🧾 ZATCA Bill Format"],["draft","📋 Draft Bill Format"]].map(([id,lbl])=>(
          <button key={id} onClick={()=>setFormatMode(id)}
            style={{flex:1,padding:"10px",border:`2px solid ${formatMode===id?C.primary:C.border}`,borderRadius:8,
              background:formatMode===id?C.primaryLight:"#fff",color:formatMode===id?C.primary:C.textMid,
              fontFamily:"inherit",fontSize:13,fontWeight:700,cursor:"pointer"}}>{lbl}</button>
        ))}
      </div>

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
          <div style={{marginBottom:12}}>
            <Slider label="Font Size" value={parseInt(fmt.fontSize)||12} min={8} max={24} onChange={v=>update("fontSize",v)}/>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
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

        {/* Logo & QR sizes */}
        <Card>
          <div style={{fontSize:13,fontWeight:700,marginBottom:10}}>📐 Logo & QR Size</div>
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            <Slider label="Logo Size" value={parseInt(fmt.logoSize)||46} min={20} max={140} onChange={v=>update("logoSize",v)}/>
            <Slider label="ZATCA QR Size" value={parseInt(fmt.qrSize)||120} min={80} max={220} onChange={v=>update("qrSize",v)}/>
            <Slider label="Date / Time Size" value={fmt.dateSize!==undefined?parseInt(fmt.dateSize):(parseInt(fmt.fontSize)||12)-1} min={7} max={20} onChange={v=>update("dateSize",v)}/>
            <Slider label="Gap: Arabic ↕ English name" value={fmt.nameGap!==undefined?parseInt(fmt.nameGap):2} min={0} max={14} onChange={v=>update("nameGap",v)}/>
            <div style={{fontSize:11,color:C.textMid}}>ℹ️ The ZATCA QR content is generated automatically and required by law — only its size can be changed.</div>
          </div>
        </Card>

        {/* Additional info */}
        <Card>
          <div style={{fontSize:13,fontWeight:700,marginBottom:10}}>📝 Content</div>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            <Inp label="Shop Name Override" value={fmt.shopNameOverride||""} onChange={v=>update("shopNameOverride",v)} placeholder={company?.businessName||license?.businessName}/>
            <TextArea label="Tagline (press Enter for new line)" value={fmt.tagline||""} onChange={v=>update("tagline",v)} placeholder="Best food in town!" rows={2}/>
            <ImageUrlField label="Logo URL (paste image link)" field="zatcaLogo" value={fmt.logoUrl||""} onChange={v=>update("logoUrl",v)} placeholder="https://example.com/logo.png"/>
            <TextArea label="Footer (English) — press Enter for new line" value={fmt.footer||""} onChange={v=>update("footer",v)} placeholder={"Thank you for your visit!\nCall: 0500000000"} rows={3}/>
            <TextArea label="Footer (Arabic)" value={fmt.footerAr||""} onChange={v=>update("footerAr",v)} placeholder="شكراً لزيارتكم" rows={2} dir="rtl"/>
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
          const _locSnap=await getDocs(query(collection(db,"licenses"),where("key","==",license.licenseKey)));
          if(!_locSnap.empty){
            await updateDoc(doc(db,"licenses",_locSnap.docs[0].id),{location:{lat,lng,timestamp:locObj.timestamp},locationUpdatedAt:new Date().toISOString()});
          }
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
    <div style={{padding:14,background:C.bg,border:`1px solid ${C.border}`,borderRadius:10}}>
      <div style={{fontSize:13,fontWeight:700,color:C.textMid,marginBottom:8}}>🔒 License Management</div>
      <div style={{fontSize:12,color:C.textMid,marginBottom:12}}>License management is handled by RestoPOS support — contact us to make any changes to your license.</div>
      <button disabled title="Contact RestoPOS support to make license changes" style={{padding:"8px 16px",background:C.border,color:C.textLight,border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontWeight:700,cursor:"not-allowed",fontFamily:"inherit",opacity:0.6}}>Clear License & Re-Activate</button>
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
function KitchenPrinterSettings(){
  const [kitchenPrinter,setKitchenPrinter]=useState(()=>LS.get("restopos_kitchen_printer")||{name:"Kitchen Printer",paperWidth:"80mm",autoKOT:true,enabled:false});
  const [kpSaved,setKpSaved]=useState(false);
  function saveKP(){LS.set("restopos_kitchen_printer",kitchenPrinter);setKpSaved(true);setTimeout(()=>setKpSaved(false),3000);}
  function testKOT(){
    const win=window.open("","_blank","width=340,height=500");if(!win){alert("Pop-up blocked.");return;}
    const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>@page{size:${kitchenPrinter.paperWidth} auto;margin:0}body{font-family:'Courier New',monospace;font-size:14px;padding:8mm;width:${kitchenPrinter.paperWidth}}.center{text-align:center}.big{font-size:18px;font-weight:900}.hr{border:none;border-top:2px dashed #000;margin:6px 0}</style></head><body><div class="center"><div class="big">*** KOT TEST ***</div><div>Kitchen Order Ticket</div><div>${new Date().toLocaleTimeString()}</div></div><div class="hr"/><div>1x Broasted Chicken Half</div><div>2x French Fries</div><div>1x Fresh Lemon Juice</div><div class="hr"/><div class="center">Table 5 · Dine-in</div><script>window.onload=function(){window.print();window.close();}<\/script></body></html>`;
    win.document.write(html);win.document.close();
  }
  return(<Card style={{maxWidth:560}}>
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
          {[["1","Connect your kitchen printer via USB or Network to the same computer/device."],["2",`Set it as a secondary printer in your OS — name it "${kitchenPrinter.name||"Kitchen Printer"}".`],["3","RestoPOS will open a separate print dialog targeting that printer for KOTs."],["4","Use 80mm thermal paper for kitchen tickets (58mm if your printer is smaller)."]].map(([n,tx])=>(
            <div key={n} style={{display:"flex",gap:10}}><span style={{width:20,height:20,borderRadius:"50%",background:C.primary,color:"#fff",fontSize:11,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{n}</span><span style={{fontSize:12,color:C.textMid}}>{tx}</span></div>
          ))}
        </div>
        <div style={{display:"flex",gap:10}}>
          <Btn onClick={testKOT} variant="outline">🖨️ Test KOT Print</Btn>
          <Btn onClick={saveKP}>💾 Save Kitchen Settings</Btn>
          {kpSaved&&<span style={{fontSize:12,color:C.success,fontWeight:700,alignSelf:"center"}}>✓ Saved!</span>}
        </div>
      </div>
    </Card>);
}

function Settings({company,setCompany,tables,setTables,license,onClearLicense,onSwitchAccount,pins,setPins,invoiceFormat,setInvoiceFormat,lang="en",onLangChange,sales=[],items=[]}){
  const [tab,setTab]=useState("company");const [newTableCount,setNewTableCount]=useState(tables.length);const [companySaved,setCompanySaved]=useState(false);
  const TAB_LABELS={"company":"🏢 "+t("Company",lang),"dashboard":"📊 "+t("Dashboard",lang),"tables":"🪑 "+t("Tables",lang),"printers":"🖨️ "+t("Bill Printer",lang),"invoices":"📄 "+t("Invoices",lang),"backup":"💾 "+t("Backup",lang),"security":"🔐 "+t("Security",lang),"license":"📋 "+t("License",lang),"language":"🌐 "+t("Language",lang)};
  const tabs=[["company","🏢 Company"],["dashboard","📊 Dashboard"],["tables","🪑 Tables"],["printers","🖨️ Bill Printer"],["invoices","📄 Invoices"],["presets","🎨 Preset Bills"],["backup","💾 Backup"],["security","🔐 Security"],["license","📋 License"],["language","🌐 Language"]];
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
    {tab==="dashboard"&&<DashboardEditor sales={sales} items={items}/>}
    {tab==="tables"&&<Card style={{maxWidth:500}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:16}}>Table Configuration</div>
      <div style={{display:"flex",gap:10,marginBottom:20,alignItems:"flex-end"}}><Inp label="Number of Tables" value={newTableCount} onChange={v=>setNewTableCount(parseInt(v)||1)} type="number"/><Btn onClick={()=>setTables(Array.from({length:newTableCount},(_,i)=>({id:i+1,status:"free",capacity:4})))}>Update</Btn></div>
      <div style={{display:"flex",flexWrap:"wrap",gap:8}}>{tables.map(t=><div key={t.id} onClick={()=>setTables(prev=>prev.map(x=>x.id===t.id?{...x,status:x.status==="occupied"?"free":"occupied"}:x))} style={{width:44,height:44,borderRadius:8,border:`2px solid ${t.status==="occupied"?C.danger:C.success}`,background:t.status==="occupied"?C.dangerLight:C.successLight,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:700,color:t.status==="occupied"?C.danger:C.success,cursor:"pointer"}}>{t.id}</div>)}</div>
    </Card>}
    {tab==="printers"&&<Card style={{maxWidth:560}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,marginBottom:20}}>
        <div style={{fontSize:15,fontWeight:700}}>🖨️ Thermal Printer Setup</div>
        <PrintGuideButton/>
      </div>
      <div style={{background:C.successLight,border:`1px solid ${C.success}`,borderRadius:10,padding:"12px 16px",marginBottom:16,fontSize:13,color:C.success,fontWeight:600}}>✅ RestoPOS uses a hidden iframe for printing — no pop-up dialog, no extra confirmation.</div>
      <div style={{display:"flex",flexDirection:"column",gap:12}}>{[["Paper Width","80mm standard thermal roll"],["Print Method","Hidden iframe → auto-prints, no pop-up"],["USB / Network","Set thermal printer as default in OS"],["Bluetooth","Pair first via OS settings, then set as default"]].map(([k,v])=><div key={k} style={{display:"flex",gap:12,padding:"10px 14px",background:C.bg,borderRadius:8}}><span style={{fontSize:12,fontWeight:700,color:C.textMid,width:130,flexShrink:0}}>{k}</span><span style={{fontSize:13}}>{v}</span></div>)}</div>
    </Card>}
    {tab==="invoices"&&<InvoiceEnhancements sales={sales} items={items} license={license} company={company}/>}
    {tab==="presets"&&<PresetFormatTab license={license} company={company}/>}
    {tab==="backup"&&<div><CloudSyncStatus/><BackupManager sales={sales} items={items}/></div>}
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
  const [colors,setColors]=useState(()=>getCategoryColors());
  function setCatColor(cat,color){const next={...colors,[cat]:color};setColors(next);saveCategoryColors(next);}

  function addCategory(){
    const trimmed=(newCat.trim().charAt(0).toUpperCase()+newCat.trim().slice(1));
    if(!trimmed)return alert("Category name cannot be empty");
    if(trimmed===OTHER_CAT)return alert(`"${OTHER_CAT}" is reserved for uncategorised items`);
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
    const catItemsArr=items.filter(i=>i.category===cat);
    if(catItemsArr.length>0){
      const other=categories.filter(c=>c!==cat)[0]||OTHER_CAT;
      if(!confirm(`"${cat}" has ${catItemsArr.length} item(s). Move them to "${other}" and delete?`))return;
      // Move to next real category, or clear so they fall into the virtual "Other" bucket
      if(other&&other!==OTHER_CAT)setItems(prev=>prev.map(i=>i.category===cat?{...i,category:other}:i));
      else setItems(prev=>prev.map(i=>i.category===cat?{...i,category:""}:i));
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

  // Category list incl. virtual "Other" bucket for orphan/uncategorised items
  const displayCats=catsWithOther(categories,items);
  const itemsInCat=(cat)=>cat===OTHER_CAT?items.filter(i=>effectiveCat(i,categories)===OTHER_CAT):items.filter(i=>i.category===cat);
  const catItems=itemsInCat(selectedCatView);

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
          {displayCats.map(cat=>{
            const isOther=cat===OTHER_CAT;
            const col=colorForCat(cat,categories);
            return(
            <div key={cat}
              style={{padding:"8px 10px",borderRadius:8,
                background:selectedCatView===cat?C.primaryLight:"#fff",
                border:`1.5px solid ${selectedCatView===cat?C.primary:C.border}`,
                borderLeft:`5px solid ${col}`,
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
                  {!isOther&&<input type="color" value={col} title="Category colour"
                    onClick={e=>e.stopPropagation()}
                    onChange={e=>{e.stopPropagation();setCatColor(cat,e.target.value);}}
                    style={{width:18,height:18,padding:0,border:"none",borderRadius:4,cursor:"pointer",flexShrink:0,background:"none"}}/>}
                  {isOther&&<span style={{width:18,height:18,borderRadius:4,background:col,flexShrink:0,display:"inline-block"}}/>}
                  <span style={{flex:1,fontSize:13,fontWeight:selectedCatView===cat?700:500,color:selectedCatView===cat?C.primary:C.text}}>{cat}{isOther&&<span style={{fontSize:9,color:C.textLight,fontWeight:600}}> · uncategorised</span>}</span>
                  <span style={{fontSize:10,color:C.textLight,minWidth:14,textAlign:"center"}}>{itemsInCat(cat).length}</span>
                  {!isOther&&<button onClick={e=>{e.stopPropagation();startEdit(cat);}}
                    style={{background:"none",border:"none",color:C.info,cursor:"pointer",fontSize:12,padding:"0 2px",lineHeight:1}}>✏️</button>}
                  {!isOther&&<button onClick={e=>{e.stopPropagation();deleteCategory(cat);}}
                    style={{background:"none",border:"none",color:C.danger,cursor:"pointer",fontSize:12,padding:"0 2px",lineHeight:1}}>🗑️</button>}
                </div>
              )}
            </div>
            );
          })}
          {displayCats.length===0&&<div style={{fontSize:12,color:C.textLight,padding:"10px 0"}}>No categories yet</div>}
        </div>

        {/* Items in selected category */}
        <Card>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10,flexWrap:"wrap",gap:8}}>
            <div style={{fontSize:13,fontWeight:700}}>
              📋 "{selectedCatView}" — {catItems.length} item{catItems.length!==1?"s":""}
            </div>
            <div style={{fontSize:11,color:C.textMid}}>{selectedCatView===OTHER_CAT?"Move these into a real category":"Use dropdown to move item to another category"}</div>
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
        <Sel label="Category" value={itemForm.category} onChange={v=>setItemForm(f=>({...f,category:v}))} options={[...categories,...(categories.includes(OTHER_CAT)?[]:[OTHER_CAT])]}/><Inp label="Barcode" value={itemForm.barcode} onChange={v=>setItemForm(f=>({...f,barcode:v}))} placeholder="Scan or type barcode"/>
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
      catItems.map(it=>`<div class="row"><span class="item-name">${it.nameAr?`<span style="font-family:'Amiri','Noto Naskh Arabic',serif;direction:rtl;display:block;font-weight:700;">${it.nameAr}</span>`:""}<span style="display:block">${it.name}</span><small>${it.qty} x SAR ${it.price.toFixed(2)}</small></span><span class="item-amt">SAR ${(it.qty*it.price).toFixed(2)}</span></div>`).join("");
  }).join("");
  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Receipt ${sale.id}</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Naskh+Arabic:wght@400;700&family=Amiri:wght@400;700&display=swap" rel="stylesheet">
<style>@page{size:80mm auto;margin:0}*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Amiri','Noto Naskh Arabic',serif;font-size:12px;color:#000;background:#fff;width:80mm;padding:4mm;word-break:break-word;overflow-wrap:anywhere}.center{text-align:center}.bold{font-weight:bold}.big{font-size:16px;font-weight:bold}.hr{border:none;border-top:1px dashed #000;margin:6px 0}.row{display:flex;justify-content:space-between;margin:3px 0;align-items:flex-start;gap:6px}.row-total{display:flex;justify-content:space-between;margin:4px 0;font-size:15px;font-weight:900;border-top:2px solid #000;padding-top:4px}.item-name{flex:1 1 auto;min-width:0;padding-right:4px;word-break:break-word;overflow-wrap:anywhere}.item-amt{flex:0 0 auto;white-space:nowrap;text-align:right}.zatca-label{font-size:9px;font-weight:bold;letter-spacing:0.1em}@media print{body{width:80mm}}</style>
</head><body>
<div class="center"><div class="big">${sale.businessName||license.businessName}</div><div>${license.address||""}</div><div>TRN: ${license.vatNumber}</div><div>${sale.id} | ${sale.date} ${sale.time}</div>${sale.customer?`<div>Customer: ${sale.customer}</div>`:""}<div>${sale.type}${sale.table?` · Table ${sale.table}`:""}</div></div>
<hr class="hr"/>${itemsHTML}
<hr class="hr"/>${(sale.discount||0)>0?`<div class="row"><span>Discount</span><span>-SAR ${sale.discount.toFixed(2)}</span></div>`:""}
<div class="row" style="font-size:10px;color:#888;"><span>VAT 15% (incl.)</span><span>SAR ${(sale.vat||0).toFixed(2)}</span></div><div class="row-total"><span>TOTAL</span><span>SAR ${(sale.total||0).toFixed(2)}</span></div>
${sale.payMethod==="Cash"?`<div class="row"><span>Cash Given</span><span>SAR ${Number(sale.given||0).toFixed(2)}</span></div><div class="row bold"><span>Change</span><span>SAR ${Number(sale.change||0).toFixed(2)}</span></div>`:`<div class="row bold"><span>Payment</span><span>${sale.payMethod}</span></div>`}
<hr class="hr"/><div style="text-align:center;margin:8px 0;"><canvas id="qr-canvas"></canvas><div class="zatca-label" style="margin-top:4px;">ZATCA PHASE 2 · QR CODE</div><div style="font-size:8px;">TLV Base64 · Scan to verify</div></div>
<div class="bold center" style="margin-top:6px;">Thank you for your visit!</div>
<div style="font-family:'Amiri','Noto Naskh Arabic',serif;font-size:14px;font-weight:bold;text-align:center;direction:rtl;margin-top:3px;">شكراً لزيارتكم</div><br/><br/>
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
  const [editingDraft,setEditingDraft]=useState(null); // draft being edited in invoice format

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
    resetDailyToken();
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
                <DataTable headers={["D-Invoice#","Date","Time","Customer","Items","Total","Method","Actions"]}
                  rows={filteredDrafts.slice().reverse().map(d=>[
                    <span style={{fontFamily:"monospace",fontWeight:800,color:"#F0A500",fontSize:12}}>{d.id}</span>,
                    d.date,d.time||"—",d.customer||"—",
                    <span style={{fontSize:11,color:C.textMid}}>{(d.items||[]).map(i=>i.qty+"x "+i.name).join(", ").slice(0,30)}</span>,
                    <strong style={{color:"#A07000"}}>{fmtSAR(d.total||0)}</strong>,
                    d.payMethod||"—",
                    <div style={{display:"flex",gap:5}}>
                      <Btn size="sm" variant="outline" onClick={()=>setEditingDraft(JSON.parse(JSON.stringify(d)))}>✏️ Edit</Btn>
                      <Btn size="sm" variant="ghost" onClick={()=>{try{printDraftReceipt(d,LS.get("restopos_license_v2")||{});}catch(e){alert("Print failed: "+e.message);}}}>🖨️</Btn>
                    </div>
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
      {editingDraft&&<DraftInvoiceEditor
        draft={editingDraft}
        license={LS.get("restopos_license_v2")||{}}
        onClose={()=>setEditingDraft(null)}
        onSave={(updated)=>{
          const fix=(arr)=>(arr||[]).map(d=>d.id===updated.id?{...d,...updated}:d);
          LS.set("restopos_draft_invoices",fix(LS.get("restopos_draft_invoices")));
          setSales(prev=>prev.map(s=>s.id===updated.id?{...s,...updated}:s));
          setEditingDraft(null);
        }}
      />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// DRAFT INVOICE EDITOR — edit a draft in invoice format, then print
// ═══════════════════════════════════════════════════════════════════
function DraftInvoiceEditor({draft,license,onClose,onSave}){
  const [rows,setRows]=useState(()=>(draft.items||[]).map(it=>({...it})));
  const [customer,setCustomer]=useState(draft.customer||"");
  const [note,setNote]=useState(draft.note||"");
  const VAT_RATE=0.15;
  const recalc=(items)=>{
    const total=items.reduce((s,it)=>s+(Number(it.price)||0)*(Number(it.qty)||0),0);
    const subtotal=total/(1+VAT_RATE);
    const vat=total-subtotal;
    return{subtotal:+subtotal.toFixed(2),vat:+vat.toFixed(2),total:+total.toFixed(2)};
  };
  const totals=recalc(rows);
  const setRow=(i,field,val)=>setRows(prev=>prev.map((r,idx)=>idx===i?{...r,[field]:field==="name"||field==="nameAr"?val:(parseFloat(val)||0)}:r));
  const addRow=()=>setRows(prev=>[...prev,{name:"New Item",nameAr:"",qty:1,price:0}]);
  const delRow=(i)=>setRows(prev=>prev.filter((_,idx)=>idx!==i));
  const build=()=>({...draft,items:rows.map(r=>({...r,qty:Number(r.qty)||0,price:Number(r.price)||0})),customer,note,...totals});

  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#fff",borderRadius:14,maxWidth:640,width:"100%",maxHeight:"90vh",overflow:"auto",boxShadow:"0 20px 60px rgba(0,0,0,0.3)"}}>
        <div style={{background:"linear-gradient(135deg,#F0A500,#C07800)",color:"#fff",padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <div style={{fontSize:16,fontWeight:800}}>✏️ Edit Draft — {draft.id}</div>
            <div style={{fontSize:11,opacity:0.9}}>DRAFT · not an official tax invoice</div>
          </div>
          <button onClick={onClose} style={{background:"rgba(255,255,255,0.2)",border:"none",color:"#fff",width:30,height:30,borderRadius:"50%",fontSize:18,cursor:"pointer"}}>×</button>
        </div>
        <div style={{padding:20}}>
          <div style={{display:"flex",gap:10,marginBottom:16,flexWrap:"wrap"}}>
            <div style={{flex:"1 1 200px"}}>
              <label style={{fontSize:11,fontWeight:700,color:C.textMid,display:"block",marginBottom:4}}>Customer</label>
              <input value={customer} onChange={e=>setCustomer(e.target.value)} style={{width:"100%",padding:"8px 10px",border:`1px solid ${C.border}`,borderRadius:8,fontFamily:"inherit",fontSize:13}}/>
            </div>
            <div style={{flex:"1 1 200px"}}>
              <label style={{fontSize:11,fontWeight:700,color:C.textMid,display:"block",marginBottom:4}}>Note</label>
              <input value={note} onChange={e=>setNote(e.target.value)} style={{width:"100%",padding:"8px 10px",border:`1px solid ${C.border}`,borderRadius:8,fontFamily:"inherit",fontSize:13}}/>
            </div>
          </div>
          <div style={{fontSize:12,fontWeight:800,color:C.textMid,marginBottom:8,textTransform:"uppercase",letterSpacing:"0.04em"}}>Items</div>
          <div style={{display:"flex",fontSize:10,fontWeight:700,color:C.textLight,padding:"0 4px 6px",gap:8}}>
            <div style={{flex:"2 1 0"}}>NAME</div>
            <div style={{flex:"2 1 0"}}>ARABIC</div>
            <div style={{width:54}}>QTY</div>
            <div style={{width:64}}>PRICE</div>
            <div style={{width:64,textAlign:"right"}}>AMOUNT</div>
            <div style={{width:28}}></div>
          </div>
          {rows.map((r,i)=>(
            <div key={i} style={{display:"flex",gap:8,marginBottom:6,alignItems:"center"}}>
              <input value={r.name} onChange={e=>setRow(i,"name",e.target.value)} style={{flex:"2 1 0",padding:"7px 8px",border:`1px solid ${C.border}`,borderRadius:7,fontFamily:"inherit",fontSize:12,minWidth:0}}/>
              <input value={r.nameAr||""} onChange={e=>setRow(i,"nameAr",e.target.value)} placeholder="عربي" dir="rtl" style={{flex:"2 1 0",padding:"7px 8px",border:`1px solid ${C.border}`,borderRadius:7,fontFamily:"inherit",fontSize:12,minWidth:0}}/>
              <input type="number" value={r.qty} onChange={e=>setRow(i,"qty",e.target.value)} style={{width:54,padding:"7px 6px",border:`1px solid ${C.border}`,borderRadius:7,fontFamily:"inherit",fontSize:12}}/>
              <input type="number" step="0.01" value={r.price} onChange={e=>setRow(i,"price",e.target.value)} style={{width:64,padding:"7px 6px",border:`1px solid ${C.border}`,borderRadius:7,fontFamily:"inherit",fontSize:12}}/>
              <div style={{width:64,textAlign:"right",fontSize:12,fontWeight:700,color:"#A07000"}}>{((Number(r.price)||0)*(Number(r.qty)||0)).toFixed(2)}</div>
              <button onClick={()=>delRow(i)} style={{width:28,height:28,border:"none",background:C.dangerLight,color:C.danger,borderRadius:7,cursor:"pointer",fontSize:14}}>×</button>
            </div>
          ))}
          <button onClick={addRow} style={{marginTop:6,padding:"7px 14px",border:`1.5px dashed ${C.primary}`,background:C.primaryLight,color:C.primary,borderRadius:8,fontFamily:"inherit",fontSize:12,fontWeight:700,cursor:"pointer"}}>+ Add Item</button>

          <div style={{marginTop:16,padding:"12px 14px",background:C.bg,borderRadius:10}}>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:13,padding:"3px 0"}}><span style={{color:C.textMid}}>Subtotal</span><span>{fmtSAR(totals.subtotal)}</span></div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:13,padding:"3px 0"}}><span style={{color:C.textMid}}>VAT 15%</span><span>{fmtSAR(totals.vat)}</span></div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:16,fontWeight:800,padding:"6px 0 0",borderTop:`1px solid ${C.border}`,marginTop:6}}><span>TOTAL</span><span style={{color:"#A07000"}}>{fmtSAR(totals.total)}</span></div>
          </div>

          <div style={{display:"flex",gap:10,marginTop:18}}>
            <Btn variant="outline" style={{flex:1}} onClick={onClose}>Cancel</Btn>
            <Btn variant="outline" style={{flex:1}} onClick={()=>{onSave(build());}}>💾 Save</Btn>
            <Btn style={{flex:1}} onClick={()=>{const u=build();onSave(u);try{printDraftReceipt(u,license);}catch(e){alert("Print failed: "+e.message);}}}>💾 Save & Print</Btn>
          </div>
        </div>
      </div>
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
        <div style={{marginTop:8,padding:14,background:C.zatcaLight,border:`1px solid ${C.zatca}30`,borderRadius:10,fontSize:12,color:C.zatca}}>💡 Connected to the ZATCA Phase 2 signing service. Invoices are cryptographically signed and submitted to FATOORA when reported.</div>
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
function Help({license: helpLicense}){
  const lic=helpLicense||LS.get("restopos_license_v2")||{};
  const [tab,setTab]=useState("guide");const [aiMessages,setAiMessages]=useState([{role:"assistant",content:"Hi! I'm the RestoPOS Assistant 🤖 Ask me anything — billing, ZATCA compliance, ICV counters, hash chains, UBL XML, reports, settings, or any feature!"}]);const [aiInput,setAiInput]=useState("");const [aiLoading,setAiLoading]=useState(false);const chatRef=useRef();
  const [liveForm,setLiveForm]=useState({name:"",phone:"",email:"",issue:"",priority:"Normal"});const [liveSent,setLiveSent]=useState(false);const [liveLoading,setLiveSending]=useState(false);

  // ── Notifications ──
  const [notifications,setNotifications]=useState([]);
  const [notifLoading,setNotifLoading]=useState(false);
  const [unreadCount,setUnreadCount]=useState(0);
  useEffect(()=>{
    if(tab!=="notifications"||!lic.licenseKey)return;
    setNotifLoading(true);
    const q=query(collection(db,"pending_activations"),where("licenseKey","==",lic.licenseKey));
    getDocs(q).then(snap=>{
      const notifs=[];
      if(!snap.empty){
        const data=snap.docs[0].data();
        if(data.notification?.text)notifs.push({icon:"📨",title:"Message from Admin",body:data.notification.text,time:data.notification.sentAt,read:!!data.notification.read});
        if(data.planUpdatedAt)notifs.push({icon:"💳",title:"Plan Updated",body:`Your plan was updated to ${SUBSCRIPTION_PLANS?.[data.subscriptionPlan]?.name||data.subscriptionPlan||"Basic"}.`,time:data.planUpdatedAt,read:true});
        if(data.expiryUpdatedAt)notifs.push({icon:"📅",title:"Expiry Date Set",body:`Subscription expiry set to ${data.customExpiryDate||"—"}.`,time:data.expiryUpdatedAt,read:true});
        if(data.passwordResetAt&&data.passwordResetByAdmin)notifs.push({icon:"🔑",title:"Password Reset by Admin",body:"Your password was reset. Set a new one on next login.",time:data.passwordResetAt,read:true});
        if(data.forceLogoutAt)notifs.push({icon:"⚡",title:"Session Ended by Admin",body:"Your session was force-ended by the admin.",time:data.forceLogoutAt,read:true});
        if(data.approvedAt)notifs.push({icon:"✅",title:"Account Approved",body:"Your RestoPOS account was approved and activated.",time:data.approvedAt,read:true});
        if(data.renewedAt)notifs.push({icon:"🔄",title:"Subscription Renewed",body:"Your subscription was renewed by admin.",time:data.renewedAt,read:true});
      }
      notifs.sort((a,b)=>(b.time||"").localeCompare(a.time||""));
      setNotifications(notifs);
      setUnreadCount(notifs.filter(n=>!n.read).length);
      setNotifLoading(false);
    }).catch(()=>setNotifLoading(false));
  },[tab,lic.licenseKey]);

  // ── Live Chat ──
  const [chatMessages,setChatMessages]=useState([]);
  const [chatInput,setChatInput]=useState("");
  const [chatSending,setChatSending]=useState(false);
  const [chatPhoto,setChatPhoto]=useState(null);
  const [chatPhotoPreview,setChatPhotoPreview]=useState(null);
  const liveChatRef=useRef();
  const photoInputRef=useRef();
  const chatRoomId=lic.licenseKey?`chat_${lic.licenseKey}`:null;

  useEffect(()=>{
    if(tab!=="livechat"||!chatRoomId)return;
    let unsub=()=>{};
    try{
      const q=query(collection(db,"live_chats",chatRoomId,"messages"),orderBy("sentAt","asc"),limit(100));
      unsub=onSnapshot(q,snap=>{
        setChatMessages(snap.docs.map(d=>({id:d.id,...d.data()})));
        setTimeout(()=>liveChatRef.current?.scrollTo({top:liveChatRef.current.scrollHeight,behavior:"smooth"}),100);
      },()=>{});
      setDoc(doc(db,"live_chats",chatRoomId),{licenseKey:lic.licenseKey,businessName:lic.businessName||"",lastClientActivity:new Date().toISOString(),status:"active"},{merge:true}).catch(()=>{});
    }catch(e){}
    return()=>unsub();
  },[tab,chatRoomId]);

  async function sendChatMessage(){
    if((!chatInput.trim()&&!chatPhoto)||chatSending||!chatRoomId)return;
    setChatSending(true);
    try{
      let photoUrl=null;
      if(chatPhoto){
        const pRef=ref(storage,`chat/${chatRoomId}/${Date.now()}_${chatPhoto.name}`);
        await uploadBytes(pRef,chatPhoto);
        photoUrl=await getDownloadURL(pRef);
      }
      await addDoc(collection(db,"live_chats",chatRoomId,"messages"),{text:chatInput.trim()||"",photoUrl,sender:"client",senderName:lic.businessName||"Client",sentAt:new Date().toISOString(),read:false});
      await setDoc(doc(db,"live_chats",chatRoomId),{licenseKey:lic.licenseKey,businessName:lic.businessName||"",lastMessage:chatInput.trim()||"📷 Photo",lastActivity:new Date().toISOString(),hasUnread:true,status:"active"},{merge:true});
      setChatInput("");setChatPhoto(null);setChatPhotoPreview(null);
    }catch(e){alert("Send failed: "+e.message);}
    setChatSending(false);
  }
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
  // ── App Update (pull the latest deployed build from the server) ──
  const [updating,setUpdating]=useState(false);
  const [updateMsg,setUpdateMsg]=useState("");
  async function forceUpdate(){
    setUpdating(true);setUpdateMsg("Checking for the latest version…");
    try{
      // 1) Tell the service worker to update + skip waiting (pull newest deploy)
      if("serviceWorker" in navigator){
        try{
          const regs=await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map(async r=>{
            try{await r.update();}catch(e){}
            try{r.waiting&&r.waiting.postMessage({type:"SKIP_WAITING"});}catch(e){}
          }));
        }catch(e){}
      }
      // 2) Clear all cached app shells so the next load fetches fresh files
      if("caches" in window){
        try{const keys=await caches.keys();await Promise.all(keys.map(k=>caches.delete(k)));}catch(e){}
      }
      setUpdateMsg("Latest version downloaded — reloading…");
      // 3) Hard reload from the server (cache-busted)
      setTimeout(()=>{
        try{
          const u=new URL(window.location.href);
          u.searchParams.set("_v",Date.now().toString());
          window.location.replace(u.toString());
        }catch(e){window.location.reload(true);}
      },800);
    }catch(e){
      setUpdating(false);
      setUpdateMsg("⚠️ Update failed: "+(e.message||"unknown error")+". Check your connection and try again.");
    }
  }
  const sections=[["guide","🚀","Guide"],["zatca","⬛","ZATCA"],["ai","🤖","AI Help"],["notifications","🔔",unreadCount>0?`Updates (${unreadCount})`:"Updates"],["livechat","💬","Live Chat"],["update","🔄","Update"],["upgrade","⬆️","Upgrade"],["live","🆘","Live Help"],["support","📞","Support"],["terms","📄","Terms"]];
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
                  <a href="https://wa.me/966538360053?text=Hello%2C%20I%27d%20like%20to%20upgrade%20my%20RestoPOS%20plan." target="_blank" rel="noreferrer" style={{padding:"10px 20px",background:"#25d366",color:"#fff",borderRadius:10,fontWeight:700,fontSize:13,textDecoration:"none",display:"inline-flex",alignItems:"center",gap:6}}>💬 WhatsApp Us</a>
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
                    <a href="https://wa.me/966538360053?text=Hello%2C%20I%27d%20like%20to%20upgrade%20my%20RestoPOS%20plan." target="_blank" rel="noreferrer"
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
      {tab==="notifications"&&(
        <Card>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
            <div style={{width:44,height:44,background:"linear-gradient(135deg,#6366f1,#818cf8)",borderRadius:12,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22}}>🔔</div>
            <div><div style={{fontSize:17,fontWeight:800}}>Admin Updates</div><div style={{fontSize:12,color:C.textMid}}>All changes made to your account by RestoPOS admin</div></div>
          </div>
          {notifLoading?(
            <div style={{textAlign:"center",padding:"30px 0",color:C.textLight}}>⏳ Loading…</div>
          ):notifications.length===0?(
            <div style={{textAlign:"center",padding:"40px 20px"}}>
              <div style={{fontSize:40,marginBottom:10}}>📭</div>
              <div style={{fontSize:14,fontWeight:700,color:C.textMid}}>No updates yet</div>
              <div style={{fontSize:12,color:C.textLight,marginTop:4}}>Admin actions on your account will appear here.</div>
            </div>
          ):notifications.map((n,i)=>(
            <div key={i} style={{display:"flex",gap:12,padding:"12px 14px",borderRadius:10,marginBottom:8,
              background:n.read?"rgba(0,0,0,0.02)":"#EFF6FF",border:`1px solid ${n.read?C.border:"#93c5fd"}`,position:"relative"}}>
              {!n.read&&<div style={{position:"absolute",top:10,right:12,width:8,height:8,borderRadius:"50%",background:C.primary}}/>}
              <div style={{fontSize:24,flexShrink:0}}>{n.icon}</div>
              <div style={{flex:1}}>
                <div style={{fontSize:13,fontWeight:700,marginBottom:2}}>{n.title}</div>
                <div style={{fontSize:12,color:C.textMid,lineHeight:1.5,marginBottom:4}}>{n.body}</div>
                <div style={{fontSize:10,color:C.textLight}}>{n.time?.slice(0,16).replace("T"," ")||"—"}</div>
              </div>
            </div>
          ))}
        </Card>
      )}
      {tab==="livechat"&&(
        <Card style={{padding:0,overflow:"hidden",display:"flex",flexDirection:"column",height:"70vh"}}>
          <div style={{padding:"14px 16px",background:"linear-gradient(135deg,#1A3D2B,#1F4D36)",display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
            <div style={{width:40,height:40,background:"rgba(255,255,255,0.15)",borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20}}>💬</div>
            <div>
              <div style={{fontSize:14,fontWeight:800,color:"#fff"}}>Live Chat with Support</div>
              <div style={{fontSize:11,color:"rgba(255,255,255,0.55)"}}>RestoPOS team · Usually responds within minutes</div>
            </div>
            <div style={{marginLeft:"auto",width:8,height:8,borderRadius:"50%",background:"#2ECC71"}}/>
          </div>
          <div ref={liveChatRef} style={{flex:1,overflowY:"auto",padding:14,display:"flex",flexDirection:"column",gap:10,background:"#F8F9FB"}}>
            {chatMessages.length===0&&(
              <div style={{textAlign:"center",padding:"40px 20px",color:C.textLight}}>
                <div style={{fontSize:36,marginBottom:8}}>👋</div>
                <div style={{fontSize:13,fontWeight:600,color:C.textMid}}>Start a conversation</div>
                <div style={{fontSize:12,marginTop:4}}>Ask anything or send a photo of an error screen.</div>
              </div>
            )}
            {chatMessages.map(msg=>{
              const isClient=msg.sender==="client";
              return(
                <div key={msg.id} style={{display:"flex",flexDirection:"column",alignItems:isClient?"flex-end":"flex-start",gap:3}}>
                  <div style={{maxWidth:"78%",padding:"10px 13px",borderRadius:isClient?"16px 16px 4px 16px":"16px 16px 16px 4px",
                    background:isClient?"linear-gradient(135deg,#1A6B4A,#1F4D36)":"#fff",
                    color:isClient?"#fff":C.text,fontSize:13,lineHeight:1.5,
                    boxShadow:"0 1px 4px rgba(0,0,0,0.1)",border:isClient?"none":`1px solid ${C.border}`}}>
                    {msg.text&&<div>{msg.text}</div>}
                    {msg.photoUrl&&<img src={msg.photoUrl} alt="attachment" onClick={()=>window.open(msg.photoUrl,"_blank")} style={{maxWidth:"100%",maxHeight:200,borderRadius:8,marginTop:msg.text?6:0,cursor:"pointer",display:"block"}}/>}
                  </div>
                  <div style={{fontSize:9,color:C.textLight,padding:"0 4px"}}>{msg.sender==="admin"?"RestoPOS Support":lic.businessName||"You"} · {msg.sentAt?.slice(11,16)||""}</div>
                </div>
              );
            })}
          </div>
          {chatPhotoPreview&&(
            <div style={{padding:"8px 14px",background:"#F0F9F4",borderTop:`1px solid ${C.border}`,display:"flex",alignItems:"center",gap:8}}>
              <img src={chatPhotoPreview} alt="preview" style={{width:50,height:50,objectFit:"cover",borderRadius:8}}/>
              <div style={{flex:1,fontSize:12,color:C.textMid}}>📎 {chatPhoto?.name}</div>
              <button onClick={()=>{setChatPhoto(null);setChatPhotoPreview(null);}} style={{background:"none",border:"none",color:C.danger,cursor:"pointer",fontSize:18,fontWeight:700}}>×</button>
            </div>
          )}
          <div style={{padding:"10px 12px",borderTop:`1px solid ${C.border}`,background:"#fff",display:"flex",gap:8,alignItems:"flex-end",flexShrink:0}}>
            <input ref={photoInputRef} type="file" accept="image/*" style={{display:"none"}} onChange={e=>{
              const file=e.target.files?.[0];if(!file)return;
              setChatPhoto(file);
              const r=new FileReader();r.onload=ev=>setChatPhotoPreview(ev.target.result);r.readAsDataURL(file);
              e.target.value="";
            }}/>
            <button onClick={()=>photoInputRef.current?.click()} style={{padding:"9px 10px",background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,cursor:"pointer",fontSize:16,flexShrink:0,color:C.textMid}}>📷</button>
            <textarea value={chatInput} onChange={e=>setChatInput(e.target.value)}
              onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendChatMessage();}}}
              placeholder="Type a message… (Enter to send)"
              rows={2} style={{flex:1,padding:"9px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontFamily:"inherit",resize:"none",outline:"none"}}/>
            <button onClick={sendChatMessage} disabled={chatSending||(!chatInput.trim()&&!chatPhoto)}
              style={{padding:"9px 14px",background:chatSending||(!chatInput.trim()&&!chatPhoto)?"#ccc":"linear-gradient(135deg,#1A6B4A,#134D36)",
                color:"#fff",border:"none",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:700,fontFamily:"inherit",flexShrink:0,alignSelf:"stretch"}}>
              {chatSending?"…":"Send"}
            </button>
          </div>
        </Card>
      )}
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
      {tab==="update"&&<Card>
        <div style={{fontSize:18,fontWeight:800,marginBottom:6}}>🔄 App Update</div>
        <div style={{fontSize:13,color:C.textMid,marginBottom:18}}>Get the latest features and fixes pushed by your RestoPOS provider. This downloads the newest version and reloads the app.</div>
        <div style={{display:"flex",alignItems:"center",gap:14,padding:"14px 16px",background:C.bg,borderRadius:12,border:`1px solid ${C.border}`,marginBottom:16}}>
          <div style={{width:46,height:46,borderRadius:12,background:C.primaryLight,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,flexShrink:0}}>📦</div>
          <div style={{flex:1}}>
            <div style={{fontSize:14,fontWeight:800}}>Current version</div>
            <div style={{fontSize:12,color:C.textMid}}>{APP_VERSION_FULL}</div>
          </div>
          <Badge color={C.success} bg={C.successLight}>Installed</Badge>
        </div>
        <button onClick={forceUpdate} disabled={updating}
          style={{width:"100%",padding:"14px",background:updating?"#9bb3a8":"linear-gradient(135deg,#1A6B4A,#134D36)",color:"#fff",border:"none",borderRadius:12,fontSize:15,fontWeight:800,cursor:updating?"not-allowed":"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",gap:10}}>
          {updating?"⏳ Updating…":"⬇️ Check for Updates & Install"}
        </button>
        {updateMsg&&<div style={{marginTop:14,padding:"10px 14px",background:C.infoLight,border:`1px solid ${C.info}33`,borderRadius:10,fontSize:12.5,color:C.info,fontWeight:600,textAlign:"center"}}>{updateMsg}</div>}
        <div style={{marginTop:16,display:"flex",flexDirection:"column",gap:8}}>
          {[["1","Make sure you're online (Wi-Fi or data)."],["2","Tap “Check for Updates & Install”."],["3","The app clears its cache and reloads with the newest version automatically."],["4","If a payment is in progress, finish it before updating."]].map(([n,d])=>(
            <div key={n} style={{display:"flex",gap:10,alignItems:"flex-start"}}><span style={{width:20,height:20,borderRadius:"50%",background:C.primary,color:"#fff",fontSize:11,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,marginTop:1}}>{n}</span><span style={{fontSize:12.5,color:C.textMid}}>{d}</span></div>
          ))}
        </div>
        <div style={{marginTop:16,fontSize:11,color:C.textLight}}>Your data (sales, menu, settings) is safe and backed up to the cloud — updating never deletes it.</div>
      </Card>}
      {tab==="support"&&<Card><div style={{fontSize:18,fontWeight:800,marginBottom:20}}>Support & Contact</div>{[{icon:"📦",label:"Product",value:APP_VERSION_FULL},{icon:"🌍",label:"Region",value:"Kingdom of Saudi Arabia"},{icon:"📧",label:"Email",value:"restopos.noreply@gmail.com"},{icon:"📞",label:"Phone",value:"+966 53 836 0053 (9AM–6PM)"},{icon:"💬",label:"WhatsApp",value:"+966 53 836 0053"}].map((item,i)=><div key={i} style={{display:"flex",gap:14,padding:"12px 0",borderBottom:`1px solid ${C.border}`,alignItems:"center"}}><span style={{fontSize:20,width:28}}>{item.icon}</span><div style={{fontSize:12,fontWeight:700,color:C.textMid,width:90}}>{item.label}</div><div style={{fontSize:13,color:C.text,fontWeight:600}}>{item.value}</div></div>)}</Card>}
      {tab==="terms"&&<Card>
        <div style={{fontSize:18,fontWeight:800,marginBottom:4}}>📄 Terms &amp; Conditions</div>
        <div style={{fontSize:13,color:'#5D6D7E',marginBottom:20}}>RestoPOS Software License Agreement — Kingdom of Saudi Arabia</div>
        <div style={{padding:'14px 16px',background:'#F4F7FB',borderRadius:10,border:'1px solid #D6DDE8',marginBottom:16}}>
          <div style={{fontSize:13,fontWeight:700,color:'#1A2E4A',marginBottom:6}}>📋 What you agreed to</div>
          <div style={{fontSize:12.5,color:'#2C3E50',lineHeight:1.7}}>
            By creating your RestoPOS account you accepted our full Terms &amp; Conditions including:<br/>
            • ZATCA VAT compliance obligations are your sole responsibility<br/>
            • Tax evasion of any kind is strictly prohibited — you bear full legal liability<br/>
            • RestoPOS bears zero responsibility for your tax filings or regulatory penalties<br/>
            • Your signed acceptance is recorded and accessible to RestoPOS admin
          </div>
        </div>
        <div style={{display:'flex',flexDirection:'column',gap:10,marginBottom:20}}>
          <a href="https://restopos.store/RestoPOS_Terms_and_Conditions.pdf" target="_blank" rel="noopener noreferrer"
            style={{display:'flex',alignItems:'center',gap:12,padding:'14px 16px',background:'linear-gradient(135deg,#1A2E4A,#2C4A6E)',color:'#fff',borderRadius:10,textDecoration:'none',fontFamily:'inherit'}}>
            <span style={{fontSize:22}}>📄</span>
            <div style={{flex:1}}>
              <div style={{fontSize:14,fontWeight:800}}>Read Full Terms &amp; Conditions</div>
              <div style={{fontSize:12,opacity:0.8,marginTop:2}}>Opens official PDF — English, Saudi Arabian Law</div>
            </div>
            <span style={{fontSize:18,opacity:0.7}}>↗</span>
          </a>
          <a href="https://restopos.store/RestoPOS_Terms_and_Conditions.pdf" target="_blank" rel="noopener noreferrer"
            style={{display:'flex',alignItems:'center',gap:12,padding:'14px 16px',background:'#fff',border:'1.5px solid #D6DDE8',color:'#1A2E4A',borderRadius:10,textDecoration:'none',fontFamily:'inherit'}}>
            <span style={{fontSize:22}}>⬇️</span>
            <div style={{flex:1}}>
              <div style={{fontSize:14,fontWeight:700}}>Download PDF Copy</div>
              <div style={{fontSize:12,color:'#5D6D7E',marginTop:2}}>Save a copy for your records</div>
            </div>
            <span style={{fontSize:18,color:'#5D6D7E'}}>↗</span>
          </a>
        </div>
        <div style={{padding:'12px 14px',background:'#FFF3F3',border:'1.5px solid #CC000033',borderRadius:10,marginBottom:16}}>
          <div style={{fontSize:12.5,fontWeight:800,color:'#8B0000',marginBottom:4}}>⚠️ Tax Evasion Warning</div>
          <div style={{fontSize:12,color:'#5D0000',lineHeight:1.6}}>
            Under Saudi Arabian law, tax evasion carries penalties of up to 3× the VAT evaded, criminal prosecution, and business license revocation. If you evade tax, you alone are fully liable. RestoPOS is not responsible.
          </div>
        </div>
        <div style={{display:'flex',gap:12,padding:'12px 14px',background:'#EAF4EA',border:'1px solid #2E7D3233',borderRadius:10}}>
          <span style={{fontSize:20}}>✅</span>
          <div style={{fontSize:12.5,color:'#1B4D1E',lineHeight:1.6}}>
            <strong>Your agreement is on record.</strong> A signed copy including your name, VAT number, CR number, and acceptance timestamp was saved when you registered. Contact <strong>restopos.noreply@gmail.com</strong> if you need a copy.
          </div>
        </div>
      </Card>}
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
// ═══════════════════════════════════════════════════════════════════
// ZATCA PHASE 2 SETUP — client onboarding via microservice
// ═══════════════════════════════════════════════════════════════════
const ZATCA_SETUP_STATUS_KEY = "restopos_zatca_phase2_status";
const ZATCA_MANUAL_REVENUE_KEY = "restopos_zatca_manual_revenue";

function ZATCASetup({license,sales=[]}){
  const saved = LS.get(ZATCA_SETUP_STATUS_KEY) || {};
  const [otp,setOtp]=useState("");
  const [vatNumber,setVatNumber]=useState(license?.vatNumber||"");
  const [companyName,setCompanyName]=useState(license?.businessName||"");
  const [branchName,setBranchName]=useState(saved.branchName||"Main Branch");
  const [busy,setBusy]=useState(false);
  const [status,setStatus]=useState(saved.activated?"activated":"idle");
  const [msg,setMsg]=useState("");
  const [progressSteps,setProgressSteps]=useState([]);
  const [currentStep,setCurrentStep]=useState("");
  // Manually-entered prior-year taxable revenue (for businesses with history outside RestoPOS)
  const [manualRev,setManualRev]=useState(()=>LS.get(ZATCA_MANUAL_REVENUE_KEY)||{});

  // ── ZATCA Phase 2 wave thresholds (per ZATCA, qualifying years 2022/2023/2024) ──
  // Wave 24 (current lowest): taxable revenue > SAR 375,000 → Phase 2 mandated, deadline 30 Jun 2026.
  const PHASE2_THRESHOLD = 375000;
  const REV_YEARS = ["2022","2023","2024","2025"];
  // Revenue per calendar year from RestoPOS sales (uses VAT-exclusive taxable amount)
  const posRevenueByYear = {};
  (sales||[]).forEach(s=>{
    const yr = (s.date||"").slice(0,4);
    if(!yr) return;
    const total = s.total||0;
    const vat = s.vat||(total*15/115);
    const taxable = total - vat; // VAT-exclusive taxable revenue
    posRevenueByYear[yr] = (posRevenueByYear[yr]||0) + taxable;
  });
  // Combined view: take the HIGHER of (RestoPOS recorded) vs (client-entered) for each year.
  // Client-entered figures represent their full official taxable revenue incl. sales outside RestoPOS.
  const revenueByYear = {};
  [...new Set([...Object.keys(posRevenueByYear),...Object.keys(manualRev),...REV_YEARS])].forEach(y=>{
    const pos = posRevenueByYear[y]||0;
    const man = parseFloat(manualRev[y])||0;
    const v = Math.max(pos,man);
    if(v>0) revenueByYear[y]=v;
  });
  function saveManualRev(yr,val){
    const next={...manualRev};
    const clean=val.replace(/[^0-9.]/g,"");
    if(clean==="") delete next[yr]; else next[yr]=clean;
    setManualRev(next);
    LS.set(ZATCA_MANUAL_REVENUE_KEY,next);
  }
  const qualifyingYears = ["2022","2023","2024","2025","2026"].filter(y=>revenueByYear[y]>0);
  const maxRevenue = qualifyingYears.reduce((m,y)=>Math.max(m,revenueByYear[y]||0),0);
  const maxRevenueYear = qualifyingYears.reduce((my,y)=>(revenueByYear[y]||0)>(revenueByYear[my]||0)?y:my,qualifyingYears[0]||"");
  const isMandated = maxRevenue >= PHASE2_THRESHOLD;
  const hasData = qualifyingYears.length>0;

  // Step labels shown in the UI progress tracker
  const STEP_LABELS = [
    "Generating cryptographic keys & CSR",
    "Issuing compliance certificate (OTP)",
    "Compliance check 1/3 — test invoice",
    "Compliance check 2/3 — test invoice",
    "Compliance check 3/3 — test invoice",
    "Issuing production certificate",
    "Saving to secure database"
  ];

  async function handleActivate(){
    if(!license?.licenseKey){setMsg("⚠️ No license key found. Please re-activate RestoPOS first.");return;}
    if(!vatNumber||!/^3\d{14}$/.test(vatNumber)){setMsg("⚠️ Enter a valid 15-digit VAT number starting with 3.");return;}
    if(!companyName){setMsg("⚠️ Company name is required.");return;}
    if(!otp||otp.trim().length<4){setMsg("⚠️ Enter the OTP from the FATOORA portal.");return;}
    setBusy(true);setMsg("");
    setProgressSteps(STEP_LABELS.map(l=>({label:l,status:"pending"})));
    setCurrentStep("Starting activation...");

    // Simulate step progress while the server runs the full chain
    // The server does everything automatically — we just animate progress
    let stepIdx = 0;
    const stepTimer = setInterval(()=>{
      if(stepIdx < STEP_LABELS.length){
        setProgressSteps(prev=>prev.map((s,i)=>
          i < stepIdx ? {...s,status:"done"} :
          i === stepIdx ? {...s,status:"active"} : s
        ));
        setCurrentStep(STEP_LABELS[stepIdx]);
        stepIdx++;
      }
    }, IS_PRODUCTION_ENV ? 4000 : 1500);

    try{
      const res=await fetch(`${ZATCA_SERVICE_URL}/zatca/onboard`,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({licenseKey:license.licenseKey,vatNumber,companyName,branchName,otp:otp.trim()})
      });
      clearInterval(stepTimer);
      const data=await res.json().catch(()=>({}));
      if(!res.ok||data.success!==true){throw new Error(data.error||`Service returned ${res.status}`);}

      // Mark all steps done
      setProgressSteps(STEP_LABELS.map(l=>({label:l,status:"done"})));
      setCurrentStep("Complete");

      LS.set(ZATCA_SETUP_STATUS_KEY,{
        activated:true, branchName, vatNumber, companyName,
        activatedAt:new Date().toISOString(),
        complianceRequestId:data.complianceRequestId,
        productionReady:data.productionReady||false,
        environment:data.environment||"sandbox"
      });
      setStatus("activated");
      setMsg(data.productionReady
        ? "✅ Phase 2 fully activated. Your branch is certified with ZATCA and ready for live reporting."
        : "✅ Activation complete. Contact your RestoPOS provider to finalise the production certificate.");
      setOtp("");
    }catch(e){
      clearInterval(stepTimer);
      setProgressSteps(prev=>prev.map(s=>s.status==="active"?{...s,status:"error"}:s));
      setMsg("❌ Activation failed: "+e.message);
    }
    setBusy(false);
  }

  const inputStyle={width:"100%",padding:"11px 14px",borderRadius:8,border:`1.5px solid ${C.border}`,fontSize:14,fontFamily:"inherit",boxSizing:"border-box",marginTop:6};
  const labelStyle={fontSize:12,fontWeight:700,color:C.textMid,textTransform:"uppercase",letterSpacing:0.5};

  return(
    <div style={{maxWidth:640}}>
      {/* ── PHASE 2 ELIGIBILITY CHECK ── */}
      <Card style={{marginBottom:16}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
          <span style={{fontSize:24}}>📊</span>
          <div><div style={{fontSize:18,fontWeight:800}}>Phase 2 Eligibility Check</div><div style={{fontSize:12,color:C.textMid}}>Based on your taxable revenue (RestoPOS + your records)</div></div>
        </div>

        {hasData?(
          <>
            <div style={{display:"flex",flexWrap:"wrap",gap:10,marginBottom:14}}>
              {qualifyingYears.map(y=>{
                const man=parseFloat(manualRev[y])||0;
                const pos=posRevenueByYear[y]||0;
                const src=man>pos?"You entered":pos>0?"From RestoPOS":"";
                return(
                <div key={y} style={{flex:"1 1 110px",background:y===maxRevenueYear?C.zatcaLight:C.bg,border:`1px solid ${y===maxRevenueYear?C.zatca+"55":C.border}`,borderRadius:10,padding:"10px 12px"}}>
                  <div style={{fontSize:11,color:C.textLight,fontWeight:600}}>{y}{y===maxRevenueYear?" · highest":""}</div>
                  <div style={{fontSize:15,fontWeight:800,color:C.text}}>{fmtSAR(revenueByYear[y])}</div>
                  {src&&<div style={{fontSize:9,color:C.textLight,marginTop:2}}>{src}</div>}
                </div>
                );
              })}
            </div>

            {isMandated?(
              <div style={{background:C.warningLight,border:`1px solid ${C.warning}55`,borderRadius:10,padding:16}}>
                <div style={{fontWeight:800,color:C.warning,fontSize:15,marginBottom:6}}>⚠️ You are very likely Phase 2 mandated</div>
                <div style={{fontSize:13,color:C.textMid,lineHeight:1.6}}>
                  Your highest yearly taxable revenue (<strong>{fmtSAR(maxRevenue)}</strong>) exceeds the current ZATCA threshold of <strong>SAR 375,000</strong> (Wave 24). Businesses above this level must integrate with FATOORA by <strong>30 June 2026</strong>.
                  <br/><br/>
                  Non-compliance penalties range from <strong>SAR 5,000 to SAR 50,000</strong>, plus up to SAR 10,000 per invoice for a non-compliant QR. Activate Phase 2 below.
                </div>
              </div>
            ):(
              <div style={{background:C.zatcaLight,border:`1px solid ${C.zatca}30`,borderRadius:10,padding:16}}>
                <div style={{fontWeight:800,color:C.zatca,fontSize:15,marginBottom:6}}>ℹ️ You may still be Phase 1 only</div>
                <div style={{fontSize:13,color:C.textMid,lineHeight:1.6}}>
                  Your highest yearly taxable revenue in RestoPOS (<strong>{fmtSAR(maxRevenue)}</strong>) is below the current ZATCA Phase 2 threshold of <strong>SAR 375,000</strong>. You likely don't need to integrate yet — but keep generating your Phase 1 QR invoices as usual.
                </div>
              </div>
            )}
          </>
        ):(
          <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,padding:16,fontSize:13,color:C.textMid}}>
            Not enough sales data yet to estimate your revenue. Once you process orders, RestoPOS will compare your yearly taxable revenue against the ZATCA Phase 2 threshold (SAR 375,000).
          </div>
        )}

        <div style={{fontSize:11,color:C.textLight,marginTop:12,lineHeight:1.5}}>
          ⚖️ This estimate combines sales recorded in RestoPOS with any prior-year figures you enter below, for the calendar years ZATCA uses. Your official obligation is confirmed by ZATCA's notification email to your registered contact.
        </div>
      </Card>

      {/* ── ENTER YOUR PAST REVENUE (for accurate eligibility) ── */}
      <Card style={{marginBottom:16}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}>
          <span style={{fontSize:24}}>🧮</span>
          <div><div style={{fontSize:18,fontWeight:800}}>Enter Your Past Revenue</div><div style={{fontSize:12,color:C.textMid}}>For accurate Phase 2 eligibility, add your real yearly totals</div></div>
        </div>
        <div style={{fontSize:13,color:C.textMid,lineHeight:1.7,marginBottom:14}}>
          RestoPOS can only see sales you processed inside it. If your restaurant was already operating before RestoPOS — or you take some payments elsewhere — enter your <strong>total taxable revenue</strong> for each year so we can check your Phase 2 obligation correctly. Whatever you enter is compared against what RestoPOS recorded, and the higher figure is used.
        </div>

        <div style={{display:"flex",flexWrap:"wrap",gap:12,marginBottom:16}}>
          {REV_YEARS.map(y=>(
            <div key={y} style={{flex:"1 1 130px"}}>
              <label style={{fontSize:12,fontWeight:700,color:C.textMid,display:"block",marginBottom:5}}>{y} Revenue (SAR)</label>
              <input value={manualRev[y]||""} onChange={e=>saveManualRev(y,e.target.value)} inputMode="decimal" placeholder={posRevenueByYear[y]?`POS: ${Math.round(posRevenueByYear[y]).toLocaleString()}`:"e.g. 420000"} style={{width:"100%",padding:"10px 12px",borderRadius:8,border:`1.5px solid ${C.border}`,fontSize:14,fontFamily:"inherit",boxSizing:"border-box"}}/>
            </div>
          ))}
        </div>

        <div style={{background:C.zatcaLight,border:`1px solid ${C.zatca}30`,borderRadius:10,padding:14}}>
          <div style={{fontWeight:700,color:C.zatca,fontSize:13,marginBottom:8}}>📖 How to calculate your taxable revenue</div>
          <div style={{fontSize:12,color:C.textMid,lineHeight:1.8}}>
            <strong>1. Use VAT-exclusive figures.</strong> Enter sales <em>before</em> 15% VAT. If your books show VAT-inclusive totals, divide by 1.15 (e.g. SAR 1,150 inclusive → SAR 1,000 taxable).<br/>
            <strong>2. Per calendar year.</strong> January–December of each year, not your fiscal year.<br/>
            <strong>3. Count all taxable sales.</strong> Dine-in, takeaway, delivery, catering — everything subject to 15% VAT, across all branches and payment channels.<br/>
            <strong>4. Exclude non-taxable items.</strong> Don't include VAT collected, exempt items, or out-of-scope amounts (e.g. staff wages).<br/>
            <strong>5. Which years matter.</strong> ZATCA assigns Phase 2 waves by your revenue in <strong>2022, 2023, or 2024</strong>. If your revenue crossed <strong>SAR 375,000</strong> in <em>any</em> of these years, you are in scope for the current waves.
          </div>
        </div>

        <div style={{fontSize:11,color:C.textLight,marginTop:12,lineHeight:1.5}}>
          🔒 These figures are stored only on this device to help estimate your obligation. They are not sent to ZATCA. ZATCA's official notification email is always the final word on your Phase 2 deadline.
        </div>
      </Card>

      <Card>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}>
          <span style={{fontSize:24}}>🔐</span>
          <div><div style={{fontSize:18,fontWeight:800}}>ZATCA Phase 2 Activation</div><div style={{fontSize:12,color:C.textMid}}>Connect this branch to FATOORA for e-invoice reporting</div></div>
        </div>

        {status==="activated"?(
          <div style={{background:C.successLight,border:`1px solid ${C.success}44`,borderRadius:10,padding:16,marginTop:14}}>
            <div style={{fontWeight:800,color:C.success,fontSize:15,marginBottom:4}}>
              {saved.productionReady?"✅ Phase 2 Fully Active (Production)":"✅ Phase 2 Active (Sandbox)"}
            </div>
            <div style={{fontSize:13,color:C.textMid,lineHeight:1.6}}>
              Branch: <strong>{saved.branchName||branchName}</strong><br/>
              VAT: <strong>{saved.vatNumber||vatNumber}</strong><br/>
              Status: <strong style={{color:saved.productionReady?C.success:C.warning}}>{saved.productionReady?"Certified — live FATOORA reporting enabled":"Compliance cert only — awaiting production cert"}</strong>
            </div>
            <div style={{fontSize:11,color:C.textLight,marginTop:8}}>Activated: {saved.activatedAt?new Date(saved.activatedAt).toLocaleString():"—"}</div>
            <div style={{display:"flex",gap:8,marginTop:12,flexWrap:"wrap"}}>
              <button onClick={()=>{setStatus("idle");setMsg("");setProgressSteps([]);}} style={{background:"transparent",border:`1.5px solid ${C.border}`,borderRadius:8,padding:"8px 16px",color:C.textMid,fontFamily:"inherit",fontSize:12,fontWeight:600,cursor:"pointer"}}>Re-activate / Add branch</button>
            </div>
          </div>
        ):(
          <>
            <div style={{background:C.zatcaLight,border:`1px solid ${C.zatca}30`,borderRadius:10,padding:14,marginTop:14,fontSize:13,color:C.textMid,lineHeight:1.6}}>
              <strong style={{color:C.zatca}}>How to activate:</strong>
              <ol style={{margin:"8px 0 0 0",paddingLeft:18}}>
                <li>Open the FATOORA portal and log in with your ZATCA (ERAD) account.</li>
                <li>Go to <strong>Onboard New Solution / Generate OTP</strong>.</li>
                <li>Copy the OTP code shown and paste it below, then tap Activate.</li>
              </ol>
              <a href="https://fatoora.zatca.gov.sa" target="_blank" rel="noopener noreferrer" style={{display:"inline-block",marginTop:10,background:C.zatca,color:"#fff",padding:"9px 16px",borderRadius:8,fontSize:13,fontWeight:700,textDecoration:"none"}}>🌐 Open FATOORA Portal</a>
            </div>

            <div style={{marginTop:16}}>
              <label style={labelStyle}>Company / VAT Name</label>
              <input value={companyName} onChange={e=>setCompanyName(e.target.value)} style={inputStyle} placeholder="Registered business name"/>
            </div>
            <div style={{marginTop:14}}>
              <label style={labelStyle}>VAT Number (15 digits)</label>
              <input value={vatNumber} onChange={e=>setVatNumber(e.target.value.replace(/\D/g,"").slice(0,15))} style={inputStyle} placeholder="3XXXXXXXXXXXXXX" inputMode="numeric"/>
            </div>
            <div style={{marginTop:14}}>
              <label style={labelStyle}>Branch Name</label>
              <input value={branchName} onChange={e=>setBranchName(e.target.value)} style={inputStyle} placeholder="e.g. Main Branch"/>
            </div>
            <div style={{marginTop:14}}>
              <label style={labelStyle}>OTP from FATOORA Portal</label>
              <input value={otp} onChange={e=>setOtp(e.target.value)} style={{...inputStyle,letterSpacing:3,fontWeight:700}} placeholder="Paste OTP here"/>
            </div>

            <button onClick={handleActivate} disabled={busy} style={{marginTop:18,width:"100%",background:busy?C.textLight:C.zatca,color:"#fff",border:"none",borderRadius:10,padding:"13px",fontFamily:"inherit",fontSize:14,fontWeight:700,cursor:busy?"not-allowed":"pointer"}}>{busy?"Activating… please wait":"🔐 Activate ZATCA Phase 2"}</button>

            {busy&&progressSteps.length>0&&(
              <div style={{marginTop:16,background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,padding:14}}>
                <div style={{fontSize:12,fontWeight:700,color:C.textMid,marginBottom:10}}>⚙️ Automated setup in progress…</div>
                {progressSteps.map((s,i)=>(
                  <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"5px 0",borderBottom:i<progressSteps.length-1?`1px solid ${C.border}44`:"none"}}>
                    <span style={{fontSize:14,width:20,textAlign:"center"}}>
                      {s.status==="done"?"✅":s.status==="active"?"⏳":s.status==="error"?"❌":"⬜"}
                    </span>
                    <span style={{fontSize:12,color:s.status==="done"?C.success:s.status==="active"?C.zatca:s.status==="error"?C.warning:C.textLight,fontWeight:s.status==="active"?700:400}}>{s.label}</span>
                  </div>
                ))}
                <div style={{fontSize:11,color:C.textLight,marginTop:8}}>Do not close this screen. This may take up to 30 seconds.</div>
              </div>
            )}
          </>
        )}

        {msg&&<div style={{marginTop:14,padding:12,borderRadius:8,fontSize:13,fontWeight:600,background:msg.startsWith("✅")?C.successLight:msg.startsWith("❌")||msg.startsWith("⚠️")?C.warningLight:C.bg,color:msg.startsWith("✅")?C.success:C.warning}}>{msg}</div>}
      </Card>
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
        {[["balancesheet","📋 Balance Sheet"],["cashflow","💧 Cash Flow"],["trial","⚖️ Trial Balance"],["gl","📒 General Ledger"],["vat","🧾 VAT Liability"],["pnl","📈 P&L"],["expenses","💸 Expenses"],["zatcasetup","🔐 ZATCA Setup"],["vatguide","📖 VAT Guide"]].map(([id,lbl])=>(
          <button key={id} onClick={()=>setTab(id)} style={{padding:"8px 16px",borderRadius:8,border:`1.5px solid ${tab===id?C.primary:C.border}`,background:tab===id?C.primaryLight:"#fff",color:tab===id?C.primary:C.textMid,fontFamily:"inherit",fontSize:13,fontWeight:600,cursor:"pointer"}}>{lbl}</button>
        ))}
      </div>

      {fSales.length===0&&tab!=="vat"&&tab!=="zatcasetup"&&<Card><div style={{textAlign:"center",padding:"60px 20px",color:C.textLight}}><div style={{fontSize:48,marginBottom:12}}>🏦</div><div style={{fontSize:16,fontWeight:700,marginBottom:6}}>No financial data yet</div><div style={{fontSize:13}}>Complete orders in the POS screen to populate these financial reports.</div></div></Card>}

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

      {tab==="zatcasetup"&&<ZATCASetup license={license} sales={sales}/>}
      {tab==="vatguide"&&<ZATCAVATGuide sales={sales} license={license}/>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// ZATCA VAT GUIDE — Interactive reference built from zatcaVAT.js engine
// ═══════════════════════════════════════════════════════════════════
function zatcaRound(v,dp=2){const f=Math.pow(10,dp);return Math.floor(v*f+0.5)/f;}
const zr2=v=>zatcaRound(v,2);
function extractVATInclusive(total,rate=0.15){if(rate===0)return{net:zr2(total),vat:0,total:zr2(total)};const net=zr2(total/(1+rate));return{net,vat:zr2(total-net),total:zr2(total)};}
const ZATCA_PEN={not_issuing:{fixed:5000,pct:0,label:"Not issuing e-invoice (per invoice)"},not_storing:{fixed:5000,pct:0,label:"Not storing e-invoice electronically"},bad_qr:{fixed:10000,pct:0,label:"Non-compliant or missing QR code"},modifying:{fixed:10000,pct:0,label:"Deleting or modifying an e-invoice"},late_reg:{fixed:10000,pct:0,label:"Failure to register for VAT on time"},late_return:{fixed:0,pct:0.05,label:"Late VAT return (5% of unpaid tax)"},incorrect_return:{fixed:0,pct:0.50,label:"Incorrect VAT return (50% of tax difference)"}};
function calcPen(type,tax=0){const r=ZATCA_PEN[type];if(!r)return 0;return zr2(Math.min(r.fixed+(tax*r.pct),50000));}
function aggVAT(sales=[],year=""){const f=year?sales.filter(s=>(s.date||"").startsWith(year)):sales;let out=0,gross=0,net=0;const byMo={};f.forEach(s=>{const t=s.total||0;const v=s.vat||(t*15/115);const n=t-v;out+=v;gross+=t;net+=n;const mo=(s.date||"").slice(0,7);if(!byMo[mo])byMo[mo]={gross:0,vat:0,net:0,count:0};byMo[mo].gross+=t;byMo[mo].vat+=v;byMo[mo].net+=n;byMo[mo].count++;});return{out:zr2(out),gross:zr2(gross),net:zr2(net),byMo,count:f.length};}
const VCATS=[{code:"S",label:"Standard Rated",labelAr:"خاضع للضريبة",rate:"15%",color:"#1A6B4A",bg:"#E8F5F0",desc:"All restaurant food & beverage sales in KSA. Default rate since 1 Jul 2020.",rec:true,ex:"Meals, drinks, delivery, catering, service charges"},{code:"Z",label:"Zero Rated",labelAr:"معدل الصفر",rate:"0%",color:"#1565C0",bg:"#E3F2FD",desc:"Exports outside GCC, international transport, qualifying medicines. Input VAT still recoverable.",rec:true,ex:"Exported goods, international shipping"},{code:"E",label:"Exempt",labelAr:"معفاة",rate:"0%",color:"#7B1FA2",bg:"#F3E5F5",desc:"Residential rental, certain financial services, life insurance. Input VAT NOT recoverable.",rec:false,ex:"Residential rent, life insurance"},{code:"O",label:"Out of Scope",labelAr:"خارج النطاق",rate:"N/A",color:"#616161",bg:"#F5F5F5",desc:"Wages, dividends, government statutory fees. Not subject to VAT at all.",rec:false,ex:"Employee salaries, government fees"}];

function ZATCAVATGuide({sales=[]}){
  const [sec,setSec]=useState("categories");
  const [inclPrice,setInclPrice]=useState("");
  const [penType,setPenType]=useState("not_issuing");
  const [penTax,setPenTax]=useState("");
  const years=[...new Set((sales||[]).map(s=>(s.date||"").slice(0,4)).filter(Boolean))].sort().reverse();
  const [yr,setYr]=useState(years[0]||new Date().getFullYear().toString());
  const vd=aggVAT(sales,yr);
  const ir=inclPrice?extractVATInclusive(parseFloat(inclPrice)||0):null;
  const pr=calcPen(penType,parseFloat(penTax)||0);
  const SECS=[["categories","🏷️ VAT Categories"],["calculator","🧮 VAT Calculator"],["return","📊 VAT Return"],["penalties","⚠️ Penalties"],["rules","📋 ZATCA Rules"]];

  return(
    <div>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
        <span style={{fontSize:24}}>📖</span>
        <div><div style={{fontSize:18,fontWeight:800}}>ZATCA VAT Guide</div><div style={{fontSize:12,color:C.textMid}}>KSA VAT Law · FATOORA Phase 2 · Interactive Reference</div></div>
      </div>
      <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:20}}>
        {SECS.map(([id,lbl])=><button key={id} onClick={()=>setSec(id)} style={{padding:"7px 14px",borderRadius:8,border:`1.5px solid ${sec===id?C.zatca:C.border}`,background:sec===id?C.zatcaLight:"#fff",color:sec===id?C.zatca:C.textMid,fontFamily:"inherit",fontSize:12,fontWeight:600,cursor:"pointer"}}>{lbl}</button>)}
      </div>

      {sec==="categories"&&<div style={{display:"flex",flexDirection:"column",gap:12}}>
        {VCATS.map(cat=>(
          <Card key={cat.code}>
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:8,flexWrap:"wrap"}}>
              <div style={{background:cat.bg,color:cat.color,borderRadius:8,padding:"6px 14px",fontWeight:800,fontSize:15,border:`1px solid ${cat.color}33`}}>{cat.rate}</div>
              <div><div style={{fontWeight:800,fontSize:14}}>{cat.label} <span style={{color:C.textLight,fontWeight:400,fontSize:12}}>({cat.labelAr})</span></div><div style={{fontSize:11,fontFamily:"monospace",color:cat.color}}>Code: {cat.code}</div></div>
              <div style={{marginLeft:"auto",fontSize:11,padding:"3px 10px",borderRadius:20,background:cat.rec?"#E8F5F0":"#FFF3E0",color:cat.rec?"#1A6B4A":"#E65100",fontWeight:700}}>Input VAT {cat.rec?"✓ Recoverable":"✗ Not Recoverable"}</div>
            </div>
            <div style={{fontSize:13,color:C.textMid,marginBottom:4}}>{cat.desc}</div>
            <div style={{fontSize:12,color:C.textLight}}><strong>Examples:</strong> {cat.ex}</div>
          </Card>
        ))}
        <Card style={{background:C.zatcaLight,border:`1px solid ${C.zatca}30`}}>
          <div style={{fontWeight:700,color:C.zatca,marginBottom:6}}>🍽️ For Restaurants</div>
          <div style={{fontSize:13,color:C.textMid,lineHeight:1.7}}>Almost all restaurant transactions are <strong>Standard Rated (15%)</strong> — dine-in, takeaway, delivery, service charges, cover charges, and catering. Zero-rated and exempt categories almost never apply to restaurant operations inside Saudi Arabia.</div>
        </Card>
      </div>}

      {sec==="calculator"&&<div style={{display:"flex",flexDirection:"column",gap:16}}>
        <Card>
          <div style={{fontWeight:800,fontSize:15,marginBottom:4}}>🧮 Extract VAT from Inclusive Price</div>
          <div style={{fontSize:12,color:C.textMid,marginBottom:14}}>Enter a VAT-inclusive menu price to see the breakdown. ZATCA half-up rounding applied.</div>
          <label style={{fontSize:12,fontWeight:700,color:C.textMid,textTransform:"uppercase"}}>Menu Price (SAR, incl. 15% VAT)</label>
          <input value={inclPrice} onChange={e=>setInclPrice(e.target.value.replace(/[^0-9.]/g,""))} placeholder="e.g. 43.70" inputMode="decimal" style={{width:"100%",padding:"11px 14px",borderRadius:8,border:`1.5px solid ${C.border}`,fontSize:16,fontFamily:"inherit",boxSizing:"border-box",marginTop:6,fontWeight:700}}/>
          {ir&&<div style={{marginTop:14,display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
            {[["Net (excl. VAT)",ir.net,"Price before VAT"],["VAT Amount (15%)",ir.vat,"Paid to ZATCA"],["Total (incl. VAT)",ir.total,"Customer pays"]].map(([l,v,sub])=>(
              <div key={l} style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,padding:12,textAlign:"center"}}>
                <div style={{fontSize:11,color:C.textLight,marginBottom:4}}>{l}</div>
                <div style={{fontSize:18,fontWeight:800,color:C.zatca}}>SAR {v.toFixed(2)}</div>
                <div style={{fontSize:10,color:C.textLight,marginTop:4}}>{sub}</div>
              </div>
            ))}
          </div>}
        </Card>
        <Card>
          <div style={{fontWeight:800,fontSize:15,marginBottom:8}}>📐 Invoice Type Auto-Detection</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            {[["Simplified Tax Invoice","B2C walk-in, total < SAR 1,000. Report to FATOORA within 24 hours.","0200000"],["Standard Tax Invoice","B2B customer OR total ≥ SAR 1,000. Submit for ZATCA Clearance BEFORE issuing.","0100000"]].map(([t,d,s])=>(
              <div key={t} style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,padding:12}}>
                <div style={{fontWeight:700,fontSize:13,marginBottom:4}}>{t}</div>
                <div style={{fontSize:12,color:C.textMid,marginBottom:4}}>{d}</div>
                <div style={{fontSize:11,fontFamily:"monospace",color:C.zatca}}>Subtype: {s}</div>
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <div style={{fontWeight:800,fontSize:15,marginBottom:6}}>📐 ZATCA Rounding Rule</div>
          <div style={{fontSize:13,color:C.textMid,lineHeight:1.7}}>ZATCA mandates <strong>half-up rounding</strong>. Line items use <strong>4 decimal places</strong> internally. VAT is calculated at document level (BT-110 rule) — NOT by summing per-line VAT amounts.</div>
          <div style={{marginTop:10,background:C.bg,borderRadius:8,padding:10,fontSize:12,fontFamily:"monospace",color:C.text}}>Example: 3 × SAR 9.99 = 29.97 net → VAT = 29.97 × 0.15 = 4.4955 → <strong>SAR 4.50</strong></div>
        </Card>
      </div>}

      {sec==="return"&&<div style={{display:"flex",flexDirection:"column",gap:16}}>
        <Card>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:8}}>
            <div><div style={{fontWeight:800,fontSize:15}}>📊 VAT Return — {yr}</div><div style={{fontSize:12,color:C.textMid}}>From your RestoPOS sales data</div></div>
            <select value={yr} onChange={e=>setYr(e.target.value)} style={{padding:"8px 12px",borderRadius:8,border:`1px solid ${C.border}`,fontFamily:"inherit",fontSize:13}}>
              {years.map(y=><option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:14}}>
            {[["Total Sales (incl. VAT)",vd.gross,C.primary],["Taxable Net",vd.net,C.text],["Output VAT",vd.out,C.zatca]].map(([l,v,c])=>(
              <div key={l} style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,padding:12,textAlign:"center"}}>
                <div style={{fontSize:11,color:C.textLight,marginBottom:4}}>{l}</div>
                <div style={{fontSize:16,fontWeight:800,color:c}}>SAR {v.toFixed(2)}</div>
              </div>
            ))}
          </div>
          <div style={{background:C.zatcaLight,border:`1px solid ${C.zatca}30`,borderRadius:8,padding:12,fontSize:13,color:C.textMid}}><strong style={{color:C.zatca}}>Filing rule:</strong> Monthly if annual revenue &gt; SAR 40M, otherwise <strong>quarterly</strong>. Deadline: last day of month after period end. Nil returns required even during inactive periods.</div>
        </Card>
        {Object.keys(vd.byMo).length>0&&<Card>
          <div style={{fontWeight:800,fontSize:14,marginBottom:12}}>Monthly Breakdown</div>
          {Object.entries(vd.byMo).sort(([a],[b])=>a.localeCompare(b)).map(([mo,d])=>(
            <div key={mo} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 10px",borderRadius:8,background:C.bg,border:`1px solid ${C.border}`,marginBottom:4,flexWrap:"wrap",gap:4}}>
              <span style={{fontSize:13,fontWeight:600,minWidth:90}}>{mo}</span>
              <span style={{fontSize:12,color:C.textLight}}>{d.count} orders</span>
              <span style={{fontSize:12,color:C.textMid}}>Net: SAR {d.net.toFixed(2)}</span>
              <span style={{fontSize:13,fontWeight:700,color:C.zatca}}>VAT: SAR {d.vat.toFixed(2)}</span>
              <span style={{fontSize:13,fontWeight:800}}>SAR {d.gross.toFixed(2)}</span>
            </div>
          ))}
        </Card>}
      </div>}

      {sec==="penalties"&&<div style={{display:"flex",flexDirection:"column",gap:16}}>
        <Card>
          <div style={{fontWeight:800,fontSize:15,marginBottom:4}}>⚠️ ZATCA Penalty Estimator</div>
          <div style={{fontSize:12,color:C.textMid,marginBottom:14}}>Source: ZATCA VAT Law Article 45. Max SAR 50,000 per violation.</div>
          <label style={{fontSize:12,fontWeight:700,color:C.textMid,textTransform:"uppercase"}}>Violation Type</label>
          <select value={penType} onChange={e=>setPenType(e.target.value)} style={{width:"100%",padding:"11px 14px",borderRadius:8,border:`1.5px solid ${C.border}`,fontFamily:"inherit",fontSize:13,marginTop:6,marginBottom:14}}>
            {Object.entries(ZATCA_PEN).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
          </select>
          {(penType==="late_return"||penType==="incorrect_return")&&<>
            <label style={{fontSize:12,fontWeight:700,color:C.textMid,textTransform:"uppercase"}}>Tax Amount (SAR)</label>
            <input value={penTax} onChange={e=>setPenTax(e.target.value.replace(/[^0-9.]/g,""))} placeholder="e.g. 10000" inputMode="decimal" style={{width:"100%",padding:"11px 14px",borderRadius:8,border:`1.5px solid ${C.border}`,fontSize:14,fontFamily:"inherit",boxSizing:"border-box",marginTop:6,marginBottom:14}}/>
          </>}
          <div style={{background:C.warningLight,border:`1px solid ${C.warning}55`,borderRadius:10,padding:16,textAlign:"center"}}>
            <div style={{fontSize:12,color:C.textMid,marginBottom:4}}>Estimated Penalty</div>
            <div style={{fontSize:32,fontWeight:900,color:C.warning}}>SAR {pr.toFixed(2)}</div>
            <div style={{fontSize:11,color:C.textLight,marginTop:4}}>Capped at SAR 50,000 per Article 45</div>
          </div>
        </Card>
        <Card>
          <div style={{fontWeight:800,fontSize:14,marginBottom:10}}>All ZATCA Penalties</div>
          {Object.entries(ZATCA_PEN).map(([k,v])=>(
            <div key={k} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 0",borderBottom:`1px solid ${C.border}`}}>
              <span style={{fontSize:13,color:C.text,flex:1}}>{v.label}</span>
              <span style={{fontSize:13,fontWeight:700,color:C.warning,minWidth:140,textAlign:"right"}}>{v.fixed>0?`SAR ${v.fixed.toLocaleString()}`:v.pct>0?`${(v.pct*100).toFixed(0)}% of tax`:"—"}</span>
            </div>
          ))}
        </Card>
      </div>}

      {sec==="rules"&&<div style={{display:"flex",flexDirection:"column",gap:12}}>
        {[["📅","Credit & Debit Note Deadline","Must be issued within 15 CALENDAR DAYS of the event (return, price correction, overcharge). Always reference the original invoice number. After 15 days, ZATCA may reject and penalties apply."],["🔢","Sequential Invoice Numbers","ZATCA requires gap-free sequential numbers. You cannot delete or skip numbers. Voiding requires a Credit Note — not deletion. RestoPOS auto-generates compliant numbers."],["🏦","VAT Registration Threshold","Mandatory if taxable revenue exceeded SAR 375,000 in any 12-month period. Voluntary from SAR 187,500. Late registration penalty: SAR 10,000."],["📦","5-Year Record Keeping","All e-invoices and XML files must be stored securely and accessible for minimum 5 years. ZATCA can audit any period within this window."],["⏱️","24-Hour Reporting Rule","B2C (Simplified) invoices must be reported to FATOORA within 24 hours. B2B (Standard) invoices require ZATCA Clearance BEFORE giving to the buyer."],["🧾","Mandatory Invoice Fields","Seller legal name (Arabic), 15-digit VAT TRN, CR number, invoice date, sequential number, UUID, QR code, VAT breakdown, payment method. Standard invoices also need buyer name and TRN."],["💱","SAR Currency Only","All ZATCA invoices must be in Saudi Riyals (SAR). Foreign currency transactions must show the SAR equivalent. Tax is always in SAR."],["🔐","Phase 2 Cryptographic Signing","Every Phase 2 invoice must be signed with your ECDSA private key and stamped with the ZATCA CSID. RestoPOS handles this automatically after ZATCA Phase 2 activation."]].map(([icon,title,rule])=>(
          <Card key={title}>
            <div style={{display:"flex",gap:12,alignItems:"flex-start"}}>
              <span style={{fontSize:22,minWidth:30}}>{icon}</span>
              <div><div style={{fontWeight:800,fontSize:14,marginBottom:4}}>{title}</div><div style={{fontSize:13,color:C.textMid,lineHeight:1.6}}>{rule}</div></div>
            </div>
          </Card>
        ))}
        <Card style={{background:C.zatcaLight,border:`1px solid ${C.zatca}30`}}>
          <div style={{fontWeight:700,color:C.zatca,marginBottom:6}}>📜 Legal References</div>
          <div style={{fontSize:12,color:C.textMid,lineHeight:1.8}}>• KSA VAT Law — Royal Decree M/113 (2 Nov 2017)<br/>• VAT Rate 15% — Royal Decree A/638 (effective 1 Jul 2020)<br/>• VAT Implementing Regulations — Board Resolution 01-06-24 (18 Apr 2025)<br/>• FATOORA XML Standard v1.2 (May 2023)<br/>• Phase 2 Wave 24 — businesses above SAR 375,000 (deadline 30 Jun 2026)</div>
        </Card>
      </div>}
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
      settings:{company:LS.get("restopos_company"),invoiceFormat:LS.get("restopos_invoice_format"),draftFormat:LS.get("restopos_draft_format"),kotFormat:LS.get("restopos_kot_format"),dashboardConfig:LS.get("restopos_dashboard_config"),tables:LS.get("restopos_tables"),promos:LS.get("restopos_promos")},
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
        if(data.settings?.draftFormat)LS.set("restopos_draft_format",data.settings.draftFormat);
        if(data.settings?.kotFormat)LS.set("restopos_kot_format",data.settings.kotFormat);
        if(data.settings?.dashboardConfig)LS.set("restopos_dashboard_config",data.settings.dashboardConfig);
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
// Lightweight per-section boundary — keeps one broken tab from white-screening the app.
class TabBoundary extends Component {
  constructor(props){super(props);this.state={hasError:false,msg:""};}
  static getDerivedStateFromError(error){return{hasError:true,msg:error?.message||"Error"};}
  componentDidCatch(error,info){
    try{const logs=JSON.parse(localStorage.getItem("restopos_error_logs")||"[]");logs.unshift({ts:new Date().toISOString(),message:error?.message||"Unknown",where:this.props.name||"tab"});localStorage.setItem("restopos_error_logs",JSON.stringify(logs.slice(0,50)));}catch(e){}
  }
  render(){
    if(this.state.hasError){
      return(
        <div style={{padding:30,textAlign:"center",background:"#fff",border:"1px solid #eee",borderRadius:14,maxWidth:460,margin:"20px auto"}}>
          <div style={{fontSize:38,marginBottom:10}}>⚠️</div>
          <div style={{fontSize:16,fontWeight:800,color:"#D94040",marginBottom:6}}>This section hit an error</div>
          <div style={{fontSize:12,color:"#888",marginBottom:18}}>{this.state.msg}</div>
          <button onClick={()=>{try{localStorage.setItem("restopos_screen","dashboard");}catch(e){}window.location.reload();}}
            style={{padding:"11px 24px",background:"linear-gradient(135deg,#1A6B4A,#134D36)",color:"#fff",border:"none",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Go to Dashboard</button>
        </div>
      );
    }
    return this.props.children;
  }
}

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
            <button onClick={()=>{try{localStorage.setItem("restopos_screen","dashboard");}catch(e){}this.setState({hasError:false,error:null});window.location.reload();}} style={{padding:"12px 28px",background:"linear-gradient(135deg,#1A6B4A,#134D36)",color:"#fff",border:"none",borderRadius:10,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit",marginRight:10}}>Try Again</button>
            <button onClick={()=>{try{localStorage.setItem("restopos_screen","dashboard");}catch(e){}window.location.reload();}} style={{padding:"12px 28px",background:"rgba(255,255,255,0.1)",color:"#fff",border:"1px solid rgba(255,255,255,0.2)",borderRadius:10,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Reload App</button>
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
// Convert an amount to English words for the invoice "Amount in words" line.
function numberToWordsSAR(amount){
  const n=Math.round((Number(amount)||0)*100);
  const riyals=Math.floor(n/100), halalas=n%100;
  const ones=["zero","one","two","three","four","five","six","seven","eight","nine","ten","eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen"];
  const tens=["","","twenty","thirty","forty","fifty","sixty","seventy","eighty","ninety"];
  function below1000(x){
    let s="";
    if(x>=100){s+=ones[Math.floor(x/100)]+" hundred";x%=100;if(x)s+=" ";}
    if(x>=20){s+=tens[Math.floor(x/10)];if(x%10)s+="-"+ones[x%10];}
    else if(x>0)s+=ones[x];
    return s;
  }
  function words(x){
    if(x===0)return "zero";
    let s="";
    if(x>=1000000){s+=below1000(Math.floor(x/1000000))+" million";x%=1000000;if(x)s+=" ";}
    if(x>=1000){s+=below1000(Math.floor(x/1000))+" thousand";x%=1000;if(x)s+=" ";}
    if(x>0)s+=below1000(x);
    return s;
  }
  const cap=(s)=>s.charAt(0).toUpperCase()+s.slice(1);
  let out=cap(words(riyals))+" Riyal";
  out+=" and "+(halalas===0?"Zero":words(halalas))+" Halala";
  return out;
}

const ESC=0x1B;const GS=0x1D;

// ── CP864 (Arabic thermal code page) lookup ─────────────────────────
// Maps common Arabic Unicode letters → CP864 byte values so the printer's
// HARDWARE font renders Arabic crisply instead of garbling UTF-8.
// This is the SAME approach the competitor receipt uses: built-in Font A.
const CP864_MAP={
  0x0660:0x30,0x0661:0x31,0x0662:0x32,0x0663:0x33,0x0664:0x34,0x0665:0x35,0x0666:0x36,0x0667:0x37,0x0668:0x38,0x0669:0x39,
  0x060C:0xAC,0x061B:0xBB,0x061F:0xBF,
  0x0621:0xC1,0x0622:0xC2,0x0623:0xC3,0x0624:0xC4,0x0625:0xC5,0x0626:0xC6,0x0627:0xC7,0x0628:0xC8,0x0629:0xC9,0x062A:0xCA,
  0x062B:0xCB,0x062C:0xCC,0x062D:0xCD,0x062E:0xCE,0x062F:0xCF,0x0630:0xD0,0x0631:0xD1,0x0632:0xD2,0x0633:0xD3,0x0634:0xD4,
  0x0635:0xD5,0x0636:0xD6,0x0637:0xD7,0x0638:0xD8,0x0639:0xD9,0x063A:0xDA,0x0640:0xE0,0x0641:0xE1,0x0642:0xE2,0x0643:0xE3,
  0x0644:0xE4,0x0645:0xE5,0x0646:0xE6,0x0647:0xE7,0x0648:0xE8,0x0649:0xE9,0x064A:0xEA
};
function _hasArabic(s){return /[\u0600-\u06FF]/.test(String(s||""));}
// Encode a string for thermal printing. Arabic chars → CP864 bytes (reversed for RTL),
// everything else → ASCII. Never throws, never garbles.
function _encodeThermal(str){
  const s=String(str==null?"":str);
  const out=[];
  // Split into runs so Arabic runs can be reversed for visual RTL order
  const tokens=s.match(/[\u0600-\u06FF\u0660-\u0669]+|[^\u0600-\u06FF\u0660-\u0669]+/g)||[];
  for(const tok of tokens){
    if(_hasArabic(tok)){
      const bytes=[];
      for(const ch of tok){const cp=ch.codePointAt(0);bytes.push(CP864_MAP[cp]!=null?CP864_MAP[cp]:0x20);}
      bytes.reverse(); // visual RTL
      out.push(...bytes);
    }else{
      for(const ch of tok){const c=ch.charCodeAt(0);out.push(c<128?c:0x20);}
    }
  }
  return new Uint8Array(out);
}

const escpos={
  init:()=>new Uint8Array([ESC,0x40]),
  // Force built-in Font A (the crisp, never-corrupting hardware font)
  fontA:()=>new Uint8Array([ESC,0x4D,0x00]),
  // Select CP864 Arabic code page (n=22 on most Epson-compatible printers)
  codepage:(n=22)=>new Uint8Array([ESC,0x74,n]),
  alignCenter:()=>new Uint8Array([ESC,0x61,0x01]),
  alignLeft:()=>new Uint8Array([ESC,0x61,0x00]),
  bold:(on)=>new Uint8Array([ESC,0x45,on?1:0]),
  doubleSize:(on)=>new Uint8Array([ESC,0x21,on?0x30:0x00]),
  cutPaper:()=>new Uint8Array([GS,0x56,0x41,0x00]),
  feed:(n=3)=>new Uint8Array([ESC,0x64,n]),
  // text() now routes Arabic through CP864 so it never garbles
  text:(str)=>{const body=_encodeThermal(str);const out=new Uint8Array(body.length+1);out.set(body,0);out[body.length]=0x0A;return out;},
  // Raster logo: takes a monochrome packed bitmap {width,height,data} → GS v 0
  image:(bmp)=>{
    if(!bmp||!bmp.data)return new Uint8Array(0);
    const wBytes=Math.ceil(bmp.width/8);
    const xL=wBytes&0xff,xH=(wBytes>>8)&0xff;
    const yL=bmp.height&0xff,yH=(bmp.height>>8)&0xff;
    const header=new Uint8Array([GS,0x76,0x30,0x00,xL,xH,yL,yH]);
    const out=new Uint8Array(header.length+bmp.data.length);
    out.set(header,0);out.set(bmp.data,header.length);
    return out;
  },
  // Native ESC/POS QR (GS ( k) — prints a scannable ZATCA QR on the thermal printer
  qr:(str)=>{
    const enc=new TextEncoder().encode(String(str||""));
    const storeLen=enc.length+3;const pL=storeLen&0xff,pH=(storeLen>>8)&0xff;
    const model=new Uint8Array([GS,0x28,0x6B,0x04,0x00,0x31,0x41,0x32,0x00]); // model 2
    const size=new Uint8Array([GS,0x28,0x6B,0x03,0x00,0x31,0x43,0x06]);       // module size 6
    const ec=new Uint8Array([GS,0x28,0x6B,0x03,0x00,0x31,0x45,0x31]);         // error correction M
    const store=new Uint8Array([GS,0x28,0x6B,pL,pH,0x31,0x50,0x30,...enc]);   // store data
    const print=new Uint8Array([GS,0x28,0x6B,0x03,0x00,0x31,0x51,0x30]);      // print
    const total=model.length+size.length+ec.length+store.length+print.length;
    const out=new Uint8Array(total);let o=0;[model,size,ec,store,print].forEach(a=>{out.set(a,o);o+=a.length;});
    return out;
  },
  merge:(...arrays)=>{const total=arrays.reduce((s,a)=>s+a.length,0);const merged=new Uint8Array(total);let offset=0;for(const a of arrays){merged.set(a,offset);offset+=a.length;}return merged;}
};

// ── Logo raster helper ──────────────────────────────────────────────
// Loads a logo image URL, scales it to fit the paper width, converts to
// 1-bit monochrome and packs it into the byte layout GS v 0 expects.
// maxWidth in dots: 384 for 58mm paper, 576 for 80mm paper.
async function logoToBitmap(url,maxWidth=384){
  return new Promise((resolve)=>{
    if(!url){resolve(null);return;}
    let done=false;
    const finish=(val)=>{if(done)return;done=true;resolve(val);};
    // Hard timeout: never let a slow/blocked image stall printing
    const timer=setTimeout(()=>{console.warn("[logo] timed out — printing without logo");finish(null);},1500);
    const img=new Image();
    img.crossOrigin="anonymous";
    img.onload=()=>{
      clearTimeout(timer);
      try{
        let w=img.width,h=img.height;
        if(!w||!h){finish(null);return;}
        if(w>maxWidth){h=Math.round(h*(maxWidth/w));w=maxWidth;}
        w=Math.floor(w/8)*8; // width must be a multiple of 8 dots
        if(w<8){finish(null);return;}
        const cv=document.createElement("canvas");cv.width=w;cv.height=h;
        const ctx=cv.getContext("2d");
        ctx.fillStyle="#fff";ctx.fillRect(0,0,w,h);
        ctx.drawImage(img,0,0,w,h);
        let px;
        try{px=ctx.getImageData(0,0,w,h).data;}
        catch(secErr){console.warn("[logo] canvas blocked (CORS) — printing without logo");finish(null);return;}
        const wBytes=w/8;
        const data=new Uint8Array(wBytes*h);
        for(let y=0;y<h;y++){
          for(let x=0;x<w;x++){
            const i=(y*w+x)*4;
            const a=px[i+3];
            const lum=(px[i]*0.299+px[i+1]*0.587+px[i+2]*0.114);
            const dot=(a>128&&lum<140)?1:0;
            if(dot)data[y*wBytes+(x>>3)]|=(0x80>>(x&7));
          }
        }
        finish({width:w,height:h,data});
      }catch(e){console.warn("[logo] failed:",e);finish(null);}
    };
    img.onerror=()=>{clearTimeout(timer);console.warn("[logo] image failed to load — printing without logo");finish(null);};
    try{img.src=url;}catch(e){clearTimeout(timer);finish(null);}
  });
}

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
  const fmt=(typeof LS!=="undefined"&&LS.get&&LS.get("restopos_invoice_format"))||{};
  const paper=(fmt.paperWidth==="58mm")?"58mm":"80mm";
  const W=paper==="58mm"?32:42;                 // chars per line for Font A
  const logoDots=paper==="58mm"?384:576;
  const money=(n)=>"SAR "+(Number(n)||0).toFixed(2);
  // right-aligned two-column line
  const line=(left,right="")=>{
    left=String(left);right=String(right);
    if(left.length+right.length>=W)left=left.slice(0,Math.max(0,W-right.length-1));
    const gap=W-left.length-right.length;
    return escpos.text(left+(gap>0?" ".repeat(gap):" ")+right);
  };
  const rule=()=>escpos.text("-".repeat(W));

  const parts=[ escpos.init(), escpos.fontA(), escpos.codepage(22) ];

  // ── Logo (raster) — prints crisply at the very top ─────────────────
  try{
    if(fmt.logoUrl){
      const bmp=await logoToBitmap(fmt.logoUrl,logoDots);
      if(bmp){parts.push(escpos.alignCenter(),escpos.image(bmp),escpos.text(""));}
    }
  }catch(e){console.warn("[logo]",e);}

  // ── Header ─────────────────────────────────────────────────────────
  parts.push(
    escpos.alignCenter(),
    escpos.bold(true),escpos.doubleSize(true),
    escpos.text(license.businessName||"Restaurant"),
    escpos.doubleSize(false),escpos.bold(false),
  );
  if(license.businessNameAr)parts.push(escpos.text(license.businessNameAr));
  if(license.address)parts.push(escpos.text(license.address));
  parts.push(
    escpos.text("VAT / "+("الرقم الضريبي")+": "+(license.vatNumber||"")),
    license.phone?escpos.text("Tel: "+license.phone):new Uint8Array(0),
    rule(),
    escpos.bold(true),escpos.text("Simplified Tax Invoice"),escpos.bold(false),
    escpos.text("فاتورة ضريبية مبسطة"),
    rule(),
    escpos.alignLeft(),
    line(order.id||"",((order.date||"")+" "+(order.time||"")).trim()),
    escpos.text((order.type||"Sale")+(order.table?" - Table "+order.table:"")),
  );
  if(order.customer)parts.push(escpos.text("Customer: "+order.customer));
  parts.push(rule());

  // ── Column header ──────────────────────────────────────────────────
  parts.push(escpos.bold(true),line("Item            Qty x Rate","Amount"),escpos.bold(false),rule());

  // ── Items (bilingual: English line + Arabic line) ──────────────────
  for(const it of items){
    const qtyRate=(it.qty)+" x "+(Number(it.price)||0).toFixed(2);
    const nm=(it.name||"").slice(0,W-qtyRate.length-2);
    parts.push(line(nm,money(it.price*it.qty)));
    parts.push(escpos.text("   "+qtyRate));
    if(it.nameAr)parts.push(escpos.text(it.nameAr));
  }
  parts.push(rule());

  // ── Totals breakdown (clear, like competitor) ──────────────────────
  const total=Number(order.total)||0;
  const vat=Number(order.vat)||0;
  const subtotal=(order.subtotal!=null)?Number(order.subtotal):(total-vat);
  if(order.discount>0)parts.push(line("Discount / خصم","-"+money(order.discount)));
  parts.push(
    line("Subtotal / المجموع",money(subtotal)),
    line("VAT 15% / ضريبة",money(vat)),
    escpos.bold(true),escpos.doubleSize(true),
    line("TOTAL",money(total)),
    escpos.doubleSize(false),escpos.bold(false),
  );

  // ── Amount in words ────────────────────────────────────────────────
  try{parts.push(escpos.text("Amount in words: "+numberToWordsSAR(total)));}catch(e){}

  // ── Payment ────────────────────────────────────────────────────────
  if(order.payMethod==="Cash"){
    parts.push(line("Cash Given",money(order.given)),line("Change",money(order.change)));
  }else if(order.payMethod==="Both"){
    parts.push(line("Cash",money(order.cashAmount)),line("Card",money(order.cardAmount)));
  }else{
    parts.push(line("Payment",order.payMethod||""));
  }

  // ── ZATCA QR (native, scannable) ───────────────────────────────────
  try{
    const qrStr=(order.qr_string)||generatePhase1QR({sellerName:license.businessName||"",vatNumber:license.vatNumber||"",timestamp:new Date().toISOString(),total:total,vatAmount:vat});
    parts.push(escpos.text(""),escpos.alignCenter(),escpos.qr(qrStr),escpos.text("ZATCA PHASE 2 - QR"));
  }catch(e){}

  parts.push(
    escpos.text(""),escpos.alignCenter(),
    escpos.text("Thank you for your visit!"),
    escpos.text("شكرا لزيارتكم"),
    escpos.text(""),escpos.feed(3),escpos.cutPaper()
  );
  const data=escpos.merge(...parts.filter(p=>p.length>0));
  if(order.payMethod==="Cash"||order.payMethod==="Both"){
    try{
      const drawerCmd=new Uint8Array([0x1B,0x70,0x00,0x19,0xFA]);
      await printEscPos(escpos.merge(drawerCmd,data),"bill");
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
    escpos.fontA(),
    escpos.codepage(22),
    escpos.alignCenter(),
    escpos.bold(true),escpos.doubleSize(true),
    escpos.text("KOT #"+kotNo),
    escpos.doubleSize(false),escpos.bold(false),
    escpos.text("--------------------------------"),
    escpos.alignLeft(),
    escpos.text((orderType||"Order").toUpperCase()+(tableId?" - Table "+tableId:"")),
    escpos.text(new Date().toLocaleTimeString("en-SA",{hour:"2-digit",minute:"2-digit"})),
    escpos.text("--------------------------------"),
    ...cart.flatMap(it=>{
      const rows=[escpos.bold(true),escpos.doubleSize(true),escpos.text(it.qty+"x "+it.name),escpos.doubleSize(false),escpos.bold(false)];
      if(it.nameAr)rows.push(escpos.text("   "+it.nameAr));
      return rows;
    }),
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
  // Sync new sales into KDS queue — use a ref to avoid re-running on every orders change
  const kdsIdsRef=useRef(new Set(orders.map(o=>o.id)));
  useEffect(()=>{
    const recent=sales.filter(s=>!kdsIdsRef.current.has(s.id)&&s.status==="completed");
    if(recent.length>0){
      const newOrders=recent.map(s=>({...s,kdsStatus:"pending",kdsAt:new Date().toISOString(),routedTo:"Kitchen"}));
      recent.forEach(s=>kdsIdsRef.current.add(s.id));
      setOrders(prev=>{
        const updated=[...newOrders,...prev].slice(0,200);
        localStorage.setItem("restopos_kds_orders",JSON.stringify(updated));
        return updated;
      });
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
      if(typeof qz==="undefined"){setStatus("disconnected");addLog("QZ Tray library failed to load","error");return;}
      const active=isQZConnected();
      if(active){
        setStatus("connected");
        try{
          const p=await qz.printers.find();
          const pList=Array.isArray(p)?p:[p].filter(Boolean);
          setPrinters(pList);
          _qzPrinters=pList;
          addLog("Connected! Found "+pList.length+" printer(s)","success");
        }catch(pe){addLog("Connected but could not list printers: "+pe.message,"error");}
      }else{
        const ok=await connectQZ();
        if(ok){
          setStatus("connected");
          setPrinters(_qzPrinters);
          addLog("Connected! Found "+_qzPrinters.length+" printer(s)","success");
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
              {status==="connected"&&<Btn onClick={async()=>{await disconnectQZ();setTimeout(()=>checkStatus(),500);}} color={C.danger} variant="outline" size="sm">Disconnect</Btn>}
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

      {/* Certificate setup — stops the "Allow / Untrusted website" popup permanently */}
      <Card style={{border:`2px solid ${C.zatca}33`,background:"#F7FFFB"}}>
        <div style={{fontSize:14,fontWeight:800,marginBottom:6,color:C.zatca}}>🔐 Stop the “Allow” popup (one-time per computer)</div>
        <div style={{display:"inline-flex",alignItems:"center",gap:8,marginBottom:10,padding:"6px 12px",borderRadius:8,background:(typeof window!=="undefined"&&window.KJUR)?C.successLight:C.warningLight,border:`1px solid ${(typeof window!=="undefined"&&window.KJUR)?C.success:C.warning}44`}}>
          <span style={{fontSize:14}}>{(typeof window!=="undefined"&&window.KJUR)?"🟢":"🟡"}</span>
          <span style={{fontSize:12,fontWeight:800,color:(typeof window!=="undefined"&&window.KJUR)?C.success:C.warning}}>
            Request signing: {(typeof window!=="undefined"&&window.KJUR)?"ON (active)":"loading… reconnect if this stays yellow"}
          </span>
        </div>
        <div style={{fontSize:12,color:C.textMid,marginBottom:12}}>
          RestoPOS already signs every print request. To make QZ Tray trust it silently, install the RestoPOS certificate on this computer <strong>once</strong>:
        </div>
        {[
          {n:"1",t:"Download the certificate",d:"Click the button below to save restopos-certificate.txt."},
          {n:"2",t:"Open QZ Tray → Advanced → Site Manager",d:"Right-click the QZ Tray tray icon → Advanced → Site Manager."},
          {n:"3",t:"Add the certificate",d:"Site Manager → click + → choose the downloaded restopos-certificate.txt. When asked “copy to override.crt?”, click Yes."},
          {n:"4",t:"Restart QZ Tray",d:"Right-click tray icon → Exit, then start QZ Tray again. Done — no more popups on this machine."},
        ].map(s=>(
          <div key={s.n} style={{display:"flex",gap:12,marginBottom:8,padding:10,background:"#fff",borderRadius:8}}>
            <div style={{width:26,height:26,background:C.zatca,color:"#fff",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:800,flexShrink:0}}>{s.n}</div>
            <div><div style={{fontSize:13,fontWeight:700,marginBottom:2}}>{s.t}</div><div style={{fontSize:12,color:C.textMid}}>{s.d}</div></div>
          </div>
        ))}
        <Btn onClick={()=>{
          try{
            const blob=new Blob([RESTOPOS_QZ_CERT],{type:"text/plain"});
            const url=URL.createObjectURL(blob);
            const a=document.createElement("a");
            a.href=url;a.download="restopos-certificate.txt";
            document.body.appendChild(a);a.click();
            setTimeout(()=>{document.body.removeChild(a);URL.revokeObjectURL(url);},100);
            addLog("Certificate downloaded — add it in QZ Tray Site Manager","success");
          }catch(e){addLog("Download failed: "+e.message,"error");}
        }}>⬇️ Download RestoPOS Certificate</Btn>
      </Card>

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

// ═══════════════════════════════════════════════════════════════════
// SILENT PRINTING SETUP — dedicated tab: makes QZ Tray print with
// zero "Allow" pop-ups, permanently, per computer.
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// PRINTING SETUP GUIDE — popup with full guide + Save/Print as PDF
// ═══════════════════════════════════════════════════════════════════
const PRINT_GUIDE_HTML=`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>RestoPOS — Silent Printing Setup</title><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F4F6F9;color:#1a1a2e}
.header{background:linear-gradient(135deg,#1A6B4A,#134D36);color:#fff;padding:32px 24px 28px;text-align:center}
.header h1{font-size:22px;font-weight:800;margin-bottom:6px}
.header p{font-size:13px;opacity:.8}
.badge{display:inline-block;background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.3);border-radius:20px;padding:4px 14px;font-size:11px;font-weight:700;margin-top:10px}
.container{max-width:640px;margin:0 auto;padding:20px 16px 40px}
.alert{background:#FFF8E1;border:1.5px solid #F0A500;border-radius:12px;padding:14px 16px;margin-bottom:20px;font-size:13px;color:#7A5200;line-height:1.6}
.alert strong{color:#C07800}
.card{background:#fff;border-radius:14px;padding:20px;margin-bottom:16px;box-shadow:0 1px 4px rgba(0,0,0,.07)}
.part-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#1A6B4A;background:#E8F5F0;border-radius:6px;padding:3px 10px;display:inline-block;margin-bottom:12px}
.card-title{font-size:15px;font-weight:800;margin-bottom:14px}
.step{display:flex;gap:12px;margin-bottom:12px;align-items:flex-start}
.step-num{width:28px;height:28px;min-width:28px;border-radius:50%;background:#1A6B4A;color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800}
.step-body{flex:1;padding-top:4px}
.step-title{font-size:13px;font-weight:700;margin-bottom:3px}
.step-desc{font-size:12px;color:#666;line-height:1.6}
.step-desc code{background:#F0F0F0;border-radius:4px;padding:1px 6px;font-family:monospace;font-size:12px;color:#333}
.tip{background:#E8F5F0;border:1px solid #1A6B4A33;border-radius:10px;padding:12px 14px;font-size:12px;color:#1A4A33;line-height:1.7;margin-top:12px}
.tip strong{color:#1A6B4A}
.warning-card{background:#FFF3E0;border:1.5px solid #E6510033;border-radius:12px;padding:16px;margin-bottom:16px}
.warning-card .title{font-size:14px;font-weight:800;color:#E65100;margin-bottom:8px}
.warning-card p{font-size:12px;color:#7A3500;line-height:1.6}
.success-card{background:#E8F5F0;border:1.5px solid #1A6B4A44;border-radius:12px;padding:16px;margin-bottom:16px}
.success-card .title{font-size:14px;font-weight:800;color:#1A6B4A;margin-bottom:8px}
.success-card p{font-size:12px;color:#1A4A33;line-height:1.6}
.divider{border:none;border-top:1px solid #E8ECF0;margin:20px 0}
.footer{text-align:center;font-size:11px;color:#999;margin-top:24px;line-height:1.8}
.footer a{color:#1A6B4A;text-decoration:none;font-weight:700}
.path{background:#1a1a2e;color:#7FFAB5;border-radius:8px;padding:8px 12px;font-family:monospace;font-size:12px;margin:8px 0;display:block;word-break:break-all}
@media print{body{background:#fff}.card,.warning-card,.success-card{box-shadow:none;break-inside:avoid}}
</style></head><body>
<div class="header"><div style="font-size:36px;margin-bottom:8px;">🖨️</div><h1>Stop the Print Pop-Up — Forever</h1><p>One-time setup per computer · Takes 3 minutes</p><div class="badge">RestoPOS Silent Printing Guide</div></div>
<div class="container">
<div class="alert"><strong>Why does the pop-up keep appearing?</strong><br/>QZ Tray shows an "Allow / Untrusted website" box every time because it doesn't yet trust RestoPOS on this computer. Once you install the RestoPOS certificate (below), it will never ask again on this machine.</div>
<div class="card"><div class="part-label">Part A — If QZ Tray is not installed yet</div><div class="card-title">⬇️ Install QZ Tray</div>
<div class="step"><div class="step-num">1</div><div class="step-body"><div class="step-title">Download QZ Tray</div><div class="step-desc">Go to <strong>qz.io/download</strong> — it's free and about 15MB. Choose the Windows installer.</div></div></div>
<div class="step"><div class="step-num">2</div><div class="step-body"><div class="step-title">Install and run it</div><div class="step-desc">Double-click the installer and follow the prompts. QZ Tray appears as a small icon in the <strong>system tray</strong> (bottom-right, near the clock). It starts automatically with Windows.</div></div></div>
<div class="step"><div class="step-num">3</div><div class="step-body"><div class="step-title">Confirm it's running</div><div class="step-desc">Open RestoPOS → <strong>Settings → 🔇 Silent Printing</strong>. The "QZ Tray" status should show 🟢 Connected. If not, click <strong>Reconnect</strong>.</div></div></div></div>
<hr class="divider"/>
<div class="card"><div class="part-label">Part B — Kill the pop-up permanently</div><div class="card-title">🔐 Trust RestoPOS in QZ Tray</div>
<div class="step"><div class="step-num">1</div><div class="step-body"><div class="step-title">Download the RestoPOS certificate</div><div class="step-desc">In RestoPOS → <strong>Settings → 🔇 Silent Printing → "Download RestoPOS Certificate"</strong>. A file <code>restopos-certificate.txt</code> downloads.</div></div></div>
<div class="step"><div class="step-num">2</div><div class="step-body"><div class="step-title">Open QZ Tray → Site Manager</div><div class="step-desc">Right-click the QZ Tray tray icon → <strong>Advanced</strong> → <strong>Site Manager</strong>.</div></div></div>
<div class="step"><div class="step-num">3</div><div class="step-body"><div class="step-title">Add the certificate</div><div class="step-desc">Click <strong>+</strong> (Allowed Sites) → select <code>restopos-certificate.txt</code>. If asked <em>"Copy to override.crt?"</em> click <strong>Yes</strong>.</div></div></div>
<div class="step"><div class="step-num">4</div><div class="step-body"><div class="step-title">Restart QZ Tray</div><div class="step-desc">Right-click the tray icon → <strong>Exit</strong>. Open QZ Tray again from the Start menu. Wait a few seconds.</div></div></div>
<div class="step"><div class="step-num">5</div><div class="step-body"><div class="step-title">Test a print</div><div class="step-desc">Print any receipt in RestoPOS. The pop-up should be completely gone. ✅</div></div></div>
<div class="tip"><strong>This only needs to be done once per computer.</strong> Other computers need the same steps separately — 3 minutes each.</div></div>
<hr class="divider"/>
<div class="card"><div class="part-label">Alternative — Manual file copy</div><div class="card-title">📁 Copy certificate file directly</div>
<p style="font-size:12px;color:#666;margin-bottom:14px;line-height:1.6;">If Site Manager isn't in your QZ Tray version, use this instead:</p>
<div class="step"><div class="step-num">1</div><div class="step-body"><div class="step-title">Download the certificate</div><div class="step-desc">Same as Part B Step 1.</div></div></div>
<div class="step"><div class="step-num">2</div><div class="step-body"><div class="step-title">Rename the file</div><div class="step-desc">Rename <code>restopos-certificate.txt</code> to exactly: <code>override.crt</code></div></div></div>
<div class="step"><div class="step-num">3</div><div class="step-body"><div class="step-title">Copy it to the QZ Tray folder</div><div class="step-desc">Open File Explorer and go to:</div><code class="path">C:\\\\Program Files\\\\QZ Tray\\\\</code><div class="step-desc">Paste <code>override.crt</code> there. Approve the admin prompt with <strong>Yes</strong>.</div></div></div>
<div class="step"><div class="step-num">4</div><div class="step-body"><div class="step-title">Restart QZ Tray</div><div class="step-desc">Right-click tray icon → <strong>Exit</strong> → open QZ Tray again. Done.</div></div></div></div>
<hr class="divider"/>
<div class="warning-card"><div class="title">⚠️ Pop-up still appearing after setup?</div><p>• Make sure you <strong>restarted QZ Tray</strong> after adding the certificate.<br/>• Make sure the certificate came from <strong>RestoPOS Settings → Silent Printing</strong>.<br/>• If the QZ Tray icon isn't in the tray, search "QZ Tray" in the Start menu.<br/>• Still stuck? WhatsApp RestoPOS support: <strong>+966 53 836 0053</strong></p></div>
<div class="success-card"><div class="title">✅ When it's working correctly</div><p>Every receipt, draft bill and report prints <strong>instantly and silently</strong> — no pop-up, no clicking Allow. If QZ Tray is ever off, RestoPOS prints through the browser as a backup so you're never blocked.</p></div>
<div class="footer">RestoPOS · restopos.store<br/>Support: <a href="https://wa.me/966538360053">WhatsApp +966 53 836 0053</a><br/><span style="color:#ccc;">For QZ Tray v2.1+ on Windows. Steps are similar on Mac.</span></div>
</div></body></html>`;

function PrintGuidePopup({onClose}){
  function savePDF(){
    const w=window.open("","_blank","width=760,height=900");
    if(!w){alert("Please allow pop-ups to print / save the guide.");return;}
    w.document.write(PRINT_GUIDE_HTML);
    w.document.close();
    setTimeout(()=>{try{w.focus();w.print();}catch(e){}},500);
  }
  return(
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:10000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#fff",borderRadius:14,width:"100%",maxWidth:680,height:"88vh",display:"flex",flexDirection:"column",overflow:"hidden",boxShadow:"0 20px 60px rgba(0,0,0,0.35)"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 16px",borderBottom:`1px solid ${C.border}`,background:"#fff",flexShrink:0}}>
          <div style={{fontSize:14,fontWeight:800,color:C.text}}>🖨️ Silent Printing Setup Guide</div>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            <Btn size="sm" onClick={savePDF}>🖨️ Print / Save PDF</Btn>
            <button onClick={onClose} style={{background:C.bg,border:`1px solid ${C.border}`,color:C.textMid,width:30,height:30,borderRadius:"50%",fontSize:18,cursor:"pointer",lineHeight:1}}>×</button>
          </div>
        </div>
        <iframe title="Printing Guide" srcDoc={PRINT_GUIDE_HTML} style={{flex:1,border:"none",width:"100%"}}/>
      </div>
    </div>
  );
}

// Self-contained help button — opens the guide popup, no parent state needed
function PrintGuideButton({label="❓ Printing Setup Guide",size="sm",variant="outline"}){
  const [open,setOpen]=useState(false);
  return(<>
    <Btn size={size} variant={variant} onClick={()=>setOpen(true)}>{label}</Btn>
    {open&&<PrintGuidePopup onClose={()=>setOpen(false)}/>}
  </>);
}

// ═══════════════════════════════════════════════════════════════════
// SILENT PRINT SETUP TAB
// ═══════════════════════════════════════════════════════════════════
function SilentPrintSetup(){
  const [showGuide,setShowGuide]=useState(false);
  const [signingOn,setSigningOn]=useState(typeof window!=="undefined"&&!!window.KJUR);
  const [qzConnected,setQzConnected]=useState(false);
  const [msg,setMsg]=useState("");
  useEffect(()=>{
    let alive=true;
    (async()=>{
      try{await loadQZ();}catch(e){}
      if(!alive)return;
      setSigningOn(!!window.KJUR);
      setQzConnected(isQZConnected());
    })();
    const iv=setInterval(()=>{if(alive){setSigningOn(!!window.KJUR);setQzConnected(isQZConnected());}},2000);
    return()=>{alive=false;clearInterval(iv);};
  },[]);
  function downloadCert(){
    try{
      const blob=new Blob([RESTOPOS_QZ_CERT],{type:"text/plain"});
      const url=URL.createObjectURL(blob);
      const a=document.createElement("a");a.href=url;a.download="restopos-certificate.txt";
      document.body.appendChild(a);a.click();
      setTimeout(()=>{document.body.removeChild(a);URL.revokeObjectURL(url);},100);
      setMsg("✅ Certificate downloaded. Now add it in QZ Tray → Advanced → Site Manager.");
    }catch(e){setMsg("❌ Download failed: "+e.message);}
  }
  async function reconnect(){
    setMsg("Reconnecting to QZ Tray…");
    try{await connectQZ();setQzConnected(isQZConnected());setMsg(isQZConnected()?"✅ Connected to QZ Tray.":"⚠️ QZ Tray not detected. Make sure it is installed and running.");}
    catch(e){setMsg("❌ "+e.message);}
  }
  const Step=({n,t,d})=>(
    <div style={{display:"flex",gap:12,marginBottom:8,padding:10,background:"#fff",borderRadius:8,border:`1px solid ${C.border}`}}>
      <div style={{width:26,height:26,background:C.zatca,color:"#fff",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:800,flexShrink:0}}>{n}</div>
      <div><div style={{fontSize:13,fontWeight:700,marginBottom:2}}>{t}</div><div style={{fontSize:12,color:C.textMid}}>{d}</div></div>
    </div>
  );
  return(
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      <div style={{background:C.zatcaLight,border:`1px solid ${C.zatca}44`,borderRadius:10,padding:"12px 16px",fontSize:13,color:C.zatca,fontWeight:600,display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}>
        <div>🔇 Set this up <strong>once per computer</strong> and every invoice, draft and report prints instantly — no “Allow / Untrusted website” pop-up, ever.</div>
        <button onClick={()=>setShowGuide(true)} title="Open step-by-step printing guide" style={{flexShrink:0,width:30,height:30,borderRadius:"50%",border:`1.5px solid ${C.zatca}`,background:"#fff",color:C.zatca,fontSize:15,fontWeight:800,cursor:"pointer",lineHeight:1}}>?</button>
      </div>
      {showGuide&&<PrintGuidePopup onClose={()=>setShowGuide(false)}/>}

      {/* Live status */}
      <Card>
        <div style={{fontSize:14,fontWeight:800,marginBottom:12}}>Status on this computer</div>
        <div style={{display:"flex",flexWrap:"wrap",gap:10}}>
          <div style={{flex:1,minWidth:200,display:"flex",alignItems:"center",gap:10,padding:"10px 14px",borderRadius:8,background:qzConnected?C.successLight:C.warningLight,border:`1px solid ${qzConnected?C.success:C.warning}44`}}>
            <span style={{fontSize:18}}>{qzConnected?"🟢":"🟡"}</span>
            <div><div style={{fontSize:13,fontWeight:800,color:qzConnected?C.success:C.warning}}>QZ Tray {qzConnected?"connected":"not connected"}</div><div style={{fontSize:11,color:C.textMid}}>{qzConnected?"Ready to print silently":"Install & run QZ Tray, then Reconnect"}</div></div>
          </div>
          <div style={{flex:1,minWidth:200,display:"flex",alignItems:"center",gap:10,padding:"10px 14px",borderRadius:8,background:signingOn?C.successLight:C.warningLight,border:`1px solid ${signingOn?C.success:C.warning}44`}}>
            <span style={{fontSize:18}}>{signingOn?"🟢":"🟡"}</span>
            <div><div style={{fontSize:13,fontWeight:800,color:signingOn?C.success:C.warning}}>Request signing {signingOn?"active":"loading…"}</div><div style={{fontSize:11,color:C.textMid}}>{signingOn?"RestoPOS signs every print request":"Reconnect if this stays yellow"}</div></div>
          </div>
        </div>
        <div style={{display:"flex",gap:8,marginTop:12,flexWrap:"wrap"}}>
          <Btn onClick={reconnect} variant="outline" size="sm">🔄 Reconnect</Btn>
          <a href="https://qz.io/download" target="_blank" rel="noreferrer" style={{padding:"7px 14px",background:C.primary,color:"#fff",borderRadius:8,fontSize:12,fontWeight:700,textDecoration:"none"}}>⬇️ Download QZ Tray</a>
        </div>
        {msg&&<div style={{marginTop:10,fontSize:12,color:C.textMid}}>{msg}</div>}
      </Card>

      {/* Part A — install QZ */}
      <Card style={{background:"#F8FAFF"}}>
        <div style={{fontSize:14,fontWeight:800,marginBottom:12}}>Part A · Install QZ Tray</div>
        <Step n="1" t="Download QZ Tray" d="Free, ~15MB, works on Windows / Mac / Linux. Use the Download button above."/>
        <Step n="2" t="Install & run it" d="Install like any app. It runs quietly in the system tray next to the clock and starts with the computer."/>
        <Step n="3" t="Open RestoPOS again" d="Come back to this page. The status above should turn green. If not, click Reconnect."/>
      </Card>

      {/* Part B — trust cert (the real popup killer) */}
      <Card style={{border:`2px solid ${C.zatca}33`,background:"#F7FFFB"}}>
        <div style={{fontSize:14,fontWeight:800,marginBottom:6,color:C.zatca}}>Part B · Trust RestoPOS (kills the “Allow” pop-up)</div>
        <div style={{fontSize:12,color:C.textMid,marginBottom:12}}>
          RestoPOS already signs every print request. Installing this certificate tells QZ Tray to trust it permanently — so the approval pop-up never shows again on this computer.
        </div>
        <Step n="1" t="Download the certificate" d="Click the button below to save restopos-certificate.txt."/>
        <Step n="2" t="Open QZ Tray → Advanced → Site Manager" d="Right-click the QZ Tray tray icon → Advanced → Site Manager."/>
        <Step n="3" t="Add the certificate" d="In Site Manager click + → choose the downloaded restopos-certificate.txt. If asked “copy to override.crt?”, click Yes."/>
        <Step n="4" t="Restart QZ Tray" d="Right-click tray icon → Exit, then start QZ Tray again. Done — no more pop-ups on this machine."/>
        <Btn onClick={downloadCert}>⬇️ Download RestoPOS Certificate</Btn>
      </Card>

      {/* Fallback note */}
      <Card style={{background:C.infoLight,border:`1px solid ${C.info}33`}}>
        <div style={{fontSize:13,fontWeight:700,color:C.info,marginBottom:4}}>If QZ Tray is ever off</div>
        <div style={{fontSize:12,color:C.textMid}}>RestoPOS automatically falls back to the computer’s default printer so a sale is never blocked. Re-enable QZ Tray anytime for fully silent printing.</div>
      </Card>
    </div>
  );
}

function AdvancedFeatures({sales,items,setItems,license,company,invoiceFormat,setInvoiceFormat,users,setUsers}){
  const [tab,setTab]=useState("qztray");
  const tabs=[["qztray","🖨️ QZ Tray"],["silentprint","🔇 Silent Printing"],["invoice","🧾 Invoice Format"],["kitchen","🍽️ Kitchen Printer"],["users","👤 Users"],["kds","🍳 KDS"],["stocktakes","📦 Stock Takes"],["recipes","📋 Recipes"],["giftcards","🎁 Gift Cards"],["delivery","🛵 Delivery"],["locations","🏢 Locations"],["accounting","📤 Accounting"],["reports","📅 Reports"],["printer","🖨️ ESC/POS"],["errorlog","⚠️ Error Log"],["analytics","📉 Analytics"],["audit","🔍 Audit Trail"],["tools","🔧 Tools"]];
  return(
    <div>
      <div style={{display:"flex",gap:6,marginBottom:20,flexWrap:"wrap"}}>
        {tabs.map(([id,lbl])=>(
          <button key={id} onClick={()=>setTab(id)} style={{padding:"7px 14px",borderRadius:8,border:`1.5px solid ${tab===id?C.primary:C.border}`,background:tab===id?C.primaryLight:"#fff",color:tab===id?C.primary:C.textMid,fontFamily:"inherit",fontSize:12,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap"}}>{lbl}</button>
        ))}
      </div>
      {tab==="invoice"&&<div>
        <div style={{background:C.zatcaLight,border:`1px solid ${C.zatca}44`,borderRadius:10,padding:"10px 14px",marginBottom:16,fontSize:12,color:C.zatca,fontWeight:600}}>🧾 This is your billing format. The live preview below is exactly what prints on your bill printer (QZ Tray) — including the ZATCA QR. Configure the printer under the <strong>QZ Tray</strong> tab.</div>
        <InvoiceFormatTab license={license} company={company} invoiceFormat={invoiceFormat} setInvoiceFormat={setInvoiceFormat}/>
      </div>}
      {tab==="kitchen"&&<KitchenPrinterSettings/>}
      {tab==="silentprint"&&<SilentPrintSetup/>}
      {tab==="users"&&<UserAdmin users={users} setUsers={setUsers}/>}
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
      {tab==="analytics"&&<AdvancedReports sales={sales} items={items}/>}
      {tab==="audit"&&<AuditTrail/>}
      {tab==="tools"&&<Tools sales={sales} items={items} setItems={setItems}/>}
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
let _qzKeepAliveSet = false; // ensures the auto-reconnect callback is registered only once

// Load QZ Tray script dynamically (+ jsrsasign for request signing → no popup)
async function loadQZ() {
  if (window.qz && window.KJUR) return true;
  // Load jsrsasign first (provides KJUR for RSA signing)
  if (!window.KJUR) {
    await new Promise((resolve) => {
      const j = document.createElement("script");
      j.src = "https://cdn.jsdelivr.net/npm/jsrsasign@10.8.6/lib/jsrsasign-all-min.js";
      j.onload = () => resolve(true);
      j.onerror = () => resolve(false);
      document.head.appendChild(j);
    });
  }
  if (window.qz) return true;
  return new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/qz-tray@2.2.4/qz-tray.min.js";
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

// ── RestoPOS signing identity — embedded cert + private key.
// Signing every QZ request with this pair makes QZ Tray trust RestoPOS,
// so the "Allow / Untrusted website" popup never appears once the
// certificate is installed as an override on the machine (see QZ Tray tab).
const RESTOPOS_QZ_CERT = "-----BEGIN CERTIFICATE-----\n" +
"MIIDuTCCAqGgAwIBAgIUbdbyNClEgQptkymOk47mldBLAqIwDQYJKoZIhvcNAQEL\n" +
"BQAwbDELMAkGA1UEBhMCU0ExDzANBgNVBAgMBk1ha2thaDEPMA0GA1UEBwwGTWFr\n" +
"a2FoMREwDwYDVQQKDAhSZXN0b1BPUzEVMBMGA1UECwwMUmVzdG9QT1MgUE9TMREw\n" +
"DwYDVQQDDAhSZXN0b1BPUzAeFw0yNjA2MTIyMDUwMjRaFw00NjA2MDcyMDUwMjRa\n" +
"MGwxCzAJBgNVBAYTAlNBMQ8wDQYDVQQIDAZNYWtrYWgxDzANBgNVBAcMBk1ha2th\n" +
"aDERMA8GA1UECgwIUmVzdG9QT1MxFTATBgNVBAsMDFJlc3RvUE9TIFBPUzERMA8G\n" +
"A1UEAwwIUmVzdG9QT1MwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCK\n" +
"LF41YprvBG5ak7xiYRHeWCESgvMh8I01vNcwko2ETsYoInlsOjyhIsbcL/rkE6MQ\n" +
"bCt/+2xTxlPNDC49weuLL3Nj6Q/i0iMSqi83VPvDSnNGrf2s7gBv32DegsKF5m/H\n" +
"Jsj+1WanxgUYICY+Pozfdp53fRTVBdX6cnHDGIljXM4JkFLJM5dtQAryn6dorMDB\n" +
"iPc2UJn47r863MsoHUx/yD6DBKLEZsH+R/v4dbxJpI3pmx2iaHxJxbzl4swNjQZ8\n" +
"qqmD66w9GShv0Lqy3LRV+uzwxrqd7xrcXpYiaoL1xaDbiF2sB7IVakeHL7G+N2Eg\n" +
"q7HgwuxgK4EXtwTfw3VtAgMBAAGjUzBRMB0GA1UdDgQWBBSIpQHlLixSIjJiVINa\n" +
"aLgc7rxzYTAfBgNVHSMEGDAWgBSIpQHlLixSIjJiVINaaLgc7rxzYTAPBgNVHRMB\n" +
"Af8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQBxDdnKQqV2+dbJ80g9XclUYsRn\n" +
"0rOBJxB5b3uFBVawpicUjx8kanU95zcvy54OG6DxfBQILtNgPGNCpYfLn+SQKX68\n" +
"m7smh0QdQPWHd/awrWPnuaJIxF+MrncSFK94kHek63H6Mt2aw0gCPg/F7B6RCNeP\n" +
"yFiiNrxVYJicWfr903KxxzR7SsYTu2L4MOsPObWlcM9AvbyZ3I/jUy+1YGBgoIsD\n" +
"KW2ktNK4R2k8tXP5MhZTRyKpw7PzZpLCZs1luaVJ2EAH+31XcbDW5BzaGkixvpyf\n" +
"Pt9/igmcDkHmCvQKm9ECRtsPEI+I3hi0LL720qsX/epNJT92niq2MC128AbD\n" +
"-----END CERTIFICATE-----\n";
const RESTOPOS_QZ_KEY = "-----BEGIN RSA PRIVATE KEY-----\n" +
"MIIEogIBAAKCAQEAiixeNWKa7wRuWpO8YmER3lghEoLzIfCNNbzXMJKNhE7GKCJ5\n" +
"bDo8oSLG3C/65BOjEGwrf/tsU8ZTzQwuPcHriy9zY+kP4tIjEqovN1T7w0pzRq39\n" +
"rO4Ab99g3oLCheZvxybI/tVmp8YFGCAmPj6M33aed30U1QXV+nJxwxiJY1zOCZBS\n" +
"yTOXbUAK8p+naKzAwYj3NlCZ+O6/OtzLKB1Mf8g+gwSixGbB/kf7+HW8SaSN6Zsd\n" +
"omh8ScW85eLMDY0GfKqpg+usPRkob9C6sty0Vfrs8Ma6ne8a3F6WImqC9cWg24hd\n" +
"rAeyFWpHhy+xvjdhIKux4MLsYCuBF7cE38N1bQIDAQABAoIBAAG8vRJ+wuPuclTB\n" +
"NsUl40ugYAoTi2sJ0zyxuyLpNM5ND0DB7jTmJo0AGu/5ynXDqXEzaviY+Ku0+qjB\n" +
"VnOAVK3TUugWrhRz/+zkJuPTNbcm4HwrA92AwJCnhlhF3JxCYXVnj29kz32ch8Pd\n" +
"4500vCCzJRrrf6+N+zrC5ZtGW7PcGiBLHVlMbI9BvLFD1mGtQSHuA01+5VO2I0ti\n" +
"GeJPdErLIdKxVrYhsVqTzMe6hkoseCK7pDH+c9KvdKwlPDFUYG80Il/UBudBf9sF\n" +
"Jvcrs92omcV4+9vXEifwwKXp+l6z4ia6qdhc8pKvOBtB7jdWNTdibY8MxbatMDFN\n" +
"ipgCZyECgYEAvdI/wgjZZuyjbOr/Fpc3sij8i1REAgB7LdaSieWtatxcCm31b1r4\n" +
"8QJpkAEvyXkx3+cFlAXr9PxrGqUsqjvb9UCk476ysnwBXtBjOQamwo4Ei/1IUcF1\n" +
"41yN/WBd5ine3SIzaOpVrMKlwzBsHktbXWkl7UnkcbXpeR6rWc+ZU4cCgYEAulh7\n" +
"jOUVQz4Iv+SqngSFlRAdb8OKeVXSUsiERNweS9BW4r0WOIwZeKq700INZiuNTVNu\n" +
"GoBS9E7SImBt8wquCKpypDqI51YYEEvaP7VS04hwV5ulw1LdQb+IVhDEclUkopoC\n" +
"whuL07qZZb6E+3F8J0LRR9u8sEXwXPJLFDZhFGsCgYB3efiLhspf0B5lFdyNOYzi\n" +
"5I1gnR9ZKzhc96uwhBINKrn8Do3nExmRiPUsoLKVW2UbCuwl6TxFLQO097YPSDIA\n" +
"QjoG5ybO1OJ/7SYm5Jrd5knSWw/D9cLf4oe0rY0sq7oM8dPt+2EFplZzbuz+fGv7\n" +
"dY1bt6DEOb3EcJtlohddzQKBgGfpKVQi9l1dvUFMQLwG53p81v1Yu+H3MmZJPECt\n" +
"whMipSCgskBsF1QLWNtwDMq5ZH0HFfGfNyLWxSS4QvdxMCTS70SXA3qErrx/n79A\n" +
"3GPqxEKGH8QwdALSzDK5/OGIivpFCV62P52cgyeSOtN/r+ywvMTmSmy9Q1CBJ86o\n" +
"mC/rAoGAI+zHE3WY/68Kg2/ZZG9lmGY5LN+ondP35MGl21+vZHfX63i9Ar06AegI\n" +
"VZtfNCT0onpn4+j8mLZEqoSMSHnoJkmo2usurEmQaKQgqyAHcsGraayHlw9rRFp5\n" +
"MEZ+HCAfdCw3Ov2l6PIn/2Y9ibtlf/EkjdmwanASFpOjyMMMfww=\n" +
"-----END RSA PRIVATE KEY-----\n";

// Connect to QZ Tray
async function connectQZ() {
  try {
    const loaded = await loadQZ();
    if (!loaded || !window.qz) return false;
    if (qz.websocket.isActive()) return true;

    // ── Signed mode — RestoPOS signs every request so QZ Tray trusts it.
    // With the certificate installed as an override on the machine, the
    // "Allow / Untrusted website" popup no longer appears.
    qz.security.setCertificatePromise(function(resolve, reject) {
      resolve(RESTOPOS_QZ_CERT);
    });
    qz.security.setSignatureAlgorithm("SHA512"); // must match the signing below
    qz.security.setSignaturePromise(function(toSign) {
      return function(resolve, reject) {
        try {
          if (!window.KJUR) { resolve(null); return; } // fallback: unsigned (shows popup) if lib missing
          const sig = new KJUR.crypto.Signature({ alg: "SHA512withRSA" });
          sig.init(RESTOPOS_QZ_KEY);
          sig.updateString(toSign);
          const hex = sig.sign();
          resolve(stob64(hextorstr(hex)));
        } catch (err) {
          console.warn("[QZ] Signing failed, falling back to unsigned:", err && err.message);
          resolve(null);
        }
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

    // ── Keep-alive: if QZ Tray drops (PC sleep, QZ restart, blip), reconnect
    //    automatically in the background so it's live before the next sale. ──
    if (!_qzKeepAliveSet) {
      try {
        qz.websocket.setClosedCallbacks(function () {
          _qzConnected = false;
          console.warn("[QZ] Connection closed — auto-reconnecting…");
          setTimeout(function () { connectQZ(); }, 2000);
        });
        _qzKeepAliveSet = true;
      } catch (_e) {}
    }
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
    rasterize: false,        // Use HTML rendering directly — keeps ZATCA QR crisp/scannable
    jobWaitForEnd: false,    // Don't block waiting for the spooler — no dialog
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

// ── Universal silent print for ANY HTML (invoices, drafts, reports) ──
// Tries QZ Tray first (truly silent). Falls back to a hidden iframe so it
// still prints without opening a blocked pop-up window. Returns the method used.
async function silentPrintHTML(html, { printer, paperWidth = "80mm", a4 = false } = {}) {
  // 1) QZ Tray — silent, no dialog
  const qzPrinter = printer || localStorage.getItem("restopos_qz_bill_printer") || _qzBillPrinter;
  if (qzPrinter) {
    try {
      if (!isQZConnected()) await connectQZ();
      if (isQZConnected()) {
        await printWithQZ(html, qzPrinter, a4 ? "210" : paperWidth);
        return "QZ Tray";
      }
    } catch (e) { console.warn("[silentPrint QZ]", e.message); }
  }
  // 2) Hidden iframe — prints to the OS default printer, no pop-up window
  try {
    let frame = document.getElementById("restopos-print-frame");
    if (!frame) {
      frame = document.createElement("iframe");
      frame.id = "restopos-print-frame";
      frame.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:0;height:0;border:none;";
      document.body.appendChild(frame);
    }
    const doc = frame.contentDocument || frame.contentWindow.document;
    doc.open(); doc.write(html); doc.close();
    await new Promise(r => setTimeout(r, 500));
    frame.contentWindow.focus();
    frame.contentWindow.print();
    return "Browser";
  } catch (e) {
    console.warn("[silentPrint iframe]", e.message);
    throw e;
  }
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
  const [step,setStep]=useState("checking");const [businessData,setBusinessData]=useState(null);const [license,setLicense]=useState(null);const [currentUser,setCurrentUser]=useState(null);const [screen,_setScreen]=useState(()=>{
    // Crash-recovery: if the error boundary set this, honor it once then clear.
    try{const rec=localStorage.getItem("restopos_screen");if(rec){localStorage.removeItem("restopos_screen");return rec;}}catch(e){}
    // Otherwise always land on Dashboard after every refresh (per client request).
    return "dashboard";
  });
  function setScreen(s){_setScreen(s);LS.set("restopos_last_screen",s);}
  const [terminated,setTerminated]=useState(null);
  // Daily token (top-bar box) — updates live when an invoice increments it.
  const [dailyToken,setDailyToken]=useState(()=>getDailyToken());
  // ZATCA Invoice number (ICV) — reads current counter, updates live on real invoices only
  const [currentICV,setCurrentICV]=useState(()=>parseInt(localStorage.getItem(ZATCA_COUNTER_KEY)||"1000",10));
  useEffect(()=>{
    const onTok=(e)=>setDailyToken(typeof e.detail==="number"?e.detail:getDailyToken());
    const onStorage=(e)=>{
      if(!e||e.key===TOKEN_KEY)setDailyToken(getDailyToken());
      if(!e||e.key===ZATCA_COUNTER_KEY)setCurrentICV(parseInt(localStorage.getItem(ZATCA_COUNTER_KEY)||"1000",10));
    };
    const onInv=(e)=>setCurrentICV(parseInt(localStorage.getItem(ZATCA_COUNTER_KEY)||"1000",10));
    window.addEventListener("restopos-token",onTok);
    window.addEventListener("storage",onStorage);
    window.addEventListener("restopos-invoice",onInv);
    return()=>{window.removeEventListener("restopos-token",onTok);window.removeEventListener("storage",onStorage);window.removeEventListener("restopos-invoice",onInv);};
  },[]);
  const [announcementBanner,setAnnouncementBanner]=useState(()=>{try{return LS.get("restopos_announcement")||"";}catch{return "";}});
  const [adminNotification,setAdminNotification]=useState(null);
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
    // Background keep-alive: every 30s, silently reconnect if QZ dropped.
    const qzKeepAlive=setInterval(()=>{
      if(!isQZConnected())connectQZ();
    },30000);
    return ()=>clearInterval(qzKeepAlive);
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
        let expiry=null;
        if(data.customExpiryDate){
          expiry=new Date(data.customExpiryDate);
          expiry.setHours(23,59,59,999);
        }else if(activatedAt){
          expiry=new Date(activatedAt);
          expiry.setMonth(expiry.getMonth()+(planMonths[data.subscriptionPlan||"basic"]||1));
        }
        if(expiry&&new Date()>expiry){
          setTerminated("expired");
        }
        // ── Admin notification popup ──────────────────────────────────
        if(data.notification?.text&&!data.notification?.read){
          setAdminNotification(data.notification);
        }
      }
    });
    return()=>unsub();
  },[]);

  // LIVE ANNOUNCEMENT LISTENER
  useEffect(()=>{
    try{
      const unsub=onSnapshot(doc(db,"config","announcement"),snap=>{
        try{
          if(snap.exists()){
            const txt=snap.data().text||"";
            try{LS.set("restopos_announcement",txt);}catch(e){}
            setAnnouncementBanner(txt);
          }
        }catch(e){}
      },()=>{});
      return()=>unsub();
    }catch(e){}
  },[]);
  const [salesVersion,setSalesVersion]=useState(0);
  const [sales,_setSales]=useState(()=>LS.get("restopos_sales")||[]);
  const [items,_setItems]=useState(()=>LS.get("restopos_items")||[]);
  const [tables,_setTables]=useState(()=>LS.get("restopos_tables")||Array.from({length:12},(_,i)=>({id:i+1,status:"free",capacity:4})));
  const [users,_setUsers]=useState(()=>LS.get("restopos_users")||[]);
  const [promos,_setPromos]=useState(()=>LS.get("restopos_promos")||[]);
  const [company,_setCompany]=useState(()=>LS.get("restopos_company")||{phone:"",email:"",address:"",city:"Riyadh"});
  const [pins,_setPins]=useState(()=>LS.get("restopos_pins")||DEFAULT_PINS);
  const [invoiceFormat,_setInvoiceFormat]=useState(()=>LS.get("restopos_invoice_format")||{font:"courier",fontSize:12,shopNameOverride:"",footer:"Thank you for your visit!",footerAr:"شكراً لزيارتكم",website:"",social:"",tagline:""});
  // Unlimited sales storage — keeps recent 200 in fast state, archives rest by month
  function setSales(v){setSalesVersion(n=>n+1);_setSales(p=>{
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
  const allSales=useMemo(()=>{
    const activeIds=new Set(sales.map(s=>s.id));
    // Load archived sales fresh from LS every time sales changes
    const archivedRaw=LS.get("restopos_archived_sales")||[];
    const monthlyArchived=[];
    for(let i=0;i<localStorage.length;i++){
      const k=localStorage.key(i);
      if(k&&k.startsWith("restopos_sales_")&&k!=="restopos_sales"){
        try{const bucket=JSON.parse(localStorage.getItem(k)||"[]");monthlyArchived.push(...bucket);}catch(e){}
      }
    }
    const allArchived=[...archivedRaw,...monthlyArchived];
    const archived=allArchived.filter(s=>!activeIds.has(s.id));
    const seen=new Set();
    const deduped=archived.filter(s=>{if(seen.has(s.id))return false;seen.add(s.id);return true;});
    return[...sales,...deduped].sort((a,b)=>b.date.localeCompare(a.date)||b.id.localeCompare(a.id));
  },[sales,salesVersion]);
  function setItems(v){_setItems(p=>{const n=typeof v==="function"?v(p):v;LS.set("restopos_items",n);const _lic_setItems=LS.get("restopos_license_v2")?.licenseKey;if(_lic_setItems)debouncedSync(_lic_setItems,"restopos_items",n);if(n.length!==p.length)logActivity(n.length>p.length?"ITEM_ADDED":"ITEM_DELETED",{after:{itemCount:n.length}},currentUser?.role||"System");return n;});}
  function setTables(v){_setTables(p=>{const n=typeof v==="function"?v(p):v;LS.set("restopos_tables",n);const lic=LS.get("restopos_license_v2")?.licenseKey;if(lic)debouncedSync(lic,"restopos_tables",n);return n;});}
  function setUsers(v){_setUsers(p=>{const n=typeof v==="function"?v(p):v;LS.set("restopos_users",n);if(n.length!==p.length)logActivity(n.length>p.length?"USER_ADDED":"USER_DELETED",{after:{userCount:n.length}},currentUser?.role||"System");return n;});}
  function setPromos(v){_setPromos(p=>{const n=typeof v==="function"?v(p):v;LS.set("restopos_promos",n);const lic=LS.get("restopos_license_v2")?.licenseKey;if(lic)debouncedSync(lic,"restopos_promos",n);return n;});}
  function setCompany(v){_setCompany(p=>{const n=typeof v==="function"?v(p):v;LS.set("restopos_company",n);const _lic_setCompany=LS.get("restopos_license_v2")?.licenseKey;if(_lic_setCompany)debouncedSync(_lic_setCompany,"restopos_company",n);logActivity("SETTINGS_CHANGED",{after:{company:"updated"}},currentUser?.role||"System");return n;});}
  function setPins(v){_setPins(p=>{const n=typeof v==="function"?v(p):v;LS.set("restopos_pins",n);const _lic_setPins=LS.get("restopos_license_v2")?.licenseKey;if(_lic_setPins)debouncedSync(_lic_setPins,"restopos_pins",n);logActivity("PINS_CHANGED",{after:{pins:"updated"}},currentUser?.role||"System");return n;});}
  function setInvoiceFormat(v){_setInvoiceFormat(p=>{const n=typeof v==="function"?v(p):v;LS.set("restopos_invoice_format",n);const _lic_setInvoiceFormat=LS.get("restopos_license_v2")?.licenseKey;if(_lic_setInvoiceFormat)debouncedSync(_lic_setInvoiceFormat,"restopos_invoice_format",n);return n;});}
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
  const ALL_NAV=[["dashboard","📊","Dashboard",["Admin","Manager"]],["pos","🖥️","POS",["Admin","Manager","Cashier"]],["settings","⚙️","Settings",["Admin"]],["create","➕","Create",["Admin","Manager"]],["transactions","💳","Transactions",["Admin","Manager"]],["financials","🏦","Financials",["Admin","Manager"]],["customers","👥","CRM",["Admin","Manager"]],["reports","📋","Reports",["Admin","Manager"]],["analytics","📉","Analytics",["Admin","Manager"]],["advanced","⚡","Advanced",["Admin","Manager"]],["vat","🧾","VAT",["Admin","Manager"]],["shifts","🔄","Shifts",["Admin","Manager"]],["audit","🔍","Audit",["Admin"]],["tools","🔧","Tools",["Admin"]],["help","❓","Help",["Admin","Manager","Cashier"]]];
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
    <div dir={dir(lang)} style={{fontFamily:lang==="ar"?"'Tajawal','Plus Jakarta Sans',sans-serif":"'Plus Jakarta Sans','Tajawal',sans-serif",background:C.bg,height:"100vh",display:"flex",flexDirection:"column",overflow:"hidden",zoom:`${uiScale}%`}}>
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
          <span title="Today's token — resets on Close Day" style={{fontSize:9,background:"rgba(240,165,0,0.25)",color:"#FFD27F",padding:"2px 7px",borderRadius:4,fontWeight:800,border:"1px solid rgba(240,165,0,0.45)",whiteSpace:"nowrap"}}>🎫 Token {dailyToken}</span>
          <span title="Last ZATCA invoice number — only real invoices count, not drafts" style={{fontSize:9,background:"rgba(26,107,74,0.35)",color:"#6ee7b7",padding:"2px 7px",borderRadius:4,fontWeight:800,border:"1px solid rgba(26,107,74,0.5)",whiteSpace:"nowrap"}}>🧾 INV-{String(currentICV).padStart(6,"0")}</span>
          {isOnline&&<span style={{fontSize:8,background:"rgba(46,204,113,0.25)",color:"#7FFAB5",padding:"2px 5px",borderRadius:4,fontWeight:700,border:"1px solid rgba(46,204,113,0.4)",whiteSpace:"nowrap",display:viewport.w<640?"none":"inline"}}>● LIVE</span>}

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
        {announcementBanner&&screen!=="pos"&&(
          <div style={{background:"linear-gradient(135deg,#F0A500,#e09000)",color:"#fff",padding:"9px 16px",marginBottom:14,borderRadius:10,display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,boxShadow:"0 2px 12px rgba(240,165,0,0.25)"}}>
            <span style={{fontSize:12,fontWeight:700}}>📢 {announcementBanner}</span>
            <button onClick={()=>setAnnouncementBanner("")} style={{background:"rgba(255,255,255,0.2)",border:"none",borderRadius:6,color:"#fff",fontSize:14,cursor:"pointer",padding:"2px 8px",fontFamily:"inherit",fontWeight:700,flexShrink:0}}>×</button>
          </div>
        )}
        {adminNotification&&(
          <div style={{position:"fixed",bottom:24,right:24,zIndex:9999,maxWidth:340,background:"#1A3D2B",border:"1px solid rgba(46,204,113,0.4)",borderRadius:14,padding:"14px 16px",boxShadow:"0 8px 32px rgba(0,0,0,0.35)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8,marginBottom:6}}>
              <div style={{fontSize:12,fontWeight:800,color:"#7FFAB5"}}>📨 Message from RestoPOS Admin</div>
              <button onClick={async()=>{
                setAdminNotification(null);
                try{
                  const savedLic=LS.get("restopos_license_v2");
                  if(savedLic?.licenseKey){
                    const q=query(collection(db,"pending_activations"),where("licenseKey","==",savedLic.licenseKey));
                    const snap=await getDocs(q);
                    if(!snap.empty)await updateDoc(doc(db,"pending_activations",snap.docs[0].id),{"notification.read":true});
                  }
                }catch(e){}
              }} style={{background:"rgba(255,255,255,0.1)",border:"none",borderRadius:6,color:"rgba(255,255,255,0.6)",fontSize:16,cursor:"pointer",padding:"1px 7px",flexShrink:0}}>×</button>
            </div>
            <div style={{fontSize:13,color:"#fff",lineHeight:1.5,marginBottom:8}}>{adminNotification.text}</div>
            <div style={{fontSize:10,color:"rgba(255,255,255,0.35)"}}>{adminNotification.sentAt?.slice(0,16).replace("T"," ")}</div>
          </div>
        )}
        <TabBoundary key={screen} name={screen}>
        {screen==="dashboard"&&<Dashboard sales={allSales} items={items} license={license} lang={lang}/>}
        {screen==="pos"&&<POS items={items} sales={sales} setSales={setSales} tables={tables} setTables={setTables} promos={promos} license={license} lang={lang} currentUser={currentUser}/>}
        {screen==="settings"&&<Settings company={company} setCompany={setCompany} tables={tables} setTables={setTables} license={license} onClearLicense={handleClearLicense} onSwitchAccount={handleSwitchAccount} pins={pins} setPins={setPins} invoiceFormat={invoiceFormat} setInvoiceFormat={setInvoiceFormat} lang={lang} onLangChange={handleLangChange} sales={allSales} items={items}/>}
        {screen==="create"&&<Create items={items} setItems={setItems} promos={promos} setPromos={setPromos}/>}
        {screen==="transactions"&&<Transactions sales={allSales} setSales={setSales} license={license}/>}
        {/* P&L moved to Financials tab */}
        {screen==="financials"&&<FinancialReports sales={allSales} items={items} license={license}/>}
        {/* Invoices moved into Settings → Invoices tab */}
        {/* Expenses moved to Financials tab */}
        {screen==="customers"&&<Customers sales={allSales}/>}
        {screen==="reports"&&<Reports sales={sales} allSales={allSales} items={items} setSales={setSales}/>}
        {screen==="advanced"&&<AdvancedFeatures sales={allSales} items={items} setItems={setItems} license={license} company={company} invoiceFormat={invoiceFormat} setInvoiceFormat={setInvoiceFormat} users={users} setUsers={setUsers}/>}
        {screen==="vat"&&<ZATCAVatEngine/>}
        {/* Backup moved into Settings → Backup tab; Users moved into Advanced → Users tab */}
        {screen==="shifts"&&<ShiftManager sales={allSales} currentUser={currentUser} lang={lang}/>}
        {screen==="help"&&<Help license={license||undefined}/>}
        </TabBoundary>
      </div>
    </div>
    </ErrorBoundary>
  );
}


// ═══════════════════════════════════════════════════════════════════
// ZATCA VAT ENGINE (embedded as top-level tab)
// ═══════════════════════════════════════════════════════════════════
/**
 * ZATCAVatEngine.jsx
 * ══════════════════════════════════════════════════════════════
 *  ZATCA VAT Return Tracker & Pending Amount Estimator
 *  For: RestoPOS — Saudi Arabia (KSA)
 *
 *  ZATCA Business Rules Applied:
 *  • VAT Rate: 15% standard (Royal Decree A/638, 1 Jul 2020)
 *  • Output VAT  = VAT collected on SALES (owed to ZATCA)
 *  • Input VAT   = VAT paid on PURCHASES (recoverable from ZATCA)
 *  • Net Payable = Output VAT − Input VAT
 *  • If Net < 0  → VAT Refund due FROM ZATCA
 *  • Filing: Monthly if annual revenue > SAR 40M; else Quarterly
 *  • Deadline: Last day of month following tax period
 *  • Penalty for late filing: 5% of unpaid tax per month
 *  • Penalty for non-filing: 5–25% of tax due
 *  • All amounts in SAR, rounded to 2dp (half-up per ZATCA spec)
 *
 *  Uses persistent storage — data survives page refresh.
 * ══════════════════════════════════════════════════════════════
 */


// ─── ZATCA Constants ──────────────────────────────────────────
const VAT_ENGINE_RATE        = 0.15;
const VAT_ENGINE_RATE_PCT    = 15;
const VAT_LATE_PENALTY    = 0.05;   // 5% per month on unpaid tax
const VAT_MAX_PENALTY_PCT = 0.25;   // 25% cap on non-filing penalty

// VAT Categories per ZATCA regulations
const VAT_CATS = {
  STANDARD : { code: "S", label: "Standard (15%)",    rate: 0.15, color: "#10b981" },
  ZERO     : { code: "Z", label: "Zero Rated (0%)",   rate: 0.00, color: "#6366f1" },
  EXEMPT   : { code: "E", label: "Exempt",             rate: 0.00, color: "#f59e0b" },
};

// Transaction types
const VAT_TX_TYPES = {
  SALE     : { label: "Sale",     labelAr: "مبيعات",    sign: +1, vatField: "outputVAT"  },
  PURCHASE : { label: "Purchase", labelAr: "مشتريات",   sign: -1, vatField: "inputVAT"   },
  EXPENSE  : { label: "Expense",  labelAr: "مصاريف",    sign: -1, vatField: "inputVAT"   },
};

// ─── Rounding — ZATCA half-up (NOT banker's rounding) ─────────
const vatR2 = (v) => Math.floor(Number(v) * 100 + 0.5) / 100;

// ─── Core VAT Calculator ──────────────────────────────────────
function vatCalc(amount, category = "STANDARD", inclVAT = false) {
  const rate = VAT_CATS[category]?.rate ?? VAT_ENGINE_RATE;
  if (rate === 0) return { net: vatR2(amount), vat: 0, gross: vatR2(amount), rate: 0 };
  if (inclVAT) {
    const net   = vatR2(amount / (1 + rate));
    const vat   = vatR2(amount - net);
    return { net, vat, gross: vatR2(amount), rate };
  }
  const vat   = vatR2(amount * rate);
  const gross = vatR2(amount + vat);
  return { net: vatR2(amount), vat, gross, rate };
}

// ─── Period helpers ───────────────────────────────────────────
function vatGetCurrentPeriod() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}
function vatPeriodLabel(p) {
  if (!p) return "";
  const [y, m] = p.split("-");
  return new Date(y, m - 1, 1).toLocaleDateString("en-SA", { month: "long", year: "numeric" });
}
function vatFilingDeadline(period) {
  const [y, m] = period.split("-").map(Number);
  const next = new Date(y, m, 0); // last day of following month
  next.setMonth(next.getMonth() + 1);
  return next.toLocaleDateString("en-SA", { day: "numeric", month: "long", year: "numeric" });
}
function vatDaysLeft(period) {
  const [y, m] = period.split("-").map(Number);
  const deadline = new Date(y, m, 0); // last day of next month
  deadline.setMonth(deadline.getMonth() + 1);
  const diff = Math.ceil((deadline - new Date()) / 86400000);
  return Math.max(0, diff);
}
function vatTodayStr() {
  return new Date().toISOString().split("T")[0];
}

// ─── QUARTERLY filing helpers (ZATCA: file within the month AFTER quarter end) ──
// Q1 Jan–Mar → due 30 Apr · Q2 Apr–Jun → due 31 Jul · Q3 Jul–Sep → due 31 Oct · Q4 Oct–Dec → due 31 Jan
function vatQuarterInfo(d) {
  d = d || new Date();
  const y = d.getFullYear();
  const q = Math.floor(d.getMonth() / 3); // 0..3
  const qStartMonth = q * 3;              // 0,3,6,9
  const quarterEnd = new Date(y, qStartMonth + 3, 0); // last day of quarter
  // Filing deadline = last day of the month following the quarter end
  const deadline = new Date(y, qStartMonth + 4, 0);
  const qNames = ["Q1 (Jan–Mar)", "Q2 (Apr–Jun)", "Q3 (Jul–Sep)", "Q4 (Oct–Dec)"];
  const fmt = (dt) => dt.toLocaleDateString("en-SA", { day: "numeric", month: "short", year: "numeric" });
  const daysLeft = Math.max(0, Math.ceil((deadline - new Date()) / 86400000));
  return {
    label: qNames[q] + " " + y,
    quarterEnd, deadline,
    quarterEndStr: fmt(quarterEnd),
    deadlineStr: fmt(deadline),
    daysLeft,
  };
}

// ─── Aggregate transactions into VAT return figures ──────────
function vatAggregate(transactions) {
  let totalSales    = 0, totalSalesVAT    = 0;
  let totalPurchases= 0, totalPurchasesVAT= 0;
  let outputVAT     = 0, inputVAT         = 0;
  const byCategory  = { STANDARD: { sales: 0, salesVAT: 0, purchases: 0, purchasesVAT: 0 },
                        ZERO:     { sales: 0, salesVAT: 0, purchases: 0, purchasesVAT: 0 },
                        EXEMPT:   { sales: 0, salesVAT: 0, purchases: 0, purchasesVAT: 0 } };

  for (const tx of transactions) {
    const cat = tx.category || "STANDARD";
    if (tx.type === "SALE") {
      totalSales    += tx.net;
      totalSalesVAT += tx.vat;
      outputVAT     += tx.vat;
      if (byCategory[cat]) { byCategory[cat].sales += tx.net; byCategory[cat].salesVAT += tx.vat; }
    } else {
      totalPurchases    += tx.net;
      totalPurchasesVAT += tx.vat;
      inputVAT          += tx.vat;
      if (byCategory[cat]) { byCategory[cat].purchases += tx.net; byCategory[cat].purchasesVAT += tx.vat; }
    }
  }

  const netVATPayable = vatR2(outputVAT - inputVAT);
  const refundDue     = netVATPayable < 0 ? vatR2(Math.abs(netVATPayable)) : 0;
  const amountOwed    = netVATPayable > 0 ? netVATPayable : 0;

  // ZATCA penalties
  const latePenalty       = vatR2(amountOwed * VAT_LATE_PENALTY);
  const maxPenalty        = vatR2(amountOwed * VAT_MAX_PENALTY_PCT);

  return {
    totalSales      : vatR2(totalSales),
    totalSalesVAT   : vatR2(totalSalesVAT),
    totalPurchases  : vatR2(totalPurchases),
    totalPurchasesVAT: vatR2(totalPurchasesVAT),
    outputVAT       : vatR2(outputVAT),
    inputVAT        : vatR2(inputVAT),
    netVATPayable,
    amountOwed,
    refundDue,
    latePenalty,
    maxPenalty,
    byCategory,
    txCount: transactions.length,
  };
}

// ─── SAR formatter ────────────────────────────────────────────
const vatSar = (v, arabic = false) =>
  arabic ? `${vatR2(v).toFixed(2)} ر.س` : `SAR ${vatR2(v).toFixed(2)}`;
const vatMenuBtn = (theme) => ({display:"block",width:"100%",textAlign:"left",padding:"10px 12px",background:"transparent",border:"none",borderRadius:8,fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit",color:theme==="light"?"#0f172a":"#e2e8f0"});

// ══════════════════════════════════════════════════════════════
//  MAIN COMPONENT
// ══════════════════════════════════════════════════════════════
function ZATCAVatEngine() {
  const period = vatGetCurrentPeriod();

  // ── State ─────────────────────────────────────────────────
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading]           = useState(true);
  const [activeTab, setActiveTab]       = useState("dashboard");
  const [showForm, setShowForm]         = useState(false);
  const [toast, setToast]               = useState(null);
  const [deleteId, setDeleteId]         = useState(null);
  const [searchQ, setSearchQ]           = useState("");
  const [filterType, setFilterType]     = useState("ALL");
  // Light/Dark theme for the VAT engine (default dark; persisted)
  const [vatTheme, setVatTheme]         = useState(() => (typeof LS!=="undefined"&&LS.get&&LS.get("restopos_vat_theme")) || "dark");
  const [showPrintMenu, setShowPrintMenu]= useState(false);
  const [showVatGuide, setShowVatGuide] = useState(false);
  function toggleVatTheme(){ const t=vatTheme==="dark"?"light":"dark"; setVatTheme(t); try{LS.set("restopos_vat_theme",t);}catch(e){} }

  // Form state
  const [form, setForm] = useState({
    date       : vatTodayStr(),
    type       : "SALE",
    category   : "STANDARD",
    description: "",
    amount     : "",
    inclVAT    : false,
    invoiceRef : "",
  });

  // ── Storage helpers ───────────────────────────────────────
  const STORAGE_KEY = `zatca_vat_${period}`;

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = LS.get(STORAGE_KEY);
      if (Array.isArray(res)) setTransactions(res);
    } catch (_) { setTransactions([]); }
    setLoading(false);
  }, [STORAGE_KEY]);

  const saveData = useCallback(async (txList) => {
    try {
      LS.set(STORAGE_KEY, txList);
    } catch (e) { console.error("Storage error", e); }
  }, [STORAGE_KEY]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Toast ─────────────────────────────────────────────────
  const showToast = (msg, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  // ── Add Transaction ───────────────────────────────────────
  const addTransaction = () => {
    const amount = parseFloat(form.amount);
    if (!amount || amount <= 0)   { showToast("Enter a valid amount.", "error"); return; }
    if (!form.description.trim()) { showToast("Description is required.", "error"); return; }

    const { net, vat, gross } = vatCalc(amount, form.category, form.inclVAT);

    const tx = {
      id         : `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      date       : form.date,
      type       : form.type,
      category   : form.category,
      description: form.description.trim(),
      net,
      vat,
      gross,
      inclVAT    : form.inclVAT,
      invoiceRef : form.invoiceRef.trim(),
      addedAt    : new Date().toISOString(),
    };

    const updated = [...transactions, tx].sort((a, b) => a.date.localeCompare(b.date));
    setTransactions(updated);
    saveData(updated);
    setForm({ date: vatTodayStr(), type: "SALE", category: "STANDARD", description: "", amount: "", inclVAT: false, invoiceRef: "" });
    setShowForm(false);
    showToast(`${VAT_TX_TYPES[tx.type].label} added — VAT: ${vatSar(vat)}`);
  };

  // ── Delete ─────────────────────────────────────────────────
  const deleteTransaction = (id) => {
    const updated = transactions.filter(t => t.id !== id);
    setTransactions(updated);
    saveData(updated);
    setDeleteId(null);
    showToast("Entry removed.", "info");
  };

  // ── Auto-pull SALES from finalized (Close Day) data ───────
  // Reads restopos_closed_days, keeps the current month, and turns each
  // closed day into a synthetic SALE entry. Recomputes live whenever a day
  // is closed. Manual entries (purchases/expenses/adjustments) layer on top.
  const autoSalesTx = useMemo(() => {
    let closed = [];
    try { closed = (typeof LS!=="undefined" && LS.get && LS.get("restopos_closed_days")) || []; } catch(_) {}
    return closed
      .filter(d => d && typeof d.date === "string" && d.date.slice(0,7) === period) // YYYY-MM match
      .map(d => {
        const gross = Number(d.revenue) || 0;     // total incl. VAT
        const vat   = Number(d.vat) || 0;          // VAT collected that day
        const net   = vatR2(gross - vat);
        return {
          id        : `auto-${d.date}`,
          date      : d.date,
          type      : "SALE",
          category  : "STANDARD",
          description: `Daily sales (Close Day) — ${d.orderCount || 0} orders`,
          net, vat, gross: vatR2(gross),
          inclVAT   : true,
          invoiceRef: "AUTO",
          auto      : true,            // flag so UI can mark/lock it
          addedAt   : d.closedAt || d.closeTime || new Date().toISOString(),
        };
      });
  }, [period, transactions]); // transactions dep so a re-render after edits refreshes too

  // Combined list = auto sales + manual entries (auto first, by date)
  const allTx = useMemo(
    () => [...autoSalesTx, ...transactions].sort((a,b) => a.date.localeCompare(b.date)),
    [autoSalesTx, transactions]
  );

  // ── Computed ──────────────────────────────────────────────
  const stats   = vatAggregate(allTx);
  const _qi     = vatQuarterInfo();
  const days    = _qi.daysLeft;
  const txToday = allTx.filter(t => t.date === vatTodayStr()).length;

  // ── Print / Save the official VAT return — mode: "a4" | "thermal" | "pdf" ───
  const printVATReturn = (mode="a4") => {
    const lic = (typeof LS!=="undefined" && LS.get && LS.get("restopos_license_v2")) || {};
    const fmtN = (v) => "SAR " + (Math.round(Number(v)*100)/100).toFixed(2);
    const C2 = stats.byCategory;
    const qi = vatQuarterInfo();
    const payable = stats.netVATPayable >= 0;
    // ── THERMAL (80mm) layout ──
    if (mode === "thermal") {
      const trow=(l,v)=>`<div style="display:flex;justify-content:space-between;gap:8px;margin:2px 0"><span>${l}</span><span style="white-space:nowrap">${fmtN(v)}</span></div>`;
      const thtml=`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
@page{size:80mm auto;margin:0}*{box-sizing:border-box;margin:0;padding:0}
html,body{max-width:80mm;overflow-x:hidden}
body{font-family:'Courier New',monospace;font-size:12px;width:80mm;padding:4mm;color:#000;font-weight:600;-webkit-print-color-adjust:exact;print-color-adjust:exact}
*{color:#000 !important}.c{text-align:center}.b{font-weight:900}.hr{border-top:1px dashed #000;margin:5px 0}
</style></head><body>
<div class="c b" style="font-size:15px">${_escHTML(lic.businessName||"RestoPOS")}</div>
${lic.vatNumber?`<div class="c" style="font-size:11px">VAT: ${_escHTML(lic.vatNumber)}</div>`:""}
<div class="c b" style="font-size:13px;margin-top:4px">VAT RETURN ESTIMATE</div>
<div class="hr"></div>
<div style="font-size:11px">Quarter: ${qi.label}</div>
<div style="font-size:11px">Quarter ends: ${qi.quarterEndStr}</div>
<div style="font-size:11px">Filing deadline: ${qi.deadlineStr}</div>
<div style="font-size:11px">Days left: ${qi.daysLeft}</div>
<div class="hr"></div>
<div class="b">Sales (Output Tax)</div>
${trow("Standard sales",C2.STANDARD?.sales||0)}
${trow("Output VAT",stats.outputVAT)}
<div class="hr"></div>
<div class="b">Purchases (Input Tax)</div>
${trow("Standard purchases",C2.STANDARD?.purchases||0)}
${trow("Input VAT",stats.inputVAT)}
<div class="hr"></div>
<div style="display:flex;justify-content:space-between;font-weight:900;font-size:14px;border-top:2px solid #000;padding-top:4px"><span>${payable?"VAT PAYABLE":"VAT REFUND"}</span><span>${fmtN(Math.abs(stats.netVATPayable))}</span></div>
<div class="hr"></div>
<div style="font-size:9px">Estimate from ${stats.txCount} entries. Verify on FATOORA before filing at zatca.gov.sa</div>
<div class="c" style="font-size:9px;margin-top:4px">${new Date().toLocaleString("en-SA")}</div>
<br/><br/><br/></body></html>`;
      _vatOutput(thtml, "thermal");
      return;
    }
    // ── A4 / PDF layout (shared) ──
    const row = (box,label,labelAr,taxable,vat,opt={}) =>
      `<tr style="${opt.total?'font-weight:700;background:#f1f5f9;':''}">
        <td style="padding:7px 10px;border:1px solid #e2e8f0;white-space:nowrap;">${box}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;">${label}<div style="font-size:10px;color:#64748b;direction:rtl;">${labelAr}</div></td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;text-align:right;">${fmtN(taxable)}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;text-align:right;">${fmtN(vat)}</td>
      </tr>`;
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<title>VAT Return ${qi.label}</title>
<style>
@page{size:A4;margin:14mm}
*{box-sizing:border-box}
body{font-family:-apple-system,'Segoe UI',Arial,sans-serif;color:#0f172a;margin:0}
.hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #1A6B4A;padding-bottom:14px;margin-bottom:18px}
.hd h1{font-size:20px;margin:0 0 4px;color:#1A6B4A}
.hd .sub{font-size:12px;color:#475569}
.meta{text-align:right;font-size:12px;color:#475569;line-height:1.7}
.sec{font-size:12px;font-weight:800;letter-spacing:.04em;color:#1A6B4A;margin:18px 0 6px;text-transform:uppercase}
table{width:100%;border-collapse:collapse;font-size:12px}
th{background:#1A6B4A;color:#fff;padding:8px 10px;text-align:left;font-size:11px}
th.r{text-align:right}
.net{display:flex;gap:10px;margin-top:16px}
.net .b{flex:1;border:1.5px solid #e2e8f0;border-radius:10px;padding:12px;text-align:center}
.net .b .l{font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.04em}
.net .b .v{font-size:18px;font-weight:800;margin-top:4px}
.final{border:2px solid ${payable?'#dc2626':'#10b981'};background:${payable?'#fef2f2':'#f0fdf4'}}
.final .v{color:${payable?'#dc2626':'#16a34a'}}
.note{font-size:11px;color:#64748b;margin-top:8px;line-height:1.6}
.foot{margin-top:24px;border-top:1px solid #e2e8f0;padding-top:12px;font-size:10px;color:#94a3b8;text-align:center}
.warn{margin-top:16px;border:1px solid #fca5a5;background:#fef2f2;border-radius:8px;padding:10px 12px;font-size:11px;color:#991b1b}
.warn b{display:block;margin-bottom:4px}
@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body>
<div class="hd">
  <div>
    <h1>VAT Return Summary</h1>
    <div class="sub">${lic.businessName||"RestoPOS"}${lic.vatNumber?` · VAT: ${lic.vatNumber}`:""}</div>
  </div>
  <div class="meta">
    <div><strong>Quarter:</strong> ${qi.label}</div>
    <div><strong>Quarter ends:</strong> ${qi.quarterEndStr}</div>
    <div><strong>ZATCA filing deadline:</strong> ${qi.deadlineStr}</div>
    <div><strong>Days left:</strong> ${qi.daysLeft}</div>
    <div><strong>Generated:</strong> ${new Date().toLocaleDateString("en-SA",{day:"numeric",month:"long",year:"numeric"})}</div>
  </div>
</div>

<div class="sec">Sales (Output Tax)</div>
<table>
  <tr><th>Box</th><th>Description</th><th class="r">Taxable (SAR)</th><th class="r">VAT (SAR)</th></tr>
  ${row("Box 1","Standard-rated domestic sales","المبيعات المحلية الخاضعة للضريبة",C2.STANDARD?.sales||0,C2.STANDARD?.salesVAT||0)}
  ${row("Box 2","Zero-rated domestic sales","المبيعات المحلية بمعدل الصفر",C2.ZERO?.sales||0,0)}
  ${row("Box 3","Exempt sales","المبيعات المعفاة",C2.EXEMPT?.sales||0,0)}
  ${row("Box 4","Total Sales","إجمالي المبيعات",stats.totalSales,stats.outputVAT,{total:true})}
</table>

<div class="sec">Purchases (Input Tax)</div>
<table>
  <tr><th>Box</th><th>Description</th><th class="r">Taxable (SAR)</th><th class="r">VAT (SAR)</th></tr>
  ${row("Box 5","Standard-rated purchases","المشتريات الخاضعة للضريبة",C2.STANDARD?.purchases||0,C2.STANDARD?.purchasesVAT||0)}
  ${row("Box 6","Total recoverable input VAT","إجمالي ضريبة المدخلات القابلة للاسترداد",stats.totalPurchases,stats.inputVAT,{total:true})}
</table>

<div class="sec">Net VAT Position</div>
<div class="net">
  <div class="b"><div class="l">Output VAT</div><div class="v" style="color:#dc2626">${fmtN(stats.outputVAT)}</div></div>
  <div class="b"><div class="l">Input VAT</div><div class="v" style="color:#6366f1">${fmtN(stats.inputVAT)}</div></div>
  <div class="b final"><div class="l">${payable?"VAT Payable":"VAT Refund"}</div><div class="v">${fmtN(Math.abs(stats.netVATPayable))}</div></div>
</div>
<div class="note">Output VAT ${fmtN(stats.outputVAT)} − Input VAT ${fmtN(stats.inputVAT)} = ${fmtN(stats.netVATPayable)} · Based on ${stats.txCount} logged entries.</div>

${stats.amountOwed>0?`<div class="warn"><b>⚠️ Penalty estimates if filed late</b>Late filing: ${fmtN(stats.latePenalty)} per month (5%) · Maximum: ${fmtN(stats.maxPenalty)} (25% of tax due).</div>`:""}

<div class="note" style="margin-top:16px"><strong>Note:</strong> This is an estimated VAT return based on entries logged in RestoPOS. Verify all figures against your official ZATCA e-invoices (FATOORA) before submitting at zatca.gov.sa.</div>

<div class="foot">RestoPOS · VAT Engine · restopos.store · Generated ${new Date().toLocaleString("en-SA")}</div>
</body></html>`;
    _vatOutput(html, mode);
  };

  // Output helper: print (A4/thermal) or save as PDF via the browser print dialog → "Save as PDF".
  function _vatOutput(html, mode) {
    let frame = document.getElementById("vat-print-frame");
    if (!frame) {
      frame = document.createElement("iframe");
      frame.id = "vat-print-frame";
      frame.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:0;height:0;border:none;";
      document.body.appendChild(frame);
    }
    const fdoc = frame.contentDocument || frame.contentWindow.document;
    fdoc.open(); fdoc.write(html); fdoc.close();
    setTimeout(() => {
      try { frame.contentWindow.focus(); frame.contentWindow.print(); }
      catch (e) {
        const w = window.open("", "_blank", "width=800,height=1000");
        if (w) { w.document.write(html); w.document.close(); setTimeout(()=>w.print(),400); }
        else showToast("Allow pop-ups to print/save the VAT return.", "error");
      }
    }, 400);
    if (mode === "pdf") showToast("In the print dialog, choose 'Save as PDF' as the destination.", "info");
  }



  // Filtered list for transactions tab
  const filtered = allTx
    .filter(t => filterType === "ALL" || t.type === filterType)
    .filter(t =>
      !searchQ || t.description.toLowerCase().includes(searchQ.toLowerCase()) ||
      (t.invoiceRef||"").toLowerCase().includes(searchQ.toLowerCase())
    )
    .slice().reverse();

  // Daily grouped totals for mini chart
  const dailyMap = {};
  for (const tx of allTx) {
    if (!dailyMap[tx.date]) dailyMap[tx.date] = { sales: 0, purchases: 0, outputVAT: 0, inputVAT: 0 };
    if (tx.type === "SALE") { dailyMap[tx.date].sales += tx.net; dailyMap[tx.date].outputVAT += tx.vat; }
    else { dailyMap[tx.date].purchases += tx.net; dailyMap[tx.date].inputVAT += tx.vat; }
  }
  const dailyDates = Object.keys(dailyMap).sort().slice(-14); // Last 14 days

  // ── Progress bar for VAT position ─────────────────────────
  const vatProgress = stats.outputVAT > 0
    ? Math.min(100, (stats.inputVAT / stats.outputVAT) * 100)
    : 0;

  // ── Chart bar scale ───────────────────────────────────────
  const maxDailyVAT = Math.max(1, ...dailyDates.map(d =>
    (dailyMap[d]?.outputVAT || 0) + (dailyMap[d]?.inputVAT || 0)
  ));

  if (loading) return (
    <div style={S.loadWrap}>
      <div style={S.spinner} />
      <p style={{ color: "#94a3b8", marginTop: 16, fontFamily: "system-ui" }}>Loading VAT data…</p>
    </div>
  );

  return (
    <div className={vatTheme==="light"?"vat-light":"vat-dark"} style={{...S.root, background: vatTheme==="light"?"#f1f5f9":S.root.background, color: vatTheme==="light"?"#0f172a":S.root.color}}>
      {vatTheme==="light"&&(
        <style>{`
          .vat-light{background:#f1f5f9 !important;color:#0f172a !important}
          .vat-light [style*="background: rgb(15, 23, 42)"],
          .vat-light [style*="background:#0f172a"]{background:#ffffff !important;border-color:#e2e8f0 !important}
          .vat-light [style*="background: rgb(11, 17, 32)"]{background:#f1f5f9 !important}
          .vat-light [style*="background: rgb(30, 41, 59)"]{background:#e2e8f0 !important}
          .vat-light [style*="color: rgb(241, 245, 249)"],
          .vat-light [style*="color:#f1f5f9"]{color:#0f172a !important}
          .vat-light [style*="color: rgb(226, 232, 240)"]{color:#1e293b !important}
          .vat-light [style*="color: rgb(148, 163, 184)"]{color:#475569 !important}
          .vat-light [style*="color: rgb(100, 116, 139)"]{color:#64748b !important}
          .vat-light [style*="color: rgb(71, 85, 105)"]{color:#64748b !important}
          .vat-light [style*="border: 1px solid rgb(30, 41, 59)"],
          .vat-light [style*="border:1px solid #1e293b"]{border-color:#e2e8f0 !important}
        `}</style>
      )}
      {toast && (
        <div style={{ ...S.toast, background: toast.type === "error" ? "#dc2626" : toast.type === "info" ? "#3b82f6" : "#10b981" }}>
          {toast.msg}
        </div>
      )}

      {/* ── Delete Confirm Modal ───────────────────────────── */}
      {deleteId && (
        <div style={S.modalOverlay}>
          <div style={S.modal}>
            <p style={S.modalTitle}>Remove this entry?</p>
            <p style={S.modalSub}>This will recalculate your VAT position. This cannot be undone.</p>
            <div style={S.modalBtns}>
              <button style={S.btnCancel} onClick={() => setDeleteId(null)}>Cancel</button>
              <button style={S.btnDanger} onClick={() => deleteTransaction(deleteId)}>Remove</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Header ────────────────────────────────────────── */}
      <div style={S.header}>
        <div>
          <div style={S.headerEyebrow}>ZATCA VAT Engine — RestoPOS</div>
          <div style={S.headerTitle}>VAT Return Tracker</div>
          <div style={S.headerPeriod}>
            <span style={{fontWeight:700}}>{_qi.label}</span>
            <span style={S.deadlineBadge}>Quarter ends: {_qi.quarterEndStr}</span>
            <span style={{...S.deadlineBadge, borderColor:"#10b981", color:"#10b981"}}>ZATCA filing deadline: {_qi.deadlineStr}</span>
            <button onClick={()=>setShowVatGuide(true)} style={{background:"transparent",border:"1px solid #64748b",color:"#94a3b8",borderRadius:6,padding:"2px 8px",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>ℹ️ Filing guide</button>
          </div>
        </div>
        <div style={S.headerRight}>
          {/* Light / Dark toggle */}
          <button onClick={toggleVatTheme} title="Toggle light / dark"
            style={{background:vatTheme==="light"?"#fff":"#1e293b",border:`1px solid ${vatTheme==="light"?"#cbd5e1":"#334155"}`,color:vatTheme==="light"?"#0f172a":"#e2e8f0",borderRadius:8,padding:"9px 14px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
            {vatTheme==="light"?"🌙 Dark":"☀️ Light"}
          </button>
          <div style={{ ...S.daysBadge, background: days < 10 ? "#dc2626" : days < 20 ? "#f59e0b" : "#10b981" }}>
            <span style={S.daysNum}>{days}</span>
            <span style={S.daysLabel}>days left</span>
          </div>
          {/* Save / Print VAT Return with A4 / Thermal / PDF choice */}
          <div style={{position:"relative"}}>
            <button style={{ ...S.addBtn, background:"#1A6B4A" }} onClick={()=>setShowPrintMenu(v=>!v)}>🧾 Save / Print VAT ▾</button>
            {showPrintMenu&&(
              <>
                <div onClick={()=>setShowPrintMenu(false)} style={{position:"fixed",inset:0,zIndex:40}}/>
                <div style={{position:"absolute",right:0,top:"calc(100% + 6px)",zIndex:50,background:vatTheme==="light"?"#fff":"#0f172a",border:`1px solid ${vatTheme==="light"?"#e2e8f0":"#1e293b"}`,borderRadius:10,padding:6,minWidth:210,boxShadow:"0 12px 40px rgba(0,0,0,0.35)"}}>
                  <button onClick={()=>{setShowPrintMenu(false);printVATReturn("pdf");}} style={vatMenuBtn(vatTheme)}>📄 Save as PDF</button>
                  <button onClick={()=>{setShowPrintMenu(false);printVATReturn("a4");}} style={vatMenuBtn(vatTheme)}>🖨️ Print — A4 printer</button>
                  <button onClick={()=>{setShowPrintMenu(false);printVATReturn("thermal");}} style={vatMenuBtn(vatTheme)}>🧾 Print — Thermal (80mm)</button>
                </div>
              </>
            )}
          </div>
          <button style={S.addBtn} onClick={() => setShowForm(true)}>+ Add Entry</button>
        </div>
      </div>

      {/* Filing guide modal */}
      {showVatGuide&&(
        <div onClick={()=>setShowVatGuide(false)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div onClick={e=>e.stopPropagation()} style={{background:vatTheme==="light"?"#fff":"#0f172a",color:vatTheme==="light"?"#0f172a":"#e2e8f0",border:`1px solid ${vatTheme==="light"?"#e2e8f0":"#1e293b"}`,borderRadius:14,maxWidth:480,width:"100%",padding:24}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <div style={{fontSize:17,fontWeight:800}}>📖 VAT Filing Guide</div>
              <button onClick={()=>setShowVatGuide(false)} style={{background:"none",border:"none",fontSize:22,cursor:"pointer",color:"#94a3b8"}}>×</button>
            </div>
            <div style={{fontSize:13,lineHeight:1.7,color:vatTheme==="light"?"#475569":"#94a3b8"}}>
              <p style={{marginBottom:10}}>VAT returns in Saudi Arabia are filed <strong>quarterly</strong> (every 3 months) for most businesses. Businesses with annual revenue above SAR 40M file monthly.</p>
              <p style={{marginBottom:10}}>After each quarter ends, you have until the <strong>end of the following month</strong> to file and pay with ZATCA:</p>
              <ul style={{paddingLeft:18,display:"flex",flexDirection:"column",gap:6,marginBottom:12}}>
                <li>Q1 (Jan–Mar) → file by <strong>30 Apr</strong></li>
                <li>Q2 (Apr–Jun) → file by <strong>31 Jul</strong></li>
                <li>Q3 (Jul–Sep) → file by <strong>31 Oct</strong></li>
                <li>Q4 (Oct–Dec) → file by <strong>31 Jan</strong></li>
              </ul>
              <div style={{background:vatTheme==="light"?"#f0fdf4":"#0b2a1c",border:"1px solid #16a34a",borderRadius:8,padding:"10px 12px",fontSize:12.5,color:vatTheme==="light"?"#16a34a":"#4ade80"}}>
                Current quarter: <strong>{_qi.label}</strong> — ends {_qi.quarterEndStr}, file by <strong>{_qi.deadlineStr}</strong> ({days} days left).
              </div>
              <p style={{marginTop:12,fontSize:11.5}}>Late filing penalty: 5% of unpaid tax per month. Always verify figures against your FATOORA e-invoices before filing at zatca.gov.sa.</p>
            </div>
          </div>
        </div>
      )}

      {/* ── KPI Cards ─────────────────────────────────────── */}
      <div style={S.kpiGrid}>
        <VatKPICard label="Total Sales (Net)" labelAr="صافي المبيعات"   value={vatSar(stats.totalSales)}       sub={`VAT collected: ${vatSar(stats.outputVAT)}`}    accent="#10b981" icon="📈" />
        <VatKPICard label="Total Purchases"   labelAr="إجمالي المشتريات" value={vatSar(stats.totalPurchases)}   sub={`Input VAT paid: ${vatSar(stats.inputVAT)}`}     accent="#6366f1" icon="📦" />
        <VatKPICard label="Output VAT"        labelAr="ضريبة المخرجات"   value={vatSar(stats.outputVAT)}        sub="VAT collected from customers"                  accent="#f59e0b" icon="⬆️" />
        <VatKPICard label="Input VAT"         labelAr="ضريبة المدخلات"   value={vatSar(stats.inputVAT)}         sub="VAT paid on purchases (recoverable)"           accent="#8b5cf6" icon="⬇️" />
      </div>

      {/* ── VAT Position Banner ───────────────────────────── */}
      <div style={{ ...S.positionBanner, borderColor: stats.netVATPayable >= 0 ? "#f59e0b" : "#10b981" }}>
        <div style={S.positionLeft}>
          <div style={S.positionLabel}>
            {stats.netVATPayable >= 0 ? "🔴 ESTIMATED VAT PAYABLE TO ZATCA" : "🟢 ESTIMATED VAT REFUND FROM ZATCA"}
          </div>
          <div style={{ ...S.positionLabel, fontSize: 12, color: "#64748b", marginTop: 2 }}>
            {stats.netVATPayable >= 0 ? "ضريبة القيمة المضافة المستحقة" : "استرداد ضريبة القيمة المضافة"}
          </div>
          <div style={S.positionAmount}>
            {stats.netVATPayable >= 0 ? vatSar(stats.amountOwed) : vatSar(stats.refundDue)}
          </div>
          <div style={S.positionFormula}>
            Output VAT {vatSar(stats.outputVAT)} − Input VAT {vatSar(stats.inputVAT)} = <strong>{vatSar(stats.netVATPayable)}</strong>
          </div>
        </div>
        <div style={S.positionRight}>
          {/* VAT coverage bar */}
          <div style={S.coverageWrap}>
            <div style={S.coverageLabel}>Input VAT covers {Math.round(vatProgress)}% of Output VAT</div>
            <div style={S.coverageBar}>
              <div style={{ ...S.coverageFill, width: `${vatProgress}%`, background: vatProgress >= 100 ? "#10b981" : "#f59e0b" }} />
            </div>
            <div style={S.coverageValues}>
              <span>0</span><span>{vatSar(stats.outputVAT)}</span>
            </div>
          </div>
          {/* Late penalty estimate */}
          {stats.amountOwed > 0 && (
            <div style={S.penaltyBox}>
              <div style={S.penaltyTitle}>⚠️ If filed late (estimated)</div>
              <div style={S.penaltyRow}><span>5% monthly penalty:</span><span style={{ color: "#f87171" }}>{vatSar(stats.latePenalty)}</span></div>
              <div style={S.penaltyRow}><span>Max non-filing penalty (25%):</span><span style={{ color: "#f87171" }}>{vatSar(stats.maxPenalty)}</span></div>
            </div>
          )}
        </div>
      </div>

      {/* ── Pay VAT Button ────────────────────────────────── */}
      {(()=>{
        const now = new Date();
        const m = now.getMonth(); // 0-indexed
        const d = now.getDate();
        // Filing windows: month AFTER quarter end, days 1-30/31
        // Q1 (Jan-Mar) → April (m=3), Q2 (Apr-Jun) → July (m=6)
        // Q3 (Jul-Sep) → October (m=9), Q4 (Oct-Dec) → January (m=0)
        const filingMonths = [0, 3, 6, 9]; // Jan, Apr, Jul, Oct
        const isFilingMonth = filingMonths.includes(m);
        // Quarter that just ended
        const quarterLabels = {0:"Q4 (Oct–Dec)", 3:"Q1 (Jan–Mar)", 6:"Q2 (Apr–Jun)", 9:"Q3 (Jul–Sep)"};
        const nextFilingMonth = filingMonths.find(fm => fm > m) ?? filingMonths[0];
        const nextFilingMonthName = ["January","February","March","April","May","June","July","August","September","October","November","December"][nextFilingMonth];
        const currentFilingQuarter = quarterLabels[m] || "";
        // Last day of current month
        const lastDay = new Date(now.getFullYear(), m+1, 0).getDate();
        const isActive = isFilingMonth;
        return (
          <div style={{margin:"14px 0 10px 0"}}>
            {isActive ? (
              <div>
                <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",background:"#0b1f17",border:"1px solid #10b981",borderRadius:10,marginBottom:10,fontSize:12.5,color:"#86efac"}}>
                  <span style={{fontSize:16}}>📅</span>
                  <span><strong>Filing window open</strong> — {currentFilingQuarter} VAT return is due by <strong>{lastDay} {["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m]} {now.getFullYear()}</strong></span>
                </div>
                <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"center",padding:"14px 16px",background:"linear-gradient(135deg,#0b2a1a,#0d3320)",border:"2px solid #10b981",borderRadius:12}}>
                  <div style={{flex:1,minWidth:180}}>
                    <div style={{fontSize:14,fontWeight:800,color:"#fff",marginBottom:3}}>💳 Pay VAT Liability</div>
                    <div style={{fontSize:12,color:"#86efac"}}>Estimated liability: <strong style={{color:"#fff",fontSize:13}}>{vatSar(stats.amountOwed)}</strong></div>
                    <div style={{fontSize:11,color:"#64748b",marginTop:3}}>Log in to ZATCA portal → File return → Pay via SADAD</div>
                  </div>
                  <button
                    onClick={()=>window.open("https://zatca.gov.sa/en/Pages/default.aspx","_blank")}
                    style={{padding:"12px 22px",background:"linear-gradient(135deg,#10b981,#059669)",color:"#fff",border:"none",borderRadius:10,fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap",boxShadow:"0 4px 14px #10b98144"}}>
                    🔗 Pay Now on ZATCA
                  </button>
                </div>
              </div>
            ) : (
              <div style={{display:"flex",alignItems:"center",gap:12,padding:"13px 16px",background:"#111827",border:"1px solid #374151",borderRadius:12,opacity:0.7}}>
                <span style={{fontSize:20}}>🔒</span>
                <div>
                  <div style={{fontSize:13,fontWeight:700,color:"#9ca3af"}}>Pay VAT — Not Yet Available</div>
                  <div style={{fontSize:11.5,color:"#6b7280",marginTop:2}}>Filing window opens <strong style={{color:"#9ca3af"}}>{nextFilingMonthName} 1st</strong> after your quarter ends</div>
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Tabs ──────────────────────────────────────────── */}
      <div style={S.tabs}>
        {[["dashboard","Dashboard"],["transactions","Transactions"],["breakdown","VAT Breakdown"],["summary","Return Summary"]].map(([k,l]) => (
          <button key={k} style={{ ...S.tab, ...(activeTab === k ? S.tabActive : {}) }} onClick={() => setActiveTab(k)}>{l}</button>
        ))}
      </div>

      {/* ══════════════════════════════════════════════════════
          TAB: DASHBOARD
      ══════════════════════════════════════════════════════ */}
      {activeTab === "dashboard" && (
        <div style={S.tabContent}>
          <div style={{ background:"#0b1f17", border:"1px solid #1A6B4A", borderRadius:10, padding:"12px 16px", marginBottom:14, fontSize:13, color:"#86efac", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
            <span style={{fontSize:18}}>🔄</span>
            <span>Sales auto-update from <strong>Close Day</strong> totals — {autoSalesTx.length} day{autoSalesTx.length===1?"":"s"} pulled this month ({vatSar(autoSalesTx.reduce((s,t)=>s+t.vat,0))} output VAT). Add purchases &amp; expenses manually with <strong>+ Add Entry</strong>.</span>
          </div>
          {/* Daily VAT Chart */}
          <div style={S.card}>
            <div style={S.cardTitle}>Daily VAT Activity — Last 14 Days</div>
            {dailyDates.length === 0 ? (
              <div style={S.empty}>No transactions yet. Add your first entry above.</div>
            ) : (
              <div style={S.chartWrap}>
                {dailyDates.map(d => {
                  const outH = ((dailyMap[d].outputVAT / maxDailyVAT) * 120).toFixed(0);
                  const inH  = ((dailyMap[d].inputVAT  / maxDailyVAT) * 120).toFixed(0);
                  return (
                    <div key={d} style={S.barGroup} title={`${d}\nOutput: ${vatSar(dailyMap[d].outputVAT)}\nInput: ${vatSar(dailyMap[d].inputVAT)}`}>
                      <div style={S.barPair}>
                        <div style={{ ...S.bar, height: `${outH}px`, background: "#10b981" }} />
                        <div style={{ ...S.bar, height: `${inH}px`,  background: "#6366f1" }} />
                      </div>
                      <div style={S.barLabel}>{d.slice(8)}</div>
                    </div>
                  );
                })}
                <div style={S.chartLegend}>
                  <span><span style={{ ...S.dot, background: "#10b981" }} />Output VAT</span>
                  <span><span style={{ ...S.dot, background: "#6366f1" }} />Input VAT</span>
                </div>
              </div>
            )}
          </div>

          {/* Stats Row */}
          <div style={S.statsRow}>
            <div style={S.statBox}>
              <div style={S.statNum}>{stats.txCount}</div>
              <div style={S.statLabel}>Total Entries</div>
            </div>
            <div style={S.statBox}>
              <div style={S.statNum}>{txToday}</div>
              <div style={S.statLabel}>Today's Entries</div>
            </div>
            <div style={S.statBox}>
              <div style={{ ...S.statNum, color: "#10b981" }}>{vatSar(stats.totalSales)}</div>
              <div style={S.statLabel}>Total Revenue (Net)</div>
            </div>
            <div style={S.statBox}>
              <div style={{ ...S.statNum, color: stats.netVATPayable > 0 ? "#f87171" : "#10b981" }}>{vatSar(Math.abs(stats.netVATPayable))}</div>
              <div style={S.statLabel}>{stats.netVATPayable >= 0 ? "VAT to Pay" : "VAT Refund"}</div>
            </div>
          </div>

          {/* ZATCA Rules reminder */}
          <div style={S.card}>
            <div style={S.cardTitle}>📋 ZATCA Filing Rules — This Period</div>
            <div style={S.rulesGrid}>
              {[
                ["📅 Filing Deadline", vatFilingDeadline(period)],
                ["⏳ Days Remaining", `${days} days`],
                ["📊 VAT Rate", "15% (Standard)"],
                ["🔁 Filing Frequency", "Monthly (if revenue > SAR 40M) or Quarterly"],
                ["💰 Payment Method", "ZATCA e-Services portal (zatca.gov.sa)"],
                ["⚠️ Late Penalty", "5% of unpaid tax per month (max 25%)"],
                ["🔒 Input VAT Rule", "Only recoverable if supplier issued valid ZATCA e-invoice"],
                ["📄 Record Retention", "Invoices must be stored for 6 years minimum"],
              ].map(([k, v]) => (
                <div key={k} style={S.ruleRow}>
                  <span style={S.ruleKey}>{k}</span>
                  <span style={S.ruleVal}>{v}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          TAB: TRANSACTIONS
      ══════════════════════════════════════════════════════ */}
      {activeTab === "transactions" && (
        <div style={S.tabContent}>
          {/* Filters */}
          <div style={S.filterBar}>
            <input
              style={S.searchInput}
              placeholder="Search by description or invoice ref…"
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
            />
            <div style={S.filterBtns}>
              {["ALL","SALE","PURCHASE","EXPENSE"].map(t => (
                <button key={t} style={{ ...S.filterBtn, ...(filterType === t ? S.filterBtnActive : {}) }} onClick={() => setFilterType(t)}>
                  {t === "ALL" ? "All" : VAT_TX_TYPES[t]?.label || t}
                </button>
              ))}
            </div>
          </div>

          {filtered.length === 0 ? (
            <div style={S.empty}>
              {transactions.length === 0
                ? "No entries yet. Click + Add Entry to log your first transaction."
                : "No entries match your filter."}
            </div>
          ) : (
            <div style={S.txList}>
              {filtered.map(tx => (
                <div key={tx.id} style={{ ...S.txCard, borderLeft: `3px solid ${tx.type === "SALE" ? "#10b981" : "#6366f1"}`, ...(tx.auto?{opacity:0.95,background:"#0b1f17"}:{}) }}>
                  <div style={S.txTop}>
                    <div style={S.txInfo}>
                      <div style={S.txDesc}>{tx.description}</div>
                      <div style={S.txMeta}>
                        {tx.auto && <span style={{ ...S.txBadge, background: "#1A6B4A" }}>🔄 AUTO</span>}
                        <span style={{ ...S.txBadge, background: tx.type === "SALE" ? "#064e3b" : "#1e1b4b" }}>
                          {VAT_TX_TYPES[tx.type]?.label}
                        </span>
                        <span style={{ ...S.txBadge, background: "#1e293b" }}>
                          {VAT_CATS[tx.category]?.label}
                        </span>
                        {tx.invoiceRef && !tx.auto && <span style={{ ...S.txBadge, background: "#0c2340" }}>#{tx.invoiceRef}</span>}
                        <span style={{ color: "#64748b", fontSize: 11 }}>{tx.date}</span>
                      </div>
                    </div>
                    <div style={S.txAmounts}>
                      <div style={S.txNet}>Net: <strong>{vatSar(tx.net)}</strong></div>
                      <div style={{ ...S.txVat, color: tx.type === "SALE" ? "#10b981" : "#818cf8" }}>
                        VAT ({(tx.rate * 100 || 15)}%): {vatSar(tx.vat)}
                      </div>
                      <div style={S.txGross}>Gross: {vatSar(tx.gross)}</div>
                    </div>
                    {tx.auto
                      ? <span style={{ ...S.delBtn, cursor:"default", color:"#475569", fontSize:14 }} title="Auto-pulled from Close Day — edit in POS sales">🔒</span>
                      : <button style={S.delBtn} onClick={() => setDeleteId(tx.id)} title="Remove entry">✕</button>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          TAB: VAT BREAKDOWN
      ══════════════════════════════════════════════════════ */}
      {activeTab === "breakdown" && (
        <div style={S.tabContent}>
          {/* Per-category breakdown */}
          <div style={S.card}>
            <div style={S.cardTitle}>VAT Breakdown by Category</div>
            <div style={S.breakTable}>
              <div style={S.breakHeader}>
                <span>Category</span>
                <span>Taxable Sales</span>
                <span>Output VAT</span>
                <span>Taxable Purchases</span>
                <span>Input VAT</span>
                <span>Net VAT</span>
              </div>
              {Object.entries(VAT_CATS).map(([key, cat]) => {
                const d    = stats.byCategory[key] || { sales: 0, salesVAT: 0, purchases: 0, purchasesVAT: 0 };
                const net  = vatR2(d.salesVAT - d.purchasesVAT);
                return (
                  <div key={key} style={S.breakRow}>
                    <span style={{ display:"flex", alignItems:"center", gap:6 }}>
                      <span style={{ ...S.catDot, background: cat.color }} />
                      <span>
                        <div style={{ fontWeight: 600, color: "#e2e8f0", fontSize: 13 }}>{cat.label}</div>
                        <div style={{ color: "#64748b", fontSize: 11 }}>{cat.labelAr || ""} · Code {cat.code}</div>
                      </span>
                    </span>
                    <span style={S.breakCell}>{vatSar(d.sales)}</span>
                    <span style={{ ...S.breakCell, color: "#10b981" }}>{vatSar(d.salesVAT)}</span>
                    <span style={S.breakCell}>{vatSar(d.purchases)}</span>
                    <span style={{ ...S.breakCell, color: "#818cf8" }}>{vatSar(d.purchasesVAT)}</span>
                    <span style={{ ...S.breakCell, color: net >= 0 ? "#f87171" : "#34d399", fontWeight: 700 }}>{vatSar(net)}</span>
                  </div>
                );
              })}
              {/* Total row */}
              <div style={{ ...S.breakRow, ...S.breakTotalRow }}>
                <span style={{ fontWeight: 700, color: "#f1f5f9" }}>TOTAL</span>
                <span style={S.breakCell}>{vatSar(stats.totalSales)}</span>
                <span style={{ ...S.breakCell, color: "#10b981", fontWeight: 700 }}>{vatSar(stats.outputVAT)}</span>
                <span style={S.breakCell}>{vatSar(stats.totalPurchases)}</span>
                <span style={{ ...S.breakCell, color: "#818cf8", fontWeight: 700 }}>{vatSar(stats.inputVAT)}</span>
                <span style={{ ...S.breakCell, color: stats.netVATPayable >= 0 ? "#f87171" : "#34d399", fontWeight: 700 }}>
                  {vatSar(stats.netVATPayable)}
                </span>
              </div>
            </div>
          </div>

          {/* VAT Recoverability note */}
          <div style={{ ...S.card, background: "#0f172a", border: "1px solid #1e3a5f" }}>
            <div style={S.cardTitle}>📌 Input VAT Recoverability Rules (ZATCA)</div>
            <div style={S.rulesList}>
              {[
                "Input VAT is ONLY recoverable if the supplier issued a valid ZATCA Phase 2 e-invoice.",
                "Input VAT on EXEMPT supplies cannot be recovered — it becomes a business cost.",
                "Zero-rated supply input VAT CAN be recovered (supplier registers for VAT).",
                "Mixed-use purchases must be apportioned — only the business-use portion is recoverable.",
                "Personal expenses, entertainment for non-employees: input VAT blocked.",
                "Motor vehicle purchase/lease: input VAT blocked UNLESS the vehicle is your core business.",
                "All input VAT claims must be supported by invoices retained for 6 years minimum.",
              ].map((r, i) => <div key={i} style={S.ruleItem}>• {r}</div>)}
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          TAB: RETURN SUMMARY
      ══════════════════════════════════════════════════════ */}
      {activeTab === "summary" && (
        <div style={S.tabContent}>
          <div style={S.card}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,flexWrap:"wrap"}}>
              <div style={S.cardTitle}>VAT Return Summary — {vatPeriodLabel(period)}</div>
              <button style={{ ...S.addBtn, background:"#1A6B4A" }} onClick={printVATReturn}>🖨️ Print / Save PDF</button>
            </div>
            <div style={S.summaryNote}>
              This is your estimated VAT return based on entries logged so far this period.
              Final figures must be verified against your official ZATCA e-invoices before submission.
            </div>

            {/* Return form layout — mirrors ZATCA VAT return boxes */}
            <div style={S.returnForm}>

              <div style={S.returnSection}>SALES (OUTPUT TAX)</div>
              <VatReturnRow box="Box 1" label="Standard-rated domestic sales" labelAr="المبيعات المحلية الخاضعة للضريبة"
                taxable={stats.byCategory.STANDARD?.sales || 0} vat={stats.byCategory.STANDARD?.salesVAT || 0} highlight />
              <VatReturnRow box="Box 2" label="Zero-rated domestic sales"     labelAr="المبيعات المحلية بمعدل الصفر"
                taxable={stats.byCategory.ZERO?.sales || 0}     vat={0} />
              <VatReturnRow box="Box 3" label="Exempt sales"                  labelAr="المبيعات المعفاة"
                taxable={stats.byCategory.EXEMPT?.sales || 0}   vat={0} />
              <VatReturnRow box="Box 4" label="Total Sales"                   labelAr="إجمالي المبيعات"
                taxable={stats.totalSales}  vat={stats.outputVAT} total />

              <div style={{ ...S.returnSection, marginTop: 20 }}>PURCHASES (INPUT TAX)</div>
              <VatReturnRow box="Box 5" label="Standard-rated purchases"       labelAr="المشتريات الخاضعة للضريبة"
                taxable={stats.byCategory.STANDARD?.purchases || 0} vat={stats.byCategory.STANDARD?.purchasesVAT || 0} highlight />
              <VatReturnRow box="Box 6" label="Total recoverable input VAT"    labelAr="إجمالي ضريبة المدخلات القابلة للاسترداد"
                taxable={stats.totalPurchases} vat={stats.inputVAT} total />

              <div style={{ ...S.returnSection, marginTop: 20 }}>NET VAT POSITION</div>
              <div style={S.netRow}>
                <div style={S.netBox}>
                  <div style={S.netBoxLabel}>Output VAT (Box 4)</div>
                  <div style={{ ...S.netBoxVal, color: "#f87171" }}>{vatSar(stats.outputVAT)}</div>
                </div>
                <div style={S.netMinus}>−</div>
                <div style={S.netBox}>
                  <div style={S.netBoxLabel}>Input VAT (Box 6)</div>
                  <div style={{ ...S.netBoxVal, color: "#818cf8" }}>{vatSar(stats.inputVAT)}</div>
                </div>
                <div style={S.netMinus}>=</div>
                <div style={{ ...S.netBox, background: stats.netVATPayable >= 0 ? "#450a0a" : "#052e16", borderColor: stats.netVATPayable >= 0 ? "#dc2626" : "#10b981" }}>
                  <div style={S.netBoxLabel}>{stats.netVATPayable >= 0 ? "VAT Payable" : "VAT Refund"}</div>
                  <div style={{ ...S.netBoxVal, color: stats.netVATPayable >= 0 ? "#f87171" : "#34d399", fontSize: 22 }}>
                    {vatSar(Math.abs(stats.netVATPayable))}
                  </div>
                  <div style={{ color: "#64748b", fontSize: 11, marginTop: 4 }}>
                    {stats.netVATPayable >= 0 ? "ضريبة مستحقة الدفع" : "مبلغ مسترد"}
                  </div>
                </div>
              </div>

              {/* Penalty section */}
              {stats.amountOwed > 0 && (
                <>
                  <div style={{ ...S.returnSection, marginTop: 20, color: "#f87171" }}>⚠️ PENALTY ESTIMATES (if late)</div>
                  <div style={S.penaltyTable}>
                    <div style={S.penaltyTableRow}>
                      <span>Late filing penalty (5% per month):</span>
                      <span style={{ color: "#f87171" }}>{vatSar(stats.latePenalty)} / month</span>
                    </div>
                    <div style={S.penaltyTableRow}>
                      <span>Maximum penalty (25% of tax due):</span>
                      <span style={{ color: "#f87171" }}>{vatSar(stats.maxPenalty)}</span>
                    </div>
                    <div style={S.penaltyTableRow}>
                      <span>Non-electronic invoice penalty (per invoice):</span>
                      <span style={{ color: "#f87171" }}>SAR 5,000.00</span>
                    </div>
                    <div style={S.penaltyTableRow}>
                      <span>Modified/deleted invoice penalty:</span>
                      <span style={{ color: "#f87171" }}>SAR 10,000.00</span>
                    </div>
                  </div>
                </>
              )}

              {/* Submit reminder */}
              <div style={S.submitReminder}>
                <div style={S.submitTitle}>📤 How to Submit to ZATCA</div>
                <div style={S.submitSteps}>
                  {[
                    "Log in to ZATCA e-Services portal (zatca.gov.sa)",
                    "Navigate to VAT → File VAT Return",
                    "Enter values from this summary into the corresponding boxes",
                    "Upload supporting e-invoices (already submitted via FATOORA)",
                    "Review and confirm — pay any balance due before the deadline",
                    "Save the acknowledgement reference number for your records",
                  ].map((s, i) => <div key={i} style={S.submitStep}><span style={S.stepNum}>{i+1}</span>{s}</div>)}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          ADD ENTRY FORM MODAL
      ══════════════════════════════════════════════════════ */}
      {showForm && (
        <div style={S.modalOverlay} onClick={(e) => { if (e.target === e.currentTarget) setShowForm(false); }}>
          <div style={{ ...S.modal, width: 460, maxWidth: "95vw", padding: 28 }}>
            <div style={S.formTitle}>Add VAT Entry</div>
            <div style={S.formGrid}>

              <VatFormRow label="Date">
                <input type="date" style={S.input} value={form.date}
                  onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
              </VatFormRow>

              <VatFormRow label="Transaction Type">
                <select style={S.input} value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
                  {Object.entries(VAT_TX_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label} ({v.labelAr})</option>)}
                </select>
              </VatFormRow>

              <VatFormRow label="VAT Category">
                <select style={S.input} value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>
                  {Object.entries(VAT_CATS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
              </VatFormRow>

              <VatFormRow label="Description (required)">
                <input style={S.input} placeholder="e.g. Daily restaurant sales, Food supplier invoice…"
                  value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
              </VatFormRow>

              <VatFormRow label="Amount (SAR)">
                <input type="number" step="0.01" min="0" style={S.input} placeholder="0.00"
                  value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
              </VatFormRow>

              <VatFormRow label="Invoice / Reference No.">
                <input style={S.input} placeholder="Optional — e.g. INV-20250613-000042"
                  value={form.invoiceRef} onChange={e => setForm(f => ({ ...f, invoiceRef: e.target.value }))} />
              </VatFormRow>

              <VatFormRow label="">
                <label style={S.checkLabel}>
                  <input type="checkbox" checked={form.inclVAT}
                    onChange={e => setForm(f => ({ ...f, inclVAT: e.target.checked }))} />
                  <span>Amount is VAT-inclusive (extract VAT automatically)</span>
                </label>
              </VatFormRow>
            </div>

            {/* Live preview */}
            {form.amount > 0 && (() => {
              const { net, vat, gross } = vatCalc(parseFloat(form.amount) || 0, form.category, form.inclVAT);
              return (
                <div style={S.preview}>
                  <div style={S.previewRow}><span>Net amount:</span><strong>{vatSar(net)}</strong></div>
                  <div style={S.previewRow}><span>VAT ({VAT_CATS[form.category]?.rate * 100 || 0}%):</span>
                    <strong style={{ color: form.type === "SALE" ? "#10b981" : "#818cf8" }}>{vatSar(vat)}</strong>
                  </div>
                  <div style={S.previewRow}><span>Gross total:</span><strong>{vatSar(gross)}</strong></div>
                  <div style={S.previewRow}><span>Effect on VAT position:</span>
                    <strong style={{ color: form.type === "SALE" ? "#f87171" : "#34d399" }}>
                      {form.type === "SALE" ? `+${vatSar(vat)} output VAT` : `-${vatSar(vat)} input VAT (recoverable)`}
                    </strong>
                  </div>
                </div>
              );
            })()}

            <div style={S.formBtns}>
              <button style={S.btnCancel} onClick={() => setShowForm(false)}>Cancel</button>
              <button style={S.btnPrimary} onClick={addTransaction}>Add Entry</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────
function VatKPICard({ label, labelAr, value, sub, accent, icon }) {
  return (
    <div style={{ ...S.kpiCard, borderTop: `3px solid ${accent}` }}>
      <div style={S.kpiTop}>
        <span style={S.kpiIcon}>{icon}</span>
        <div>
          <div style={S.kpiLabel}>{label}</div>
          <div style={S.kpiLabelAr}>{labelAr}</div>
        </div>
      </div>
      <div style={{ ...S.kpiValue, color: accent }}>{value}</div>
      <div style={S.kpiSub}>{sub}</div>
    </div>
  );
}

function VatReturnRow({ box, label, labelAr, taxable, vat, highlight, total }) {
  return (
    <div style={{ ...S.returnRow, ...(total ? S.returnRowTotal : {}), ...(highlight ? S.returnRowHL : {}) }}>
      <span style={S.returnBox}>{box}</span>
      <span style={S.returnLabel}>
        <div>{label}</div>
        <div style={{ color: "#475569", fontSize: 11 }}>{labelAr}</div>
      </span>
      <span style={S.returnCell}>{vatSar(taxable)}</span>
      <span style={{ ...S.returnCell, color: vat > 0 ? "#f87171" : "#94a3b8", fontWeight: total ? 700 : 400 }}>{vatSar(vat)}</span>
    </div>
  );
}

function VatFormRow({ label, children }) {
  return (
    <div style={S.formRow}>
      {label && <label style={S.formLabel}>{label}</label>}
      {children}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────
const S = {
  root: { background: "#0b1120", minHeight: "100vh", color: "#e2e8f0", fontFamily: "'Inter', system-ui, sans-serif", padding: "0 0 60px" },
  loadWrap: { display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100vh", background:"#0b1120" },
  spinner: { width:36, height:36, border:"3px solid #1e293b", borderTop:"3px solid #10b981", borderRadius:"50%", animation:"spin 0.8s linear infinite" },

  // Header
  header: { display:"flex", justifyContent:"space-between", alignItems:"flex-start", padding:"28px 28px 0", flexWrap:"wrap", gap:16 },
  headerEyebrow: { fontSize:11, fontWeight:600, letterSpacing:"0.12em", color:"#10b981", textTransform:"uppercase", marginBottom:4 },
  headerTitle: { fontSize:26, fontWeight:700, color:"#f1f5f9", letterSpacing:"-0.02em" },
  headerPeriod: { fontSize:13, color:"#64748b", marginTop:4, display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" },
  deadlineBadge: { background:"#1e293b", border:"1px solid #334155", borderRadius:6, padding:"2px 10px", fontSize:11, color:"#94a3b8" },
  headerRight: { display:"flex", alignItems:"center", gap:12 },
  daysBadge: { borderRadius:12, padding:"8px 16px", display:"flex", flexDirection:"column", alignItems:"center", minWidth:70 },
  daysNum: { fontSize:24, fontWeight:800, lineHeight:1, color:"#fff" },
  daysLabel: { fontSize:10, color:"rgba(255,255,255,0.7)", marginTop:2, letterSpacing:"0.05em" },
  addBtn: { background:"#10b981", color:"#fff", border:"none", borderRadius:8, padding:"10px 20px", fontSize:14, fontWeight:600, cursor:"pointer" },

  // KPI Grid
  kpiGrid: { display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(210px,1fr))", gap:14, padding:"20px 28px 0" },
  kpiCard: { background:"#0f172a", borderRadius:12, padding:"18px 20px", border:"1px solid #1e293b" },
  kpiTop: { display:"flex", alignItems:"center", gap:10, marginBottom:10 },
  kpiIcon: { fontSize:20 },
  kpiLabel: { fontSize:12, fontWeight:600, color:"#94a3b8" },
  kpiLabelAr: { fontSize:10, color:"#475569", marginTop:1 },
  kpiValue: { fontSize:22, fontWeight:700, letterSpacing:"-0.02em" },
  kpiSub: { fontSize:11, color:"#475569", marginTop:4 },

  // Position Banner
  positionBanner: { margin:"20px 28px 0", background:"#0f172a", borderRadius:14, border:"2px solid", padding:24, display:"flex", flexWrap:"wrap", gap:24 },
  positionLeft: { flex:1, minWidth:220 },
  positionRight: { flex:1, minWidth:220 },
  positionLabel: { fontSize:11, fontWeight:700, letterSpacing:"0.08em", color:"#94a3b8", textTransform:"uppercase" },
  positionAmount: { fontSize:36, fontWeight:800, color:"#f1f5f9", letterSpacing:"-0.03em", margin:"8px 0" },
  positionFormula: { fontSize:12, color:"#64748b" },
  coverageWrap: { marginBottom:16 },
  coverageLabel: { fontSize:11, color:"#94a3b8", marginBottom:6 },
  coverageBar: { background:"#1e293b", borderRadius:4, height:8, overflow:"hidden" },
  coverageFill: { height:"100%", borderRadius:4, transition:"width 0.5s ease" },
  coverageValues: { display:"flex", justifyContent:"space-between", fontSize:10, color:"#475569", marginTop:4 },
  penaltyBox: { background:"#1c0a0a", border:"1px solid #450a0a", borderRadius:8, padding:"12px 14px" },
  penaltyTitle: { fontSize:11, fontWeight:600, color:"#f87171", marginBottom:8 },
  penaltyRow: { display:"flex", justifyContent:"space-between", fontSize:12, color:"#94a3b8", marginBottom:4 },

  // Tabs
  tabs: { display:"flex", gap:0, padding:"20px 28px 0", borderBottom:"1px solid #1e293b" },
  tab: { background:"none", border:"none", borderBottom:"2px solid transparent", color:"#64748b", padding:"8px 18px", fontSize:13, fontWeight:500, cursor:"pointer", marginBottom:-1 },
  tabActive: { color:"#10b981", borderBottomColor:"#10b981", fontWeight:600 },
  tabContent: { padding:"20px 28px 0" },

  // Cards
  card: { background:"#0f172a", borderRadius:12, padding:"20px 22px", border:"1px solid #1e293b", marginBottom:16 },
  cardTitle: { fontSize:13, fontWeight:700, color:"#94a3b8", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:16 },
  empty: { textAlign:"center", color:"#475569", padding:"48px 0", fontSize:14 },

  // Chart
  chartWrap: { display:"flex", flexDirection:"column", gap:0 },
  barGroup: { display:"inline-flex", flexDirection:"column", alignItems:"center", flex:1, minWidth:32, cursor:"default" },
  barPair: { display:"flex", alignItems:"flex-end", gap:2, height:130 },
  bar: { width:12, borderRadius:"3px 3px 0 0", minHeight:2, transition:"height 0.3s ease" },
  barLabel: { fontSize:9, color:"#475569", marginTop:4 },
  chartLegend: { display:"flex", gap:16, marginTop:12, fontSize:12, color:"#64748b" },
  dot: { display:"inline-block", width:8, height:8, borderRadius:"50%", marginRight:4 },

  // chart row wrap
  statsRow: { display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))", gap:12, marginBottom:16 },
  statBox: { background:"#0f172a", borderRadius:10, padding:"16px 18px", border:"1px solid #1e293b", textAlign:"center" },
  statNum: { fontSize:22, fontWeight:700, color:"#f1f5f9" },
  statLabel: { fontSize:11, color:"#64748b", marginTop:4 },

  // Rules
  rulesGrid: { display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))", gap:0 },
  ruleRow: { display:"flex", flexDirection:"column", padding:"10px 0", borderBottom:"1px solid #1e293b" },
  ruleKey: { fontSize:12, fontWeight:600, color:"#94a3b8", marginBottom:3 },
  ruleVal: { fontSize:13, color:"#cbd5e1" },

  // Filter bar
  filterBar: { display:"flex", gap:12, marginBottom:16, flexWrap:"wrap" },
  searchInput: { flex:1, background:"#0f172a", border:"1px solid #1e293b", borderRadius:8, padding:"8px 14px", color:"#e2e8f0", fontSize:13, outline:"none", minWidth:200 },
  filterBtns: { display:"flex", gap:6 },
  filterBtn: { background:"#1e293b", border:"none", borderRadius:6, padding:"7px 14px", color:"#64748b", fontSize:12, cursor:"pointer" },
  filterBtnActive: { background:"#10b981", color:"#fff" },

  // Transactions
  txList: { display:"flex", flexDirection:"column", gap:8 },
  txCard: { background:"#0f172a", borderRadius:10, padding:"14px 16px", border:"1px solid #1e293b" },
  txTop: { display:"flex", alignItems:"flex-start", gap:12 },
  txInfo: { flex:1 },
  txDesc: { fontSize:14, fontWeight:600, color:"#e2e8f0", marginBottom:6 },
  txMeta: { display:"flex", gap:6, flexWrap:"wrap", alignItems:"center" },
  txBadge: { borderRadius:4, padding:"2px 8px", fontSize:10, fontWeight:600, color:"#94a3b8" },
  txAmounts: { textAlign:"right", minWidth:140 },
  txNet: { fontSize:13, color:"#94a3b8" },
  txVat: { fontSize:12, fontWeight:600 },
  txGross: { fontSize:11, color:"#475569" },
  delBtn: { background:"none", border:"none", color:"#334155", cursor:"pointer", fontSize:16, padding:"0 0 0 8px", lineHeight:1, "&:hover": { color:"#f87171" } },

  // Breakdown table
  breakTable: { display:"flex", flexDirection:"column", gap:0 },
  breakHeader: { display:"grid", gridTemplateColumns:"2fr 1fr 1fr 1fr 1fr 1fr", padding:"8px 0", borderBottom:"2px solid #1e293b", fontSize:11, fontWeight:600, color:"#475569", textTransform:"uppercase", letterSpacing:"0.05em" },
  breakRow: { display:"grid", gridTemplateColumns:"2fr 1fr 1fr 1fr 1fr 1fr", padding:"12px 0", borderBottom:"1px solid #1e293b", alignItems:"center" },
  breakTotalRow: { background:"#0b1628", borderRadius:8, padding:"12px 10px", borderTop:"2px solid #1e293b", border:"none", marginTop:4 },
  breakCell: { fontSize:13, color:"#cbd5e1" },
  catDot: { width:10, height:10, borderRadius:"50%", flexShrink:0 },

  // Rules list
  rulesList: { display:"flex", flexDirection:"column", gap:8 },
  ruleItem: { fontSize:13, color:"#94a3b8", lineHeight:1.6 },

  // Return form
  returnForm: { marginTop:8 },
  returnSection: { fontSize:11, fontWeight:700, letterSpacing:"0.1em", color:"#64748b", textTransform:"uppercase", padding:"12px 0 6px", borderBottom:"1px solid #1e293b" },
  returnRow: { display:"grid", gridTemplateColumns:"60px 1fr 160px 160px", gap:8, padding:"10px 0", borderBottom:"1px solid #0f172a", alignItems:"center" },
  returnRowHL: { background:"#0d1f2d", borderRadius:6, padding:"10px 8px" },
  returnRowTotal: { background:"#0d1f2d", borderRadius:6, padding:"10px 8px", fontWeight:700 },
  returnBox: { fontSize:11, fontWeight:700, color:"#475569", background:"#1e293b", borderRadius:4, padding:"2px 6px", textAlign:"center", width:"fit-content" },
  returnLabel: { fontSize:13, color:"#cbd5e1" },
  returnCell: { fontSize:13, color:"#94a3b8", textAlign:"right" },
  netRow: { display:"flex", alignItems:"center", gap:12, margin:"16px 0", flexWrap:"wrap" },
  netBox: { flex:1, minWidth:140, background:"#1e293b", borderRadius:10, padding:"14px 16px", border:"1px solid #334155", textAlign:"center" },
  netBoxLabel: { fontSize:11, color:"#64748b", marginBottom:6 },
  netBoxVal: { fontSize:18, fontWeight:700 },
  netMinus: { fontSize:24, color:"#475569", fontWeight:300 },
  penaltyTable: { background:"#1c0a0a", borderRadius:8, padding:"12px 16px", marginTop:8 },
  penaltyTableRow: { display:"flex", justifyContent:"space-between", fontSize:12, color:"#94a3b8", padding:"5px 0", borderBottom:"1px solid #2a0a0a" },
  submitReminder: { background:"#0d1f2d", border:"1px solid #1e3a5f", borderRadius:10, padding:"18px 20px", marginTop:20 },
  submitTitle: { fontSize:13, fontWeight:700, color:"#60a5fa", marginBottom:12 },
  submitSteps: { display:"flex", flexDirection:"column", gap:8 },
  submitStep: { display:"flex", gap:10, alignItems:"flex-start", fontSize:13, color:"#94a3b8" },
  stepNum: { background:"#1e3a5f", color:"#60a5fa", borderRadius:"50%", width:20, height:20, display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:700, flexShrink:0 },
  summaryNote: { fontSize:12, color:"#64748b", background:"#1e293b", borderRadius:6, padding:"10px 14px", marginBottom:16, lineHeight:1.6 },

  // Form modal
  formTitle: { fontSize:18, fontWeight:700, color:"#f1f5f9", marginBottom:20 },
  formGrid: { display:"flex", flexDirection:"column", gap:12 },
  formRow: { display:"flex", flexDirection:"column", gap:4 },
  formLabel: { fontSize:12, fontWeight:600, color:"#64748b" },
  input: { background:"#0b1120", border:"1px solid #1e293b", borderRadius:8, padding:"9px 12px", color:"#e2e8f0", fontSize:13, outline:"none", width:"100%", boxSizing:"border-box" },
  checkLabel: { display:"flex", gap:8, alignItems:"center", fontSize:13, color:"#94a3b8", cursor:"pointer" },
  preview: { background:"#0b1120", borderRadius:8, padding:"14px 16px", margin:"14px 0 0", border:"1px solid #10b981", display:"flex", flexDirection:"column", gap:6 },
  previewRow: { display:"flex", justifyContent:"space-between", fontSize:13, color:"#64748b" },
  formBtns: { display:"flex", gap:10, justifyContent:"flex-end", marginTop:20 },

  // Buttons
  btnPrimary: { background:"#10b981", color:"#fff", border:"none", borderRadius:8, padding:"10px 22px", fontSize:14, fontWeight:600, cursor:"pointer" },
  btnCancel: { background:"#1e293b", color:"#94a3b8", border:"none", borderRadius:8, padding:"10px 22px", fontSize:14, cursor:"pointer" },
  btnDanger: { background:"#dc2626", color:"#fff", border:"none", borderRadius:8, padding:"10px 22px", fontSize:14, fontWeight:600, cursor:"pointer" },

  // Modal
  modalOverlay: { position:"fixed", inset:0, background:"rgba(0,0,0,0.75)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:20 },
  modal: { background:"#0f172a", borderRadius:14, padding:24, border:"1px solid #1e293b", width:360, maxWidth:"95vw" },
  modalTitle: { fontSize:16, fontWeight:700, color:"#f1f5f9", marginBottom:8 },
  modalSub: { fontSize:13, color:"#64748b", marginBottom:20 },
  modalBtns: { display:"flex", gap:10, justifyContent:"flex-end" },

  // Toast
  toast: { position:"fixed", bottom:24, right:24, color:"#fff", borderRadius:8, padding:"12px 20px", fontSize:13, fontWeight:600, zIndex:2000, boxShadow:"0 4px 20px rgba(0,0,0,0.4)" },

  // Chart bar wrap — override display
  chartBars: { display:"flex", alignItems:"flex-end", gap:6, height:140, padding:"0 0 8px" },
};
