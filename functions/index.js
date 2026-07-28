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

// Brute-force throttling is per CALLER, not per account.
//
// Locking the account itself turned the protection into a weapon: anyone who
// knew a licence key (they follow a guessable RESTO+7 format and are not
// treated as secrets) could send eight wrong passwords and take a real shop
// offline for fifteen minutes, repeatedly, without ever knowing a credential.
// A till that cannot open is a worse outcome than a slow brute force.
//
// So the hard lock now applies to the caller's IP against one account, and the
// account itself is never locked — a legitimate client at the counter can
// always keep trying. Brute force is held off by three things instead: bcrypt
// at cost 12 (~0.25s per guess), the per-IP lock, and a delay that grows with
// consecutive account-wide failures and is capped low enough to be invisible
// to someone simply mistyping.
const MAX_IP_ATTEMPTS = 8;
const IP_LOCK_MS = 15 * 60 * 1000;
const THROTTLE_TTL_MS = 60 * 60 * 1000;
const MAX_ACCOUNT_DELAY_MS = 2000;

const ipHash = (ip) => crypto.createHash("sha256").update(String(ip || "unknown")).digest("hex").slice(0, 32);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function callerIp(req) {
  const raw = req.rawRequest;
  const fwd = raw?.headers?.["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  return raw?.ip || "unknown";
}

// ── Device approval, decided here and nowhere else ────────────────────────
//
// This gate used to live entirely in the browser: the client read
// approvedDevices, decided for itself whether it was on the list, and could
// write itself onto it — Firestore rules never protected that field. A gate
// enforced only by the code an attacker controls is not a gate. Stolen
// credentials walked straight through it.
//
// It is now settled server-side, on the Admin SDK, as part of verifying the
// password, and approvedDevices is admin-only in the rules.
//
// The FIRST device is approved automatically. Requiring an approval before
// anyone can use the account they just paid for meant a client registering at
// two in the morning could not open their till until the owner woke up — for
// no security benefit, because a licence with no approved devices has nothing
// to protect yet. Every device after that waits.
const devId = (d) => (typeof d === "string" ? d : d && d.id);

async function settleDevice(ref, data, key, deviceId, deviceLabel) {
  const approved = Array.isArray(data.approvedDevices) ? data.approvedDevices : [];
  if (!deviceId) return { status: "approved" }; // older client build; don't lock it out
  if (approved.some((d) => devId(d) === deviceId)) return { status: "approved" };

  const now = new Date().toISOString();
  if (approved.length === 0) {
    await ref.update({
      approvedDevices: [{ id: deviceId, label: deviceLabel || "First device", approvedAt: now, firstDevice: true }],
      lastDeviceApprovedAt: now,
    });
    return { status: "approved", first: true };
  }

  const pending = Array.isArray(data.pendingDevices) ? data.pendingDevices : [];
  if (!pending.some((d) => devId(d) === deviceId)) {
    await ref.update({
      pendingDevices: [...pending, { id: deviceId, label: deviceLabel || "Unknown device", requestedAt: now }],
      lastDeviceRequestAt: now,
    });
    // A durable line in the admin panel's Activity tab, so a request is still
    // visible after the badge has been cleared or missed.
    await db.collection("activity_log").add({
      action: "DEVICE_LOGIN_REQUEST",
      user: data.businessName || key,
      details: `New device "${deviceLabel || "Unknown device"}" tried to sign in to ${key} and is waiting for approval.`,
      licenseKey: key,
      deviceId,
      timestamp: now,
    }).catch(() => {});
  }
  return { status: "pending" };
}

export const verifyLogin = onCall({ cors: true, region: "us-central1" }, async (req) => {
  const { licenseKey, username, password, deviceId, deviceLabel } = req.data || {};
  if (!licenseKey || !username || !password) {
    throw new HttpsError("invalid-argument", "Missing credentials.");
  }
  const key = String(licenseKey).trim().toUpperCase();
  const enteredUser = String(username).trim().toLowerCase();

  const ref = db.collection("pending_activations").doc(key);
  const throttleRef = db.collection("login_throttle").doc(`${key}__${ipHash(callerIp(req))}`);

  // Per-IP gate, checked before anything else so a locked-out attacker never
  // reaches the (deliberately expensive) bcrypt comparison.
  const throttleSnap = await throttleRef.get();
  const throttle = throttleSnap.exists ? throttleSnap.data() : {};
  const nowMs = Date.now();
  if ((throttle.lockUntil || 0) > nowMs) {
    const mins = Math.ceil((throttle.lockUntil - nowMs) / 60000);
    throw new HttpsError("resource-exhausted",
      `Too many failed attempts from this device. Try again in ${mins} minute${mins > 1 ? "s" : ""}.`);
  }

  // A slow answer for an account that has been failing, so repeated guessing
  // costs real time. Capped at 2s: a client who mistyped once waits ~0.25s.
  const priorFails = Math.max(0, Number(throttle.fails) || 0);
  if (priorFails > 0) await sleep(Math.min(250 * priorFails, MAX_ACCOUNT_DELAY_MS));

  // The transaction COMMITS the counter and returns a verdict — it never throws
  // (throwing inside runTransaction would roll back the very increment that
  // records the failed attempt). Password verification (bcrypt) runs inside so
  // the counter and the check are atomic.
  const verdict = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { status: "invalid" };
    const data = snap.data();
    if (!data.clientUsername || !data.passwordHash) return { status: "no-creds" };

    const userMatch = enteredUser === data.clientUsername;
    const pw = userMatch ? await verifyPassword(password, data.passwordHash) : { ok: false, needsUpgrade: false };
    if (!userMatch || !pw.ok) {
      // loginFailCount is kept purely so the admin panel can show that an
      // account is being probed. It no longer gates anything.
      tx.update(ref, { loginFailCount: (data.loginFailCount || 0) + 1, lastFailedLoginAt: new Date().toISOString() });
      return { status: "invalid" };
    }

    // Correct credentials — clear counters and upgrade a legacy hash to bcrypt.
    const update = {};
    if (data.loginFailCount || data.loginLockUntil) { update.loginFailCount = 0; update.loginLockUntil = 0; }
    if (pw.needsUpgrade) { update.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS); update.passwordHashUpgradedAt = new Date().toISOString(); }
    if (Object.keys(update).length) tx.update(ref, update);
    return { status: "ok", data };
  });

  if (verdict.status === "ok") {
    if (throttleSnap.exists) await throttleRef.delete().catch(() => {});
  } else if (verdict.status === "invalid") {
    const fails = priorFails + 1;
    await throttleRef.set({
      licenseKey: key,
      fails: fails >= MAX_IP_ATTEMPTS ? 0 : fails,
      lockUntil: fails >= MAX_IP_ATTEMPTS ? nowMs + IP_LOCK_MS : 0,
      // So a cleanup job (or a TTL policy on this field) can reap stale rows.
      expiresAt: nowMs + THROTTLE_TTL_MS,
      updatedAt: new Date().toISOString(),
    }, { merge: true }).catch(() => {});
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

  // Password is right and the account is live. Now: is this device allowed?
  // An unapproved device gets NO token — issuing one and relying on the browser
  // to show a waiting screen would hand it real read access to the account.
  const device = await settleDevice(ref, data, key, String(deviceId || "").slice(0, 100), String(deviceLabel || "").slice(0, 60));
  if (device.status === "pending") {
    return { deviceStatus: "pending", businessName: data.businessName || "" };
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
    credentialsApproved: data.credentialsApproved || false,
    deviceStatus: "approved",
    firstDevice: !!device.first,
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

// ═══════════════════════════════════════════════════════════════════
// ZATCA INVOICE ARCHIVE
//
// zatca_invoices is one collection shared by every client, and the till used
// to read and write it directly. Firestore rules cannot inspect a query — they
// see "someone wants invoices", not which ones — so the collection had to be
// readable by any signed-in caller, and the app signs devices in anonymously.
// In practice that meant anyone who opened the site could read every shop's
// invoices: totals, VAT, buyer names, the lot.
//
// These three functions are the only way in now, and the collection is closed
// in the rules. The seller VAT they scope every query to is read from the
// CALLER'S OWN ACCOUNT DOCUMENT, never from the request — a client that could
// name its own VAT number could still read anyone it liked, which would leave
// the hole exactly where it was.
//
// Writes go through here too. A client that could write directly could create
// invoices under another shop's number, and blocking reads while allowing
// writes would leave that open.
// ═══════════════════════════════════════════════════════════════════

const ZATCA_MAX_PAGE = 500;

// One tenant's invoice number, made unique across the shared collection.
// "/" is the one character a Firestore document id may not contain.
const archiveDocId = (sellerVat, invoiceNumber) =>
  `${String(sellerVat).replace(/\//g, "_")}__${String(invoiceNumber).replace(/\//g, "_")}`.slice(0, 1400);

/**
 * Establish that the caller owns this licence, and return the account. Two
 * kinds of caller are legitimate: a logged-in client, whose custom token has
 * uid == the licence key, and a device on the licence's authUids allowlist
 * (the till before anyone has logged in, restoring its own chain).
 */
async function requireLicense(req, licenseKey) {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign-in required.");
  const key = String(licenseKey || "").trim().toUpperCase();
  if (!key) throw new HttpsError("invalid-argument", "licenseKey is required.");
  const snap = await db.collection("pending_activations").doc(key).get();
  if (!snap.exists) throw new HttpsError("not-found", "Account not found.");
  const data = snap.data() || {};
  const owns = req.auth.uid === key || (Array.isArray(data.authUids) && data.authUids.includes(req.auth.uid));
  if (!owns) throw new HttpsError("permission-denied", "Not authorized for this license.");
  return { key, data };
}

// The tenant's VAT, taken from the account rather than the caller's word for it.
function sellerVatOf(data) {
  const vat = String(data.vatNumber || "").trim();
  if (!vat) throw new HttpsError("failed-precondition", "This account has no VAT number, so its invoice archive cannot be scoped.");
  return vat;
}

/** Archive one invoice. Upserts by invoice number so later clearance updates merge. */
export const zatcaArchive = onCall({ cors: true, region: "us-central1" }, async (req) => {
  const { licenseKey, invoice, extra } = req.data || {};
  const { data } = await requireLicense(req, licenseKey);
  const sellerVat = sellerVatOf(data);
  if (!invoice || !invoice.invoice_number) throw new HttpsError("invalid-argument", "invoice.invoice_number is required.");
  // An invoice may only be filed under the VAT of the account filing it.
  if (String(invoice.seller_vat || "").trim() !== sellerVat) {
    throw new HttpsError("permission-denied", "This invoice's seller VAT does not belong to this account.");
  }
  // The document id is scoped to the tenant, and must be.
  //
  // Invoice numbers come from a per-shop counter that starts at 1000, so EVERY
  // client generates INV-1001, INV-1002 and so on. Keyed on the invoice number
  // alone — as this collection was — the second shop to reach INV-1001 silently
  // overwrote the first shop's invoice in the permanent five-year archive. Not
  // a collision that might happen: one that happens to every pair of clients.
  //
  // Queries here filter on seller_vat and order by icv or timestamp, none of
  // which touch the document id, so older documents keyed the old way are still
  // returned normally. Only the upsert key changes.
  await db.collection("zatca_invoices").doc(archiveDocId(sellerVat, invoice.invoice_number)).set({
    ...invoice, ...(extra && typeof extra === "object" ? extra : {}),
    seller_vat: sellerVat,
    archived_at: new Date().toISOString(),
  }, { merge: true });
  return { ok: true };
});

/**
 * File many invoices in one call.
 *
 * Two jobs. It drains a till's offline backlog quickly instead of one round
 * trip per invoice, and it is what a reconciliation uses: before document ids
 * were scoped to the tenant, two shops reaching the same invoice number
 * overwrote each other, and the losing shop's only surviving copy is the one
 * in its own browser. Re-filing that cache puts it back under the shop's own
 * key without disturbing the other's.
 *
 * Every invoice is checked against the caller's VAT individually — a batch is
 * not an excuse to skip the check that makes any of this safe.
 */
export const zatcaArchiveBatch = onCall({ cors: true, region: "us-central1" }, async (req) => {
  const { licenseKey, invoices } = req.data || {};
  const { data } = await requireLicense(req, licenseKey);
  const sellerVat = sellerVatOf(data);
  if (!Array.isArray(invoices) || !invoices.length) {
    throw new HttpsError("invalid-argument", "invoices must be a non-empty array.");
  }
  if (invoices.length > 200) throw new HttpsError("invalid-argument", "At most 200 invoices per call.");

  const batch = db.batch();
  let written = 0;
  const rejected = [];
  for (const inv of invoices) {
    if (!inv || !inv.invoice_number) { rejected.push({ reason: "no invoice_number" }); continue; }
    if (String(inv.seller_vat || "").trim() !== sellerVat) {
      rejected.push({ invoice_number: inv.invoice_number, reason: "seller VAT does not belong to this account" });
      continue;
    }
    batch.set(db.collection("zatca_invoices").doc(archiveDocId(sellerVat, inv.invoice_number)), {
      ...inv, seller_vat: sellerVat, archived_at: new Date().toISOString(),
    }, { merge: true });
    written += 1;
  }
  if (written) await batch.commit();
  return { written, rejected };
});

/**
 * The head of this tenant's hash chain, plus the most recent invoices to
 * repopulate the till's local cache. This is what lets a wiped or replaced
 * device pick the ICV sequence back up instead of restarting it — which would
 * break the chain ZATCA audits.
 */
export const zatcaChain = onCall({ cors: true, region: "us-central1" }, async (req) => {
  const { licenseKey, limit } = req.data || {};
  const { data } = await requireLicense(req, licenseKey);
  const sellerVat = sellerVatOf(data);
  const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), ZATCA_MAX_PAGE);
  const snap = await db.collection("zatca_invoices")
    .where("seller_vat", "==", sellerVat).orderBy("icv", "desc").limit(n).get();
  const recent = snap.docs.map((d) => d.data());
  const latest = recent[0] || null;
  return {
    latestIcv: latest ? (latest.icv || 0) : 0,
    latestHash: latest ? (latest.invoice_hash || "") : "",
    recent,
  };
});

/**
 * A page of this tenant's archive for the export screen. Ordered by timestamp
 * then invoice number so the cursor is unambiguous — ordering on timestamp
 * alone would skip invoices that share a second, which for a busy till is not
 * a hypothetical.
 */
export const zatcaExport = onCall({ cors: true, region: "us-central1" }, async (req) => {
  const { licenseKey, from, to, cursor, pageSize, countOnly } = req.data || {};
  const { data } = await requireLicense(req, licenseKey);
  const sellerVat = sellerVatOf(data);
  if (!from || !to) throw new HttpsError("invalid-argument", "from and to are required (YYYY-MM-DD).");
  const fromTs = new Date(from + "T00:00:00.000Z").toISOString();
  const toTs = new Date(to + "T23:59:59.999Z").toISOString();

  let q = db.collection("zatca_invoices")
    .where("seller_vat", "==", sellerVat)
    .where("timestamp", ">=", fromTs).where("timestamp", "<=", toTs)
    .orderBy("timestamp", "asc").orderBy("invoice_number", "asc");

  if (countOnly) {
    const agg = await q.count().get();
    return { count: agg.data().count };
  }
  if (cursor && cursor.timestamp) q = q.startAfter(cursor.timestamp, cursor.invoiceNumber || "");
  const n = Math.min(Math.max(parseInt(pageSize, 10) || 200, 1), ZATCA_MAX_PAGE);
  const snap = await q.limit(n).get();
  const invoices = snap.docs.map((d) => d.data());
  const last = invoices[invoices.length - 1];
  return {
    invoices,
    nextCursor: invoices.length === n && last
      ? { timestamp: last.timestamp, invoiceNumber: last.invoice_number }
      : null,
  };
});
