import { getDistance2d } from "../../../utils/utils";
import { NavManager } from "../../../utils/recast";
import type { Npc } from "../entities/npc";
import type { ZoneServer2016 } from "../zoneserver";
import { isHostile } from "./factions";
import { JSM } from "./jsm";

export const enum HumanTransitions {
  Patrol = "patrol",
  Engage = "engage"
}

const enum HumanEvents {
  TargetFound = "targetFound",
  TargetLost = "targetLost"
}

export interface HumanoidAiOptions {
  homePosition?: Float32Array;
  patrolRadius?: number;
  leashRadius?: number;
  detectionRange?: number;
  attackRange: number;
  minimumRange?: number;
  attackCooldownSeconds: number;
  reactionSeconds?: number;
  canAttackTarget: (targetCharacterId: string) => boolean;
  performAttack: (targetCharacterId: string) => void;
}

function getTarget(server: ZoneServer2016, characterId: string | null) {
  if (!characterId) return;
  return server._characters[characterId] ?? server._npcs[characterId];
}

function findNearestHostile(
  npc: Npc,
  server: ZoneServer2016,
  detectionRange: number
): string | null {
  const cellSize = 50;
  const x = Math.floor(npc.state.position[0] / cellSize);
  const z = Math.floor(npc.state.position[2] / cellSize);
  let nearestId: string | null = null;
  let nearestDistance = detectionRange;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const bucket = server.aiTargetSpatialMap.get(`${x + dx},${z + dz}`);
      if (!bucket) continue;
      for (const entry of bucket) {
        if (
          entry.id === npc.characterId ||
          !isHostile(npc.faction, entry.faction)
        )
          continue;
        const distance = getDistance2d(npc.state.position, entry.position);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestId = entry.id;
        }
      }
    }
  }
  return nearestId;
}

function pickNavPoint(
  server: ZoneServer2016,
  center: Float32Array,
  radius: number
): Float32Array | null {
  const result = server.navManager.navMeshQuery.findRandomPointAroundCircle(
    NavManager.gameToNav(center),
    radius
  );
  return result.success ? NavManager.navToGame(result.randomPoint) : null;
}

export function createHumanoid(
  npc: Npc,
  server: ZoneServer2016,
  options: HumanoidAiOptions
): JSM<HumanEvents> {
  const home =
    options.homePosition?.slice() ??
    (npc.state.position.slice() as Float32Array);
  const patrolRadius = options.patrolRadius ?? 35;
  const leashRadius = options.leashRadius ?? 90;
  const detectionRange = options.detectionRange ?? 55;
  const minimumRange = options.minimumRange ?? 8;
  const reactionSeconds = options.reactionSeconds ?? 0.65;
  let targetCharacterId: string | null = null;
  let stateTimer = 0;
  let attackTimer = 0;
  let repositionTimer = 0;

  const moveToFlank = (targetPosition: Float32Array, radius = 12) => {
    const point = pickNavPoint(server, targetPosition, radius);
    if (point) {
      npc.setSpeed(3.2);
      npc.goTo(point);
    }
  };

  const ai = new JSM<HumanEvents>(
    {
      [HumanTransitions.Patrol]: (dt) => {
        stateTimer += dt;
        targetCharacterId = findNearestHostile(npc, server, detectionRange);
        if (targetCharacterId) {
          ai.event(HumanEvents.TargetFound);
          return;
        }
        if (stateTimer >= 5) {
          stateTimer = 0;
          const patrolPoint = pickNavPoint(server, home, patrolRadius);
          if (patrolPoint) {
            npc.setSpeed(1.8);
            npc.goTo(patrolPoint);
          }
        }
      },
      [HumanTransitions.Engage]: (dt) => {
        stateTimer += dt;
        attackTimer += dt;
        repositionTimer += dt;
        const target = getTarget(server, targetCharacterId);
        if (
          !target?.isAlive ||
          getDistance2d(home, npc.state.position) > leashRadius ||
          getDistance2d(npc.state.position, target?.state.position ?? home) >
            detectionRange * 1.5
        ) {
          ai.event(HumanEvents.TargetLost);
          return;
        }

        const distance = getDistance2d(
          npc.state.position,
          target.state.position
        );
        const hasLineOfSight = options.canAttackTarget(target.characterId);
        npc.lookAt(target.state.position);

        if (!hasLineOfSight || distance < minimumRange) {
          if (repositionTimer >= 0.8) {
            repositionTimer = 0;
            moveToFlank(
              target.state.position,
              distance < minimumRange ? 18 : 12
            );
          }
          return;
        }
        if (distance > options.attackRange * 0.8) {
          npc.setSpeed(3.2);
          npc.goTo(target.state.position);
          return;
        }

        npc.stopMovement();
        if (repositionTimer >= 3.5) {
          repositionTimer = 0;
          moveToFlank(target.state.position, 10);
          return;
        }
        if (
          stateTimer >= reactionSeconds &&
          attackTimer >= options.attackCooldownSeconds
        ) {
          attackTimer = 0;
          options.performAttack(target.characterId);
        }
      }
    },
    [
      {
        eventId: HumanEvents.TargetFound,
        from: [HumanTransitions.Patrol],
        to: HumanTransitions.Engage,
        EnterTransition: () => {
          stateTimer = 0;
          attackTimer = 0;
          repositionTimer = 0;
        }
      },
      {
        eventId: HumanEvents.TargetLost,
        from: [HumanTransitions.Engage],
        to: HumanTransitions.Patrol,
        EnterTransition: () => {
          targetCharacterId = null;
          stateTimer = 5;
          npc.lookAtTarget = null;
        }
      }
    ],
    HumanTransitions.Patrol
  );

  return ai;
}
