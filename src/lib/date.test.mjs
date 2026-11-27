import { test } from "node:test";
import assert from "node:assert/strict";
import { businessToday, TODAY } from "./date.js";

test("businessToday follows Saudi Arabia calendar date rather than UTC", () => {
  // 2026-11-27 21:30 UTC is 2026-11-28 00:30 in Riyadh.
  assert.equal(businessToday(new Date("2026-11-27T21:30:00Z")), "2026-11-28");
  assert.equal(businessToday(new Date("2026-11-27T20:59:00Z")), "2026-11-27");
});

test("TODAY remains a valid Saudi business date compatibility constant", () => {
  assert.match(TODAY, /^\d{4}-\d{2}-\d{2}$/);
});
