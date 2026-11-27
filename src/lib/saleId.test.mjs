import { test } from "node:test";
import assert from "node:assert/strict";
import { getDeviceInvoicePrefix, buildSaleInvoiceId, buildDraftInvoiceId, buildZatcaInvoiceNumber, DEVICE_INVOICE_PREFIX_KEY } from "./saleId.js";
function mem(){const m=new Map();return{getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k)};}
test("device prefix persists and stable per till",()=>{
  const s=mem();const first=getDeviceInvoicePrefix(s);
  assert.match(first,/^[A-Z0-9]{6}$/);
  assert.equal(s.getItem(DEVICE_INVOICE_PREFIX_KEY),first);
  assert.equal(getDeviceInvoicePrefix(s),first);
});
test("two devices with same sequence get different sale IDs",()=>{
  const a=mem(),b=mem();
  a.setItem(DEVICE_INVOICE_PREFIX_KEY,"ABC123");b.setItem(DEVICE_INVOICE_PREFIX_KEY,"XYZ789");
  assert.notEqual(buildSaleInvoiceId(44,getDeviceInvoicePrefix(a)),buildSaleInvoiceId(44,getDeviceInvoicePrefix(b)));
  assert.notEqual(buildDraftInvoiceId(44,"A",getDeviceInvoicePrefix(a)),buildDraftInvoiceId(44,"A",getDeviceInvoicePrefix(b)));
});
test("sale and draft IDs are deterministic for a given device and sequence",()=>{
  assert.equal(buildSaleInvoiceId(7,"ABC123"),"INV-ABC123-7");
  assert.equal(buildDraftInvoiceId(7,"C","ABC123"),"D-ABC123-7C");
});

test("ZATCA invoice reference is unique across device sequences with same ICV",()=>{
  assert.notEqual(buildZatcaInvoiceNumber(1001,"ABC123"),buildZatcaInvoiceNumber(1001,"XYZ789"));
  assert.equal(buildZatcaInvoiceNumber(1001,"ABC123"),"INV-ABC123-001001");
});
