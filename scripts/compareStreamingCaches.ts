import {
  compareTileCacheLogicalIdentities,
  createTileCacheLogicalIdentity,
  summarizeTileCacheLogicalIdentity
} from "../src/utils/tilecacheidentity";

function usage(): never {
  console.error(
    "Usage: npm run navmesh-cache-identity -- <cache-dir> [candidate-cache-dir]"
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const positional = process.argv
    .slice(2)
    .filter((value) => !value.startsWith("--"));
  if (positional.length < 1 || positional.length > 2) usage();

  const reference = await createTileCacheLogicalIdentity(positional[0]);
  if (positional.length === 1) {
    console.log(
      JSON.stringify(
        {
          mode: "identity",
          cache: summarizeTileCacheLogicalIdentity(reference)
        },
        null,
        2
      )
    );
    return;
  }

  const candidate = await createTileCacheLogicalIdentity(positional[1]);
  const comparison = compareTileCacheLogicalIdentities(reference, candidate);
  console.log(
    JSON.stringify(
      {
        mode: "compare",
        equal: comparison.equal,
        reference: summarizeTileCacheLogicalIdentity(reference),
        candidate: summarizeTileCacheLogicalIdentity(candidate),
        comparison: {
          headerEqual: comparison.headerEqual,
          logicalPayloadEqual: comparison.logicalPayloadEqual,
          canonicalEqual: comparison.canonicalEqual,
          missingCount: comparison.missing.length,
          extraCount: comparison.extra.length,
          payloadMismatchCount: comparison.payloadMismatches.length,
          missing: comparison.missing,
          extra: comparison.extra,
          payloadMismatches: comparison.payloadMismatches
        }
      },
      null,
      2
    )
  );
  if (!comparison.equal) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
