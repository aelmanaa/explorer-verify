import { spawnSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, cp, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

import { packedPackage } from "../packages.mjs";
// Without --tarballs, the consumer installs the published explorer-verify that package.json and
// the lockfile pin. With --tarballs, it installs that directory's core tarball, such as a release
// candidate.
const args = process.argv.slice(2);
const tarballs = args.includes("--tarballs") ? args[args.indexOf("--tarballs") + 1] : undefined;
if (args.includes("--tarballs") && !tarballs) throw new Error("--tarballs needs a directory");
const output = resolve(
  args.includes("--output") ? args[args.indexOf("--output") + 1] : "validation/ccip/results",
);
const installation = await mkdtemp(join(tmpdir(), "ccip-validation-"));
for (const file of [
  "sdk.mjs",
  "cli.mjs",
  "exercise.mjs",
  "artifacts",
  "package.json",
  "package-lock.json",
])
  await cp(new URL(`./${file}`, import.meta.url), join(installation, file), { recursive: true });
let packed;
const hashes = {};
if (tarballs) {
  packed = packedPackage(tarballs, "explorer-verify");
  await cp(packed.path, join(installation, "candidate.tgz"));
  const manifestPath = join(installation, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.dependencies["explorer-verify"] = "file:./candidate.tgz";
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  const lockPath = join(installation, "package-lock.json");
  const consumerLock = JSON.parse(await readFile(lockPath, "utf8"));
  consumerLock.packages[""].dependencies["explorer-verify"] = "file:./candidate.tgz";
  Object.assign(consumerLock.packages["node_modules/explorer-verify"], {
    version: packed.version,
    resolved: "file:candidate.tgz",
    integrity: packed.integrity,
  });
  await writeFile(lockPath, JSON.stringify(consumerLock, null, 2) + "\n");
  for (const file of (await readdir(tarballs)).filter((name) => name.endsWith(".tgz")).toSorted())
    hashes[file] = createHash("sha256")
      .update(await readFile(join(tarballs, file)))
      .digest("hex");
}
const install = spawnSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: installation,
  encoding: "utf8",
});
if (install.status !== 0)
  throw new Error("Temporary consumer installation failed: " + install.stderr);
await mkdir(output, { recursive: true });
const child = spawn(process.execPath, ["exercise.mjs", output], {
  cwd: installation,
  stdio: "inherit",
});
const code = await new Promise((done) => child.on("exit", done));
const installed = JSON.parse(
  await readFile(join(installation, "node_modules/explorer-verify/package.json"), "utf8"),
);
const lock = JSON.parse(await readFile(join(installation, "package-lock.json"), "utf8"));
await writeFile(
  join(output, "packages.json"),
  JSON.stringify(
    tarballs
      ? {
          source: "tarball",
          candidate: packed.gitHead,
          coreVersion: installed.version,
          tarballs: hashes,
        }
      : {
          source: "npm",
          coreVersion: installed.version,
          resolved: lock.packages["node_modules/explorer-verify"].resolved,
          integrity: lock.packages["node_modules/explorer-verify"].integrity,
        },
    null,
    2,
  ) + "\n",
);
process.exitCode = code ?? 1;
