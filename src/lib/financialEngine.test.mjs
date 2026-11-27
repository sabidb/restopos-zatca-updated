import { test } from "node:test";
import assert from "node:assert/strict";
import { splitInclusiveCents, calculateSale, assertSaleReconciles } from "./financialEngine.js";
test("inclusive split reconciles standard and zero rates",()=>{assert.deepEqual(splitInclusiveCents(11500,15),{netCents:10000,vatCents:1500,totalCents:11500});assert.deepEqual(splitInclusiveCents(10000,0),{netCents:10000,vatCents:0,totalCents:10000});});
test("sale with no discount reconciles",()=>{const r=calculateSale([{id:"a",qty:1,price:115},{id:"b",qty:2,price:23}],0);assert.equal(r.subtotal,161);assert.equal(r.total,161);assertSaleReconciles(r);});
test("discount allocation deterministic and reconciled",()=>{const r=calculateSale([{id:"a",qty:1,price:115},{id:"b",qty:1,price:23}],5);assert.equal(r.total,133);assert.equal(r.lines.reduce((s,l)=>s+l.discount,0),5);assertSaleReconciles(r);});
test("mixed VAT rates reconcile",()=>{const r=calculateSale([{id:"std",qty:1,price:115,vatRate:15},{id:"zero",qty:1,price:50,vatRate:0}],0);assert.equal(r.total,165);assert.equal(r.vat,15);assertSaleReconciles(r);});
test("reject invalid discounts and totals",()=>{assert.throws(()=>calculateSale([{qty:1,price:10}],-1),/Discount/);assert.throws(()=>calculateSale([{qty:1,price:10}],11),/Discount/);assert.throws(()=>splitInclusiveCents(-1,15),/non-negative/);});
