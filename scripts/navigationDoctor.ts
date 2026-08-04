import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  assessNavigationPreparedModels,
  createNavigationDoctorReport,
  NavigationDoctorLegacyValidation,
  NavigationDoctorTemplateSource,
  NavigationModelValidationTemplate,
  NavigationPreparedModelRun,
  NavigationUnknownInventory,
  renderNavigationDoctorMarkdown
} from "../src/utils/navigationdoctor";

type PreparedModel = NavigationPreparedModelRun & {
  templatePath: string;
  outputDirectory: string;
};

const repositoryRoot = resolve(__dirname, "..");

function values(name: string): string[] {
  const output: string[] = [];
  for (let index = 2; index < process.argv.length; index++) {
    if (process.argv[index] !== name) continue;
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`${name} requires a value`);
    output.push(value);
    index++;
  }
  return output;
}

function value(name: string): string | undefined {
  const matches = values(name);
  if (matches.length > 1) throw new Error(`${name} may be specified only once`);
  return matches[0];
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function requireFile(path: string, label: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute) || !statSync(absolute).isFile())
    throw new Error(`${label} was not found: ${absolute}`);
  return absolute;
}

function requireDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory())
    throw new Error(`${label} was not found: ${absolute}`);
  return absolute;
}

function requireOption(name: string): string {
  const configured = value(name);
  if (!configured) throw new Error(`${name} is required with --prepare`);
  return configured;
}

function jsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function defaultInventoryPath(): string {
  const candidates = [
    process.env.NAV_DOCTOR_INVENTORY,
    resolve(
      repositoryRoot,
      "../staging/navigation-doctor-current/nav-unknown-current.json"
    ),
    resolve(repositoryRoot, "../staging/nav-unknown-ranked-after-pv.json")
  ].filter((candidate): candidate is string => Boolean(candidate));
  return (
    candidates.find((candidate) => existsSync(resolve(candidate))) ??
    candidates[0]
  );
}

function loadTemplates(directory: string): NavigationDoctorTemplateSource[] {
  return readdirSync(directory)
    .filter((name) => /^navigationModelValidation\..+\.json$/i.test(name))
    .sort()
    .map((name) => {
      const path = join(directory, name);
      return {
        path: relative(repositoryRoot, path).replaceAll("\\", "/"),
        template: jsonFile<NavigationModelValidationTemplate>(path)
      };
    });
}

function loadLegacyValidations(
  directory: string
): NavigationDoctorLegacyValidation[] {
  const catalogPath = join(directory, "navigationDoctorCatalog.json");
  if (!existsSync(catalogPath)) return [];
  const catalog = jsonFile<{
    schemaVersion: number;
    legacyValidations: NavigationDoctorLegacyValidation[];
  }>(catalogPath);
  if (catalog.schemaVersion !== 1)
    throw new Error(`${catalogPath} has unsupported schemaVersion`);
  if (!Array.isArray(catalog.legacyValidations))
    throw new Error(`${catalogPath} has no legacyValidations array`);
  return catalog.legacyValidations;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function slug(actorFile: string): string {
  return actorFile
    .replace(/\.adr$/i, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLocaleLowerCase("en-US");
}

function selectedTemplates(
  templates: NavigationDoctorTemplateSource[],
  selectors: string[]
): NavigationDoctorTemplateSource[] {
  if (selectors.length === 0) return templates;
  const lowered = selectors.map((selector) =>
    selector.toLocaleLowerCase("en-US")
  );
  const selected = templates.filter(({ template }) => {
    const actor = template.actorFile.toLocaleLowerCase("en-US");
    return lowered.some((selector) => actor.includes(selector));
  });
  for (let index = 0; index < selectors.length; index++) {
    if (
      !selected.some(({ template }) =>
        template.actorFile.toLocaleLowerCase("en-US").includes(lowered[index])
      )
    )
      throw new Error(
        `--model matched no standard template: ${selectors[index]}`
      );
  }
  return selected;
}

function pythonCommand(): { command: string; prefix: string[] } {
  const configured = value("--python");
  if (configured) return { command: configured, prefix: [] };
  return process.platform === "win32"
    ? { command: "py", prefix: ["-3"] }
    : { command: "python3", prefix: [] };
}

function prepareModels(
  templates: NavigationDoctorTemplateSource[],
  collision: string,
  metadata: string,
  heightmap: string | undefined,
  workDirectory: string,
  cacheDirectory: string | undefined
): PreparedModel[] {
  const metadataValue = jsonFile<{ collisionSha256?: string }>(metadata);
  const collisionHash = sha256(collision);
  if (metadataValue.collisionSha256 !== collisionHash)
    throw new Error(
      `collision/metadata identity mismatch: ${collisionHash} != ${metadataValue.collisionSha256 ?? "missing"}`
    );

  mkdirSync(workDirectory, { recursive: true });
  const python = pythonCommand();
  const preparer = resolve(
    repositoryRoot,
    "tools/forgelight/prepare_model_instance_validation.py"
  );
  const validator = resolve(
    repositoryRoot,
    "scripts/validateModelRoutesStreaming.ts"
  );
  const prepared: PreparedModel[] = [];

  for (const source of templates) {
    const templatePath = resolve(repositoryRoot, source.path);
    const outputDirectory = join(
      workDirectory,
      slug(source.template.actorFile)
    );
    const args = [
      ...python.prefix,
      preparer,
      collision,
      metadata,
      templatePath,
      outputDirectory
    ];
    if (heightmap) args.push("--heightmap", heightmap);
    const child = spawnSync(python.command, args, {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024
    });
    if (child.status !== 0)
      throw new Error(
        `model preparation failed for ${source.template.actorFile}: ${child.stderr || child.stdout || child.error?.message}`
      );
    const outputLine = child.stdout
      .trim()
      .split(/\r?\n/)
      .findLast((line) => line.trim().startsWith("{"));
    if (!outputLine)
      throw new Error(
        `model preparation emitted no summary for ${source.template.actorFile}`
      );
    const summary = JSON.parse(outputLine) as {
      instances: number;
      skippedInstances: number;
      routes: number;
      forbiddenProbes: number;
      transitions: number;
    };
    const row: PreparedModel = {
      actorFile: source.template.actorFile,
      templatePath: source.path,
      outputDirectory,
      ...summary
    };

    if (cacheDirectory) {
      const reportPath = join(outputDirectory, "validation.json");
      if (existsSync(reportPath)) unlinkSync(reportPath);
      const validationChild = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          validator,
          cacheDirectory,
          join(outputDirectory, "routes.json"),
          "--transitions",
          join(outputDirectory, "transitions.json"),
          "--forbidden",
          join(outputDirectory, "forbidden.json"),
          "--report",
          reportPath
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          maxBuffer: 32 * 1024 * 1024
        }
      );
      if (!existsSync(reportPath))
        throw new Error(
          `model validation produced no report for ${source.template.actorFile}: ${validationChild.stderr || validationChild.stdout || validationChild.error?.message}`
        );
      row.validationExitCode = validationChild.status ?? -1;
      row.validation = jsonFile<PreparedModel["validation"]>(reportPath)!;
    }
    prepared.push(row);
  }
  return prepared;
}

function usage(): string {
  return `Navigation doctor: rank reusable building archetypes and optionally run bounded model probes.

Read-only inventory scan:
  npm run navmesh-doctor -- [--inventory <unknown-report.json>] [--limit 20]
    [--report <report.json>] [--markdown <report.md>]

Prepare and validate existing model templates:
  npm run navmesh-doctor -- --prepare --collision <z1_collision.bin>
    --metadata <z1_collision.metadata.json> --heightmap <heightmap.png>
    --work-dir <directory> [--cache-dir <collision-cache-directory>]
    [--model <actor-substring>]...

The doctor never bakes, composes, deploys, or modifies game/server files.`;
}

async function main(): Promise<void> {
  if (has("--help") || has("-h")) {
    console.log(usage());
    return;
  }
  const inventoryPath = requireFile(
    value("--inventory") ?? defaultInventoryPath(),
    "unknown-model inventory"
  );
  const templatesDirectory = requireDirectory(
    value("--templates-dir") ?? resolve(repositoryRoot, "data/2016"),
    "model template directory"
  );
  const inventory = jsonFile<NavigationUnknownInventory>(inventoryPath);
  const templates = loadTemplates(templatesDirectory);
  const report = createNavigationDoctorReport(
    inventory,
    templates,
    loadLegacyValidations(templatesDirectory)
  );
  const limit = Number(value("--limit") ?? 20);
  if (!Number.isInteger(limit) || limit <= 0)
    throw new Error("--limit must be a positive integer");

  const cacheDirectory = value("--cache-dir")
    ? requireDirectory(value("--cache-dir")!, "streaming cache")
    : undefined;
  const prepared = has("--prepare")
    ? prepareModels(
        selectedTemplates(templates, values("--model")),
        requireFile(requireOption("--collision"), "H1COL2 collision"),
        requireFile(requireOption("--metadata"), "H1COL2 metadata"),
        value("--heightmap")
          ? requireFile(value("--heightmap")!, "heightmap")
          : undefined,
        resolve(requireOption("--work-dir")),
        cacheDirectory
      )
    : [];

  const output = { ...report, preparedModels: prepared };
  const reportPath = value("--report");
  if (reportPath) {
    const absolute = resolve(reportPath);
    mkdirSync(resolve(absolute, ".."), { recursive: true });
    writeFileSync(absolute, `${JSON.stringify(output, null, 2)}\n`);
  }
  const markdownPath = value("--markdown");
  if (markdownPath) {
    const absolute = resolve(markdownPath);
    mkdirSync(resolve(absolute, ".."), { recursive: true });
    let markdown = renderNavigationDoctorMarkdown(report, limit);
    if (prepared.length) {
      markdown += [
        "## Bounded model runs",
        "",
        ...prepared.map((model) => {
          const skipped = model.skippedInstances
            ? `, ${model.skippedInstances} skipped`
            : "";
          const validation = model.validation
            ? `, ${model.validation.passed}/${model.validation.routes} routes passed, ${model.validation.forbiddenPassed}/${model.validation.forbiddenProbes} forbidden probes passed (${model.validation.forbiddenEvaluated} evaluated)`
            : "";
          return `- \`${model.actorFile}\`: ${model.instances} instances${skipped}, ${model.routes} routes prepared${validation}`;
        }),
        ""
      ].join("\n");
    }
    writeFileSync(absolute, markdown);
  }

  console.log(`[nav-doctor] inventory ${inventoryPath}`);
  console.log(
    `[nav-doctor] ${report.totals.compositeModels} composite models / ` +
      `${report.totals.compositeInstances} placements; ` +
      `${report.totals.knownValidationModels} known validators cover ` +
      `${report.totals.knownValidationWorldImpactPercent.toFixed(3)}% of world impact`
  );
  for (const model of report.models.slice(0, limit))
    console.log(
      `${String(model.rank).padStart(2)}  ${model.worldImpactPercent
        .toFixed(3)
        .padStart(7)}%  ${String(model.instances).padStart(3)}x  ` +
        `${model.validation?.kind === "standard-model-template" ? "PROBED " : model.validation?.kind === "legacy-model-validator" ? "LEGACY " : "NEEDS  "} ${model.actorFile}`
    );
  for (const model of prepared)
    console.log(
      `[nav-doctor] ${model.actorFile}: ${model.instances} instances / ` +
        `${model.routes} routes prepared` +
        (model.validation
          ? `; ${model.validation.passed}/${model.validation.routes} passed`
          : "")
    );
  const preparationFailures = assessNavigationPreparedModels(
    prepared,
    Boolean(cacheDirectory)
  );
  for (const failure of preparationFailures)
    console.error(`[nav-doctor] FAIL ${failure}`);
  if (preparationFailures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(
    `[nav-doctor] ${error instanceof Error ? error.message : error}`
  );
  console.error(usage());
  process.exit(1);
});
