// ═══════════════════════════════════════════════════════════════════════════
// UNIVERSAL INTEGRATION — API surface (Firebase Functions)
//
// Additive module. It defines NEW functions only and imports nothing from
// index.js, so it cannot disturb existing behaviour. index.js re-exports the
// symbols below.
//
//   createIntegration   (callable) — merchant/admin provisions an API key.
//   listIntegrations    (callable) — list a license's integrations (no secrets).
//   revokeIntegration   (callable) — disable an integration.
//   integrationOrders   (HTTP)     — external apps POST orders / GET an order.
//
// Phase 2 scope: receive, validate, identify tenant+branch, preserve the raw
// payload immutably, normalize to the canonical order, run reconciliation, and
// persist — idempotently. It does NOT yet mint a ZATCA invoice; that is a
// separate step wired to the existing zatca-service, kept out of this change so
// nothing invoicing-related is touched here.
// ═══════════════════════════════════════════════════════════════════════════
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import {
  normalizeOrder, reconcile, buildOrderDocId, payloadHash,
  ORDER_STATES, PAYMENT_STATES,
} from "./canonical.js";

const REGION = "us-central1";
const BCRYPT_ROUNDS = 12;
const ADMIN_EMAIL = "8742sabithsaleem@gmail.com";

// Lazy Firestore accessor — never call getFirestore() at module load, because
// this module is imported before initializeApp() has run in index.js.
const db = () => getFirestore();

// ── Small local ownership guard ──────────────────────────────────────────────
// A deliberate, tiny re-statement of index.js's requireLicense. Importing that
// helper would make index.js ⇄ api.js a circular import; the guard is small
// enough that a local copy is safer than restructuring shared auth in this
// additive change.
async function requireLicense(auth, licenseKey) {
  if (!auth) throw new HttpsError("unauthenticated", "Sign-in required.");
  const key = String(licenseKey || "").trim().toUpperCase();
  if (!key) throw new HttpsError("invalid-argument", "licenseKey is required.");
  const snap = await db().collection("pending_activations").doc(key).get();
  if (!snap.exists) throw new HttpsError("not-found", "Account not found.");
  const data = snap.data() || {};
  const isAdmin = auth.token?.email === ADMIN_EMAIL && auth.token?.email_verified;
  const owns = auth.uid === key || (Array.isArray(data.authUids) && data.authUids.includes(auth.uid));
  if (!isAdmin && !owns) throw new HttpsError("permission-denied", "Not authorized for this license.");
  return { key, data, isAdmin };
}

// A secret the merchant sees once. Prefix is stored in clear for O(1) lookup;
// the full key is only ever stored bcrypt-hashed.
function newApiKey() {
  const secret = crypto.randomBytes(24).toString("base64url");
  const prefix = "rpk_" + crypto.randomBytes(6).toString("hex"); // 12 hex chars
  return { plaintext: `${prefix}.${secret}`, prefix };
}
const parseKey = (raw) => {
  const s = String(raw || "").trim();
  const dot = s.indexOf(".");
  return dot > 0 ? { prefix: s.slice(0, dot), full: s } : { prefix: "", full: s };
};

async function audit(entry) {
  try {
    await db().collection("activity_log").add({ ...entry, timestamp: new Date().toISOString() });
  } catch (e) { /* audit must never break the request path */ }
}

// ── createIntegration ────────────────────────────────────────────────────────
export const createIntegration = onCall({ cors: true, region: REGION }, async (req) => {
  const { licenseKey, name, branchMappings } = req.data || {};
  const { key } = await requireLicense(req.auth, licenseKey);
  const cleanName = String(name || "").trim() || "External App";

  const { plaintext, prefix } = newApiKey();
  const webhookSecret = "whsec_" + crypto.randomBytes(24).toString("base64url");
  const integrationId = "int_" + crypto.randomBytes(10).toString("hex");
  const now = new Date().toISOString();

  const mappings = (branchMappings && typeof branchMappings === "object" && !Array.isArray(branchMappings)) ? branchMappings : {};

  await db().collection("integrations").doc(integrationId).set({
    integrationId,
    licenseKey: key,
    name: cleanName,
    type: "ONLINE_ORDERING",
    status: "active",
    apiKeyPrefix: prefix,
    apiKeyHash: await bcrypt.hash(plaintext, BCRYPT_ROUNDS),
    // The webhook secret is a shared HMAC key (like Stripe's whsec_…): we need
    // it in recoverable form to SIGN outbound deliveries. It lives only in this
    // admin-only, default-deny collection and is never returned by list.
    webhookSecret,
    webhookUrl: "",
    // External prices are treated as VAT-inclusive by default (POS convention).
    pricesTaxInclusive: true,
    branchMappings: mappings,
    createdAt: now,
    createdBy: req.auth.uid,
    lastRequestAt: null,
  });
  await audit({ action: "INTEGRATION_CREATED", user: key, licenseKey: key, details: `Integration "${cleanName}" (${integrationId}) created.` });

  // The plaintext key and webhook secret are returned ONCE and never stored in
  // recoverable form. The merchant must copy them now.
  return { integrationId, name: cleanName, apiKey: plaintext, webhookSecret, branchMappings: mappings };
});

// ── listIntegrations (never returns secrets) ─────────────────────────────────
export const listIntegrations = onCall({ cors: true, region: REGION }, async (req) => {
  const { licenseKey } = req.data || {};
  const { key } = await requireLicense(req.auth, licenseKey);
  const snap = await db().collection("integrations").where("licenseKey", "==", key).get();
  const integrations = snap.docs.map((d) => {
    const x = d.data();
    return {
      integrationId: x.integrationId, name: x.name, status: x.status, type: x.type,
      apiKeyPrefix: x.apiKeyPrefix, webhookUrl: x.webhookUrl || "",
      branchMappings: x.branchMappings || {}, createdAt: x.createdAt, lastRequestAt: x.lastRequestAt || null,
    };
  });
  return { integrations };
});

// ── revokeIntegration ────────────────────────────────────────────────────────
export const revokeIntegration = onCall({ cors: true, region: REGION }, async (req) => {
  const { licenseKey, integrationId } = req.data || {};
  const { key } = await requireLicense(req.auth, licenseKey);
  const ref = db().collection("integrations").doc(String(integrationId || ""));
  const snap = await ref.get();
  if (!snap.exists || snap.data().licenseKey !== key) throw new HttpsError("not-found", "Integration not found for this license.");
  await ref.update({ status: "revoked", revokedAt: new Date().toISOString(), revokedBy: req.auth.uid });
  await audit({ action: "INTEGRATION_REVOKED", user: key, licenseKey: key, details: `Integration ${integrationId} revoked.` });
  return { ok: true };
});

// ── HTTP helpers ─────────────────────────────────────────────────────────────
function sendJson(res, code, body) { res.status(code).set("Content-Type", "application/json").send(JSON.stringify(body)); }

// Authenticate an inbound integration request by its API key. Returns the
// integration record or throws { code, message }.
async function authenticateIntegration(req) {
  const header = req.get("x-api-key") || (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { prefix, full } = parseKey(header);
  if (!full) throw { code: 401, message: "Missing API key. Send it as 'x-api-key' or 'Authorization: Bearer'." };
  if (!prefix) throw { code: 401, message: "Malformed API key." };
  const snap = await db().collection("integrations").where("apiKeyPrefix", "==", prefix).limit(1).get();
  if (snap.empty) throw { code: 401, message: "Invalid API key." };
  const integ = snap.docs[0].data();
  const ok = await bcrypt.compare(full, integ.apiKeyHash || "");
  if (!ok) throw { code: 401, message: "Invalid API key." };
  if (integ.status !== "active") throw { code: 403, message: "This integration is not active." };

  // The tenant's account must itself be usable (spec §10 — server-side isolation).
  const lic = await db().collection("pending_activations").doc(integ.licenseKey).get();
  const licData = lic.exists ? lic.data() : {};
  if (!lic.exists || licData.status === "deactivated" || licData.deactivated === true) {
    throw { code: 403, message: "The account for this integration is not active." };
  }
  return { integration: integ, licenseData: licData };
}

// Resolve the external branch id to a RestoPOS branch via the integration's
// mapping. If mappings are configured, an unmapped branch is rejected — never
// silently accepted (spec §10, §12). If no mappings exist, single-branch is
// assumed and branch_id stays null.
function resolveBranch(integration, externalBranchId) {
  const mappings = integration.branchMappings || {};
  const hasMappings = Object.keys(mappings).length > 0;
  if (!externalBranchId) {
    if (hasMappings) return { ok: false, message: "This integration requires a branch_id; none was supplied." };
    return { ok: true, branchId: null };
  }
  if (hasMappings) {
    const mapped = mappings[externalBranchId];
    if (!mapped) return { ok: false, message: `Unknown branch_id '${externalBranchId}' for this integration.` };
    return { ok: true, branchId: mapped };
  }
  // No mappings configured but a branch was supplied — pass it through as-is.
  return { ok: true, branchId: externalBranchId };
}

// ── integrationOrders (HTTP) ─────────────────────────────────────────────────
// POST  /orders            → create (idempotent) and return the RestoPOS order
// GET   /orders?id=<extid> → fetch a previously received order
export const integrationOrders = onRequest({ cors: true, region: REGION }, async (req, res) => {
  let auth;
  try {
    auth = await authenticateIntegration(req);
  } catch (e) {
    return sendJson(res, e.code || 401, { error: e.message || "Unauthorized" });
  }
  const { integration } = auth;

  // Touch lastRequestAt (best-effort, non-blocking correctness).
  db().collection("integrations").doc(integration.integrationId).update({ lastRequestAt: new Date().toISOString() }).catch(() => {});

  if (req.method === "GET") {
    const extId = String(req.query.id || req.query.external_order_id || "").trim();
    if (!extId) return sendJson(res, 400, { error: "Provide ?id=<external_order_id>." });
    const docId = buildOrderDocId(integration.integrationId, extId);
    const snap = await db().collection("external_orders").doc(docId).get();
    if (!snap.exists) return sendJson(res, 404, { error: "Order not found." });
    const o = snap.data();
    return sendJson(res, 200, {
      restopos_order_id: o.restoposOrderId, external_order_id: o.externalOrderId,
      processing_status: o.processingStatus, payment_status: o.normalizedOrder?.payment?.status,
      reconciliation: o.reconciliation, received_at: o.receivedAt,
    });
  }

  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed." });

  const payload = (req.body && typeof req.body === "object") ? req.body : {};
  const ctx = { integrationId: integration.integrationId, licenseKey: integration.licenseKey };
  const { ok, errors, canonical } = normalizeOrder(payload, ctx);

  const externalOrderId = canonical.external_order_id;
  if (!externalOrderId) return sendJson(res, 400, { error: "Validation failed.", details: errors });

  const docId = buildOrderDocId(integration.integrationId, externalOrderId);
  const ref = db().collection("external_orders").doc(docId);

  // Idempotency (spec §21): the same (integration, external order) always maps
  // to one RestoPOS order. A repeat POST returns the existing record and never
  // creates a second, nor overwrites the immutable original payload.
  const existing = await ref.get();
  if (existing.exists) {
    const o = existing.data();
    return sendJson(res, 200, {
      restopos_order_id: o.restoposOrderId, external_order_id: o.externalOrderId,
      processing_status: o.processingStatus, reconciliation: o.reconciliation, idempotent: true,
    });
  }

  // Branch resolution + tenant isolation.
  const branch = resolveBranch(integration, canonical.external_branch_id);
  const now = new Date().toISOString();
  const restoposOrderId = "rpos_" + crypto.randomBytes(10).toString("hex");

  if (!ok || !branch.ok) {
    const allErrors = [...errors, ...(branch.ok ? [] : [{ field: "branch_id", message: branch.message }])];
    // Even a rejected order is recorded immutably, for audit and dispute (spec §7).
    await ref.set({
      restoposOrderId, integrationId: integration.integrationId, licenseKey: integration.licenseKey,
      externalOrderId, receivedAt: now, payloadHash: payloadHash(payload),
      originalPayload: payload, normalizedOrder: canonical,
      processingStatus: ORDER_STATES.REJECTED, validationErrors: allErrors,
    });
    await audit({ action: "INTEGRATION_ORDER_REJECTED", user: integration.licenseKey, licenseKey: integration.licenseKey, details: `Order ${externalOrderId} rejected: ${allErrors.map((e) => e.message).join("; ")}` });
    return sendJson(res, 422, { error: "Validation failed.", restopos_order_id: restoposOrderId, details: allErrors });
  }

  canonical.branch_id = branch.branchId;
  const recon = reconcile(canonical);

  await ref.set({
    restoposOrderId,
    integrationId: integration.integrationId,
    licenseKey: integration.licenseKey,
    externalOrderId,
    receivedAt: now,
    payloadHash: payloadHash(payload),
    originalPayload: payload,   // immutable — set once, never rewritten
    normalizedOrder: canonical,
    reconciliation: recon,
    paymentStatus: canonical.payment.status,
    processingStatus: ORDER_STATES.VALIDATED, // ready for invoicing (a later phase)
    invoiceStatus: "NOT_CREATED",
    createdAt: now,
    updatedAt: now,
  });
  await audit({
    action: "INTEGRATION_ORDER_RECEIVED", user: integration.licenseKey, licenseKey: integration.licenseKey,
    details: `Order ${externalOrderId} received (${recon.status}).`, integrationId: integration.integrationId,
  });

  return sendJson(res, 202, {
    restopos_order_id: restoposOrderId,
    external_order_id: externalOrderId,
    processing_status: ORDER_STATES.VALIDATED,
    payment_status: canonical.payment.status,
    reconciliation: { status: recon.status, notes: recon.notes },
  });
});
