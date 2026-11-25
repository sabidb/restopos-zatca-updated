// ═══════════════════════════════════════════════════════════════════
// GRID NAV — pure keyboard-navigation geometry for the Supermarket POS.
//
// The supermarket till renders every control (item name, barcode, price,
// ＋ add, quantity, edit, − minus, ✕ cancel, F-keys, scan box …) as cells
// laid out in rows. This module answers one question, geometrically:
//
//   "Focus is on cell X; the cashier pressed an arrow — which cell next?"
//
// It is intentionally LAYOUT-AGNOSTIC: it works off each cell's on-screen
// position (centre x/y from getBoundingClientRect), not off any hard-coded
// row/column structure. That is why a single handler drives all four
// supermarket layouts (A/B/C/D) without knowing their markup — the DOM layer
// in App.jsx measures the cells, this decides the move.
//
// Pure + testable: no DOM, no React. The App.jsx handler builds the `cells`
// array from live rectangles and calls nextCellId(). Vertical moves clamp at
// the edges; horizontal moves serpentine across rows so EVERY cell is
// reachable by repeated ← / →, matching the "select anything" requirement.
// ═══════════════════════════════════════════════════════════════════

/** Default vertical tolerance (px): cells whose centres are within this band
 *  count as the same visual row. Tuned for the till's ~46px rows. */
export const ROW_TOLERANCE = 14;

/**
 * Group cells into visual rows (top→bottom), each sorted left→right.
 * @param {{id:*,x:number,y:number}[]} cells  cell centres
 * @param {number} rowTol  vertical band that counts as one row
 * @returns {{id:*,x:number,y:number}[][]} rows
 */
export function arrangeRows(cells = [], rowTol = ROW_TOLERANCE) {
  const list = (cells || []).filter((c) => c && c.id != null && Number.isFinite(c.x) && Number.isFinite(c.y));
  const byY = [...list].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  let cur = null;
  let baseY = null;
  for (const c of byY) {
    if (cur === null || Math.abs(c.y - baseY) > rowTol) {
      cur = [];
      rows.push(cur);
      baseY = c.y;
    }
    cur.push(c);
  }
  for (const r of rows) r.sort((a, b) => a.x - b.x);
  return rows;
}

/** Locate a cell id within arranged rows → { ri, ci } or null. */
function locate(rows, id) {
  for (let ri = 0; ri < rows.length; ri++) {
    const ci = rows[ri].findIndex((c) => c.id === id);
    if (ci >= 0) return { ri, ci };
  }
  return null;
}

/** In a row, pick the cell whose x-centre is closest to a target x. */
function nearestInRow(row, targetX) {
  let best = row[0];
  let bestD = Infinity;
  for (const c of row) {
    const d = Math.abs(c.x - targetX);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

/**
 * Next cell id for an arrow press. Returns null when the move is a no-op
 * (e.g. ↑ on the top row), so the caller can leave the key to the browser.
 *
 * @param {{id:*,x:number,y:number}[]} cells
 * @param {*} activeId  currently focused cell id (or null → entry point)
 * @param {"ArrowUp"|"ArrowDown"|"ArrowLeft"|"ArrowRight"} key
 * @param {number} rowTol
 * @returns {*|null} next cell id, or null if nothing to move to
 */
export function nextCellId(cells = [], activeId = null, key, rowTol = ROW_TOLERANCE) {
  const rows = arrangeRows(cells, rowTol);
  if (!rows.length) return null;

  const pos = activeId == null ? null : locate(rows, activeId);
  // No current focus → entry: first cell for forward/down, last for back/up.
  if (!pos) {
    if (key === "ArrowUp" || key === "ArrowLeft") {
      const last = rows[rows.length - 1];
      return last[last.length - 1].id;
    }
    return rows[0][0].id;
  }

  const { ri, ci } = pos;
  const row = rows[ri];

  switch (key) {
    case "ArrowUp": {
      if (ri === 0) return null;
      return nearestInRow(rows[ri - 1], row[ci].x).id;
    }
    case "ArrowDown": {
      if (ri === rows.length - 1) return null;
      return nearestInRow(rows[ri + 1], row[ci].x).id;
    }
    case "ArrowLeft": {
      if (ci > 0) return row[ci - 1].id;
      // serpentine to the end of the previous row
      if (ri > 0) { const p = rows[ri - 1]; return p[p.length - 1].id; }
      return null;
    }
    case "ArrowRight": {
      if (ci < row.length - 1) return row[ci + 1].id;
      // serpentine to the start of the next row
      if (ri < rows.length - 1) return rows[ri + 1][0].id;
      return null;
    }
    default:
      return null;
  }
}
