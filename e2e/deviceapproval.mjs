// ═══════════════════════════════════════════════════════════════════
// DEVICE APPROVAL TEST — against the real verifyLogin function
//
// The rule is: the FIRST device on an account signs in without waiting for
// anyone; every device after it needs the owner's approval. That decision must
// be made on the server, because the version that lived in the browser could
// be — and was — bypassed by simply writing to approvedDevices.
//
// This calls the deployed-shape callable in the functions emulator, so what is
// tested is the code that actually runs in production, not a reimplementation.
//
// Run it:
//   1. npx firebase emulators:start --only firestore,auth,functions \
//        --project restopos-db --config firebase.emulator.json
//   2. cd e2e && node deviceapproval.mjs
// ═══════════════════════════════════════════════════════════════════
import bcrypt from '../functions/node_modules/bcryptjs/index.js';

const FS = 'http://127.0.0.1:8080/v1/projects/restopos-db/databases/(default)/documents';
const FN = 'http://127.0.0.1:5001/restopos-db/us-central1/verifyLogin';
const H = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
const KEY = 'RESTODEV' + String(Date.now()).slice(-5);
const USER = 'albahr';
const PASS = 'correct-horse';

const sv = (x) => ({ stringValue: String(x) });
const bv = (x) => ({ booleanValue: x });

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => { console.log(ok ? '  ✅' : '  ❌', name, extra); ok ? pass++ : fail++; };

async function readAccount() {
  const r = await fetch(`${FS}/pending_activations/${KEY}`, { headers: H });
  return r.ok ? (await r.json()).fields || {} : {};
}
const arrIds = (f) => (f?.arrayValue?.values || []).map((v) => v.mapValue?.fields?.id?.stringValue);

async function login(deviceId, deviceLabel) {
  const r = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { licenseKey: KEY, username: USER, password: PASS, deviceId, deviceLabel } }) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, result: j.result, error: j.error };
}

// One approved account with credentials set and NO devices yet — a client who
// has just finished registration.
const r0 = await fetch(`${FS}/pending_activations/${KEY}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: {
  licenseKey: sv(KEY), businessName: sv('Al Bahr Supermarket'), status: sv('approved'),
  isActive: bv(true), credentialsApproved: bv(true), credentialsSet: bv(true),
  clientUsername: sv(USER), passwordHash: sv(await bcrypt.hash(PASS, 10)),
} }) });
if (!r0.ok) { console.error('seed failed', r0.status, await r0.text()); process.exit(1); }

console.log('\n── the first device ───────────────────────────────────');
{
  const a = await login('device-A', 'Windows · Chrome');
  t('signs in with no approval needed', !!a.result?.token, a.error?.message || `deviceStatus=${a.result?.deviceStatus}`);
  t('is flagged as the first device', a.result?.firstDevice === true);
  const acct = await readAccount();
  t('is recorded on the allowlist', arrIds(acct.approvedDevices).includes('device-A'),
    `approved=[${arrIds(acct.approvedDevices).join(', ')}]`);
}

console.log('\n── a second device, same username and password ────────');
{
  const bLogin = await login('device-B', 'Android · Chrome');
  t('is NOT signed in', !bLogin.result?.token, bLogin.result?.token ? 'got a token!' : '');
  t('is told it is waiting for approval', bLogin.result?.deviceStatus === 'pending', `deviceStatus=${bLogin.result?.deviceStatus}`);
  const acct = await readAccount();
  t('appears in the owner\'s pending list', arrIds(acct.pendingDevices).includes('device-B'),
    `pending=[${arrIds(acct.pendingDevices).join(', ')}]`);
  t('does NOT sneak onto the allowlist', !arrIds(acct.approvedDevices).includes('device-B'));

  // Asking twice must not queue the same device twice.
  await login('device-B', 'Android · Chrome');
  const again = await readAccount();
  t('asking twice does not duplicate the request',
    arrIds(again.pendingDevices).filter((x) => x === 'device-B').length === 1);
}

console.log('\n── the admin panel is told ────────────────────────────');
{
  const r = await fetch(`${FS}/activity_log`, { headers: H });
  const docs = (await r.json()).documents || [];
  const entry = docs.find((d) => d.fields?.action?.stringValue === 'DEVICE_LOGIN_REQUEST'
    && d.fields?.licenseKey?.stringValue === KEY);
  t('a durable Activity entry is written', !!entry,
    entry ? entry.fields.details.stringValue.slice(0, 90) : '(none found)');
  t('it names the business and the device',
    !!entry && /Al Bahr Supermarket/.test(entry.fields.user.stringValue) && /Android · Chrome/.test(entry.fields.details.stringValue));
}

console.log('\n── after the owner approves it ────────────────────────');
{
  // Exactly what the admin panel's Approve button writes.
  const acct = await readAccount();
  const approved = (acct.approvedDevices?.arrayValue?.values || []).concat([
    { mapValue: { fields: { id: sv('device-B'), label: sv('Android · Chrome'), approvedAt: sv(new Date().toISOString()) } } },
  ]);
  const r = await fetch(`${FS}/pending_activations/${KEY}?updateMask.fieldPaths=approvedDevices&updateMask.fieldPaths=pendingDevices`,
    { method: 'PATCH', headers: H, body: JSON.stringify({ fields: {
      approvedDevices: { arrayValue: { values: approved } }, pendingDevices: { arrayValue: { values: [] } } } }) });
  if (!r.ok) console.log('   approve write failed', r.status, await r.text());
  const b2 = await login('device-B', 'Android · Chrome');
  t('the second device can now sign in', !!b2.result?.token, b2.result?.deviceStatus || '');
  t('and is not treated as a first device', b2.result?.firstDevice !== true);
}

console.log('\n── a wrong password still fails, device or not ────────');
{
  const r = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { licenseKey: KEY, username: USER, password: 'wrong', deviceId: 'device-A' } }) });
  const j = await r.json().catch(() => ({}));
  t('rejected before any device logic runs', !j.result?.token && !!j.error);
}

console.log(`\n${fail === 0 ? '✅ ALL PASSED' : '❌ FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
