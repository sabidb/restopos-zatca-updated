import { test } from "node:test";
import assert from "node:assert/strict";
import { splitInclusiveCents, calculateSale, assertSaleReconciles } from "./financialEngine.js";
import { vatFromInclusive } from "./tax.js";
test("inclusive split reconciles standard and zero rates",()=>{assert.deepEqual(splitInclusiveCents(11500,15),{netCents:10000,vatCents:1500,totalCents:11500});assert.deepEqual(splitInclusiveCents(10000,0),{netCents:10000,vatCents:0,totalCents:10000});});
test("sale with no discount reconciles",()=>{const r=calculateSale([{id:"a",qty:1,price:115},{id:"b",qty:2,price:23}],0);assert.equal(r.subtotal,161);assert.equal(r.total,161);assertSaleReconciles(r);});
test("discount allocation deterministic and reconciled",()=>{const r=calculateSale([{id:"a",qty:1,price:115},{id:"b",qty:1,price:23}],5);assert.equal(r.total,133);assert.equal(r.lines.reduce((s,l)=>s+l.discount,0),5);assertSaleReconciles(r);});
test("mixed VAT rates reconcile",()=>{const r=calculateSale([{id:"std",qty:1,price:115,vatRate:15},{id:"zero",qty:1,price:50,vatRate:0}],0);assert.equal(r.total,165);assert.equal(r.vat,15);assertSaleReconciles(r);});
test("reject invalid discounts and totals",()=>{assert.throws(()=>calculateSale([{qty:1,price:10}],-1),/Discount/);assert.throws(()=>calculateSale([{qty:1,price:10}],11),/Discount/);assert.throws(()=>splitInclusiveCents(-1,15),/non-negative/);});

test("empty sale is zero and reconciles",()=>{const r=calculateSale([],0);assert.equal(r.total,0);assert.equal(r.vat,0);assertSaleReconciles(r);});
test("fractional quantities are rounded to cents per line",()=>{const r=calculateSale([{qty:0.5,price:10,vatRate:15}],0);assert.equal(r.total,5);assert.equal(r.net,4.35);assert.equal(r.vat,0.65);assertSaleReconciles(r);});
test("negative unit prices are rejected",()=>{assert.throws(()=>calculateSale([{qty:1,price:-1}],0),/non-negative/);});
test("unsafe cent totals are rejected",()=>{assert.throws(()=>calculateSale([{qty:1,price:1e14}],0),/safe cent precision/);});
test("discount allocation handles cent-level ties deterministically",()=>{const r=calculateSale([{id:"a",qty:1,price:1},{id:"b",qty:1,price:1},{id:"c",qty:1,price:1}],0.01);assert.deepEqual(r.lines.map(l=>l.discount),[0.01,0,0]);assertSaleReconciles(r);});

test("aggregate VAT rounding matches existing transaction path for standard-rate totals",()=>{for(const amount of [0.01,0.05,0.35,1,10,23,35,115,999.99]){const r=calculateSale([{qty:1,price:amount}],0);assert.equal(r.vat,vatFromInclusive(amount),`VAT mismatch for ${amount}`);assertSaleReconciles(r);}});
test("many one-cent lines aggregate VAT before rounding instead of understating it",()=>{const r=calculateSale(Array.from({length:100},()=>({qty:1,price:0.01})),0);assert.equal(r.total,1);assert.equal(r.net,0.87);assert.equal(r.vat,0.13);assertSaleReconciles(r);});

test("standard-rate discount VAT matches existing transaction total path",()=>{const r=calculateSale([{qty:1,price:115},{qty:1,price:23}],5);assert.equal(r.total,133);assert.equal(r.vat,vatFromInclusive(133));assertSaleReconciles(r);});
