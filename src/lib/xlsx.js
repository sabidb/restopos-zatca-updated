// ═══════════════════════════════════════════════════════════════════
// XLSX — a minimal, dependency-light .xlsx reader built on jszip (already a
// project dependency). It reads what a product import needs — sheet names,
// header row, and text/number cells — without pulling in a heavy third-party
// spreadsheet library. It is NOT a full XLSX implementation: it does not
// interpret date number-formats (a date cell comes back as its serial number),
// styles, merged cells or formulas-as-values beyond cached string results.
//
// parseXLSX(data) -> { sheets: [{ name, rows: string[][] }] }   (async)
// data may be an ArrayBuffer, Uint8Array, or Blob/File.
// ═══════════════════════════════════════════════════════════════════
import JSZip from "jszip";

const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X"
        ? parseInt(code.slice(2), 16)
        : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return XML_ENTITIES[code] ?? m;
  });
}

// "A"->0, "Z"->25, "AA"->26 …  Reads the leading letters of a cell ref like "AB12".
function colIndex(ref) {
  const letters = String(ref).match(/^[A-Z]+/i);
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters[0].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// All <t>…</t> text inside a chunk (shared-string <si> or inline <is>), concatenated.
function joinText(chunk) {
  let out = "";
  const re = /<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g;
  let m;
  while ((m = re.exec(chunk))) out += decodeEntities(m[1] ?? "");
  return out;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const re = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml))) out.push(joinText(m[1]));
  return out;
}

function parseSheet(xml, shared) {
  const rows = [];
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const inner = rm[2] || "";
    const cells = [];
    let autoCol = 0;
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(inner))) {
      const attrs = cm[1] || "";
      const body = cm[2] || "";
      const refM = attrs.match(/\br="([A-Z]+\d+)"/i);
      const idx = refM ? colIndex(refM[1]) : autoCol;
      autoCol = idx + 1;
      const tM = attrs.match(/\bt="([^"]+)"/);
      const type = tM ? tM[1] : "n";
      let val = "";
      if (type === "s") {
        const vM = body.match(/<v>([\s\S]*?)<\/v>/);
        const si = vM ? parseInt(vM[1], 10) : NaN;
        val = Number.isFinite(si) && shared[si] != null ? shared[si] : "";
      } else if (type === "inlineStr") {
        val = joinText(body);
      } else {
        const vM = body.match(/<v>([\s\S]*?)<\/v>/);
        val = vM ? decodeEntities(vM[1]) : "";
      }
      while (cells.length < idx) cells.push("");
      cells[idx] = val;
    }
    rows.push(cells);
  }
  return rows;
}

// Map sheet display names (workbook order) to their worksheet file paths via rels.
function sheetFileOrder(workbookXml, relsXml, zip) {
  const names = [];
  const sheetRe = /<sheet\b[^>]*\bname="([^"]*)"[^>]*\br:id="([^"]*)"[^>]*\/?>/g;
  let m;
  while ((m = sheetRe.exec(workbookXml || ""))) names.push({ name: decodeEntities(m[1]), rid: m[2] });
  const relMap = {};
  const relRe = /<Relationship\b[^>]*\bId="([^"]*)"[^>]*\bTarget="([^"]*)"[^>]*\/?>/g;
  let r;
  while ((r = relRe.exec(relsXml || ""))) relMap[r[1]] = r[2].replace(/^\/?xl\//, "").replace(/^\//, "");
  return names.map(({ name, rid }) => {
    let target = relMap[rid] || "";
    if (target && !target.startsWith("worksheets/")) target = target.replace(/^.*?(worksheets\/)/, "$1");
    const path = target ? `xl/${target}` : null;
    return { name, path: path && zip.file(path) ? path : null };
  });
}

export async function parseXLSX(data) {
  const zip = await JSZip.loadAsync(data);
  const read = async (p) => (zip.file(p) ? zip.file(p).async("string") : "");
  const shared = parseSharedStrings(await read("xl/sharedStrings.xml"));
  const workbookXml = await read("xl/workbook.xml");
  const relsXml = await read("xl/_rels/workbook.xml.rels");
  let order = sheetFileOrder(workbookXml, relsXml, zip).filter((s) => s.path);
  if (order.length === 0) {
    // Fallback: every worksheet file in natural order, named Sheet1…N.
    order = Object.keys(zip.files)
      .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
      .sort()
      .map((p, i) => ({ name: `Sheet${i + 1}`, path: p }));
  }
  const sheets = [];
  for (const { name, path } of order) {
    sheets.push({ name, rows: parseSheet(await read(path), shared) });
  }
  return { sheets };
}
