import test from "node:test";
import assert from "node:assert/strict";
import {computePurchaseInvoice,auditPurchaseInvoice,auditPurchaseRegister} from "./purchases.js";

const valid={id:"P-1",supplierId:"SUP-1",supplierName:"Al Noor",supplierVatNumber:"300000000000003",supplierInvoiceNo:"INV-1",invoiceDate:"2026-11-01",hasValidEInvoice:true,lines:[{qty:1,unitCost:100}]};

test("auditPurchaseInvoice reconciles valid saved line invoice and recoverable VAT",()=>{
  const saved=computePurchaseInvoice(valid);
  const a=auditPurchaseInvoice(saved);
  assert.equal(a.financiallyReconciled,true);
  assert.deepEqual(a.warnings,[]);
  assert.equal(a.inputVatEligible,true);
  assert.equal(a.recoverableInputVat,15);
  assert.equal(a.totalDelta,0);
  assert.equal(a.vatDelta,0);
});

test("auditPurchaseInvoice flags saved invoice total and line VAT mismatch without mutation",()=>{
  const saved=computePurchaseInvoice(valid);
  const corrupted={...saved,total:116,vatAmount:16,lines:saved.lines.map(l=>({...l,vat:14}))};
  const a=auditPurchaseInvoice(corrupted);
  assert.equal(a.financiallyReconciled,false);
  assert.ok(a.warnings.includes("saved-total-mismatch"));
  assert.ok(a.warnings.includes("saved-vatAmount-mismatch"));
  assert.ok(a.warnings.includes("line-0-vat-mismatch"));
  assert.equal(corrupted.total,116);
  assert.equal(corrupted.vatAmount,16);
});

test("amount-only inclusive purchase reconciles with zero lines",()=>{
  const saved=computePurchaseInvoice({supplierName:"A",supplierVatNumber:"300000000000003",supplierInvoiceNo:"A1",invoiceDate:"2026-11-01",hasValidEInvoice:true,totalAmount:115,amountInclVat:true});
  const a=auditPurchaseInvoice(saved);
  assert.equal(a.financiallyReconciled,true);
  assert.equal(a.recoverableInputVat,15);
});

test("invalid input VAT evidence is surfaced and recoverable VAT remains zero",()=>{
  const saved=computePurchaseInvoice({...valid,supplierVatNumber:"123",hasValidEInvoice:true});
  const a=auditPurchaseInvoice(saved);
  assert.equal(a.inputVatEligible,false);
  assert.ok(a.inputVatReasons.includes("invalid-supplier-vat-number"));
  assert.equal(a.recoverableInputVat,0);
});

test("credit note audit preserves signed recoverable input VAT",()=>{
  const saved=computePurchaseInvoice({...valid,docType:"credit_note"});
  const a=auditPurchaseInvoice(saved);
  assert.equal(a.docType,"credit_note");
  assert.equal(a.recoverableInputVat,-15);
});

test("register audit flags exact duplicate purchase invoices and near duplicates",()=>{
  const exact=computePurchaseInvoice({...valid,id:"P-2"});
  const near=computePurchaseInvoice({...valid,id:"P-3",supplierInvoiceNo:"OTHER"});
  const register=auditPurchaseRegister([computePurchaseInvoice(valid),exact,near]);
  assert.equal(register.count,3);
  assert.equal(register.exactDuplicates.length,1);
  assert.equal(register.nearDuplicates.length,1);
  assert.equal(register.financiallyUnreconciledCount,0);
  assert.equal(register.recoverableInputVat,45);
});
