// ═══════════════════════════════════════════════════════════════════
// ZATCA ARCHIVE ACCESS TEST — against the real functions
//
// zatca_invoices is one collection shared by every client. A Firestore rule
// cannot inspect a query, so the collection had to be readable by any signed-in
// caller — and the app signs devices in anonymously. Anyone who opened the site
// could read every shop's invoices.
//
// It is closed now, and these three functions are the only way in. The question
// this test has to answer is not "does it work for me" but "does it refuse
// someone else" — so it runs TWO tenants and tries every crossing between them.
//
// Run it:
//   1. npx firebase emulators:start --only firestore,auth,functions \
//        --project restopos-db --config firebase.emulator.json
//   2. cd e2e && node zatca.mjs
// ═══════════════════════════════════════════════════════════════════
const FS = 'http://127.0.0.1:8080/v1/projects/restopos-db/databases/(default)/documents';
const FN = 'http://127.0.0.1:5001/restopos-db/us-central1';
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key';
const H = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };

// Unique per run, VAT included. The emulator keeps data between runs, and a
// reused VAT silently inherits the previous run's invoices — which is how a
// scoping test quietly starts counting the wrong thing.
const RUN = String(Date.now()).slice(-9);
const A = { key: 'RESTOVATA' + RUN.slice(-4), vat: `300${RUN}103`, name: 'Al Bahr' };
const B = { key: 'RESTOVATB' + RUN.slice(-4), vat: `300${RUN}203`, name: 'Rival Shop' };

const sv = (x) => ({ stringValue: String(x) });
const bv = (x) => ({ booleanValue: x });
const iv = (x) => ({ integerValue: String(x) });

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => { console.log(ok ? '  ✅' : '  ❌', name, extra); ok ? pass++ : fail++; };

async function newUser() {
  const r = await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true }) });
  const j = await r.json();
  return { idToken: j.idToken, uid: j.localId };
}

async function call(fn, data, idToken) {
  const headers = { 'Content-Type': 'application/json' };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  const r = await fetch(`${FN}/${fn}`, { method: 'POST', headers, body: JSON.stringify({ data }) });
  const j = await r.json().catch(() => ({}));
  return { result: j.result, error: j.error };
}

async function seedAccount(tenant, uid) {
  const r = await fetch(`${FS}/pending_activations/${tenant.key}`, { method: 'PATCH', headers: H,
    body: JSON.stringify({ fields: {
      licenseKey: sv(tenant.key), businessName: sv(tenant.name), vatNumber: sv(tenant.vat),
      status: sv('approved'), isActive: bv(true), authUids: { arrayValue: { values: [sv(uid)] } },
    } }) });
  if (!r.ok) throw new Error(`seed ${tenant.key}: ${r.status} ${await r.text()}`);
}

// Deliberately IDENTICAL invoice numbers across both tenants. Every shop's
// counter starts at 1000, so this is what really happens — not an edge case.
const mkInvoice = (vat, icv, day) => ({
  invoice_number: `INV-${1000 + icv}`, uuid: `uuid-${vat}-${icv}`, icv,
  seller_vat: vat, seller_name: 'Shop', timestamp: `2026-06-${String(day).padStart(2, '0')}T12:00:00.000Z`,
  total: 100 + icv, vat_amount: 15, subtotal: 85 + icv,
  invoice_hash: `hash-${icv}`, prev_invoice_hash: `hash-${icv - 1}`,
  items: [{ name: 'Chicken Mandi', qty: 1, price: 85 }],
});

const userA = await newUser();
const userB = await newUser();
await seedAccount(A, userA.uid);
await seedAccount(B, userB.uid);

console.log('\n── filing an invoice ──────────────────────────────────');
{
  const r = await call('zatcaArchive', { licenseKey: A.key, invoice: mkInvoice(A.vat, 1, 1) }, userA.idToken);
  t('a till files its own invoice', r.result?.ok === true, r.error?.message || '');
  const g = await fetch(`${FS}/zatca_invoices/${A.vat}__INV-1001`, { headers: H });
  const doc = g.ok ? (await g.json()).fields : null;
  t('it lands in the shared archive under the account VAT',
    doc?.seller_vat?.stringValue === A.vat, doc?.seller_vat?.stringValue || '(absent)');
}

console.log('\n── the crossings that matter ──────────────────────────');
{
  // The whole point: a caller must not be able to name someone else's VAT.
  const r1 = await call('zatcaArchive',
    { licenseKey: A.key, invoice: mkInvoice(B.vat, 99, 1) }, userA.idToken);
  t('cannot file an invoice under another shop VAT', !r1.result && !!r1.error, r1.error?.status || '');

  const r2 = await call('zatcaChain', { licenseKey: B.key }, userA.idToken);
  t('cannot read another shop chain by naming its licence', !r2.result && !!r2.error, r2.error?.status || '');

  const r3 = await call('zatcaExport', { licenseKey: B.key, from: '2026-06-01', to: '2026-06-30' }, userA.idToken);
  t('cannot export another shop archive', !r3.result && !!r3.error, r3.error?.status || '');

  const r4 = await call('zatcaChain', { licenseKey: A.key }, null);
  t('unauthenticated is refused outright', !r4.result && !!r4.error, r4.error?.status || '');
}

console.log('\n── the chain each tenant sees ─────────────────────────');
{
  for (let i = 2; i <= 5; i++) await call('zatcaArchive', { licenseKey: A.key, invoice: mkInvoice(A.vat, i, i) }, userA.idToken);
  for (let i = 1; i <= 3; i++) await call('zatcaArchive', { licenseKey: B.key, invoice: mkInvoice(B.vat, i, i) }, userB.idToken);

  const a = (await call('zatcaChain', { licenseKey: A.key, limit: 50 }, userA.idToken)).result;
  t('chain head is this tenant latest ICV', a?.latestIcv === 5, `icv=${a?.latestIcv}`);
  t('chain head carries the hash to continue from', a?.latestHash === 'hash-5', a?.latestHash || '');
  t('recent invoices are this tenant only',
    a?.recent?.length === 5 && a.recent.every((x) => x.seller_vat === A.vat),
    `${a?.recent?.length} invoice(s), VATs: ${[...new Set((a?.recent || []).map((x) => x.seller_vat))].join(', ')}`);

  const b = (await call('zatcaChain', { licenseKey: B.key, limit: 50 }, userB.idToken)).result;
  t('the other tenant sees its own, shorter chain',
    b?.latestIcv === 3 && b.recent.every((x) => x.seller_vat === B.vat), `icv=${b?.latestIcv}`);
  // Both shops filed an INV-1001. Keyed on the invoice number alone — as this
  // collection was — the second would have destroyed the first.
  const aOne = a?.recent?.find((x) => x.invoice_number === 'INV-1001');
  const bOne = b?.recent?.find((x) => x.invoice_number === 'INV-1001');
  t('two shops with the SAME invoice number both survive',
    !!aOne && !!bOne && aOne.seller_vat === A.vat && bOne.seller_vat === B.vat,
    `A:${aOne?.seller_vat || 'lost'}  B:${bOne?.seller_vat || 'lost'}`);
}

console.log('\n── export ─────────────────────────────────────────────');
{
  const c = (await call('zatcaExport', { licenseKey: A.key, from: '2026-06-01', to: '2026-06-30', countOnly: true }, userA.idToken)).result;
  t('count covers this tenant only', c?.count === 5, `count=${c?.count} (the other shop has 3 in the same range)`);

  let cursor = null, seen = [], pages = 0;
  do {
    const r = (await call('zatcaExport', { licenseKey: A.key, from: '2026-06-01', to: '2026-06-30', cursor, pageSize: 2 }, userA.idToken)).result;
    seen.push(...(r?.invoices || []));
    cursor = r?.nextCursor || null;
    if (++pages > 10) break;
  } while (cursor);
  t('paging returns every invoice exactly once',
    seen.length === 5 && new Set(seen.map((x) => x.invoice_number)).size === 5, `${seen.length} over ${pages} page(s)`);
  t('and never leaks the other tenant', seen.every((x) => x.seller_vat === A.vat));

  const narrow = (await call('zatcaExport', { licenseKey: A.key, from: '2026-06-02', to: '2026-06-03', countOnly: true }, userA.idToken)).result;
  t('the date range is honoured', narrow?.count === 2, `count=${narrow?.count}`);
}

console.log(`\n${fail === 0 ? '✅ ALL PASSED' : '❌ FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
