// ═══════════════════════════════════════════════════════════════════════════
// verifyLogin — Functions emulator integration test
//
// Drives the REAL verifyLogin Cloud Function through the Firebase emulators
// (Functions + Firestore + Auth), not a mock. It seeds accounts with the Admin
// SDK, mints a device identity from the Auth emulator, calls the callable over
// HTTP exactly as the browser does, and asserts the full device-approval flow:
//
//   • every device — including the first — must wait for admin approval;
//   • the device's Firebase uid is recorded on the pending request so the
//     admin panel can grant it data access;
//   • once approved, verifyLogin issues a custom token;
//   • wrong password / unapproved / deactivated accounts are refused with the
//     right error codes and never leak a token.
//
// Run it (needs firebase-tools + a JRE on PATH):
//   cd functions && npm install
//   firebase emulators:exec --project restopos-db --only functions,firestore,auth \
//     "node --test test/"
//
// The emulator sets FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST for
// this process; ports come from firebase.json. No network or real project is
// touched.
// ═══════════════════════════════════════════════════════════════════════════
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import bcrypt from "bcryptjs";

const PROJECT = process.env.GCLOUD_PROJECT || process.env.GCLOUD_PROJECT_ID || "restopos-db";
const REGION = "us-central1";
const FN_HOST = process.env.FUNCTIONS_EMULATOR_ORIGIN || "http://127.0.0.1:5001";
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";

const KEY = "LIC-INT-TEST-1";
const USERNAME = "shopowner";
const PASSWORD = "Secret123";
const DEVICE_ID = "device-abc-123";

let db;

before(() => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "FIRESTORE_EMULATOR_HOST must be set (run under emulators:exec)");
  assert.ok(process.env.FIREBASE_AUTH_EMULATOR_HOST, "FIREBASE_AUTH_EMULATOR_HOST must be set (run under emulators:exec)");
  initializeApp({ projectId: PROJECT });
  db = getFirestore();
});

// A fresh, approved account with a real bcrypt hash the function will verify.
async function seedApprovedAccount(extra = {}) {
  await db.collection("pending_activations").doc(KEY).set({
    businessName: "Test Diner",
    clientUsername: USERNAME,
    passwordHash: await bcrypt.hash(PASSWORD, 12),
    credentialsApproved: true,
    credentialsSet: true,
    isActive: true,
    authUids: [],
    ...extra,
  });
}

// Mint an anonymous user in the Auth emulator and return a usable ID token +
// its uid. verifyLogin reads req.auth.uid from this token.
async function mintDeviceIdentity() {
  const res = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ returnSecureToken: true }) }
  );
  const j = await res.json();
  assert.ok(j.idToken && j.localId, "Auth emulator should return an idToken + localId: " + JSON.stringify(j));
  return { idToken: j.idToken, uid: j.localId };
}

// Call the verifyLogin callable over HTTP, the same envelope the browser SDK uses.
async function callVerifyLogin(data, idToken) {
  const res = await fetch(`${FN_HOST}/${PROJECT}/${REGION}/verifyLogin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
    body: JSON.stringify({ data }),
  });
  return { http: res.status, body: await res.json() };
}

beforeEach(async () => {
  await db.collection("pending_activations").doc(KEY).delete().catch(() => {});
});

test("first login on a device waits for approval and records the device uid", async () => {
  await seedApprovedAccount();
  const { uid, idToken } = await mintDeviceIdentity();

  const { http, body } = await callVerifyLogin(
    { licenseKey: KEY, username: USERNAME, password: PASSWORD, deviceId: DEVICE_ID, deviceLabel: "Windows · Chrome" },
    idToken
  );

  assert.equal(http, 200, "correct password should not be an HTTP error");
  assert.equal(body.result?.deviceStatus, "pending", "an unapproved (even first) device must wait");
  assert.equal(body.result?.token, undefined, "no token may be issued to a pending device");

  const doc = (await db.collection("pending_activations").doc(KEY).get()).data();
  const entry = (doc.pendingDevices || []).find((d) => d.id === DEVICE_ID);
  assert.ok(entry, "device should be added to pendingDevices");
  assert.equal(entry.uid, uid, "the device's real Firebase uid must be recorded for later approval");
  assert.ok(!(doc.approvedDevices || []).some((d) => (d.id || d) === DEVICE_ID), "device must NOT be auto-approved");
});

test("an approved device receives a custom token and account details", async () => {
  await seedApprovedAccount({ approvedDevices: [{ id: DEVICE_ID, label: "Windows · Chrome" }] });
  const { idToken } = await mintDeviceIdentity();

  const { http, body } = await callVerifyLogin(
    { licenseKey: KEY, username: USERNAME, password: PASSWORD, deviceId: DEVICE_ID, deviceLabel: "Windows · Chrome" },
    idToken
  );

  assert.equal(http, 200);
  assert.equal(body.result?.deviceStatus, "approved");
  assert.ok(typeof body.result?.token === "string" && body.result.token.length > 0, "approved device must get a token");
  assert.equal(body.result?.businessName, "Test Diner");
});

test("wrong password is rejected as unauthenticated with no token", async () => {
  await seedApprovedAccount({ approvedDevices: [{ id: DEVICE_ID }] });
  const { idToken } = await mintDeviceIdentity();

  const { body } = await callVerifyLogin(
    { licenseKey: KEY, username: USERNAME, password: "wrong-password", deviceId: DEVICE_ID },
    idToken
  );

  assert.equal(body.error?.status, "UNAUTHENTICATED");
  assert.equal(body.result, undefined);
});

test("an account still awaiting admin approval is refused with permission-denied", async () => {
  await seedApprovedAccount({ credentialsApproved: false });
  const { idToken } = await mintDeviceIdentity();

  const { body } = await callVerifyLogin(
    { licenseKey: KEY, username: USERNAME, password: PASSWORD, deviceId: DEVICE_ID },
    idToken
  );

  assert.equal(body.error?.status, "PERMISSION_DENIED");
});

test("a deactivated account is refused with permission-denied", async () => {
  await seedApprovedAccount({ isActive: false, approvedDevices: [{ id: DEVICE_ID }] });
  const { idToken } = await mintDeviceIdentity();

  const { body } = await callVerifyLogin(
    { licenseKey: KEY, username: USERNAME, password: PASSWORD, deviceId: DEVICE_ID },
    idToken
  );

  assert.equal(body.error?.status, "PERMISSION_DENIED");
});
