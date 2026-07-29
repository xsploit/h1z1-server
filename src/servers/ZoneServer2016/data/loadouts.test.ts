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

test("juggernaut kit has premium armor, weapons, supplies, and deep ammunition", () => {
  const expectedItems = new Map<Items, number | undefined>([
    [Items.FULLY_GEARED_EXPLORER_BACKPACK, undefined],
    [Items.HEAVY_ASSAULT_BODY_ARMOR, undefined],
    [Items.HEAVY_ASSAULT_FULL_HELMET, undefined],
    [Items.HEAVY_ASSAULT_MILITARY_PANTS, undefined],
    [Items.NV_GOGGLES, undefined],
    [Items.WEAPON_FROSTBITE, undefined],
    [Items.WEAPON_NAGAFENS_RAGE, undefined],
    [Items.WEAPON_REAPER, undefined],
    [Items.WEAPON_HEAVY_ASSAULT_MAGNUM, undefined],
    [Items.WEAPON_TOXIC_COMBATKNIFE, undefined],
    [Items.AMMO_762, 600],
    [Items.AMMO_12GA, 240],
    [Items.AMMO_308, 200],
    [Items.AMMO_44, 240],
    [Items.FIRST_AID, 30],
    [Items.GUN_REPAIR_KIT, 20],
    [Items.REPAIR_BOX, 10]
  ]);

  for (const [item, count] of expectedItems) {
    assert.ok(
      characterJuggernautLoadout.some(
        (entry) => entry.item === item && entry.count === count
      )
    );
  }

  for (const vanillaWeapon of [
    Items.WEAPON_AR15,
    Items.WEAPON_SHOTGUN,
    Items.WEAPON_308,
    Items.WEAPON_M9
  ]) {
    assert.equal(
      characterJuggernautLoadout.some((entry) => entry.item === vanillaWeapon),
      false
    );
  }
});
