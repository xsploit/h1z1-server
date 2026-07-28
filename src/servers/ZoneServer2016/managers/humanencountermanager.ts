import { getDistance2d } from "../../../utils/utils";
import { HumanNpcArchetype } from "../entities/hostilesurvivor";
import { ModelIds } from "../models/enums";
import type { ZoneServer2016 } from "../zoneserver";

export interface HumanEncounterDefinition {
  id: string;
  archetype: HumanNpcArchetype;
  center: Float32Array;
  count: number;
  activationRadius: number;
  despawnRadius: number;
}

export const HUMAN_ENCOUNTERS: HumanEncounterDefinition[] = [
  {
    id: "military_base",
    archetype: "military",
    center: new Float32Array([822.4, 14, -2670.29, 1]),
    count: 5,
    activationRadius: 240,
    despawnRadius: 340
  },
  {
    id: "pleasant_valley_pd_west",
    archetype: "police",
    center: new Float32Array([-236, 22.2, -1155, 1]),
    count: 2,
    activationRadius: 140,
    despawnRadius: 220
  },
  {
    id: "pleasant_valley_pd_east",
    archetype: "police",
    center: new Float32Array([349, 31.6, -1157, 1]),
    count: 2,
    activationRadius: 140,
    despawnRadius: 220
  },
  {
    id: "cranberry_pd",
    archetype: "police",
    center: new Float32Array([-1382, 74.6, 1802, 1]),
    count: 2,
    activationRadius: 140,
    despawnRadius: 220
  },
  {
    id: "ranchito_pd",
    archetype: "police",
    center: new Float32Array([2169, 47.5, -992, 1]),
    count: 2,
    activationRadius: 140,
    despawnRadius: 220
  }
];

export class HumanEncounterManager {
  private readonly spawned = new Map<string, Set<string>>();
  private readonly respawnAt = new Map<string, number>();
  private lastTick = 0;

  tick(server: ZoneServer2016): void {
    const now = Date.now();
    if (!server._soloMode || now - this.lastTick < 2000) return;
    this.lastTick = now;
    const players = Object.values(server._characters).filter(
      (character) => character.isAlive
    );

    for (const encounter of HUMAN_ENCOUNTERS) {
      const nearby = players.some(
        (player) =>
          getDistance2d(player.state.position, encounter.center) <=
          encounter.activationRadius
      );
      const retained = players.some(
        (player) =>
          getDistance2d(player.state.position, encounter.center) <=
          encounter.despawnRadius
      );
      const ids = this.spawned.get(encounter.id);

      if (ids && !retained) {
        for (const characterId of ids) {
          if (server._npcs[characterId]) {
            server.deleteEntity(characterId, server._npcs);
          }
        }
        this.spawned.delete(encounter.id);
        continue;
      }
      if (ids) {
        const living = [...ids].some((id) => server._npcs[id]?.isAlive);
        if (!living && !this.respawnAt.has(encounter.id)) {
          this.respawnAt.set(encounter.id, now + 15 * 60 * 1000);
        }
        continue;
      }
      if (!nearby || (this.respawnAt.get(encounter.id) ?? 0) > now) continue;

      const spawnedIds = new Set<string>();
      for (let index = 0; index < encounter.count; index++) {
        const angle = (index / encounter.count) * Math.PI * 2;
        const radius = encounter.archetype === "military" ? 28 : 9;
        const candidate = new Float32Array([
          encounter.center[0] + Math.cos(angle) * radius,
          encounter.center[1],
          encounter.center[2] + Math.sin(angle) * radius,
          1
        ]);
        candidate[1] = server.getGroundInfo(candidate).selection.height;
        const modelId =
          index % 2 === 0
            ? ModelIds.SURVIVOR_MALE_HEAD_01
            : ModelIds.SURVIVAL_FEMALE_HEAD_01;
        const npc = server.worldObjectManager.createNpc(
          server,
          modelId,
          candidate,
          new Float32Array([0, 0, 0, 1]),
          0,
          undefined,
          encounter.archetype,
          encounter.center
        );
        spawnedIds.add(npc.characterId);
      }
      this.spawned.set(encounter.id, spawnedIds);
      this.respawnAt.delete(encounter.id);
    }
  }
}
