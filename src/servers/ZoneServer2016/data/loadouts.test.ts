import assert from "node:assert";
import test from "node:test";
import {
  characterDefaultLoadout,
  characterJuggernautLoadout,
  characterSoloStarterLoadout
} from "./loadouts";
import { Items } from "../models/enums";

test("solo starter loadout preserves defaults and includes the juggernaut kit", () => {
  for (const entry of characterDefaultLoadout) {
    assert.ok(
      characterSoloStarterLoadout.some(
        (starterEntry) =>
          starterEntry.item === entry.item && starterEntry.count === entry.count
      )
    );
  }

  for (const entry of characterJuggernautLoadout) {
    assert.ok(
      characterSoloStarterLoadout.some(
        (starterEntry) =>
          starterEntry.item === entry.item && starterEntry.count === entry.count
      )
    );
  }
});

test("juggernaut kit has armor, tactical weapons, and deep ammunition", () => {
  const expectedItems = new Map<Items, number | undefined>([
    [Items.BACKPACK_MILITARY_GREEN_CAMO, undefined],
    [Items.KEVLAR_DEFAULT, undefined],
    [Items.HELMET_TACTICAL, undefined],
    [Items.NV_GOGGLES, undefined],
    [Items.WEAPON_AR15, undefined],
    [Items.WEAPON_SHOTGUN, undefined],
    [Items.WEAPON_308, undefined],
    [Items.AMMO_223, 300],
    [Items.AMMO_12GA, 120],
    [Items.AMMO_308, 100],
    [Items.FIRST_AID, 20]
  ]);

  for (const [item, count] of expectedItems) {
    assert.ok(
      characterJuggernautLoadout.some(
        (entry) => entry.item === item && entry.count === count
      )
    );
  }
});
