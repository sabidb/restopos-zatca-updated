// ═══════════════════════════════════════════════════════════════════
// CLOUD STORAGE RULES TESTS
//
// The bucket holds every client's commercial registration and VAT
// certificate, plus support-chat photos of their own tills. Until now it had
// no rules file at all — whatever is live was set in the console, and
// Firebase's default template grants access to any signed-in caller. This app
// signs devices in anonymously, so "any signed-in caller" is the public.
//
// The question each case answers is not "can the owner get its file" but
// "is someone else refused" — so every path is tried from a second, unrelated
// device as well.
//
//   cd rules-test && npm run test:storage
// ═══════════════════════════════════════════════════════════════════
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';
import { ref, uploadBytes, getBytes, deleteObject } from 'firebase/storage';
import fs from 'fs';

const KEY_A = 'RESTOSHOPA';
const KEY_B = 'RESTOSHOPB';
const DEVICE_A = 'device-a';
const DEVICE_B = 'device-b';
const ADMIN = { email: '8742sabithsaleem@gmail.com', email_verified: true };

const env = await initializeTestEnvironment({
  projectId: 'demo-restopos',
  firestore: { rules: fs.readFileSync('../firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
  storage: { rules: fs.readFileSync('../storage.rules', 'utf8'), host: '127.0.0.1', port: 9199 },
});

// Ownership lives in Firestore, so the accounts have to exist for the storage
// rules to resolve authUids at all.
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'pending_activations', KEY_A), { licenseKey: KEY_A, authUids: [DEVICE_A] });
  await setDoc(doc(db, 'pending_activations', KEY_B), { licenseKey: KEY_B, authUids: [DEVICE_B] });
});

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.log('  ❌', name, '—', (e && e.message || e).slice(0, 120)); fail++; }
}

const bytes = (n = 16) => new Uint8Array(n).fill(65);
const asA = () => env.authenticatedContext(DEVICE_A).storage();
const asB = () => env.authenticatedContext(DEVICE_B).storage();
const asAdmin = () => env.authenticatedContext('admin-uid', ADMIN).storage();
const asAnon = () => env.unauthenticatedContext().storage();

// Seed one filed certificate for shop A, bypassing rules.
await env.withSecurityRulesDisabled(async (ctx) => {
  await uploadBytes(ref(ctx.storage(), `documents/${KEY_A}/cr_1_seed.pdf`), bytes(), { contentType: 'application/pdf' });
  await uploadBytes(ctx.storage().ref?.(`chat/chat_${KEY_A}/1_seed.jpg`) || ref(ctx.storage(), `chat/chat_${KEY_A}/1_seed.jpg`), bytes(), { contentType: 'image/jpeg' });
});

console.log('\n── registration documents ─────────────────────────────');
await t('a shop uploads its own CR certificate', () =>
  assertSucceeds(uploadBytes(ref(asA(), `documents/${KEY_A}/cr_2_mine.pdf`), bytes(), { contentType: 'application/pdf' })));

await t('and can read it back', () =>
  assertSucceeds(getBytes(ref(asA(), `documents/${KEY_A}/cr_1_seed.pdf`))));

await t('ANOTHER shop cannot read it', () =>
  assertFails(getBytes(ref(asB(), `documents/${KEY_A}/cr_1_seed.pdf`))));

await t('another shop cannot file documents under it', () =>
  assertFails(uploadBytes(ref(asB(), `documents/${KEY_A}/cr_3_theirs.pdf`), bytes(), { contentType: 'application/pdf' })));

await t('an unauthenticated visitor cannot read it', () =>
  assertFails(getBytes(ref(asAnon(), `documents/${KEY_A}/cr_1_seed.pdf`))));

await t('a device with no account at all is refused', () =>
  assertFails(uploadBytes(ref(env.authenticatedContext('nobody').storage(), `documents/${KEY_A}/x.pdf`), bytes())));

await t('the owner cannot overwrite a filed certificate', () =>
  assertFails(uploadBytes(ref(asA(), `documents/${KEY_A}/cr_1_seed.pdf`), bytes(32), { contentType: 'application/pdf' })));

await t('the owner cannot delete a filed certificate', () =>
  assertFails(deleteObject(ref(asA(), `documents/${KEY_A}/cr_1_seed.pdf`))));

await t('the admin can read any shop documents', () =>
  assertSucceeds(getBytes(ref(asAdmin(), `documents/${KEY_A}/cr_1_seed.pdf`))));

await t('an oversized upload is refused', () =>
  assertFails(uploadBytes(ref(asA(), `documents/${KEY_A}/huge.pdf`), new Uint8Array(11 * 1024 * 1024), { contentType: 'application/pdf' })));

console.log('\n── support chat photos ────────────────────────────────');
await t('a shop posts a photo to its own room', () =>
  assertSucceeds(uploadBytes(ref(asA(), `chat/chat_${KEY_A}/2_mine.jpg`), bytes(), { contentType: 'image/jpeg' })));

await t('and reads its own room', () =>
  assertSucceeds(getBytes(ref(asA(), `chat/chat_${KEY_A}/1_seed.jpg`))));

await t('another shop cannot read that room', () =>
  assertFails(getBytes(ref(asB(), `chat/chat_${KEY_A}/1_seed.jpg`))));

await t('another shop cannot post into that room', () =>
  assertFails(uploadBytes(ref(asB(), `chat/chat_${KEY_A}/3_theirs.jpg`), bytes(), { contentType: 'image/jpeg' })));

await t('a non-image is refused in chat', () =>
  assertFails(uploadBytes(ref(asA(), `chat/chat_${KEY_A}/4_payload.html`), bytes(), { contentType: 'text/html' })));

await t('a room name that is not chat_<key> is refused', () =>
  assertFails(uploadBytes(ref(asA(), `chat/random-room/5.jpg`), bytes(), { contentType: 'image/jpeg' })));

await t('the admin can read any room', () =>
  assertSucceeds(getBytes(ref(asAdmin(), `chat/chat_${KEY_A}/1_seed.jpg`))));

console.log('\n── everything else is closed ──────────────────────────');
await t('an unlisted path is refused even to the owner', () =>
  assertFails(uploadBytes(ref(asA(), `whatever/${KEY_A}/file.bin`), bytes())));

await t('the bucket root is refused', () =>
  assertFails(uploadBytes(ref(asA(), `dropped.bin`), bytes())));

await t('an unauthenticated upload anywhere is refused', () =>
  assertFails(uploadBytes(ref(asAnon(), `documents/${KEY_A}/anon.pdf`), bytes())));

await env.cleanup();
console.log(`\n${fail === 0 ? '✅ ALL PASSED' : '❌ FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
