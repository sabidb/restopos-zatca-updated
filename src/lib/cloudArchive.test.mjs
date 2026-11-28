// Failure-injection tests for src/cloudArchive.js (sale persistence) — npm test.
// Mocks the injected Firestore deps and a localStorage shim, then exercises the
// idempotency and failure/retry guarantees that keep sales from being lost or
// duplicated. Uses flushArchive() to persist synchronously (no debounce timer).
import { test } from "node:test";
import assert from "node:assert/strict";
import { initCloudArchive, archiveSalesDay, flushArchive, summariseSales, loadArchivedRange, loadArchivedInvoice } from "../cloudArchive.js";

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
    query: (coll, ...parts) => ({ collPath: coll.collPath, parts }),
    where: (field, op, value) => ({ kind: "where", field, op, value }),
    orderBy: (field, direction) => ({ kind: "orderBy", field, direction }),
    limit: (n) => ({ kind: "limit", n }),
    startAfter: (cursor) => ({ kind: "startAfter", cursor }),
    getDoc: async (ref) => ({ exists: () => !!store[keyOf(ref)], data: () => store[keyOf(ref)] }),
    getDocs: async (q) => {
      let rows=Object.entries(store).filter(([key])=>key.startsWith(q.collPath+"/"));
      for(const part of q.parts||[]){
        if(part.kind==="where"){
          rows=rows.filter(([,data])=>{
            const v=data?.[part.field];
            if(part.op==="==")return v===part.value;
            if(part.op===">=")return String(v||"")>=String(part.value);
            if(part.op==="<=")return String(v||"")<=String(part.value);
            return true;
          });
        }
      }
      rows.sort((a,b)=>String(a[1]?.date||"").localeCompare(String(b[1]?.date||"")));
      return {docs:rows.map(([key,data])=>({id:key.slice(q.collPath.length+1),data:()=>data})),size:rows.length};
    },
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


test("archive summary is status-aware and deduplicates IDs",()=>{
  const rows=[
    sale("A",20,2.61),
    {...sale("A",50,6.52),updatedAt:"2026-11-22T12:00:00Z"},
    {...sale("D",100,13.04),isDraft:true},
    {...sale("R",75,9.78),status:"refunded"},
    {...sale("V",40,5.22),status:"voided"},
    {...sale("P",10,1.30),status:"pending"},
  ];
  const s=summariseSales(rows);
  assert.equal(s.n,1);
  assert.equal(s.total,50);
  assert.equal(s.vat,6.52);
  assert.ok(s.fingerprint);
});
test("archive fingerprint detects same-count same-total content edits",async()=>{
  mem.clear();const store={};initCloudArchive(makeFb(store));
  const first=[{...sale("SAME",100,13),items:[{name:"A",qty:1,price:100}],updatedAt:"2026-11-22T10:00:00Z"}];
  archiveSalesDay("LICD","2026-11-22",first);await flushArchive();
  const indexKey="client_data/LICD/sales_index/index";
  const before=store[indexKey].days["2026-11-22"].fingerprint;
  const second=[{...sale("SAME",100,13),items:[{name:"B",qty:1,price:100}],updatedAt:"2026-11-22T11:00:00Z"}];
  archiveSalesDay("LICD","2026-11-22",second);await flushArchive();
  const after=store[indexKey].days["2026-11-22"].fingerprint;
  assert.notEqual(after,before,"archive index changes even when count and totals do not");
  const docs=invoiceDocs(store,"LICD");
  assert.equal(docs.length,1);
  assert.equal(store[docs[0]].items[0].name,"B");
});

const compactDocs=(store,lic)=>Object.keys(store).filter(k=>k.startsWith(`client_data/${lic}/invoices_compact/`));

test("older day writes compact per-invoice snapshots and verifies index while retaining detailed invoices",async()=>{
  mem.clear();const store={};initCloudArchive(makeFb(store));
  const oldDate="2026-07-01";
  const sales=[
    {...sale("OLD-1",115,15),date:oldDate,items:[{name:"Food",qty:1,price:115,taxCategory:"S"}],receiptHtml:"big"},
    {...sale("OLD-2",23,3),date:oldDate,items:[{name:"Drink",qty:1,price:23,taxCategory:"S"}]},
  ];
  archiveSalesDay("OLDLIC",oldDate,sales);await flushArchive();
  assert.equal(invoiceDocs(store,"OLDLIC").length,2);
  assert.equal(compactDocs(store,"OLDLIC").length,2);
  const index=store["client_data/OLDLIC/sales_index/index"].days[oldDate];
  assert.equal(index.compact.verified,true);
  assert.equal(index.compact.count,2);
  assert.equal(index.compact.total,138);
  assert.equal(index.compact.vat,18);
  assert.equal(index.compact.missingIdCount,0);
  const compactKey="client_data/OLDLIC/invoices_compact/OLD-1";
  assert.equal(store[compactKey].compactArchiveVersion,1);
  assert.equal(store[compactKey].receiptHtml,undefined);
});

test("recent day remains detailed and is not compacted",async()=>{
  mem.clear();const store={};initCloudArchive(makeFb(store));
  const recent="2026-11-22";
  archiveSalesDay("RECENT",recent,[sale("R-1",35,4.57)]);await flushArchive();
  assert.equal(invoiceDocs(store,"RECENT").length,1);
  assert.equal(compactDocs(store,"RECENT").length,0);
});

test("verified compact rows are returned for older archive range and invoice lookup",async()=>{
  mem.clear();const store={};initCloudArchive(makeFb(store));
  const date="2026-07-01";
  const sales=[{...sale("C-1",115,15),date,items:[{name:"Food",qty:1,price:115,privateNote:"drop"}]}];
  archiveSalesDay("COMPACTREAD",date,sales);await flushArchive();
  const rows=await loadArchivedRange("COMPACTREAD",date,date);
  assert.equal(rows.length,1);
  assert.equal(rows[0].compactArchiveVersion,1);
  assert.equal(rows[0].items[0].privateNote,undefined);
  const invoice=await loadArchivedInvoice("COMPACTREAD","C-1");
  assert.equal(invoice.compactArchiveVersion,1);
});

test("compact snapshot is unverified when source records lack invoice IDs",async()=>{
  mem.clear();const store={};initCloudArchive(makeFb(store));
  const date="2026-07-01";
  archiveSalesDay("NOID",date,[ {...sale("N-1",100,13),date},{...sale("",50,6),date}]);await flushArchive();
  const index=store["client_data/NOID/sales_index/index"].days[date];
  assert.equal(index.compact.verified,false);
  assert.equal(index.compact.missingIdCount,1);
  assert.equal(index.compact.compactDocCount,1);
});
