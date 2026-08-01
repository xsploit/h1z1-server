// ======================================================================
//
//   GNU GENERAL PUBLIC LICENSE
//   Version 3, 29 June 2007
//   copyright (C) 2021 - 2026 H1emu community
//
// ======================================================================

import type { ZoneServer2016 } from "../zoneserver";
import type {
  HumanNpcDisposition,
  HumanNpcRole
} from "../entities/hostilesurvivor";
import { ModelIds } from "../models/enums";

export type HumanEncounterPosition = [number, number, number, number];

export interface HumanEncounterProfile {
  id: string;
  label: string;
  disposition: HumanNpcDisposition;
  role: HumanNpcRole;
  spawnerBaseId: number;
  positions: HumanEncounterPosition[];
}

export interface HumanEncounterStatus {
  sourceId: string;
  profileId: string;
  label: string;
  disposition: HumanNpcDisposition;
  role: HumanNpcRole;
  alive: number;
  present: number;
  total: number;
}

export interface HumanEncounterSyncResult {
  created: number;
  existing: number;
  pendingCorpses: number;
  failed: number;
}

interface HumanEncounterSlot extends Omit<HumanEncounterProfile, "positions"> {
  sourceId: string;
  slot: number;
  spawnerId: number;
  position: HumanEncounterPosition;
}

function assertFinitePosition(
  position: HumanEncounterPosition,
  context: string
): void {
  if (
    !Array.isArray(position) ||
    position.length !== 4 ||
    !position.every((component) => Number.isFinite(component))
  ) {
    throw new Error(`${context} has an invalid world position`);
  }
}

export function compileHumanEncounterSlots(
  sourceId: string,
  profiles: HumanEncounterProfile[]
): HumanEncounterSlot[] {
  if (!sourceId.trim()) throw new Error("encounter sourceId cannot be empty");
  const profileIds = new Set<string>();
  const spawnerIds = new Set<number>();
  const slots: HumanEncounterSlot[] = [];

  for (const profile of profiles) {
    if (!profile.id.trim())
      throw new Error("encounter profile id cannot be empty");
    if (profileIds.has(profile.id)) {
      throw new Error(`duplicate encounter profile id: ${profile.id}`);
    }
    profileIds.add(profile.id);
    if (
      !Number.isSafeInteger(profile.spawnerBaseId) ||
      profile.spawnerBaseId <= 0
    ) {
      throw new Error(`${profile.id} has an invalid spawnerBaseId`);
    }
    if (!profile.positions.length) {
      throw new Error(`${profile.id} has no spawn positions`);
    }

    profile.positions.forEach((position, slot) => {
      assertFinitePosition(position, `${profile.id} slot ${slot}`);
      const spawnerId = profile.spawnerBaseId + slot;
      if (spawnerIds.has(spawnerId)) {
        throw new Error(`duplicate encounter spawnerId: ${spawnerId}`);
      }
      spawnerIds.add(spawnerId);
      slots.push({
        id: profile.id,
        label: profile.label,
        disposition: profile.disposition,
        role: profile.role,
        spawnerBaseId: profile.spawnerBaseId,
        sourceId,
        slot,
        spawnerId,
        position
      });
    });
  }

  return slots;
}

export class HumanEncounterManager {
  private readonly sources = new Map<string, HumanEncounterSlot[]>();

  constructor(private readonly server: ZoneServer2016) {}

  registerSource(sourceId: string, profiles: HumanEncounterProfile[]): void {
    const slots = compileHumanEncounterSlots(sourceId, profiles);
    const incomingIds = new Set(slots.map(({ spawnerId }) => spawnerId));
    for (const [registeredSource, registeredSlots] of this.sources) {
      if (registeredSource === sourceId) continue;
      for (const slot of registeredSlots) {
        if (incomingIds.has(slot.spawnerId)) {
          throw new Error(
            `encounter spawnerId ${slot.spawnerId} is already owned by ${registeredSource}`
          );
        }
      }
    }
    this.sources.set(sourceId, slots);
  }

  unregisterSource(sourceId: string): void {
    this.sources.delete(sourceId);
  }

  sync(sourceId: string, profileId?: string): HumanEncounterSyncResult {
    const slots = this.getSlots(sourceId, profileId);
    const result: HumanEncounterSyncResult = {
      created: 0,
      existing: 0,
      pendingCorpses: 0,
      failed: 0
    };

    for (const slot of slots) {
      const existingCharacterId =
        this.server.worldObjectManager.spawnedNpcs[slot.spawnerId];
      const existing = existingCharacterId
        ? this.server._npcs[existingCharacterId]
        : undefined;
      if (existing) {
        result.existing++;
        if (!existing.isAlive) result.pendingCorpses++;
        continue;
      }

      const anchor = new Float32Array(slot.position);
      const nearest = this.server.navManager.getClosestNavPointVec3(anchor);
      const navSnapDistance = nearest
        ? Math.hypot(nearest.x - anchor[0], nearest.z - anchor[2])
        : Number.POSITIVE_INFINITY;
      const position =
        nearest &&
        Math.abs(nearest.y - anchor[1]) <= 1.5 &&
        navSnapDistance <= 2.5
          ? new Float32Array([nearest.x, nearest.y, nearest.z, 1])
          : anchor;
      const modelId =
        slot.slot % 2 === 0
          ? ModelIds.SURVIVOR_MALE_HEAD_01
          : ModelIds.SURVIVAL_FEMALE_HEAD_01;

      try {
        this.server.worldObjectManager.createNpc(
          this.server,
          modelId,
          position,
          new Float32Array([0, 0, 0, 1]),
          slot.spawnerId,
          undefined,
          slot.disposition,
          slot.role
        );
        console.info(
          `[Encounter:${sourceId}] ${slot.label} #${slot.slot + 1} ` +
            `role=${slot.role} at ${position[0].toFixed(1)},${position[1].toFixed(1)},${position[2].toFixed(1)}`
        );
        result.created++;
      } catch (error) {
        result.failed++;
        console.error(
          `[Encounter:${sourceId}] failed to spawn ${slot.id} #${slot.slot + 1}: ${error}`
        );
      }
    }

    return result;
  }

  despawn(sourceId: string, profileId?: string): number {
    let removed = 0;
    for (const slot of this.getSlots(sourceId, profileId)) {
      const characterId =
        this.server.worldObjectManager.spawnedNpcs[slot.spawnerId];
      if (!characterId) continue;
      if (this.server.deleteEntity(characterId, this.server._npcs)) removed++;
      delete this.server.worldObjectManager.spawnedNpcs[slot.spawnerId];
    }
    return removed;
  }

  getStatus(sourceId?: string): HumanEncounterStatus[] {
    const entries = sourceId
      ? [[sourceId, this.sources.get(sourceId) ?? []] as const]
      : [...this.sources.entries()];
    const status: HumanEncounterStatus[] = [];

    for (const [registeredSource, slots] of entries) {
      const byProfile = new Map<string, HumanEncounterSlot[]>();
      for (const slot of slots) {
        const profileSlots = byProfile.get(slot.id) ?? [];
        profileSlots.push(slot);
        byProfile.set(slot.id, profileSlots);
      }
      for (const [profileId, profileSlots] of byProfile) {
        const first = profileSlots[0];
        let present = 0;
        let alive = 0;
        for (const slot of profileSlots) {
          const characterId =
            this.server.worldObjectManager.spawnedNpcs[slot.spawnerId];
          const npc = characterId ? this.server._npcs[characterId] : undefined;
          if (!npc) continue;
          present++;
          if (npc.isAlive) alive++;
        }
        status.push({
          sourceId: registeredSource,
          profileId,
          label: first.label,
          disposition: first.disposition,
          role: first.role,
          alive,
          present,
          total: profileSlots.length
        });
      }
    }

    return status;
  }

  getNearestStatus(
    sourceId: string,
    position: Float32Array
  ): (HumanEncounterStatus & { distance: number }) | undefined {
    const slots = this.sources.get(sourceId) ?? [];
    let nearest: HumanEncounterSlot | undefined;
    let distance = Number.POSITIVE_INFINITY;
    for (const slot of slots) {
      const candidate = Math.hypot(
        slot.position[0] - position[0],
        slot.position[2] - position[2]
      );
      if (candidate < distance) {
        nearest = slot;
        distance = candidate;
      }
    }
    if (!nearest) return;
    const status = this.getStatus(sourceId).find(
      ({ profileId }) => profileId === nearest?.id
    );
    return status ? { ...status, distance } : undefined;
  }

  private getSlots(sourceId: string, profileId?: string): HumanEncounterSlot[] {
    const slots = this.sources.get(sourceId);
    if (!slots)
      throw new Error(`encounter source is not registered: ${sourceId}`);
    if (!profileId || profileId === "all") return slots;
    const filtered = slots.filter(({ id }) => id === profileId);
    if (!filtered.length) {
      throw new Error(`unknown encounter profile: ${profileId}`);
    }
    return filtered;
  }
}
