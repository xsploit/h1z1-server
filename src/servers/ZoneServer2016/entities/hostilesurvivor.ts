import { ZoneClient2016 } from "../classes/zoneclient";
import { LoadoutContainer } from "../classes/loadoutcontainer";
import { createZombie } from "../jsms/zombie.jsm";
import { Factions } from "../jsms/factions";
import {
  Effects,
  Items,
  LoadoutIds,
  MaterialTypes,
  ModelIds,
  NpcIds,
  StringIds
} from "../models/enums";
import { ZoneServer2016 } from "../zoneserver";
import {
  generateRandomGuid,
  randomIntFromInterval
} from "../../../utils/utils";
import { Lootbag } from "./lootbag";
import { Npc } from "./npc";

export class HostileSurvivor extends Npc {
  constructor(
    characterId: string,
    transientId: number,
    actorModelId: number,
    position: Float32Array,
    rotation: Float32Array,
    server: ZoneServer2016,
    spawnerId: number = 0
  ) {
    super(
      characterId,
      transientId,
      actorModelId,
      position,
      rotation,
      server,
      spawnerId
    );
    this.materialType = MaterialTypes.FLESH;
    this.npcId = NpcIds.SURVIVOR;
    this.faction = Factions.BANDIT;
    this.loadoutId = LoadoutIds.CHARACTER;
    this.usesPlayerReplication = true;
    this.playerName = "Raider";
    this.movementStance = 66561;
    this.stationaryStance = 1089;
    this.npcMeleeDamage = 1400;
    this.npcMeleeWeapon = Items.WEAPON_COMBATKNIFE;
    this.npcMeleeEffect = Effects.MAT_Knife_ForehandSlash;
    this.npcMeleeTrace = {
      reach: 1.35,
      halfArcDegrees: 55,
      verticalTolerance: 1.25
    };
    this.infectsTargetOnMelee = false;

    for (const itemDefinitionId of [
      Items.SHIRT_DEFAULT,
      Items.PANTS_DEFAULT,
      Items.BOOTS_TAN,
      Items.BACKPACK_BLUE_ORANGE
    ]) {
      this.equipItem(server, server.generateItem(itemDefinitionId), false);
    }

    const weapon = server.generateItem(Items.WEAPON_COMBATKNIFE, 1, true);
    if (weapon) {
      this.currentLoadoutSlot = server.getLoadoutSlot(weapon.itemDefinitionId);
      this.equipItem(server, weapon, false, this.currentLoadoutSlot);
    }

    if (!process.env.DISABLE_AI && server.aiEnabled) {
      this.fsm = createZombie(this, server, {
        canFeed: false,
        detectionRange: 20,
        attackRange: 1.35,
        attackAnimation: "OneHandForehandSlashRight"
      });
    }
  }

  protected addLoot(server: ZoneServer2016): void {
    const lootItems = [
      server.generateItem(Items.WEAPON_COMBATKNIFE, 1, true),
      server.generateItem(Items.CLOTH, randomIntFromInterval(1, 3)),
      server.generateItem(Items.BANDAGE_DRESSED, randomIntFromInterval(1, 3))
    ].filter((item) => item != null);

    const characterId = generateRandomGuid();
    const lootbag = new Lootbag(
      characterId,
      server.getTransientId(characterId),
      ModelIds.LOOT_BAG_CLEAN,
      new Float32Array([
        this.state.position[0] + 0.7,
        this.state.position[1],
        this.state.position[2] + 0.7
      ]),
      new Float32Array([0, 0, 0, 0]),
      server
    );
    const container = lootbag.getContainer() as LoadoutContainer;
    for (const item of lootItems) {
      server.addContainerItem(lootbag, item, container);
    }
    server._lootbags[characterId] = lootbag;
  }

  protected onHarvest(server: ZoneServer2016, client: ZoneClient2016): void {
    client.character.lootContainerItem(
      server,
      server.generateItem(Items.CLOTH, randomIntFromInterval(1, 2))
    );
  }

  protected buildInteractionString(
    server: ZoneServer2016,
    client: ZoneClient2016
  ): void {
    this.sendInteractionString(server, client, StringIds.HARVEST);
  }
}
