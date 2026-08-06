import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const NAVIGATION_CRAWL_SCHEMA_VERSION = 1 as const;

export type NavigationCrawlDecision = "PASS" | "REVIEW" | "BLOCKED";
export type RegionalBounds = [number, number, number, number];

export interface NavigationCrawlerConfig {
  repositoryRoot: string;
  collision: string;
  metadata: string;
  semantics: string;
  heightmap: string;
  transitions: string;
  workDirectory: string;
  templatesDirectory?: string;
  baker?: string;
  navigationRuntimeRoot?: string;
  pythonCommand?: string;
  pythonPrefix?: string[];
  modelSelectors?: string[];
  proposalLimit?: number;
  bake?: boolean;
  workers?: number;
}

export interface NavigationProposalReport {
  schemaVersion: number;
  collisionSha256: string;
  semanticSidecarSha256: string;
  totals: {
    proposals: number;
    unknownTriangles: number;
    worldUnknownTriangles: number;
    decisions: Record<string, number>;
  };
  proposals: Array<{
    actorFile: string;
    kind: number;
    unknownTriangles: number;
    instanceCount: number;
    decision: NavigationCrawlDecision;
    proposalKind: string;
    riskSignals: string[];
  }>;
}

export interface PreparedNavigationModel {
  actorFile: string;
  slug: string;
  templatePath: string;
  templateSha256: string;
  outputDirectory: string;
  instances: number;
  skippedInstances: number;
  routes: number;
  forbiddenProbes: number;
  transitions: number;
}

export interface PreparedNavigationModels {
  schemaVersion: number;
  models: PreparedNavigationModel[];
}

export interface RegionalBakeInputs {
  bakerSha256: string;
  collisionSha256: string;
  semanticsSha256: string;
  heightmapSha256: string;
  transitionsSha256: string;
  profile: "human";
  agentClimb: number;
  dynamicDoorObstacles: boolean;
  bounds: RegionalBounds;
}

export interface RegionalBakeJob {
  key: string;
  actorFile: string;
  modelSlug: string;
  modelKey: string;
  instanceIndex: number;
  bounds: RegionalBounds;
  inputs: RegionalBakeInputs;
  cacheDirectory: string;
  modelInstanceDirectory: string;
  transitionsPath: string;
}

export interface RegionalBakeResult {
  key: string;
  actorFile: string;
  instanceIndex: number;
  state: "cache-hit" | "shared-hit" | "built" | "failed";
  cacheDirectory: string;
  seconds: number;
  error?: string;
}

export interface NavigationCrawlReport {
  schemaVersion: typeof NAVIGATION_CRAWL_SCHEMA_VERSION;
  mode: "analysis" | "bake";
  inputs: Record<string, string>;
  proposalReport: string;
  preparedModelsReport: string;
  totals: {
    proposals: number;
    preparedModels: number;
    regionalJobs: number;
    cacheHits: number;
    built: number;
    passedModels: number;
    reviewModels: number;
    blockedModels: number;
  };
  models: Array<{
    actorFile: string;
    decision: NavigationCrawlDecision;
    instances: number;
    routes: number;
    modelCacheRoot?: string;
    validationReport?: string;
    reason: string;
  }>;
  bakeResults: RegionalBakeResult[];
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Canonical JSON used by every content-addressed crawl identity. */
export function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const object = value as Record<string, JsonValue>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createRegionalBakeKey(inputs: RegionalBakeInputs): string {
  return sha256Text(stableStringify(inputs as unknown as JsonValue));
}

export async function sha256File(path: string): Promise<string> {
  return await new Promise((fulfill, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => fulfill(hash.digest("hex")));
  });
}

function jsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

export function bakeCacheIsComplete(
  directory: string,
  expectedKey: string
): boolean {
  if (!existsSync(directory) || !statSync(directory).isDirectory())
    return false;
  const manifestPath = join(directory, "bake-manifest.json");
  if (!isFile(manifestPath) || !isFile(join(directory, "z1_0.bin")))
    return false;
  let manifest: { schemaVersion: number; key: string };
  try {
    manifest = jsonFile(manifestPath);
  } catch {
    return false;
  }
  if (manifest.schemaVersion !== 1 || manifest.key !== expectedKey)
    return false;
  return readdirSync(directory).some((name) =>
    /^z1_cache_\d+\.bin$/i.test(name)
  );
}

/** Find a completed interrupted bake that can be promoted into the cache. */
export function findRecoverableBakeCache(
  cacheDirectory: string,
  expectedKey: string
): string | undefined {
  const parent = dirname(cacheDirectory);
  if (!existsSync(parent)) return undefined;
  const prefix = `${basename(cacheDirectory)}.tmp-`;
  return readdirSync(parent)
    .filter((name) => name.startsWith(prefix))
    .sort()
    .map((name) => join(parent, name))
    .find((candidate) => bakeCacheIsComplete(candidate, expectedKey));
}

function retryableRenameError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return ["EACCES", "EBUSY", "EPERM"].includes(String(error.code));
}

async function promoteBakeCache(
  temporary: string,
  cacheDirectory: string,
  expectedKey: string
): Promise<void> {
  const delays = [0, 25, 50, 100, 200, 400, 800];
  for (const delay of delays) {
    if (bakeCacheIsComplete(cacheDirectory, expectedKey)) return;
    if (delay > 0) await new Promise((fulfill) => setTimeout(fulfill, delay));
    try {
      renameSync(temporary, cacheDirectory);
      return;
    } catch (error) {
      if (!retryableRenameError(error) || delay === delays.at(-1)) throw error;
    }
  }
}

/** Run bounded asynchronous work while preserving input/result order. */
export async function runBounded<T, R>(
  values: T[],
  workers: number,
  operation: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isInteger(workers) || workers <= 0)
    throw new Error("workers must be a positive integer");
  const results = new Array<R>(values.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await operation(values[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(workers, values.length) }, () => worker())
  );
  return results;
}

function requireFile(path: string, label: string): string {
  const absolute = resolve(path);
  if (!isFile(absolute)) throw new Error(`${label} was not found: ${absolute}`);
  return absolute;
}

function requireDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory())
    throw new Error(`${label} was not found: ${absolute}`);
  return absolute;
}

function runChecked(command: string, arguments_: string[], cwd: string): void {
  const child = spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  if (child.status !== 0)
    throw new Error(
      `${basename(command)} exited ${child.status}: ${child.stderr || child.stdout || child.error?.message}`
    );
}

export function mergeNavigationTransitions(
  base: unknown[],
  model: unknown[]
): unknown[] {
  if (!Array.isArray(base) || !Array.isArray(model))
    throw new Error("navigation transitions must be JSON arrays");
  const result: unknown[] = [];
  const identities = new Map<string, string>();
  for (const transition of [...base, ...model]) {
    if (
      !transition ||
      typeof transition !== "object" ||
      Array.isArray(transition)
    )
      throw new Error("navigation transition entries must be objects");
    const runtimeTransition = Object.fromEntries(
      Object.entries(transition).filter(([field]) =>
        [
          "name",
          "kind",
          "source",
          "start",
          "end",
          "radius",
          "bidirectional"
        ].includes(field)
      )
    );
    const encoded = stableStringify(runtimeTransition as JsonValue);
    const name =
      "name" in runtimeTransition && typeof runtimeTransition.name === "string"
        ? runtimeTransition.name
        : undefined;
    const key = name ? `name:${name}` : `value:${encoded}`;
    const comparison = encoded;
    const previous = identities.get(key);
    if (previous === comparison) continue;
    if (previous !== undefined)
      throw new Error(`conflicting navigation transition identity ${key}`);
    identities.set(key, comparison);
    result.push(runtimeTransition);
  }
  return result;
}

function mergeTransitions(
  basePath: string,
  modelPath: string,
  output: string
): void {
  writeJson(
    output,
    mergeNavigationTransitions(
      jsonFile<unknown[]>(basePath),
      jsonFile<unknown[]>(modelPath)
    )
  );
}

function hardlinkOrCopy(source: string, destination: string): void {
  if (existsSync(destination)) return;
  try {
    linkSync(source, destination);
  } catch {
    copyFileSync(source, destination);
  }
}

function materializeModelView(job: RegionalBakeJob): void {
  mkdirSync(job.modelInstanceDirectory, { recursive: true });
  for (const name of readdirSync(job.cacheDirectory)) {
    if (!/^z1(?:_cache)?_\d+\.bin$/i.test(name)) continue;
    hardlinkOrCopy(
      join(job.cacheDirectory, name),
      join(job.modelInstanceDirectory, name)
    );
  }
}

function bakeOne(
  job: RegionalBakeJob,
  baker: string,
  collision: string,
  semantics: string,
  heightmap: string,
  repositoryRoot: string
): Promise<RegionalBakeResult> {
  const started = Date.now();
  if (bakeCacheIsComplete(job.cacheDirectory, job.key)) {
    materializeModelView(job);
    return Promise.resolve({
      key: job.key,
      actorFile: job.actorFile,
      instanceIndex: job.instanceIndex,
      state: "cache-hit",
      cacheDirectory: job.cacheDirectory,
      seconds: 0
    });
  }
  if (existsSync(job.cacheDirectory))
    return Promise.resolve({
      key: job.key,
      actorFile: job.actorFile,
      instanceIndex: job.instanceIndex,
      state: "failed",
      cacheDirectory: job.cacheDirectory,
      seconds: 0,
      error: "content-addressed cache directory exists but is incomplete"
    });

  mkdirSync(resolve(job.cacheDirectory, ".."), { recursive: true });
  const recoverable = findRecoverableBakeCache(job.cacheDirectory, job.key);
  if (recoverable) {
    return promoteBakeCache(recoverable, job.cacheDirectory, job.key)
      .then(() => {
        materializeModelView(job);
        return {
          key: job.key,
          actorFile: job.actorFile,
          instanceIndex: job.instanceIndex,
          state: "cache-hit" as const,
          cacheDirectory: job.cacheDirectory,
          seconds: (Date.now() - started) / 1000
        };
      })
      .catch((error: unknown) => ({
        key: job.key,
        actorFile: job.actorFile,
        instanceIndex: job.instanceIndex,
        state: "failed" as const,
        cacheDirectory: job.cacheDirectory,
        seconds: (Date.now() - started) / 1000,
        error: `failed to recover completed bake ${recoverable}: ${error instanceof Error ? error.message : String(error)}`
      }));
  }
  const temporary = `${job.cacheDirectory}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  mkdirSync(temporary, { recursive: true });
  const logPath = join(temporary, "bake.log");
  const descriptor = openSync(logPath, "a");
  const [minX, minZ, maxX, maxZ] = job.bounds;
  const arguments_ = [
    "placeholder.obj",
    join(temporary, "nav.bin"),
    "--profile",
    "human",
    "--agent-climb",
    "1.3",
    "--dynamic-door-obstacles",
    "--geometry-source",
    "forgelight",
    "--forgelight-collision",
    collision,
    "--forgelight-semantics",
    semantics,
    "--forgelight-heightmap",
    heightmap,
    "--forgelight-transitions",
    job.transitionsPath,
    "--global-bounds",
    String(minX),
    "-100",
    String(minZ),
    String(maxX),
    "500",
    String(maxZ)
  ];
  return new Promise((fulfill) => {
    let settled = false;
    let descriptorClosed = false;
    const closeDescriptor = (): void => {
      if (descriptorClosed) return;
      descriptorClosed = true;
      closeSync(descriptor);
    };
    const finish = (result: RegionalBakeResult): void => {
      if (settled) return;
      settled = true;
      closeDescriptor();
      fulfill(result);
    };
    const child = spawn(baker, arguments_, {
      cwd: repositoryRoot,
      windowsHide: true,
      stdio: ["ignore", descriptor, descriptor]
    });
    child.on("error", (error) => {
      finish({
        key: job.key,
        actorFile: job.actorFile,
        instanceIndex: job.instanceIndex,
        state: "failed",
        cacheDirectory: job.cacheDirectory,
        seconds: (Date.now() - started) / 1000,
        error: error.message
      });
    });
    child.on("close", async (code) => {
      if (settled) return;
      if (code !== 0) {
        finish({
          key: job.key,
          actorFile: job.actorFile,
          instanceIndex: job.instanceIndex,
          state: "failed",
          cacheDirectory: job.cacheDirectory,
          seconds: (Date.now() - started) / 1000,
          error: `baker exited ${code}; see ${logPath}`
        });
        return;
      }
      writeJson(join(temporary, "bake-manifest.json"), {
        schemaVersion: 1,
        key: job.key,
        actorFile: job.actorFile,
        instanceIndex: job.instanceIndex,
        inputs: job.inputs
      });
      if (!bakeCacheIsComplete(temporary, job.key)) {
        finish({
          key: job.key,
          actorFile: job.actorFile,
          instanceIndex: job.instanceIndex,
          state: "failed",
          cacheDirectory: job.cacheDirectory,
          seconds: (Date.now() - started) / 1000,
          error: `baker exited successfully but cache outputs are incomplete: ${temporary}`
        });
        return;
      }
      // Windows will not rename a directory while this process still holds its
      // bake.log descriptor. Close it before cache promotion, then tolerate a
      // short-lived scanner/AV handle with bounded retries.
      closeDescriptor();
      try {
        await promoteBakeCache(temporary, job.cacheDirectory, job.key);
        materializeModelView(job);
        finish({
          key: job.key,
          actorFile: job.actorFile,
          instanceIndex: job.instanceIndex,
          state: "built",
          cacheDirectory: job.cacheDirectory,
          seconds: (Date.now() - started) / 1000
        });
      } catch (error) {
        finish({
          key: job.key,
          actorFile: job.actorFile,
          instanceIndex: job.instanceIndex,
          state: "failed",
          cacheDirectory: job.cacheDirectory,
          seconds: (Date.now() - started) / 1000,
          error: `failed to promote completed bake ${temporary}: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    });
  });
}

async function buildInputHashes(config: NavigationCrawlerConfig) {
  const [
    collisionSha256,
    metadataSha256,
    semanticsSha256,
    heightmapSha256,
    transitionsSha256
  ] = await Promise.all([
    sha256File(config.collision),
    sha256File(config.metadata),
    sha256File(config.semantics),
    sha256File(config.heightmap),
    sha256File(config.transitions)
  ]);
  const navigationRuntimeCoreSha256 = config.navigationRuntimeRoot
    ? await sha256File(join(config.navigationRuntimeRoot, "core.mjs"))
    : undefined;
  const navigationRuntimeWasmSha256 = config.navigationRuntimeRoot
    ? await sha256File(join(config.navigationRuntimeRoot, "wasm-compat.mjs"))
    : undefined;
  return {
    collisionSha256,
    metadataSha256,
    semanticsSha256,
    heightmapSha256,
    transitionsSha256,
    ...(navigationRuntimeCoreSha256 && navigationRuntimeWasmSha256
      ? { navigationRuntimeCoreSha256, navigationRuntimeWasmSha256 }
      : {})
  };
}

function templatePaths(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => /^navigationModelValidation\..+\.json$/i.test(name))
    .sort()
    .map((name) => join(directory, name));
}

function readBakes(model: PreparedNavigationModel): Array<{
  instanceIndex: number;
  bounds: RegionalBounds;
}> {
  return jsonFile(join(model.outputDirectory, "bakes.json"));
}

async function planJobs(
  config: NavigationCrawlerConfig,
  models: PreparedNavigationModel[],
  hashes: Awaited<ReturnType<typeof buildInputHashes>>,
  bakerSha256: string
): Promise<RegionalBakeJob[]> {
  const jobs: RegionalBakeJob[] = [];
  for (const model of models) {
    const mergedTransitions = join(
      config.workDirectory,
      "transitions",
      `${model.slug}-${model.templateSha256.slice(0, 12)}.json`
    );
    mergeTransitions(
      config.transitions,
      join(model.outputDirectory, "transitions.json"),
      mergedTransitions
    );
    const transitionsSha256 = await sha256File(mergedTransitions);
    const modelKey = sha256Text(
      stableStringify({
        collisionSha256: hashes.collisionSha256,
        bakerSha256,
        semanticsSha256: hashes.semanticsSha256,
        heightmapSha256: hashes.heightmapSha256,
        transitionsSha256,
        navigationRuntimeCoreSha256: hashes.navigationRuntimeCoreSha256 ?? null,
        navigationRuntimeWasmSha256: hashes.navigationRuntimeWasmSha256 ?? null,
        templateSha256: model.templateSha256,
        profile: "human",
        agentClimb: 1.3,
        dynamicDoorObstacles: true
      })
    );
    for (const bake of readBakes(model)) {
      const inputs: RegionalBakeInputs = {
        bakerSha256,
        collisionSha256: hashes.collisionSha256,
        semanticsSha256: hashes.semanticsSha256,
        heightmapSha256: hashes.heightmapSha256,
        transitionsSha256,
        profile: "human",
        agentClimb: 1.3,
        dynamicDoorObstacles: true,
        bounds: bake.bounds
      };
      const key = createRegionalBakeKey(inputs);
      jobs.push({
        key,
        actorFile: model.actorFile,
        modelSlug: model.slug,
        modelKey,
        instanceIndex: bake.instanceIndex,
        bounds: bake.bounds,
        inputs,
        cacheDirectory: join(config.workDirectory, "cache", key),
        modelInstanceDirectory: join(
          config.workDirectory,
          "models",
          model.slug,
          modelKey,
          String(bake.instanceIndex)
        ),
        transitionsPath: mergedTransitions
      });
    }
  }
  return jobs;
}

function validateModel(
  config: NavigationCrawlerConfig,
  model: PreparedNavigationModel,
  modelJobs: RegionalBakeJob[]
): { decision: NavigationCrawlDecision; report?: string; reason: string } {
  if (modelJobs.length === 0)
    return {
      decision: "BLOCKED",
      reason: "no regional bake jobs were prepared"
    };
  const modelRoot = resolve(modelJobs[0].modelInstanceDirectory, "..");
  const report = join(modelRoot, "validation.json");
  const validator = join(
    config.repositoryRoot,
    "scripts",
    "validateModelRoutesStreaming.ts"
  );
  const childArguments = [
    "--import",
    "tsx",
    validator,
    modelRoot,
    join(model.outputDirectory, "routes.json"),
    "--transitions",
    modelJobs[0].transitionsPath,
    "--forbidden",
    join(model.outputDirectory, "forbidden.json"),
    "--report",
    report
  ];
  if (config.navigationRuntimeRoot)
    childArguments.push("--runtime64-root", config.navigationRuntimeRoot);
  const child = spawnSync(process.execPath, childArguments, {
    cwd: config.repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  if (child.status !== 0 || !isFile(report))
    return {
      decision: "BLOCKED",
      report: isFile(report) ? report : undefined,
      reason: `streaming route validation failed (exit ${child.status})`
    };
  return {
    decision: "PASS",
    report,
    reason: "all route and forbidden probes passed"
  };
}

/**
 * Deep orchestration module for the whole-map navigation crawl. The CLI is an
 * adapter; all identity, resume, scheduling, and admission-state logic lives
 * here so the pipeline has one deterministic source of truth.
 */
export async function runNavigationCrawl(
  configured: NavigationCrawlerConfig
): Promise<NavigationCrawlReport> {
  if (configured.bake && !configured.navigationRuntimeRoot)
    throw new Error(
      "navigationRuntimeRoot is required for bake validation so results cannot silently use the stock runtime"
    );
  const config: NavigationCrawlerConfig = {
    ...configured,
    repositoryRoot: requireDirectory(configured.repositoryRoot, "repository"),
    collision: requireFile(configured.collision, "H1COL2 collision"),
    metadata: requireFile(configured.metadata, "H1COL2 metadata"),
    semantics: requireFile(configured.semantics, "H1SEM1 semantics"),
    heightmap: requireFile(configured.heightmap, "heightmap"),
    transitions: requireFile(configured.transitions, "navigation transitions"),
    navigationRuntimeRoot: configured.navigationRuntimeRoot
      ? requireDirectory(
          configured.navigationRuntimeRoot,
          "navigation64 runtime"
        )
      : undefined,
    workDirectory: resolve(configured.workDirectory),
    templatesDirectory: requireDirectory(
      configured.templatesDirectory ??
        join(configured.repositoryRoot, "data", "2016"),
      "navigation templates"
    ),
    workers: configured.workers ?? 2
  };
  mkdirSync(config.workDirectory, { recursive: true });
  const hashes = await buildInputHashes(config);
  const templateDigests = await Promise.all(
    templatePaths(config.templatesDirectory!).map(sha256File)
  );
  const analysisKey = sha256Text(
    stableStringify({
      ...hashes,
      templateDigests,
      modelSelectors: config.modelSelectors ?? [],
      proposalLimit: config.proposalLimit ?? null
    } as JsonValue)
  );
  const analysisDirectory = join(config.workDirectory, "analysis", analysisKey);
  mkdirSync(analysisDirectory, { recursive: true });
  const proposalPath = join(analysisDirectory, "proposals.json");
  const python =
    config.pythonCommand ?? (process.platform === "win32" ? "py" : "python3");
  const pythonPrefix =
    config.pythonPrefix ?? (process.platform === "win32" ? ["-3"] : []);
  if (!isFile(proposalPath)) {
    const arguments_ = [
      ...pythonPrefix,
      join(
        config.repositoryRoot,
        "tools",
        "forgelight",
        "propose_navigation_archetypes.py"
      ),
      config.collision,
      config.metadata,
      config.semantics,
      "--json",
      proposalPath
    ];
    if (config.proposalLimit)
      arguments_.push("--limit", String(config.proposalLimit));
    runChecked(python, arguments_, config.repositoryRoot);
  }
  const proposals = jsonFile<NavigationProposalReport>(proposalPath);
  if (
    proposals.schemaVersion !== 1 ||
    proposals.collisionSha256 !== hashes.collisionSha256 ||
    proposals.semanticSidecarSha256 !== hashes.semanticsSha256
  )
    throw new Error("proposal artifact does not match crawl inputs");

  const preparationKey = sha256Text(
    stableStringify({
      collisionSha256: hashes.collisionSha256,
      metadataSha256: hashes.metadataSha256,
      heightmapSha256: hashes.heightmapSha256,
      templateDigests,
      modelSelectors: config.modelSelectors ?? []
    } as JsonValue)
  );
  const preparationDirectory = join(
    config.workDirectory,
    "prepared",
    preparationKey
  );
  const preparedPath = join(preparationDirectory, "prepared-models.json");
  if (!isFile(preparedPath)) {
    const arguments_ = [
      ...pythonPrefix,
      join(
        config.repositoryRoot,
        "tools",
        "forgelight",
        "prepare_navigation_crawl.py"
      ),
      config.collision,
      config.metadata,
      config.templatesDirectory!,
      preparationDirectory,
      "--heightmap",
      config.heightmap
    ];
    for (const selector of config.modelSelectors ?? [])
      arguments_.push("--model", selector);
    runChecked(python, arguments_, config.repositoryRoot);
  }
  const prepared = jsonFile<PreparedNavigationModels>(preparedPath);
  if (prepared.schemaVersion !== 1)
    throw new Error("prepared model artifact has unsupported schemaVersion");

  let jobs: RegionalBakeJob[] = [];
  let bakeResults: RegionalBakeResult[] = [];
  const models: NavigationCrawlReport["models"] = prepared.models.map(
    (model) => ({
      actorFile: model.actorFile,
      decision: "REVIEW",
      instances: model.instances,
      routes: model.routes,
      reason:
        "prepared deterministically; regional bake and validation not requested"
    })
  );
  if (config.bake) {
    const baker = requireFile(config.baker ?? "", "navmesh builder");
    const bakerSha256 = await sha256File(baker);
    jobs = await planJobs(config, prepared.models, hashes, bakerSha256);
    const uniqueJobs = [
      ...new Map(jobs.map((job) => [job.key, job] as const)).values()
    ];
    console.log(
      `[nav-crawl] regional queue logical=${jobs.length} unique=${uniqueJobs.length} workers=${config.workers}`
    );
    const uniqueResults = await runBounded(
      uniqueJobs,
      config.workers!,
      async (job, index) => {
        console.log(
          `[nav-crawl] regional ${index + 1}/${uniqueJobs.length} start ${job.actorFile} #${job.instanceIndex}`
        );
        const result = await bakeOne(
          job,
          baker,
          config.collision,
          config.semantics,
          config.heightmap,
          config.repositoryRoot
        );
        console.log(
          `[nav-crawl] regional ${index + 1}/${uniqueJobs.length} ${result.state} ${result.seconds.toFixed(1)}s ${job.actorFile} #${job.instanceIndex}`
        );
        return result;
      }
    );
    const resultByKey = new Map(
      uniqueResults.map((result) => [result.key, result] as const)
    );
    const firstLogicalByKey = new Set<string>();
    bakeResults = jobs.map((job) => {
      const source = resultByKey.get(job.key)!;
      const first = !firstLogicalByKey.has(job.key);
      firstLogicalByKey.add(job.key);
      if (source.state !== "failed") materializeModelView(job);
      return {
        ...source,
        actorFile: job.actorFile,
        instanceIndex: job.instanceIndex,
        state: !first && source.state !== "failed" ? "shared-hit" : source.state
      };
    });
    for (const model of models) {
      const modelJobs = jobs.filter((job) => job.actorFile === model.actorFile);
      const modelResults = bakeResults.filter(
        (result) => result.actorFile === model.actorFile
      );
      const failed = modelResults.filter((result) => result.state === "failed");
      if (failed.length) {
        model.decision = "BLOCKED";
        model.reason = `${failed.length}/${modelResults.length} regional bakes failed`;
        continue;
      }
      const validation = validateModel(
        config,
        prepared.models.find((entry) => entry.actorFile === model.actorFile)!,
        modelJobs
      );
      model.decision = validation.decision;
      model.reason = validation.reason;
      model.validationReport = validation.report;
      model.modelCacheRoot = modelJobs.length
        ? resolve(modelJobs[0].modelInstanceDirectory, "..")
        : undefined;
    }
  }

  const report: NavigationCrawlReport = {
    schemaVersion: NAVIGATION_CRAWL_SCHEMA_VERSION,
    mode: config.bake ? "bake" : "analysis",
    inputs: { ...hashes },
    proposalReport: proposalPath,
    preparedModelsReport: preparedPath,
    totals: {
      proposals: proposals.totals.proposals,
      preparedModels: prepared.models.length,
      regionalJobs: jobs.length,
      cacheHits: bakeResults.filter(
        (result) =>
          result.state === "cache-hit" || result.state === "shared-hit"
      ).length,
      built: bakeResults.filter((result) => result.state === "built").length,
      passedModels: models.filter((model) => model.decision === "PASS").length,
      reviewModels: models.filter((model) => model.decision === "REVIEW")
        .length,
      blockedModels: models.filter((model) => model.decision === "BLOCKED")
        .length
    },
    models,
    bakeResults
  };
  writeJson(join(config.workDirectory, "navigation-crawl-latest.json"), report);
  return report;
}
