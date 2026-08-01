// ======================================================================
//
//   GNU GENERAL PUBLIC LICENSE
//   Version 3, 29 June 2007
//   copyright (C) 2021 - 2026 H1emu community
//
// ======================================================================

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  NavigationArea,
  NavigationPolyFlag,
  NavigationSemantic,
  navigationSemanticArea,
  runtimeNavigationArea,
  TILECACHE_LEGACY_WALKABLE_AREA
} from "./navigationareas";

describe("navigation semantic area contract", () => {
  it("preserves semantic areas and assigns their runtime flags", () => {
    assert.deepEqual(runtimeNavigationArea(NavigationArea.Road), {
      area: NavigationArea.Road,
      flags: NavigationPolyFlag.Walk,
      legacy: false
    });
    assert.deepEqual(runtimeNavigationArea(NavigationArea.FloorInterior), {
      area: NavigationArea.FloorInterior,
      flags: NavigationPolyFlag.Walk | NavigationPolyFlag.Indoor,
      legacy: false
    });
    assert.deepEqual(runtimeNavigationArea(NavigationArea.Threshold), {
      area: NavigationArea.Threshold,
      flags:
        NavigationPolyFlag.Walk |
        NavigationPolyFlag.Transition |
        NavigationPolyFlag.Door,
      legacy: false
    });
  });

  it("maps a legacy tile-cache walkable marker without changing WALK behavior", () => {
    assert.deepEqual(runtimeNavigationArea(TILECACHE_LEGACY_WALKABLE_AREA), {
      area: NavigationArea.Terrain,
      flags: NavigationPolyFlag.Walk,
      legacy: true
    });
  });

  it("maps non-walkable source semantics to null", () => {
    for (const semantic of [
      NavigationSemantic.ObstacleStatic,
      NavigationSemantic.DoorPanelDynamic,
      NavigationSemantic.Exclude,
      NavigationSemantic.Unknown
    ]) {
      assert.equal(navigationSemanticArea(semantic), NavigationArea.Null);
    }
  });

  it("rejects unsupported baker area IDs", () => {
    assert.throws(
      () => runtimeNavigationArea(42),
      /unsupported semantic area id 42/
    );
  });
});
