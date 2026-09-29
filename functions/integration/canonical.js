// ═══════════════════════════════════════════════════════════════════════════
// UNIVERSAL INTEGRATION — canonical order model, normalization & reconciliation
//
// Pure functions only. NO Firebase, NO network, NO side effects — so the whole
// commercial-logic core is unit-testable with plain `node --test` (no emulator)
// and can be reasoned about in isolation.
//
// Design rule (from the integration spec): the EXTERNAL app is the source of
// truth for the commercial transaction. RestoPOS receives the complete order +
// pricing + payment, preserves EVERY component, and NEVER recalculates the deal
// from its own menu. We normalize field names into one canonical shape while
// keeping the original values, and we FLAG discrepancies rather than silently
// "fixing" them.
// ═══════════════════════════════════════════════════════════════════════════
import crypto from "crypto";

export const CANONICAL_SCHEMA_VERSION = 1;

// Idempotency identity: one RestoPOS order per (integration, external order id).
export const IDEMPOTENCY_SEP = "__";
export function buildOrderDocId(integrationId, externalOrderId) {
  const a = String(integrationId || "").trim();
  const b = String(externalOrderId || "").trim();
  if (!a || !b) throw new Error("integrationId and externalOrderId are required for the idempotency key");
  // Firestore document ids may not contain "/". Everything else here is opaque;
  // we hash to keep the id bounded and free of illegal characters while staying
  // deterministic for the same pair.
  const raw = `${a}${IDEMPOTENCY_SEP}${b}`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

// Stable hash of the original payload, for tamper-evidence and dedupe.
export function payloadHash(payload) {
  return crypto.createHash("sha256").update(stableStringify(payload)).digest("hex");
}

// Deterministic JSON stringify (sorted keys) so the same logical payload always
// hashes identically regardless of key order.
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

// ── State machines (spec §4, §27) ──────────────────────────────────────────
export const ORDER_STATES = Object.freeze({
  RECEIVED: "RECEIVED",
  VALIDATING: "VALIDATING",
  VALIDATED: "VALIDATED",
  REJECTED: "REJECTED",
  PROCESSING: "PROCESSING",
  COMPLETED: "COMPLETED",
});

export const PAYMENT_STATES = Object.freeze({
  PENDING: "PENDING",
  AUTHORIZED: "AUTHORIZED",
  CAPTURED: "CAPTURED",
  PARTIALLY_CAPTURED: "PARTIALLY_CAPTURED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  PARTIALLY_REFUNDED: "PARTIALLY_REFUNDED",
  REFUNDED: "REFUNDED",
});

export const RECON_STATES = Object.freeze({
  PENDING: "PENDING",
  RECONCILED: "RECONCILED",
  MISMATCH: "MISMATCH",
  MANUAL_REVIEW: "MANUAL_REVIEW",
});

// Money tolerance for float comparisons (halalas). Two amounts within this are
// considered equal; anything larger is a real, reportable difference.
export const MONEY_TOLERANCE = 0.005;

// ── Helpers ────────────────────────────────────────────────────────────────
// A strict number parse: accepts numbers and numeric strings, rejects NaN /
// Infinity / non-numeric. Returns { ok, value }. We do NOT coerce garbage to 0
// — inventing data is exactly what the spec forbids.
function num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? { ok: true, value: v } : { ok: false };
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
  }
  return { ok: false };
}
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const firstDefined = (obj, keys) => {
  for (const k of keys) if (obj != null && obj[k] != null && obj[k] !== "") return obj[k];
  return undefined;
};
const str = (v) => (v == null ? "" : String(v));

// Aliases external apps use for the same concept (spec §8). We normalize the
// NAME but never destroy the original value — the raw payload is stored intact.
const GRAND_TOTAL_KEYS = ["grand_total", "total", "amount_due", "payable", "final_amount", "net_amount", "order_total", "amount"];
const SUBTOTAL_KEYS = ["items_subtotal", "subtotal", "sub_total", "items_total", "lines_total"];
const DISCOUNT_TYPES = new Set(["promotion", "coupon", "discount", "campaign", "voucher", "loyalty", "wallet", "membership", "manual_discount"]);
const CHARGE_TYPES = new Set(["delivery_fee", "delivery", "service_charge", "service", "packaging", "handling", "platform_fee", "surcharge", "tip", "gratuity", "other_charge"]);

// Classify an adjustment as discount (reduces total) or charge (increases it).
// An explicit sign on `amount` always wins; otherwise we infer from the type.
function adjustmentDirection(type, amount) {
  if (amount < 0) return "discount";
  if (amount > 0 && CHARGE_TYPES.has(type)) return "charge";
  if (DISCOUNT_TYPES.has(type)) return "discount";
  if (CHARGE_TYPES.has(type)) return "charge";
  // Unknown positive amount: treat as a charge (adds to what the customer pays).
  return "charge";
}

// ── Normalization (spec §8, §9) ────────────────────────────────────────────
// Turn an arbitrary external payload into the RestoPOS canonical order.
// Returns { ok, errors:[], canonical }. `errors` is non-empty when the payload
// is unusable; the caller rejects (spec §5) rather than guessing.
export function normalizeOrder(payload, ctx = {}) {
  const errors = [];
  const p = payload && typeof payload === "object" ? payload : {};

  const externalOrderId = str(firstDefined(p, ["external_order_id", "order_id", "id", "reference", "orderRef"])).trim();
  if (!externalOrderId) errors.push({ field: "external_order_id", message: "An external order id is required." });

  const currency = str(firstDefined(p, ["currency", "currency_code"]) || "SAR").toUpperCase();

  // ── Items ──
  const rawItems = Array.isArray(p.items) ? p.items : Array.isArray(p.line_items) ? p.line_items : [];
  if (!rawItems.length) errors.push({ field: "items", message: "At least one order item is required." });
  const items = [];
  rawItems.forEach((it, i) => {
    const o = it && typeof it === "object" ? it : {};
    const qtyP = num(firstDefined(o, ["quantity", "qty"]) ?? 1);
    const priceP = num(firstDefined(o, ["unit_price", "price", "tax_exclusive_price", "unitPrice"]));
    const name = str(firstDefined(o, ["name", "title", "description"])).trim();
    if (!name) errors.push({ field: `items[${i}].name`, message: "Item name is required." });
    if (!qtyP.ok || qtyP.value <= 0) errors.push({ field: `items[${i}].quantity`, message: "Item quantity must be a positive number." });
    // unit_price of 0 IS valid — free/promotional items (spec §18).
    if (!priceP.ok || priceP.value < 0) errors.push({ field: `items[${i}].unit_price`, message: "Item unit_price must be a number >= 0." });

    const quantity = qtyP.ok ? qtyP.value : 0;
    const unitPrice = priceP.ok ? priceP.value : 0;
    const declaredLine = num(firstDefined(o, ["line_total", "total", "amount"]));
    const modifiers = Array.isArray(o.modifiers) ? o.modifiers.map((m) => ({
      name: str(firstDefined(m, ["name", "title"])),
      amount: num(firstDefined(m, ["amount", "price"]) ?? 0).value || 0,
    })) : [];
    const modTotal = modifiers.reduce((s, m) => s + m.amount, 0);
    const computedLine = round2(quantity * unitPrice + modTotal * quantity);
    const taxRateP = num(firstDefined(o, ["tax_rate", "vat_percent", "VAT_percent", "tax_percent"]));
    // vat_percent may be given as 0.15 or 15 — normalize to a fraction.
    let taxRate = taxRateP.ok ? taxRateP.value : null;
    if (taxRate != null && taxRate > 1) taxRate = taxRate / 100;

    items.push({
      id: str(firstDefined(o, ["id", "sku", "product_id"]) || String(i + 1)),
      name,
      name_ar: str(firstDefined(o, ["name_ar", "nameAr", "arabic_name"])) || undefined,
      quantity,
      unit_price: unitPrice,
      modifiers,
      line_total: declaredLine.ok ? declaredLine.value : computedLine,
      computed_line_total: computedLine,
      tax_rate: taxRate,
      tax_category: str(firstDefined(o, ["tax_category", "vat_category"])) || undefined,
    });
  });

  // ── Adjustments (discounts / promotions / charges) — spec §17, §19 ──
  const adjustments = [];
  const rawAdjustments = Array.isArray(p.adjustments) ? p.adjustments
    : Array.isArray(p.pricing?.adjustments) ? p.pricing.adjustments : [];
  rawAdjustments.forEach((a, i) => {
    const o = a && typeof a === "object" ? a : {};
    const amtP = num(firstDefined(o, ["amount", "value"]));
    if (!amtP.ok) { errors.push({ field: `adjustments[${i}].amount`, message: "Adjustment amount must be a number." }); return; }
    const type = str(firstDefined(o, ["type", "kind"]) || "other").toLowerCase();
    const direction = adjustmentDirection(type, amtP.value);
    adjustments.push({
      type,
      direction, // "discount" | "charge"
      code: str(firstDefined(o, ["code", "coupon", "voucher"])) || undefined,
      description: str(firstDefined(o, ["description", "label", "reason"])) || undefined,
      amount: Math.abs(amtP.value),
      scope: str(firstDefined(o, ["scope"]) || "order"),
      source: str(firstDefined(o, ["source"]) || "external"),
      tax_treatment: str(firstDefined(o, ["tax_treatment"])) || undefined,
    });
  });

  // ── Pricing (preserve declared values; also compute for reconciliation) ──
  const pricingSrc = p.pricing && typeof p.pricing === "object" ? p.pricing : p;
  const declaredSubtotal = num(firstDefined(pricingSrc, SUBTOTAL_KEYS));
  const declaredGrand = num(firstDefined(pricingSrc, GRAND_TOTAL_KEYS));
  const taxNode = pricingSrc.tax && typeof pricingSrc.tax === "object" ? pricingSrc.tax : {};
  const declaredTax = num(firstDefined({ ...pricingSrc, ...taxNode }, ["tax_amount", "vat_amount", "amount", "tax"]));

  const computedItemsSubtotal = round2(items.reduce((s, it) => s + it.line_total, 0));
  const discountTotal = round2(adjustments.filter((a) => a.direction === "discount").reduce((s, a) => s + a.amount, 0));
  const chargeTotal = round2(adjustments.filter((a) => a.direction === "charge").reduce((s, a) => s + a.amount, 0));

  const itemsSubtotal = declaredSubtotal.ok ? declaredSubtotal.value : computedItemsSubtotal;
  const taxTotal = declaredTax.ok ? declaredTax.value : null; // null = not supplied; do NOT invent (spec §16)
  const grandTotal = declaredGrand.ok ? declaredGrand.value : null;

  // ── Payment (spec §3) ──
  const payNode = p.payment && typeof p.payment === "object" ? p.payment : {};
  const capturedP = num(firstDefined(payNode, ["captured_amount", "captured", "paid_amount"]));
  const authorizedP = num(firstDefined(payNode, ["authorized_amount", "authorized"]));
  const refundedP = num(firstDefined(payNode, ["refunded_amount", "refunded"]));
  const rawStatus = str(firstDefined(payNode, ["status", "state"])).toUpperCase();
  const paymentStatus = PAYMENT_STATES[rawStatus] || (capturedP.ok && capturedP.value > 0 ? PAYMENT_STATES.CAPTURED : PAYMENT_STATES.PENDING);
  const capturedAmount = capturedP.ok ? capturedP.value : null;
  const refundedAmount = refundedP.ok ? refundedP.value : 0;
  const netCaptured = capturedAmount != null ? round2(capturedAmount - refundedAmount) : null;

  // ── Branch / customer ──
  const externalBranchId = str(firstDefined(p, ["branch_id", "external_branch_id", "store_id", "location_id"])) || undefined;
  const custNode = p.customer && typeof p.customer === "object" ? p.customer : {};
  const customer = {
    name: str(firstDefined(custNode, ["name", "full_name"])) || undefined,
    phone: str(firstDefined(custNode, ["phone", "mobile"])) || undefined,
    vat_number: str(firstDefined(custNode, ["vat_number", "vatNumber", "tax_number"])) || undefined,
    address: custNode.address || undefined,
  };
  // Presence of a buyer VAT number implies a standard (B2B) document (spec: both
  // B2C and B2B supported). We record the hint; the invoice engine decides.
  const isB2B = !!customer.vat_number;

  const canonical = {
    schema_version: CANONICAL_SCHEMA_VERSION,
    external_order_id: externalOrderId,
    integration_id: ctx.integrationId || null,
    license_key: ctx.licenseKey || null,
    restaurant_id: ctx.licenseKey || null,
    external_branch_id: externalBranchId,
    branch_id: ctx.branchId || null, // resolved from mapping by the caller
    source: ctx.source || str(firstDefined(p, ["source", "channel"])) || "external",
    order_type: str(firstDefined(p, ["order_type", "type", "fulfillment"])) || undefined,
    document_hint: isB2B ? "standard" : "simplified", // B2B → clearance, B2C → report
    currency,
    customer,
    items,
    adjustments,
    pricing: {
      items_subtotal: itemsSubtotal,
      computed_items_subtotal: computedItemsSubtotal,
      discount_total: discountTotal,
      charge_total: chargeTotal,
      tax_total: taxTotal,
      grand_total: grandTotal,
    },
    tax: {
      amount: taxTotal,
      supplied: declaredTax.ok,
    },
    payment: {
      status: paymentStatus,
      method: str(firstDefined(payNode, ["method", "payment_method"])) || undefined,
      provider: str(firstDefined(payNode, ["provider", "gateway"])) || undefined,
      transaction_id: str(firstDefined(payNode, ["transaction_id", "txn_id", "reference"])) || undefined,
      authorized_amount: authorizedP.ok ? authorizedP.value : null,
      captured_amount: capturedAmount,
      refunded_amount: refundedAmount,
      net_captured_amount: netCaptured,
    },
    captured_amount: capturedAmount,
    timestamps: {
      external_created_at: str(firstDefined(p, ["created_at", "order_date", "timestamp", "issued_at"])) || undefined,
    },
    metadata: (p.metadata && typeof p.metadata === "object") ? p.metadata : {},
  };

  return { ok: errors.length === 0, errors, canonical };
}

// ── Reconciliation (spec §6) ────────────────────────────────────────────────
// Two independent checks, both non-destructive:
//   (a) do the line items + charges − discounts + tax equal the declared total?
//   (b) does the declared total equal the captured amount?
// We never silently correct a mismatch; we report it.
export function reconcile(canonical) {
  const pr = canonical.pricing || {};
  const notes = [];
  let status = RECON_STATES.RECONCILED;

  const declaredGrand = pr.grand_total;
  const captured = canonical.captured_amount;

  // (a) internal arithmetic — only meaningful when tax + grand total are supplied.
  let computedGrand = null;
  if (pr.tax_total != null) {
    computedGrand = round2(pr.items_subtotal + pr.charge_total - pr.discount_total + pr.tax_total);
  }
  const arithmeticDelta = (computedGrand != null && declaredGrand != null)
    ? round2(declaredGrand - computedGrand) : null;
  if (arithmeticDelta != null && Math.abs(arithmeticDelta) > MONEY_TOLERANCE) {
    status = RECON_STATES.MISMATCH;
    notes.push(`Declared total ${declaredGrand} does not equal items(${pr.items_subtotal}) + charges(${pr.charge_total}) − discounts(${pr.discount_total}) + tax(${pr.tax_total}) = ${computedGrand} (Δ ${arithmeticDelta}).`);
  }

  // (b) declared vs captured.
  let captureDelta = null;
  if (declaredGrand != null && captured != null) {
    captureDelta = round2(captured - declaredGrand);
    if (Math.abs(captureDelta) > MONEY_TOLERANCE) {
      status = RECON_STATES.MISMATCH;
      notes.push(`Captured amount ${captured} does not equal declared total ${declaredGrand} (Δ ${captureDelta}).`);
    }
  }

  // Missing critical figures → cannot assert reconciliation; needs review, not a
  // silent pass (spec §5).
  if (declaredGrand == null) { status = RECON_STATES.MANUAL_REVIEW; notes.push("No declared grand total supplied."); }
  if (captured == null) {
    // Not necessarily an error (payment may still be pending) — but not reconciled.
    if (status === RECON_STATES.RECONCILED) status = RECON_STATES.PENDING;
    notes.push("No captured amount supplied yet.");
  }

  return {
    status,
    reconciled: status === RECON_STATES.RECONCILED,
    declared_grand_total: declaredGrand ?? null,
    computed_grand_total: computedGrand,
    captured_amount: captured ?? null,
    arithmetic_delta: arithmeticDelta,
    capture_delta: captureDelta,
    notes,
  };
}
