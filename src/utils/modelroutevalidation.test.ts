import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { resolveModelInstanceCacheDirectory } from "./modelroutevalidation";

test("model route validator resolves per-instance regional caches", () => {
  const root = mkdtempSync(join(tmpdir(), "h1emu-model-cache-"));
  try {
    const instance = join(root, "42");
    mkdirSync(instance);
    writeFileSync(join(instance, "z1_cache_0.bin"), "cache");
    assert.equal(
      resolveModelInstanceCacheDirectory(root, 42),
      resolve(instance)
    );
    assert.throws(
      () => resolveModelInstanceCacheDirectory(root, 43),
      /instance 43 was not found/
    );
    assert.throws(
      () => resolveModelInstanceCacheDirectory(instance, 43),
      /belongs to instance 42, not 43/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("model route validator accepts a direct deployed cache directory", () => {
  const root = mkdtempSync(join(tmpdir(), "h1emu-model-cache-"));
  try {
    writeFileSync(join(root, "z1_cache_0.bin"), "cache");
    assert.equal(resolveModelInstanceCacheDirectory(root, 7), resolve(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
