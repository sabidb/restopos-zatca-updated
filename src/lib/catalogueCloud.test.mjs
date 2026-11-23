// Golden tests for src/lib/catalogueCloud.js — run with: npm test
// Mock-based (no live Firestore); a real-emulator suite lives in test/emulator/.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  initCatalogueCloud, setCatalogueLicense,
  persistItem, removeItem, loadAllItems, backfillCatalogue,
  catalogueCloud, buildBarcodeIndex, CATALOGUE_COLL,
} from "./catalogueCloud.js";

function mockFb() {
  const store = new Map();
  const join = (segs) => segs.join("/");
  return {
    db: {},
    doc: (_db, ...segs) => ({ __path: join(segs) }),
    collection: (_db, ...segs) => ({ __coll: join(segs) }),
    setDoc: async (ref, data) => { store.set(ref.__path, data); },
    deleteDoc: async (ref) => { store.delete(ref.__path); },
    getDocs: async (collRef) => {
      const prefix = collRef.__coll + "/";
      const docs = [...store.entries()].filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/")).map(([, d]) => d);
      return { forEach: (cb) => docs.forEach((d) => cb({ data: () => d })) };
    },
    writeBatch: (_db) => {
      const ops = [];
      return { set: (ref, data) => ops.push([ref.__path, data]), commit: async () => { for (const [p, d] of ops) store.set(p, d); } };
    },
    _store: store,
  };
}

let fb;
beforeEach(() => { fb = mockFb(); initCatalogueCloud(fb); setCatalogueLicense("LK1"); });

test("persist writes one doc per product under the catalogue subcollection", async () => {
  await persistItem({ id: 7, name: "Milk" });
  assert.ok(fb._store.has(`client_data/LK1/${CATALOGUE_COLL}/7`));
});

test("loadAllItems returns the whole catalogue; remove deletes one", async () => {
  await persistItem({ id: 1, name: "A" });
  await persistItem({ id: 2, name: "B" });
  assert.equal((await loadAllItems()).length, 2);
  await removeItem(1);
  const all = await loadAllItems();
  assert.deepEqual(all.map((i) => i.id).sort(), [2]);
});

test("backfill writes everything in batches of <=400 and is idempotent", async () => {
  const items = Array.from({ length: 401 }, (_, i) => ({ id: i + 1, name: "p" + i }));
  const r = await backfillCatalogue(items);
  assert.equal(r.written, 401);
  assert.equal(r.batches, 2);                 // 400 + 1
  assert.equal((await loadAllItems()).length, 401);
  // re-run: same ids, no duplicates
  await backfillCatalogue(items);
  assert.equal((await loadAllItems()).length, 401);
});

test("no license → safe no-ops", async () => {
  setCatalogueLicense(null);
  await persistItem({ id: 9, name: "X" });
  assert.equal(fb._store.size, 0);
  assert.deepEqual(await loadAllItems(), []);
  assert.deepEqual(await backfillCatalogue([{ id: 1 }]), { written: 0, batches: 0 });
});

test("catalogueCloud adapter proxies persist/remove/loadAll", async () => {
  await catalogueCloud.persist({ id: 5, name: "Z" });
  assert.ok(fb._store.has(`client_data/LK1/${CATALOGUE_COLL}/5`));
  await catalogueCloud.remove(5);
  assert.equal((await catalogueCloud.loadAll()).length, 0);
});

test("buildBarcodeIndex maps every barcode to its product (incl. multi-barcode)", () => {
  const items = [
    { id: 1, name: "Milk", barcode: "111" },
    { id: 2, name: "Bread", barcodes: ["222", "333"] },
  ];
  const idx = buildBarcodeIndex(items);
  assert.equal(idx.get("111").id, 1);
  assert.equal(idx.get("222").id, 2);
  assert.equal(idx.get("333").id, 2);
});
