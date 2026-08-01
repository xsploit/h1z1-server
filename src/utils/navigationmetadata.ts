// ======================================================================
//
//   GNU GENERAL PUBLIC LICENSE
//   Version 3, 29 June 2007
//   copyright (C) 2021 - 2026 H1emu community
//
// ======================================================================

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type NavigationMetadataKind = "door" | "stairs";

export interface NavigationMetadataInstance {
  actorDefinition: string;
  kind: NavigationMetadataKind;
  instanceId: number;
  position: [number, number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number, number];
}

export interface NavigationMetadata {
  version: 1;
  coordinateSpace: "h1z1-world-y-up-meters";
  bakedDoorGeometryExcluded: boolean;
  instances: NavigationMetadataInstance[];
}

function isFiniteTuple(
  value: unknown
): value is [number, number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((component) => Number.isFinite(component))
  );
}

export function parseNavigationMetadata(value: unknown): NavigationMetadata {
  if (!value || typeof value !== "object") {
    throw new Error("navigation metadata must be an object");
  }
  const metadata = value as Record<string, unknown>;
  if (metadata.version !== 1) {
    throw new Error(
      `unsupported navigation metadata version: ${metadata.version}`
    );
  }
  if (metadata.coordinateSpace !== "h1z1-world-y-up-meters") {
    throw new Error(
      `unsupported navigation coordinate space: ${metadata.coordinateSpace}`
    );
  }
  if (typeof metadata.bakedDoorGeometryExcluded !== "boolean") {
    throw new Error("bakedDoorGeometryExcluded must be a boolean");
  }
  if (!Array.isArray(metadata.instances)) {
    throw new Error("navigation metadata instances must be an array");
  }

  const seen = new Set<string>();
  const instances = metadata.instances.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new Error(
        `navigation metadata instance ${index} must be an object`
      );
    }
    const instance = raw as Record<string, unknown>;
    if (typeof instance.actorDefinition !== "string") {
      throw new Error(
        `navigation metadata instance ${index} has no actorDefinition`
      );
    }
    if (instance.kind !== "door" && instance.kind !== "stairs") {
      throw new Error(`navigation metadata instance ${index} has invalid kind`);
    }
    if (!Number.isInteger(instance.instanceId)) {
      throw new Error(
        `navigation metadata instance ${index} has invalid instanceId`
      );
    }
    if (
      !isFiniteTuple(instance.position) ||
      !isFiniteTuple(instance.rotation) ||
      !isFiniteTuple(instance.scale)
    ) {
      throw new Error(
        `navigation metadata instance ${index} has invalid transform`
      );
    }

    const key = `${instance.kind}:${instance.actorDefinition}:${instance.instanceId}`;
    if (seen.has(key)) {
      throw new Error(`duplicate navigation metadata instance: ${key}`);
    }
    seen.add(key);

    return instance as unknown as NavigationMetadataInstance;
  });

  return {
    version: 1,
    coordinateSpace: "h1z1-world-y-up-meters",
    bakedDoorGeometryExcluded: metadata.bakedDoorGeometryExcluded,
    instances
  };
}

export function loadNavigationMetadata(
  path = join(__dirname, "..", "..", "data", "2016", "navigation_metadata.json")
): NavigationMetadata | null {
  if (!existsSync(path)) return null;
  return parseNavigationMetadata(JSON.parse(readFileSync(path, "utf8")));
}

export function shouldEnableDynamicDoorObstacles(
  metadata: NavigationMetadata | null,
  override = process.env.H1EMU_DYNAMIC_DOOR_OBSTACLES
): boolean {
  if (override === "0") return false;
  if (override === "1") return true;
  return metadata?.bakedDoorGeometryExcluded === true;
}
