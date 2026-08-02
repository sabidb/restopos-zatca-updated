// ═══════════════════════════════════════════════════════════════════
// KITCHEN PRINTER STATIONS
//
// A shop can have more than one kitchen: a grill, a cold/juice counter, a
// bakery bench. Each station is one printer plus the categories it cooks, so
// a ticket only lists what that station actually makes.
//
// A station:
//   { id, name, printer, paperWidth, categories: [], enabled }
//
// `categories: []` means "everything" — which is exactly the old
// single-kitchen behaviour, and what the migration below produces, so a shop
// that never configures stations keeps printing precisely as it did before.
// ═══════════════════════════════════════════════════════════════════
import { LS } from "./storage.js";

export const STATIONS_KEY = "restopos_kitchen_stations";
// Legacy single-kitchen keys, still read once for migration.
const LEGACY_QZ_KITCHEN = "restopos_qz_kitchen_printer";
const LEGACY_KITCHEN_CFG = "restopos_kitchen_printer";

const newId = () => `st-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

export function makeStation(over = {}) {
  return {
    id: newId(),
    name: "Kitchen",
    printer: "",
    paperWidth: "80mm",
    categories: [],   // empty = all categories
    enabled: true,
    ...over,
  };
}

// Read the configured stations. If none exist yet but a legacy single kitchen
// printer was set up, fold it into one station so nothing silently stops
// printing after an upgrade.
export function getStations() {
  const saved = LS.get(STATIONS_KEY);
  if (Array.isArray(saved) && saved.length) return saved.map((s) => ({ ...makeStation(), ...s }));

  let legacyPrinter = "";
  try { legacyPrinter = localStorage.getItem(LEGACY_QZ_KITCHEN) || ""; } catch (e) {}
  const legacyCfg = LS.get(LEGACY_KITCHEN_CFG) || {};
  if (legacyPrinter || legacyCfg.name) {
    return [makeStation({
      name: legacyCfg.name || "Kitchen",
      printer: legacyPrinter,
      paperWidth: legacyCfg.paperWidth || "80mm",
      enabled: legacyCfg.enabled !== false,
    })];
  }
  return [];
}

export function saveStations(list) {
  const clean = (Array.isArray(list) ? list : []).map((s) => ({ ...makeStation(), ...s }));
  LS.set(STATIONS_KEY, clean);
  // Keep the legacy key pointing at the first station's printer so any older
  // code path (and the QZ engine's _qzKitchenPrinter default) stays coherent.
  try {
    const first = clean.find((s) => s.enabled && s.printer);
    if (first) localStorage.setItem(LEGACY_QZ_KITCHEN, first.printer);
  } catch (e) {}
  return clean;
}

// Which items belong to this station: everything when no categories are
// pinned, otherwise only the matching ones.
export function itemsForStation(items, station) {
  const list = Array.isArray(items) ? items : [];
  const cats = Array.isArray(station?.categories) ? station.categories.filter(Boolean) : [];
  if (!cats.length) return list;
  const want = new Set(cats.map((c) => String(c).toLowerCase()));
  return list.filter((it) => want.has(String(it?.category || "").toLowerCase()));
}

// Plan the KOT run for one order: the enabled stations that have both a
// printer and at least one item to cook. Callers print one ticket per entry.
export function routeKOT(items, stations) {
  const list = Array.isArray(stations) ? stations : getStations();
  const plan = [];
  for (const station of list) {
    if (!station || station.enabled === false || !station.printer) continue;
    const stationItems = itemsForStation(items, station);
    if (!stationItems.length) continue;
    plan.push({ station, items: stationItems });
  }
  return plan;
}
