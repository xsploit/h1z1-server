import type {
  HumanNpcDisposition,
  HumanNpcRole
} from "../entities/hostilesurvivor";

type SpawnPosition = [number, number, number, number];

export interface PoiHumanSpawnProfile {
  id: string;
  label: string;
  positions: SpawnPosition[];
  patrolRadius: number;
  disposition: HumanNpcDisposition;
  role: HumanNpcRole;
}

export interface PoiHumanSpawnSlot
  extends Omit<PoiHumanSpawnProfile, "positions"> {
  position: SpawnPosition;
  slot: number;
  spawnerId: number;
}

function policePost(
  id: string,
  label: string,
  positions: SpawnPosition[]
): PoiHumanSpawnProfile {
  return {
    id,
    label,
    positions,
    patrolRadius: 45,
    disposition: "survivor",
    role: "police"
  };
}

export const POI_HUMAN_SPAWN_PROFILES: PoiHumanSpawnProfile[] = [
  {
    id: "military",
    label: "Military Base",
    positions: [
      [688.5, 48.08, -2476, 1],
      [704.5, 48.08, -2476, 1],
      [930.43, 14, -2704.97, 1],
      [705.24, 14, -2704.81, 1],
      [844, 16.1, -2659, 1]
    ],
    patrolRadius: 80,
    disposition: "survivor",
    role: "military"
  },
  {
    id: "hospital",
    label: "Hospital",
    positions: [
      [1895.92, 93.69, -2747.17, 1],
      [1852.99, 93.69, -2780.15, 1],
      [1861.14, 93.69, -2910.28, 1]
    ],
    patrolRadius: 60,
    disposition: "survivor",
    role: "medic"
  },
  policePost("police-1", "Pleasant Valley Police Station", [
    [-222.04, 23.41, -1133.48, 1],
    [-240.86, 23.41, -1134.44, 1]
  ]),
  policePost("police-2", "Police Station 2", [
    [-592.8, 47.5, 1204.1, 1],
    [-598.8, 47.5, 1204.1, 1]
  ]),
  policePost("police-3", "Police Station 3", [
    [337.1, 31.6, -1156.6, 1],
    [343.1, 31.6, -1156.6, 1]
  ]),
  policePost("police-4", "Police Station 4", [
    [-1383.3, 74.6, 1803.3, 1],
    [-1389.3, 74.6, 1803.3, 1]
  ]),
  policePost("police-5", "Police Station 5", [
    [2166, 47.5, -991.7, 1],
    [2172, 47.5, -991.7, 1]
  ])
];

export function getPoiHumanSpawnSlots(
  profiles = POI_HUMAN_SPAWN_PROFILES
): PoiHumanSpawnSlot[] {
  return profiles.flatMap((profile, profileIndex) =>
    profile.positions.map((position, slot) => ({
      id: profile.id,
      label: profile.label,
      position,
      patrolRadius: profile.patrolRadius,
      disposition: profile.disposition,
      role: profile.role,
      slot,
      spawnerId: 2_000_000 + profileIndex * 100 + slot
    }))
  );
}
