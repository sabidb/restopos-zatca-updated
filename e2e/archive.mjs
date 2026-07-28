// ═══════════════════════════════════════════════════════════════════
// SALES ARCHIVE TEST
//
// Exercises src/cloudArchive.js against the real Firestore emulator, under the
// real security rules. The questions it has to answer are the ones a client
// will eventually ask: is my history actually in the cloud, does it survive
// past the sizes that broke the old design, and do I get it back on a new
// machine.
//
// Run it:
//   1. npx firebase emulators:start --only firestore,auth \
//        --project restopos-db --config firebase.emulator.json
//   2. cd e2e && npm run archive
// ═══════════════════════════════════════════════════════════════════
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  doc, collection, setDoc, getDoc, getDocs, query, where, orderBy, limit, startAfter, writeBatch,
} from 'firebase/firestore';
import fs from 'fs';

const KEY = 'RESTOARCHIVE1';
const DEVICE = 'device-archive-1';

// localStorage shim — restoreArchiveToDevice writes the device's monthly
// buckets, and Node has no localStorage.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
};

const env = await initializeTestEnvironment({
  projectId: 'restopos-db',
  firestore: { rules: fs.readFileSync('../firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
});
await env.clearFirestore();
await env.withSecurityRulesDisabled(async (ctx) => {
  await setDoc(doc(ctx.firestore(), 'pending_activations', KEY), {
    licenseKey: KEY, status: 'approved', isActive: true, authUids: [DEVICE],
  });
});

const db = env.authenticatedContext(DEVICE).firestore();
const strangerDb = env.authenticatedContext('someone-else').firestore();

const archive = await import('../src/cloudArchive.js');
archive.initCloudArchive({ db, doc, collection, setDoc, getDoc, getDocs, query, where, orderBy, limit, startAfter, writeBatch });

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.log('  ❌', name, '\n       ', String(e.message).split('\n')[0].slice(0, 180)); fail++; }
}
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`); };

// A sale shaped like the real thing, including fields added after creation.
const mkSale = (date, i) => ({
  id: `INV-${date}-${i}`, token: i, voucher: `INV-${i}`, user: 'admin', date,
  time: '14:32', createdAt: `${date}T14:32:${String(i % 60).padStart(2, '0')}.000Z`,
  type: 'Dine-in', billType: 'normal', table: (i % 12) + 1, customer: 'Walk-in',
  customerPhone: '0538360053', items: [
    { name: 'Chicken Mandi', qty: 2, price: 35, category: 'Rice' },
    { name: 'Laban', qty: 1, price: 6, category: 'Drinks' },
  ],
  subtotal: 76, discount: 0, vat: 11.4, total: 87.4, status: 'completed',
  cashier: 'Admin', payMethod: i % 3 === 0 ? 'Card' : 'Cash', isDraft: false,
  zatcaInvoiceNumber: `INV-${String(i).padStart(6, '0')}`,   // added after the sale
});

console.log('\n── one document per bill ──────────────────────────────');
await t('a bill is stored under its own invoice number', async () => {
  const sale = mkSale('2026-07-01', 7);
  archive.archiveSalesDay(KEY, '2026-07-01', [sale]);
  await archive.flushArchive();
  const one = await archive.loadArchivedInvoice(KEY, sale.id);
  if (!one) throw new Error('invoice not found by its own number');
  eq(one.id, sale.id, 'invoice number');
  eq(JSON.stringify(one.items), JSON.stringify(sale.items), 'items');
});
await t('a bill survives the round trip unchanged, late fields included', async () => {
  const sale = { ...mkSale('2026-07-01', 8), status: 'voided', voidReason: 'mistake' };
  archive.archiveSalesDay(KEY, '2026-07-01', [sale]);
  await archive.flushArchive();
  const back = await archive.loadArchivedInvoice(KEY, sale.id);
  for (const k of Object.keys(sale)) {
    if (JSON.stringify(back[k]) !== JSON.stringify(sale[k])) throw new Error(`field ${k} changed`);
  }
});
await t('an unchanged day is not rewritten on the next cycle', async () => {
  const sales = Array.from({ length: 20 }, (_, i) => mkSale('2026-07-05', i));
  archive.archiveSalesDay(KEY, '2026-07-05', sales);
  await archive.flushArchive();
  const before = (await getDocs(collection(db, 'client_data', KEY, 'invoices'))).docs
    .filter((d) => d.data().date === '2026-07-05').map((d) => d.data().archivedAt).sort();
  archive.archiveSalesDay(KEY, '2026-07-05', sales);
  await archive.flushArchive();
  const after = (await getDocs(collection(db, 'client_data', KEY, 'invoices'))).docs
    .filter((d) => d.data().date === '2026-07-05').map((d) => d.data().archivedAt).sort();
  eq(JSON.stringify(after), JSON.stringify(before), 'archivedAt stamps (a rewrite would change them)');
});

console.log('\n── writing and reading ────────────────────────────────');
await t('a busy day (300 sales) round-trips through Firestore', async () => {
  const sales = Array.from({ length: 300 }, (_, i) => mkSale('2026-07-02', i));
  archive.archiveSalesDay(KEY, '2026-07-02', sales);
  await archive.flushArchive();
  const back = await archive.loadArchivedDay(KEY, '2026-07-02');
  eq(back.length, 300, 'sales returned');
  // By identity, not position: several of these share a createdAt second, so
  // position carries no meaning.
  const one = back.find((s) => s.id === sales[7].id);
  if (!one) throw new Error('invoice ' + sales[7].id + ' missing');
  eq(JSON.stringify(one.items), JSON.stringify(sales[7].items), 'items');
});

await t('a day far past any single-document limit stores fine', async () => {
  // 4,000 invoices in one day would have blown the 1 MiB document cap under
  // any scheme that bundles a day together. As separate documents it is
  // simply 4,000 documents.
  const sales = Array.from({ length: 4000 }, (_, i) => mkSale('2026-07-03', i));
  archive.archiveSalesDay(KEY, '2026-07-03', sales);
  await archive.flushArchive();
  const back = await archive.loadArchivedDay(KEY, '2026-07-03');
  eq(back.length, 4000, 'every bill came back');
  eq(new Set(back.map((s) => s.id)).size, 4000, 'distinct invoice numbers');
  if (!back.some((s) => s.id === sales[3999].id)) throw new Error('last invoice missing');
});

await t('adding a bill to a day does not duplicate the others', async () => {
  const sales = Array.from({ length: 5 }, (_, i) => mkSale('2026-07-04', i));
  archive.archiveSalesDay(KEY, '2026-07-04', sales);
  await archive.flushArchive();
  archive.archiveSalesDay(KEY, '2026-07-04', [...sales, mkSale('2026-07-04', 99)]);
  await archive.flushArchive();
  eq((await archive.loadArchivedDay(KEY, '2026-07-04')).length, 6, 'bills after re-archive');
});

await t('a date range reads back in order', async () => {
  for (const d of ['2026-06-10', '2026-06-11', '2026-06-12']) {
    archive.archiveSalesDay(KEY, d, [mkSale(d, 1), mkSale(d, 2)]);
    await archive.flushArchive();
  }
  const range = await archive.loadArchivedRange(KEY, '2026-06-10', '2026-06-11');
  eq(range.length, 4, 'sales in range');
  eq(range[0].date, '2026-06-10', 'oldest first');
  if (range.some((s) => s.date === '2026-06-12')) throw new Error('range leaked a day past its end');
});

await t('the index lists history without reading any invoices', async () => {
  const idx = await archive.loadArchiveIndex(KEY);
  const days = Object.keys(idx).sort();
  if (!days.includes('2026-07-02') || !days.includes('2026-06-10')) throw new Error('index missing days: ' + days.join(','));
  eq(idx['2026-07-02'].n, 300, 'indexed invoice count');
  console.log(`       index holds ${days.length} day(s); 2026-07-02 → ${idx['2026-07-02'].n} invoices, SAR ${idx['2026-07-02'].total}`);
});

console.log('\n── a new device ───────────────────────────────────────');
await t('restores recent history into the device monthly buckets', async () => {
  store.clear();
  const r = await archive.restoreArchiveToDevice(KEY);
  if (!r.days) throw new Error('restored nothing');
  const july = JSON.parse(localStorage.getItem('restopos_sales_2026-07') || '[]');
  const june = JSON.parse(localStorage.getItem('restopos_sales_2026-06') || '[]');
  console.log(`       device now holds ${july.length} July + ${june.length} June sale(s)`);
  if (!july.length || !june.length) throw new Error('a month bucket is empty');
  if (july.some((s, i) => i && s.createdAt < july[i - 1].createdAt)) throw new Error('sales not in time order');
});
await t('restoring twice does not duplicate anything', async () => {
  const before = JSON.parse(localStorage.getItem('restopos_sales_2026-06') || '[]').length;
  await archive.restoreArchiveToDevice(KEY);
  eq(JSON.parse(localStorage.getItem('restopos_sales_2026-06') || '[]').length, before, 'June sales after second restore');
});

console.log('\n── isolation ──────────────────────────────────────────');
await t("another shop cannot read this shop's history", async () => {
  await assertFails(getDocs(collection(strangerDb, 'client_data', KEY, 'sales_days')));
  await assertFails(getDoc(doc(strangerDb, 'client_data', KEY, 'sales_index', 'index')));
});
await t('the owning device still can', () =>
  assertSucceeds(getDocs(collection(db, 'client_data', KEY, 'sales_days'))));

console.log('\n── five-year projection ───────────────────────────────');
{
  const one = JSON.stringify(mkSale('2026-07-01', 1));
  const per = Buffer.byteLength(one);
  const perDay = 300, days = 365 * 5;
  console.log(`  one bill ≈ ${per} bytes as its own document`);
  console.log(`  at ${perDay} bills/day: ${(per * perDay / 1024).toFixed(0)} KB/day, ` +
    `${(per * perDay * days / 1024 / 1024).toFixed(0)} MB over 5 years`);
  console.log(`  5 years = ${(perDay * days).toLocaleString()} documents — each written once, never rewritten`);
}

await env.cleanup();
console.log(`\n${fail === 0 ? '✅ ALL PASSED' : '❌ FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
