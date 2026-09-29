// ═══════════════════════════════════════════════════════════════════════════
// Universal integration — invoice-request builder & webhook signing (pure).
// Run:  node --test test/
// The central guarantee tested here: whatever the external pricing looks like,
// the invoice the builder produces has a total that ties out to the order's
// declared/captured amount, using only the zatca-service's per-line contract.
// ═══════════════════════════════════════════════════════════════════════════
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOrder } from "../integration/canonical.js";
import { buildInvoiceRequest, checkInvoiceTotals, paymentMeansCode } from "../integration/invoice.js";
import { signWebhook, verifyWebhook, buildWebhookEvent, WEBHOOK_EVENTS } from "../integration/webhook.js";

const ctx = { integrationId: "int_x", licenseKey: "RESTO123" };
const build = (payload, opts) => {
  const { canonical } = normalizeOrder(payload, ctx);
  return { canonical, ...buildInvoiceRequest(canonical, { licenseKey: "RESTO123", serialNumber: "ONL-1000", ...opts }) };
};
const near = (a, b, t = 0.01) => Math.abs(a - b) <= t;

test("simple B2C order ties out and routes to report", () => {
  const { canonical, endpoint, request, computed } = build({
    external_order_id: "A1",
    items: [{ name: "Meal", quantity: 2, unit_price: 50 }],
    pricing: { items_subtotal: 100, tax: { amount: 13.04 }, grand_total: 100 },
    payment: { status: "captured", captured_amount: 100, method: "mada" },
  });
  assert.equal(endpoint, "report");
  assert.ok(near(computed.total, 100));
  assert.equal(request.invoice.line_items.length, 1);
  assert.equal(request.invoice.payment_means_code, "48"); // mada
  assert.ok(checkInvoiceTotals(canonical, computed).ok);
});

test("promotion + delivery: charge becomes a line, discount allocated, total ties out", () => {
  const { endpoint, request, computed, canonical } = build({
    external_order_id: "A2",
    items: [{ name: "A", quantity: 1, unit_price: 100 }],
    pricing: {
      items_subtotal: 100,
      adjustments: [{ type: "promotion", amount: -20 }, { type: "delivery_fee", amount: 5 }],
      tax: { amount: 11.09 }, grand_total: 85,
    },
    payment: { status: "captured", captured_amount: 85 },
  });
  assert.equal(endpoint, "report");
  assert.ok(near(computed.total, 85), `total ${computed.total}`);
  // Original item line + one charge line for delivery.
  assert.equal(request.invoice.line_items.length, 2);
  assert.ok(checkInvoiceTotals(canonical, computed).ok);
});

test("multiple discounts all reduce the total correctly", () => {
  const { computed, canonical } = build({
    external_order_id: "A3",
    items: [{ name: "A", quantity: 1, unit_price: 100 }],
    pricing: {
      adjustments: [{ type: "promotion", amount: -10 }, { type: "coupon", amount: -5 }, { type: "loyalty", amount: -3 }],
      items_subtotal: 100, tax: { amount: 10.7 }, grand_total: 82,
    },
    payment: { captured_amount: 82 },
  });
  assert.ok(near(computed.total, 82), `total ${computed.total}`);
  assert.ok(checkInvoiceTotals(canonical, computed).ok);
});

test("free item (price 0) invoices at total of paid items", () => {
  const { request, computed, canonical } = build({
    external_order_id: "A4",
    items: [{ name: "Burger", quantity: 1, unit_price: 20 }, { name: "Free Drink", quantity: 1, unit_price: 0 }],
    pricing: { items_subtotal: 20, tax: { amount: 2.61 }, grand_total: 20 },
    payment: { captured_amount: 20 },
  });
  assert.equal(request.invoice.line_items.length, 2);
  assert.ok(near(computed.total, 20));
  assert.ok(checkInvoiceTotals(canonical, computed).ok);
});

test("acceptance scenario (spec §37): 50+30 −10 −5 +8 +2 = 75 captured", () => {
  const { computed, canonical, request } = build({
    external_order_id: "A5",
    items: [{ name: "Item 1", quantity: 1, unit_price: 50 }, { name: "Item 2", quantity: 1, unit_price: 30 }],
    pricing: {
      items_subtotal: 80,
      adjustments: [
        { type: "promotion", amount: -10 }, { type: "coupon", amount: -5 },
        { type: "delivery_fee", amount: 8 }, { type: "service_charge", amount: 2 },
      ],
      tax: { amount: 9.78 }, grand_total: 75,
    },
    payment: { status: "captured", captured_amount: 75 },
  });
  assert.ok(near(computed.total, 75), `total ${computed.total}`);
  // 2 item lines + 2 charge lines.
  assert.equal(request.invoice.line_items.length, 4);
  assert.ok(checkInvoiceTotals(canonical, computed).ok);
});

test("B2B buyer routes to clearance and includes buyer party", () => {
  const { endpoint, request } = build({
    external_order_id: "A6",
    items: [{ name: "A", quantity: 1, unit_price: 100 }],
    customer: { name: "Acme Trading", vat_number: "311111111100003", address: { street: "Prince Sultan Rd", city: "Jeddah", postal_zone: "23456", building: "4321" } },
    pricing: { items_subtotal: 100, tax: { amount: 15 }, grand_total: 115 },
    payment: { captured_amount: 115 },
  });
  assert.equal(endpoint, "clearance");
  assert.equal(request.invoice.buyer.vat_number, "311111111100003");
  assert.equal(request.invoice.buyer.address.city, "Jeddah");
});

test("tax-exclusive input prices produce a gross-inclusive total", () => {
  const { computed } = build({
    external_order_id: "A7",
    items: [{ name: "A", quantity: 1, unit_price: 100 }],
    pricing: { items_subtotal: 100, tax: { amount: 15 }, grand_total: 115 },
    payment: { captured_amount: 115 },
  }, { pricesTaxInclusive: false });
  assert.ok(near(computed.total, 115), `total ${computed.total}`);
});

test("checkInvoiceTotals rejects invoicing more than captured", () => {
  const { canonical } = normalizeOrder({
    external_order_id: "A8",
    items: [{ name: "A", quantity: 1, unit_price: 100 }],
    pricing: { items_subtotal: 100, tax: { amount: 15 }, grand_total: 115 },
    payment: { captured_amount: 100 }, // captured LESS than the invoice would be
  }, ctx);
  const built = buildInvoiceRequest(canonical, { licenseKey: "RESTO123", serialNumber: "ONL-1" });
  const chk = checkInvoiceTotals(canonical, built.computed);
  assert.equal(chk.ok, false);
});

test("credit note carries original reference and reason", () => {
  const { request } = build({
    external_order_id: "A9",
    items: [{ name: "A", quantity: 1, unit_price: 100 }],
    pricing: { items_subtotal: 100, tax: { amount: 15 }, grand_total: 115 },
    payment: { captured_amount: 115 },
  }, { documentType: "credit_note", originalInvoiceNumber: "ONL-500", reason: "Customer returned order" });
  assert.equal(request.invoice.document_type, "credit_note");
  assert.equal(request.invoice.original_invoice_number, "ONL-500");
  assert.equal(request.invoice.reason, "Customer returned order");
});

test("payment means map covers common methods with a safe default", () => {
  assert.equal(paymentMeansCode("cash"), "10");
  assert.equal(paymentMeansCode("apple_pay"), "48");
  assert.equal(paymentMeansCode("something-unknown"), "10");
});

test("webhook signature verifies and rejects tampering", () => {
  const body = JSON.stringify(buildWebhookEvent(WEBHOOK_EVENTS.INVOICE_REPORTED, { restoposOrderId: "rpos_1", externalOrderId: "A1", integrationId: "int_x" }));
  const { header } = signWebhook("whsec_test", body, 1700000000);
  assert.equal(header, `t=1700000000,v1=${header.split("v1=")[1]}`);
  assert.equal(verifyWebhook("whsec_test", body, header), true);
  assert.equal(verifyWebhook("whsec_wrong", body, header), false);
  assert.equal(verifyWebhook("whsec_test", body + "x", header), false);
});
