import { onCall, HttpsError } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import crypto from "crypto";
import bcrypt from "bcryptjs";

initializeApp();
const db = getFirestore();

// Server-side secrets live in a locked Firestore doc (config/secrets), read here
// with the Admin SDK. Firestore rules deny all client access to the `config`
// collection, so these never reach the browser — same protection as Secret
// Manager, but the functions deploy with no pre-provisioning and the owner can
// set/rotate values by editing one doc in the Firebase console. Fields:
//   qzPrivateKey       — QZ Tray RSA private key (PEM)
//   emailjsPrivateKey  — EmailJS private key (server-side reset email)
//   aiApiKey           — Anthropic API key (falls back to config/ai.apiKey)
async function getSecret(field) {
  try {
    const snap = await db.collection("config").doc("secrets").get();
    if (snap.exists && snap.data()[field]) return String(snap.data()[field]);
  } catch (e) { /* fall through */ }
  return "";
}

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

  // Server-side brute-force protection: lock the account after too many failed
  // logins. The transaction COMMITS the counter and returns a verdict — it never
  // throws (throwing inside runTransaction would roll back the very increment
  // that records the failed attempt). Password verification (bcrypt) runs inside
  // so the counter and the check are atomic.
  const MAX_ATTEMPTS = 8;
  const LOCK_MS = 15 * 60 * 1000;
  const verdict = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { status: "invalid" };
    const data = snap.data();
    if (!data.clientUsername || !data.passwordHash) return { status: "no-creds" };

    const now = Date.now();
    if ((data.loginLockUntil || 0) > now) {
      return { status: "locked", mins: Math.ceil((data.loginLockUntil - now) / 60000) };
    }

    const userMatch = enteredUser === data.clientUsername;
    const pw = userMatch ? await verifyPassword(password, data.passwordHash) : { ok: false, needsUpgrade: false };
    if (!userMatch || !pw.ok) {
      const fails = (data.loginFailCount || 0) + 1;
      tx.update(ref, fails >= MAX_ATTEMPTS
        ? { loginFailCount: 0, loginLockUntil: now + LOCK_MS }
        : { loginFailCount: fails });
      return { status: "invalid" };
    }

    // Correct credentials — clear counters and upgrade a legacy hash to bcrypt.
    const update = {};
    if (data.loginFailCount || data.loginLockUntil) { update.loginFailCount = 0; update.loginLockUntil = 0; }
    if (pw.needsUpgrade) { update.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS); update.passwordHashUpgradedAt = new Date().toISOString(); }
    if (Object.keys(update).length) tx.update(ref, update);
    return { status: "ok", data };
  });

  if (verdict.status === "locked") {
    throw new HttpsError("resource-exhausted", `Too many failed attempts. Try again in ${verdict.mins} minute${verdict.mins > 1 ? "s" : ""}.`);
  }
  if (verdict.status === "no-creds") {
    throw new HttpsError("unauthenticated", "This account has no login credentials set yet.");
  }
  if (verdict.status !== "ok") {
    throw new HttpsError("unauthenticated", "Invalid license key or password.");
  }
  const data = verdict.data;

  // Approval / active checks happen only after a correct password (they are not
  // brute-force failures, so they must not affect the lockout counter).
  if (!data.credentialsApproved) {
    throw new HttpsError("permission-denied", "Account pending admin approval.");
  }
  if (data.isActive === false) {
    throw new HttpsError("permission-denied", "This account has been deactivated.");
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
    businessType: data.businessType || "restaurant",
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
// config/secrets.aiApiKey, falling back to the config/ai doc). The browser never
// receives the key. Requires the caller to be signed in.
const AI_SYSTEM_PROMPT = "You are RestoPOS Assistant — a helpful support bot for the RestoPOS restaurant management system used in Saudi Arabia. You help restaurant staff with: POS billing, ZATCA QR codes and compliance (Phase 1 & 2), UBL 2.1 XML invoices, FATOORA reporting queue, ICV sequential counters, SHA-256 hash chains, reports, menu management, settings, user roles, barcode scanning, payment methods (Cash, Card, Cash+Card split), VAT calculations (15%), and general app usage. Keep answers short, clear and practical.";

export const aiChat = onCall({ cors: true, region: "us-central1" }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign-in required.");
  const messages = Array.isArray(req.data?.messages) ? req.data.messages : null;
  if (!messages || !messages.length) throw new HttpsError("invalid-argument", "messages array is required.");

  // Sanitise: only role/content strings, cap history and length.
  const clean = messages.slice(-20).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content || "").slice(0, 4000),
  }));

  // config/secrets.aiApiKey, falling back to the legacy config/ai.apiKey doc.
  let apiKey = await getSecret("aiApiKey");
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
// config/secrets.qzPrivateKey, PEM). The key never reaches the browser.
// Returns a base64 RSA-SHA512 signature, which is what QZ Tray expects.
export const qzSign = onCall({ cors: true, region: "us-central1" }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign-in required.");
  const toSign = String(req.data?.toSign ?? "");
  const pem = await getSecret("qzPrivateKey");
  if (!pem) throw new HttpsError("failed-precondition", "QZ signing key is not configured.");
  try {
    const signer = crypto.createSign("RSA-SHA512");
    signer.update(toSign);
    return { signature: signer.sign(pem.replace(/\\n/g, "\n"), "base64") };
  } catch (e) {
    throw new HttpsError("internal", "QZ signing failed.");
  }
});

// ── Password reset via server-verified OTP ─────────────────────────────────
// The OTP is generated, stored (hashed) and verified server-side, and the email
// is sent from the function — so the code can't be read or skipped in the
// browser (the old flow generated + compared the code client-side).
const EMAILJS_SERVICE = "service_mxln2w4";
const EMAILJS_RESET_TEMPLATE = "template_444v50v";
const EMAILJS_PUBLIC_KEY = "jlfUG0WjJ3UVXUgCb";

// Step 1: request a reset code. Always returns ok (no account enumeration).
export const requestPasswordReset = onCall({ cors: true, region: "us-central1" }, async (req) => {
  const email = String(req.data?.email || "").trim().toLowerCase();
  if (!email) throw new HttpsError("invalid-argument", "Email is required.");
  try {
    const idx = await db.collection("email_index").doc(email).get();
    if (!idx.exists) return { ok: true };
    const licenseKey = idx.data().licenseKey;
    const acct = await db.collection("pending_activations").doc(licenseKey).get();
    if (!acct.exists) return { ok: true };
    const name = acct.data().ownerName || acct.data().businessName || "User";

    const code = String(Math.floor(100000 + Math.random() * 900000));
    await db.collection("password_resets").doc(licenseKey).set({
      email,
      codeHash: await bcrypt.hash(code, 10),
      expiresAt: Date.now() + 10 * 60 * 1000,
      attempts: 0,
      createdAt: new Date().toISOString(),
    });

    const emailResp = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_id: EMAILJS_SERVICE,
        template_id: EMAILJS_RESET_TEMPLATE,
        user_id: EMAILJS_PUBLIC_KEY,
        accessToken: await getSecret("emailjsPrivateKey"),
        template_params: { to_email: email, to_name: name, code },
      }),
    });
    if (!emailResp.ok) {
      console.error("EmailJS send failed:", emailResp.status, await emailResp.text().catch(() => ""));
    }
  } catch (e) {
    // Never surface internal errors to the caller (avoids enumeration/leaks).
    console.error("requestPasswordReset error:", e.message);
  }
  return { ok: true };
});

// Step 2: verify the code and set a new password. Proof of email ownership via
// the OTP replaces the device-trust requirement, so this works from any device.
export const resetPasswordWithOtp = onCall({ cors: true, region: "us-central1" }, async (req) => {
  const email = String(req.data?.email || "").trim().toLowerCase();
  const code = String(req.data?.code || "").trim();
  const newPassword = String(req.data?.newPassword || "");
  if (!email || !code || !newPassword) throw new HttpsError("invalid-argument", "email, code and newPassword are required.");
  if (newPassword.length < 6) throw new HttpsError("invalid-argument", "Password must be at least 6 characters.");

  const idx = await db.collection("email_index").doc(email).get();
  if (!idx.exists) throw new HttpsError("unauthenticated", "Invalid or expired code.");
  const licenseKey = idx.data().licenseKey;
  const resetRef = db.collection("password_resets").doc(licenseKey);

  const verdict = await db.runTransaction(async (tx) => {
    const snap = await tx.get(resetRef);
    if (!snap.exists) return { status: "invalid" };
    const d = snap.data();
    if (Date.now() > d.expiresAt) { tx.delete(resetRef); return { status: "expired" }; }
    if ((d.attempts || 0) >= 5) { tx.delete(resetRef); return { status: "toomany" }; }
    if (!(await bcrypt.compare(code, d.codeHash))) {
      tx.update(resetRef, { attempts: (d.attempts || 0) + 1 });
      return { status: "invalid" };
    }
    tx.delete(resetRef);
    return { status: "ok" };
  });

  if (verdict.status === "expired") throw new HttpsError("deadline-exceeded", "Code expired. Please request a new one.");
  if (verdict.status === "toomany") throw new HttpsError("resource-exhausted", "Too many attempts. Please request a new code.");
  if (verdict.status !== "ok") throw new HttpsError("unauthenticated", "Invalid or expired code.");

  await db.collection("pending_activations").doc(licenseKey).update({
    passwordHash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS),
    passwordResetAt: new Date().toISOString(),
    loginFailCount: 0,
    loginLockUntil: 0,
  });
  return { ok: true };
});
