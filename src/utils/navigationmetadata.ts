// ======================================================================
//
//   GNU GENERAL PUBLIC LICENSE
//   Version 3, 29 June 2007
//   copyright (C) 2021 - 2026 H1emu community
//
// ======================================================================

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NAVIGATION_SEMANTIC_SCHEMA_VERSION,
  NavigationSemantic,
  NavigationSemanticName
} from "./navigationareas";

export type NavigationMetadataKind = "door" | "stairs" | "ramp" | "threshold";

export interface NavigationMetadataInstance {
  actorDefinition: string;
  kind: NavigationMetadataKind;
  objectName?: string;
  semantic?: NavigationSemanticName;
  classificationSource?: string;
  geometrySource?: string;
  geometryAsset?: string | null;
  instanceId: number;
  position: [number, number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number, number];
}

export interface NavigationMetadata {
  version: 1 | 2;
  semanticSchemaVersion?: number;
  semanticMode?: "strict" | "legacy";
  canonicalMaterials?: NavigationSemanticName[];
  coordinateSpace: "h1z1-world-y-up-meters";
  bakedDoorGeometryExcluded: boolean;
  instances: NavigationMetadataInstance[];
}

const NAVIGATION_METADATA_KINDS = new Set<NavigationMetadataKind>([
  "door",
  "stairs",
  "ramp",
  "threshold"
]);
const CANONICAL_NAVIGATION_MATERIALS = new Set<NavigationSemanticName>(
  Object.values(NavigationSemantic)
);

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
  if (metadata.version !== 1 && metadata.version !== 2) {
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
  if (metadata.version === 2) {
    if (
      metadata.semanticSchemaVersion !== NAVIGATION_SEMANTIC_SCHEMA_VERSION ||
      (metadata.semanticMode !== "strict" &&
        metadata.semanticMode !== "legacy") ||
      !Array.isArray(metadata.canonicalMaterials) ||
      metadata.canonicalMaterials.length !==
        CANONICAL_NAVIGATION_MATERIALS.size ||
      new Set(metadata.canonicalMaterials).size !==
        CANONICAL_NAVIGATION_MATERIALS.size ||
      metadata.canonicalMaterials.some(
        (material) =>
          typeof material !== "string" ||
          !CANONICAL_NAVIGATION_MATERIALS.has(
            material as NavigationSemanticName
          )
      )
    ) {
      throw new Error("navigation metadata semantic contract is invalid");
    }
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
    if (
      !NAVIGATION_METADATA_KINDS.has(instance.kind as NavigationMetadataKind)
    ) {
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
    if (
      metadata.version === 2 &&
      (typeof instance.objectName !== "string" ||
        !instance.objectName ||
        typeof instance.semantic !== "string" ||
        !CANONICAL_NAVIGATION_MATERIALS.has(
          instance.semantic as NavigationSemanticName
        ) ||
        typeof instance.classificationSource !== "string" ||
        !instance.classificationSource ||
        typeof instance.geometrySource !== "string" ||
        !instance.geometrySource ||
        (instance.geometryAsset !== null &&
          typeof instance.geometryAsset !== "string"))
    ) {
      throw new Error(
        `navigation metadata instance ${index} has invalid semantic provenance`
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
    version: metadata.version,
    semanticSchemaVersion:
      metadata.version === 2
        ? (metadata.semanticSchemaVersion as number)
        : undefined,
    semanticMode:
      metadata.version === 2
        ? (metadata.semanticMode as "strict" | "legacy")
        : undefined,
    canonicalMaterials:
      metadata.version === 2
        ? (metadata.canonicalMaterials as NavigationSemanticName[])
        : undefined,
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
  if (override !== "1") return false;
  return metadata?.bakedDoorGeometryExcluded === true;
}
