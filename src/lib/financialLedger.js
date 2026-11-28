import { calculateSale, assertSaleReconciles } from "./financialEngine.js";

const DEFAULT_LEDGER_KEY="restopos_financial_ledger_v1";
const toTime=(v)=>Date.parse(v||"")||0;
const safeJson=(v)=>JSON.stringify(v);
function stable(value){
  if(Array.isArray(value))return value.map(stable);
  if(value&&typeof value==="object")return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));
  return value;
}
function signature(value){return safeJson(stable(value));}
function hash(value){
  const text=signature(value);let h=0x811c9dc5;
  for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,0x01000193);}
  return (h>>>0).toString(16).padStart(8,"0");
}
function readLedger(storage,key=DEFAULT_LEDGER_KEY){
  try{const parsed=JSON.parse(storage.getItem(key)||"{}");return normalizeLedger(parsed);}catch{return normalizeLedger({});}
}
export function normalizeLedger(value){
  return {version:1,sales:Array.isArray(value?.sales)?value.sales:[],transactions:Array.isArray(value?.transactions)?value.transactions:[],updatedAt:value?.updatedAt||null};
}
export function buildSaleTransactionPair(input={},now=new Date().toISOString()){
  const saleId=String(input.saleId||input.id||"").trim();
  if(!saleId)throw new TypeError("saleId is required");
  const calculated=calculateSale(input.items||[],input.discount||0);
  assertSaleReconciles(calculated);
  const metadata=input.metadata&&typeof input.metadata==="object"?input.metadata:{};
  const createdAt=input.createdAt||now;
  const sale={...metadata,id:saleId,items:input.items||[],...calculated,status:input.status||metadata.status||"completed",createdAt,updatedAt:now,ledgerVersion:1};
  const transaction={...pickPaymentMetadata(metadata),id:`txn:${saleId}`,saleId,type:"sale",total:calculated.total,net:calculated.net,vat:calculated.vat,discount:calculated.discount,createdAt,updatedAt:now,ledgerVersion:1};
  return {sale,transaction};
}
function pickPaymentMetadata(metadata){
  const out={};
  for(const key of ["branchId","branchName","tillId","tillName","cashierId","cashierName","paymentMethod","payments","paymentBreakdown","customerId"])if(metadata[key]!==undefined)out[key]=metadata[key];
  return out;
}
export function appendSaleAndTransaction(storage,input,key=DEFAULT_LEDGER_KEY,now=new Date().toISOString()){
  if(!storage||typeof storage.setItem!=="function"||typeof storage.getItem!=="function")throw new TypeError("Storage adapter is required");
  const ledger=readLedger(storage,key);
  const pair=buildSaleTransactionPair(input,now);
  const existing=ledger.sales.find(s=>String(s.id)===pair.sale.id);
  if(existing){
    const existingTx=ledger.transactions.find(t=>String(t.saleId)===pair.sale.id&&t.type==="sale")||null;
    const same=signature({items:existing.items,lines:existing.lines,discount:existing.discount,total:existing.total,net:existing.net,vat:existing.vat,metadata:pickPaymentMetadata(existing)})===signature({items:pair.sale.items,lines:pair.sale.lines,discount:pair.sale.discount,total:pair.sale.total,net:pair.sale.net,vat:pair.sale.vat,metadata:pickPaymentMetadata(pair.sale)});
    if(!same)throw new Error("Sale ID conflict: existing sale has different financial or line details");
    return {ledger,sale:existing,transaction:existingTx,duplicate:true};
  }
  const next={version:1,sales:[...ledger.sales,pair.sale],transactions:[...ledger.transactions,pair.transaction],updatedAt:now};
  // One localStorage write contains the sale and its transaction together.
  storage.setItem(key,JSON.stringify(next));
  return {ledger:next,sale:pair.sale,transaction:pair.transaction,duplicate:false};
}
export function auditLedger(value){
  const ledger=normalizeLedger(value);
  const saleCounts=new Map(),txCounts=new Map(),txBySale=new Map();
  let missingSaleIdCount=0,missingTransactionCount=0,duplicateSaleCount=0,duplicateTransactionCount=0,unlinkedTransactionCount=0;
  const mismatches=[];
  for(const sale of ledger.sales){
    if(sale.id==null||sale.id===""){missingSaleIdCount++;continue;}
    const id=String(sale.id);saleCounts.set(id,(saleCounts.get(id)||0)+1);
  }
  for(const tx of ledger.transactions){
    if(tx.id==null||tx.id==="")continue;
    txCounts.set(String(tx.id),(txCounts.get(String(tx.id))||0)+1);
    if((tx.type==="sale"||(!tx.type&&tx.saleId!=null))&&tx.saleId!=null){const id=String(tx.saleId);txBySale.set(id,(txBySale.get(id)||[]).concat(tx));}
    else if(tx.saleId==null)unlinkedTransactionCount++;
  }
  duplicateSaleCount=[...saleCounts.values()].reduce((n,count)=>n+Math.max(0,count-1),0);
  duplicateTransactionCount=[...txCounts.values()].reduce((n,count)=>n+Math.max(0,count-1),0);
  for(const sale of ledger.sales){
    const id=String(sale.id||"");
    if(!id)continue;
    const txs=txBySale.get(id)||[];
    if(txs.length===0)missingTransactionCount++;
    if(txs.length>1)mismatches.push({saleId:id,type:"duplicate-sale-transactions",count:txs.length});
    const tx=txs[0];
    if(tx){
      for(const field of ["total","net","vat","discount"])if(Math.round((Number(sale[field])||0)*100)!==Math.round((Number(tx[field])||0)*100))mismatches.push({saleId:id,type:"amount-mismatch",field,sale:Number(sale[field])||0,transaction:Number(tx[field])||0});
    }
  }
  const completed=ledger.sales.filter(s=>!s.isDraft&&s.status!=="voided"&&s.status!=="cancelled");
  const saleTotals={total:completed.reduce((n,s)=>n+(Number(s.total)||0),0),net:completed.reduce((n,s)=>n+(Number(s.net)||0),0),vat:completed.reduce((n,s)=>n+(Number(s.vat)||0),0)};
  const txTotals=ledger.transactions.filter(t=>t.type==="sale").reduce((a,t)=>({total:a.total+(Number(t.total)||0),net:a.net+(Number(t.net)||0),vat:a.vat+(Number(t.vat)||0)}),{total:0,net:0,vat:0});
  return {saleCount:ledger.sales.length,transactionCount:ledger.transactions.length,missingSaleIdCount,missingTransactionCount,duplicateSaleCount,duplicateTransactionCount,unlinkedTransactionCount,mismatches,saleTotals,transactionTotals:txTotals,totalsMatch:["total","net","vat"].every(k=>Math.round(saleTotals[k]*100)===Math.round(txTotals[k]*100))};
}
function mergeRecords(left=[],right=[],keyField="id"){
  const map=new Map(),conflicts=[];
  for(const record of [...left,...right]){
    const key=record?.[keyField];if(key==null||key==="")continue;
    const k=String(key),previous=map.get(k);
    if(!previous){map.set(k,record);continue;}
    const a=toTime(previous.updatedAt||previous.createdAt),b=toTime(record.updatedAt||record.createdAt);
    if(b>a){map.set(k,record);continue;}
    if(a>b)continue;
    const sigA=signature(previous),sigB=signature(record);
    if(sigA!==sigB){
      conflicts.push({key:k,left:previous,right:record});
      if(sigB<sigA)map.set(k,record);
    }
  }
  return {records:[...map.values()],conflicts};
}
export function mergeLedgers(left,right,now=new Date().toISOString()){
  const a=normalizeLedger(left),b=normalizeLedger(right);
  const sales=mergeRecords(a.sales,b.sales,"id");
  const transactions=mergeRecords(a.transactions,b.transactions,"id");
  return {ledger:{version:1,sales:sales.records,transactions:transactions.records,updatedAt:now},conflicts:[...sales.conflicts.map(c=>({...c,type:"sale"})),...transactions.conflicts.map(c=>({...c,type:"transaction"}))]};
}
export function migrateLegacyLedger(sales=[],transactions=[],now=new Date().toISOString()){
  const salesResult=mergeRecords([],sales,"id");
  const normalizedTransactions=(transactions||[]).map(tx=>tx&&tx.type==null&&tx.saleId!=null?{...tx,type:"sale",legacyTypeInferred:true}:tx);
  const txResult=mergeRecords([],normalizedTransactions,"id");
  const ledger={version:1,sales:salesResult.records,transactions:txResult.records,updatedAt:now,legacyMigration:true};
  return {ledger,audit:auditLedger(ledger),conflicts:[...salesResult.conflicts,...txResult.conflicts]};
}
export function writeLedgerAtomic(storage,ledger,key=DEFAULT_LEDGER_KEY){
  if(!storage||typeof storage.setItem!=="function")throw new TypeError("Storage adapter is required");
  storage.setItem(key,JSON.stringify(normalizeLedger(ledger)));
  return normalizeLedger(ledger);
}
export { DEFAULT_LEDGER_KEY };
