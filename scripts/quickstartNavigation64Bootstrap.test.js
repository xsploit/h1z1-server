const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const configureNavigation64 = require("./quickstartNavigation64Bootstrap");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "h1emu-nav64-bootstrap-"));
  const runtimeRoot = path.join(
    root,
    "node_modules",
    "h1z1-server",
    "runtime",
    "navigation64"
  );
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const files = [
    ["core.mjs", "export {};\n"],
    ["wasm-compat.mjs", "export {};\n"]
  ];
  for (const [name, contents] of files) {
    fs.writeFileSync(path.join(runtimeRoot, name), contents);
  }
  const identity = {
    schemaVersion: 1,
    kind: "h1emu-navigation-runtime",
    mode: "monolithic64",
    abi: { polyRefBits: 64 },
    source: { recastNavigationCommit: "fixture" },
    files: files.map(([name]) => {
      const contents = fs.readFileSync(path.join(runtimeRoot, name));
      return {
        path: name,
        size: contents.length,
        sha256: crypto.createHash("sha256").update(contents).digest("hex")
      };
    })
  };
  fs.writeFileSync(
    path.join(runtimeRoot, "runtime-manifest.json"),
    JSON.stringify({
      artifactId: crypto
        .createHash("sha256")
        .update(JSON.stringify(identity))
        .digest("hex"),
      ...identity
    })
  );
  return { root, runtimeRoot };
}

test("QuickStart navigation64 bootstrap remains stock unless enabled", () => {
  const environment = {};
  const result = configureNavigation64({
    environment,
    quickStartRoot: "missing"
  });
  assert.deepEqual(result, { enabled: false, mode: "stock" });
  assert.equal(environment.NAV_MONOLITHIC_64, "0");
});

test("QuickStart navigation64 bootstrap resolves only packaged modules", (t) => {
  const { root, runtimeRoot } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const environment = { NAV_STREAMING: "1" };
  const result = configureNavigation64({
    environment,
    quickStartRoot: root,
    enableByDefault: true
  });
  assert.equal(result.enabled, true);
  assert.match(result.artifactId, /^[0-9a-f]{64}$/);
  assert.equal(environment.NAV_MONOLITHIC_64, "1");
  assert.equal(environment.NAV_STREAMING, "0");
  assert.equal(
    environment.NAV_64_CORE_MODULE,
    path.join(runtimeRoot, "core.mjs")
  );
  assert.equal(
    environment.NAV_64_WASM_MODULE,
    path.join(runtimeRoot, "wasm-compat.mjs")
  );
});

test("QuickStart navigation64 bootstrap fails closed on a partial package", (t) => {
  const { root, runtimeRoot } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.rmSync(path.join(runtimeRoot, "wasm-compat.mjs"));
  assert.throws(
    () =>
      configureNavigation64({
        environment: {},
        quickStartRoot: root,
        enableByDefault: true
      }),
    /packaged runtime is missing/
  );
});

test("QuickStart navigation64 bootstrap rejects a modified runtime", (t) => {
  const { root, runtimeRoot } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.appendFileSync(path.join(runtimeRoot, "core.mjs"), "// tampered\n");
  assert.throws(
    () =>
      configureNavigation64({
        environment: {},
        quickStartRoot: root,
        enableByDefault: true
      }),
    /runtime file identity/
  );
});

test("QuickStart navigation64 bootstrap rejects a partial override", (t) => {
  const { root } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () =>
      configureNavigation64({
        environment: { NAV_64_CORE_MODULE: "external-core.mjs" },
        quickStartRoot: root,
        enableByDefault: true
      }),
    /CORE_MODULE and NAV_64_WASM_MODULE together/
  );
});

test("QuickStart navigation64 bootstrap preserves a complete override", (t) => {
  const { root } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const environment = {
    NAV_64_CORE_MODULE: "external-core.mjs",
    NAV_64_WASM_MODULE: "external-wasm.mjs"
  };
  const result = configureNavigation64({
    environment,
    quickStartRoot: root,
    enableByDefault: true
  });
  assert.equal(result.coreModule, "external-core.mjs");
  assert.equal(result.wasmModule, "external-wasm.mjs");
});
