import { BasePlugin } from "@h1z1-server/out/servers/ZoneServer2016/managers/pluginmanager.js";
import type { HumanEncounterProfile } from "@h1z1-server/out/servers/ZoneServer2016/managers/humanencountermanager.js";
import type { ZoneServer2016 } from "@h1z1-server/out/servers/ZoneServer2016/zoneserver.js";
import type { ZoneClient2016 } from "@h1z1-server/out/servers/ZoneServer2016/classes/zoneclient.js";

interface SurvivorEncountersConfig {
  enabled: boolean;
  pveOrSoloOnly: boolean;
  respawnCheckSeconds: number;
  ambientBanditChancePercent: number;
  profiles: HumanEncounterProfile[];
}

const SOURCE_ID = "survivor-encounters";

export default class SurvivorEncountersPlugin extends BasePlugin {
  public name = "Survivor Encounters";
  public description =
    "Configurable human factions, POI defenders, and lightweight missions";
  public version = "0.1.0";
  private config!: SurvivorEncountersConfig;
  private nextSyncAt = 0;

  public commands = [
    {
      name: "encounters",
      description: "Show human encounter status",
      permissionLevel: 0,
      execute: (server: ZoneServer2016, client: ZoneClient2016) => {
        const statuses = server.humanEncounterManager.getStatus(SOURCE_ID);
        if (!statuses.length) {
          server.sendChatText(client, "[Encounters] No profiles registered.");
          return;
        }
        for (const status of statuses) {
          server.sendChatText(
            client,
            `[Encounters] ${status.label}: ${status.alive}/${status.total} alive ` +
              `(${status.role}, ${status.disposition})`
          );
        }
      }
    },
    {
      name: "mission",
      description: "Show the nearest encounter objective",
      permissionLevel: 0,
      execute: (server: ZoneServer2016, client: ZoneClient2016) => {
        const nearest = server.humanEncounterManager.getNearestStatus(
          SOURCE_ID,
          client.character.state.position
        );
        if (!nearest) {
          server.sendChatText(client, "[Mission] No encounter is available.");
          return;
        }
        const objective =
          nearest.disposition === "bandit" ? "Clear" : "Defend or reinforce";
        server.sendChatText(
          client,
          `[Mission] ${objective} ${nearest.label} - ${nearest.alive}/${nearest.total} alive, ` +
            `${Math.round(nearest.distance)}m away.`
        );
      }
    },
    {
      name: "encounter",
      description: "Admin: status, sync, reset, or despawn encounter profiles",
      permissionLevel: 2,
      execute: (
        server: ZoneServer2016,
        client: ZoneClient2016,
        args: string[]
      ) => {
        const action = args[0] ?? "status";
        const profileId = args[1] ?? "all";
        try {
          if (action === "sync") {
            const result = server.humanEncounterManager.sync(
              SOURCE_ID,
              profileId
            );
            server.sendChatText(
              client,
              `[Encounters] created=${result.created}, existing=${result.existing}, ` +
                `corpses=${result.pendingCorpses}, failed=${result.failed}`
            );
            return;
          }
          if (action === "despawn") {
            const removed = server.humanEncounterManager.despawn(
              SOURCE_ID,
              profileId
            );
            server.sendChatText(client, `[Encounters] despawned ${removed}.`);
            return;
          }
          if (action === "reset") {
            const removed = server.humanEncounterManager.despawn(
              SOURCE_ID,
              profileId
            );
            const result = server.humanEncounterManager.sync(
              SOURCE_ID,
              profileId
            );
            server.sendChatText(
              client,
              `[Encounters] reset ${profileId}: removed=${removed}, created=${result.created}, failed=${result.failed}`
            );
            return;
          }
          if (action === "status") {
            this.commands[0].execute(server, client, []);
            return;
          }
          server.sendChatText(
            client,
            "[Encounters] Usage: /encounter <status|sync|reset|despawn> [profile|all]"
          );
        } catch (error) {
          server.sendChatText(client, `[Encounters] ${String(error)}`);
        }
      }
    }
  ];

  public loadConfig(config: SurvivorEncountersConfig): void {
    this.config = config;
  }

  public async init(server: ZoneServer2016): Promise<void> {
    if (!server.humanEncounterManager) return;
    const percent = Number(this.config.ambientBanditChancePercent);
    if (Number.isFinite(percent)) {
      process.env.HOSTILE_SURVIVOR_CHANCE_PER_THOUSAND = String(
        Math.round(Math.max(0, Math.min(100, percent)) * 10)
      );
    }
    server.humanEncounterManager.registerSource(
      SOURCE_ID,
      this.config.profiles
    );
    if (!this.shouldRun(server)) return;

    const result = server.humanEncounterManager.sync(SOURCE_ID);
    console.info(
      `[Survivor Encounters] initial sync created=${result.created}, existing=${result.existing}, failed=${result.failed}`
    );
    this.nextSyncAt = Date.now() + this.getRespawnIntervalMs();
    server.hookManager.hook("OnWorldRoutine", () => {
      if (Date.now() < this.nextSyncAt) return;
      this.nextSyncAt = Date.now() + this.getRespawnIntervalMs();
      server.humanEncounterManager.sync(SOURCE_ID);
    });
  }

  private shouldRun(server: ZoneServer2016): boolean {
    if (!this.config.enabled) return false;
    return !this.config.pveOrSoloOnly || server._soloMode || server.isPvE;
  }

  private getRespawnIntervalMs(): number {
    const seconds = Number(this.config.respawnCheckSeconds);
    return Math.max(10, Number.isFinite(seconds) ? seconds : 60) * 1000;
  }
}
