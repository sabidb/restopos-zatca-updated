// Golden tests for src/lib/catalogueFlag.js (pure resolution) — run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCatalogueFlag } from "./catalogueFlag.js";

test("off by default (no licence flag, no account flag)", () => {
  assert.equal(resolveCatalogueFlag(null, undefined), false);
  assert.equal(resolveCatalogueFlag({}, false), false);
});

test("licence-level flag (admin/server) forces it on, whatever the account flag", () => {
  assert.equal(resolveCatalogueFlag({ catalogueSubcollection: true }, false), true);
  assert.equal(resolveCatalogueFlag({ catalogueSubcollection: true }, undefined), true);
});

test("synced account flag turns it on when the licence doesn't force it", () => {
  assert.equal(resolveCatalogueFlag({}, true), true);
  assert.equal(resolveCatalogueFlag(null, true), true);
});

test("only strict true enables it (guards against truthy junk)", () => {
  assert.equal(resolveCatalogueFlag({ catalogueSubcollection: "yes" }, "yes"), false);
  assert.equal(resolveCatalogueFlag({ catalogueSubcollection: 1 }, 1), false);
});
