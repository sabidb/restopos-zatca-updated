// Failure-injection tests for src/cloudArchive.js (sale persistence) — npm test.
// Mocks the injected Firestore deps and a localStorage shim, then exercises the
// idempotency and failure/retry guarantees that keep sales from being lost or
// duplicated. Uses flushArchive() to persist synchronously (no debounce timer).
import { test } from "node:test";
import assert from "node:assert/strict";
import { initCloudArchive, archiveSalesDay, flushArchive } from "../cloudArchive.js";

// ── localStorage shim (fingerprint cache lives here) ──────────────
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
  get length() { return mem.size; },
  key: (i) => [...mem.keys()][i],
};

// ── in-memory Firestore mock ──────────────────────────────────────
const keyOf = (ref) => `${ref.collPath}/${ref.id}`;
function makeFb(store, opts = {}) {
  let commits = 0;
  return {
    db: {},
    collection: (_db, ...path) => ({ collPath: path.join("/") }),
    doc: (coll, id) => ({ collPath: coll.collPath, id }),
    setDoc: async (ref, body) => { store[keyOf(ref)] = { ...(store[keyOf(ref)] || {}), ...body }; },
    writeBatch: () => {
      const ops = [];
      return {
        set(ref, body) { ops.push([ref, body]); },
        async commit() {
          commits++;
          if (opts.failTimes && commits <= opts.failTimes) throw new Error("network down");
          for (const [ref, body] of ops) store[keyOf(ref)] = { ...(store[keyOf(ref)] || {}), ...body };
        },
      };
    },
  };
}
const invoiceDocs = (store, lic) => Object.keys(store).filter((k) => k.startsWith(`client_data/${lic}/invoices/`));
const sale = (id, total, vat) => ({ id, invoice_number: id, total, vat, items: [], date: "2026-11-22" });

test("re-archiving the same sales creates no duplicate invoice documents", async () => {
  mem.clear(); const store = {};
  initCloudArchive(makeFb(store));
  const sales = [sale("INV-1", 35, 4.57), sale("INV-2", 10, 1.3)];
  archiveSalesDay("LICA", "2026-11-22", sales); await flushArchive();
  assert.equal(invoiceDocs(store, "LICA").length, 2);
  // second identical run — fingerprint cache skips them, and merge-by-id means
  // even a write would hit the same two docs.
  archiveSalesDay("LICA", "2026-11-22", sales); await flushArchive();
  assert.equal(invoiceDocs(store, "LICA").length, 2);
});

test("a sale re-sent under the same id updates one document, never two", async () => {
  mem.clear(); const store = {};
  initCloudArchive(makeFb(store));
  archiveSalesDay("LICB", "2026-11-22", [sale("DUP", 35, 4.57)]); await flushArchive();
  archiveSalesDay("LICB", "2026-11-22", [sale("DUP", 50, 6.52)]); await flushArchive();
  const docs = invoiceDocs(store, "LICB");
  assert.equal(docs.length, 1);
  assert.equal(store[docs[0]].total, 50); // updated in place
});

test("a commit failure is contained (no throw, no partial write) and a retry completes it", async () => {
  mem.clear(); const store = {};
  initCloudArchive(makeFb(store, { failTimes: 1 }));
  // first attempt: the batch commit throws — flushArchive must not throw, and
  // nothing may be written for the sale.
  archiveSalesDay("LICC", "2026-11-22", [sale("X", 5, 0.65)]);
  await assert.doesNotReject(flushArchive());
  assert.equal(invoiceDocs(store, "LICC").length, 0);
  // retry: the next cycle succeeds and the sale lands — not lost.
  archiveSalesDay("LICC", "2026-11-22", [sale("X", 5, 0.65)]);
  await flushArchive();
  assert.equal(invoiceDocs(store, "LICC").length, 1);
});
