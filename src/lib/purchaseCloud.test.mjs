// Golden tests for src/lib/purchaseCloud.js — run with: npm test
// Uses an in-memory mock of the injected Firestore handles (no live Firestore).
// A real-emulator suite lives in test/emulator/ and is run separately.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  initPurchaseCloud, setPurchaseCloudLicense,
  purchaseDocsCloud, purchaseOrdersCloud, mergeById,
  PURCHASE_DOCS_COLL,
} from "./purchaseCloud.js";

function mockFb() {
  const store = new Map(); // "seg/seg/..." -> data
  const join = (segs) => segs.join("/");
  return {
    db: {},
    doc: (_db, ...segs) => ({ __path: join(segs) }),
    collection: (_db, ...segs) => ({ __coll: join(segs) }),
    setDoc: async (ref, data) => { store.set(ref.__path, data); },
    deleteDoc: async (ref) => { store.delete(ref.__path); },
    getDocs: async (collRef) => {
      const prefix = collRef.__coll + "/";
      const docs = [...store.entries()]
        .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
        .map(([, d]) => d);
      return { forEach: (cb) => docs.forEach((d) => cb({ data: () => d })) };
    },
    _store: store,
  };
}

let fb;
beforeEach(() => { fb = mockFb(); initPurchaseCloud(fb); setPurchaseCloudLicense("LK1"); });

test("persist writes one document per record under the right subcollection path", async () => {
  await purchaseDocsCloud.persist({ id: "PINV-1", supplierName: "A", total: 115 });
  assert.ok(fb._store.has("client_data/LK1/purchase_docs/PINV-1"));
  assert.equal(fb._store.get("client_data/LK1/purchase_docs/PINV-1").total, 115);
});

test("POs go to the purchase_orders subcollection", async () => {
  await purchaseOrdersCloud.persist({ id: "PO-1", poNumber: "PO-1001" });
  assert.ok(fb._store.has("client_data/LK1/purchase_orders/PO-1"));
});

test("loadAll returns every document in the subcollection (not nested)", async () => {
  await purchaseDocsCloud.persist({ id: "PINV-1", total: 1 });
  await purchaseDocsCloud.persist({ id: "PINV-2", total: 2 });
  const all = await purchaseDocsCloud.loadAll();
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((d) => d.id).sort(), ["PINV-1", "PINV-2"]);
});

test("remove deletes the document", async () => {
  await purchaseDocsCloud.persist({ id: "PINV-1", total: 1 });
  await purchaseDocsCloud.remove("PINV-1");
  assert.equal((await purchaseDocsCloud.loadAll()).length, 0);
});

test("writes/reads are a safe no-op when no license is set", async () => {
  setPurchaseCloudLicense(null);
  await purchaseDocsCloud.persist({ id: "X", total: 9 });
  assert.equal(fb._store.size, 0);
  assert.deepEqual(await purchaseDocsCloud.loadAll(), []);
});

test("persist ignores a record with no id", async () => {
  await purchaseDocsCloud.persist({ supplierName: "no id" });
  assert.equal(fb._store.size, 0);
});

// ── mergeById (cloud ↔ local reconciliation) ───────────────────────────────
test("mergeById keeps the most-recently-updated version of each id", () => {
  const cloud = [{ id: "A", total: 1, updatedAt: "2026-11-01T00:00:00Z" }];
  const local = [
    { id: "A", total: 2, updatedAt: "2026-11-05T00:00:00Z" }, // newer locally
    { id: "B", total: 3, updatedAt: "2026-11-02T00:00:00Z" },
  ];
  const merged = mergeById(cloud, local);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((x) => x.id === "A").total, 2); // newer wins
  assert.equal(merged[0].id, "A"); // newest-first
});

test("mergeById skips records without an id", () => {
  const merged = mergeById([{ total: 1 }], [{ id: "A", total: 2 }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "A");
});
