// ═══════════════════════════════════════════════════════════════════
// DURABLE SALES ARCHIVE — years of history, in the cloud, per client
//
// WHY THIS EXISTS
//
// Everything a client owned was backed up into a single Firestore document,
// client_data/{licenseKey}, with each localStorage key stored as one long
// JSON string field. A Firestore document is capped at 1 MiB. Two consequences
// followed, and both were silent:
//
//   1. restopos_archived_sales was on that document's sync list, capped at
//      50,000 records. At a few hundred bytes each that is tens of megabytes
//      aimed at a 1 MiB limit. Once the document crossed the cap EVERY write
//      to it failed — menu, settings, customers, all of it — and the only
//      trace was a console warning, because the sync helper swallows errors.
//      A client could be running for months with no working backup at all.
//
//   2. Only the most recent 200 invoices were ever uploaded. The monthly
//      archives existed on the device and were uploaded for trials only, so a
//      paid client's older sales lived on exactly one machine. A lost or wiped
//      device took the history with it, and signing in on a new device
//      restored the last 200 invoices — under a day's trading for a busy shop.
//
// THE SHAPE
//
//   client_data/{licenseKey}
//     ├── (parent doc)                  settings, menu, recent working set
//     ├── sales_days/{YYYY-MM-DD}       one document per business day
//     │      └── …__p2, __p3            overflow parts for very busy days
//     └── sales_index/index             date → {n, total, vat, parts}
//
// A day is the right grain. Per-invoice documents would mean a read per
// invoice — hundreds of thousands of reads to rebuild a device. A month would
// put a busy shop back over the 1 MiB limit. A day of 300 invoices encodes to
// roughly 100 KB, which leaves an order of magnitude of headroom, and five
// years is about 1,825 documents per client.
//
// The index doc means the app can show what history exists, and how big it is,
// without reading any of it.
//
// RETENTION: nothing here deletes anything. Firestore has no TTL unless one is
// configured, so history persists until someone removes it deliberately. Five
// years is a floor, not a ceiling.
//
// Everything is best-effort: a failed archive write must never break the till.
// ═══════════════════════════════════════════════════════════════════

const DEBOUNCE_MS = 8000;
// Firestore's hard limit is 1 MiB per document. Stay well under it — the
// encoded payload is not the only thing in the document, and a write that
// fails because it is two bytes over loses a day of trading.
const MAX_PART_BYTES = 700000;
const ENCODING_VERSION = 1;

let fb = null;
const timers = {};
const pending = {};
let inFlight = false;

/** Inject the app's Firestore handles — one Firebase app, one auth session. */
export function initCloudArchive(deps) { fb = deps; }

// ── Encoding ───────────────────────────────────────────────────────
//
// Columnar and lossless. A day's invoices share the same keys, so writing the
// key names once and then rows of values costs far less than repeating every
// key on every record — roughly half the bytes, which directly doubles how
// many invoices fit in a day document.
//
// It is deliberately NOT a fixed field list. Sales pick up fields after they
// are created (a ZATCA invoice number, a void or refund status), and a fixed
// list would silently drop whichever ones nobody remembered to add.

// Defensive only: there are no image fields on a sale today, and none should
// ever arrive here. Anything that looks like embedded binary is dropped rather
// than stored — it would blow the size budget and is not wanted in the archive.
const isEmbeddedBinary = (v) => typeof v === "string" && v.length > 512 && /^data:/.test(v);

export function encodeDay(sales) {
  const rows = Array.isArray(sales) ? sales : [];
  const cols = [];
  const seen = new Set();
  for (const s of rows) {
    for (const k of Object.keys(s || {})) {
      if (!seen.has(k)) { seen.add(k); cols.push(k); }
    }
  }
  const data = rows.map((s) => cols.map((c) => {
    const v = s ? s[c] : undefined;
    if (v === undefined) return null;
    return isEmbeddedBinary(v) ? null : v;
  }));
  return { v: ENCODING_VERSION, cols, rows: data };
}

export function decodeDay(payload) {
  if (!payload) return [];
  // Tolerate a plain array, so a document written by any other path still reads.
  if (Array.isArray(payload)) return payload;
  const { cols, rows } = payload;
  if (!Array.isArray(cols) || !Array.isArray(rows)) return [];
  return rows.map((r) => {
    const o = {};
    for (let i = 0; i < cols.length; i++) if (r[i] !== null && r[i] !== undefined) o[cols[i]] = r[i];
    return o;
  });
}

const bytes = (s) => (typeof TextEncoder !== "undefined" ? new TextEncoder().encode(s).length : s.length * 2);

/**
 * Split a day into as many documents as its size demands. Almost always one.
 * Splitting by row count rather than guessing keeps every part under budget
 * even when a few invoices carry unusually large item lists.
 */
function splitIntoParts(sales) {
  const whole = JSON.stringify(encodeDay(sales));
  if (bytes(whole) <= MAX_PART_BYTES) return [{ payload: whole, sales }];
  const mid = Math.max(1, Math.floor(sales.length / 2));
  return [...splitIntoParts(sales.slice(0, mid)), ...splitIntoParts(sales.slice(mid))];
}

const partId = (date, i) => (i === 0 ? date : `${date}__p${i + 1}`);

const summarise = (sales) => {
  let total = 0, vat = 0, n = 0;
  for (const s of sales) {
    if (s && s.status !== "voided" && !s.isDraft) {
      n += 1;
      total += Number(s.total) || 0;
      vat += Number(s.vat) || 0;
    }
  }
  return { n, total: Math.round(total * 100) / 100, vat: Math.round(vat * 100) / 100 };
};

// ── Writing ────────────────────────────────────────────────────────

async function writeDay(licenseKey, date, sales) {
  const { db, doc, collection, setDoc, writeBatch } = fb;
  const parts = splitIntoParts(sales);
  const batch = writeBatch(db);
  parts.forEach((p, i) => {
    const ref = doc(collection(db, "client_data", licenseKey, "sales_days"), partId(date, i));
    const sum = summarise(p.sales);
    batch.set(ref, {
      date,
      part: i + 1,
      parts: parts.length,
      count: p.sales.length,
      invoiceCount: sum.n,
      revenue: sum.total,
      vat: sum.vat,
      encoding: ENCODING_VERSION,
      data: p.payload,
      updatedAt: new Date().toISOString(),
    });
  });
  await batch.commit();

  // The index lets the app list available history without reading any of it.
  const sum = summarise(sales);
  await setDoc(doc(collection(db, "client_data", licenseKey, "sales_index"), "index"), {
    licenseKey,
    days: { [date]: { n: sum.n, total: sum.total, vat: sum.vat, parts: parts.length } },
    updatedAt: new Date().toISOString(),
  }, { merge: true });

  return parts.length;
}

/** Queue a day for upload. Debounced so a lunch rush is one write, not fifty. */
export function archiveSalesDay(licenseKey, date, sales) {
  if (!fb || !licenseKey || !date) return;
  pending[date] = { licenseKey, sales };
  if (timers[date]) clearTimeout(timers[date]);
  timers[date] = setTimeout(async () => {
    delete timers[date];
    const job = pending[date];
    if (!job) return;
    delete pending[date];
    if (inFlight) { archiveSalesDay(job.licenseKey, date, job.sales); return; }
    inFlight = true;
    try {
      const n = await writeDay(job.licenseKey, date, job.sales);
      console.log(`[Archive] ${date}: ${job.sales.length} sale(s) in ${n} document(s).`);
    } catch (e) {
      console.warn("[Archive] failed for", date, "—", e && e.message);
      // Put it back so the next change retries rather than losing the day.
      pending[date] = job;
    } finally { inFlight = false; }
  }, DEBOUNCE_MS);
}

/** Write every pending day now — used when the tab is closing. */
export async function flushArchive() {
  const dates = Object.keys(pending);
  for (const d of dates) {
    const job = pending[d];
    if (!job) continue;
    delete pending[d];
    if (timers[d]) { clearTimeout(timers[d]); delete timers[d]; }
    try { await writeDay(job.licenseKey, d, job.sales); }
    catch (e) { console.warn("[Archive] flush failed for", d, "—", e && e.message); }
  }
}

// ── Reading ────────────────────────────────────────────────────────

/** What history exists, and how large — one read, no invoices fetched. */
export async function loadArchiveIndex(licenseKey) {
  if (!fb || !licenseKey) return {};
  try {
    const { db, doc, collection, getDoc } = fb;
    const snap = await getDoc(doc(collection(db, "client_data", licenseKey, "sales_index"), "index"));
    return snap.exists() ? (snap.data().days || {}) : {};
  } catch (e) {
    console.warn("[Archive] index read failed:", e && e.message);
    return {};
  }
}

/** Every invoice for one day, parts reassembled. */
export async function loadArchivedDay(licenseKey, date) {
  if (!fb || !licenseKey || !date) return [];
  const { db, collection, query, where, getDocs } = fb;
  try {
    const snap = await getDocs(query(collection(db, "client_data", licenseKey, "sales_days"), where("date", "==", date)));
    const out = [];
    snap.docs
      .sort((a, b) => (a.data().part || 1) - (b.data().part || 1))
      .forEach((d) => {
        try { out.push(...decodeDay(JSON.parse(d.data().data || "null"))); }
        catch (e) { console.warn("[Archive] undecodable part", d.id); }
      });
    return out;
  } catch (e) {
    console.warn("[Archive] day read failed:", date, e && e.message);
    return [];
  }
}

/**
 * Every invoice between two dates (inclusive), oldest first. This is what
 * reports over an old period should call — the data does not need to be on the
 * device, and for five years of trading it could not be.
 */
export async function loadArchivedRange(licenseKey, fromDate, toDate) {
  if (!fb || !licenseKey) return [];
  const { db, collection, query, where, orderBy, getDocs } = fb;
  try {
    const snap = await getDocs(query(
      collection(db, "client_data", licenseKey, "sales_days"),
      where("date", ">=", fromDate), where("date", "<=", toDate), orderBy("date", "asc"),
    ));
    const byDay = {};
    snap.docs.forEach((d) => {
      const v = d.data();
      (byDay[v.date] = byDay[v.date] || []).push(v);
    });
    const out = [];
    Object.keys(byDay).sort().forEach((date) => {
      byDay[date].sort((a, b) => (a.part || 1) - (b.part || 1)).forEach((v) => {
        try { out.push(...decodeDay(JSON.parse(v.data || "null"))); } catch (e) {}
      });
    });
    return out;
  } catch (e) {
    console.warn("[Archive] range read failed:", e && e.message);
    return [];
  }
}

// ── Backfilling what is already on the device ──────────────────────

/**
 * Upload history that predates this archive existing.
 *
 * Without this, an existing client upgrading to this version would sit on
 * months of sales that never reach the cloud: days are only queued when a sale
 * changes them, so a shop's back catalogue would upload one day at a time, and
 * only for days that happened to see new activity. Everything before that would
 * still live on exactly one machine — the situation this whole module exists to
 * end.
 *
 * It reads every local source of sales, groups by business day, and queues the
 * days the cloud is missing or has a different count for. Days that already
 * match are skipped, so on a settled device this costs one index read and
 * nothing else.
 *
 * Capped per run, oldest first, so a client with years of local history uploads
 * steadily across sessions instead of firing thousands of writes at one boot.
 */
const BACKFILL_DAYS_PER_RUN = 45;

export async function backfillArchive(licenseKey) {
  if (!fb || !licenseKey) return { queued: 0, remaining: 0 };
  let index = {};
  try { index = await loadArchiveIndex(licenseKey); } catch (e) { return { queued: 0, remaining: 0 }; }

  // Every place a sale can be sitting on this device.
  const sources = [];
  try { sources.push(JSON.parse(localStorage.getItem("restopos_sales") || "[]")); } catch (e) {}
  try { sources.push(JSON.parse(localStorage.getItem("restopos_archived_sales") || "[]")); } catch (e) {}
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("restopos_sales_") && k !== "restopos_sales") {
      try { sources.push(JSON.parse(localStorage.getItem(k) || "[]")); } catch (e) {}
    }
  }

  const byDay = {};
  const seen = new Set();
  for (const list of sources) {
    if (!Array.isArray(list)) continue;
    for (const s of list) {
      if (!s || !s.date || !s.id || seen.has(s.id)) continue;
      seen.add(s.id);
      (byDay[s.date] = byDay[s.date] || []).push(s);
    }
  }

  const missing = Object.keys(byDay).sort().filter((date) => {
    const cloud = index[date];
    return !cloud || cloud.n !== summarise(byDay[date]).n;
  });

  missing.slice(0, BACKFILL_DAYS_PER_RUN).forEach((date) => archiveSalesDay(licenseKey, date, byDay[date]));
  const queued = Math.min(missing.length, BACKFILL_DAYS_PER_RUN);
  if (queued) {
    console.log(`[Archive] backfilling ${queued} day(s) of existing history` +
      (missing.length > queued ? `; ${missing.length - queued} more will follow next session.` : "."));
  }
  return { queued, remaining: Math.max(0, missing.length - queued) };
}

// ── Restoring onto a device ────────────────────────────────────────

// localStorage is a few megabytes. Five years of invoices is hundreds. So a
// new device gets the recent window locally — enough to work offline and to
// answer "what did we take yesterday" instantly — and anything older is read
// from the cloud on demand. Trying to pull it all down would fail on quota
// partway through and leave a mess.
const RESTORE_DAYS = 120;
const RESTORE_BUDGET_BYTES = 3000000;

/**
 * Rebuild the device's monthly sales buckets from the cloud. Returns what it
 * managed to restore and what it deliberately left in the cloud, so the caller
 * can tell the client the truth about where their history is.
 */
export async function restoreArchiveToDevice(licenseKey, { days = RESTORE_DAYS } = {}) {
  if (!fb || !licenseKey) return { days: 0, sales: 0, older: 0, truncated: false };
  const index = await loadArchiveIndex(licenseKey);
  const allDates = Object.keys(index).sort();               // oldest → newest
  if (!allDates.length) return { days: 0, sales: 0, older: 0, truncated: false };

  const wanted = allDates.slice(-days);
  const older = allDates.length - wanted.length;
  const byMonth = {};
  let used = 0, restoredSales = 0, restoredDays = 0, truncated = false;

  // Newest first, so if the budget runs out the client keeps the days they are
  // most likely to look at rather than whatever happened to come first.
  for (const date of [...wanted].reverse()) {
    const sales = await loadArchivedDay(licenseKey, date);
    if (!sales.length) continue;
    const size = bytes(JSON.stringify(sales));
    if (used + size > RESTORE_BUDGET_BYTES) { truncated = true; break; }
    used += size;
    restoredSales += sales.length;
    restoredDays += 1;
    const month = date.slice(0, 7);
    (byMonth[month] = byMonth[month] || []).push(...sales);
  }

  for (const [month, sales] of Object.entries(byMonth)) {
    const key = `restopos_sales_${month}`;
    try {
      const existing = JSON.parse(localStorage.getItem(key) || "[]");
      const ids = new Set(existing.map((s) => s.id));
      const merged = [...existing, ...sales.filter((s) => !ids.has(s.id))];
      merged.sort((a, b) => String(a.createdAt || a.date || "").localeCompare(String(b.createdAt || b.date || "")));
      localStorage.setItem(key, JSON.stringify(merged));
    } catch (e) {
      // Out of quota — stop rather than half-writing more months.
      console.warn("[Archive] restore stopped at", month, "—", e && e.message);
      truncated = true;
      break;
    }
  }

  console.log(`[Archive] restored ${restoredSales} sale(s) across ${restoredDays} day(s);`,
    `${older} older day(s) remain in the cloud.`);
  return { days: restoredDays, sales: restoredSales, older, truncated };
}
