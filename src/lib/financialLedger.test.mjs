import test from "node:test";
import assert from "node:assert/strict";
import {appendSaleAndTransaction,auditLedger,mergeLedgers,migrateLegacyLedger,writeLedgerAtomic,DEFAULT_LEDGER_KEY} from "./financialLedger.js";

function storage(){const map=new Map();return {map,getItem:k=>map.has(k)?map.get(k):null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k)};}

test("append writes sale and transaction atomically under one key with canonical totals",()=>{
  const s=storage();
  const r=appendSaleAndTransaction(s,{saleId:"S-1",items:[{name:"Food",qty:1,price:115}],metadata:{branchId:"B1",tillId:"T1",paymentMethod:"card",payments:[{method:"card",amount:115}]}},DEFAULT_LEDGER_KEY,"2026-11-28T00:00:00Z");
  assert.equal(s.map.size,1);
  assert.equal(r.ledger.sales.length,1);assert.equal(r.ledger.transactions.length,1);
  assert.equal(r.sale.total,115);assert.equal(r.sale.vat,15);assert.equal(r.sale.net,100);
  assert.equal(r.transaction.saleId,"S-1");assert.equal(r.transaction.total,115);assert.equal(r.transaction.vat,15);
  assert.equal(r.duplicate,false);
  assert.equal(auditLedger(r.ledger).totalsMatch,true);
});

test("append is idempotent for exact sale ID and rejects conflicting reuse",()=>{
  const s=storage();
  appendSaleAndTransaction(s,{saleId:"S-2",items:[{name:"A",qty:1,price:23}]},DEFAULT_LEDGER_KEY,"2026-11-28T00:00:00Z");
  const duplicate=appendSaleAndTransaction(s,{saleId:"S-2",items:[{name:"A",qty:1,price:23}]},DEFAULT_LEDGER_KEY,"2026-11-28T00:01:00Z");
  assert.equal(duplicate.duplicate,true);assert.equal(duplicate.ledger.sales.length,1);assert.equal(duplicate.ledger.transactions.length,1);
  assert.throws(()=>appendSaleAndTransaction(s,{saleId:"S-2",items:[{name:"Different",qty:1,price:35}]},DEFAULT_LEDGER_KEY,"2026-11-28T00:02:00Z"),/Sale ID conflict/);
  assert.equal(JSON.parse(s.getItem(DEFAULT_LEDGER_KEY)).sales.length,1);
});

test("audit detects missing transaction and amount mismatches",()=>{
  const ledger={sales:[{id:"S-3",status:"completed",total:115,net:100,vat:15,discount:0}],transactions:[{id:"tx3",saleId:"S-3",type:"sale",total:114,net:99,vat:15,discount:0}]};
  const a=auditLedger(ledger);
  assert.equal(a.missingTransactionCount,0);assert.equal(a.totalsMatch,false);
  assert.equal(a.mismatches.length,2);
  const missing=auditLedger({sales:[{id:"S-4",total:1,net:1,vat:0}],transactions:[]});
  assert.equal(missing.missingTransactionCount,1);
});

test("merge ledgers deduplicates sale and transaction IDs, prefers newer version",()=>{
  const left={sales:[{id:"S-5",total:23,updatedAt:"2026-11-28T00:00:00Z"}],transactions:[{id:"tx:S-5",saleId:"S-5",total:23,updatedAt:"2026-11-28T00:00:00Z"}]};
  const right={sales:[{id:"S-5",total:35,updatedAt:"2026-11-28T01:00:00Z"},{id:"S-6",total:10}],transactions:[{id:"tx:S-5",saleId:"S-5",total:35,updatedAt:"2026-11-28T01:00:00Z"},{id:"tx:S-6",saleId:"S-6",total:10}]};
  const m=mergeLedgers(left,right,"2026-11-28T02:00:00Z");
  assert.equal(m.ledger.sales.length,2);assert.equal(m.ledger.transactions.length,2);
  assert.equal(m.ledger.sales.find(s=>s.id==="S-5").total,35);
  assert.equal(m.conflicts.length,0);
});

test("merge reports equal-time financial conflicts instead of silently hiding them",()=>{
  const a={sales:[{id:"S-7",total:23,updatedAt:"2026-11-28T00:00:00Z"}],transactions:[]};
  const b={sales:[{id:"S-7",total:35,updatedAt:"2026-11-28T00:00:00Z"}],transactions:[]};
  const m=mergeLedgers(a,b);
  assert.equal(m.conflicts.length,1);assert.equal(m.conflicts[0].type,"sale");
});

test("legacy migration preserves saved totals without recalculation",()=>{
  const sales=[{id:"L-1",total:115,vat:15,net:100,items:[{name:"A",price:115,qty:1}]},{id:"L-1",total:115,vat:15,net:100}];
  const tx=[{id:"T-1",saleId:"L-1",total:115,vat:15,net:100},{id:"T-2",saleId:"missing",total:10}];
  const m=migrateLegacyLedger(sales,tx,"2026-11-28T00:00:00Z");
  assert.equal(m.ledger.sales.length,1);assert.equal(m.ledger.transactions.length,2);
  assert.equal(m.ledger.sales[0].total,115);assert.equal(m.ledger.sales[0].vat,15);
  assert.equal(m.audit.missingTransactionCount,0);
  assert.equal(m.audit.unlinkedTransactionCount,1);
  assert.equal(m.audit.totalsMatch,true);
  assert.equal(m.ledger.legacyMigration,true);
});

test("writeLedgerAtomic stores a normalized ledger in one storage write",()=>{
  const s=storage(),ledger={sales:[{id:"W-1"}],transactions:[{id:"txW-1",saleId:"W-1"}]};
  const written=writeLedgerAtomic(s,ledger);
  assert.equal(s.map.size,1);assert.equal(written.version,1);assert.equal(JSON.parse(s.getItem(DEFAULT_LEDGER_KEY)).transactions.length,1);
});
