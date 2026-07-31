import type { HumanNpcDisposition } from "../entities/hostilesurvivor";

export interface PoiHumanSpawnProfile {
  id: string;
  label: string;
  position: [number, number, number, number];
  count: number;
  patrolRadius: number;
  disposition: HumanNpcDisposition;
}

export interface PoiHumanSpawnSlot extends PoiHumanSpawnProfile {
  slot: number;
  spawnerId: number;
}

export const POI_HUMAN_SPAWN_PROFILES: PoiHumanSpawnProfile[] = [
  {
    id: "military",
    label: "Military Base",
    position: [844, 16.1, -2659, 1],
    count: 5,
    patrolRadius: 100,
    disposition: "survivor"
  },
  {
    id: "hospital",
    label: "Hospital",
    position: [1814.4, 99.1, -2788.4, 1],
    count: 3,
    patrolRadius: 70,
    disposition: "survivor"
  },
  ...[
    [-236.8, 23.1, -1154, 1],
    [-595.8, 47.5, 1204.1, 1],
    [340.1, 31.6, -1156.6, 1],
    [-1386.3, 74.6, 1803.3, 1],
    [2169, 47.5, -991.7, 1]
  ].map(
    (position, index): PoiHumanSpawnProfile => ({
      id: `police-${index + 1}`,
      label: `Police Station ${index + 1}`,
      position: position as [number, number, number, number],
      count: 2,
      patrolRadius: 45,
      disposition: "survivor"
    })
  )
];

export function getPoiHumanSpawnSlots(
  profiles = POI_HUMAN_SPAWN_PROFILES
): PoiHumanSpawnSlot[] {
  return profiles.flatMap((profile, profileIndex) =>
    Array.from({ length: profile.count }, (_, slot) => ({
      ...profile,
      slot,
      spawnerId: 2_000_000 + profileIndex * 100 + slot
    }))
  );
}
