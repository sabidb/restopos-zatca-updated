// ═══════════════════════════════════════════════════════════════════
// REPORTS ↔ CLOUD ARCHIVE TEST
//
// A client asking for an old month must not be told "0 orders" while the
// month sits safely in Firestore. This seeds history that exists ONLY in the
// cloud — nothing in localStorage — then drives the real Reports screen and
// checks it says so, downloads it on request, and reports the true totals.
//
// Run it:
//   1. npx firebase emulators:start --only firestore,auth \
//        --project restopos-db --config firebase.emulator.json
//   2. VITE_USE_EMULATORS=1 npx vite --port 5300 --host 127.0.0.1
//   3. cd e2e && node reports.mjs
// ═══════════════════════════════════════════════════════════════════
import { chromium } from 'playwright';
const SP = process.env.SCREENSHOT_DIR || '/tmp';
const BASE = 'http://127.0.0.1:8080/v1/projects/restopos-db/databases/(default)/documents';
const H = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
// Unique per run: the emulator keeps state between runs, and a reused trial key
// silently inherits the previous run's history, which quietly voids the premise.
const PHONE = '05' + String(Date.now()).slice(-8);
const KEY = `TRIAL-${PHONE}`;

// Three days that exist only in the cloud, well before anything this device
// could have. 12 invoices, SAR 1,200 in total — numbers chosen so a partial
// load is obvious rather than plausible.
const CLOUD_DAYS = ['2026-03-10', '2026-03-11', '2026-03-12'];
const PER_DAY = 4;
const EACH = 100;

const mkSale = (date, i) => ({
  id: `INV-${date}-${i}`, date, time: '13:00', createdAt: `${date}T13:0${i}:00.000Z`,
  type: 'Dine-in', items: [{ name: 'Chicken Mandi', qty: 1, price: 86.96, category: 'Rice' }],
  subtotal: 86.96, vat: 13.04, total: EACH, discount: 0, status: 'completed',
  cashier: 'Admin', payMethod: 'Cash', isDraft: false,
});

function encodeDay(sales) {
  const cols = []; const seen = new Set();
  for (const s of sales) for (const k of Object.keys(s)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
  return { v: 1, cols, rows: sales.map((s) => cols.map((c) => (s[c] === undefined ? null : s[c]))) };
}
const sv = (x) => ({ stringValue: String(x) });
const iv = (x) => ({ integerValue: String(x) });
const dv = (x) => ({ doubleValue: x });

async function seedCloudOnlyHistory() {
  const days = {};
  for (const date of CLOUD_DAYS) {
    const sales = Array.from({ length: PER_DAY }, (_, i) => mkSale(date, i));
    const body = { fields: {
      date: sv(date), part: iv(1), parts: iv(1), count: iv(sales.length),
      invoiceCount: iv(sales.length), revenue: dv(PER_DAY * EACH), vat: dv(PER_DAY * 13.04),
      encoding: iv(1), data: sv(JSON.stringify(encodeDay(sales))), updatedAt: sv(new Date().toISOString()),
    } };
    const r = await fetch(`${BASE}/client_data/${KEY}/sales_days/${date}`, { method: 'PATCH', headers: H, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`seed ${date}: ${r.status} ${await r.text()}`);
    days[date] = { mapValue: { fields: { n: iv(PER_DAY), total: dv(PER_DAY * EACH), vat: dv(PER_DAY * 13.04), parts: iv(1) } } };
  }
  const r = await fetch(`${BASE}/client_data/${KEY}/sales_index/index`, { method: 'PATCH', headers: H,
    body: JSON.stringify({ fields: { licenseKey: sv(KEY), days: { mapValue: { fields: days } }, updatedAt: sv(new Date().toISOString()) } }) });
  if (!r.ok) throw new Error(`seed index: ${r.status} ${await r.text()}`);
}

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => { console.log(ok ? '  ✅' : '  ❌', name, extra); ok ? pass++ : fail++; };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await (await b.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
p.on('console', (m) => { const x = m.text();
  if (m.type() === 'error' && !/favicon|manifest|net::ERR|Failed to load resource|preload|installations|Could not reach/i.test(x)) errs.push('CONSOLE: ' + x.slice(0, 160)); });

// Warm vite, then sign a trial up so we land inside the till.
await p.goto('http://127.0.0.1:5300/', { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 25 && (await p.locator('body').innerText()).trim().length < 40; i++) await p.waitForTimeout(1000);

await p.getByRole('button', { name: /Start my free 14-day trial/ }).click();
await p.waitForTimeout(900);
const modal = p.locator('div[style*="z-index: 9000"]');
const mi = modal.locator('input[type=text], input:not([type])');
await mi.nth(0).fill('Cloud Reports Shop');
await mi.nth(1).fill('Sabith Saleem');
await mi.nth(2).fill(PHONE);
await modal.getByRole('button', { name: '▶ Start my 14 days' }).click();
await p.waitForTimeout(1000);
await p.locator('input[type=checkbox]').first().check();
await p.getByRole('button', { name: 'I Agree and Continue' }).click();
await p.waitForTimeout(6000);
t('reached the till', !/Start my free 14-day trial/.test(await p.locator('body').innerText()));

// Make this look like a device that has been in use, so the new-device restore
// does NOT run. That restore is working (it pulled these days down on the first
// attempt at this test, which is the behaviour we want) — but it would hide the
// case being tested here: an established till whose older months have aged off
// the device and now live only in the cloud.
await p.evaluate(() => {
  // Wipe any sales this device has, whatever their provenance, so "only in the
  // cloud" is a fact rather than an assumption.
  const kill = [];
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.includes('restopos_sales')) kill.push(k); }
  kill.forEach((k) => localStorage.removeItem(k));
  localStorage.setItem('restopos_items', JSON.stringify([{ id: 'i1', name: 'Chicken Mandi', price: 35, category: 'Rice' }]));
});
await seedCloudOnlyHistory();
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForTimeout(6000);

const local = await p.evaluate(() => {
  let n = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.includes('restopos_sales')) { try { n += JSON.parse(localStorage.getItem(k) || '[]').length; } catch (e) {} }
  }
  return n;
});
t('device holds none of it locally', local === 0, `${local} local sale(s)`);

// Into Reports.
const navReports = p.getByRole('button').filter({ hasText: /^\s*(📋\s*)?Reports\s*$/ }).first();
if (await navReports.count() === 0) {
  console.log('   nav buttons:', await p.evaluate(() => Array.from(document.querySelectorAll('button')).map((b) => b.innerText.trim()).filter(Boolean).slice(0, 25).join(' | ')));
}
await navReports.click();
await p.waitForTimeout(2500);
await p.screenshot({ path: SP + '/60-reports.png' });

const dateInputs = p.locator('input[type=date]');
await dateInputs.nth(0).fill('2026-03-01');
await dateInputs.nth(1).fill('2026-03-31');
await p.waitForTimeout(1500);

const body1 = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
t('warns the period is not all on this device', /stored in the cloud, not on this device/i.test(body1),
  body1.match(/[\d,]+ invoices? in this period[^.]*\./)?.[0] || '(no warning)');
t('names the right number of invoices', /12 invoices in this period/.test(body1));
t('totals exclude cloud data until loaded', /0 orders/.test(body1) || / 0 orders/.test(body1),
  body1.match(/\d+ orders · [^·]*/)?.[0] || '');
await p.screenshot({ path: SP + '/61-gap.png' });

// Download it.
await p.getByRole('button', { name: /Load from cloud/i }).click();
let loaded = false;
for (let i = 0; i < 40; i++) {
  const bt = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
  if (/This period is complete/i.test(bt)) { loaded = true; break; }
  await p.waitForTimeout(500);
}
t('downloads the period on request', loaded);
await p.waitForTimeout(800);
const body2 = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
t('now reports the real order count', /12 orders/.test(body2), body2.match(/\d+ orders · [^·]*/)?.[0] || '');
// fmtSAR renders without a thousands separator, so match the app's own format.
t('now reports the real revenue', /SAR ?1,?200\.00/.test(body2), body2.match(/SAR ?[\d,]+\.\d\d/)?.[0] || '');
t('tells the client what history exists', /Cloud history: 3 days/i.test(body2),
  body2.match(/Cloud history:[^.]*\./)?.[0] || '(absent)');
await p.screenshot({ path: SP + '/62-loaded.png' });

// A range with nothing missing must not nag.
await dateInputs.nth(0).fill('2026-03-10');
await dateInputs.nth(1).fill('2026-03-12');
await p.waitForTimeout(1200);
t('no warning once the range is fully loaded',
  !/stored in the cloud, not on this device/i.test((await p.locator('body').innerText()).replace(/\s+/g, ' ')));

console.log('\nPAGE ERRORS:', errs.length ? errs.slice(0, 5) : 'none ✅');
if (errs.length) fail++;
await b.close();
console.log(`\n${fail === 0 ? '✅ ALL PASSED' : '❌ FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
