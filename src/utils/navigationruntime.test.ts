// ======================================================================
//
//   GNU GENERAL PUBLIC LICENSE
//   Version 3, 29 June 2007
//   copyright (C) 2021 - 2026 H1emu community
//
// ======================================================================

import assert from "node:assert";
import test from "node:test";
import {
  navigationRuntimeSelectionsMatch,
  selectNavigationRuntime
} from "./navigationruntime";

test("stock navigation runtime needs no external module paths", () => {
  assert.deepEqual(selectNavigationRuntime(undefined, undefined, undefined), {
    mode: "stock"
  });
  assert.deepEqual(selectNavigationRuntime("0", undefined, undefined), {
    mode: "stock"
  });
});

test("64-bit navigation runtime fails closed without both modules", () => {
  assert.throws(
    () => selectNavigationRuntime("1", undefined, "wasm.mjs"),
    /NAV_64_CORE_MODULE/
  );
  assert.throws(
    () => selectNavigationRuntime("1", "core.mjs", undefined),
    /NAV_64_CORE_MODULE/
  );
});

test("64-bit navigation runtime preserves the selected module paths", () => {
  assert.deepEqual(selectNavigationRuntime("1", "core.mjs", "wasm.mjs"), {
    mode: "monolithic64",
    coreModule: "core.mjs",
    wasmModule: "wasm.mjs"
  });
});

test("an initialized 64-bit runtime cannot silently change module paths", () => {
  const selected = selectNavigationRuntime("1", "core.mjs", "wasm.mjs");
  assert.equal(navigationRuntimeSelectionsMatch(selected, selected), true);
  assert.equal(
    navigationRuntimeSelectionsMatch(
      selected,
      selectNavigationRuntime("1", "other-core.mjs", "wasm.mjs")
    ),
    false
  );
  assert.equal(
    navigationRuntimeSelectionsMatch(selected, { mode: "stock" }),
    false
  );
});
