import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveModelInstanceCacheDirectory } from "../src/utils/modelroutevalidation";

type Route = {
  instance?: number;
  instanceIndex?: number;
  label?: string;
  start: [number, number, number];
  end: [number, number, number];
};

type ForbiddenProbe = {
  instanceIndex: number;
  label: string;
  position: [number, number, number];
  halfExtents: [number, number, number];
};

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const cacheDir = process.argv[2];
const reportPath = option("--report");
const transitionsPath = option("--transitions");
const forbiddenPath = option("--forbidden");
const valueOptions = new Set(["--report", "--transitions", "--forbidden"]);
const routeFiles = process.argv
  .slice(3)
  .filter((argument, index, arguments_) => {
    if (valueOptions.has(argument)) return false;
    if (index > 0 && valueOptions.has(arguments_[index - 1])) return false;
    return true;
  });

if (!cacheDir || routeFiles.length === 0) {
  console.error(
    "Usage: npx tsx scripts/validateModelRoutesStreaming.ts <cache-dir> <routes.json> [...] [--report <report.json>] [--transitions <transitions.json>] [--forbidden <forbidden.json>]"
  );
  process.exit(1);
}

function routeInstance(route: Route): number {
  const instance = route.instance ?? route.instanceIndex;
  if (!Number.isInteger(instance))
    throw new Error("route has no instance index");
  return instance!;
}

async function main() {
  const routes = routeFiles.flatMap(
    (path) => JSON.parse(readFileSync(resolve(path), "utf8")) as Route[]
  );
  if (routes.length === 0) throw new Error("no model routes were provided");
  const routesByInstance = new Map<number, Route[]>();
  for (const route of routes) {
    const instance = routeInstance(route);
    const instanceRoutes = routesByInstance.get(instance) ?? [];
    instanceRoutes.push(route);
    routesByInstance.set(instance, instanceRoutes);
  }
  const forbiddenProbes = forbiddenPath
    ? (JSON.parse(
        readFileSync(resolve(forbiddenPath), "utf8")
      ) as ForbiddenProbe[])
    : [];
  const forbiddenByInstance = new Map<number, ForbiddenProbe[]>();
  for (const probe of forbiddenProbes) {
    if (!Number.isInteger(probe.instanceIndex))
      throw new Error("forbidden probe has no instance index");
    if (!routesByInstance.has(probe.instanceIndex))
      throw new Error(
        `forbidden probe targets unvalidated instance ${probe.instanceIndex}`
      );
    const entries = forbiddenByInstance.get(probe.instanceIndex) ?? [];
    entries.push(probe);
    forbiddenByInstance.set(probe.instanceIndex, entries);
  }

  // A mutable Detour runtime is intentionally not reused across distant model
  // instances. Repeatedly removing and rebuilding thousands of streamed
  // columns eventually exhausts the WASM tile allocator and reports false
  // DT_OUT_OF_MEMORY failures. Each child gets the exact production streaming
  // loader with a clean bounded runtime, matching a player visiting one POI.
  const failures: unknown[] = [];
  const forbiddenFailures: unknown[] = [];
  const forbiddenUnverified: unknown[] = [];
  let checkedRoutes = 0;
  let evaluatedForbiddenProbes = 0;
  const cacheDirectories: Record<string, string> = {};
  const tempRoot = mkdtempSync(join(tmpdir(), "h1emu-nav-routes-"));
  try {
    let completed = 0;
    for (const [instance, instanceRoutes] of [...routesByInstance].sort(
      ([left], [right]) => left - right
    )) {
      const routesPath = join(tempRoot, `${instance}.routes.json`);
      const instanceReportPath = join(tempRoot, `${instance}.report.json`);
      const instanceCacheDirectory = resolveModelInstanceCacheDirectory(
        cacheDir,
        instance
      );
      cacheDirectories[String(instance)] = instanceCacheDirectory;
      writeFileSync(routesPath, JSON.stringify(instanceRoutes));
      const childArguments = [
        "--import",
        "tsx",
        resolve(__dirname, "validateModelInstanceStreaming.ts"),
        instanceCacheDirectory,
        routesPath,
        String(instance),
        "--report",
        instanceReportPath
      ];
      if (transitionsPath)
        childArguments.push("--transitions", resolve(transitionsPath));
      if (forbiddenPath)
        childArguments.push("--forbidden", resolve(forbiddenPath));
      const child = spawnSync(process.execPath, childArguments, {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024
      });
      if (!existsSync(instanceReportPath)) {
        throw new Error(
          `streaming validator failed for instance ${instance}: ${
            child.error?.message ?? child.stderr ?? child.stdout
          }`
        );
      }
      const result = JSON.parse(readFileSync(instanceReportPath, "utf8")) as {
        routes: number;
        failures: unknown[];
        forbiddenProbes: number;
        forbiddenEvaluated: number;
        forbiddenFailures: unknown[];
        forbiddenUnverified: unknown[];
        meshPresent: boolean;
      };
      const expectedForbidden = forbiddenByInstance.get(instance)?.length ?? 0;
      if (result.forbiddenProbes !== expectedForbidden)
        throw new Error(
          `instance ${instance} received ${result.forbiddenProbes}/${expectedForbidden} forbidden probes`
        );
      checkedRoutes += result.routes;
      failures.push(...result.failures);
      evaluatedForbiddenProbes += result.forbiddenEvaluated;
      forbiddenFailures.push(...result.forbiddenFailures);
      forbiddenUnverified.push(...result.forbiddenUnverified);
      completed++;
      if (completed % 10 === 0 || completed === routesByInstance.size) {
        console.error(
          `[model-routes] ${completed}/${routesByInstance.size} instances, ${checkedRoutes - failures.length}/${checkedRoutes} routes passed`
        );
      }
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }

  const summary = {
    cacheDirectory: resolve(cacheDir),
    cacheDirectories,
    routeFiles: routeFiles.map((path) => resolve(path)),
    instances: routesByInstance.size,
    routes: checkedRoutes,
    passed: checkedRoutes - failures.length,
    failures,
    forbiddenProbes: forbiddenProbes.length,
    forbiddenEvaluated: evaluatedForbiddenProbes,
    forbiddenPassed: evaluatedForbiddenProbes - forbiddenFailures.length,
    forbiddenFailures,
    forbiddenUnverified
  };
  const encoded = `${JSON.stringify(summary, null, 2)}\n`;
  if (reportPath) writeFileSync(resolve(reportPath), encoded);
  console.log(encoded);
  if (
    failures.length ||
    forbiddenFailures.length ||
    forbiddenUnverified.length ||
    evaluatedForbiddenProbes !== forbiddenProbes.length
  )
    process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
