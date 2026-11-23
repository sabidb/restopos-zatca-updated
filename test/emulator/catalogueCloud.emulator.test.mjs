// Firestore-EMULATOR integration test for src/lib/catalogueCloud.js (R1).
// NOT part of `npm test` (CI has no emulator). Run it yourself:
//   1. firebase emulators:start --only firestore      (firebase.json → :8080)
//   2. npm run test:emulator
// Skips cleanly (exit 0) when the emulator isn't reachable.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { initializeApp } from "firebase/app";
import { getFirestore, connectFirestoreEmulator, doc, setDoc, deleteDoc, collection, getDocs, writeBatch } from "firebase/firestore";
import {
  initCatalogueCloud, setCatalogueLicense,
  persistItem, removeItem, loadAllItems, backfillCatalogue,
} from "../../src/lib/catalogueCloud.js";

const HOST = "127.0.0.1", PORT = 8080;
let reachable = false;

before(async () => {
  try { const r = await fetch(`http://${HOST}:${PORT}/`); reachable = r.ok || r.status === 404 || r.status === 200; }
  catch { reachable = false; }
  if (!reachable) {
    console.log(`\n[SKIP] Firestore emulator not reachable at ${HOST}:${PORT}. Start: firebase emulators:start --only firestore\n`);
    return;
  }
  const app = initializeApp({ projectId: "demo-restopos" });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, HOST, PORT);
  initCatalogueCloud({ db, doc, setDoc, deleteDoc, collection, getDocs, writeBatch });
  setCatalogueLicense("EMU-CAT-" + Date.now());
});

test("catalogue: persist → loadAll → remove round-trips through Firestore", async (t) => {
  if (!reachable) return t.skip("emulator not running");
  await persistItem({ id: 101, name: "Milk 1L", barcode: "6281000", price: 5, stock: 20 });
  let all = await loadAllItems();
  assert.ok(all.find((i) => i.id === 101 && i.barcode === "6281000"));
  await removeItem(101);
  all = await loadAllItems();
  assert.ok(!all.find((i) => i.id === 101));
});

test("catalogue: backfill writes a large catalogue in batches", async (t) => {
  if (!reachable) return t.skip("emulator not running");
  const items = Array.from({ length: 450 }, (_, i) => ({ id: 2000 + i, name: "p" + i, price: 1 }));
  const r = await backfillCatalogue(items);
  assert.equal(r.written, 450);
  assert.ok(r.batches >= 2);
  const all = await loadAllItems();
  assert.ok(all.length >= 450);
});
