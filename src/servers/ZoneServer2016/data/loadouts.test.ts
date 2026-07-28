import assert from "node:assert";
import test from "node:test";
import {
  characterDefaultLoadout,
  characterSoloStarterLoadout
} from "./loadouts";
import { Items } from "../models/enums";

test("solo starter loadout preserves defaults and adds survival essentials", () => {
  for (const entry of characterDefaultLoadout) {
    assert.ok(
      characterSoloStarterLoadout.some(
        (starterEntry) =>
          starterEntry.item === entry.item && starterEntry.count === entry.count
      )
    );
  }

  const expectedItems = new Map<Items, number | undefined>([
    [Items.BACKPACK_SATCHEL, undefined],
    [Items.WEAPON_HATCHET, undefined],
    [Items.WATER_PURE, 2],
    [Items.CANNED_FOOD01, 2],
    [Items.BANDAGE_DRESSED, 2]
  ]);

  for (const [item, count] of expectedItems) {
    assert.ok(
      characterSoloStarterLoadout.some(
        (entry) => entry.item === item && entry.count === count
      )
    );
  }
});
