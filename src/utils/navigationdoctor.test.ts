import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createNavigationDoctorReport,
  NavigationModelValidationTemplate,
  NavigationUnknownInventory,
  renderNavigationDoctorMarkdown
} from "./navigationdoctor";

function inventory(): NavigationUnknownInventory {
  return {
    collisionSha256: "a".repeat(64),
    semanticSidecarSha256: "d".repeat(64),
    semanticSource: "h1sem1",
    semanticMode: "diagnostic",
    meshes: [
      {
        actorFile: "Common_Structures_HouseB.adr",
        collisionAssetSha256: "b".repeat(64),
        kind: 0,
        meshIndex: 2,
        triangleCount: 20,
        unknownTriangles: 10,
        instanceCount: 5,
        worldUnknownTriangles: 50
      },
      {
        actorFile: "Common_Structures_HouseA.adr",
        collisionAssetSha256: "c".repeat(64),
        kind: 0,
        meshIndex: 1,
        triangleCount: 100,
        unknownTriangles: 100,
        instanceCount: 2,
        worldUnknownTriangles: 200
      },
      {
        actorFile: "Common_Props_Chair.adr",
        kind: 2,
        meshIndex: 3,
        triangleCount: 1_000,
        unknownTriangles: 1_000,
        instanceCount: 1_000,
        worldUnknownTriangles: 1_000_000
      }
    ]
  };
}

const template: NavigationModelValidationTemplate = {
  schemaVersion: 1,
  actorFile: "Common_Structures_HouseA.adr",
  routes: [{ label: "entrance" }, { label: "stairs" }],
  terrainProbes: [[0, 0, 0]],
  forbiddenProbes: [{ label: "roof" }],
  transitions: [{ name: "door seam" }]
};

test("navigation doctor ranks composite archetypes and binds reusable probes", () => {
  const report = createNavigationDoctorReport(inventory(), [
    { path: "house-a.json", template }
  ]);

  assert.equal(report.totals.compositeModels, 2);
  assert.equal(report.semanticSidecarSha256, "d".repeat(64));
  assert.equal(report.semanticSource, "h1sem1");
  assert.equal(report.totals.compositeInstances, 7);
  assert.equal(report.totals.worldUnknownTriangles, 250);
  assert.equal(report.totals.templatedModels, 1);
  assert.equal(report.totals.templatedWorldImpactPercent, 80);
  assert.equal(report.totals.knownValidationModels, 1);
  assert.equal(report.totals.knownValidationWorldImpactPercent, 80);
  assert.deepEqual(
    report.models.map((model) => model.actorFile),
    ["Common_Structures_HouseA.adr", "Common_Structures_HouseB.adr"]
  );
  assert.equal(report.models[0].worldImpactPercent, 80);
  assert.equal(report.models[0].cumulativeImpactPercent, 80);
  const validation = report.models[0].validation;
  assert.equal(validation?.kind, "standard-model-template");
  if (validation?.kind !== "standard-model-template")
    assert.fail("expected a standard model template");
  assert.equal(validation.routesPerInstance, 2);
  assert.equal(validation.forbiddenProbes, 1);
  assert.equal(validation.transitionsPerInstance, 1);
  assert.equal(report.models[0].nextAction, "run-model-validation");
  assert.equal(report.models[1].cumulativeImpactPercent, 100);
  assert.equal(report.models[1].nextAction, "author-model-template");
});

test("navigation doctor distinguishes legacy evidence from reusable templates", () => {
  const report = createNavigationDoctorReport(
    inventory(),
    [],
    [
      {
        actorFile: "Common_Structures_HouseB.adr",
        evidencePaths: ["scripts/validateHouseB.ts"],
        note: "Bespoke world-space validator"
      }
    ]
  );
  assert.equal(report.totals.templatedModels, 0);
  assert.equal(report.totals.knownValidationModels, 1);
  assert.equal(report.totals.knownValidationWorldImpactPercent, 20);
  assert.equal(report.models[1].validation?.kind, "legacy-model-validator");
  assert.equal(report.models[1].nextAction, "migrate-legacy-validator");
});

test("navigation doctor reports stale templates and renders a review table", () => {
  const stale = structuredClone(template);
  stale.actorFile = "Missing_Structure.adr";
  const report = createNavigationDoctorReport(inventory(), [
    { path: "missing.json", template: stale }
  ]);
  assert.deepEqual(report.unboundTemplates, [
    { actorFile: "Missing_Structure.adr", path: "missing.json" }
  ]);
  const markdown = renderNavigationDoctorMarkdown(report, 1);
  assert.match(markdown, /Top 1 model archetypes/);
  assert.match(markdown, /Semantics: `d{64}` \(h1sem1\)/);
  assert.match(markdown, /Common_Structures_HouseA\.adr/);
  assert.doesNotMatch(markdown, /Common_Structures_HouseB\.adr/);
  assert.match(markdown, /Missing_Structure\.adr/);
});

test("navigation doctor rejects duplicate and malformed model evidence", () => {
  assert.throws(
    () =>
      createNavigationDoctorReport(inventory(), [
        { path: "a.json", template },
        { path: "b.json", template }
      ]),
    /duplicate model template/
  );
  const malformed = inventory();
  malformed.meshes[0].instanceCount = -1;
  assert.throws(
    () => createNavigationDoctorReport(malformed, []),
    /instanceCount must be a non-negative integer/
  );
});

test("House36B evidence covers both entrances and the interior stair", () => {
  const house36B = JSON.parse(
    readFileSync("data/2016/navigationModelValidation.house36B.json", "utf8")
  ) as NavigationModelValidationTemplate;
  assert.equal(house36B.actorFile, "Common_Structures_Houses_House36B.adr");
  assert.equal(house36B.terrainProbes?.length, 2);
  assert.equal(house36B.forbiddenProbes?.length, 5);
  assert.equal(house36B.transitions?.length, 5);
  assert.equal(house36B.routes.length, 28);
  const labels = house36B.routes.map((route) =>
    String((route as { label?: unknown }).label)
  );
  assert(labels.some((label) => label.startsWith("south terrain")));
  assert(labels.some((label) => label.startsWith("north terrain")));
  assert(labels.some((label) => label.includes("interior upper flight")));
  assert(labels.some((label) => label.includes("second floor")));
});
