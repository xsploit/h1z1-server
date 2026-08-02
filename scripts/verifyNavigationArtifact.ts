import { resolve } from "node:path";
import { verifyNavigationArtifact } from "../src/utils/navigationartifacts";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const bundleRoot = resolve(option("--bundle-root") ?? "data/2016");
  const cacheDirectory = resolve(
    option("--cache-dir") ?? resolve(bundleRoot, "collision")
  );
  const manifestPath = resolve(
    option("--manifest") ??
      resolve(bundleRoot, "navigation-artifact-manifest.json")
  );
  const verified = await verifyNavigationArtifact({
    manifestPath,
    cacheDirectory
  });
  console.log(
    JSON.stringify(
      {
        artifactId: verified.manifest.artifactId,
        manifestPath: verified.manifestPath,
        provenance: verified.manifest.provenance.status,
        filesVerified: verified.filesVerified,
        bytesVerified: verified.bytesVerified,
        cache: verified.manifest.runtime.cache.header,
        collision: verified.manifest.runtime.collision
          ? {
              meshCount: verified.manifest.runtime.collision.meshCount,
              instanceCount: verified.manifest.runtime.collision.instanceCount
            }
          : null,
        heightmap: verified.manifest.runtime.heightmap
          ? {
              width: verified.manifest.runtime.heightmap.width,
              height: verified.manifest.runtime.heightmap.height
            }
          : null,
        navigationMetadata:
          verified.manifest.runtime.navigationMetadata?.instanceCount ?? null,
        semantics: verified.manifest.runtime.semantics
          ? {
              contract: verified.manifest.runtime.semantics.semanticContract,
              sourceTriangles:
                verified.manifest.runtime.semantics.sourceTriangles,
              fallbackTriangles:
                verified.manifest.runtime.semantics.fallbackTriangles,
              warnings: verified.manifest.runtime.semantics.warnings.length
            }
          : null,
        transitions: verified.manifest.runtime.transitions?.count ?? null
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
