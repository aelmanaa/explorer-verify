import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { packedPackage } from "../packages.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
assert.ok(option("--tarballs"), "Required: --tarballs <directory>");
const tarballs = resolve(option("--tarballs"));
const output = resolve(option("--output") ?? join(here, "results"));
const work = await mkdtemp(join(tmpdir(), "explorer-hardhat-"));
await cp(join(here, "project"), work, { recursive: true });
await mkdir(output, { recursive: true });
const report = {
  schemaVersion: 1,
  project: "hardhat",
  issue: 266,
  candidate: null,
  node: process.version,
  mode: "local-http-stand-in",
  packages: [],
  scenarios: [],
  success: false,
};
function command(bin, argv) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(bin, argv, {
      cwd: work,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", reject);
    child.on("close", (code) => resolveCommand({ code, stdout, stderr }));
  });
}
const hardhat = async (...argv) => {
  const result = await command(process.execPath, ["node_modules/hardhat/dist/src/cli.js", ...argv]);
  const line = result.stdout
    .split("\n")
    .find(
      (candidateLine) =>
        candidateLine.startsWith("{") && candidateLine.includes('"schemaVersion":1'),
    );
  if (argv[0] === "explorer-verify") assert.ok(line, result.stdout + result.stderr);
  return { ...result, envelope: line ? JSON.parse(line) : undefined };
};
let mode = "success";
const submissions = [];
let requests = 0;
const job = "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718";
const address = "0x0000000000000000000000000000000000000001";
const server = createServer(async (req, res) => {
  requests++;
  res.setHeader("content-type", "application/json");
  if (req.method === "POST") {
    let text = "";
    for await (const chunk of req) text += chunk;
    submissions.push(JSON.parse(text));
    res.writeHead(202).end(JSON.stringify({ verificationId: job }));
  } else if (req.url.startsWith("/v2/contract/")) {
    res.writeHead(404).end(JSON.stringify({ match: null, chainId: "31337", address }));
  } else {
    res.end(
      JSON.stringify({
        verificationId: job,
        isJobCompleted: mode !== "pending",
        ...(mode === "pending"
          ? {}
          : {
              contract: {
                chainId: "31337",
                address,
                match: mode === "reject" ? null : "exact_match",
              },
              ...(mode === "reject"
                ? {
                    error: {
                      customCode: "no_match",
                      message: "Synthetic bytecode mismatch",
                    },
                  }
                : {}),
            }),
      }),
    );
  }
});
try {
  const lockPath = join(work, "package-lock.json");
  const consumerLock = JSON.parse(await readFile(lockPath, "utf8"));
  for (const [name, target] of [
    ["explorer-verify", "explorer-verify.tgz"],
    ["@explorer-verify/hardhat", "explorer-verify-hardhat.tgz"],
  ]) {
    const packed = packedPackage(tarballs, name);
    if (name === "explorer-verify") report.candidate = packed.gitHead;
    const bytes = await readFile(packed.path);
    report.packages.push({ name, version: packed.version, file: target, sha256: packed.sha256 });
    await writeFile(join(work, target), bytes);
    consumerLock.packages[`node_modules/${name}`].version = packed.version;
    consumerLock.packages[`node_modules/${name}`].integrity = packed.integrity;
    if (name === "@explorer-verify/hardhat")
      consumerLock.packages[`node_modules/${name}`].peerDependencies["explorer-verify"] =
        packed.manifest.peerDependencies["explorer-verify"];
  }
  await writeFile(lockPath, JSON.stringify(consumerLock, null, 2) + "\n");
  const install = await command("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  assert.equal(install.code, 0, install.stderr);
  await cp(join(work, "package-lock.json"), join(output, "installation-lock.json"));
  const types = await command(process.execPath, [
    "node_modules/typescript/bin/tsc",
    "--project",
    "tsconfig.json",
  ]);
  assert.equal(types.code, 0, types.stdout + types.stderr);
  report.scenarios.push({
    name: "strict-typecheck",
    success: true,
    exitCode: types.code,
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const bound = server.address();
  assert.ok(bound && typeof bound !== "string");
  const api = `http://127.0.0.1:${bound.port}`;
  const run = (...extra) => hardhat("explorer-verify", "--api-url", api, ...extra);
  const record = (name, result) =>
    report.scenarios.push({
      name,
      success: true,
      exitCode: result.code,
      ...result.envelope,
    });
  let built = await hardhat("build");
  assert.equal(built.code, 0, built.stderr);
  record("compile-default", built);
  let result = await run();
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(result.envelope.result.status, "verified");
  record("success-default", result);
  assert.equal(submissions.at(-1).contractIdentifier, "project/contracts/Counter.sol:Counter");
  assert.equal(submissions.at(-1).stdJsonInput.settings.optimizer.enabled, false);
  built = await hardhat("build", "--build-profile", "production");
  assert.equal(built.code, 0, built.stderr);
  record("compile-production", built);
  result = await run();
  assert.equal(result.envelope.result.status, "verified");
  assert.equal(submissions.at(-1).stdJsonInput.settings.optimizer.enabled, true);
  record("success-production", result);
  mode = "reject";
  result = await run();
  assert.equal(result.code, 1);
  assert.equal(result.envelope.result.status, "failed");
  record("explorer-rejection", result);
  mode = "pending";
  result = await run();
  assert.equal(result.code, 1);
  assert.equal(result.envelope.error.code, "not-confirmed");
  record("pending-not-confirmed-with-handle", result);
  const saved = result.envelope.resumeHandle;
  assert.ok(saved);
  const before = submissions.length;
  mode = "success";
  result = await run("--resume", typeof saved === "string" ? saved : JSON.stringify(saved));
  assert.equal(result.envelope.result.status, "verified");
  assert.equal(submissions.length, before);
  record("resume-new-process-no-resubmit", result);
  const info = join(work, "build/artifacts/build-info");
  const files = (await readdir(info)).filter((file) => file.endsWith(".output.json"));
  for (const file of files) await rename(join(info, file), join(info, `${file}.saved`));
  const beforeMissing = requests;
  result = await run();
  assert.equal(result.code, 1);
  assert.equal(result.envelope.error.code, "incomplete-input");
  assert.equal(requests, beforeMissing);
  record("incomplete-build-no-network", result);
  for (const file of files) await rename(join(info, `${file}.saved`), join(info, file));
  result = await run();
  assert.equal(result.envelope.result.status, "verified");
  record("restore-build-recovery", result);
  report.submissions = submissions.map((body) => ({
    contractIdentifier: body.contractIdentifier,
    compilerVersion: body.compilerVersion,
    optimizer: body.stdJsonInput.settings.optimizer,
    sourceNames: Object.keys(body.stdJsonInput.sources),
    inputSha256: createHash("sha256").update(JSON.stringify(body.stdJsonInput)).digest("hex"),
  }));
  report.success = true;
} catch (error) {
  report.failure = String(error);
  process.exitCode = 1;
} finally {
  server.close();
  await writeFile(join(output, "results.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
