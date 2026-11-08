import { spawnSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, cp, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
const args = process.argv.slice(2);
const tarballs = args[args.indexOf("--tarballs") + 1];
if (!args.includes("--tarballs") || !tarballs) throw new Error("--tarballs directory required");
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
const tarball = resolve(tarballs, "explorer-verify-0.1.0.tgz");
await cp(tarball, join(installation, "candidate.tgz"));
const install = spawnSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: installation,
  encoding: "utf8",
});
if (install.status !== 0)
  throw new Error("Temporary consumer installation failed: " + install.stderr);
const hashes = {};
for (const file of (await readdir(tarballs)).filter((name) => name.endsWith(".tgz")).sort())
  hashes[file] = createHash("sha256")
    .update(await readFile(join(tarballs, file)))
    .digest("hex");
await mkdir(output, { recursive: true });
const child = spawn(process.execPath, ["exercise.mjs", output], {
  cwd: installation,
  stdio: "inherit",
});
const code = await new Promise((done) => child.on("exit", done));
await writeFile(
  join(output, "packages.json"),
  JSON.stringify(
    {
      candidate: "df036c7245c1baefa869478c7a5a00ca5366d8a2",
      coreVersion: JSON.parse(
        await readFile(join(installation, "node_modules/explorer-verify/package.json"), "utf8"),
      ).version,
      tarballs: hashes,
    },
    null,
    2,
  ) + "\n",
);
process.exitCode = code ?? 1;
