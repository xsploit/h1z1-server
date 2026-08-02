// Compose a bounded navigation source without stacking render geometry on top
// of the collision-first world.  The collision source owns every obstacle and
// door. A reviewed render source may replace one exact collision object with
// one exact render object inside explicit evidence bounds. Exact object identity,
// not rectangle partitioning, is the authority seam, so distinct actor AABBs may
// overlap without deleting or duplicating geometry.
"use strict";

const { createHash } = require("node:crypto");
const {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
  writeSync
} = require("node:fs");
const { basename, dirname, resolve } = require("node:path");
const { createInterface } = require("node:readline");

const POLICY_SCHEMA = "h1emu-regional-hybrid-policy-v1";
const REPORT_SCHEMA = "h1emu-regional-hybrid-nav-source-v1";
const BASE_REPORT_SCHEMA = "h1emu-collision-semantic-obj-v1";
const SEMANTIC_CONTRACT = "h1emu-nav-semantics-v1";
const COORDINATE_SPACE = "h1z1-world-y-up-meters";
const EPSILON = 1e-7;

const WALKABLE_MATERIALS = new Set([
  "nav_terrain",
  "nav_road",
  "nav_floor_exterior",
  "nav_floor_interior",
  "nav_stair",
  "nav_ramp",
  "nav_threshold"
]);
const BASE_NON_WALKABLE_MATERIALS = new Set([
  "nav_obstacle_static",
  "nav_door_panel_dynamic",
  "nav_exclude"
]);
const INPUT_MATERIALS = new Set([
  ...WALKABLE_MATERIALS,
  ...BASE_NON_WALKABLE_MATERIALS
]);

function sha256File(path) {
  const hash = createHash("sha256");
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    let bytesRead;
    while ((bytesRead = readSync(descriptor, buffer, 0, buffer.length, null))) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function finiteNumber(value, label) {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`${label} must be finite`);
  return result;
}

function readBounds(value, label) {
  if (!value || typeof value !== "object")
    throw new Error(`${label} must be an object`);
  const result = {
    minX: finiteNumber(value.minX, `${label}.minX`),
    minZ: finiteNumber(value.minZ, `${label}.minZ`),
    maxX: finiteNumber(value.maxX, `${label}.maxX`),
    maxZ: finiteNumber(value.maxZ, `${label}.maxZ`)
  };
  if (result.minX >= result.maxX || result.minZ >= result.maxZ)
    throw new Error(`${label} must have increasing bounds`);
  return result;
}

function boundsEqual(left, right) {
  return ["minX", "minZ", "maxX", "maxZ"].every(
    (key) => Math.abs(left[key] - right[key]) <= EPSILON
  );
}

function containsBounds(outer, inner) {
  return (
    inner.minX >= outer.minX - EPSILON &&
    inner.minZ >= outer.minZ - EPSILON &&
    inner.maxX <= outer.maxX + EPSILON &&
    inner.maxZ <= outer.maxZ + EPSILON
  );
}

function containsPoint(bounds, point) {
  return (
    point[0] >= bounds.minX - EPSILON &&
    point[0] <= bounds.maxX + EPSILON &&
    point[2] >= bounds.minZ - EPSILON &&
    point[2] <= bounds.maxZ + EPSILON
  );
}

function overlapsArea(left, right) {
  return (
    Math.min(left.maxX, right.maxX) - Math.max(left.minX, right.minX) >
      EPSILON &&
    Math.min(left.maxZ, right.maxZ) - Math.max(left.minZ, right.minZ) > EPSILON
  );
}

function safeName(value) {
  return (
    String(value)
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "unnamed"
  );
}

function loadPolicy(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (
    value.schema !== POLICY_SCHEMA ||
    value.coordinateSpace !== COORDINATE_SPACE
  )
    throw new Error(`invalid hybrid ownership policy ${path}`);
  const bounds = readBounds(value.bounds, "policy.bounds");
  if (!Array.isArray(value.ownership) || value.ownership.length === 0)
    throw new Error("policy.ownership must contain at least one region");
  const ids = new Set();
  const ownership = value.ownership.map((entry, index) => {
    if (!entry || typeof entry !== "object")
      throw new Error(`policy.ownership[${index}] must be an object`);
    const id = String(entry.id ?? "").trim();
    if (!id || ids.has(id))
      throw new Error(`policy.ownership[${index}] has an invalid id`);
    ids.add(id);
    if (entry.owner !== "render-semantic-object")
      throw new Error(
        `policy.ownership[${index}] must be owned by render-semantic-object`
      );
    const regionBounds = readBounds(
      entry.bounds,
      `policy.ownership[${index}].bounds`
    );
    if (!containsBounds(bounds, regionBounds))
      throw new Error(`ownership region ${id} is outside policy bounds`);
    if (
      !Array.isArray(entry.requiredMaterials) ||
      entry.requiredMaterials.length === 0
    )
      throw new Error(`ownership region ${id} must declare requiredMaterials`);
    const requiredMaterials = [...new Set(entry.requiredMaterials)].sort();
    for (const material of requiredMaterials)
      if (!WALKABLE_MATERIALS.has(material))
        throw new Error(
          `ownership region ${id} requires unsafe material ${material}`
        );
    const replacement = entry.objectReplacement;
    const baseObject = String(replacement?.baseObject ?? "").trim();
    const overlayObject = String(replacement?.overlayObject ?? "").trim();
    if (!baseObject || !overlayObject)
      throw new Error(
        `ownership region ${id} must declare an exact objectReplacement`
      );
    const terrainOcclusionBounds = entry.terrainOcclusionBounds
      ? readBounds(
          entry.terrainOcclusionBounds,
          `policy.ownership[${index}].terrainOcclusionBounds`
        )
      : null;
    if (
      terrainOcclusionBounds &&
      !containsBounds(regionBounds, terrainOcclusionBounds)
    )
      throw new Error(
        `ownership region ${id} terrain occlusion is outside its evidence bounds`
      );
    if (
      terrainOcclusionBounds &&
      !requiredMaterials.some((material) =>
        [
          "nav_floor_exterior",
          "nav_floor_interior",
          "nav_stair",
          "nav_ramp",
          "nav_threshold"
        ].includes(material)
      )
    )
      throw new Error(
        `ownership region ${id} cannot occlude terrain without a required replacement structure surface`
      );
    return {
      id,
      bounds: regionBounds,
      objectReplacement: { baseObject, overlayObject },
      terrainOcclusionBounds,
      requiredMaterials
    };
  });
  const baseObjects = new Set();
  const overlayObjects = new Set();
  for (const region of ownership) {
    const { baseObject, overlayObject } = region.objectReplacement;
    if (baseObjects.has(baseObject))
      throw new Error(
        `collision object ${baseObject} is replaced more than once`
      );
    if (overlayObjects.has(overlayObject))
      throw new Error(
        `render object ${overlayObject} is inserted more than once`
      );
    baseObjects.add(baseObject);
    overlayObjects.add(overlayObject);
  }
  ownership.sort((left, right) => left.id.localeCompare(right.id));
  return {
    schema: POLICY_SCHEMA,
    coordinateSpace: COORDINATE_SPACE,
    bounds,
    ownership
  };
}

function validateBaseReport(path, expectedBounds) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  const reportBounds = readBounds(value.bounds, "base report bounds");
  if (
    value.schema !== BASE_REPORT_SCHEMA ||
    value.semanticContract !== SEMANTIC_CONTRACT ||
    value.coordinateSpace !== COORDINATE_SPACE ||
    value.sourceStrategy !== "heightmap-plus-h1col2-only" ||
    value.renderGeometryMerged !== false ||
    !boundsEqual(reportBounds, expectedBounds)
  )
    throw new Error("collision-first source report does not match the policy");
  return value;
}

function validateOverlayEvidence(manifestPath, lintPath, overlayPath, policy) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const lint = JSON.parse(readFileSync(lintPath, "utf8"));
  const overlayHash = sha256File(overlayPath);
  const manifestBounds = readBounds(
    manifest.navBounds,
    "overlay manifest bounds"
  );
  const lintBounds = readBounds(lint.bounds, "overlay lint bounds");
  if (
    manifest.schemaVersion !== 1 ||
    manifest.semanticSchemaVersion !== 1 ||
    manifest.semanticMode !== "strict" ||
    manifest.coordinateSpace !== COORDINATE_SPACE ||
    !manifest.worldObj ||
    manifest.worldObj.sha256 !== overlayHash ||
    !overlapsArea(manifestBounds, policy.bounds)
  )
    throw new Error(
      "render overlay build manifest is not strict or does not match its OBJ"
    );
  if (
    lint.schemaVersion !== 3 ||
    lint.semanticSchemaVersion !== 1 ||
    lint.coordinateSpace !== COORDINATE_SPACE ||
    !Array.isArray(lint.errors) ||
    lint.errors.length !== 0 ||
    !boundsEqual(lintBounds, manifestBounds)
  )
    throw new Error("render overlay lint is not a matching zero-error report");
  return { manifest, lint, overlayHash, evidenceBounds: manifestBounds };
}

function createLineWriter(path) {
  const fd = openSync(path, "wx");
  let buffered = "";
  return {
    line(value) {
      buffered += `${value}\n`;
      if (buffered.length >= 1024 * 1024) {
        writeSync(fd, buffered);
        buffered = "";
      }
    },
    close() {
      if (buffered) writeSync(fd, buffered);
      buffered = "";
      closeSync(fd);
    }
  };
}

function formatNumber(value) {
  if (Object.is(value, -0) || Math.abs(value) < 0.0000005) return "0";
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function interpolate(left, right, amount) {
  return [
    left[0] + (right[0] - left[0]) * amount,
    left[1] + (right[1] - left[1]) * amount,
    left[2] + (right[2] - left[2]) * amount
  ];
}

function samePoint(left, right) {
  return (
    Math.abs(left[0] - right[0]) <= EPSILON &&
    Math.abs(left[1] - right[1]) <= EPSILON &&
    Math.abs(left[2] - right[2]) <= EPSILON
  );
}

function cleanPolygon(polygon) {
  const result = [];
  for (const point of polygon)
    if (result.length === 0 || !samePoint(result[result.length - 1], point))
      result.push(point);
  if (result.length > 1 && samePoint(result[0], result[result.length - 1]))
    result.pop();
  return result;
}

function splitPolygon(polygon, distance) {
  const inside = [];
  const outside = [];
  for (let index = 0; index < polygon.length; index++) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    const currentDistance = distance(current);
    const nextDistance = distance(next);
    if (currentDistance >= -EPSILON) inside.push(current);
    if (currentDistance <= EPSILON) outside.push(current);
    const crosses =
      (currentDistance < -EPSILON && nextDistance > EPSILON) ||
      (currentDistance > EPSILON && nextDistance < -EPSILON);
    if (crosses) {
      const amount = currentDistance / (currentDistance - nextDistance);
      const point = interpolate(current, next, amount);
      inside.push(point);
      outside.push(point);
    }
  }
  return [cleanPolygon(inside), cleanPolygon(outside)];
}

function rectangleDistances(bounds) {
  return [
    (point) => point[0] - bounds.minX,
    (point) => bounds.maxX - point[0],
    (point) => point[2] - bounds.minZ,
    (point) => bounds.maxZ - point[2]
  ];
}

function intersectRectangle(polygon, bounds) {
  let result = polygon;
  for (const distance of rectangleDistances(bounds)) {
    [result] = splitPolygon(result, distance);
    if (result.length < 3) return [];
  }
  return result;
}

function subtractRectangle(polygon, bounds) {
  let candidates = [polygon];
  const outside = [];
  for (const distance of rectangleDistances(bounds)) {
    const next = [];
    for (const candidate of candidates) {
      const [insidePart, outsidePart] = splitPolygon(candidate, distance);
      if (outsidePart.length >= 3) outside.push(outsidePart);
      if (insidePart.length >= 3) next.push(insidePart);
    }
    candidates = next;
    if (candidates.length === 0) break;
  }
  return outside;
}

function triangleAreaSquared(triangle) {
  const [a, b, c] = triangle;
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cross = [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0]
  ];
  return cross[0] ** 2 + cross[1] ** 2 + cross[2] ** 2;
}

function projectedAreaXZ(polygon) {
  let twiceArea = 0;
  for (let index = 0; index < polygon.length; index++) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    twiceArea += current[0] * next[2] - next[0] * current[2];
  }
  return Math.abs(twiceArea) / 2;
}

function roundNumber(value) {
  return Number(value.toFixed(6));
}

function triangulate(polygon) {
  const triangles = [];
  for (let index = 1; index < polygon.length - 1; index++) {
    const triangle = [polygon[0], polygon[index], polygon[index + 1]];
    if (triangleAreaSquared(triangle) > EPSILON ** 2) triangles.push(triangle);
  }
  return triangles;
}

async function parseObj(path, onTriangle) {
  const vertices = [null];
  const objectDeclarations = new Map();
  let material = null;
  let objectName = "unnamed";
  let faces = 0;
  let lineNumber = 0;
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const rawLine of lines) {
    lineNumber++;
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf(" ");
    const command = separator === -1 ? line : line.slice(0, separator);
    const body = separator === -1 ? "" : line.slice(separator + 1).trim();
    if (command === "v") {
      const values = body.split(/\s+/).slice(0, 3).map(Number);
      if (
        values.length !== 3 ||
        values.some((value) => !Number.isFinite(value))
      )
        throw new Error(`${path}:${lineNumber} has an invalid vertex`);
      vertices.push(values);
    } else if (command === "usemtl") {
      if (!INPUT_MATERIALS.has(body))
        throw new Error(`${path}:${lineNumber} has unsafe material ${body}`);
      material = body;
    } else if (command === "o") {
      objectName = body || "unnamed";
      objectDeclarations.set(
        objectName,
        (objectDeclarations.get(objectName) ?? 0) + 1
      );
    } else if (command === "g") {
      // A group does not change exact actor/object ownership.
    } else if (command === "f") {
      if (!material)
        throw new Error(`${path}:${lineNumber} has a face without a material`);
      const references = body.split(/\s+/);
      if (references.length < 3)
        throw new Error(
          `${path}:${lineNumber} has a face with fewer than 3 vertices`
        );
      const points = references.map((reference) => {
        const rawIndex = Number(reference.split("/", 1)[0]);
        if (!Number.isInteger(rawIndex) || rawIndex === 0)
          throw new Error(`${path}:${lineNumber} has an invalid face index`);
        const index = rawIndex < 0 ? vertices.length + rawIndex : rawIndex;
        if (index <= 0 || index >= vertices.length)
          throw new Error(`${path}:${lineNumber} face index is out of range`);
        return vertices[index];
      });
      for (let index = 1; index < points.length - 1; index++) {
        faces++;
        await onTriangle({
          triangle: [points[0], points[index], points[index + 1]],
          material,
          objectName
        });
      }
    } else if (!["vt", "vn", "s", "mtllib"].includes(command)) {
      throw new Error(
        `${path}:${lineNumber} has unsupported OBJ command ${command}`
      );
    }
  }
  return { vertices: vertices.length - 1, faces, objectDeclarations };
}

function materialCounter() {
  return Object.create(null);
}

function increment(counter, material, amount = 1) {
  counter[material] = (counter[material] ?? 0) + amount;
}

function sortedCounter(counter) {
  return Object.fromEntries(
    Object.entries(counter).sort(([left], [right]) => left.localeCompare(right))
  );
}

async function composeRegionalHybrid(options) {
  const outputPath = resolve(options.outputPath);
  const reportPath = resolve(options.reportPath ?? `${outputPath}.source.json`);
  const paths = {
    baseObj: resolve(options.baseObjPath),
    baseReport: resolve(options.baseReportPath),
    overlayObj: resolve(options.overlayObjPath),
    overlayManifest: resolve(options.overlayManifestPath),
    overlayLint: resolve(options.overlayLintPath),
    policy: resolve(options.policyPath)
  };
  if (existsSync(outputPath) || existsSync(reportPath))
    throw new Error("output OBJ and report paths must not already exist");
  for (const [label, path] of Object.entries(paths))
    if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`);

  const policy = loadPolicy(paths.policy);
  validateBaseReport(paths.baseReport, policy.bounds);
  const overlayEvidence = validateOverlayEvidence(
    paths.overlayManifest,
    paths.overlayLint,
    paths.overlayObj,
    policy
  );

  mkdirSync(dirname(outputPath), { recursive: true });
  mkdirSync(dirname(reportPath), { recursive: true });
  const writer = createLineWriter(outputPath);
  const counts = {
    baseInput: materialCounter(),
    baseOutput: materialCounter(),
    baseObjectReplaced: materialCounter(),
    overlayInput: materialCounter(),
    overlayOutput: materialCounter(),
    overlayUnownedDiscarded: materialCounter(),
    baseTerrainOcclusionSelectedTriangles: 0,
    baseTerrainOcclusionRemovedProjectedArea: 0,
    outputVertices: 0,
    outputTriangles: 0,
    droppedDegenerateTriangles: 0
  };
  const regionMaterials = Object.fromEntries(
    policy.ownership.map((region) => [region.id, materialCounter()])
  );
  const regionMatches = Object.fromEntries(
    policy.ownership.map((region) => [
      region.id,
      {
        baseSelectedTriangles: 0,
        baseSelectedOutsideOwnershipTriangles: 0,
        overlaySelectedTriangles: 0,
        overlaySelectedOutsideOwnershipTriangles: 0,
        terrainOcclusionSelectedTriangles: 0,
        terrainOcclusionRemovedProjectedArea: 0
      }
    ])
  );
  let activeObject = null;
  let activeMaterial = null;

  function emit(source, owner, objectName, material, polygon) {
    const triangles = triangulate(polygon);
    if (triangles.length === 0) {
      counts.droppedDegenerateTriangles++;
      return;
    }
    const outputObject = `${safeName(source)}__${safeName(owner)}__${safeName(objectName)}`;
    if (outputObject !== activeObject) {
      writer.line(`o ${outputObject}`);
      activeObject = outputObject;
      activeMaterial = null;
    }
    if (material !== activeMaterial) {
      writer.line(`usemtl ${material}`);
      activeMaterial = material;
    }
    for (const triangle of triangles) {
      const first = counts.outputVertices + 1;
      for (const point of triangle)
        writer.line(
          `v ${formatNumber(point[0])} ${formatNumber(point[1])} ${formatNumber(point[2])}`
        );
      writer.line(`f ${first} ${first + 1} ${first + 2}`);
      counts.outputVertices += 3;
      counts.outputTriangles++;
      increment(
        source === "base" ? counts.baseOutput : counts.overlayOutput,
        material
      );
      if (source === "overlay") increment(regionMaterials[owner], material);
    }
  }

  try {
    writer.line(`# ${SEMANTIC_CONTRACT}`);
    writer.line(`# ${REPORT_SCHEMA}`);
    writer.line("# collision-first world plus exact render object replacement");
    const baseParsed = await parseObj(
      paths.baseObj,
      ({ triangle, material, objectName }) => {
        increment(counts.baseInput, material);
        const bounded = intersectRectangle(triangle, policy.bounds);
        if (bounded.length < 3) return;
        const region = policy.ownership.find(
          (entry) => entry.objectReplacement.baseObject === objectName
        );
        if (region) {
          regionMatches[region.id].baseSelectedTriangles++;
          if (!bounded.every((point) => containsPoint(region.bounds, point)))
            regionMatches[region.id].baseSelectedOutsideOwnershipTriangles++;
          increment(counts.baseObjectReplaced, material);
          return;
        }
        let polygons = [bounded];
        if (material === "nav_terrain") {
          for (const owner of policy.ownership) {
            if (!owner.terrainOcclusionBounds || polygons.length === 0)
              continue;
            const next = [];
            let removedArea = 0;
            for (const polygon of polygons) {
              const fragments = subtractRectangle(
                polygon,
                owner.terrainOcclusionBounds
              );
              removedArea +=
                projectedAreaXZ(polygon) -
                fragments.reduce(
                  (sum, fragment) => sum + projectedAreaXZ(fragment),
                  0
                );
              next.push(...fragments);
            }
            if (removedArea > EPSILON) {
              counts.baseTerrainOcclusionSelectedTriangles++;
              counts.baseTerrainOcclusionRemovedProjectedArea += removedArea;
              regionMatches[owner.id].terrainOcclusionSelectedTriangles++;
              regionMatches[owner.id].terrainOcclusionRemovedProjectedArea +=
                removedArea;
            }
            polygons = next;
          }
        }
        for (const polygon of polygons)
          emit("base", "collision-owned", objectName, material, polygon);
      }
    );
    const overlayParsed = await parseObj(
      paths.overlayObj,
      ({ triangle, material, objectName }) => {
        increment(counts.overlayInput, material);
        const region = policy.ownership.find(
          (entry) => entry.objectReplacement.overlayObject === objectName
        );
        if (!region) {
          increment(counts.overlayUnownedDiscarded, material);
          return;
        }
        const bounded = intersectRectangle(triangle, policy.bounds);
        if (bounded.length < 3) return;
        regionMatches[region.id].overlaySelectedTriangles++;
        if (!bounded.every((point) => containsPoint(region.bounds, point)))
          regionMatches[region.id].overlaySelectedOutsideOwnershipTriangles++;
        emit("overlay", region.id, objectName, material, bounded);
      }
    );
    writer.close();

    for (const region of policy.ownership) {
      const { baseObject, overlayObject } = region.objectReplacement;
      if (baseParsed.objectDeclarations.get(baseObject) !== 1)
        throw new Error(
          `ownership region ${region.id} requires exactly one collision object ${baseObject}`
        );
      if (overlayParsed.objectDeclarations.get(overlayObject) !== 1)
        throw new Error(
          `ownership region ${region.id} requires exactly one render object ${overlayObject}`
        );
      if (regionMatches[region.id].baseSelectedTriangles === 0)
        throw new Error(
          `ownership region ${region.id} matched no selected collision object triangles`
        );
      if (regionMatches[region.id].overlaySelectedTriangles === 0)
        throw new Error(
          `ownership region ${region.id} matched no selected render object triangles`
        );
      if (
        regionMatches[region.id].baseSelectedOutsideOwnershipTriangles !== 0 ||
        regionMatches[region.id].overlaySelectedOutsideOwnershipTriangles !== 0
      )
        throw new Error(
          `ownership region ${region.id} does not contain both complete selected replacement objects`
        );
      for (const material of region.requiredMaterials)
        if (!regionMaterials[region.id][material])
          throw new Error(
            `ownership region ${region.id} emitted no required ${material} triangles`
          );
    }
    if (counts.outputTriangles === 0)
      throw new Error("hybrid source emitted no triangles");

    const report = {
      schema: REPORT_SCHEMA,
      semanticContract: SEMANTIC_CONTRACT,
      coordinateSpace: COORDINATE_SPACE,
      sourceStrategy: "collision-base-plus-exact-render-object-replacement",
      renderGeometryMerged: true,
      bounds: policy.bounds,
      ownership: policy.ownership.map((region) => ({
        ...region,
        matchedInputTriangles: {
          ...regionMatches[region.id],
          terrainOcclusionRemovedProjectedArea: roundNumber(
            regionMatches[region.id].terrainOcclusionRemovedProjectedArea
          )
        },
        emittedMaterialTriangles: sortedCounter(regionMaterials[region.id])
      })),
      rules: {
        collisionSourceOwnsTerrainAndUnmappedObjects: true,
        renderSourceOwnsMappedObject: true,
        mappedObjectsRequiredExactlyOnce: true,
        materialChangesPreserveExactOutputObjectIdentity: true,
        terrainOcclusionRequiresExplicitContainedEvidenceBounds: true,
        mappedObjectPortionsSelectedByPolicyRequiredInsideOwnershipBounds: true,
        overlayMappedObjectIncludesAllCanonicalFaces: true,
        triangleBoundaryMode: "exact-xz-rectangle-clipping",
        crossSourceMappedObjectOverlapByConstruction: false
      },
      inputs: {
        baseObj: {
          file: basename(paths.baseObj),
          sha256: sha256File(paths.baseObj)
        },
        baseReport: {
          file: basename(paths.baseReport),
          sha256: sha256File(paths.baseReport)
        },
        overlayObj: {
          file: basename(paths.overlayObj),
          sha256: overlayEvidence.overlayHash,
          evidenceBounds: overlayEvidence.evidenceBounds
        },
        overlayManifest: {
          file: basename(paths.overlayManifest),
          sha256: sha256File(paths.overlayManifest)
        },
        overlayLint: {
          file: basename(paths.overlayLint),
          sha256: sha256File(paths.overlayLint)
        },
        policy: {
          file: basename(paths.policy),
          sha256: sha256File(paths.policy)
        }
      },
      output: { file: basename(outputPath), sha256: sha256File(outputPath) },
      counts: {
        baseParsed: {
          vertices: baseParsed.vertices,
          faces: baseParsed.faces,
          objects: baseParsed.objectDeclarations.size
        },
        overlayParsed: {
          vertices: overlayParsed.vertices,
          faces: overlayParsed.faces,
          objects: overlayParsed.objectDeclarations.size
        },
        baseInputMaterialTriangles: sortedCounter(counts.baseInput),
        baseOutputMaterialTriangles: sortedCounter(counts.baseOutput),
        baseObjectReplacedMaterialTriangles: sortedCounter(
          counts.baseObjectReplaced
        ),
        overlayInputMaterialTriangles: sortedCounter(counts.overlayInput),
        overlayOutputMaterialTriangles: sortedCounter(counts.overlayOutput),
        overlayUnownedDiscardedMaterialTriangles: sortedCounter(
          counts.overlayUnownedDiscarded
        ),
        baseTerrainOcclusionSelectedTriangles:
          counts.baseTerrainOcclusionSelectedTriangles,
        baseTerrainOcclusionRemovedProjectedArea: roundNumber(
          counts.baseTerrainOcclusionRemovedProjectedArea
        ),
        outputVertices: counts.outputVertices,
        outputTriangles: counts.outputTriangles,
        droppedDegenerateTriangles: counts.droppedDegenerateTriangles
      },
      limitations: [
        "Ownership is regional and must pass topology gates before it can be expanded or deployed.",
        "Only exact mapped objects change authority; collision terrain and separate props remain authoritative.",
        "Separate collision actors can overlap a mapped render actor and mask its walkable semantics; topology gates must detect this.",
        "Base terrain remains authoritative except inside an explicit, contained terrainOcclusionBounds footprint on a reviewed structure replacement.",
        "This regional source is not a complete-provenance full-world artifact."
      ]
    };
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      flag: "wx"
    });
    return report;
  } catch (error) {
    try {
      writer.close();
    } catch {
      // Preserve the original composition failure during best-effort cleanup.
    }
    rmSync(outputPath, { force: true });
    rmSync(reportPath, { force: true });
    throw error;
  }
}

function parseArgs(argv) {
  const result = {};
  const names = new Map([
    ["--base-obj", "baseObjPath"],
    ["--base-report", "baseReportPath"],
    ["--overlay-obj", "overlayObjPath"],
    ["--overlay-manifest", "overlayManifestPath"],
    ["--overlay-lint", "overlayLintPath"],
    ["--policy", "policyPath"],
    ["--output", "outputPath"],
    ["--report", "reportPath"]
  ]);
  for (let index = 0; index < argv.length; index++) {
    const property = names.get(argv[index]);
    if (!property) throw new Error(`unknown argument: ${argv[index]}`);
    if (index + 1 >= argv.length)
      throw new Error(`missing value for ${argv[index]}`);
    result[property] = argv[++index];
  }
  for (const property of [
    "baseObjPath",
    "baseReportPath",
    "overlayObjPath",
    "overlayManifestPath",
    "overlayLintPath",
    "policyPath",
    "outputPath"
  ])
    if (!result[property])
      throw new Error(`missing required option ${property}`);
  return result;
}

async function main() {
  const report = await composeRegionalHybrid(parseArgs(process.argv.slice(2)));
  console.log(
    `[hybrid-nav-source] wrote ${report.counts.outputTriangles} triangles from ` +
      `${report.ownership.length} explicit ownership region(s)`
  );
}

module.exports = {
  POLICY_SCHEMA,
  REPORT_SCHEMA,
  composeRegionalHybrid,
  intersectRectangle,
  loadPolicy,
  parseArgs,
  subtractRectangle
};

if (require.main === module)
  main().catch((error) => {
    console.error(`[hybrid-nav-source] ${error.message}`);
    process.exitCode = 1;
  });
