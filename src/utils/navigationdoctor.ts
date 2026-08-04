export const NAVIGATION_DOCTOR_SCHEMA_VERSION = 1 as const;

export interface NavigationUnknownMesh {
  actorFile: string;
  collisionAsset?: string;
  collisionAssetSha256?: string;
  kind: number;
  meshIndex: number;
  triangleCount: number;
  unknownTriangles: number;
  classifiedTriangles?: number;
  instanceCount: number;
  worldUnknownTriangles: number;
}

export interface NavigationUnknownInventory {
  collisionSha256: string;
  semanticSidecarSha256?: string | null;
  semanticSource?: "h1sem1" | "metadata";
  semanticMode?: string;
  totalTriangles?: number;
  totalUnknownTriangles?: number;
  meshes: NavigationUnknownMesh[];
}

export interface NavigationModelValidationTemplate {
  schemaVersion: number;
  actorFile: string;
  routes: unknown[];
  terrainProbes?: unknown[];
  forbiddenProbes?: unknown[];
  transitions?: unknown[];
}

export interface NavigationDoctorTemplateSource {
  path: string;
  template: NavigationModelValidationTemplate;
}

export interface NavigationDoctorLegacyValidation {
  actorFile: string;
  evidencePaths: string[];
  note: string;
}

export interface NavigationDoctorModel {
  rank: number;
  actorFile: string;
  family: string;
  meshIndex: number;
  collisionAssetSha256: string | null;
  triangles: number;
  unknownTriangles: number;
  instances: number;
  worldUnknownTriangles: number;
  worldImpactPercent: number;
  cumulativeImpactPercent: number;
  validation:
    | {
        kind: "standard-model-template";
        path: string;
        routesPerInstance: number;
        terrainProbes: number;
        forbiddenProbes: number;
        transitionsPerInstance: number;
      }
    | {
        kind: "legacy-model-validator";
        evidencePaths: string[];
        note: string;
      }
    | null;
  nextAction:
    | "run-model-validation"
    | "migrate-legacy-validator"
    | "author-model-template";
}

export interface NavigationDoctorReport {
  schemaVersion: typeof NAVIGATION_DOCTOR_SCHEMA_VERSION;
  collisionSha256: string;
  semanticSidecarSha256: string | null;
  semanticSource: "h1sem1" | "metadata" | null;
  semanticMode: string | null;
  totals: {
    compositeModels: number;
    compositeInstances: number;
    compositeUnknownTriangles: number;
    worldUnknownTriangles: number;
    standardTemplates: number;
    templatedModels: number;
    templatedWorldImpactPercent: number;
    knownValidationModels: number;
    knownValidationWorldImpactPercent: number;
  };
  milestones: Array<{
    models: number;
    worldImpactPercent: number;
  }>;
  models: NavigationDoctorModel[];
  unboundTemplates: Array<{
    actorFile: string;
    path: string;
  }>;
}

export interface NavigationPreparedValidationSummary {
  instances: number;
  routes: number;
  passed: number;
  failures: unknown[];
  forbiddenProbes: number;
  forbiddenEvaluated: number;
  forbiddenPassed: number;
  forbiddenFailures: unknown[];
  forbiddenUnverified: unknown[];
}

export interface NavigationPreparedModelRun {
  actorFile: string;
  instances: number;
  skippedInstances: number;
  routes: number;
  forbiddenProbes: number;
  transitions: number;
  validationExitCode?: number;
  validation?: NavigationPreparedValidationSummary;
}

export function assessNavigationPreparedModels(
  models: NavigationPreparedModelRun[],
  requireValidation: boolean
): string[] {
  const failures: string[] = [];
  for (const model of models) {
    const label = model.actorFile;
    if (model.instances <= 0 || model.routes <= 0)
      failures.push(`${label}: zero model instances or routes were prepared`);
    if (!model.validation) {
      if (requireValidation)
        failures.push(`${label}: streaming validation was not produced`);
      continue;
    }
    const validation = model.validation;
    if (
      model.validationExitCode !== undefined &&
      model.validationExitCode !== 0
    )
      failures.push(
        `${label}: streaming validator exited ${model.validationExitCode}`
      );
    if (validation.instances !== model.instances)
      failures.push(
        `${label}: validated ${validation.instances}/${model.instances} instances`
      );
    if (validation.routes !== model.routes)
      failures.push(
        `${label}: validated ${validation.routes}/${model.routes} routes`
      );
    if (
      validation.passed !== validation.routes ||
      validation.failures.length > 0
    )
      failures.push(
        `${label}: ${validation.passed}/${validation.routes} routes passed`
      );
    if (validation.forbiddenProbes !== model.forbiddenProbes)
      failures.push(
        `${label}: received ${validation.forbiddenProbes}/${model.forbiddenProbes} forbidden probes`
      );
    if (
      validation.forbiddenEvaluated !== model.forbiddenProbes ||
      validation.forbiddenPassed !== model.forbiddenProbes ||
      validation.forbiddenFailures.length > 0 ||
      validation.forbiddenUnverified.length > 0
    )
      failures.push(
        `${label}: ${validation.forbiddenPassed}/${model.forbiddenProbes} forbidden probes passed with ${validation.forbiddenEvaluated} evaluated`
      );
  }
  return failures;
}

function finiteNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 0)
    throw new Error(`${field} must be a non-negative integer`);
  return Number(value);
}

function finiteNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error(`${field} must be a finite non-negative number`);
  return value;
}

function actorFamily(actorFile: string): string {
  const withoutExtension = actorFile.replace(/\.adr$/i, "");
  const pieces = withoutExtension.split("_");
  if (pieces.length <= 2) return withoutExtension;
  return pieces.slice(0, -1).join("_");
}

function roundedPercent(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 100_000) / 1_000;
}

function validateTemplateSource(source: NavigationDoctorTemplateSource): void {
  const { path, template } = source;
  if (!path) throw new Error("model validation template path is empty");
  if (template.schemaVersion !== 1)
    throw new Error(`${path} has unsupported schemaVersion`);
  if (!template.actorFile) throw new Error(`${path} has no actorFile`);
  if (!Array.isArray(template.routes) || template.routes.length === 0)
    throw new Error(`${path} has no model routes`);
  if (template.terrainProbes && !Array.isArray(template.terrainProbes))
    throw new Error(`${path} terrainProbes must be an array`);
  if (template.forbiddenProbes && !Array.isArray(template.forbiddenProbes))
    throw new Error(`${path} forbiddenProbes must be an array`);
  if (template.transitions && !Array.isArray(template.transitions))
    throw new Error(`${path} transitions must be an array`);
}

/**
 * Converts the diagnostic unknown-mesh inventory into a model-oriented work
 * queue. Only kind-0 composite geometry is included: props and thin blockers
 * are a different classification problem and would distort building priority.
 */
export function createNavigationDoctorReport(
  inventory: NavigationUnknownInventory,
  templates: NavigationDoctorTemplateSource[],
  legacyValidations: NavigationDoctorLegacyValidation[] = []
): NavigationDoctorReport {
  if (!inventory.collisionSha256)
    throw new Error("navigation inventory has no collisionSha256");
  if (!Array.isArray(inventory.meshes))
    throw new Error("navigation inventory has no meshes array");

  const templateByActor = new Map<string, NavigationDoctorTemplateSource>();
  for (const source of templates) {
    validateTemplateSource(source);
    const key = source.template.actorFile.toLocaleLowerCase("en-US");
    if (templateByActor.has(key))
      throw new Error(
        `duplicate model template for ${source.template.actorFile}`
      );
    templateByActor.set(key, source);
  }
  const legacyByActor = new Map<string, NavigationDoctorLegacyValidation>();
  for (const validation of legacyValidations) {
    if (!validation.actorFile)
      throw new Error("legacy model validation has no actorFile");
    if (!validation.note)
      throw new Error(
        `legacy validation for ${validation.actorFile} has no note`
      );
    if (
      !Array.isArray(validation.evidencePaths) ||
      validation.evidencePaths.length === 0
    )
      throw new Error(
        `legacy validation for ${validation.actorFile} has no evidencePaths`
      );
    const key = validation.actorFile.toLocaleLowerCase("en-US");
    if (legacyByActor.has(key) || templateByActor.has(key))
      throw new Error(`duplicate model validation for ${validation.actorFile}`);
    legacyByActor.set(key, validation);
  }

  const compositeMeshes = inventory.meshes.filter((mesh) => mesh.kind === 0);
  const actorKeys = new Set<string>();
  for (const mesh of compositeMeshes) {
    if (!mesh.actorFile)
      throw new Error("kind-0 inventory mesh has no actorFile");
    const key = mesh.actorFile.toLocaleLowerCase("en-US");
    if (actorKeys.has(key))
      throw new Error(`duplicate kind-0 inventory actor ${mesh.actorFile}`);
    actorKeys.add(key);
    finiteNonNegativeInteger(mesh.meshIndex, `${mesh.actorFile}.meshIndex`);
    finiteNonNegativeInteger(
      mesh.triangleCount,
      `${mesh.actorFile}.triangleCount`
    );
    finiteNonNegativeInteger(
      mesh.unknownTriangles,
      `${mesh.actorFile}.unknownTriangles`
    );
    finiteNonNegativeInteger(
      mesh.instanceCount,
      `${mesh.actorFile}.instanceCount`
    );
    finiteNonNegativeNumber(
      mesh.worldUnknownTriangles,
      `${mesh.actorFile}.worldUnknownTriangles`
    );
  }

  const ranked = [...compositeMeshes].sort(
    (left, right) =>
      right.worldUnknownTriangles - left.worldUnknownTriangles ||
      left.actorFile.localeCompare(right.actorFile)
  );
  const worldUnknownTriangles = ranked.reduce(
    (sum, mesh) => sum + mesh.worldUnknownTriangles,
    0
  );
  let cumulativeImpact = 0;
  let templatedWorldImpact = 0;
  let knownValidationWorldImpact = 0;
  const models = ranked.map((mesh, index): NavigationDoctorModel => {
    cumulativeImpact += mesh.worldUnknownTriangles;
    const source = templateByActor.get(
      mesh.actorFile.toLocaleLowerCase("en-US")
    );
    const legacy = legacyByActor.get(mesh.actorFile.toLocaleLowerCase("en-US"));
    if (source) templatedWorldImpact += mesh.worldUnknownTriangles;
    if (source || legacy)
      knownValidationWorldImpact += mesh.worldUnknownTriangles;
    return {
      rank: index + 1,
      actorFile: mesh.actorFile,
      family: actorFamily(mesh.actorFile),
      meshIndex: mesh.meshIndex,
      collisionAssetSha256: mesh.collisionAssetSha256 ?? null,
      triangles: mesh.triangleCount,
      unknownTriangles: mesh.unknownTriangles,
      instances: mesh.instanceCount,
      worldUnknownTriangles: mesh.worldUnknownTriangles,
      worldImpactPercent: roundedPercent(
        mesh.worldUnknownTriangles,
        worldUnknownTriangles
      ),
      cumulativeImpactPercent: roundedPercent(
        cumulativeImpact,
        worldUnknownTriangles
      ),
      validation: source
        ? {
            kind: "standard-model-template",
            path: source.path,
            routesPerInstance: source.template.routes.length,
            terrainProbes: source.template.terrainProbes?.length ?? 0,
            forbiddenProbes: source.template.forbiddenProbes?.length ?? 0,
            transitionsPerInstance: source.template.transitions?.length ?? 0
          }
        : legacy
          ? {
              kind: "legacy-model-validator",
              evidencePaths: legacy.evidencePaths,
              note: legacy.note
            }
          : null,
      nextAction: source
        ? "run-model-validation"
        : legacy
          ? "migrate-legacy-validator"
          : "author-model-template"
    };
  });

  const milestoneSizes = [5, 10, 15, 20].filter(
    (count) => count <= models.length
  );
  if (models.length > 0 && !milestoneSizes.includes(models.length))
    milestoneSizes.push(models.length);

  return {
    schemaVersion: NAVIGATION_DOCTOR_SCHEMA_VERSION,
    collisionSha256: inventory.collisionSha256,
    semanticSidecarSha256: inventory.semanticSidecarSha256 ?? null,
    semanticSource: inventory.semanticSource ?? null,
    semanticMode: inventory.semanticMode ?? null,
    totals: {
      compositeModels: models.length,
      compositeInstances: ranked.reduce(
        (sum, mesh) => sum + mesh.instanceCount,
        0
      ),
      compositeUnknownTriangles: ranked.reduce(
        (sum, mesh) => sum + mesh.unknownTriangles,
        0
      ),
      worldUnknownTriangles,
      standardTemplates: templates.length,
      templatedModels: models.filter(
        (model) => model.validation?.kind === "standard-model-template"
      ).length,
      templatedWorldImpactPercent: roundedPercent(
        templatedWorldImpact,
        worldUnknownTriangles
      ),
      knownValidationModels: models.filter((model) => model.validation).length,
      knownValidationWorldImpactPercent: roundedPercent(
        knownValidationWorldImpact,
        worldUnknownTriangles
      )
    },
    milestones: milestoneSizes.map((count) => ({
      models: count,
      worldImpactPercent: models[count - 1].cumulativeImpactPercent
    })),
    models,
    unboundTemplates: templates
      .filter(
        (source) =>
          !actorKeys.has(source.template.actorFile.toLocaleLowerCase("en-US"))
      )
      .map((source) => ({
        actorFile: source.template.actorFile,
        path: source.path
      }))
      .sort((left, right) => left.actorFile.localeCompare(right.actorFile))
  };
}

export function renderNavigationDoctorMarkdown(
  report: NavigationDoctorReport,
  limit: number = 20
): string {
  const boundedLimit = Math.max(1, Math.min(limit, report.models.length));
  const lines = [
    "# Navigation doctor report",
    "",
    `Collision: \`${report.collisionSha256}\``,
    ...(report.semanticSidecarSha256
      ? [
          `Semantics: \`${report.semanticSidecarSha256}\` (${report.semanticSource ?? "unknown source"})`
        ]
      : []),
    "",
    `Composite models: ${report.totals.compositeModels}`,
    `Placed composite instances: ${report.totals.compositeInstances}`,
    `Standard model templates: ${report.totals.templatedModels}/${report.totals.compositeModels}`,
    `Templated world impact: ${report.totals.templatedWorldImpactPercent.toFixed(3)}%`,
    `Known validation coverage: ${report.totals.knownValidationModels}/${report.totals.compositeModels} models, ${report.totals.knownValidationWorldImpactPercent.toFixed(3)}% world impact`,
    "",
    `## Top ${boundedLimit} model archetypes`,
    "",
    "| Rank | Actor | Instances | World impact | Cumulative | Validator | Next action |",
    "| ---: | --- | ---: | ---: | ---: | --- | --- |"
  ];
  for (const model of report.models.slice(0, boundedLimit)) {
    lines.push(
      `| ${model.rank} | \`${model.actorFile}\` | ${model.instances} | ${model.worldImpactPercent.toFixed(3)}% | ${model.cumulativeImpactPercent.toFixed(3)}% | ${model.validation?.kind === "standard-model-template" ? `${model.validation.routesPerInstance} routes / ${model.validation.forbiddenProbes} forbidden / ${model.validation.transitionsPerInstance} links` : model.validation?.kind === "legacy-model-validator" ? "legacy" : "missing"} | ${model.nextAction} |`
    );
  }
  if (report.unboundTemplates.length) {
    lines.push("", "## Unbound templates", "");
    for (const template of report.unboundTemplates)
      lines.push(`- \`${template.actorFile}\`: \`${template.path}\``);
  }
  lines.push("");
  return lines.join("\n");
}
