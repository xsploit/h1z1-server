import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  compareTileCacheLogicalIdentities,
  createTileCacheLogicalIdentity
} from "./tilecacheidentity";

interface FixtureRecord {
  tx: number;
  ty: number;
  tlayer: number;
  marker: number;
  tileRef: number;
}

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function makeHeader(layers: number, walkableClimb = 0.5): Buffer {
  const header = Buffer.alloc(92);
  header.writeInt32LE(0x54534554, 0);
  header.writeInt32LE(1, 4);
  header.writeInt32LE(layers, 8);
  const floats: Array<[number, number]> = [
    [12, -4096.5],
    [16, -9.85],
    [20, -4096.5],
    [24, 25.6],
    [28, 25.6],
    [40, -4096.5],
    [44, -9.85],
    [48, -4096.5],
    [52, 0.2],
    [56, 0.1],
    [68, 2],
    [72, 0.2],
    [76, walkableClimb],
    [80, 1]
  ];
  for (const [offset, value] of floats) header.writeFloatLE(value, offset);
  header.writeInt32LE(32768, 32);
  header.writeInt32LE(128, 36);
  header.writeInt32LE(128, 60);
  header.writeInt32LE(128, 64);
  header.writeInt32LE(2097152, 84);
  header.writeInt32LE(20000, 88);
  return header;
}

function makeRecord(record: FixtureRecord): Buffer {
  const payload = Buffer.alloc(24);
  payload.writeInt32LE(0x44544c52, 0);
  payload.writeInt32LE(1, 4);
  payload.writeInt32LE(record.tx, 8);
  payload.writeInt32LE(record.ty, 12);
  payload.writeInt32LE(record.tlayer, 16);
  payload.writeUInt32LE(record.marker, 20);
  const header = Buffer.alloc(8);
  header.writeUInt32LE(record.tileRef, 0);
  header.writeInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function makeFixture(
  parts: FixtureRecord[][],
  options: { walkableClimb?: number } = {}
): string {
  const directory = mkdtempSync(join(tmpdir(), "h1emu-cache-identity-"));
  fixtures.push(directory);
  mkdirSync(directory, { recursive: true });
  const layerCount = parts.reduce((count, part) => count + part.length, 0);
  parts.forEach((records, index) => {
    const chunks = records.map(makeRecord);
    if (index === 0) {
      chunks.unshift(makeHeader(layerCount, options.walkableClimb));
    }
    writeFileSync(
      join(directory, `z1_cache_${index}.bin`),
      Buffer.concat(chunks)
    );
  });
  return directory;
}

test("logical identity ignores tile refs, record order, and part splits", async () => {
  const reference = makeFixture([
    [
      { tx: 2, ty: 4, tlayer: 0, marker: 11, tileRef: 100 },
      { tx: 3, ty: 4, tlayer: 0, marker: 12, tileRef: 101 }
    ]
  ]);
  const candidate = makeFixture([
    [{ tx: 3, ty: 4, tlayer: 0, marker: 12, tileRef: 9001 }],
    [{ tx: 2, ty: 4, tlayer: 0, marker: 11, tileRef: 42 }]
  ]);

  const left = await createTileCacheLogicalIdentity(reference);
  const right = await createTileCacheLogicalIdentity(candidate);
  const comparison = compareTileCacheLogicalIdentities(left, right);

  assert.notEqual(left.serializedSha256, right.serializedSha256);
  assert.equal(left.logicalPayloadSha256, right.logicalPayloadSha256);
  assert.equal(left.canonicalSha256, right.canonicalSha256);
  assert.deepEqual(comparison, {
    equal: true,
    headerEqual: true,
    logicalPayloadEqual: true,
    canonicalEqual: true,
    missing: [],
    extra: [],
    payloadMismatches: []
  });
});

test("comparison reports missing, extra, and changed payloads", async () => {
  const reference = makeFixture([
    [
      { tx: 1, ty: 1, tlayer: 0, marker: 10, tileRef: 1 },
      { tx: 2, ty: 1, tlayer: 0, marker: 20, tileRef: 2 },
      { tx: 3, ty: 1, tlayer: 0, marker: 30, tileRef: 3 }
    ]
  ]);
  const candidate = makeFixture([
    [
      { tx: 2, ty: 1, tlayer: 0, marker: 21, tileRef: 2 },
      { tx: 3, ty: 1, tlayer: 0, marker: 30, tileRef: 3 },
      { tx: 4, ty: 1, tlayer: 0, marker: 40, tileRef: 4 }
    ]
  ]);

  const comparison = compareTileCacheLogicalIdentities(
    await createTileCacheLogicalIdentity(reference),
    await createTileCacheLogicalIdentity(candidate)
  );

  assert.equal(comparison.equal, false);
  assert.deepEqual(
    comparison.missing.map(({ tx, ty, tlayer }) => ({ tx, ty, tlayer })),
    [{ tx: 1, ty: 1, tlayer: 0 }]
  );
  assert.deepEqual(
    comparison.extra.map(({ tx, ty, tlayer }) => ({ tx, ty, tlayer })),
    [{ tx: 4, ty: 1, tlayer: 0 }]
  );
  assert.equal(comparison.payloadMismatches.length, 1);
  assert.deepEqual(
    (({ tx, ty, tlayer }) => ({ tx, ty, tlayer }))(
      comparison.payloadMismatches[0]
    ),
    { tx: 2, ty: 1, tlayer: 0 }
  );
});

test("header differences change only the complete canonical identity", async () => {
  const record = { tx: 8, ty: 9, tlayer: 0, marker: 55, tileRef: 1 };
  const reference = makeFixture([[record]], { walkableClimb: 0.5 });
  const candidate = makeFixture([[record]], { walkableClimb: 0.6 });

  const left = await createTileCacheLogicalIdentity(reference);
  const right = await createTileCacheLogicalIdentity(candidate);
  const comparison = compareTileCacheLogicalIdentities(left, right);

  assert.equal(comparison.headerEqual, false);
  assert.equal(comparison.logicalPayloadEqual, true);
  assert.equal(comparison.canonicalEqual, false);
  assert.equal(comparison.equal, false);
});

test("duplicate stable layer keys are rejected", async () => {
  const fixture = makeFixture([
    [
      { tx: 1, ty: 2, tlayer: 0, marker: 1, tileRef: 1 },
      { tx: 1, ty: 2, tlayer: 0, marker: 2, tileRef: 2 }
    ]
  ]);
  await assert.rejects(
    createTileCacheLogicalIdentity(fixture),
    /duplicate tile cache layer 1,2,0/
  );
});
