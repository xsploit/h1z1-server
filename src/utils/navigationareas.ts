// ======================================================================
//
//   GNU GENERAL PUBLIC LICENSE
//   Version 3, 29 June 2007
//   copyright (C) 2021 - 2026 H1emu community
//
// ======================================================================

/**
 * Versioned semantic contract shared by the map extractor, Recast baker, and
 * live tile-cache mesh process. Detour areas are six-bit values; 63 is kept
 * exclusively as Recast/TileCache's legacy walkable marker.
 */
export const NAVIGATION_SEMANTIC_SCHEMA_VERSION = 1;
export const TILECACHE_LEGACY_WALKABLE_AREA = 63;

export const NavigationArea = {
  Null: 0,
  Terrain: 1,
  Road: 2,
  FloorExterior: 3,
  FloorInterior: 4,
  Stair: 5,
  Ramp: 6,
  Threshold: 7
} as const;

export type NavigationAreaId =
  (typeof NavigationArea)[keyof typeof NavigationArea];

export const NavigationPolyFlag = {
  Walk: 0x01,
  Indoor: 0x02,
  Transition: 0x04,
  Door: 0x08
} as const;

export const NavigationSemantic = {
  Terrain: "nav_terrain",
  Road: "nav_road",
  FloorExterior: "nav_floor_exterior",
  FloorInterior: "nav_floor_interior",
  Stair: "nav_stair",
  Ramp: "nav_ramp",
  Threshold: "nav_threshold",
  ObstacleStatic: "nav_obstacle_static",
  DoorPanelDynamic: "nav_door_panel_dynamic",
  Exclude: "nav_exclude",
  Unknown: "nav_unknown"
} as const;

export type NavigationSemanticName =
  (typeof NavigationSemantic)[keyof typeof NavigationSemantic];

const AREA_FLAGS: Readonly<Record<number, number>> = {
  [NavigationArea.Null]: 0,
  [NavigationArea.Terrain]: NavigationPolyFlag.Walk,
  [NavigationArea.Road]: NavigationPolyFlag.Walk,
  [NavigationArea.FloorExterior]: NavigationPolyFlag.Walk,
  [NavigationArea.FloorInterior]:
    NavigationPolyFlag.Walk | NavigationPolyFlag.Indoor,
  [NavigationArea.Stair]:
    NavigationPolyFlag.Walk | NavigationPolyFlag.Transition,
  [NavigationArea.Ramp]:
    NavigationPolyFlag.Walk | NavigationPolyFlag.Transition,
  [NavigationArea.Threshold]:
    NavigationPolyFlag.Walk |
    NavigationPolyFlag.Transition |
    NavigationPolyFlag.Door
};

export interface RuntimeNavigationArea {
  area: NavigationAreaId;
  flags: number;
  legacy: boolean;
}

/**
 * Convert a tile-cache polygon area into the runtime policy. Legacy caches use
 * area 63 for every walkable span; treat that as terrain without changing its
 * WALK behavior. Unknown area IDs fail closed so a mismatched baker cannot
 * silently create traversable polygons.
 */
export function runtimeNavigationArea(area: number): RuntimeNavigationArea {
  if (area === TILECACHE_LEGACY_WALKABLE_AREA) {
    return {
      area: NavigationArea.Terrain,
      flags: NavigationPolyFlag.Walk,
      legacy: true
    };
  }
  const flags = AREA_FLAGS[area];
  if (flags === undefined) {
    throw new Error(`[NAV] unsupported semantic area id ${area}`);
  }
  return {
    area: area as NavigationAreaId,
    flags,
    legacy: false
  };
}

export function navigationSemanticArea(
  semantic: NavigationSemanticName
): NavigationAreaId {
  switch (semantic) {
    case NavigationSemantic.Terrain:
      return NavigationArea.Terrain;
    case NavigationSemantic.Road:
      return NavigationArea.Road;
    case NavigationSemantic.FloorExterior:
      return NavigationArea.FloorExterior;
    case NavigationSemantic.FloorInterior:
      return NavigationArea.FloorInterior;
    case NavigationSemantic.Stair:
      return NavigationArea.Stair;
    case NavigationSemantic.Ramp:
      return NavigationArea.Ramp;
    case NavigationSemantic.Threshold:
      return NavigationArea.Threshold;
    case NavigationSemantic.ObstacleStatic:
    case NavigationSemantic.DoorPanelDynamic:
    case NavigationSemantic.Exclude:
    case NavigationSemantic.Unknown:
      return NavigationArea.Null;
  }
}
