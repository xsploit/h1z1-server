import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

type RuntimeFileRecord = {
  path: string;
  size: number;
  sha256: string;
};

function option(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) {
    throw new Error(`missing required option ${name}`);
  }
  return process.argv[index + 1];
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function gitHead(root: string): string {
  const trackedChanges = execFileSync(
    "git",
    ["-C", root, "status", "--porcelain", "--untracked-files=no"],
    { encoding: "utf8" }
  ).trim();
  if (trackedChanges) {
    throw new Error(
      "recast-navigation source has tracked changes; commit or restore them before packaging"
    );
  }
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8"
  }).trim();
}

function assertSourceWithinRoot(
  sourcePath: string,
  sourceRoot: string,
  label: string
): void {
  const relativePath = relative(sourceRoot, sourcePath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`${label} is outside the recast-navigation source root`);
  }
}

async function assertPolyRef64(corePath: string, wasmPath: string) {
  const cacheBust = `?artifact-check=${Date.now()}`;
  const [core, wasm] = await Promise.all([
    import(`${pathToFileURL(corePath).href}${cacheBust}`),
    import(`${pathToFileURL(wasmPath).href}${cacheBust}`)
  ]);
  if (typeof core.init !== "function" || typeof wasm.default !== "function") {
    throw new Error("navigation runtime modules have invalid exports");
  }
  await core.init(wasm.default);
  if (
    typeof core.uses64BitPolyRefs !== "function" ||
    !core.uses64BitPolyRefs()
  ) {
    throw new Error(
      "navigation runtime was not built with 64-bit polygon refs"
    );
  }
}

async function main() {
  const coreSource = resolve(option("--core-module"));
  const wasmSource = resolve(option("--wasm-module"));
  const outputRoot = resolve(option("--output-root"));
  const recastRoot = resolve(option("--recast-navigation-root"));
  assertSourceWithinRoot(coreSource, recastRoot, "core module");
  assertSourceWithinRoot(wasmSource, recastRoot, "WASM module");
  for (const source of [coreSource, wasmSource]) {
    if (!existsSync(source))
      throw new Error(`runtime source is missing: ${source}`);
  }
  if (existsSync(outputRoot)) {
    throw new Error(`output root already exists: ${outputRoot}`);
  }

  await assertPolyRef64(coreSource, wasmSource);

  const runtimeRoot = join(outputRoot, "runtime", "navigation64");
  mkdirSync(runtimeRoot, { recursive: true });
  const coreDestination = join(runtimeRoot, "core.mjs");
  const wasmDestination = join(runtimeRoot, "wasm-compat.mjs");
  copyFileSync(coreSource, coreDestination);
  copyFileSync(wasmSource, wasmDestination);

  const files: RuntimeFileRecord[] = [
    {
      path: "core.mjs",
      size: statSync(coreDestination).size,
      sha256: sha256(coreDestination)
    },
    {
      path: "wasm-compat.mjs",
      size: statSync(wasmDestination).size,
      sha256: sha256(wasmDestination)
    }
  ];
  const identity = {
    schemaVersion: 1,
    kind: "h1emu-navigation-runtime",
    mode: "monolithic64",
    abi: { polyRefBits: 64 },
    source: { recastNavigationCommit: gitHead(recastRoot) },
    files
  };
  const artifactId = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
  const manifest = { artifactId, ...identity };
  const manifestPath = join(runtimeRoot, "runtime-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assertPolyRef64(coreDestination, wasmDestination);
  process.stdout.write(
    `${JSON.stringify(
      {
        status: "navigation 64-bit runtime packaged",
        artifactId,
        outputRoot,
        runtimeRoot,
        manifestPath,
        bytes: files.reduce((sum, file) => sum + file.size, 0),
        files
      },
      null,
      2
    )}\n`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
