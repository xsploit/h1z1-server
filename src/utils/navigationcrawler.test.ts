import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  bakeCacheIsComplete,
  createRegionalBakeKey,
  findRecoverableBakeCache,
  mergeNavigationTransitions,
  runBounded,
  stableStringify
} from "./navigationcrawler";

test("stableStringify and bake keys ignore object insertion order", () => {
  assert.equal(
    stableStringify({ z: 1, a: { y: 2, x: 3 } }),
    '{"a":{"x":3,"y":2},"z":1}'
  );
  const common = {
    bakerSha256: "a".repeat(64),
    collisionSha256: "b".repeat(64),
    semanticsSha256: "c".repeat(64),
    heightmapSha256: "d".repeat(64),
    transitionsSha256: "e".repeat(64),
    profile: "human" as const,
    agentClimb: 1.3,
    dynamicDoorObstacles: true,
    bounds: [1, 2, 3, 4] as [number, number, number, number]
  };
  assert.equal(
    createRegionalBakeKey(common),
    createRegionalBakeKey({ ...common })
  );
  assert.notEqual(
    createRegionalBakeKey(common),
    createRegionalBakeKey({ ...common, bounds: [1, 2, 3, 5] })
  );
});

test("transition merge deduplicates exact entries and rejects name conflicts", () => {
  const existing = { name: "stair", start: [0, 0, 0], end: [1, 1, 1] };
  assert.deepEqual(
    mergeNavigationTransitions(
      [existing],
      [{ ...existing, actorFile: "Building.adr", instanceIndex: 7 }]
    ),
    [existing]
  );
  assert.deepEqual(
    mergeNavigationTransitions(
      [],
      [
        {
          ...existing,
          source: "model-local-navigation-template",
          actorFile: "Building.adr",
          instanceIndex: 7
        }
      ]
    ),
    [{ ...existing, source: "model-local-navigation-template" }]
  );
  assert.throws(
    () =>
      mergeNavigationTransitions([existing], [{ ...existing, end: [2, 2, 2] }]),
    /conflicting navigation transition identity/
  );
});

test("cache completion requires matching manifest, nav, and cache parts", () => {
  const root = mkdtempSync(join(tmpdir(), "nav-crawl-test-"));
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "bake-manifest.json"),
    JSON.stringify({ schemaVersion: 1, key: "right" })
  );
  writeFileSync(join(root, "z1_0.bin"), "nav");
  assert.equal(bakeCacheIsComplete(root, "right"), false);
  writeFileSync(join(root, "z1_cache_0.bin"), "cache");
  assert.equal(bakeCacheIsComplete(root, "wrong"), false);
  assert.equal(bakeCacheIsComplete(root, "right"), true);
});

test("completed interrupted bake cache is recoverable and incomplete cache is ignored", () => {
  const root = mkdtempSync(join(tmpdir(), "nav-crawl-recovery-test-"));
  const cache = join(root, "abc123");
  const incomplete = `${cache}.tmp-100-deadbeef`;
  const complete = `${cache}.tmp-200-feedface`;
  mkdirSync(incomplete, { recursive: true });
  writeFileSync(join(incomplete, "bake-manifest.json"), "{}");
  mkdirSync(complete, { recursive: true });
  writeFileSync(
    join(complete, "bake-manifest.json"),
    JSON.stringify({ schemaVersion: 1, key: "abc123" })
  );
  writeFileSync(join(complete, "z1_0.bin"), "nav");
  writeFileSync(join(complete, "z1_cache_0.bin"), "cache");
  assert.equal(findRecoverableBakeCache(cache, "abc123"), complete);
  assert.equal(findRecoverableBakeCache(cache, "wrong"), undefined);
});

test("runBounded preserves order and enforces concurrency", async () => {
  let active = 0;
  let peak = 0;
  const result = await runBounded([4, 3, 2, 1], 2, async (value) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((fulfill) => setTimeout(fulfill, value));
    active--;
    return value * 2;
  });
  assert.deepEqual(result, [8, 6, 4, 2]);
  assert.equal(peak, 2);
});
