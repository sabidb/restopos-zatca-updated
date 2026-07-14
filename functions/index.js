import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import crypto from "crypto";
import bcrypt from "bcryptjs";

// Secrets (Google Secret Manager). Set with:
//   firebase functions:secrets:set QZ_PRIVATE_KEY
//   firebase functions:secrets:set AI_API_KEY   # optional; else config/ai is used
const QZ_PRIVATE_KEY = defineSecret("QZ_PRIVATE_KEY");
const AI_API_KEY = defineSecret("AI_API_KEY");

initializeApp();
const db = getFirestore();

// Legacy hash (fast SHA-256 with a single global salt). Kept ONLY so existing
// accounts created before the bcrypt migration can still log in — on a
// successful legacy login we transparently upgrade the stored hash to bcrypt.
const legacySha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const legacyHash = (password) => legacySha256(password + "restopos_salt_v1");

const isBcrypt = (h) => typeof h === "string" && /^\$2[aby]\$/.test(h);
const BCRYPT_ROUNDS = 12;

// The single owner account allowed to set credentials on any license (used by
// the admin panel). Everyone else must own the license via authUids.
const ADMIN_EMAIL = "8742sabithsaleem@gmail.com";

// Verify a password against a stored hash, supporting both bcrypt and the
// legacy scheme. Returns { ok, needsUpgrade }.
async function verifyPassword(password, storedHash) {
  if (isBcrypt(storedHash)) {
    return { ok: await bcrypt.compare(password, storedHash), needsUpgrade: false };
  }
  // Legacy sha256 comparison — constant-time.
  const a = Buffer.from(legacyHash(password));
  const b = Buffer.from(String(storedHash || ""));
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { ok, needsUpgrade: ok };
}

export const verifyLogin = onCall({ cors: true, region: "us-central1" }, async (req) => {
  const { licenseKey, username, password } = req.data || {};
  if (!licenseKey || !username || !password) {
    throw new HttpsError("invalid-argument", "Missing credentials.");
  }
  const key = String(licenseKey).trim().toUpperCase();
  const enteredUser = String(username).trim().toLowerCase();

  const ref = db.collection("pending_activations").doc(key);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("unauthenticated", "Invalid license key or password.");
  const data = snap.data();

  if (!data.clientUsername || !data.passwordHash) {
    throw new HttpsError("unauthenticated", "This account has no login credentials set yet.");
  }
  if (enteredUser !== data.clientUsername) {
    throw new HttpsError("unauthenticated", "Invalid license key or password.");
  }

  const { ok, needsUpgrade } = await verifyPassword(password, data.passwordHash);
  if (!ok) {
    throw new HttpsError("unauthenticated", "Invalid license key or password.");
  }
  if (!data.credentialsApproved) {
    throw new HttpsError("permission-denied", "Account pending admin approval.");
  }
  if (data.isActive === false) {
    throw new HttpsError("permission-denied", "This account has been deactivated.");
  }

  // Transparently migrate a legacy sha256 hash to bcrypt on successful login.
  if (needsUpgrade) {
    try {
      await ref.update({ passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS), passwordHashUpgradedAt: new Date().toISOString() });
    } catch (e) { /* non-fatal: login still succeeds */ }
  }

  const token = await getAuth().createCustomToken(key, { licenseKey: key, username: enteredUser });
  // NOTE: passwordHash and clientUsername are deliberately NOT returned — the
  // client must never receive credential-derived secrets.
  return {
    token,
    businessName: data.businessName || "",
    crNumber: data.crNumber || "",
    vatNumber: data.vatNumber || "",
    email: data.email || "",
    city: data.city || "",
    address: data.address || "",
    phone: data.phone || "",
    credentialsApproved: data.credentialsApproved || false
  };
});

// Sets or updates a client's login credentials for a license, hashing the
// password server-side with bcrypt. The browser never computes or writes the
// password hash directly. Authorization:
//   - the caller's UID must be on the license's authUids allowlist (the device
//     that activated the license), OR
//   - the caller is the admin account (used by the admin panel).
export const setClientCredentials = onCall({ cors: true, region: "us-central1" }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign-in required.");
  const { licenseKey, username, password } = req.data || {};
  if (!licenseKey || !username || !password) {
    throw new HttpsError("invalid-argument", "licenseKey, username and password are required.");
  }
  if (String(password).length < 6) {
    throw new HttpsError("invalid-argument", "Password must be at least 6 characters.");
  }
  const key = String(licenseKey).trim().toUpperCase();
  const cleanUser = String(username).trim().toLowerCase();
  if (cleanUser.length < 3) throw new HttpsError("invalid-argument", "Username must be at least 3 characters.");

  const ref = db.collection("pending_activations").doc(key);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "License not found.");
  const data = snap.data() || {};

  const isAdmin = req.auth.token?.email === ADMIN_EMAIL && req.auth.token?.email_verified;
  const authUids = Array.isArray(data.authUids) ? data.authUids : [];
  const ownsDevice = authUids.includes(req.auth.uid);
  if (!isAdmin && !ownsDevice) {
    throw new HttpsError("permission-denied", "Not authorized to set credentials for this license.");
  }

  await ref.update({
    clientUsername: cleanUser,
    passwordHash: await bcrypt.hash(String(password), BCRYPT_ROUNDS),
    email: data.email || "",
    credentialsSet: true,
    // Self-service credential changes reset approval; admin changes keep it.
    credentialsApproved: isAdmin ? (data.credentialsApproved || false) : false,
    credentialsSetAt: new Date().toISOString()
  });

  return { success: true, credentialsApproved: isAdmin ? (data.credentialsApproved || false) : false };
});

// AI support assistant proxy. The Anthropic API key stays server-side (read from
// the AI_API_KEY env var, falling back to the config/ai Firestore doc). The
// browser never receives the key. Requires the caller to be signed in.
const AI_SYSTEM_PROMPT = "You are RestoPOS Assistant — a helpful support bot for the RestoPOS restaurant management system used in Saudi Arabia. You help restaurant staff with: POS billing, ZATCA QR codes and compliance (Phase 1 & 2), UBL 2.1 XML invoices, FATOORA reporting queue, ICV sequential counters, SHA-256 hash chains, reports, menu management, settings, user roles, barcode scanning, payment methods (Cash, Card, Cash+Card split), VAT calculations (15%), and general app usage. Keep answers short, clear and practical.";

export const aiChat = onCall({ cors: true, region: "us-central1", secrets: [AI_API_KEY] }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign-in required.");
  const messages = Array.isArray(req.data?.messages) ? req.data.messages : null;
  if (!messages || !messages.length) throw new HttpsError("invalid-argument", "messages array is required.");

  // Sanitise: only role/content strings, cap history and length.
  const clean = messages.slice(-20).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content || "").slice(0, 4000),
  }));

  // Prefer the AI_API_KEY secret; fall back to the config/ai Firestore doc.
  let apiKey = AI_API_KEY.value() || "";
  if (!apiKey) {
    try {
      const cfg = await db.collection("config").doc("ai").get();
      if (cfg.exists) apiKey = cfg.data().apiKey || "";
    } catch (e) { /* fall through */ }
  }
  if (!apiKey) throw new HttpsError("failed-precondition", "AI is not configured. Ask support to enable the assistant.");

  let resp;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, system: AI_SYSTEM_PROMPT, messages: clean }),
    });
  } catch (e) {
    throw new HttpsError("unavailable", "Could not reach the AI service.");
  }
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new HttpsError("internal", err?.error?.message || `AI service error ${resp.status}`);
  }
  const data = await resp.json();
  return { text: data?.content?.[0]?.text || "Sorry, I couldn't process that." };
});

// Signs a QZ Tray connection challenge with the RestoPOS private key (held in
// the QZ_PRIVATE_KEY env var, PEM with real newlines). The key never reaches the
// browser. Returns a base64 RSA-SHA512 signature, which is what QZ Tray expects.
export const qzSign = onCall({ cors: true, region: "us-central1", secrets: [QZ_PRIVATE_KEY] }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign-in required.");
  const toSign = String(req.data?.toSign ?? "");
  const pem = QZ_PRIVATE_KEY.value();
  if (!pem) throw new HttpsError("failed-precondition", "QZ signing key is not configured.");
  try {
    const signer = crypto.createSign("RSA-SHA512");
    signer.update(toSign);
    return { signature: signer.sign(pem.replace(/\\n/g, "\n"), "base64") };
  } catch (e) {
    throw new HttpsError("internal", "QZ signing failed.");
  }
});
