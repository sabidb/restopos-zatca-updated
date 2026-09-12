// ═══════════════════════════════════════════════════════════════════
// INVOICE SERIAL NUMBERS — one namespace per terminal.
//
// The invoice number is generated on the till, from a counter in its own
// localStorage. A licence may have several approved terminals and each
// counts independently from 1000, so two tills trading the same
// afternoon both reach INV-001001 and issue it to different customers.
//
// ZATCA requires the number to identify one document, and the signing
// service claims each serial so that a resubmission is idempotent — which
// turns the collision from two documents sharing a number into the second
// till's sale being answered with the first till's invoice and never
// reported at all.
//
// So the number carries a segment derived from the device id already used
// for terminal approval. The counter stays local, which is what lets a
// till number an invoice while it is offline; the segment is what stops
// two tills ever choosing the same one.
//
// Numbers issued before this existed keep their old shape and are still
// recognised. Nothing needs rewriting: the requirement is that a number
// identifies one document, not that every number looks alike.
// ═══════════════════════════════════════════════════════════════════

// I, L, O and U are left out — these numbers get read aloud off receipts.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SEGMENT_LENGTH = 4;

/**
 * A short stable segment for a device id.
 *
 * FNV-1a: deterministic, synchronous — Web Crypto is not, and this is
 * called while building an invoice — and only needs to separate the
 * handful of tills on one licence.
 */
export function serialSegmentFor(deviceId) {
  let hash = 0x811c9dc5;
  const id = String(deviceId || "");
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  let out = "";
  for (let i = 0; i < SEGMENT_LENGTH; i += 1) {
    out += ALPHABET[hash % ALPHABET.length];
    hash = Math.floor(hash / ALPHABET.length);
  }
  return out;
}

/** The invoice number a till issues for a counter value. */
export function serialFor(deviceId, counter) {
  return `INV-${serialSegmentFor(deviceId)}-${String(counter).padStart(6, "0")}`;
}

/**
 * Reads the counter back out of a serial this device could have issued —
 * its own segmented numbers, and the unsegmented ones it wrote before the
 * segment existed. Returns null for anything else, including another
 * till's numbers, which is what keeps one till's sequence from adopting
 * another's high-water mark.
 */
export function counterInSerial(serial, segment) {
  const match = String(serial || "").match(/^INV-(?:([0-9A-Z]{4})-)?(\d+)$/);
  if (!match) return null;
  if (match[1] && match[1] !== segment) return null;
  return parseInt(match[2], 10);
}
