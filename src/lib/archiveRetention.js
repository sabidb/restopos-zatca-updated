// Compact archive representation. This is additive and non-destructive:
// never delete detailed invoice records without a separately approved migration.
const SALE_FIELDS = [
  "id","date","createdAt","updatedAt","status","isDraft",
  "branchId","branchName","tillId","tillName","cashierId","cashierName",
  "customerId","customerName","customerVatNumber","customerAddress",
  "invoiceNumber","serialNumber","uuid","invoiceHash","previousInvoiceHash",
  "invoiceType","submissionStatus","reportedAt","total","vat","net","subtotal",
  "discount","discountAmount","paymentMethod","paymentBreakdown","splitPayments",
  "refundTotal","refundVat","refundOf","creditNoteNumber","voidedAt","voidReason",
  "taxBreakdown","taxCategories","qrCode","currency",
];

const ITEM_FIELDS = [
  "id","productId","sku","name","productName","category","qty","quantity",
  "price","unitPrice","total","lineTotal","discount","discountAmount",
  "taxCategory","vatRate","rate","vat","net",
];
const PAYMENT_FIELDS = ["id","method","type","amount","status","reference","transactionId","provider"];

const round2 = (n) => Math.round((Number(n)||0)*100)/100;
function pick(source, fields) {
  const out={};
  for(const key of fields) if(source && source[key]!==undefined && source[key]!==null) out[key]=source[key];
  return out;
}
function compactItems(items=[]) {
  return (Array.isArray(items)?items:[]).map(item=>pick(item,ITEM_FIELDS)).filter(item=>Object.keys(item).length>0);
}
function compactPayments(payments=[]) {
  return (Array.isArray(payments)?payments:[]).map(p=>pick(p,PAYMENT_FIELDS)).filter(p=>Object.keys(p).length>0);
}
export function compactSaleForArchive(sale, compactedAt=new Date().toISOString()) {
  const out=pick(sale,SALE_FIELDS);
  if(Array.isArray(sale?.items)) out.items=compactItems(sale.items);
  if(Array.isArray(sale?.payments)) out.payments=compactPayments(sale.payments);
  if(Array.isArray(sale?.splitPayments)) out.splitPayments=compactPayments(sale.splitPayments);
  // Keep the ZATCA response envelope's non-sensitive status metadata only.
  if(sale?.zatcaResponse && typeof sale.zatcaResponse==="object") {
    out.zatcaResponse=pick(sale.zatcaResponse,["status","validationStatus","reportingStatus","clearingStatus","warnings","errorCode","errorMessage","reportedAt"]);
  } else if(typeof sale?.zatcaResponse==="string") {
    out.zatcaResponseSummary=sale.zatcaResponse.slice(0,256);
    delete out.zatcaResponse;
  }
  out.compactArchiveVersion=1;
  out.compactedAt=compactedAt;
  return out;
}

export function isOlderThanRetention(date, now=new Date(), retentionDays=90) {
  const day=String(date||"").slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const cutoff=new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate()-retentionDays);
  return day < cutoff.toISOString().slice(0,10);
}

function fnvFingerprint(value) {
  const text=JSON.stringify(value);
  let hash=0x811c9dc5;
  for(let i=0;i<text.length;i++){hash^=text.charCodeAt(i);hash=Math.imul(hash,0x01000193);}
  return (hash>>>0).toString(16).padStart(8,"0");
}
function uniqueById(sales=[]) {
  const map=new Map(),withoutId=[];
  const timestamp=s=>Date.parse(s?.syncUpdatedAt||s?.updatedAt||s?.lastModifiedAt||s?.modifiedAt||s?.createdAt||"")||0;
  for(const sale of sales||[]){
    if(!sale)continue;
    if(sale.id==null||sale.id===""){withoutId.push(sale);continue;}
    const key=String(sale.id),prev=map.get(key);
    if(!prev||timestamp(sale)>=timestamp(prev))map.set(key,sale);
  }
  return [...map.values(),...withoutId];
}
export function compactArchiveDay(sales=[],date,compactedAt=new Date().toISOString()) {
  const unique=uniqueById(sales);
  const compacted=unique.map(s=>compactSaleForArchive(s,compactedAt));
  const completed=unique.filter(s=>(!s.status||s.status==="completed")&&!s.isDraft);
  const total=round2(completed.reduce((n,s)=>n+(Number(s.total)||0),0));
  const vat=round2(completed.reduce((n,s)=>n+(Number(s.vat)||0),0));
  const net=round2(total-vat);
  return {date,count:completed.length,total,vat,net,recordCount:compacted.length,fingerprint:fnvFingerprint(compacted),records:compacted};
}
