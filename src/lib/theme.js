// ═══════════════════════════════════════════════════════════════════
// THEME — the single colour palette used across the whole UI.
// Extracted verbatim from App.jsx; values unchanged.
// ═══════════════════════════════════════════════════════════════════
export const C={bg:"#F8F9FB",card:"#FFFFFF",border:"#E8EBF0",primary:"#1A6B4A",primaryLight:"#E8F5EE",primaryDark:"#134D36",accent:"#F0A500",accentLight:"#FEF6E4",danger:"#D94040",dangerLight:"#FDE8E8",info:"#2176AE",infoLight:"#E6F0F8",text:"#1A1D23",textMid:"#5A6070",textLight:"#9AA0AD",success:"#1A8A4A",successLight:"#E6F7ED",warning:"#E07B00",warningLight:"#FFF3E0",zatca:"#6366f1",zatcaLight:"#eef2ff"};

// ── Per-business-type theming ────────────────────────────────────────────────
// `C` is one shared, mutable palette object that the whole UI reads at render
// time. A business type may ship a small colour override (its folder's
// theme.js); applyBizTheme swaps ONLY those colour values in place, so every
// existing `C.primary` read picks up the new colour without touching a single
// inline style. It NEVER changes layout or logic — purely the palette.
//
// BASE is the frozen default (Restaurant) palette. applyBizTheme always resets
// to BASE first, so switching back to a type with no override restores the
// original look exactly rather than leaving a previous type's colours behind.
const BASE = { ...C };
export function applyBizTheme(overrides) {
  Object.assign(C, BASE, overrides || {});
  return C;
}
