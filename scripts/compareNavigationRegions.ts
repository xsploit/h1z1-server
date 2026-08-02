import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  compareNavigationValidationReports,
  NavigationValidationReport
} from "../src/utils/navigationvalidation";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function load(path: string): NavigationValidationReport {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

const baselinePath = option("--baseline");
const candidatePath = option("--candidate");
const outputPath = option("--report");
if (!baselinePath || !candidatePath) {
  console.error(
    "Usage: npx tsx scripts/compareNavigationRegions.ts --baseline <report> --candidate <report> [--require-pass] [--report <file>]"
  );
  process.exit(1);
}

const comparison = compareNavigationValidationReports(
  load(baselinePath),
  load(candidatePath),
  process.argv.includes("--require-pass")
);
const serialized = `${JSON.stringify(comparison, null, 2)}\n`;
if (outputPath) writeFileSync(resolve(outputPath), serialized);
process.stdout.write(serialized);
if (!comparison.passed) process.exitCode = 1;
