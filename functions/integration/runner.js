// ═══════════════════════════════════════════════════════════════════════════
// UNIVERSAL INTEGRATION — invoice orchestration (Phase 3)
//
// Turns an accepted external order into a ZATCA invoice by calling the EXISTING
// zatca-service (/zatca/report for B2C, /zatca/clearance for B2B), then persists
// the result, advances the invoice state, and fires the lifecycle webhook.
//
// This is the only impure part of the integration engine (Firebase auth + a
// network call to the ZATCA service + Firestore writes). It is exposed as an
// EXPLICIT callable — nothing auto-fires on ingest — so deploying it does not
// change any existing behaviour until it is invoked. Its pure inputs
// (invoice-request building, total checks, webhook signing) are unit-tested in
// their own modules.
//
// Config it needs (server-side only, never sent to the external app):
//   ZATCA_SERVICE_URL       — defaults to the deployed Cloud Run service.
//   FIREBASE_WEB_API_KEY    — or config/secrets.webApiKey — used to exchange a
//                             minted custom token for an ID token so we can call
//                             the zatca-service as the license owner.
// ═══════════════════════════════════════════════════════════════════════════
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { buildInvoiceRequest, checkInvoiceTotals } from "./invoice.js";
import { signWebhook, buildWebhookEvent, WEBHOOK_EVENTS } from "./webhook.js";
import { ORDER_STATES, PAYMENT_STATES, RECON_STATES } from "./canonical.js";

const REGION = "us-central1";
const ADMIN_EMAIL = "8742sabithsaleem@gmail.com";
const ZATCA_SERVICE_URL = (process.env.ZATCA_SERVICE_URL || "https://zatca-service-82816670819.me-central1.run.app").replace(/\/$/, "");

const db = () => getFirestore();

async function getWebApiKey() {
  if (process.env.FIREBASE_WEB_API_KEY) return process.env.FIREBASE_WEB_API_KEY;
  try {
    const snap = await db().collection("config").doc("secrets").get();
    if (snap.exists && snap.data().webApiKey) return String(snap.data().webApiKey);
  } catch (e) { /* fall through */ }
  return "";
}

// Authenticate to the zatca-service AS the license owner: mint a custom token
// for uid = licenseKey (the service accepts uid === licenseKey), then exchange
// it for an ID token via Identity Toolkit. Returns "Bearer <idToken>".
async function ownerAuthHeader(licenseKey) {
  const customToken = await getAuth().createCustomToken(String(licenseKey));
  const apiKey = await getWebApiKey();
  if (!apiKey) throw new HttpsError("failed-precondition", "FIREBASE_WEB_API_KEY (or config/secrets.webApiKey) is not configured; cannot authenticate to the ZATCA service.");
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.idToken) throw new HttpsError("internal", `Token exchange failed: ${data.error?.message || res.status}`);
  return `Bearer ${data.idToken}`;
}

// Allocate a per-license online invoice serial number (ONL-1000, ONL-1001, …)
// in a transaction so concurrent orders never collide. Separate from the POS
// counter so the two number spaces don't clash.
async function nextSerial(licenseKey) {
  const ref = db().collection("integration_counters").doc(String(licenseKey));
  const n = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists && Number.isFinite(snap.data().onlineInvoiceNo) ? snap.data().onlineInvoiceNo : 999;
    const next = cur + 1;
    tx.set(ref, { onlineInvoiceNo: next, updatedAt: new Date().toISOString() }, { merge: true });
    return next;
  });
  return `ONL-${n}`;
}

// Best-effort outbound webhook with a recorded delivery. Never throws.
async function deliverWebhook(integration, order, event, extra) {
  const url = integration && integration.webhookUrl;
  const body = buildWebhookEvent(event, order, extra);
  const bodyStr = JSON.stringify(body);
  const rec = {
    integrationId: integration?.integrationId || null, licenseKey: order.licenseKey || null,
    externalOrderId: order.externalOrderId || null, event, url: url || null, createdAt: new Date().toISOString(),
  };
  try {
    if (!url) { rec.status = "skipped"; rec.detail = "No webhook URL configured."; }
    else {
      const sig = signWebhook(integration.webhookSecret || "", bodyStr);
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Restopos-Signature": sig.header, "X-Restopos-Event": event }, body: bodyStr });
      rec.status = res.ok ? "delivered" : "failed";
      rec.httpStatus = res.status;
    }
  } catch (e) { rec.status = "failed"; rec.detail = String(e.message || e); }
  db().collection("webhook_deliveries").add(rec).catch(() => {});
  return rec.status;
}

/**
 * Create the ZATCA invoice for one already-received order.
 * Idempotent: a transaction flips invoiceStatus NOT_CREATED → PROCESSING so a
 * second concurrent/retried call cannot double-invoice.
 */
export async function runInvoiceForOrder(orderRef, integration, opts = {}) {
  const snap = await orderRef.get();
  if (!snap.exists) throw new HttpsError("not-found", "Order not found.");
  const order = snap.data();

  // Preconditions (spec §3/§4/§6): validated, captured, reconciled, not yet invoiced.
  if (order.processingStatus === ORDER_STATES.REJECTED) throw new HttpsError("failed-precondition", "Order was rejected; cannot invoice.");
  const pay = order.normalizedOrder?.payment?.status;
  if (pay !== PAYMENT_STATES.CAPTURED && pay !== PAYMENT_STATES.PARTIALLY_CAPTURED && pay !== PAYMENT_STATES.PARTIALLY_REFUNDED) {
    throw new HttpsError("failed-precondition", `Payment is ${pay || "unknown"}; an invoice is only created once payment is captured.`);
  }
  if (order.reconciliation && order.reconciliation.status === RECON_STATES.MISMATCH && !opts.overrideMismatch) {
    throw new HttpsError("failed-precondition", "Order is in reconciliation MISMATCH; refusing to invoice until resolved.");
  }

  // Atomic claim of the invoicing slot.
  const claimed = await db().runTransaction(async (tx) => {
    const s = await tx.get(orderRef);
    const st = s.data().invoiceStatus;
    if (st && st !== "NOT_CREATED" && st !== "FAILED") return false; // already processing/done
    tx.update(orderRef, { invoiceStatus: "PROCESSING", processingStatus: ORDER_STATES.PROCESSING, invoiceStartedAt: new Date().toISOString() });
    return true;
  });
  if (!claimed) {
    return { skipped: true, invoiceStatus: order.invoiceStatus, reason: "Invoice already created or in progress." };
  }

  const canonical = order.normalizedOrder;
  const serialNumber = await nextSerial(order.licenseKey);
  const built = buildInvoiceRequest(canonical, {
    licenseKey: order.licenseKey,
    serialNumber,
    pricesTaxInclusive: integration?.pricesTaxInclusive !== false,
    documentType: "invoice",
  });

  const totals = checkInvoiceTotals(canonical, built.computed);
  if (!totals.ok && !opts.overrideMismatch) {
    await orderRef.update({ invoiceStatus: "FAILED", invoiceError: totals.notes.join(" "), invoiceFailedAt: new Date().toISOString() });
    await deliverWebhook(integration, order, WEBHOOK_EVENTS.INVOICE_FAILED, { error: totals.notes.join(" ") });
    throw new HttpsError("failed-precondition", "Built invoice total does not match the order: " + totals.notes.join(" "));
  }

  // Call the existing zatca-service as the license owner.
  let data, res;
  try {
    const authHeader = await ownerAuthHeader(order.licenseKey);
    res = await fetch(`${ZATCA_SERVICE_URL}/zatca/${built.endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify(built.request),
    });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    await orderRef.update({ invoiceStatus: "FAILED", invoiceError: String(e.message || e), invoiceFailedAt: new Date().toISOString() });
    await deliverWebhook(integration, order, WEBHOOK_EVENTS.INVOICE_FAILED, { error: String(e.message || e) });
    throw new HttpsError("unavailable", "Could not reach the ZATCA service: " + (e.message || e));
  }

  const okReport = built.endpoint === "report" && res.ok && data.success === true;
  const okClear = built.endpoint === "clearance" && res.ok && data.success === true && data.cleared === true;
  if (!okReport && !okClear) {
    const detail = Array.isArray(data.details) ? data.details.map((d) => `${d.field}: ${d.message}`).join("; ")
      : (data.error || `ZATCA service returned ${res.status}`);
    await orderRef.update({ invoiceStatus: "FAILED", invoiceError: detail, invoiceFailedAt: new Date().toISOString() });
    await deliverWebhook(integration, order, WEBHOOK_EVENTS.INVOICE_FAILED, { error: detail });
    throw new HttpsError("internal", "ZATCA invoicing failed: " + detail);
  }

  // A 202 on report = signed & valid, reporting retried in background.
  const queuedForRetry = data.queuedForRetry === true;
  const finalStatus = built.endpoint === "clearance" ? "CLEARED" : (queuedForRetry ? "REPORTED_PENDING" : "REPORTED");
  const invoiceRecord = {
    invoiceStatus: finalStatus,
    processingStatus: ORDER_STATES.COMPLETED,
    invoice: {
      serial_number: serialNumber,
      document_type: "invoice",
      channel: built.endpoint,
      icv: data.icv ?? null,
      invoice_hash: data.invoiceHash || null,
      qr: data.qr || null,
      signed_xml: data.signedXml || null,
      cleared_xml: data.clearedInvoiceXml || null,
      total: built.computed.total,
      net: built.computed.net,
      tax: built.computed.tax,
    },
    invoicedAt: new Date().toISOString(),
    invoiceWarnings: built.warnings,
  };
  await orderRef.update(invoiceRecord);
  await deliverWebhook(integration, { ...order, ...invoiceRecord }, built.endpoint === "clearance" ? WEBHOOK_EVENTS.INVOICE_CLEARED : WEBHOOK_EVENTS.INVOICE_REPORTED, {
    invoice_number: serialNumber, icv: data.icv ?? null,
  });

  return { ok: true, invoiceStatus: finalStatus, serialNumber, endpoint: built.endpoint, computed: built.computed, warnings: built.warnings };
}

// ── Callable: explicitly invoice a received order ─────────────────────────────
export const invoiceExternalOrder = onCall({ cors: true, region: REGION }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign-in required.");
  const { licenseKey, externalOrderId, restoposOrderId, overrideMismatch } = req.data || {};
  const key = String(licenseKey || "").trim().toUpperCase();
  if (!key) throw new HttpsError("invalid-argument", "licenseKey is required.");

  // Ownership (admin or license owner).
  const licSnap = await db().collection("pending_activations").doc(key).get();
  if (!licSnap.exists) throw new HttpsError("not-found", "Account not found.");
  const licData = licSnap.data() || {};
  const isAdmin = req.auth.token?.email === ADMIN_EMAIL && req.auth.token?.email_verified;
  const owns = req.auth.uid === key || (Array.isArray(licData.authUids) && licData.authUids.includes(req.auth.uid));
  if (!isAdmin && !owns) throw new HttpsError("permission-denied", "Not authorized for this license.");

  // Locate the order (by restoposOrderId, else by externalOrderId within license).
  let orderSnap;
  if (restoposOrderId) {
    const q = await db().collection("external_orders").where("restoposOrderId", "==", restoposOrderId).limit(1).get();
    orderSnap = q.docs[0];
  } else if (externalOrderId) {
    const q = await db().collection("external_orders").where("licenseKey", "==", key).where("externalOrderId", "==", externalOrderId).limit(1).get();
    orderSnap = q.docs[0];
  }
  if (!orderSnap) throw new HttpsError("not-found", "Order not found for this license.");
  const order = orderSnap.data();
  if (order.licenseKey !== key) throw new HttpsError("permission-denied", "Order does not belong to this license.");

  const integSnap = await db().collection("integrations").doc(order.integrationId).get();
  const integration = integSnap.exists ? integSnap.data() : { integrationId: order.integrationId, licenseKey: key };

  const result = await runInvoiceForOrder(orderSnap.ref, integration, { overrideMismatch: isAdmin && overrideMismatch === true });
  return result;
});
