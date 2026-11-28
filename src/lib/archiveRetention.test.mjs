import test from "node:test";
import assert from "node:assert/strict";
import { compactSaleForArchive, compactArchiveDay, isOlderThanRetention } from "./archiveRetention.js";

test("90-day retention cutoff is strict and uses UTC calendar dates",()=>{
  const now=new Date("2026-11-28T12:00:00Z");
  assert.equal(isOlderThanRetention("2026-08-29",now,90),false);
  assert.equal(isOlderThanRetention("2026-08-28",now,90),true);
  assert.equal(isOlderThanRetention("invalid",now,90),false);
});

test("compact archive keeps financial, legal, tax and operational identifiers",()=>{
  const sale={id:"S-1",date:"2026-01-01",total:115,vat:15,net:100,discount:5,invoiceNumber:"INV-1",serialNumber:"1",uuid:"uuid",invoiceHash:"hash",previousInvoiceHash:"prev",branchId:"B1",tillId:"T1",cashierId:"C1",paymentMethod:"card",splitPayments:[{method:"cash",amount:10}],customerVatNumber:"VAT-1",items:[{id:"L1",name:"Item",qty:2,price:57.5,taxCategory:"S",vatRate:15,privateNote:"drop"}],receiptHtml:"large",rawXml:"large",photo:"data:image/png;base64,large",zatcaResponse:{status:"reported",errorMessage:"",rawXml:"secret",debug:"drop"}};
  const c=compactSaleForArchive(sale,"2026-11-28T00:00:00Z");
  assert.equal(c.total,115);assert.equal(c.vat,15);assert.equal(c.uuid,"uuid");assert.equal(c.invoiceHash,"hash");assert.equal(c.tillId,"T1");
  assert.deepEqual(c.items[0],{id:"L1",name:"Item",qty:2,price:57.5,taxCategory:"S",vatRate:15});
  assert.equal(c.receiptHtml,undefined);assert.equal(c.rawXml,undefined);assert.equal(c.photo,undefined);
  assert.deepEqual(c.zatcaResponse,{status:"reported",errorMessage:""});
  assert.equal(c.compactArchiveVersion,1);
});

test("compact archive day deduplicates by id and reconciles completed totals",()=>{
  const sales=[
    {id:"1",date:"2026-01-01",status:"completed",total:115,vat:15,items:[{name:"A",qty:1,price:115}]},
    {id:"1",date:"2026-01-01",status:"completed",total:115,vat:15,updatedAt:"2026-01-02T00:00:00Z",items:[{name:"A",qty:1,price:115}]},
    {id:"2",date:"2026-01-01",status:"voided",total:0,vat:0},
    {id:"3",date:"2026-01-01",status:"completed",total:23,vat:3},
  ];
  const r=compactArchiveDay(sales,"2026-01-01","2026-11-28T00:00:00Z");
  assert.equal(r.count,2);assert.equal(r.recordCount,3);assert.equal(r.total,138);assert.equal(r.vat,18);assert.equal(r.net,120);
  assert.equal(r.records[0].id,"1");assert.equal(r.records[0].updatedAt,"2026-01-02T00:00:00Z");
  assert.match(r.fingerprint,/^[0-9a-f]{8}$/);
});
