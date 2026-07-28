import assert from "node:assert";
import test from "node:test";
import { ItemUseOptions } from "./models/enums";
import { resolveItemUseCount } from "./zonepackethandlers";

test("zero-count drop requests default to one item", () => {
  assert.equal(resolveItemUseCount(ItemUseOptions.DROP, undefined, 0), 1);
  assert.equal(
    resolveItemUseCount(ItemUseOptions.DROP_BATTERY, undefined, 0),
    1
  );
  assert.equal(
    resolveItemUseCount(ItemUseOptions.DROP_SPARKS, undefined, 0),
    1
  );
});

test("explicit item-subdata count wins for drop requests", () => {
  assert.equal(resolveItemUseCount(ItemUseOptions.DROP, 4, 1), 4);
});

test("zero-count non-drop requests remain invalid", () => {
  assert.equal(resolveItemUseCount(ItemUseOptions.EQUIP, undefined, 0), 0);
});
