import assert from "node:assert";
import test from "node:test";
import { ItemUseOptions } from "./models/enums";
import {
  getClientWireItemGuid,
  resolveClientItemGuid,
  resolveItemUseCount
} from "./zonepackethandlers";

test("short server item GUIDs resolve from the client's wire representation", () => {
  assert.equal(getClientWireItemGuid("0x391ee"), "0x391e0e0000000000");
  assert.equal(getClientWireItemGuid("0x391ef"), "0x391e0f0000000000");
  assert.equal(getClientWireItemGuid("0x391f0"), "0x391f000000000000");
  assert.equal(
    resolveClientItemGuid("0x391e0f0000000000", [
      "0x391ee",
      "0x391ef",
      "0x391f0",
      "0x391f1"
    ]),
    "0x391ef"
  );
  assert.equal(
    resolveClientItemGuid("0x391e0e0000000000", ["0x391ee"]),
    "0x391ee"
  );
  assert.equal(
    resolveClientItemGuid("0x391f000000000000", ["0x391f0"]),
    "0x391f0"
  );
});

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
