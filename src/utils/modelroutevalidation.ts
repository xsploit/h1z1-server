import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

function containsStreamingCache(path: string): boolean {
  return (
    isDirectory(path) &&
    readdirSync(path).some((name) => /^z1_cache_\d+\.bin$/i.test(name))
  );
}

/**
 * Regional model bakes are stored as <root>/<instance>/z1_cache_*.bin while
 * deployed/full caches point directly at a directory containing the parts.
 * Never silently reuse one instance directory for a different placement.
 */
export function resolveModelInstanceCacheDirectory(
  cacheRoot: string,
  instance: number
): string {
  if (!Number.isInteger(instance))
    throw new Error(`invalid model instance index ${instance}`);
  const root = resolve(cacheRoot);
  if (!isDirectory(root))
    throw new Error(`streaming cache directory was not found: ${root}`);

  const regionalInstance = basename(root);
  if (/^\d+$/.test(regionalInstance)) {
    if (Number(regionalInstance) !== instance)
      throw new Error(
        `regional cache ${root} belongs to instance ${regionalInstance}, not ${instance}`
      );
    if (containsStreamingCache(root)) return root;
  }

  const instanceDirectory = join(root, String(instance));
  if (containsStreamingCache(instanceDirectory)) return instanceDirectory;

  const hasRegionalLayout = readdirSync(root, { withFileTypes: true }).some(
    (entry) => entry.isDirectory() && /^\d+$/.test(entry.name)
  );
  if (hasRegionalLayout)
    throw new Error(
      `streaming cache for model instance ${instance} was not found under ${root}`
    );
  if (containsStreamingCache(root)) return root;
  throw new Error(`no z1_cache_*.bin parts were found under ${root}`);
}
