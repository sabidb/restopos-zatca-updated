// ═══════════════════════════════════════════════════════════════════════════
// UNIVERSAL INTEGRATION — outbound webhook signing & event shaping (pure)
//
// RestoPOS calls the external app back on order/invoice lifecycle events
// (spec §23). Each delivery is HMAC-SHA256 signed over "<timestamp>.<body>" so
// the receiver can verify authenticity with the webhook secret shared at
// integration creation — the same scheme Stripe uses. Pure and deterministic.
// ═══════════════════════════════════════════════════════════════════════════
import crypto from "crypto";

export const WEBHOOK_EVENTS = Object.freeze({
  ORDER_RECEIVED: "order.received",
  ORDER_ACCEPTED: "order.accepted",
  ORDER_REJECTED: "order.rejected",
  PAYMENT_CAPTURED: "payment.captured",
  INVOICE_CREATED: "invoice.created",
  INVOICE_PROCESSING: "invoice.processing",
  INVOICE_REPORTED: "invoice.reported",
  INVOICE_CLEARED: "invoice.cleared",
  INVOICE_FAILED: "invoice.failed",
  REFUND_CREATED: "refund.created",
  REFUND_COMPLETED: "refund.completed",
  RECONCILIATION_FAILED: "reconciliation.failed",
});

// The canonical string that gets signed. Kept in one place so signer and
// verifier cannot drift.
export function signingPayload(timestamp, body) {
  return `${timestamp}.${typeof body === "string" ? body : JSON.stringify(body)}`;
}

// Returns the value for the X-Restopos-Signature header:
//   t=<unix-seconds>,v1=<hex hmac>
export function signWebhook(secret, body, timestamp) {
  const ts = timestamp != null ? String(timestamp) : String(Math.floor(Date.now() / 1000));
  const mac = crypto.createHmac("sha256", String(secret || "")).update(signingPayload(ts, body)).digest("hex");
  return { header: `t=${ts},v1=${mac}`, timestamp: ts, signature: mac };
}

// Constant-time verification helper (useful for tests and any inbound path).
export function verifyWebhook(secret, body, header) {
  const m = /t=(\d+),v1=([0-9a-f]+)/.exec(String(header || ""));
  if (!m) return false;
  const expected = crypto.createHmac("sha256", String(secret || "")).update(signingPayload(m[1], body)).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(m[2]);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Shape a lifecycle event body from a stored external-order record.
export function buildWebhookEvent(event, order, extra = {}) {
  return {
    event,
    restopos_order_id: order.restoposOrderId || null,
    external_order_id: order.externalOrderId || null,
    integration_id: order.integrationId || null,
    processing_status: order.processingStatus || null,
    invoice_status: order.invoiceStatus || null,
    ...extra,
    sent_at: new Date().toISOString(),
  };
}
