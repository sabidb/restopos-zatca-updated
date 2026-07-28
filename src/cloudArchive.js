// ═══════════════════════════════════════════════════════════════════
// DURABLE SALES ARCHIVE — every bill its own document, kept for years
//
// WHY THIS EXISTS
//
// Everything a client owned was backed up into a single Firestore document,
// client_data/{licenseKey}, with each localStorage key stored as one long JSON
// string field. A Firestore document is capped at 1 MiB. Two consequences
// followed, and both were silent:
//
//   1. restopos_archived_sales was on that document's sync list, capped at
//      50,000 records. At a few hundred bytes each that is tens of megabytes
//      aimed at a 1 MiB limit. Once the document crossed the cap EVERY write
//      to it failed — menu, settings, customers, all of it — and the only
//      trace was a console warning. A client could run for months believing
//      they were backed up and have nothing.
//
//   2. Only the most recent 200 invoices were ever uploaded. A paid client's
//      older sales lived on exactly one machine.
//
// ONE DOCUMENT PER BILL
//
//   client_data/{licenseKey}
//     ├── invoices/{invoiceNo}       one bill, one document
//     └── sales_index/index          date → {n, total, vat}
//
// An earlier version of this bundled each business day into one document with
// its invoices packed into a compact blob. That was wrong in two ways. A single
// bill could not be fetched, inspected or produced on its own — answering "show
// me invoice INV-1042" meant downloading and decoding the whole day — which is
// no way to hold a tax record. And every new sale rewrote the entire day
// document, so by evening each invoice cost a ~90 KB rewrite of a growing blob.
//
// A bill is written once and never touched again. That is cheaper, it matches
// what an invoice actually is, and it means the archive can be queried.
//
// The index survives because summaries should not cost a read per invoice: it
// carries per-day totals, so "what does this client have" and "is this period
// complete" are answered by one small document.
//
// RETENTION: nothing here deletes anything. Firestore has no TTL unless one is
// configured, so history persists until someone removes it deliberately. Five
// years is a floor, not a ceiling.
//
// Everything is best-effort: a failed archive write must never break the till.
// ═══════════════════════════════════════════════════════════════════

const DEBOUNCE_MS = 8000;
const BATCH_LIMIT = 400;          // Firestore caps a batch at 500; leave headroom.
const PAGE_SIZE = 1000;           // read pagination, so a wide range can't spike memory
const FP_KEY = "restopos_archive_fingerprints";

let fb = null;
const timers = {};
const pending = {};
let inFlight = false;

/** Inject the app's Firestore handles — one Firebase app, one auth session. */
export function initCloudArchive(deps) { fb = deps; }

// ── Fingerprints ───────────────────────────────────────────────────
// A bill never changes after it is written, but the till re-queues whole days
// (a void, a refund, a late ZATCA number). Without a record of what has already
// been uploaded, every cycle would rewrite every invoice of that day.
function loadFingerprints() {
  try { return JSON.parse(localStorage.getItem(FP_KEY) || "{}"); } catch (e) { return {}; }
}
function saveFingerprints(fp) {
  try { localStorage.setItem(FP_KEY, JSON.stringify(fp)); } catch (e) {}
}
function fingerprint(obj) {
  const s = JSON.stringify(obj);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h.toString(36);
}

// Firestore document ids may not contain "/" and may not be "." or "..".
// Invoice numbers are shaped INV-1042, but the archive should not be one
// unusual id away from losing a bill.
function docIdFor(id) {
  const clean = String(id == null ? "" : id).replace(/\//g, "_").slice(0, 1400);
  return !clean || clean === "." || clean === ".." ? null : clean;
}

// Defensive only: no sale carries an image today and none should ever reach
// here. Anything that looks like embedded binary is dropped rather than stored.
const stripHeavy = (sale) => {
  const out = {};
  for (const [k, v] of Object.entries(sale || {})) {
    if (typeof v === "string" && v.length > 512 && /^data:/.test(v)) continue;
    if (v !== undefined) out[k] = v;
  }
  return out;
};

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
  const fps = loadFingerprints();
  const scope = fps[licenseKey] || (fps[licenseKey] = {});

  const changed = [];
  for (const sale of sales) {
    const id = docIdFor(sale && sale.id);
    if (!id) continue;
    const body = stripHeavy(sale);
    const fp = fingerprint(body);
    if (scope[id] === fp) continue;
    changed.push({ id, body, fp });
  }

  for (let i = 0; i < changed.length; i += BATCH_LIMIT) {
    const batch = writeBatch(db);
    for (const c of changed.slice(i, i + BATCH_LIMIT)) {
      batch.set(doc(collection(db, "client_data", licenseKey, "invoices"), c.id), {
        ...c.body,
        date,
        archivedAt: new Date().toISOString(),
      }, { merge: true });
    }
    await batch.commit();
    for (const c of changed.slice(i, i + BATCH_LIMIT)) scope[c.id] = c.fp;
    saveFingerprints(fps);
  }

  // The index answers "what history exists" and "is this period complete"
  // without a read per invoice. Always refreshed, even when no bill changed,
  // because a void alters the day's totals without adding a document.
  const sum = summarise(sales);
  await setDoc(doc(collection(db, "client_data", licenseKey, "sales_index"), "index"), {
    licenseKey,
    days: { [date]: { n: sum.n, total: sum.total, vat: sum.vat } },
    updatedAt: new Date().toISOString(),
  }, { merge: true });

  return changed.length;
}

/** Queue a day for upload. Debounced so a lunch rush is one cycle, not fifty. */
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
      if (n) console.log(`[Archive] ${date}: ${n} bill(s) uploaded.`);
    } catch (e) {
      console.warn("[Archive] failed for", date, "—", e && e.message);
      pending[date] = job;   // retry on the next change rather than losing the day
    } finally { inFlight = false; }
  }, DEBOUNCE_MS);
}

/** Write every pending day now — used when the tab is closing. */
export async function flushArchive() {
  for (const d of Object.keys(pending)) {
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

const cleanRow = (d) => { const { archivedAt, ...rest } = d || {}; return rest; };

/**
 * Bills between two dates (inclusive), oldest first. Paginated, so a request
 * for several years cannot pull an unbounded result set into memory at once.
 */
export async function loadArchivedRange(licenseKey, fromDate, toDate) {
  if (!fb || !licenseKey) return [];
  const { db, collection, query, where, orderBy, limit, startAfter, getDocs } = fb;
  const out = [];
  try {
    let cursor = null;
    for (;;) {
      const parts = [
        collection(db, "client_data", licenseKey, "invoices"),
        where("date", ">=", fromDate), where("date", "<=", toDate),
        orderBy("date", "asc"),
        ...(cursor ? [startAfter(cursor)] : []),
        limit(PAGE_SIZE),
      ];
      const snap = await getDocs(query(...parts));
      snap.docs.forEach((d) => out.push(cleanRow(d.data())));
      if (snap.docs.length < PAGE_SIZE) break;
      cursor = snap.docs[snap.docs.length - 1];
    }
  } catch (e) {
    console.warn("[Archive] range read failed:", e && e.message);
  }
  // Days written by the previous day-blob format, so history uploaded before
  // this change is not stranded.
  try { out.push(...await readLegacyRange(licenseKey, fromDate, toDate, new Set(out.map((s) => s.id)))); }
  catch (e) {}
  // Invoice number breaks ties: two bills rung up in the same second would
  // otherwise come back in whatever order the pages happened to arrive, so the
  // same report could list them differently twice running.
  out.sort((a, b) =>
    String(a.createdAt || a.date || "").localeCompare(String(b.createdAt || b.date || ""))
    || String(a.id || "").localeCompare(String(b.id || "")));
  return out;
}

/** Every bill for one day. */
export async function loadArchivedDay(licenseKey, date) {
  return loadArchivedRange(licenseKey, date, date);
}

/** A single bill, by invoice number — the lookup the day-blob format could not do. */
export async function loadArchivedInvoice(licenseKey, invoiceNo) {
  if (!fb || !licenseKey) return null;
  try {
    const { db, doc, collection, getDoc } = fb;
    const id = docIdFor(invoiceNo);
    if (!id) return null;
    const snap = await getDoc(doc(collection(db, "client_data", licenseKey, "invoices"), id));
    return snap.exists() ? cleanRow(snap.data()) : null;
  } catch (e) { return null; }
}

// ── Legacy day-blob compatibility ──────────────────────────────────
// Read-only. Nothing writes this shape any more; it exists so a client who
// uploaded under the previous format still sees their history.
function decodeLegacy(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  const { cols, rows } = payload;
  if (!Array.isArray(cols) || !Array.isArray(rows)) return [];
  return rows.map((r) => {
    const o = {};
    for (let i = 0; i < cols.length; i++) if (r[i] !== null && r[i] !== undefined) o[cols[i]] = r[i];
    return o;
  });
}

async function readLegacyRange(licenseKey, fromDate, toDate, seen) {
  const { db, collection, query, where, orderBy, getDocs } = fb;
  const snap = await getDocs(query(
    collection(db, "client_data", licenseKey, "sales_days"),
    where("date", ">=", fromDate), where("date", "<=", toDate), orderBy("date", "asc"),
  ));
  const out = [];
  snap.docs
    .sort((a, b) => (a.data().part || 1) - (b.data().part || 1))
    .forEach((d) => {
      try {
        for (const s of decodeLegacy(JSON.parse(d.data().data || "null"))) {
          if (s && s.id && !seen.has(s.id)) { seen.add(s.id); out.push(s); }
        }
      } catch (e) {}
    });
  return out;
}

// ── Backfilling what is already on the device ──────────────────────

/**
 * Upload history that predates this archive existing, so an upgrading client
 * does not sit on months of sales that never leave their machine. It compares
 * against the cloud index first, so a device already in step costs one read.
 * Capped per run, oldest first, so years of local history upload steadily
 * across sessions rather than firing thousands of writes at one boot.
 */
const BACKFILL_DAYS_PER_RUN = 45;

export async function backfillArchive(licenseKey) {
  if (!fb || !licenseKey) return { queued: 0, remaining: 0 };
  let index = {};
  try { index = await loadArchiveIndex(licenseKey); } catch (e) { return { queued: 0, remaining: 0 }; }

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
// from the cloud on demand. Pulling it all down would fail on quota partway
// through and leave a mess.
const RESTORE_DAYS = 120;
const RESTORE_BUDGET_BYTES = 3000000;
const bytes = (s) => (typeof TextEncoder !== "undefined" ? new TextEncoder().encode(s).length : s.length * 2);

export async function restoreArchiveToDevice(licenseKey, { days = RESTORE_DAYS } = {}) {
  if (!fb || !licenseKey) return { days: 0, sales: 0, older: 0, truncated: false };
  const index = await loadArchiveIndex(licenseKey);
  const allDates = Object.keys(index).sort();
  if (!allDates.length) return { days: 0, sales: 0, older: 0, truncated: false };

  const wanted = allDates.slice(-days);
  const older = allDates.length - wanted.length;

  // One range query rather than a query per day: the same rows, far fewer
  // round trips on a device that may be on a phone connection.
  const rows = await loadArchivedRange(licenseKey, wanted[0], wanted[wanted.length - 1]);

  const byDate = {};
  for (const s of rows) if (s && s.date) (byDate[s.date] = byDate[s.date] || []).push(s);

  const byMonth = {};
  let used = 0, restoredSales = 0, restoredDays = 0, truncated = false;
  // Newest first, so if the budget runs out the client keeps the days they are
  // most likely to look at rather than whatever happened to come first.
  for (const date of Object.keys(byDate).sort().reverse()) {
    const sales = byDate[date];
    const size = bytes(JSON.stringify(sales));
    if (used + size > RESTORE_BUDGET_BYTES) { truncated = true; break; }
    used += size;
    restoredSales += sales.length;
    restoredDays += 1;
    (byMonth[date.slice(0, 7)] = byMonth[date.slice(0, 7)] || []).push(...sales);
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
      console.warn("[Archive] restore stopped at", month, "—", e && e.message);
      truncated = true;
      break;
    }
  }

  console.log(`[Archive] restored ${restoredSales} bill(s) across ${restoredDays} day(s);`,
    `${older} older day(s) remain in the cloud.`);
  return { days: restoredDays, sales: restoredSales, older, truncated };
}

// ═══════════════════════════════════════════════════════════════════
// CLOSED DAYS — one document per trading session
//
// A session is Open Day → Close Day, not a calendar date. A shop that starts
// billing at 2pm and taps Close Day at 5am the next morning traded ONE
// session across two dates, and handleCloseDay already models it that way:
// the period is everything since the previous close.
//
// These summaries used to ride inside client_data/{key} as the
// restopos_closed_days field — the single document Firestore caps at 1 MiB,
// shared with the menu, settings, customers and the recent working set. A
// close record measures 424 bytes and the local list holds 1,000 of them, so
// a shop closing daily reaches 414 KB of that budget in under three years.
// The per-key sync guard refuses anything over 350 KB, which it would have
// crossed at around 850 closes — a bit over two years. Past that point those
// clients' close history had quietly stopped backing up altogether. The guard
// did its job and kept the rest of the backup alive; the history itself was
// going nowhere. (Measured, not estimated: see e2e/sessions.mjs.)
//
// One document per session removes the ceiling entirely, and the day log
// rides along inside the session that produced it rather than being a second
// unbounded key.
// ═══════════════════════════════════════════════════════════════════

const CLOSED_FP_KEY = "restopos_closed_days_fp";

/** Stable, sortable, collision-free id for one close. */
function closeIdOf(summary) {
  const stamp = String(summary?.closeTime || summary?.closedAt || summary?.date || "");
  const clean = stamp.replace(/[:.\/]/g, "-").slice(0, 120);
  return clean || null;
}

function loadClosedFingerprints() {
  try { return JSON.parse(localStorage.getItem(CLOSED_FP_KEY) || "{}"); } catch (e) { return {}; }
}

/**
 * Write every session this device holds that the cloud has not confirmed.
 *
 * Runs on boot and after each close. Fingerprinted, so re-running it is free —
 * which is what makes it both the migration for existing clients and the
 * retry for a close that happened while the till was offline. No separate
 * queue: the local list IS the queue, and it is already durable.
 */
export async function syncClosedDays(licenseKey, sessions, dayLog) {
  if (!fb || !licenseKey || !Array.isArray(sessions) || !sessions.length) return 0;
  const { db, doc, collection, writeBatch } = fb;
  const fps = loadClosedFingerprints();
  const scope = fps[licenseKey] || (fps[licenseKey] = {});

  const changed = [];
  for (const s of sessions) {
    const id = closeIdOf(s);
    if (!id) continue;
    // The per-date log entries this session produced. Carried here so the
    // calendar view can be rebuilt on a new device without a second key.
    const days = {};
    if (dayLog) {
      for (const [date, entry] of Object.entries(dayLog)) {
        if (entry && entry.partOfClose === s.date) days[date] = entry;
      }
    }
    const body = { summary: s, days, closeTime: s.closeTime || s.closedAt || s.date || "", date: s.date || "" };
    const fp = fingerprint(body);
    if (scope[id] === fp) continue;
    changed.push({ id, body, fp });
  }
  if (!changed.length) return 0;

  for (let i = 0; i < changed.length; i += BATCH_LIMIT) {
    const slice = changed.slice(i, i + BATCH_LIMIT);
    const batch = writeBatch(db);
    for (const c of slice) {
      batch.set(doc(collection(db, "client_data", licenseKey, "closed_days"), c.id), c.body, { merge: true });
    }
    await batch.commit();
    // Recorded per batch, not at the end: a till that loses its connection
    // half-way keeps credit for the sessions that did land.
    for (const c of slice) scope[c.id] = c.fp;
    try { localStorage.setItem(CLOSED_FP_KEY, JSON.stringify(fps)); } catch (e) {}
  }
  console.log(`[Sessions] ${changed.length} trading session(s) backed up.`);
  return changed.length;
}

/**
 * Every session the cloud holds, newest first. Ordered on closeTime, which is
 * a single field and therefore served by the automatic index — no composite
 * to deploy before this works.
 */
export async function loadClosedDays(licenseKey, max = 1000) {
  if (!fb || !licenseKey) return { sessions: [], dayLog: {} };
  const { db, collection, query, orderBy, limit, getDocs } = fb;
  const sessions = [], dayLog = {};
  try {
    const snap = await getDocs(query(
      collection(db, "client_data", licenseKey, "closed_days"),
      orderBy("closeTime", "desc"), limit(max),
    ));
    snap.docs.forEach((d) => {
      const v = d.data() || {};
      if (v.summary) sessions.push(v.summary);
      if (v.days) Object.assign(dayLog, v.days);
    });
  } catch (e) {
    console.warn("[Sessions] read failed:", e && e.message);
  }
  return { sessions, dayLog };
}

/**
 * Merge the cloud's sessions into this device, newest wins on a tie.
 *
 * Used when a client signs in on a replacement till: the close history is
 * what Reports and the day calendar are built from, and without it the new
 * device looks like a brand-new shop.
 */
export async function restoreClosedDays(licenseKey) {
  const { sessions, dayLog } = await loadClosedDays(licenseKey);
  if (!sessions.length) return 0;
  try {
    const local = JSON.parse(localStorage.getItem("restopos_closed_days") || "[]");
    const byId = new Map();
    for (const s of sessions) byId.set(closeIdOf(s), s);
    for (const s of local) byId.set(closeIdOf(s), s);   // local wins — it is the newer writer
    const merged = Array.from(byId.values())
      .sort((a, b) => String(b.closeTime || b.closedAt || b.date || "").localeCompare(String(a.closeTime || a.closedAt || a.date || "")));
    localStorage.setItem("restopos_closed_days", JSON.stringify(merged.slice(0, 1000)));

    const localLog = JSON.parse(localStorage.getItem("restopos_daylog") || "{}");
    localStorage.setItem("restopos_daylog", JSON.stringify({ ...dayLog, ...localLog }));
    console.log(`[Sessions] restored ${sessions.length} session(s) from the cloud.`);
    return sessions.length;
  } catch (e) {
    console.warn("[Sessions] restore failed:", e && e.message);
    return 0;
  }
}
