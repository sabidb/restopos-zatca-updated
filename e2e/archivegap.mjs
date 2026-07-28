// ═══════════════════════════════════════════════════════════════════
// ARCHIVE GAP TEST — carrying a till across the upgrade
//
// The previous build wrote invoices straight to Firestore. Closing that door
// in the rules makes those writes fail, and the old build's only response was
// a console warning — so an invoice rung up in the window between the rules
// landing and the till picking up the new bundle would have stayed in
// localStorage and never reached the permanent record.
//
// This is what makes closing the rules safe to do at any moment rather than
// something that has to be timed against a browser refresh. It checks that a
// till holding invoices the archive has never confirmed notices, and files
// them.
//
// Run it:
//   1. npx firebase emulators:start --only firestore,auth,functions \
//        --project restopos-db --config firebase.emulator.json
//   2. VITE_USE_EMULATORS=1 npx vite --port 5300 --host 127.0.0.1
//   3. cd e2e && node archivegap.mjs
// ═══════════════════════════════════════════════════════════════════
import { chromium } from 'playwright';

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => { console.log(ok ? '  ✅' : '  ❌', name, extra); ok ? pass++ : fail++; };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));

await p.goto('http://127.0.0.1:5300/', { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 25 && (await p.locator('body').innerText()).trim().length < 40; i++) await p.waitForTimeout(1000);

const hook = async () => p.evaluate(() => !!(window.__restoposDebug && window.__restoposDebug.invoiceStorage));
t('the support hook exposes invoice storage', await hook());

// A till carrying invoices that were never confirmed filed — exactly what the
// previous build leaves behind once direct writes start failing.
const state = await p.evaluate(() => {
  const inv = (n, icv) => ({
    invoice_number: n, icv, seller_vat: '300111111100003', timestamp: '2026-06-01T12:00:00.000Z',
    total: 100, vat_amount: 15, invoice_hash: 'h' + icv, items: [{ name: 'Mandi', qty: 1, price: 85 }],
  });
  localStorage.setItem('zatca_invoices_v2', JSON.stringify([inv('INV-1001', 1), inv('INV-1002', 2), inv('INV-1003', 3)]));
  localStorage.removeItem('zatca_archived_numbers');
  localStorage.removeItem('zatca_archive_pending');
  const st = window.__restoposDebug.invoiceStorage;
  const queued = st.backfillArchiveGaps();
  return { queued, pending: st.pendingArchiveCount() };
});
t('every unconfirmed invoice is noticed', state.queued === 3, `queued ${state.queued}`);
t('and held for filing', state.pending === 3, `pending ${state.pending}`);

// Confirming one must remove it from the gap — otherwise every sync would
// re-queue the entire local cache forever.
const after = await p.evaluate(() => {
  const st = window.__restoposDebug.invoiceStorage;
  localStorage.setItem('zatca_archive_pending', '[]');
  st.markArchived(['INV-1002']);
  return { queued: st.backfillArchiveGaps(), pending: st.pendingArchiveCount() };
});
t('a confirmed invoice is not queued again', after.queued === 2, `queued ${after.queued}`);

// Nothing left unconfirmed means nothing to do — the steady state.
const steady = await p.evaluate(() => {
  const st = window.__restoposDebug.invoiceStorage;
  localStorage.setItem('zatca_archive_pending', '[]');
  st.markArchived(['INV-1001', 'INV-1003']);
  return st.backfillArchiveGaps();
});
t('a till already in step queues nothing', steady === 0, `queued ${steady}`);

// The queue must survive a reload: an invoice held during an outage is only
// useful if it is still there when the connection returns.
const survived = await p.evaluate(() => {
  const st = window.__restoposDebug.invoiceStorage;
  localStorage.removeItem('zatca_archived_numbers');
  st.backfillArchiveGaps();
  return st.pendingArchiveCount();
});
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2500);
const afterReload = await p.evaluate(() => window.__restoposDebug.invoiceStorage.pendingArchiveCount());
t('the queue survives a reload', survived === 3 && afterReload === 3, `before ${survived}, after ${afterReload}`);

// The local cache holds up to 5,000 invoices. Re-filing all of them on the
// first sync after an upgrade would be twenty minutes of calls to rewrite
// invoices that are already there, so the search is bounded to the window
// that can actually be at risk.
const bounded = await p.evaluate(() => {
  const st = window.__restoposDebug.invoiceStorage;
  const many = Array.from({ length: 1200 }, (_, i) => ({
    invoice_number: 'INV-' + (2000 + i), icv: i, seller_vat: '300111111100003',
    timestamp: '2026-06-01T12:00:00.000Z', total: 100, vat_amount: 15, items: [],
  }));
  localStorage.setItem('zatca_invoices_v2', JSON.stringify(many));
  localStorage.removeItem('zatca_archived_numbers');
  localStorage.setItem('zatca_archive_pending', '[]');
  return st.backfillArchiveGaps();
});
t('a huge local cache does not trigger a call storm', bounded === 300, `queued ${bounded} of 1,200`);

t('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
await b.close();
console.log(`\n${fail === 0 ? '✅ ALL PASSED' : '❌ FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
