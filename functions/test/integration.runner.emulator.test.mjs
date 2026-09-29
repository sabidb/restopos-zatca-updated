// ═══════════════════════════════════════════════════════════════════════════
// Universal integration — invoice orchestration, Firestore-emulator test.
//
// Exercises the REAL runInvoiceForOrder against the Firestore emulator: the
// idempotency transaction, precondition gates and state transitions all run for
// real. Only the two genuinely external calls are stubbed — the ZATCA service
// HTTP call and the owner-auth token exchange — via the runner's injectable
// deps, so nothing leaves the machine.
//
// Run:
//   cd functions && npm install
//   firebase emulators:exec --project restopos-db --only firestore \
//     "node --test test/integration.runner.emulator.test.mjs"
//
// Without an emulator (plain `node --test`), every case skips, so the default
// suite stays green.
// ═══════════════════════════════════════════════════════════════════════════
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { runInvoiceForOrder } from "../integration/runner.js";
import { ORDER_STATES, PAYMENT_STATES, RECON_STATES } from "../integration/canonical.js";

const EMU = !!process.env.FIRESTORE_EMULATOR_HOST;
let db;

before(() => {
  if (!EMU) return;
  initializeApp({ projectId: process.env.GCLOUD_PROJECT || "restopos-db" });
  db = getFirestore();
});

// Stub the network: any /zatca/ URL returns the given ZATCA response; anything
// else (the webhook URL) returns a plain 200.
function stubFetch(zatcaResponse, ok = true, status = 200) {
  return async (url) => {
    if (String(url).includes("/zatca/")) return { ok, status, json: async () => zatcaResponse };
    return { ok: true, status: 200, json: async () => ({}) };
  };
}
const authStub = async () => "Bearer test-token";

const baseNormalized = () => ({
  items: [{ id: "1", name: "Meal", quantity: 2, unit_price: 50, line_total: 100, tax_rate: 0.15 }],
  adjustments: [],
  pricing: { items_subtotal: 100, discount_total: 0, charge_total: 0, tax_total: 13.04, grand_total: 100 },
  payment: { status: PAYMENT_STATES.CAPTURED, method: "cash", captured_amount: 100 },
  captured_amount: 100, document_hint: "simplified", customer: {},
});

async function seedOrder(id, over = {}) {
  const order = {
    restoposOrderId: "rpos_" + id, integrationId: "int_test", licenseKey: "RESTOTEST",
    externalOrderId: id, receivedAt: new Date().toISOString(),
    normalizedOrder: over.normalizedOrder || baseNormalized(),
    reconciliation: over.reconciliation || { status: RECON_STATES.RECONCILED },
    processingStatus: over.processingStatus || ORDER_STATES.VALIDATED,
    invoiceStatus: over.invoiceStatus || "NOT_CREATED",
  };
  const ref = db.collection("external_orders").doc("doc_" + id);
  await ref.set(order);
  return ref;
}

const integration = { integrationId: "int_test", licenseKey: "RESTOTEST", webhookUrl: "https://example.test/hook", webhookSecret: "whsec_x", pricesTaxInclusive: true };

test("invoices a captured, reconciled B2C order; idempotent on re-run", { skip: !EMU }, async () => {
  const ref = await seedOrder("E1");
  const r = await runInvoiceForOrder(ref, integration, {
    fetchImpl: stubFetch({ success: true, icv: 1, invoiceHash: "h", qr: "q", signedXml: "<x/>" }),
    authHeaderImpl: authStub,
  });
  assert.equal(r.ok, true);
  assert.equal(r.invoiceStatus, "REPORTED");
  assert.match(r.serialNumber, /^ONL-\d+$/);

  const after = (await ref.get()).data();
  assert.equal(after.invoiceStatus, "REPORTED");
  assert.equal(after.processingStatus, ORDER_STATES.COMPLETED);
  assert.equal(after.invoice.total, 100);
  assert.equal(after.invoice.channel, "report");

  // Second run must NOT create a second invoice.
  const r2 = await runInvoiceForOrder(ref, integration, { fetchImpl: stubFetch({ success: true }), authHeaderImpl: authStub });
  assert.equal(r2.skipped, true);

  // A webhook delivery was recorded.
  const wd = await db.collection("webhook_deliveries").where("externalOrderId", "==", "E1").get();
  assert.ok(wd.size >= 1);
});

test("refuses to invoice an order in reconciliation MISMATCH", { skip: !EMU }, async () => {
  const ref = await seedOrder("E2", { reconciliation: { status: RECON_STATES.MISMATCH } });
  await assert.rejects(() => runInvoiceForOrder(ref, integration, { fetchImpl: stubFetch({ success: true }), authHeaderImpl: authStub }));
  const after = (await ref.get()).data();
  assert.notEqual(after.invoiceStatus, "REPORTED");
});

test("refuses when payment is not captured", { skip: !EMU }, async () => {
  const norm = baseNormalized();
  norm.payment = { status: PAYMENT_STATES.PENDING, method: "cash", captured_amount: null };
  norm.captured_amount = null;
  const ref = await seedOrder("E3", { normalizedOrder: norm });
  await assert.rejects(() => runInvoiceForOrder(ref, integration, { fetchImpl: stubFetch({ success: true }), authHeaderImpl: authStub }));
});

test("marks FAILED when the ZATCA service rejects", { skip: !EMU }, async () => {
  const ref = await seedOrder("E4");
  await assert.rejects(() => runInvoiceForOrder(ref, integration, {
    fetchImpl: stubFetch({ success: false, error: "BR-KSA-XX failed" }, false, 400),
    authHeaderImpl: authStub,
  }));
  const after = (await ref.get()).data();
  assert.equal(after.invoiceStatus, "FAILED");
  assert.ok(after.invoiceError);
});

test("B2B order routes to clearance and stores cleared XML", { skip: !EMU }, async () => {
  const norm = baseNormalized();
  norm.document_hint = "standard";
  // Prices are VAT-inclusive (integration default), so the item gross must equal
  // the declared inclusive total of 115.
  norm.items = [{ id: "1", name: "Meal", quantity: 2, unit_price: 57.5, line_total: 115, tax_rate: 0.15 }];
  norm.customer = { name: "Acme", vat_number: "311111111100003", address: { street: "St", city: "Jeddah", postal_zone: "23456", building: "1234" } };
  norm.pricing = { items_subtotal: 115, discount_total: 0, charge_total: 0, tax_total: 15, grand_total: 115 };
  norm.payment = { status: PAYMENT_STATES.CAPTURED, method: "card", captured_amount: 115 };
  norm.captured_amount = 115;
  const ref = await seedOrder("E5", { normalizedOrder: norm });
  const r = await runInvoiceForOrder(ref, integration, {
    fetchImpl: stubFetch({ success: true, cleared: true, icv: 2, invoiceHash: "h2", clearedInvoiceXml: "<cleared/>" }),
    authHeaderImpl: authStub,
  });
  assert.equal(r.endpoint, "clearance");
  assert.equal(r.invoiceStatus, "CLEARED");
  const after = (await ref.get()).data();
  assert.equal(after.invoice.cleared_xml, "<cleared/>");
});
