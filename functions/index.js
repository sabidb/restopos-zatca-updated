import { onCall, HttpsError } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import crypto from "crypto";

initializeApp();
const db = getFirestore();
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

export const verifyLogin = onCall({ cors: true, region: "us-central1" }, async (req) => {
  const { licenseKey, username, password } = req.data || {};
  if (!licenseKey || !username || !password) {
    throw new HttpsError("invalid-argument", "Missing credentials.");
  }
  const key = String(licenseKey).trim().toUpperCase();
  const enteredUser = String(username).trim().toLowerCase();

  const snap = await db.collection("pending_activations").doc(key).get();
  if (!snap.exists) throw new HttpsError("unauthenticated", "Invalid license key or password.");
  const data = snap.data();

  if (!data.clientUsername || !data.passwordHash) {
    throw new HttpsError("unauthenticated", "This account has no login credentials set yet.");
  }
  if (enteredUser !== data.clientUsername) {
    throw new HttpsError("unauthenticated", "Invalid license key or password.");
  }
  const hashed = sha256(password + "restopos_salt_v1");
  if (hashed !== data.passwordHash) {
    throw new HttpsError("unauthenticated", "Invalid license key or password.");
  }
  if (!data.credentialsApproved) {
    throw new HttpsError("permission-denied", "Account pending admin approval.");
  }
  if (data.isActive === false) {
    throw new HttpsError("permission-denied", "This account has been deactivated.");
  }

  const token = await getAuth().createCustomToken(key, { licenseKey: key, username: enteredUser });
  return { token };
});
