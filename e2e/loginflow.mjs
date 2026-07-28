// ═══════════════════════════════════════════════════════════════════
// LOGIN + ARCHIVE WIRING TEST
//
// Drives the real app in a real browser against the emulators. Two things a
// build will never tell you: whether the app still boots after a change (twice
// this has been broken by a reference used before its declaration, which
// compiles fine and renders a blank page), and whether a sale that a cashier
// actually rings up reaches the cloud archive.
//
// Run it:
//   1. npx firebase emulators:start --only firestore,auth \
//        --project restopos-db --config firebase.emulator.json
//   2. VITE_USE_EMULATORS=1 npx vite --port 5300 --host 127.0.0.1
//   3. cd e2e && node loginflow.mjs
// ═══════════════════════════════════════════════════════════════════
import { chromium } from 'playwright';
const SP = process.env.SCREENSHOT_DIR || '/tmp';
const BASE = 'http://127.0.0.1:8080/v1/projects/restopos-db/databases/(default)/documents';
const H = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
const KEY = 'RESTOLOGIN1';

const v = (x) => typeof x === 'boolean' ? { booleanValue: x }
  : typeof x === 'number' ? { integerValue: String(x) }
  : Array.isArray(x) ? { arrayValue: { values: x.map(v) } } : { stringValue: String(x) };
const fields = (o) => Object.fromEntries(Object.entries(o).map(([k, x]) => [k, v(x)]));
async function put(path, obj) {
  const r = await fetch(`${BASE}/${path}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: fields(obj) }) });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
}
async function patch(path, obj) {
  const mask = Object.keys(obj).map((k) => `updateMask.fieldPaths=${k}`).join('&');
  const r = await fetch(`${BASE}/${path}?${mask}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: fields(obj) }) });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
}
// Every bill is its own document now, so the archive is listed by invoice and
// the business days are derived from them.
async function listBills(key) {
  const r = await fetch(`${BASE}/client_data/${key}/invoices`, { headers: H });
  if (!r.ok) return [];
  return (await r.json()).documents || [];
}

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => { console.log(ok ? '  ✅' : '  ❌', name, extra); ok ? pass++ : fail++; };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

// Warm the dev server first. Vite transforms a 16k-line module on the first
// request, which can outlast any sane per-test timeout and looks exactly like
// a blank-page bug.
{
  const w = await (await b.newContext()).newPage();
  await w.goto('http://127.0.0.1:5300/', { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 20 && (await w.locator('body').innerText()).trim().length < 40; i++) await w.waitForTimeout(1000);
  await w.context().close();
}

// ── 1. The app still boots ─────────────────────────────────────────
console.log('\n── boot ───────────────────────────────────────────────');
{
  const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
  p.on('console', (m) => { const x = m.text();
    if (m.type() === 'error' && !/favicon|manifest|net::ERR|Failed to load resource|preload|installations|Could not reach/i.test(x)) errs.push('CONSOLE: ' + x.slice(0, 160)); });
  await p.goto('http://127.0.0.1:5300/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(4000);
  const body = await p.locator('body').innerText();
  t('boots with no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  t('renders something (not a blank page)', body.trim().length > 40, `${body.trim().length} chars`);
  // index.html used to hardcode lang="ar" dir="rtl" while the app's own default
  // language is English, so every pre-login screen laid English out backwards.
  const doc = await p.evaluate(() => ({ dir: document.documentElement.dir, lang: document.documentElement.lang }));
  t('document reads left-to-right for English', doc.dir === 'ltr' && doc.lang === 'en', JSON.stringify(doc));
  const fieldDir = await p.evaluate(() => {
    const el = document.querySelector('input[placeholder="Mohammed Al-Rashid"]');
    return el ? getComputedStyle(el.closest('div')).direction : 'no-field';
  });
  t('registration fields are not mirrored', fieldDir === 'ltr', fieldDir);
  await p.screenshot({ path: SP + '/70-boot.png' });
  await p.context().close();
}

// ── 2. An admin password reset must not strand the client ──────────
console.log('\n── admin password reset ───────────────────────────────');
{
  await put(`licenses/${KEY}`, { key: KEY, active: true });
  await put(`pending_activations/${KEY}`, {
    licenseKey: KEY, businessName: 'Al Bahr Supermarket', status: 'approved',
    credentialsApproved: true, credentialsSet: true, isActive: true, forceLogout: false,
    clientUsername: 'albahr', subscriptionPlan: 'premium', customExpiryDate: '2030-12-31',
    passwordResetByAdmin: false,
  });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://127.0.0.1:5300/', { waitUntil: 'domcontentloaded' });
  await p.evaluate((k) => {
    localStorage.setItem('restopos_license_v2', JSON.stringify({ licenseKey: k, businessName: 'Al Bahr Supermarket' }));
    localStorage.setItem('restopos_client_creds', JSON.stringify({ salt: 'aa', verifier: 'bb', username: 'albahr', approved: true, active: true }));
  }, KEY);
  await p.goto('http://127.0.0.1:5300/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3500);
  t('starts at the login screen', /Sign In|Log ?in|Username/i.test(await p.locator('body').innerText()));

  // The admin resets the password: passwordHash cleared, credentialsSet false.
  await patch(`pending_activations/${KEY}`, { passwordResetByAdmin: true, credentialsSet: false, credentialsApproved: false });
  let landed = false;
  for (let i = 0; i < 40; i++) {
    if (/Create Login|Set a username/i.test(await p.locator('body').innerText())) { landed = true; break; }
    await p.waitForTimeout(250);
  }
  t('client is sent to Create Login, not a dead end', landed);
  const cleared = await p.evaluate(() => localStorage.getItem('restopos_client_creds'));
  t('stale offline verifier is cleared', cleared === null, cleared ? '(still present)' : '');
  await p.screenshot({ path: SP + '/71-reset.png' });
  t('no page errors during the reset', errs.length === 0, errs.slice(0, 2).join(' | '));
  await p.context().close();
}

// ── 3. A real sale reaches the cloud archive ───────────────────────
console.log('\n── a real sale reaches the archive ────────────────────');
{
  const p = await (await b.newContext({ viewport: { width: 1400, height: 950 } })).newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://127.0.0.1:5300/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2500);

  // A trial is the one path that reaches the till without device approval.
  await p.getByRole('button', { name: /Start my free 14-day trial/ }).click();
  await p.waitForTimeout(1000);
  const modal = p.locator('div[style*="z-index: 9000"]');
  const mi = modal.locator('input[type=text], input:not([type])');
  await mi.nth(0).fill('Archive Test Shop');
  await mi.nth(1).fill('Sabith Saleem');
  await mi.nth(2).fill('0511122233');
  await modal.getByRole('button', { name: '▶ Start my 14 days' }).click();
  await p.waitForTimeout(1200);
  await p.locator('input[type=checkbox]').first().check();
  await p.getByRole('button', { name: 'I Agree and Continue' }).click();
  await p.waitForTimeout(6000);
  await p.screenshot({ path: SP + '/72-trial-in.png' });

  const trialKey = 'TRIAL-0511122233';
  const inTill = !/Start my free 14-day trial/.test(await p.locator('body').innerText());
  t('trial signup reaches the app', inTill);

  if (inTill) {
    // Put history on the device the way an upgrading client already has it —
    // sitting in localStorage, never yet uploaded — and let the app's own
    // backfill find it. That is the path that decides whether an existing
    // client's back catalogue ever reaches the cloud.
    const today = await p.evaluate(() => {
      const d = new Date().toISOString().slice(0, 10);
      const older = '2026-05-14';
      const mk = (date, i) => ({
        id: `INV-${date}-${i}`, date, time: '12:00', createdAt: `${date}T12:0${i}:00.000Z`,
        type: 'Dine-in', items: [{ name: 'Chicken Mandi', qty: 2, price: 35, category: 'Rice' }],
        subtotal: 70, vat: 10.5, total: 80.5, discount: 0, status: 'completed',
        cashier: 'Admin', payMethod: 'Cash', isDraft: false,
      });
      localStorage.setItem('restopos_sales', JSON.stringify([mk(d, 1), mk(d, 2)]));
      // An old month bucket and the close-day pile — both device-only before.
      localStorage.setItem('restopos_sales_2026-05', JSON.stringify([mk(older, 1)]));
      localStorage.setItem('restopos_archived_sales', JSON.stringify([mk('2026-05-15', 1)]));
      return d;
    });
    await p.reload({ waitUntil: 'domcontentloaded' });
    // Backfill fires 8s after boot, then the archive debounces another 8s.
    await p.waitForTimeout(20000);
    await p.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await p.waitForTimeout(3000);

    let bills = [];
    for (let i = 0; i < 30; i++) {
      bills = await listBills(trialKey);
      if (bills.length >= 4) break;
      await p.waitForTimeout(1000);
    }
    const dates = [...new Set(bills.map((d) => d.fields?.date?.stringValue))].sort();
    const ids = bills.map((d) => d.fields?.id?.stringValue);
    t('backfill uploads history already on the device', bills.length >= 4,
      `${bills.length} bill(s) over: ${dates.join(', ') || 'none'}`);
    t("today's sales reached the cloud", dates.includes(today), `expected ${today}`);
    t('an old month bucket reached the cloud', dates.includes('2026-05-14'));
    t('close-day archived sales reached the cloud', dates.includes('2026-05-15'));
    // The point of the rewrite: a bill is retrievable on its own, under its own
    // invoice number, rather than buried in a blob of the whole day.
    t('each bill is its own document, keyed by invoice number',
      ids.includes('INV-2026-05-14-1')
      && bills.every((d) => d.name.endsWith('/' + d.fields.id.stringValue)),
      ids.slice(0, 3).join(', '));
  }
  t('no page errors during trial + sale', errs.length === 0, errs.slice(0, 3).join(' | '));
  await p.context().close();
}

await b.close();
console.log(`\n${fail === 0 ? '✅ ALL PASSED' : '❌ FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
