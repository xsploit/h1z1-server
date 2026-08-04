import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type RuntimeManifest = {
  artifactId: string;
  schemaVersion: number;
  kind: string;
  mode: string;
  abi: { polyRefBits: number };
  source: { recastNavigationCommit: string };
  files: Array<{ path: string; size: number; sha256: string }>;
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

async function main() {
  const runtimeRoot = resolve(option("--runtime-root"));
  const manifestPath = join(runtimeRoot, "runtime-manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`navigation runtime manifest is missing: ${manifestPath}`);
  }
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf8")
  ) as RuntimeManifest;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== "h1emu-navigation-runtime" ||
    manifest.mode !== "monolithic64" ||
    manifest.abi?.polyRefBits !== 64
  ) {
    throw new Error("navigation runtime manifest has an unsupported contract");
  }
  const { artifactId, ...identity } = manifest;
  const expectedArtifactId = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
  if (artifactId !== expectedArtifactId) {
    throw new Error("navigation runtime manifest identity mismatch");
  }
  const expectedPaths = new Set(["core.mjs", "wasm-compat.mjs"]);
  if (
    manifest.files.length !== expectedPaths.size ||
    manifest.files.some((file) => !expectedPaths.delete(file.path)) ||
    expectedPaths.size
  ) {
    throw new Error("navigation runtime manifest file closure is invalid");
  }
  for (const file of manifest.files) {
    const path = join(runtimeRoot, file.path);
    if (!existsSync(path)) throw new Error(`runtime file is missing: ${path}`);
    if (statSync(path).size !== file.size || sha256(path) !== file.sha256) {
      throw new Error(`runtime file identity mismatch: ${file.path}`);
    }
  }

  const cacheBust = `?runtime-verification=${Date.now()}`;
  const [core, wasm] = await Promise.all([
    import(`${pathToFileURL(join(runtimeRoot, "core.mjs")).href}${cacheBust}`),
    import(
      `${pathToFileURL(join(runtimeRoot, "wasm-compat.mjs")).href}${cacheBust}`
    )
  ]);
  if (typeof core.init !== "function" || typeof wasm.default !== "function") {
    throw new Error("navigation runtime modules have invalid exports");
  }
  await core.init(wasm.default);
  if (
    typeof core.uses64BitPolyRefs !== "function" ||
    !core.uses64BitPolyRefs()
  ) {
    throw new Error("navigation runtime capability check rejected polyref64");
  }
  process.stdout.write(
    `${JSON.stringify({
      status: "navigation 64-bit runtime verified",
      artifactId,
      runtimeRoot,
      filesVerified: manifest.files.length,
      bytesVerified: manifest.files.reduce((sum, file) => sum + file.size, 0)
    })}\n`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
