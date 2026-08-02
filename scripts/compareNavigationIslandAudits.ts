import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  compareNavigationIslandAuditReports,
  NavigationIslandReportBinding
} from "../src/utils/navigationislandcomparison";
import { NavigationIslandAuditReport } from "../src/utils/navigationislandaudit";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function load(path: string): {
  report: NavigationIslandAuditReport;
  binding: NavigationIslandReportBinding;
} {
  const bytes = readFileSync(resolve(path));
  return {
    report: JSON.parse(bytes.toString("utf8")),
    binding: {
      reportSha256: createHash("sha256").update(bytes).digest("hex")
    }
  };
}

const baselinePath = option("--baseline");
const candidatePath = option("--candidate");
const outputPath = option("--report");
if (!baselinePath || !candidatePath) {
  console.error(
    "Usage: npx tsx scripts/compareNavigationIslandAudits.ts " +
      "--baseline <audit-report> --candidate <audit-report> [--report <file>]"
  );
  process.exit(1);
}

const baseline = load(baselinePath);
const candidate = load(candidatePath);
const comparison = compareNavigationIslandAuditReports(
  baseline.report,
  candidate.report,
  { baseline: baseline.binding, candidate: candidate.binding }
);
const serialized = `${JSON.stringify(comparison, null, 2)}\n`;
if (outputPath) writeFileSync(resolve(outputPath), serialized);
process.stdout.write(serialized);
if (!comparison.passed) process.exitCode = 1;
