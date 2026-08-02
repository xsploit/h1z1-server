import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseTsetHeader } from "./navigationartifacts";

const TSET_HEADER_BYTES = 92;
const TILE_RECORD_HEADER_BYTES = 8;
const TILE_LAYER_KEY_END = 20;
const LOGICAL_PAYLOAD_DOMAIN = "h1emu-tilecache-logical-payload-v1\0";
const LOGICAL_CACHE_DOMAIN = "h1emu-tilecache-logical-cache-v1\0";

export interface TileCacheLayerKey {
  tx: number;
  ty: number;
  tlayer: number;
}

export interface TileCacheLogicalRecord extends TileCacheLayerKey {
  payloadBytes: number;
  payloadSha256: string;
}

export interface TileCachePartIdentity {
  index: number;
  name: string;
  bytes: number;
  sha256: string;
}

export interface TileCacheLogicalIdentity {
  directory: string;
  parts: TileCachePartIdentity[];
  serializedBytes: number;
  serializedSha256: string;
  header: ReturnType<typeof parseTsetHeader>;
  headerSha256: string;
  recordCount: number;
  logicalPayloadSha256: string;
  canonicalSha256: string;
  records: TileCacheLogicalRecord[];
}

export interface TileCachePayloadMismatch extends TileCacheLayerKey {
  referenceBytes: number;
  candidateBytes: number;
  referenceSha256: string;
  candidateSha256: string;
}

export interface TileCacheLogicalComparison {
  equal: boolean;
  headerEqual: boolean;
  logicalPayloadEqual: boolean;
  canonicalEqual: boolean;
  missing: TileCacheLogicalRecord[];
  extra: TileCacheLogicalRecord[];
  payloadMismatches: TileCachePayloadMismatch[];
}

function cachePartIndex(name: string): number {
  const match = name.match(/^z1_cache_(\d+)\.bin$/);
  if (!match) throw new Error(`invalid cache part name: ${name}`);
  return Number(match[1]);
}

function orderedCacheParts(directory: string): string[] {
  const parts = readdirSync(directory)
    .filter((name) => /^z1_cache_\d+\.bin$/.test(name))
    .sort((left, right) => cachePartIndex(left) - cachePartIndex(right));
  if (!parts.length) {
    throw new Error(`no z1_cache_*.bin parts found in ${directory}`);
  }
  parts.forEach((name, index) => {
    if (cachePartIndex(name) !== index) {
      throw new Error(
        `cache parts are not contiguous at index ${index}: ${name}`
      );
    }
  });
  return parts;
}

function compareKeys(
  left: TileCacheLayerKey,
  right: TileCacheLayerKey
): number {
  return left.tx - right.tx || left.ty - right.ty || left.tlayer - right.tlayer;
}

function recordKey(record: TileCacheLayerKey): string {
  return `${record.tx},${record.ty},${record.tlayer}`;
}

function recordIdentityBytes(record: TileCacheLogicalRecord): Buffer {
  const identity = Buffer.allocUnsafe(16 + 32);
  identity.writeInt32LE(record.tx, 0);
  identity.writeInt32LE(record.ty, 4);
  identity.writeInt32LE(record.tlayer, 8);
  identity.writeUInt32LE(record.payloadBytes, 12);
  Buffer.from(record.payloadSha256, "hex").copy(identity, 16);
  return identity;
}

export async function createTileCacheLogicalIdentity(
  cacheDirectory: string
): Promise<TileCacheLogicalIdentity> {
  const directory = resolve(cacheDirectory);
  const names = orderedCacheParts(directory);
  const paths = names.map((name) => join(directory, name));
  const firstPart = readFileSync(paths[0]);
  if (firstPart.length < TSET_HEADER_BYTES) {
    throw new Error("tile cache set header is truncated");
  }

  const headerBytes = firstPart.subarray(0, TSET_HEADER_BYTES);
  const header = parseTsetHeader(headerBytes);
  const headerSha256 = createHash("sha256").update(headerBytes).digest("hex");
  const records: TileCacheLogicalRecord[] = [];
  const keys = new Set<string>();
  const parts: TileCachePartIdentity[] = [];
  const serializedHash = createHash("sha256");

  for (let partIndex = 0; partIndex < paths.length; partIndex++) {
    const path = paths[partIndex];
    const bytes = partIndex === 0 ? firstPart : readFileSync(path);
    serializedHash.update(bytes);
    parts.push({
      index: partIndex,
      name: names[partIndex],
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });

    let offset = partIndex === 0 ? TSET_HEADER_BYTES : 0;
    while (offset < bytes.length) {
      if (bytes.length - offset < TILE_RECORD_HEADER_BYTES) {
        throw new Error(
          `truncated tile record header in ${names[partIndex]} at ${offset}`
        );
      }
      const payloadBytes = bytes.readInt32LE(offset + 4);
      offset += TILE_RECORD_HEADER_BYTES;
      if (
        payloadBytes < TILE_LAYER_KEY_END ||
        payloadBytes > bytes.length - offset
      ) {
        throw new Error(
          `invalid tile payload size ${payloadBytes} in ${names[partIndex]} at ${offset}`
        );
      }

      const payload = bytes.subarray(offset, offset + payloadBytes);
      const record: TileCacheLogicalRecord = {
        tx: payload.readInt32LE(8),
        ty: payload.readInt32LE(12),
        tlayer: payload.readInt32LE(16),
        payloadBytes,
        payloadSha256: createHash("sha256").update(payload).digest("hex")
      };
      const key = recordKey(record);
      if (keys.has(key)) {
        throw new Error(`duplicate tile cache layer ${key}`);
      }
      keys.add(key);
      records.push(record);
      offset += payloadBytes;
    }
  }

  if (records.length !== header.layers) {
    throw new Error(
      `tile cache header declares ${header.layers} layers, parsed ${records.length}`
    );
  }
  records.sort(compareKeys);

  const logicalPayloadHash = createHash("sha256");
  logicalPayloadHash.update(LOGICAL_PAYLOAD_DOMAIN);
  const count = Buffer.allocUnsafe(4);
  count.writeUInt32LE(records.length);
  logicalPayloadHash.update(count);
  for (const record of records) {
    logicalPayloadHash.update(recordIdentityBytes(record));
  }
  const logicalPayloadSha256 = logicalPayloadHash.digest("hex");

  const canonicalHash = createHash("sha256");
  canonicalHash.update(LOGICAL_CACHE_DOMAIN);
  canonicalHash.update(headerBytes);
  canonicalHash.update(Buffer.from(logicalPayloadSha256, "hex"));

  return {
    directory,
    parts,
    serializedBytes: parts.reduce((total, part) => total + part.bytes, 0),
    serializedSha256: serializedHash.digest("hex"),
    header,
    headerSha256,
    recordCount: records.length,
    logicalPayloadSha256,
    canonicalSha256: canonicalHash.digest("hex"),
    records
  };
}

export function compareTileCacheLogicalIdentities(
  reference: TileCacheLogicalIdentity,
  candidate: TileCacheLogicalIdentity
): TileCacheLogicalComparison {
  const referenceRecords = new Map(
    reference.records.map((record) => [recordKey(record), record])
  );
  const candidateRecords = new Map(
    candidate.records.map((record) => [recordKey(record), record])
  );
  const missing: TileCacheLogicalRecord[] = [];
  const extra: TileCacheLogicalRecord[] = [];
  const payloadMismatches: TileCachePayloadMismatch[] = [];

  for (const [key, expected] of referenceRecords) {
    const actual = candidateRecords.get(key);
    if (!actual) {
      missing.push(expected);
      continue;
    }
    if (
      expected.payloadBytes !== actual.payloadBytes ||
      expected.payloadSha256 !== actual.payloadSha256
    ) {
      payloadMismatches.push({
        tx: expected.tx,
        ty: expected.ty,
        tlayer: expected.tlayer,
        referenceBytes: expected.payloadBytes,
        candidateBytes: actual.payloadBytes,
        referenceSha256: expected.payloadSha256,
        candidateSha256: actual.payloadSha256
      });
    }
  }
  for (const [key, actual] of candidateRecords) {
    if (!referenceRecords.has(key)) extra.push(actual);
  }

  missing.sort(compareKeys);
  extra.sort(compareKeys);
  payloadMismatches.sort(compareKeys);
  const headerEqual = reference.headerSha256 === candidate.headerSha256;
  const logicalPayloadEqual =
    reference.logicalPayloadSha256 === candidate.logicalPayloadSha256;
  const canonicalEqual =
    reference.canonicalSha256 === candidate.canonicalSha256;
  return {
    equal:
      canonicalEqual &&
      missing.length === 0 &&
      extra.length === 0 &&
      payloadMismatches.length === 0,
    headerEqual,
    logicalPayloadEqual,
    canonicalEqual,
    missing,
    extra,
    payloadMismatches
  };
}

export function summarizeTileCacheLogicalIdentity(
  identity: TileCacheLogicalIdentity
): Omit<TileCacheLogicalIdentity, "records"> {
  const { records: _records, ...summary } = identity;
  return summary;
}
