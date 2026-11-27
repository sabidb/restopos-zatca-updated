import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { sha256HexSync } from "./sha256.js";

// 1) FIPS 180-4 / known-answer vectors.
const vectors = [
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  ["The quick brown fox jumps over the lazy dog", "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592"],
  // 56 and 64 bytes exercise the padding block boundary.
  ["a".repeat(55), undefined], ["a".repeat(56), undefined], ["a".repeat(64), undefined], ["a".repeat(1000), undefined],
];

test("matches known SHA-256 answers", () => {
  for (const [input, expected] of vectors) {
    if (expected) assert.equal(sha256HexSync(input), expected, `vector: ${JSON.stringify(input.slice(0, 12))}`);
  }
});

// 2) Cross-check against the platform Web Crypto for a range of inputs, including
//    Arabic and a buildHashInput-style pipe string — the fallback MUST be identical.
async function subtleHex(str) {
  const buf = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

test("fallback is byte-identical to Web Crypto", async () => {
  const inputs = [
    "", "a", "abc", "0".repeat(64),
    "متجر السعادة|2026-11-27T10:00:00Z|300000000000003|115.00|15.00|" + "0".repeat(64),
    "INV-1042|2026-11-27T23:59:59Z|311111111111113|1.05|0.14|" + "f".repeat(64),
    "🧾 فاتورة ضريبية — mixed نص",
    "a".repeat(55), "a".repeat(56), "a".repeat(57), "a".repeat(119), "a".repeat(120),
  ];
  for (const s of inputs) {
    assert.equal(sha256HexSync(s), await subtleHex(s), `mismatch for input len ${s.length}`);
  }
});
