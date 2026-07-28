// ═══════════════════════════════════════════════════════════════════
// FIRESTORE RULES TESTS
//
// firestore.rules guards live tills: a wrong rule can lock out a shop
// mid-service or expose one client's data to another. These run the real
// rules against the Firestore emulator so that never has to be discovered
// in production.
//
//   cd rules-test && npm install && npm test
//
// CI runs this on every push and pull request. Add a case here whenever
// you add or change a rule.
// ═══════════════════════════════════════════════════════════════════
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, updateDoc, collection, getDocs, writeBatch } from 'firebase/firestore';
import fs from 'fs';

// Rules live at the repo root; this suite runs from rules-test/.
const RULES_PATH = '../firestore.rules';

const TRIAL = 'TRIAL-0512345678';
const DEVICE = 'device-uid-1';       // the trial's own device
const STRANGER = 'device-uid-2';     // a different signed-in device
const ADMIN = { email: '8742sabithsaleem@gmail.com', email_verified: true };

const env = await initializeTestEnvironment({
  projectId: 'demo-restopos',
  firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
});

// Seed the trial account with DEVICE on its allowlist, bypassing rules.
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'pending_activations', TRIAL), {
    licenseKey: TRIAL, isTrial: true, trialSource: 'self-serve', status: 'pending',
    credentialsApproved: false, isActive: true, phone: '0512345678',
    businessName: 'Test Mart', authUids: [DEVICE],
  });
  await setDoc(doc(db, 'pending_activations', 'REALCLIENT'), {
    licenseKey: 'REALCLIENT', status: 'approved', credentialsApproved: true, authUids: ['other-device'],
  });
});

const owner = env.authenticatedContext(DEVICE).firestore();
const stranger = env.authenticatedContext(STRANGER).firestore();
const admin = env.authenticatedContext('admin-uid', ADMIN).firestore();
const anon = env.unauthenticatedContext().firestore();

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.log('  ❌', name, '\n       ', String(e.message).split('\n')[0].slice(0, 150)); fail++; }
}

console.log('\n── NEW: trials collection ─────────────────────────────');
await t('trial device writes its own summary', () =>
  assertSucceeds(setDoc(doc(owner, 'trials', TRIAL), { mobile: '0512345678', invoiceCount: 3 })));
await t('trial device writes its own sales subcollection', () =>
  assertSucceeds(setDoc(doc(owner, 'trials', TRIAL, 'sales', 'INV-1001'), { total: 23 })));
await t('trial device writes products and customers', async () => {
  await assertSucceeds(setDoc(doc(owner, 'trials', TRIAL, 'products', '11'), { name: 'Milk' }));
  await assertSucceeds(setDoc(doc(owner, 'trials', TRIAL, 'customers', '900'), { name: 'Abdullah' }));
});
await t('trial device reads its own data back', () =>
  assertSucceeds(getDoc(doc(owner, 'trials', TRIAL))));
await t('batched write of many rows is allowed (the mirror uses batches)', async () => {
  const b = writeBatch(owner);
  for (let i = 0; i < 60; i++) b.set(doc(owner, 'trials', TRIAL, 'sales', 'B' + i), { total: i });
  await assertSucceeds(b.commit());
});
await t('ANOTHER signed-in device cannot write this trial', () =>
  assertFails(setDoc(doc(stranger, 'trials', TRIAL), { mobile: 'hacked' })));
await t('ANOTHER signed-in device cannot write its subcollections', () =>
  assertFails(setDoc(doc(stranger, 'trials', TRIAL, 'sales', 'INV-9'), { total: 1 })));
await t('ANOTHER signed-in device cannot READ this trial', () =>
  assertFails(getDoc(doc(stranger, 'trials', TRIAL))));
await t('unauthenticated cannot touch trials', () =>
  assertFails(getDoc(doc(anon, 'trials', TRIAL))));
await t('admin reads any trial', () =>
  assertSucceeds(getDoc(doc(admin, 'trials', TRIAL))));
await t('admin lists trials and subcollections', async () => {
  await assertSucceeds(getDocs(collection(admin, 'trials')));
  await assertSucceeds(getDocs(collection(admin, 'trials', TRIAL, 'sales')));
});

console.log('\n── REGRESSION: existing rules must still hold ─────────');
await t('client creates a trial activation (status pending, not approved)', () =>
  assertSucceeds(setDoc(doc(stranger, 'pending_activations', 'TRIAL-0599999999'), {
    licenseKey: 'TRIAL-0599999999', isTrial: true, status: 'pending',
    credentialsApproved: false, authUids: [STRANGER] })));
await t('client CANNOT self-create an approved account', () =>
  assertFails(setDoc(doc(stranger, 'pending_activations', 'CHEAT1'), {
    status: 'approved', credentialsApproved: true })));
await t('device may add itself to authUids', () =>
  assertSucceeds(updateDoc(doc(owner, 'pending_activations', TRIAL), { authUids: [DEVICE, 'new-device'] })));
await t('device CANNOT flip its own status to approved', () =>
  assertFails(updateDoc(doc(owner, 'pending_activations', TRIAL), { status: 'approved' })));
await t('device CANNOT extend its own expiry', () =>
  assertFails(updateDoc(doc(owner, 'pending_activations', TRIAL), { customExpiryDate: '2099-01-01' })));
await t('client records terms acceptance at registration', () =>
  assertSucceeds(setDoc(doc(stranger, 'pending_activations', 'TRIAL-0577777777'), {
    licenseKey: 'TRIAL-0577777777', status: 'pending', credentialsApproved: false,
    authUids: [STRANGER], termsAccepted: true,
    termsAcceptedAt: '2026-07-28T09:00:00.000Z', termsVersion: '1.0',
    termsAcceptance: { fullName: 'Someone', electronicSignature: 'Someone' } })));
await t('client CANNOT rewrite its own acceptance afterwards', () =>
  assertFails(updateDoc(doc(owner, 'pending_activations', TRIAL), {
    termsAcceptedAt: '2020-01-01T00:00:00.000Z' })));
await t('client CANNOT withdraw its acceptance', () =>
  assertFails(updateDoc(doc(owner, 'pending_activations', TRIAL), { termsAccepted: false })));
await t('admin CAN correct an acceptance record', () =>
  assertSucceeds(updateDoc(doc(admin, 'pending_activations', TRIAL), {
    termsAccepted: true, termsVersion: '1.0' })));
await t('admin CAN approve and set expiry', () =>
  assertSucceeds(updateDoc(doc(admin, 'pending_activations', TRIAL), {
    status: 'approved', customExpiryDate: '2026-12-31' })));
await t('owner reads/writes its own client_data', async () => {
  await assertSucceeds(setDoc(doc(owner, 'client_data', TRIAL), { restopos_items: '[]' }));
  await assertSucceeds(getDoc(doc(owner, 'client_data', TRIAL)));
});
await t('stranger CANNOT read another account client_data', () =>
  assertFails(getDoc(doc(stranger, 'client_data', TRIAL))));
await t('locked secrets stay locked (config/ai, zatca_egs)', async () => {
  await assertFails(getDoc(doc(owner, 'config', 'ai')));
  await assertFails(getDoc(doc(admin, 'zatca_egs', TRIAL)));
});
await t('config/announcement: signed-in reads, only admin writes', async () => {
  await assertSucceeds(getDoc(doc(owner, 'config', 'announcement')));
  await assertFails(setDoc(doc(owner, 'config', 'announcement'), { text: 'nope' }));
  await assertSucceeds(setDoc(doc(admin, 'config', 'announcement'), { text: 'ok' }));
});
await t('zatca_invoices still writable by a signed-in till', () =>
  assertSucceeds(setDoc(doc(owner, 'zatca_invoices', 'INV-000001'), { seller_vat: '3000' })));
await t('anything unmatched is still denied', () =>
  assertFails(setDoc(doc(owner, 'some_new_collection', 'x'), { a: 1 })));

// ═══════════════════════════════════════════════════════════════════
// TENANT ISOLATION
//
// The app signs devices in with signInAnonymously and the Firebase config
// ships in the client bundle, so ANY visitor can hold a signed-in token.
// These cases pin down what that token is not allowed to reach. `stranger`
// below is exactly that: authenticated, and entitled to nothing.
// ═══════════════════════════════════════════════════════════════════
console.log('\n── NEW: tenant isolation under anonymous auth ─────────');

await t('stranger CANNOT list every client (mass PII export)', () =>
  assertFails(getDocs(collection(stranger, 'pending_activations'))));
await t('admin CAN still list clients', () =>
  assertSucceeds(getDocs(collection(admin, 'pending_activations'))));
await t('a device CAN still get its own account by key', () =>
  assertSucceeds(getDoc(doc(owner, 'pending_activations', TRIAL))));

await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'licenses', 'LIC-1'), { active: true, issuedTo: '' });
  await setDoc(doc(db, 'email_index', 'victim@example.com'), { licenseKey: 'REALCLIENT' });
  await setDoc(doc(db, 'zatca_invoices', 'INV-CHAIN'), {
    invoice_number: 'INV-CHAIN', seller_vat: '300000000000003', total: 115,
    vat_amount: 15, icv: 42, invoice_hash: 'abc123', prev_invoice_hash: 'zzz999',
  });
  await setDoc(doc(db, 'live_chats', 'chat_REALCLIENT'), { licenseKey: 'REALCLIENT' });
  await setDoc(doc(db, 'live_chats', 'chat_REALCLIENT', 'messages', 'm1'), { text: 'private' });
});

await t('stranger CANNOT list the license catalogue', () =>
  assertFails(getDocs(collection(stranger, 'licenses'))));
await t('activation CAN stamp its own metadata on a license', () =>
  assertSucceeds(updateDoc(doc(owner, 'licenses', 'LIC-1'), {
    activatedBy: '1010101010', activatedAt: 'now', businessName: 'Test Mart' })));
await t('client CANNOT flip a license kill switch back on', () =>
  assertFails(updateDoc(doc(owner, 'licenses', 'LIC-1'), { active: false })));
await t('admin CAN flip a license kill switch', () =>
  assertSucceeds(updateDoc(doc(admin, 'licenses', 'LIC-1'), { active: false })));

// The takeover this blocks: point an index entry you can write at a license
// you do not own, then drive the password-reset path through it.
await t('stranger CANNOT aim an index entry at a license it does not own', async () => {
  await assertFails(setDoc(doc(stranger, 'email_index', 'attacker@example.com'), { licenseKey: 'REALCLIENT' }));
  await assertFails(updateDoc(doc(stranger, 'email_index', 'victim@example.com'), { licenseKey: 'REALCLIENT' }));
});
await t('registerDeviceUid CAN write the index for its own license', () =>
  assertSucceeds(setDoc(doc(owner, 'vat_index', '300000000000003'),
    { authUids: [DEVICE], licenseKey: TRIAL }, { merge: true })));
// A lapsed client buying a new key re-registers the same email against it.
// Freezing the mapping outright would have broken exactly this.
await t('a returning client CAN repoint their own email to a new owned key', () =>
  assertSucceeds(setDoc(doc(owner, 'email_index', 'victim@example.com'),
    { licenseKey: TRIAL }, { merge: true })));

await t('stranger CANNOT rewrite an archived invoice hash chain', async () => {
  await assertFails(updateDoc(doc(stranger, 'zatca_invoices', 'INV-CHAIN'), { invoice_hash: 'forged' }));
  await assertFails(updateDoc(doc(stranger, 'zatca_invoices', 'INV-CHAIN'), { total: 1 }));
  await assertFails(updateDoc(doc(stranger, 'zatca_invoices', 'INV-CHAIN'), { icv: 1 }));
});
await t('re-archiving the same invoice still succeeds (idempotent)', () =>
  assertSucceeds(setDoc(doc(owner, 'zatca_invoices', 'INV-CHAIN'), {
    invoice_number: 'INV-CHAIN', seller_vat: '300000000000003', total: 115,
    vat_amount: 15, icv: 42, invoice_hash: 'abc123', prev_invoice_hash: 'zzz999',
    archived_at: 'later',
  }, { merge: true })));
await t('a clearance update may add fields to an invoice', () =>
  assertSucceeds(updateDoc(doc(owner, 'zatca_invoices', 'INV-CHAIN'), {
    zatca_status: 'CLEARED', cleared_at: 'now' })));

await t('stranger CANNOT read another client support chat', async () => {
  await assertFails(getDoc(doc(stranger, 'live_chats', 'chat_REALCLIENT')));
  await assertFails(getDocs(collection(stranger, 'live_chats', 'chat_REALCLIENT', 'messages')));
});
await t('a client CAN use its own support chat', async () => {
  await assertSucceeds(setDoc(doc(owner, 'live_chats', `chat_${TRIAL}`), { licenseKey: TRIAL }));
  await assertSucceeds(setDoc(doc(owner, 'live_chats', `chat_${TRIAL}`, 'messages', 'm1'), { text: 'hi' }));
  await assertSucceeds(getDocs(collection(owner, 'live_chats', `chat_${TRIAL}`, 'messages')));
});
await t('admin CAN read every support chat', async () => {
  await assertSucceeds(getDoc(doc(admin, 'live_chats', 'chat_REALCLIENT')));
  await assertSucceeds(getDocs(collection(admin, 'live_chats', 'chat_REALCLIENT', 'messages')));
});
// The admin panel lists these collections directly; a rule that denied the
// list would empty the console's screens without any obvious error.
await t('admin panel CAN still list its console collections', async () => {
  await assertSucceeds(getDocs(collection(admin, 'live_chats')));
  await assertSucceeds(getDocs(collection(admin, 'licenses')));
  await assertSucceeds(getDocs(collection(admin, 'support_tickets')));
  await assertSucceeds(getDocs(collection(admin, 'trials')));
  await assertSucceeds(getDocs(collection(admin, 'activity_log')));
  await assertSucceeds(getDocs(collection(admin, 'manager_logins')));
});
await t('stranger CANNOT list the support chat rooms', () =>
  assertFails(getDocs(collection(stranger, 'live_chats'))));
// The till restores its ZATCA hash chain with a collection query, so this
// list has to keep working — rules cannot express "only your own VAT".
await t('a till CAN still query the invoice archive', () =>
  assertSucceeds(getDocs(collection(owner, 'zatca_invoices'))));

await env.cleanup();
console.log(`\n${fail === 0 ? '✅ ALL PASSED' : '❌ FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
