import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { join, resolve } from "node:path";
import { runNavigationCrawl, sha256File } from "../src/utils/navigationcrawler";

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

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function usage(): string {
  return `One-command navigation campaign runner.

npm run navmesh-campaign -- [--bake] [--model <actor-substring>]...
  [--bundle <H1COL2-directory>] [--heightmap <heightmap.png>]
  [--baker <navmesh-builder.exe>] [--work-dir <directory>]
  [--runtime64-root <runtime/navigation64>] [--workers 2]

The default mode is analysis-only. It regenerates a candidate H1SEM1 sidecar
from the committed policy, inventories unknown geometry, prepares every known
building template, and resumes content-addressed regional work. --bake adds
regional baking and route/forbidden-probe validation. It never edits policy,
performs a full-map bake, deploys files, or starts the game/server.`;
}

async function main(): Promise<void> {
  if (has("--help") || has("-h")) {
    console.log(usage());
    return;
  }

  const repositoryRoot = resolve(__dirname, "..");
  const workspaceRoot = resolve(repositoryRoot, "..");
  const bundle = requireDirectory(
    value("--bundle") ??
      join(workspaceRoot, "staging", "h1col2-house34b-v3-thresholds"),
    "H1COL2 bundle"
  );
  const collision = requireFile(
    join(bundle, "z1_collision.bin"),
    "H1COL2 collision"
  );
  const metadata = requireFile(
    join(bundle, "z1_collision.metadata.json"),
    "H1COL2 metadata"
  );
  const heightmap = requireFile(
    value("--heightmap") ??
      join(
        workspaceRoot,
        "h1z1-server",
        "data",
        "2016",
        "zoneData",
        "heightmap.png"
      ),
    "heightmap"
  );
  const transitions = requireFile(
    value("--transitions") ??
      join(repositoryRoot, "data", "2016", "navigationTransitions.json"),
    "navigation transitions"
  );
  const policy = requireFile(
    value("--policy") ??
      join(
        repositoryRoot,
        "tools",
        "forgelight",
        "policies",
        "z1_collision.semantic_policy.json"
      ),
    "semantic policy"
  );
  const workDirectory = resolve(
    value("--work-dir") ??
      join(workspaceRoot, "staging", "navigation-campaign-current")
  );
  const workers = Number(value("--workers") ?? 2);
  if (!Number.isInteger(workers) || workers <= 0)
    throw new Error("--workers must be a positive integer");
  mkdirSync(workDirectory, { recursive: true });

  const eventLog = join(workDirectory, "navigation-campaign.log");
  const originalLog = console.log.bind(console);
  const originalError = console.error.bind(console);
  const persist = (stream: "OUT" | "ERR", entries: unknown[]): void => {
    const message = entries.map((entry) => String(entry)).join(" ");
    appendFileSync(
      eventLog,
      `${new Date().toISOString()} ${stream} ${message}\n`,
      "utf8"
    );
  };
  console.log = (...entries: unknown[]): void => {
    persist("OUT", entries);
    originalLog(...entries);
  };
  console.error = (...entries: unknown[]): void => {
    persist("ERR", entries);
    originalError(...entries);
  };

  console.log(
    `[nav-campaign] start mode=${has("--bake") ? "bake" : "analysis"}`
  );
  console.log(`[nav-campaign] bundle ${bundle}`);

  const inputsDirectory = join(workDirectory, "inputs");
  mkdirSync(inputsDirectory, { recursive: true });
  const temporarySemantics = join(
    inputsDirectory,
    `candidate-semantics.tmp-${process.pid}.bin`
  );
  const python = process.platform === "win32" ? "py" : "python3";
  const pythonPrefix = process.platform === "win32" ? ["-3"] : [];
  const reclassify = spawnSync(
    python,
    [
      ...pythonPrefix,
      join(
        repositoryRoot,
        "tools",
        "forgelight",
        "reclassify_h1col2_semantics.py"
      ),
      "--collision",
      collision,
      "--metadata",
      metadata,
      "--policy",
      policy,
      "--output",
      temporarySemantics
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024
    }
  );
  if (reclassify.status !== 0)
    throw new Error(
      `semantic reclassification exited ${reclassify.status}: ${reclassify.stderr || reclassify.stdout || reclassify.error?.message}`
    );
  const semanticsHash = sha256(temporarySemantics);
  const semantics = join(
    inputsDirectory,
    `candidate-semantics-${semanticsHash}.bin`
  );
  if (existsSync(semantics)) unlinkSync(temporarySemantics);
  else renameSync(temporarySemantics, semantics);
  console.log(`[nav-campaign] semantics ${semanticsHash}`);

  const bake = has("--bake");
  const baker = bake
    ? requireFile(
        value("--baker") ??
          join(
            workspaceRoot,
            "h1emu-recast",
            "build",
            "Release",
            "navmesh-builder.exe"
          ),
        "navmesh builder"
      )
    : undefined;
  const runtimeArgument = value("--runtime64-root");
  if (bake && !runtimeArgument)
    throw new Error(
      "--runtime64-root is required with --bake so validation uses the exact target runtime"
    );
  const navigationRuntimeRoot = runtimeArgument
    ? requireDirectory(runtimeArgument, "navigation64 runtime")
    : undefined;
  const runtimeCore = navigationRuntimeRoot
    ? requireFile(join(navigationRuntimeRoot, "core.mjs"), "runtime core")
    : undefined;
  const runtimeWasm = navigationRuntimeRoot
    ? requireFile(
        join(navigationRuntimeRoot, "wasm-compat.mjs"),
        "runtime WASM module"
      )
    : undefined;

  const manifestPath = join(workDirectory, "navigation-campaign-inputs.json");
  writeJson(manifestPath, {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: bake ? "bake" : "analysis",
    inputs: {
      bundle,
      collision,
      collisionSha256: await sha256File(collision),
      metadata,
      metadataSha256: await sha256File(metadata),
      policy,
      policySha256: await sha256File(policy),
      semantics,
      semanticsSha256: semanticsHash,
      heightmap,
      heightmapSha256: await sha256File(heightmap),
      transitions,
      transitionsSha256: await sha256File(transitions),
      baker,
      bakerSha256: baker ? await sha256File(baker) : null,
      navigationRuntimeRoot,
      navigationRuntimeCoreSha256: runtimeCore
        ? await sha256File(runtimeCore)
        : null,
      navigationRuntimeWasmSha256: runtimeWasm
        ? await sha256File(runtimeWasm)
        : null
    },
    selectors: values("--model"),
    workers
  });

  const report = await runNavigationCrawl({
    repositoryRoot,
    collision,
    metadata,
    semantics,
    heightmap,
    transitions,
    workDirectory,
    baker,
    navigationRuntimeRoot,
    modelSelectors: values("--model"),
    bake,
    workers
  });
  console.log(
    `[nav-campaign] complete models=${report.totals.preparedModels} ` +
      `PASS=${report.totals.passedModels} REVIEW=${report.totals.reviewModels} ` +
      `BLOCKED=${report.totals.blockedModels}`
  );
  console.log(
    `[nav-campaign] report ${join(workDirectory, "navigation-crawl-latest.json")}`
  );
  console.log(`[nav-campaign] log ${eventLog}`);
  console.log(`[nav-campaign] input manifest ${manifestPath}`);
}

main().catch((error) => {
  console.error(
    `[nav-campaign] ${error instanceof Error ? error.message : error}`
  );
  console.error(usage());
  process.exit(1);
});
