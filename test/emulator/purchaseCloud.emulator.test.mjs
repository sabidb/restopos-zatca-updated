// Firestore-EMULATOR integration test for src/lib/purchaseCloud.js.
//
// This is NOT part of `npm test` (CI has no emulator). Run it yourself:
//
//   1. firebase emulators:start --only firestore      (uses firebase.json → :8080)
//   2. in another shell:  npm run test:emulator
//
// It exercises the real Firestore modular SDK against the emulator, so it
// verifies the actual subcollection reads/writes/deletes that the mock unit
// tests (src/lib/purchaseCloud.test.mjs) can only approximate.
//
// If the emulator isn't reachable it SKIPS (exit 0) rather than failing, so a
// missing emulator never looks like a broken test.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { initializeApp } from "firebase/app";
import { getFirestore, connectFirestoreEmulator, doc, setDoc, deleteDoc, collection, getDocs } from "firebase/firestore";
import {
  initPurchaseCloud, setPurchaseCloudLicense,
  purchaseDocsCloud, purchaseOrdersCloud,
} from "../../src/lib/purchaseCloud.js";

const HOST = "127.0.0.1";
const PORT = 8080;

// Skip cleanly when the emulator isn't up.
let reachable = false;
before(async () => {
  try {
    const res = await fetch(`http://${HOST}:${PORT}/`, { method: "GET" });
    reachable = res.ok || res.status === 200 || res.status === 404; // any HTTP answer = up
  } catch { reachable = false; }
  if (!reachable) {
    console.log(`\n[SKIP] Firestore emulator not reachable at ${HOST}:${PORT}.`);
    console.log("       Start it with:  firebase emulators:start --only firestore\n");
    return;
  }
  const app = initializeApp({ projectId: "demo-restopos" }); // demo- → no credentials needed
  const db = getFirestore(app);
  connectFirestoreEmulator(db, HOST, PORT);
  initPurchaseCloud({ db, doc, setDoc, deleteDoc, collection, getDocs });
  setPurchaseCloudLicense("EMUTEST-" + Date.now());
});

test("purchase invoice: persist → loadAll → remove round-trips through Firestore", async (t) => {
  if (!reachable) return t.skip("emulator not running");
  const inv = { id: "PINV-emu-1", docType: "invoice", supplierName: "Emu Co", supplierInvoiceNo: "E-1", total: 115 };
  await purchaseDocsCloud.persist(inv);
  let all = await purchaseDocsCloud.loadAll();
  assert.ok(all.find((d) => d.id === "PINV-emu-1" && d.total === 115), "persisted doc should load back");
  await purchaseDocsCloud.remove("PINV-emu-1");
  all = await purchaseDocsCloud.loadAll();
  assert.ok(!all.find((d) => d.id === "PINV-emu-1"), "removed doc should be gone");
});

test("purchase order persists to its own subcollection, separate from invoices", async (t) => {
  if (!reachable) return t.skip("emulator not running");
  await purchaseOrdersCloud.persist({ id: "PO-emu-1", poNumber: "PO-E1", orderedValue: 50 });
  const pos = await purchaseOrdersCloud.loadAll();
  const invs = await purchaseDocsCloud.loadAll();
  assert.ok(pos.find((d) => d.id === "PO-emu-1"), "PO should be in purchase_orders");
  assert.ok(!invs.find((d) => d.id === "PO-emu-1"), "PO must NOT leak into purchase_docs");
  await purchaseOrdersCloud.remove("PO-emu-1");
});
