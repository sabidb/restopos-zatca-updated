// Golden tests for src/lib/xlsx.js — run with: npm test
// Builds minimal .xlsx files in-memory with jszip, then reads them back.
import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { parseXLSX } from "./xlsx.js";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const colRef = (i) => { let s = "", n = i + 1; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };

// Build an xlsx (shared-strings path) from [{name, rows:[[cell,…],…]}].
async function makeXlsx(sheets) {
  const zip = new JSZip();
  const shared = [];
  const siIndex = (v) => { const k = String(v); let i = shared.indexOf(k); if (i < 0) { i = shared.length; shared.push(k); } return i; };

  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="xl/workbook.xml"/></Relationships>');

  let wbSheets = "", rels = "";
  sheets.forEach((sh, si) => {
    const rid = `rId${si + 1}`;
    wbSheets += `<sheet name="${esc(sh.name)}" sheetId="${si + 1}" r:id="${rid}"/>`;
    rels += `<Relationship Id="${rid}" Target="worksheets/sheet${si + 1}.xml"/>`;
    let rowsXml = "";
    sh.rows.forEach((row, ri) => {
      let cells = "";
      row.forEach((val, ci) => {
        if (val === null || val === undefined || val === "") return; // leave a gap
        const ref = `${colRef(ci)}${ri + 1}`;
        if (typeof val === "number") cells += `<c r="${ref}"><v>${val}</v></c>`;
        else cells += `<c r="${ref}" t="s"><v>${siIndex(val)}</v></c>`;
      });
      rowsXml += `<row r="${ri + 1}">${cells}</row>`;
    });
    zip.file(`xl/worksheets/sheet${si + 1}.xml`, `<?xml version="1.0"?><worksheet><sheetData>${rowsXml}</sheetData></worksheet>`);
  });

  zip.file("xl/workbook.xml", `<?xml version="1.0"?><workbook><sheets>${wbSheets}</sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0"?><Relationships>${rels}</Relationships>`);
  const si = shared.map((s) => `<si><t>${esc(s)}</t></si>`).join("");
  zip.file("xl/sharedStrings.xml", `<?xml version="1.0"?><sst count="${shared.length}" uniqueCount="${shared.length}">${si}</sst>`);

  return zip.generateAsync({ type: "uint8array" });
}

test("reads headers and string/number cells via shared strings", async () => {
  const buf = await makeXlsx([{ name: "Products", rows: [["name", "price"], ["Pepsi", 5], ["Water", 2.5]] }]);
  const { sheets } = await parseXLSX(buf);
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].name, "Products");
  assert.deepEqual(sheets[0].rows[0], ["name", "price"]);
  assert.deepEqual(sheets[0].rows[1], ["Pepsi", "5"]);
  assert.deepEqual(sheets[0].rows[2], ["Water", "2.5"]);
});

test("a gap (missing cell) is filled so columns stay aligned", async () => {
  const buf = await makeXlsx([{ name: "S", rows: [["a", "b", "c"], ["x", "", "z"]] }]);
  const { sheets } = await parseXLSX(buf);
  assert.deepEqual(sheets[0].rows[1], ["x", "", "z"]);
});

test("entities are decoded; Arabic text survives", async () => {
  const buf = await makeXlsx([{ name: "S", rows: [["name"], ["Tom & Jerry"], ["ماء"]] }]);
  const { sheets } = await parseXLSX(buf);
  assert.equal(sheets[0].rows[1][0], "Tom & Jerry");
  assert.equal(sheets[0].rows[2][0], "ماء");
});

test("multiple sheets keep their names and order", async () => {
  const buf = await makeXlsx([
    { name: "First", rows: [["a"]] },
    { name: "Second", rows: [["b"]] },
  ]);
  const { sheets } = await parseXLSX(buf);
  assert.deepEqual(sheets.map((s) => s.name), ["First", "Second"]);
});

test("inline strings (t=inlineStr) are read", async () => {
  const zip = new JSZip();
  zip.file("xl/worksheets/sheet1.xml",
    '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Hello</t></is></c></row></sheetData></worksheet>');
  const buf = await zip.generateAsync({ type: "uint8array" });
  const { sheets } = await parseXLSX(buf);
  assert.equal(sheets[0].rows[0][0], "Hello");
});
