const fs = require("node:fs");
const path = require("node:path");

const installedRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : undefined;

if (!installedRoot || !fs.statSync(installedRoot).isDirectory()) {
  throw new Error("Usage: node verifyCleanServerBuild.js <installed-root>");
}

const packageJsonPath = path.join(installedRoot, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const server = require(installedRoot);

for (const exportName of ["LoginServer", "ZoneServer2016"]) {
  if (typeof server[exportName] !== "function") {
    throw new Error(`Installed package is missing ${exportName}`);
  }
}

console.log(
  JSON.stringify({
    status: "clean server module load passed",
    installedRoot,
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    checkedExports: ["LoginServer", "ZoneServer2016"],
  })
);
