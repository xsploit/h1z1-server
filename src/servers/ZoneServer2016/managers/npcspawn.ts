import { ModelIds } from "../models/enums";

interface NpcSpawnerInstance {
  id: number;
  position: number[];
  rotation: number[];
  count?: number;
}

interface NpcSpawnerType {
  actorDefinition: string;
  instances: NpcSpawnerInstance[];
}

export interface NpcSpawnCandidate {
  actorDefinition: string;
  instance: NpcSpawnerInstance;
  index: number;
}

export function getAuthorizedNpcModels(actorDefinition: string): number[] {
  switch (actorDefinition) {
    case "NPCSpawner_ZombieLazy.adr":
    case "NPCSpawner_ZombieWalker.adr":
      return [ModelIds.ZOMBIE_FEMALE_WALKER, ModelIds.ZOMBIE_MALE_WALKER];
    case "NPCSpawner_Deer001.adr":
      return [9002, 9253];
    case "NPCSpawner_Rabbit001.adr":
      return [ModelIds.RABBIT];
    case "NPCSpawner_Wolf001.adr":
      return [9003];
    case "Bear_Brown.adr":
      return [9187];
    default:
      return [];
  }
}

export function isZombieSpawner(actorDefinition: string): boolean {
  return (
    actorDefinition === "NPCSpawner_ZombieLazy.adr" ||
    actorDefinition === "NPCSpawner_ZombieWalker.adr"
  );
}

export function getNpcModelsForRoll(
  actorDefinition: string,
  chanceScreamer: number,
  roll: number
): number[] {
  const models = getAuthorizedNpcModels(actorDefinition);
  if (isZombieSpawner(actorDefinition) && roll <= chanceScreamer) {
    models.push(ModelIds.ZOMBIE_SCREAMER);
  }
  return models;
}

export function buildNpcSpawnCandidates(
  spawnerTypes: NpcSpawnerType[]
): NpcSpawnCandidate[] {
  const groups = spawnerTypes
    .filter((spawner) => getAuthorizedNpcModels(spawner.actorDefinition).length)
    .map((spawner) => {
      const candidates: NpcSpawnCandidate[] = [];
      for (const instance of spawner.instances) {
        const count = instance.count ?? 1;
        for (let index = 0; index < count; index++) {
          candidates.push({
            actorDefinition: spawner.actorDefinition,
            instance,
            index
          });
        }
      }
      return candidates;
    });

  return groups
    .flatMap((group) =>
      group.map((candidate, index) => ({
        candidate,
        progress: index / group.length
      }))
    )
    .sort((a, b) => a.progress - b.progress)
    .map(({ candidate }) => candidate);
}
