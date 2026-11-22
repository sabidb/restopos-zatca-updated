// ═══════════════════════════════════════════════════════════════════
// CSV — a small, correct CSV parser for product imports.
//
// The old import did `line.split("\n")` then `line.split(",")`, which corrupts
// any value containing a comma (e.g. "Rice, Basmati 5kg"), mishandles Windows
// CRLF endings, and breaks on a UTF-8 BOM. This parser follows RFC-4180:
// quoted fields may contain commas, escaped quotes ("" -> ") and newlines.
//
// parseCSV(text) -> { headers:string[], rows:Array<Record<string,string>> }
// Headers are lowercased + trimmed; cell values are trimmed. Blank lines skipped.
// ═══════════════════════════════════════════════════════════════════

/** Tokenise CSV text into records (arrays of raw string cells), honouring quotes. */
export function parseCSVRecords(text) {
  const s = String(text ?? "").replace(/^﻿/, ""); // strip UTF-8 BOM
  const records = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let started = false; // did the current record have any content/field?
  let i = 0;
  const endField = () => { row.push(field); field = ""; };
  const endRow = () => { records.push(row); row = []; started = false; };
  while (i < s.length) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; started = true; i++; continue; }
    if (ch === ",") { endField(); started = true; i++; continue; }
    if (ch === "\r") { endField(); endRow(); i += s[i + 1] === "\n" ? 2 : 1; continue; }
    if (ch === "\n") { endField(); endRow(); i++; continue; }
    field += ch; started = true; i++;
  }
  if (started || field !== "") { endField(); endRow(); }
  return records;
}

/** Parse CSV text to { headers, rows } objects. Blank lines dropped; cells trimmed. */
export function parseCSV(text) {
  const records = parseCSVRecords(text).filter(
    (r) => !(r.length === 1 && r[0].trim() === "")
  );
  if (records.length === 0) return { headers: [], rows: [] };
  const headers = records[0].map((h) => String(h).trim().toLowerCase());
  const rows = records.slice(1).map((cells) => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = String(cells[idx] ?? "").trim(); });
    return obj;
  });
  return { headers, rows };
}
