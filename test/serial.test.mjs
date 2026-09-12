import test from 'node:test';
import assert from 'node:assert';
import { serialSegmentFor, serialFor, counterInSerial } from '../src/lib/serial.js';

test('a device always gets the same segment', () => {
  const id = 'a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
  assert.strictEqual(serialSegmentFor(id), serialSegmentFor(id));
  assert.match(serialSegmentFor(id), /^[0-9A-HJ-NP-TV-Z]{4}$/);
});

test('two tills on one licence never issue the same number', () => {
  // The failure this exists to prevent: both counters start at 1000, both
  // reach 1001 the same afternoon, and the second till's sale is answered
  // with the first till's invoice and never reported.
  const a = 'a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
  const b = 'b7e2d3c5-6f70-4b8c-9d0e-1f2a3b4c5d6e';
  assert.notStrictEqual(serialFor(a, 1001), serialFor(b, 1001));
});

test('segments collide rarely enough for the tills one licence has', () => {
  // Four characters of a 32-symbol alphabet is a million combinations. A
  // licence runs a handful of tills, not thousands, but the property worth
  // asserting is that the hash spreads rather than clumping.
  const seen = new Set();
  for (let i = 0; i < 5000; i += 1) seen.add(serialSegmentFor(`device-${i}-${i * 7919}`));
  assert.ok(seen.size > 4900, `only ${seen.size} distinct segments from 5000 devices`);
});

test('the number keeps the counter readable and padded', () => {
  const serial = serialFor('device-1', 1042);
  assert.match(serial, /^INV-[0-9A-HJ-NP-TV-Z]{4}-001042$/);
});

test('a till reads its own counter back, whatever the shape', () => {
  const id = 'device-1';
  const segment = serialSegmentFor(id);
  assert.strictEqual(counterInSerial(serialFor(id, 1042), segment), 1042);
  // Numbers this till issued before the segment existed still count as its own.
  assert.strictEqual(counterInSerial('INV-001042', segment), 1042);
});

test("a till does not adopt another till's counter", () => {
  const mine = serialSegmentFor('device-1');
  const theirs = serialFor('device-2', 9999);
  assert.strictEqual(counterInSerial(theirs, mine), null);
});

test('anything that is not an invoice number reads as nothing', () => {
  const segment = serialSegmentFor('device-1');
  for (const input of ['', null, undefined, 'D-42A', 'INV-', 'CN-000001', 'INV-XX-1', {}]) {
    assert.strictEqual(counterInSerial(input, segment), null, `${String(input)} should not parse`);
  }
});
