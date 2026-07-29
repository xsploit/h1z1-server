import { ZoneClient2016 } from "../classes/zoneclient";
import { createZombie } from "../jsms/zombie.jsm";
import { Factions } from "../jsms/factions";
import {
  Effects,
  Items,
  LoadoutIds,
  MaterialTypes,
  NpcIds,
  StringIds
} from "../models/enums";
import { ZoneServer2016 } from "../zoneserver";
import { getDistance, randomIntFromInterval } from "../../../utils/utils";
import { DamageInfo } from "../../../types/zoneserver";
import { Npc } from "./npc";

export interface BanditWeaponKit {
  itemDefinitionId: Items;
  attackRange: number;
  attackCooldownSeconds: number;
  soundRadius: number;
}

export type HumanNpcDisposition = "bandit" | "survivor";

const BANDIT_WEAPON_KITS: BanditWeaponKit[] = [
  {
    itemDefinitionId: Items.WEAPON_R380,
    attackRange: 24,
    attackCooldownSeconds: 0.9,
    soundRadius: 60
  },
  {
    itemDefinitionId: Items.WEAPON_M9,
    attackRange: 28,
    attackCooldownSeconds: 0.75,
    soundRadius: 75
  },
  {
    itemDefinitionId: Items.WEAPON_AR15,
    attackRange: 35,
    attackCooldownSeconds: 0.55,
    soundRadius: 100
  }
];

export function selectBanditWeaponKit(
  randomValue: number = Math.random()
): BanditWeaponKit {
  if (randomValue < 0.35) return BANDIT_WEAPON_KITS[0];
  if (randomValue < 0.8) return BANDIT_WEAPON_KITS[1];
  return BANDIT_WEAPON_KITS[2];
}

export function getBanditHitChance(distance: number): number {
  return Math.max(0.18, Math.min(0.72, 0.72 - distance * 0.014));
}

function randomItem(items: Items[]): Items {
  return items[Math.floor(Math.random() * items.length)];
}

export class HostileSurvivor extends Npc {
  private readonly weaponKit: BanditWeaponKit;
  private reloadReadyAt = 0;
  private shotSequence = 0;

  constructor(
    characterId: string,
    transientId: number,
    actorModelId: number,
    position: Float32Array,
    rotation: Float32Array,
    server: ZoneServer2016,
    spawnerId: number = 0,
    disposition: HumanNpcDisposition = "bandit"
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
    this.faction =
      disposition === "survivor" ? Factions.SURVIVOR : Factions.BANDIT;
    this.loadoutId = LoadoutIds.CHARACTER;
    this.usesPlayerReplication = true;
    this.playerName = disposition === "survivor" ? "Survivor" : "Raider";
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
    this.weaponKit = selectBanditWeaponKit();

    for (const itemDefinitionId of [
      randomItem([
        Items.SHIRT_DEFAULT,
        Items.BLUE_FLANNEL_SHIRT,
        Items.BROWN_FLANNEL_SHIRT,
        Items.GREEN_FLANNEL_SHIRT,
        Items.RED_FLANNEL_SHIRT
      ]),
      randomItem([Items.PANTS_DEFAULT, Items.POLICE_SLACKS]),
      randomItem([Items.BOOTS_TAN, Items.BOOTS_GRAY_BLUE]),
      randomItem([
        Items.BACKPACK_BLUE_ORANGE,
        Items.BACKPACK_MILITARY_TAN,
        Items.BACKPACK_MILITARY_GREEN_CAMO
      ])
    ]) {
      this.equipItem(server, server.generateItem(itemDefinitionId), false);
    }

    const knife = server.generateItem(Items.WEAPON_COMBATKNIFE, 1, true);
    if (knife) {
      this.equipItem(
        server,
        knife,
        false,
        server.getLoadoutSlot(knife.itemDefinitionId)
      );
    }

    const firearm = server.generateItem(
      this.weaponKit.itemDefinitionId,
      1,
      true
    );
    if (firearm) {
      this.currentLoadoutSlot = server.getLoadoutSlot(firearm.itemDefinitionId);
      this.equipItem(server, firearm, false, this.currentLoadoutSlot);
      if (firearm.weapon) {
        firearm.weapon.ammoCount = server.getWeaponMaxAmmo(
          firearm.itemDefinitionId
        );
      }
    }

    if (!process.env.DISABLE_AI && server.aiEnabled) {
      this.fsm = createZombie(this, server, {
        canFeed: false,
        detectionRange: 55,
        attackRange: this.weaponKit.attackRange,
        attackImpactSeconds: 0.12,
        attackRecoverySeconds: 0.3,
        attackCooldownSeconds: this.weaponKit.attackCooldownSeconds,
        attackImmediatelyOnReach: false,
        attackImmediatelyAfterRecovery: false,
        playAttackAnimation: false,
        canAttackTarget: (targetCharacterId) =>
          this.canShootTarget(targetCharacterId),
        performAttack: (targetCharacterId) =>
          this.fireRangedWeapon(targetCharacterId)
      });
    }
  }

  private getShotOrigin(): Float32Array {
    return new Float32Array([
      this.state.position[0],
      this.state.position[1] + 1.45,
      this.state.position[2],
      1
    ]);
  }

  private getTargetChest(targetCharacterId: string): Float32Array | undefined {
    const target =
      this.server._characters[targetCharacterId] ??
      this.server._npcs[targetCharacterId];
    if (!target?.isAlive) return;
    return new Float32Array([
      target.state.position[0],
      target.state.position[1] + 1.15,
      target.state.position[2],
      1
    ]);
  }

  private canShootTarget(targetCharacterId: string): boolean {
    const targetChest = this.getTargetChest(targetCharacterId);
    if (!targetChest) return false;
    return !this.server.collisionManager.segmentBlocked(
      this.getShotOrigin(),
      targetChest
    );
  }

  private sendWeaponUpdate(
    weaponGuid: string,
    packetName:
      | "Update.Chamber"
      | "Update.FireState"
      | "Update.ProjectileLaunch"
      | "Update.Reload"
      | "Update.ReloadLoopEnd",
    packet: object
  ): void {
    this.server.sendRemoteWeaponUpdateDataToAllWithSpawnedEntity(
      this.server._npcs,
      this.characterId,
      this.transientId,
      weaponGuid,
      packetName,
      packet
    );
  }

  private fireRangedWeapon(targetCharacterId: string): void {
    const target =
        this.server._characters[targetCharacterId] ??
        this.server._npcs[targetCharacterId],
      targetChest = this.getTargetChest(targetCharacterId),
      firearm = this.getEquippedWeapon();
    if (!target?.isAlive || !targetChest || !firearm?.weapon) return;
    if (
      this.server.collisionManager.segmentBlocked(
        this.getShotOrigin(),
        targetChest
      )
    )
      return;

    const now = Date.now();
    if (this.reloadReadyAt > now) return;
    if (this.reloadReadyAt) {
      firearm.weapon.ammoCount = this.server.getWeaponMaxAmmo(
        firearm.itemDefinitionId
      );
      this.reloadReadyAt = 0;
      this.sendWeaponUpdate(firearm.itemGuid, "Update.ReloadLoopEnd", {
        endLoop: true
      });
    }
    if (firearm.weapon.ammoCount <= 0) {
      this.sendWeaponUpdate(firearm.itemGuid, "Update.FireState", {
        state: {
          firestate: 0,
          transientId: this.transientId,
          position: this.state.position
        }
      });
      this.sendWeaponUpdate(firearm.itemGuid, "Update.Reload", {});
      this.reloadReadyAt =
        now + this.server.getWeaponReloadTime(firearm.itemDefinitionId);
      return;
    }

    this.lookAt(target.state.position);
    this.sendWeaponUpdate(firearm.itemGuid, "Update.Chamber", {});
    this.sendWeaponUpdate(firearm.itemGuid, "Update.FireState", {
      state: {
        firestate: 1,
        transientId: this.transientId,
        position: this.state.position
      }
    });
    this.sendWeaponUpdate(firearm.itemGuid, "Update.ProjectileLaunch", {});
    firearm.weapon.ammoCount--;
    this.server.pushSound({
      position: this.state.position,
      radius: this.weaponKit.soundRadius,
      agitation: 50
    });

    setTimeout(() => {
      if (!this.server._npcs[this.characterId]) return;
      this.sendWeaponUpdate(firearm.itemGuid, "Update.FireState", {
        state: {
          firestate: 0,
          transientId: this.transientId,
          position: this.state.position
        }
      });
    }, 80);

    const distance = getDistance(this.state.position, target.state.position);
    if (Math.random() >= getBanditHitChance(distance)) return;

    const damageInfo: DamageInfo = {
      entity: this.characterId,
      weapon: firearm.itemDefinitionId,
      damage: this.server.getProjectileDamage(
        firearm.itemDefinitionId,
        this.state.position,
        target.state.position
      ),
      causeBleed: true,
      hitReport: {
        sessionProjectileCount: ++this.shotSequence,
        characterId: target.characterId,
        position: target.state.position,
        unknownFlag1: 0,
        unknownByte2: 0,
        totalShotCount: this.shotSequence,
        hitLocation: "CHEST"
      }
    };

    const targetClient = this.server.getClientByCharId(targetCharacterId),
      mountedVehicle = targetClient?.vehicle.mountedVehicle
        ? this.server._vehicles[targetClient.vehicle.mountedVehicle]
        : undefined;
    if (mountedVehicle) {
      mountedVehicle.damage(this.server, damageInfo);
      return;
    }
    target.OnProjectileHit(this.server, damageInfo);
  }

  protected addLoot(server: ZoneServer2016): void {
    const ammoItemDefinitionId = server.getWeaponAmmoId(
      this.weaponKit.itemDefinitionId
    );
    const supplies = [
      ammoItemDefinitionId
        ? server.generateItem(
            ammoItemDefinitionId,
            server.getWeaponMaxAmmo(this.weaponKit.itemDefinitionId)
          )
        : undefined,
      server.generateItem(Items.CLOTH, randomIntFromInterval(1, 3)),
      server.generateItem(Items.BANDAGE_DRESSED, randomIntFromInterval(1, 3))
    ].filter((item) => item != null);

    for (const item of supplies) {
      this.lootContainerItem(server, item, item.stackCount, false);
    }
    server.worldObjectManager.createLootbag(server, this);
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
