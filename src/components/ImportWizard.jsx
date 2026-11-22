// ═══════════════════════════════════════════════════════════════════
// IMPORT WIZARD — bulk product import: CSV / XLSX / JSON, sheet + column
// mapping (auto-suggested, with saved profiles), validation, duplicate
// detection, batched apply with progress, a downloadable error report, and
// import history. Pure logic lives in src/lib (csv, xlsx, importMap,
// importPlan); this component is the UI around it.
//
// Props:
//   items         current catalogue (for dedup / update matching)
//   categories    category list (fallback for a blank category cell)
//   onApply(newItems, updatedById)  apply the plan to the catalogue
//   onClose()
// ═══════════════════════════════════════════════════════════════════
import { useState, useEffect, useMemo } from "react";
import { C } from "../lib/theme.js";
import { LS } from "../lib/storage.js";
import { Modal, Btn, Sel, Badge } from "./ui.jsx";
import { parseCSVRecords, toCSV } from "../lib/csv.js";
import { parseXLSX } from "../lib/xlsx.js";
import { IMPORT_FIELDS, norm, suggestMapping, applyMapping, mappingComplete, validateRows } from "../lib/importMap.js";
import { classifyImport, mergeUpdate } from "../lib/importPlan.js";

const PROFILES_KEY = "restopos_import_profiles";
const HISTORY_KEY = "restopos_import_history";
const colLetter = (i) => { let s = "", n = i + 1; while (n > 0) { s = String.fromCharCode(65 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); } return s; };
const download = (name, text) => {
  const blob = new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob); const a = document.createElement("a");
  a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export default function ImportWizard({ items = [], categories = [], onApply, onClose, onPersist, onTemplate }) {
  const [raw, setRaw] = useState(null);        // { fileName, sheets:[{name,rows}] }
  const [sheetIdx, setSheetIdx] = useState(0);
  const [mapping, setMapping] = useState({});
  const [updateExisting, setUpdateExisting] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);  // { created, updated, skipped, errors, errorRows }
  const [profiles, setProfiles] = useState(() => LS.get(PROFILES_KEY) || []);
  const history = LS.get(HISTORY_KEY) || [];

  const sheet = raw?.sheets?.[sheetIdx] || null;
  const headers = useMemo(() => (sheet?.rows?.[0] || []).map((h) => String(h ?? "")), [sheet]);
  const dataRows = useMemo(() => (sheet?.rows || []).slice(1).filter((r) => r.some((c) => String(c ?? "").trim() !== "")), [sheet]);

  // When a sheet is chosen, auto-apply a saved profile that matches these
  // headers, else auto-suggest a mapping.
  useEffect(() => {
    if (!sheet) return;
    const sig = JSON.stringify(headers.map(norm));
    const prof = profiles.find((p) => p.sig === sig);
    setMapping(prof ? prof.mapping : suggestMapping(headers));
  }, [sheet, headers]); // eslint-disable-line

  const ready = headers.length > 0 && mappingComplete(mapping);
  const mapped = useMemo(() => (ready ? applyMapping(dataRows, mapping) : []), [ready, dataRows, mapping]);
  const { valid, errors } = useMemo(() => (ready ? validateRows(mapped) : { valid: [], errors: [] }), [ready, mapped]);
  const plan = useMemo(() => (ready ? classifyImport(valid, items, { updateExisting }) : null), [ready, valid, items, updateExisting]);

  async function handleFile(file) {
    setError(""); setResult(null); setRaw(null); setSheetIdx(0);
    try {
      const name = file.name.toLowerCase();
      let sheets;
      if (name.endsWith(".xlsx")) {
        sheets = (await parseXLSX(await file.arrayBuffer())).sheets;
      } else if (name.endsWith(".json")) {
        const arr = JSON.parse(await file.text());
        const list = Array.isArray(arr) ? arr : [];
        const keys = [...new Set(list.flatMap((o) => Object.keys(o || {})))];
        sheets = [{ name: "JSON", rows: [keys, ...list.map((o) => keys.map((k) => o?.[k] ?? ""))] }];
      } else {
        const rows = parseCSVRecords(await file.text()).filter((r) => !(r.length === 1 && String(r[0]).trim() === ""));
        sheets = [{ name: "CSV", rows }];
      }
      if (!sheets.length || !(sheets[0].rows || []).length) { setError("No rows found in the file."); return; }
      setRaw({ fileName: file.name, sheets });
    } catch (e) { setError("Could not read file: " + e.message); }
  }

  function saveProfile() {
    const nm = (prompt("Name this column mapping (e.g. your supplier's export):") || "").trim();
    if (!nm) return;
    const sig = JSON.stringify(headers.map(norm));
    const next = [{ name: nm, sig, mapping }, ...profiles.filter((p) => p.name !== nm)].slice(0, 30);
    setProfiles(next); LS.set(PROFILES_KEY, next); onPersist?.(PROFILES_KEY, next);
  }

  async function apply() {
    if (!plan) return;
    setBusy(true); setProgress(0);
    const cat0 = categories[0] || "General";
    const newItems = []; const updatedById = new Map();
    const work = [
      ...plan.create.map((e) => ({ kind: "c", e })),
      ...plan.update.map((e) => ({ kind: "u", e })),
    ];
    const CHUNK = 400;
    for (let i = 0; i < work.length; i += CHUNK) {
      for (const w of work.slice(i, i + CHUNK)) {
        const r = w.e.row;
        if (w.kind === "c") {
          newItems.push({ id: Date.now() + Math.random(), name: r.name || "", nameAr: r.namear || r.nameAr || "", category: r.category || cat0, price: parseFloat(r.price) || 0, cost: parseFloat(r.cost || 0) || 0, stock: 0, active: true, barcode: r.barcode || "" });
        } else {
          updatedById.set(w.e.existing.id, mergeUpdate(w.e.existing, r));
        }
      }
      setProgress(Math.min(100, Math.round(((i + CHUNK) / Math.max(1, work.length)) * 100)));
      await new Promise((res) => setTimeout(res, 0)); // yield so the bar paints
    }
    onApply?.(newItems, updatedById);
    const rec = { at: new Date().toISOString(), file: raw.fileName, sheet: sheet.name, created: newItems.length, updated: updatedById.size, skipped: plan.skip.length, errors: errors.length };
    const hist = [rec, ...(LS.get(HISTORY_KEY) || [])].slice(0, 50);
    LS.set(HISTORY_KEY, hist); onPersist?.(HISTORY_KEY, hist);
    setResult({ ...rec, errorRows: errors });
    setBusy(false);
  }

  function downloadErrors(rows) {
    const body = rows.map((e) => [e.index + 2, e.row.name, e.row.price, e.row.barcode, e.messages.join("; ")]);
    download("import-errors.csv", toCSV(["row", "name", "price", "barcode", "errors"], body));
  }

  const colOptions = [{ value: "-1", label: "— none —" }, ...headers.map((h, i) => ({ value: String(i), label: `${colLetter(i)}: ${h || "(blank)"}` }))];

  return (
    <Modal title="📥 Import Products" onClose={onClose} width={720}>
      {/* RESULT ──────────────────────────────────────────── */}
      {result ? (
        <div style={{ textAlign: "center", padding: "12px 0" }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>✅</div>
          <div style={{ fontSize: 16, fontWeight: 800, color: C.success, marginBottom: 12 }}>Import complete</div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap", marginBottom: 16 }}>
            <Badge color={C.success} bg={C.successLight}>{result.created} created</Badge>
            {result.updated > 0 && <Badge color={C.info} bg={C.infoLight}>{result.updated} updated</Badge>}
            {result.skipped > 0 && <Badge color={C.textMid} bg={C.bg}>{result.skipped} skipped</Badge>}
            {result.errors > 0 && <Badge color={C.danger} bg={C.dangerLight}>{result.errors} errors</Badge>}
          </div>
          {result.errors > 0 && <Btn variant="outline" size="sm" onClick={() => downloadErrors(result.errorRows)} style={{ marginBottom: 10 }}>⬇️ Download error report</Btn>}
          <div><Btn onClick={onClose}>Done</Btn></div>
        </div>
      ) : (
        <>
          {/* UPLOAD ───────────────────────────────────────── */}
          <div style={{ fontSize: 13, color: C.textMid, marginBottom: 8 }}>Import your catalogue from CSV, Excel (.xlsx) or JSON. You'll map columns and preview before anything is saved.</div>
          <div style={{ fontSize: 12, color: C.textMid, marginBottom: 14, padding: "8px 12px", background: C.infoLight, border: `1px solid ${C.info}44`, borderRadius: 8 }}>ℹ️ This imports the product catalogue only. <strong>Opening stock is not set here</strong> — new products start at 0; set quantities separately so catalogue and inventory stay correct.</div>
          <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "9px 16px", background: C.primaryLight, border: `1.5px solid ${C.primary}`, borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600, color: C.primary }}>
              📂 Choose file (CSV / XLSX / JSON)
              <input type="file" accept=".csv,.xlsx,.json,.txt" onChange={(e) => { const f = e.target.files[0]; if (f) handleFile(f); e.target.value = ""; }} style={{ display: "none" }} />
            </label>
            {onTemplate && <button onClick={onTemplate} style={{ padding: "9px 14px", background: "transparent", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, fontWeight: 600, color: C.textMid, cursor: "pointer", fontFamily: "inherit" }}>⬇️ Download template</button>}
            {raw && <span style={{ fontSize: 12, color: C.textMid }}>📄 {raw.fileName}</span>}
          </div>
          {error && <div style={{ padding: "10px 14px", background: C.dangerLight, border: `1px solid ${C.danger}`, borderRadius: 8, fontSize: 13, color: C.danger, marginBottom: 16 }}>{error}</div>}

          {/* SHEET PICKER (xlsx multi-sheet) ───────────────── */}
          {raw && raw.sheets.length > 1 && (
            <div style={{ marginBottom: 16, maxWidth: 280 }}>
              <Sel label="Sheet" value={String(sheetIdx)} onChange={(v) => setSheetIdx(parseInt(v))} options={raw.sheets.map((s, i) => ({ value: String(i), label: s.name }))} />
            </div>
          )}

          {/* MAPPING ───────────────────────────────────────── */}
          {raw && headers.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 8, flexWrap: "wrap" }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>Map columns <span style={{ fontWeight: 400, color: C.textMid }}>({dataRows.length} data rows)</span></div>
                <div style={{ display: "flex", gap: 6 }}>
                  {profiles.length > 0 && <Sel value="" onChange={(v) => { const p = profiles[parseInt(v)]; if (p) setMapping(p.mapping); }} options={[{ value: "", label: "Load saved mapping…" }, ...profiles.map((p, i) => ({ value: String(i), label: p.name }))]} />}
                  <Btn size="sm" variant="ghost" onClick={saveProfile}>💾 Save mapping</Btn>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(210px,1fr))", gap: 10 }}>
                {IMPORT_FIELDS.map((f) => (
                  <Sel key={f.key} label={f.label + (f.required ? " *" : "")} value={String(mapping[f.key] ?? -1)} onChange={(v) => setMapping((m) => ({ ...m, [f.key]: parseInt(v) }))} options={colOptions} />
                ))}
              </div>
              {!mappingComplete(mapping) && <div style={{ fontSize: 12, color: C.danger, marginTop: 8 }}>Map the required fields (*) to continue.</div>}
            </div>
          )}

          {/* SUMMARY + PREVIEW ─────────────────────────────── */}
          {ready && plan && (
            <>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                <Badge color={C.success} bg={C.successLight}>{plan.summary.create} new</Badge>
                {updateExisting && plan.summary.update > 0 && <Badge color={C.info} bg={C.infoLight}>{plan.summary.update} update</Badge>}
                {!updateExisting && plan.summary.existingSkipped > 0 && <Badge color={C.textMid} bg={C.bg}>{plan.summary.existingSkipped} already exist · skipped</Badge>}
                {plan.summary.duplicateInFile > 0 && <Badge color={C.warning} bg={C.warningLight}>{plan.summary.duplicateInFile} duplicate rows</Badge>}
                {errors.length > 0 && <Badge color={C.danger} bg={C.dangerLight}>{errors.length} invalid rows</Badge>}
              </div>
              {errors.length > 0 && (
                <div style={{ fontSize: 12, color: C.danger, marginBottom: 10 }}>
                  {errors.length} row(s) have errors and will be skipped. <button onClick={() => downloadErrors(errors)} style={{ background: "none", border: "none", color: C.danger, textDecoration: "underline", cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>Download error report</button>
                </div>
              )}
              <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12, color: C.textMid, cursor: "pointer", lineHeight: 1.4, marginBottom: 12 }}>
                <input type="checkbox" checked={updateExisting} onChange={(e) => setUpdateExisting(e.target.checked)} style={{ marginTop: 2 }} />
                <span>Update products that already exist (price, cost, names, barcode — <strong>never stock</strong>; a blank cell never erases a value). Leave off to skip them, so re-importing the same file is safe.</span>
              </label>
              <div style={{ maxHeight: 220, overflowY: "auto", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 14 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead><tr style={{ background: C.bg }}>{["Name", "Arabic", "Category", "Price", "Cost", "Barcode"].map((h) => <th key={h} style={{ padding: "7px 10px", textAlign: "left", fontWeight: 700, color: C.textMid, fontSize: 10, textTransform: "uppercase", borderBottom: `1px solid ${C.border}`, position: "sticky", top: 0, background: C.bg }}>{h}</th>)}</tr></thead>
                  <tbody>{valid.slice(0, 50).map((r, i) => (
                    <tr key={i} style={{ borderBottom: `1px solid ${C.border}`, background: i % 2 ? "#FAFBFC" : "#fff" }}>
                      <td style={{ padding: "6px 10px", fontWeight: 600 }}>{r.name}</td>
                      <td style={{ padding: "6px 10px", direction: "rtl", fontFamily: "'Tajawal',sans-serif" }}>{r.nameAr || "—"}</td>
                      <td style={{ padding: "6px 10px", color: C.textMid }}>{r.category || "—"}</td>
                      <td style={{ padding: "6px 10px", color: C.primary, fontWeight: 700 }}>{r.price ? "SAR " + parseFloat(r.price).toFixed(2) : "—"}</td>
                      <td style={{ padding: "6px 10px", color: C.textMid }}>{r.cost ? "SAR " + parseFloat(r.cost).toFixed(2) : "—"}</td>
                      <td style={{ padding: "6px 10px", fontFamily: "monospace", fontSize: 11, color: C.zatca }}>{r.barcode || "—"}</td>
                    </tr>))}
                  </tbody>
                </table>
                {valid.length > 50 && <div style={{ padding: "6px 10px", fontSize: 11, color: C.textLight, textAlign: "center" }}>…and {valid.length - 50} more</div>}
              </div>
              {busy ? (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ height: 8, background: C.bg, borderRadius: 4, overflow: "hidden" }}><div style={{ width: progress + "%", height: "100%", background: C.primary, transition: "width 0.1s" }} /></div>
                  <div style={{ fontSize: 12, color: C.textMid, marginTop: 4, textAlign: "center" }}>Importing… {progress}%</div>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 10 }}>
                  <Btn variant="ghost" onClick={onClose} style={{ flex: 1 }}>Cancel</Btn>
                  <Btn onClick={apply} disabled={plan.summary.create + plan.summary.update === 0} style={{ flex: 2 }}>✓ Apply import — {plan.summary.create + (updateExisting ? plan.summary.update : 0)} product(s)</Btn>
                </div>
              )}
            </>
          )}

          {/* HISTORY ───────────────────────────────────────── */}
          {!raw && history.length > 0 && (
            <div style={{ marginTop: 18, borderTop: `1px solid ${C.border}`, paddingTop: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.textMid, marginBottom: 8 }}>Recent imports</div>
              {history.slice(0, 5).map((h, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.textMid, padding: "4px 0" }}>
                  <span>{new Date(h.at).toLocaleString()} · {h.file}</span>
                  <span>{h.created} new{h.updated ? `, ${h.updated} upd` : ""}{h.errors ? `, ${h.errors} err` : ""}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
