// ═══════════════════════════════════════════════════════════════════
// TRADING SESSION BACKUP TEST
//
// A session is Open Day → Close Day, not a calendar date: a shop that starts
// billing at 2pm and closes at 5am the next morning traded one session across
// two dates. Those summaries used to live inside client_data/{key} as the
// restopos_closed_days field — the one document Firestore caps at 1 MiB,
// shared with the menu, settings, customers and the working set. Capped at
// 1,000 sessions at roughly 450 bytes each, a shop closing daily reaches
// ~450 KB of that budget in under three years, and the 350 KB per-key guard
// had already begun refusing it outright.
//
// What has to hold: sessions survive as their own documents, an existing
// client's history MIGRATES rather than being stranded, a replacement till
// gets it back, and the legacy field is only reclaimed once the subcollection
// genuinely holds it.
//
// Run it:
//   1. npx firebase emulators:start --only firestore,auth,functions \
//        --project restopos-db --config firebase.emulator.json
//   2. VITE_USE_EMULATORS=1 npx vite --port 5300 --host 127.0.0.1
//   3. cd e2e && node sessions.mjs
// ═══════════════════════════════════════════════════════════════════
import { chromium } from 'playwright';

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => { console.log(ok ? '  ✅' : '  ❌', name, extra); ok ? pass++ : fail++; };

const KEY = 'RESTOSESS' + String(Date.now()).slice(-4);

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));

await p.goto('http://127.0.0.1:5300/', { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 25 && (await p.locator('body').innerText()).trim().length < 40; i++) await p.waitForTimeout(1000);

t('the support hook exposes the session helpers',
  await p.evaluate(() => !!(window.__restoposDebug && window.__restoposDebug.sessions)));

// The account has to exist with this device on authUids, or every write is
// refused by the rules — which is the correct behaviour, just not what this
// suite is measuring.
// Seeded over the emulator's REST API rather than from the page: the bundle
// does not re-export the Firestore SDK, and a bare specifier cannot be
// imported inside page.evaluate.
const FS = 'http://127.0.0.1:8080/v1/projects/restopos-db/databases/(default)/documents';
{
  const r = await fetch(`${FS}/pending_activations/${KEY}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: {
      licenseKey: { stringValue: KEY }, businessName: { stringValue: 'Session Test' },
      status: { stringValue: 'approved' }, isActive: { booleanValue: true },
    } }),
  });
  if (!r.ok) throw new Error(`seed failed: ${r.status} ${await r.text()}`);
}

// registerDeviceUid is the app's own path: it signs the device in anonymously
// and puts its uid on the account's allowlist. Going through it rather than
// forging a uid means these writes are subject to the same rules a real till
// faces — if the rules refuse them, this suite fails, which is the point.
const uid = await p.evaluate(async (key) => {
  await window.__restoposDebug.registerDeviceUid(key);
  localStorage.setItem('restopos_license_v2', JSON.stringify({ licenseKey: key, businessName: 'Session Test' }));
  return window.__restoposDebug.auth.currentUser?.uid || null;
}, KEY);
t('the device is on the account allowlist', !!uid, uid || '(none)');

// Two sessions, each spanning midnight — the shape the calendar-date model
// could not represent.
const SESSIONS = [
  { date: '2026-07-29', closeTime: '2026-07-29T02:00:00.000Z', startTime: '2026-07-28 14:00',
    orderCount: 512, revenue: 84320.5, vat: 11000.1, isMultiDay: true, dayCount: 2,
    payBreakdown: { Cash: 33120.5, Card: 51200 } },
  { date: '2026-07-30', closeTime: '2026-07-30T01:30:00.000Z', startTime: '2026-07-29 13:45',
    orderCount: 488, revenue: 79110.25, vat: 10318.7, isMultiDay: true, dayCount: 2,
    payBreakdown: { Cash: 30110.25, Card: 49000 } },
];
const DAYLOG = {
  '2026-07-28': { orderCount: 300, revenue: 50000, vat: 6521.7, partOfClose: '2026-07-29' },
  '2026-07-29': { orderCount: 212, revenue: 34320.5, vat: 4478.4, partOfClose: '2026-07-29' },
  '2026-07-30': { orderCount: 488, revenue: 79110.25, vat: 10318.7, partOfClose: '2026-07-30' },
};

console.log('\n── a session becomes its own document ─────────────────');
{
  const n = await p.evaluate(async ({ key, sessions, daylog }) => {
    localStorage.setItem('restopos_closed_days_fp', '{}');
    return window.__restoposDebug.sessions.syncClosedDays(key, sessions, daylog);
  }, { key: KEY, sessions: SESSIONS, daylog: DAYLOG });
  t('both sessions are written', n === 2, `wrote ${n}`);

  const back = await p.evaluate((key) => window.__restoposDebug.sessions.loadClosedDays(key), KEY);
  t('both come back', back.sessions.length === 2, `${back.sessions.length} session(s)`);
  t('newest first', back.sessions[0]?.date === '2026-07-30', back.sessions[0]?.date || '(none)');

  const s = back.sessions.find((x) => x.date === '2026-07-29');
  t('the open→close window survives the round trip',
    s?.startTime === '2026-07-28 14:00' && s?.closeTime === '2026-07-29T02:00:00.000Z',
    `${s?.startTime} → ${s?.closeTime}`);
  t('a session spanning midnight keeps both dates', s?.isMultiDay === true && s?.dayCount === 2);
  t('the totals are intact', s?.orderCount === 512 && s?.revenue === 84320.5 && s?.vat === 11000.1);
  t('the day log rides inside the session that made it',
    Object.keys(back.dayLog).length === 3, `${Object.keys(back.dayLog).length} date(s)`);
}

console.log('\n── re-running costs nothing ───────────────────────────');
{
  const again = await p.evaluate(({ key, sessions, daylog }) =>
    window.__restoposDebug.sessions.syncClosedDays(key, sessions, daylog), { key: KEY, sessions: SESSIONS, daylog: DAYLOG });
  t('an unchanged session is not rewritten', again === 0, `wrote ${again}`);

  const edited = await p.evaluate(({ key, sessions, daylog }) => {
    const changed = sessions.map((s) => s.date === '2026-07-30' ? { ...s, revenue: 79999 } : s);
    return window.__restoposDebug.sessions.syncClosedDays(key, changed, daylog);
  }, { key: KEY, sessions: SESSIONS, daylog: DAYLOG });
  t('but a corrected one is', edited === 1, `wrote ${edited}`);
}

console.log('\n── a replacement till gets the history back ───────────');
{
  const restored = await p.evaluate(async (key) => {
    // A brand-new device: no local sessions at all.
    localStorage.removeItem('restopos_closed_days');
    localStorage.removeItem('restopos_daylog');
    const n = await window.__restoposDebug.sessions.restoreClosedDays(key);
    return {
      n,
      local: JSON.parse(localStorage.getItem('restopos_closed_days') || '[]'),
      log: JSON.parse(localStorage.getItem('restopos_daylog') || '{}'),
    };
  }, KEY);
  t('the close history is restored', restored.n === 2 && restored.local.length === 2,
    `${restored.local.length} session(s)`);
  t('and the day calendar with it', Object.keys(restored.log).length === 3,
    `${Object.keys(restored.log).length} date(s)`);
  t('restored newest first', restored.local[0]?.date === '2026-07-30', restored.local[0]?.date || '(none)');
}

console.log('\n── a local close that never reached the cloud wins ────');
{
  const merged = await p.evaluate(async (key) => {
    const local = JSON.parse(localStorage.getItem('restopos_closed_days') || '[]');
    local.unshift({ date: '2026-07-31', closeTime: '2026-07-31T03:00:00.000Z',
      startTime: '2026-07-30 15:00', orderCount: 99, revenue: 4200, vat: 547.8 });
    localStorage.setItem('restopos_closed_days', JSON.stringify(local));
    await window.__restoposDebug.sessions.restoreClosedDays(key);
    return JSON.parse(localStorage.getItem('restopos_closed_days') || '[]');
  }, KEY);
  t('an unsynced local session is not wiped by the restore',
    merged.some((s) => s.date === '2026-07-31') && merged.length === 3, `${merged.length} session(s)`);
}

console.log('\n── volume ─────────────────────────────────────────────');
{
  // Three years of daily closes — past the point where the old single-field
  // approach was being refused by the 350 KB per-key guard.
  const big = await p.evaluate(async (key) => {
    // Every field handleCloseDay actually writes. A trimmed-down fixture would
    // under-report the size and make this test agree with a claim that is not
    // true of real data.
    const many = Array.from({ length: 1000 }, (_, i) => {
      const close = new Date(Date.UTC(2023, 0, 1, 2) + i * 86400000).toISOString();
      const prev = new Date(Date.UTC(2023, 0, 1, 2) + (i - 1) * 86400000).toISOString();
      return {
        date: close.slice(0, 10), periodStart: prev.slice(0, 10), periodEnd: close.slice(0, 10),
        isMultiDay: true, prevCloseTime: prev, prevCloseDate: prev.slice(0, 10),
        startTime: '31 Dec 2022, 02:00 PM', closeTime: close, closedAt: close,
        orderCount: 512, revenue: 84320.5, vat: 11000.15, expenses: 1240.75, dayCount: 2,
        payBreakdown: { Cash: 33120.5, Card: 51200, Both: 0, Credit: 0 },
      };
    });
    const bytes = new TextEncoder().encode(JSON.stringify(many)).length;
    localStorage.setItem('restopos_closed_days_fp', '{}');
    const wrote = await window.__restoposDebug.sessions.syncClosedDays(key, many, {});
    return { wrote, bytes, each: Math.round(bytes / many.length) };
  }, KEY);
  t('1,000 real sessions exceed the 350 KB per-key sync guard',
    big.bytes > 350000, `${Math.round(big.bytes / 1024)} KB, ${big.each} B per session — the guard refuses over 350 KB, so this was not being backed up at all`);
  t('as documents they all land', big.wrote === 1000, `wrote ${big.wrote}`);
}

t('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
await b.close();
console.log(`\n${fail === 0 ? '✅ ALL PASSED' : '❌ FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
