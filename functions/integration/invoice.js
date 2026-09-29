// ═══════════════════════════════════════════════════════════════════════════
// UNIVERSAL INTEGRATION — canonical order → ZATCA invoice request (pure)
//
// The zatca-service invoice contract accepts ONLY per-line
// { tax_exclusive_price, VAT_percent } — it has no field for order-level
// discounts, delivery or service charges. So to invoice an externally-captured
// order and have the ZATCA totals tie out to the amount actually paid, this
// module maps the arbitrary pricing components INTO line items:
//
//   • item lines            → converted to tax-exclusive unit prices
//   • charges (delivery/…)  → added as extra positive line items
//   • order-level discounts → allocated proportionally across the taxable lines
//
// It is pure and deterministic, and it reports the total it produced so the
// caller can refuse to send an invoice whose total does not match the declared
// / captured amount (never invoice a mismatch — spec §5/§6).
//
// Convention: external prices are treated as VAT-INCLUSIVE by default (matching
// the RestoPOS POS, whose menu prices are inclusive). Pass
// { pricesTaxInclusive:false } for apps that send net prices.
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_VAT_RATE = 0.15;
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// cash/card/… → ZATCA UN/ECE 4461 payment means code (mirrors the POS map).
const PAYMENT_MEANS = { cash: "10", card: "48", credit: "30", transfer: "30", bank: "42", online: "42", visa: "48", mada: "48", apple_pay: "48", applepay: "48", wallet: "42" };
export function paymentMeansCode(method) {
  return PAYMENT_MEANS[String(method || "cash").toLowerCase().trim()] || "10";
}

// Resolve a line's VAT rate: explicit per-item rate wins, else the default.
// A tax_treatment of exempt/zero forces 0.
function lineRate(taxRate, taxTreatment, defaultRate) {
  const t = String(taxTreatment || "").toLowerCase();
  if (t === "exempt" || t === "zero" || t === "zero_rated" || t === "out_of_scope") return 0;
  if (taxRate != null && Number.isFinite(taxRate)) return taxRate;
  return defaultRate;
}

/**
 * Build the zatca-service request body from a canonical order.
 *
 * @param canonical  the normalized order (from canonical.js)
 * @param opts       { licenseKey, serialNumber, issueTimestamp?, pricesTaxInclusive?,
 *                     defaultVatRate?, documentType?, originalInvoiceNumber?, reason? }
 * @returns { endpoint, request, computed:{ net, tax, total, lines }, warnings:[] }
 *   endpoint is "clearance" for B2B (standard) or "report" for B2C (simplified).
 */
export function buildInvoiceRequest(canonical, opts = {}) {
  const warnings = [];
  const defaultRate = opts.defaultVatRate != null ? opts.defaultVatRate : DEFAULT_VAT_RATE;
  const inclusive = opts.pricesTaxInclusive !== false; // default true
  const ts = opts.issueTimestamp || new Date().toISOString();
  const documentType = opts.documentType || "invoice"; // invoice | credit_note | debit_note

  // ── 1. Build gross (VAT-inclusive) lines from items ──
  const grossLines = [];
  (canonical.items || []).forEach((it, i) => {
    const qty = it.quantity || 0;
    const rate = lineRate(it.tax_rate, it.tax_category, defaultRate);
    // canonical line_total is in the payload's own convention (incl. modifiers).
    const lineAmount = it.line_total != null ? it.line_total : (it.unit_price || 0) * qty;
    const gross = inclusive ? lineAmount : round2(lineAmount * (1 + rate));
    grossLines.push({ id: String(i + 1), name: it.name || `Item ${i + 1}`, quantity: qty || 1, rate, gross, taxable: true });
  });

  // ── 2. Charges become extra positive lines ──
  (canonical.adjustments || []).filter((a) => a.direction === "charge").forEach((a, i) => {
    const rate = lineRate(null, a.tax_treatment, defaultRate);
    const gross = inclusive ? a.amount : round2(a.amount * (1 + rate));
    grossLines.push({ id: `C${i + 1}`, name: a.description || a.type || "Charge", quantity: 1, rate, gross, taxable: rate > 0 });
  });

  // ── 3. Order-level discounts allocated proportionally across gross lines ──
  const discountTotal = (canonical.adjustments || []).filter((a) => a.direction === "discount").reduce((s, a) => s + a.amount, 0);
  const totalGrossBefore = grossLines.reduce((s, l) => s + l.gross, 0);
  if (discountTotal > 0) {
    if (totalGrossBefore <= 0) {
      warnings.push("Discounts present but no positive lines to allocate them against.");
    } else if (discountTotal > totalGrossBefore + 0.01) {
      warnings.push(`Discount total ${discountTotal} exceeds line total ${round2(totalGrossBefore)}.`);
    }
    let allocated = 0;
    grossLines.forEach((l, idx) => {
      // Last line absorbs the rounding remainder so the sum is exact.
      const share = idx === grossLines.length - 1
        ? round2(discountTotal - allocated)
        : round2(discountTotal * (l.gross / totalGrossBefore));
      allocated += share;
      l.gross = round2(l.gross - share);
    });
  }

  // Mixed VAT rates make a single proportional allocation approximate; flag it.
  const rates = [...new Set(grossLines.filter((l) => l.taxable).map((l) => l.rate))];
  if (rates.length > 1) warnings.push(`Order mixes VAT rates (${rates.join(", ")}); per-line discount allocation is approximate.`);

  // ── 4. Convert gross lines → tax-exclusive unit prices + roll up totals ──
  let net = 0, tax = 0;
  const line_items = grossLines.map((l) => {
    const qty = l.quantity || 1;
    const lineNet = l.gross / (1 + l.rate);
    const lineTax = l.gross - lineNet;
    net += lineNet; tax += lineTax;
    return { id: l.id, name: l.name, quantity: qty, tax_exclusive_price: lineNet / qty, VAT_percent: l.rate };
  });
  const computed = { net: round2(net), tax: round2(tax), total: round2(net + tax), lines: line_items.length };

  // ── 5. Assemble the request in the zatca-service contract ──
  const invoice = {
    document_type: documentType,
    serial_number: opts.serialNumber,
    issue_date: ts.slice(0, 10),
    issue_time: ts.slice(11, 19),
    payment_means_code: paymentMeansCode(canonical.payment && canonical.payment.method),
    line_items,
  };
  if (documentType === "credit_note" || documentType === "debit_note") {
    invoice.original_invoice_number = opts.originalInvoiceNumber || "";
    invoice.reason = opts.reason || (documentType === "debit_note" ? "Additional charge" : "Refund issued to customer");
  }

  const isB2B = canonical.document_hint === "standard";
  if (isB2B) {
    const c = canonical.customer || {};
    const a = c.address || {};
    invoice.buyer = {
      name: c.name || "",
      vat_number: c.vat_number || "",
      id: c.vat_number || "",
      id_scheme: "TIN",
      address: {
        street: a.street || a.address || "",
        building: a.building || a.buildingNumber || "",
        district: a.district || "",
        city: a.city || "",
        postal_zone: a.postal_zone || a.postalCode || a.postal_code || "",
      },
    };
  }

  return {
    endpoint: isB2B ? "clearance" : "report",
    request: { licenseKey: opts.licenseKey, invoice },
    computed,
    warnings,
  };
}

// Does the invoice total we produced match what the order declared / captured?
// Refuse to invoice otherwise (spec §3: never invoice more than captured).
export function checkInvoiceTotals(canonical, computed, tolerance = 0.01) {
  const declared = canonical.pricing && canonical.pricing.grand_total;
  const captured = canonical.captured_amount;
  const notes = [];
  let ok = true;
  if (declared != null && Math.abs(computed.total - declared) > tolerance) {
    ok = false; notes.push(`Built invoice total ${computed.total} ≠ declared ${declared}.`);
  }
  if (captured != null && computed.total - captured > tolerance) {
    // Building an invoice for MORE than was captured is never allowed.
    ok = false; notes.push(`Built invoice total ${computed.total} exceeds captured ${captured}.`);
  }
  return { ok, notes };
}
