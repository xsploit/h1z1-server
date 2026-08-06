import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { runNavigationCrawl } from "../src/utils/navigationcrawler";

function values(name: string): string[] {
  const result: string[] = [];
  for (let index = 2; index < process.argv.length; index++) {
    if (process.argv[index] !== name) continue;
    const entry = process.argv[index + 1];
    if (!entry || entry.startsWith("--"))
      throw new Error(`${name} requires a value`);
    result.push(entry);
    index++;
  }
  return result;
}

function value(name: string): string | undefined {
  const entries = values(name);
  if (entries.length > 1) throw new Error(`${name} may be specified only once`);
  return entries[0];
}

function required(name: string): string {
  const entry = value(name);
  if (!entry) throw new Error(`${name} is required`);
  return entry;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function usage(): string {
  return `Whole-map navigation crawler (analysis-only by default).

npm run navmesh-crawl -- --collision <z1_collision.bin> --metadata <metadata.json>
  --semantics <semantics.bin> --heightmap <heightmap.png>
  --transitions <navigationTransitions.json> --work-dir <directory>
  [--model <actor-substring>]... [--proposal-limit <n>]
  [--bake --baker <navmesh-builder>
    --runtime64-root <runtime/navigation64> --workers 2]

Analysis inventories and prepares; it never changes canonical policy. --bake
uses content-addressed regional caches and validates every known archetype.`;
}

async function main(): Promise<void> {
  if (has("--help") || has("-h")) {
    console.log(usage());
    return;
  }
  const repositoryRoot = resolve(__dirname, "..");
  const workDirectory = required("--work-dir");
  const workers = Number(value("--workers") ?? 2);
  const proposalLimit = value("--proposal-limit")
    ? Number(value("--proposal-limit"))
    : undefined;
  if (!Number.isInteger(workers) || workers <= 0)
    throw new Error("--workers must be a positive integer");
  if (
    proposalLimit !== undefined &&
    (!Number.isInteger(proposalLimit) || proposalLimit <= 0)
  )
    throw new Error("--proposal-limit must be a positive integer");
  const python = value("--python");
  if (python && (!existsSync(python) || !statSync(python).isFile()))
    throw new Error(`--python was not found: ${resolve(python)}`);
  const report = await runNavigationCrawl({
    repositoryRoot,
    collision: required("--collision"),
    metadata: required("--metadata"),
    semantics: required("--semantics"),
    heightmap: required("--heightmap"),
    transitions: required("--transitions"),
    workDirectory,
    templatesDirectory: value("--templates-dir"),
    baker: value("--baker"),
    navigationRuntimeRoot: value("--runtime64-root"),
    pythonCommand: python,
    pythonPrefix: python ? [] : undefined,
    modelSelectors: values("--model"),
    proposalLimit,
    bake: has("--bake"),
    workers
  });
  console.log(
    `[nav-crawl] mode=${report.mode} proposals=${report.totals.proposals} ` +
      `models=${report.totals.preparedModels} jobs=${report.totals.regionalJobs}`
  );
  console.log(
    `[nav-crawl] PASS=${report.totals.passedModels} ` +
      `REVIEW=${report.totals.reviewModels} BLOCKED=${report.totals.blockedModels}`
  );
  console.log(
    `[nav-crawl] report ${resolve(workDirectory, "navigation-crawl-latest.json")}`
  );
}

main().catch((error) => {
  console.error(
    `[nav-crawl] ${error instanceof Error ? error.message : error}`
  );
  console.error(usage());
  process.exit(1);
});
