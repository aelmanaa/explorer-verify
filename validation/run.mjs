#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projects = ["browser-remix", "ccip", "hardhat", "cli-comparison", "polyglot"];
const { values } = parseArgs({
  options: {
    project: { type: "string", multiple: true },
    tarballs: { type: "string" },
    "package-dir": { type: "string" },
    output: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "Usage: node validation/run.mjs [--project NAME] [--tarballs DIR | --package-dir REPO] [--output DIR]",
  );
  console.log(`Projects: ${projects.join(", ")}`);
  process.exit(0);
}
const selected = values.project ?? projects;
if (
  new Set(selected).size !== selected.length ||
  selected.some((name) => !projects.includes(name))
) {
  throw new Error(`Choose each project at most once from: ${projects.join(", ")}`);
}
if (values.tarballs && values["package-dir"])
  throw new Error("Choose --tarballs or --package-dir.");
const output = values.output
  ? resolve(values.output)
  : mkdtempSync(join(tmpdir(), "explorer-verify-adoption-"));
mkdirSync(output, { recursive: true });
function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, stdio: "inherit", timeout: 1_200_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} exited ${result.status ?? result.signal}`);
}
let tarballs;
if (values.tarballs) tarballs = resolve(values.tarballs);
else {
  const source = resolve(values["package-dir"] ?? repo);
  tarballs = join(output, "tarballs");
  mkdirSync(tarballs, { recursive: true });
  command("pnpm", ["run", "build"], source);
  for (const folder of ["explorer-verify", "cli", "foundry", "hardhat"]) {
    command(
      "pnpm",
      ["pack", "--pack-destination", tarballs, "--silent"],
      join(source, "packages", folder),
    );
  }
}
const manifests = readdirSync(tarballs)
  .filter((file) => file.endsWith(".tgz"))
  .map((file) => {
    const result = spawnSync("tar", ["-xOzf", join(tarballs, file), "package/package.json"], {
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(`Cannot read packed manifest: ${file}`);
    const manifest = JSON.parse(result.stdout);
    return {
      file,
      name: manifest.name,
      version: manifest.version,
      gitHead: manifest.gitHead ?? null,
    };
  });
const names = [
  "explorer-verify",
  "@explorer-verify/cli",
  "@explorer-verify/foundry",
  "@explorer-verify/hardhat",
];
if (
  manifests.length !== 4 ||
  names.some((name) => !manifests.some((manifest) => manifest.name === name))
) {
  throw new Error("The tarballs directory must contain exactly the four built package tarballs.");
}
if (new Set(manifests.map((manifest) => manifest.version)).size !== 1)
  throw new Error("Packed package versions must match.");
const results = [];
for (const project of selected) {
  const runner = join(repo, "validation", project, "run.mjs");
  if (!existsSync(runner)) throw new Error(`Project runner is missing: ${project}`);
  if (project === "browser-remix")
    command(
      "npm",
      ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      join(repo, "validation", project),
    );
  const folder = join(output, project);
  mkdirSync(folder, { recursive: true });
  const stdout = openSync(join(folder, "stdout.log"), "w");
  const stderr = openSync(join(folder, "stderr.log"), "w");
  const started = performance.now();
  console.log(`Running ${project}; logs: ${folder}`);
  let run;
  try {
    run = spawnSync(process.execPath, [runner, "--tarballs", tarballs, "--output", folder], {
      cwd: repo,
      stdio: ["ignore", stdout, stderr],
      timeout: 1_800_000,
    });
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
  const passed = run.status === 0 && !run.error;
  results.push({
    project,
    passed,
    exitCode: run.status,
    signal: run.signal,
    error: run.error?.message ?? null,
    durationMs: Math.round(performance.now() - started),
  });
  console.log(`${project}: ${passed ? "PASS" : "FAIL"}`);
  if (!passed) {
    console.error(readFileSync(join(folder, "stdout.log"), "utf8").slice(-8000));
    console.error(readFileSync(join(folder, "stderr.log"), "utf8").slice(-8000));
  }
}
const summary = {
  checkedAt: new Date().toISOString(),
  node: process.version,
  packages: manifests,
  results,
};
writeFileSync(join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`Summary: ${join(output, "summary.json")}`);
process.exitCode = results.every((result) => result.passed) ? 0 : 1;
