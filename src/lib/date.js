// Shared Saudi business date helpers.
// Use Asia/Riyadh rather than UTC so sales and VAT periods follow the local
// business calendar even when the browser/device timezone differs.
export function businessToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Compatibility constant for existing callers. Prefer businessToday() in code
// that must remain correct across midnight without a page reload.
export const TODAY = businessToday();
