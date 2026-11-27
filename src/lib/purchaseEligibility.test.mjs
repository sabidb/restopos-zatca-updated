// Tests for evidence-based input-VAT eligibility (AUD-02) — run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidSaudiVatNumber, inputVatEligibility, isInputVatRecoverable, recoverabilityDelta,
} from "./purchases.js";

test("isValidSaudiVatNumber accepts the documented 15-digit 3…3 shape only", () => {
  assert.equal(isValidSaudiVatNumber("300000000000003"), true);
  assert.equal(isValidSaudiVatNumber("3 0000 0000 00000 3"), true); // spaces ignored
  assert.equal(isValidSaudiVatNumber(""), false);
  assert.equal(isValidSaudiVatNumber(null), false);
  assert.equal(isValidSaudiVatNumber("30000000000003"), false);   // 14 digits
  assert.equal(isValidSaudiVatNumber("3000000000000003"), false); // 16 digits
  assert.equal(isValidSaudiVatNumber("100000000000001"), false);  // wrong leading/trailing
  assert.equal(isValidSaudiVatNumber("3000000000000X3"), false);  // non-digit
});

const full = {
  id: "P1", hasValidEInvoice: true, supplierVatNumber: "300000000000003",
  supplierInvoiceNo: "INV-1", invoiceDate: "2026-11-01", vatAmount: 15,
};

test("a fully-evidenced purchase is recoverable with no reasons", () => {
  const e = inputVatEligibility(full);
  assert.equal(e.recoverable, true);
  assert.deepEqual(e.reasons, []);
  assert.equal(isInputVatRecoverable(full), true);
});

test("the checkbox alone is NOT sufficient — each missing piece is its own reason", () => {
  assert.deepEqual(inputVatEligibility({ ...full, hasValidEInvoice: false }).reasons, ["not-marked-valid-einvoice"]);
  assert.deepEqual(inputVatEligibility({ ...full, supplierVatNumber: "" }).reasons, ["invalid-supplier-vat-number"]);
  assert.deepEqual(inputVatEligibility({ ...full, supplierInvoiceNo: "  " }).reasons, ["missing-invoice-number"]);
  assert.deepEqual(inputVatEligibility({ ...full, invoiceDate: "" }).reasons, ["missing-invoice-date"]);
  // checkbox ticked but no evidence at all → multiple reasons, not recoverable
  const bare = { id: "B", hasValidEInvoice: true };
  const e = inputVatEligibility(bare);
  assert.equal(e.recoverable, false);
  assert.ok(e.reasons.includes("invalid-supplier-vat-number"));
  assert.equal(isInputVatRecoverable(bare), false);
});

test("recoverabilityDelta surfaces bills that were ticked recoverable but now are not", () => {
  const docs = [
    full,                                                            // stays recoverable
    { id: "P2", hasValidEInvoice: true, supplierInvoiceNo: "X", invoiceDate: "2026-11-02", vatAmount: 6, supplierName: "No VAT Co" }, // loses it (no VAT no.)
    { id: "P3", hasValidEInvoice: false, vatAmount: 9 },             // never claimed → not in delta
  ];
  const delta = recoverabilityDelta(docs);
  assert.equal(delta.length, 1);
  assert.equal(delta[0].id, "P2");
  assert.equal(delta[0].supplierName, "No VAT Co");
  assert.ok(delta[0].reasons.includes("invalid-supplier-vat-number"));
});
