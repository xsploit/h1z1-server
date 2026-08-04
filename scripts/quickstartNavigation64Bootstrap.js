const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

const RUNTIME_FILES = ["core.mjs", "wasm-compat.mjs"];

function sha256(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function verifyRuntime(runtimeRoot, manifest) {
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== "h1emu-navigation-runtime" ||
    manifest.mode !== "monolithic64" ||
    manifest.abi?.polyRefBits !== 64
  ) {
    throw new Error(
      "[NAV] QuickStart rejected the navigation64 runtime manifest"
    );
  }

  const { artifactId, ...identity } = manifest;
  const expectedArtifactId = crypto
    .createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
  if (artifactId !== expectedArtifactId) {
    throw new Error("[NAV] QuickStart rejected the runtime artifact identity");
  }

  const expectedPaths = new Set(RUNTIME_FILES);
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.length !== expectedPaths.size ||
    manifest.files.some((file) => !expectedPaths.delete(file.path)) ||
    expectedPaths.size
  ) {
    throw new Error("[NAV] QuickStart rejected the runtime file closure");
  }
  for (const file of manifest.files) {
    const filePath = path.join(runtimeRoot, file.path);
    if (
      !fs.existsSync(filePath) ||
      fs.statSync(filePath).size !== file.size ||
      sha256(filePath) !== file.sha256
    ) {
      throw new Error(
        `[NAV] QuickStart rejected the runtime file identity: ${file.path}`
      );
    }
  }
}

module.exports = function configureNavigation64(options = {}) {
  const environment = options.environment || process.env;
  const quickStartRoot = options.quickStartRoot || __dirname;
  const enableByDefault = options.enableByDefault === true;
  environment.NAV_MONOLITHIC_64 ??= enableByDefault ? "1" : "0";
  if (environment.NAV_MONOLITHIC_64 !== "1") {
    return { enabled: false, mode: "stock" };
  }

  const runtimeRoot = path.join(
    quickStartRoot,
    "node_modules",
    "h1z1-server",
    "runtime",
    "navigation64"
  );
  const manifestPath = path.join(runtimeRoot, "runtime-manifest.json");
  const coreModule = path.join(runtimeRoot, "core.mjs");
  const wasmModule = path.join(runtimeRoot, "wasm-compat.mjs");
  for (const requiredPath of [manifestPath, coreModule, wasmModule]) {
    if (!fs.existsSync(requiredPath)) {
      throw new Error(
        `[NAV] QuickStart requested monolithic64 but its packaged runtime is missing: ${requiredPath}`
      );
    }
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  verifyRuntime(runtimeRoot, manifest);
  const hasCoreOverride = Boolean(environment.NAV_64_CORE_MODULE);
  const hasWasmOverride = Boolean(environment.NAV_64_WASM_MODULE);
  if (hasCoreOverride !== hasWasmOverride) {
    throw new Error(
      "[NAV] QuickStart requires NAV_64_CORE_MODULE and NAV_64_WASM_MODULE together"
    );
  }
  if (!hasCoreOverride) {
    environment.NAV_64_CORE_MODULE = coreModule;
    environment.NAV_64_WASM_MODULE = wasmModule;
  }
  environment.NAV_STREAMING = "0";
  return {
    enabled: true,
    mode: "monolithic64",
    artifactId: manifest.artifactId,
    runtimeRoot,
    coreModule: environment.NAV_64_CORE_MODULE,
    wasmModule: environment.NAV_64_WASM_MODULE
  };
};
