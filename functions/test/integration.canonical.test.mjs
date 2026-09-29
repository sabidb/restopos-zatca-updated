// ═══════════════════════════════════════════════════════════════════════════
// Universal integration — canonical model, normalization & reconciliation.
//
// Pure unit tests (no emulator, no network). Run:  node --test test/
// Cover the acceptance scenarios from the integration spec §34.
// ═══════════════════════════════════════════════════════════════════════════
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeOrder, reconcile, buildOrderDocId, payloadHash,
  RECON_STATES, PAYMENT_STATES,
} from "../integration/canonical.js";

const ctx = { integrationId: "int_x", licenseKey: "RESTO123" };

test("normal order: 100 subtotal, 15 tax, 115 total, 115 captured → reconciled", () => {
  const { ok, canonical } = normalizeOrder({
    external_order_id: "APP-1",
    items: [{ name: "Meal", quantity: 2, unit_price: 50 }],
    pricing: { items_subtotal: 100, tax: { amount: 15 }, grand_total: 115 },
    payment: { status: "captured", captured_amount: 115 },
  }, ctx);
  assert.equal(ok, true);
  assert.equal(canonical.pricing.items_subtotal, 100);
  assert.equal(canonical.pricing.tax_total, 15);
  assert.equal(canonical.captured_amount, 115);
  const r = reconcile(canonical);
  assert.equal(r.status, RECON_STATES.RECONCILED);
  assert.equal(r.reconciled, true);
});

test("promotion + delivery: components preserved and reconcile", () => {
  const { canonical } = normalizeOrder({
    external_order_id: "APP-2",
    items: [{ name: "A", quantity: 1, unit_price: 100 }],
    pricing: {
      items_subtotal: 100,
      adjustments: [
        { type: "promotion", code: "SUMMER20", amount: -20 },
        { type: "delivery_fee", amount: 5 },
      ],
      tax: { amount: 12.75 }, // 15% of (100 - 20 + 5) = 85 → 12.75
      grand_total: 97.75,
    },
    payment: { status: "captured", captured_amount: 97.75 },
  }, ctx);
  assert.equal(canonical.pricing.discount_total, 20);
  assert.equal(canonical.pricing.charge_total, 5);
  assert.equal(canonical.adjustments.length, 2);
  assert.equal(canonical.adjustments[0].direction, "discount");
  assert.equal(canonical.adjustments[1].direction, "charge");
  const r = reconcile(canonical);
  assert.equal(r.status, RECON_STATES.RECONCILED);
});

test("multiple discounts are each traceable", () => {
  const { canonical } = normalizeOrder({
    external_order_id: "APP-3",
    items: [{ name: "A", quantity: 1, unit_price: 100 }],
    pricing: {
      adjustments: [
        { type: "promotion", amount: -10 },
        { type: "coupon", code: "X", amount: -5 },
        { type: "loyalty", amount: -3 },
      ],
      items_subtotal: 100, tax: { amount: 12.3 }, grand_total: 94.3,
    },
    payment: { captured_amount: 94.3 },
  }, ctx);
  assert.equal(canonical.pricing.discount_total, 18);
  assert.deepEqual(canonical.adjustments.map((a) => a.type), ["promotion", "coupon", "loyalty"]);
});

test("free item (unit_price 0) is accepted, not rejected", () => {
  const { ok, errors } = normalizeOrder({
    external_order_id: "APP-4",
    items: [{ name: "Burger", quantity: 1, unit_price: 20 }, { name: "Free Drink", quantity: 1, unit_price: 0 }],
    pricing: { items_subtotal: 20, tax: { amount: 3 }, grand_total: 23 },
    payment: { captured_amount: 23 },
  }, ctx);
  assert.equal(ok, true);
  assert.equal(errors.length, 0);
});

test("partial refund tracked in net captured", () => {
  const { canonical } = normalizeOrder({
    external_order_id: "APP-5",
    items: [{ name: "A", quantity: 1, unit_price: 100 }],
    pricing: { items_subtotal: 100, tax: { amount: 0 }, grand_total: 100 },
    payment: { status: "partially_refunded", captured_amount: 100, refunded_amount: 20 },
  }, ctx);
  assert.equal(canonical.payment.captured_amount, 100);
  assert.equal(canonical.payment.refunded_amount, 20);
  assert.equal(canonical.payment.net_captured_amount, 80);
  assert.equal(canonical.payment.status, PAYMENT_STATES.PARTIALLY_REFUNDED);
});

test("payment mismatch is flagged, never silently corrected", () => {
  const { canonical } = normalizeOrder({
    external_order_id: "APP-6",
    items: [{ name: "A", quantity: 1, unit_price: 100 }],
    pricing: { items_subtotal: 100, tax: { amount: 0 }, grand_total: 100 },
    payment: { status: "captured", captured_amount: 95 },
  }, ctx);
  const r = reconcile(canonical);
  assert.equal(r.status, RECON_STATES.MISMATCH);
  assert.equal(r.capture_delta, -5);
  // The declared total is untouched — no rounding "fix".
  assert.equal(canonical.pricing.grand_total, 100);
});

test("arithmetic mismatch (components don't sum to total) is flagged", () => {
  const { canonical } = normalizeOrder({
    external_order_id: "APP-7",
    items: [{ name: "A", quantity: 1, unit_price: 100 }],
    pricing: {
      items_subtotal: 100,
      adjustments: [{ type: "discount", amount: -20 }, { type: "service_charge", amount: 5 }],
      tax: { amount: 12 }, grand_total: 70, // should be 100 - 20 + 5 + 12 = 97
    },
    payment: { captured_amount: 70 },
  }, ctx);
  const r = reconcile(canonical);
  assert.equal(r.status, RECON_STATES.MISMATCH);
  assert.equal(r.computed_grand_total, 97);
});

test("missing external_order_id and empty items produce validation errors", () => {
  const { ok, errors } = normalizeOrder({ items: [] }, ctx);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.field === "external_order_id"));
  assert.ok(errors.some((e) => e.field === "items"));
});

test("field-name aliases normalize (grand_total via 'payable', qty via 'qty')", () => {
  const { canonical } = normalizeOrder({
    order_id: "APP-8",
    line_items: [{ title: "A", qty: 3, price: 10 }],
    payable: 34.5, tax_amount: 4.5,
    payment: { captured_amount: 34.5 },
  }, ctx);
  assert.equal(canonical.external_order_id, "APP-8");
  assert.equal(canonical.items[0].quantity, 3);
  assert.equal(canonical.pricing.grand_total, 34.5);
  assert.equal(canonical.pricing.tax_total, 4.5);
});

test("vat_percent given as 15 or 0.15 both normalize to a fraction", () => {
  const a = normalizeOrder({ external_order_id: "APP-9a", items: [{ name: "A", quantity: 1, unit_price: 1, vat_percent: 15 }] }, ctx).canonical;
  const b = normalizeOrder({ external_order_id: "APP-9b", items: [{ name: "A", quantity: 1, unit_price: 1, VAT_percent: 0.15 }] }, ctx).canonical;
  assert.equal(a.items[0].tax_rate, 0.15);
  assert.equal(b.items[0].tax_rate, 0.15);
});

test("buyer VAT number marks the order as a standard (B2B) document", () => {
  const { canonical } = normalizeOrder({
    external_order_id: "APP-10",
    items: [{ name: "A", quantity: 1, unit_price: 100 }],
    customer: { name: "Acme", vat_number: "311111111100003" },
    pricing: { items_subtotal: 100, tax: { amount: 15 }, grand_total: 115 },
    payment: { captured_amount: 115 },
  }, ctx);
  assert.equal(canonical.document_hint, "standard");
  assert.equal(canonical.customer.vat_number, "311111111100003");
});

test("idempotency key is deterministic per (integration, order) and differs across them", () => {
  const a = buildOrderDocId("int_1", "APP-1");
  const b = buildOrderDocId("int_1", "APP-1");
  const c = buildOrderDocId("int_2", "APP-1");
  const d = buildOrderDocId("int_1", "APP-2");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
  assert.throws(() => buildOrderDocId("", "APP-1"));
});

test("payloadHash is stable regardless of key order", () => {
  const h1 = payloadHash({ a: 1, b: { c: 2, d: 3 } });
  const h2 = payloadHash({ b: { d: 3, c: 2 }, a: 1 });
  assert.equal(h1, h2);
});

test("no captured amount → pending, not mismatch", () => {
  const { canonical } = normalizeOrder({
    external_order_id: "APP-11",
    items: [{ name: "A", quantity: 1, unit_price: 100 }],
    pricing: { items_subtotal: 100, tax: { amount: 0 }, grand_total: 100 },
    payment: { status: "pending" },
  }, ctx);
  const r = reconcile(canonical);
  assert.equal(r.status, RECON_STATES.PENDING);
  assert.equal(canonical.payment.status, PAYMENT_STATES.PENDING);
});
