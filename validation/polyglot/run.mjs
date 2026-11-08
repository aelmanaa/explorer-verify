import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, join, delimiter, basename } from "node:path";
import { fileURLToPath } from "node:url";

import { packedPackage } from "../packages.mjs";
const root = dirname(fileURLToPath(import.meta.url));
const flag = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
if (!flag("--tarballs"))
  throw new Error(
    "Usage: node validation/polyglot/run.mjs --tarballs <directory> [--output <directory>]",
  );
const tarballs = resolve(flag("--tarballs"));
const work = join(root, ".work");
const output = resolve(flag("--output") ?? join(root, "evidence"));
try {
  await mkdir(work, { recursive: true });
  await mkdir(output, { recursive: true });
  // Allowlist only: no credentials or user Node/npm configuration inherited by clients.
  const environment = {
    PATH: process.env.PATH ?? "",
    HOME: work,
    CI: "1",
    NO_COLOR: "1",
    GOTOOLCHAIN: "local",
    GOCACHE: join(work, "go-cache"),
  };
  function run(command, args, options = {}) {
    const r = spawnSync(command, args, {
      cwd: root,
      env: environment,
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 8 * 1024 * 1024,
      ...options,
    });
    if (r.error || r.status !== 0)
      throw new Error(`${command} failed: ${r.error?.message ?? ""}\n${r.stdout}\n${r.stderr}`);
    return r.stdout;
  }
  const names = [
    "explorer-verify",
    "@explorer-verify/cli",
    "@explorer-verify/foundry",
    "@explorer-verify/hardhat",
  ];
  const pins = JSON.parse(await readFile(join(root, "dependencies.json"), "utf8"));
  const packages = [];
  const core = packedPackage(tarballs, "explorer-verify");
  for (const name of names) {
    const packed = packedPackage(tarballs, name);
    const file = basename(packed.path);
    if (
      packed.gitHead === pins.candidate &&
      pins.packages.find((entry) => entry.file === file)?.sha256 !== packed.sha256
    )
      throw new Error("Recorded candidate tarball checksum mismatch: " + file);
    packages.push({ file, name, version: packed.version, sha256: packed.sha256 });
  }
  await writeFile(
    join(work, "package.json"),
    JSON.stringify({
      private: true,
      name: "polyglot-packed-consumer",
      version: "1.0.0",
    }),
  );
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      ...packages.map((p) => join(tarballs, p.file)),
    ],
    { cwd: work },
  );
  const bin = join(work, "node_modules/.bin/explorer-verify");
  const command = [process.execPath, "--import", join(root, "preload.mjs"), bin];
  const request = {
    chainId: 11155111,
    address: "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc",
    contractName: "src/Greeter.sol:Greeter",
    compiler: {
      kind: "solc",
      version: "0.8.24+commit.e11b9ed9",
      input: {
        language: "Solidity",
        sources: {
          "src/Greeter.sol": {
            content:
              "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.24; contract Greeter {}",
          },
        },
        settings: {},
      },
    },
    route: { backend: "sourcify" },
  };
  const input = join(work, "input.json");
  await writeFile(input, JSON.stringify(request));
  const incomplete = join(work, "incomplete.json");
  await writeFile(
    incomplete,
    JSON.stringify({
      id: "fixture-without-build-info",
      source_id_to_path: { 0: "src/Greeter.sol" },
      language: "Solidity",
    }),
  );
  const verify = [
    "verify",
    "--input-json",
    input,
    "--json",
    "--timeout",
    "3",
    "--poll-interval",
    "1",
  ];
  const definitions = [
    {
      name: "verified",
      scenario: "verified",
      args: verify,
      exitCode: 0,
      expected: "verified",
      submits: 1,
    },
    {
      name: "rejected",
      scenario: "rejected",
      args: verify,
      exitCode: 1,
      expected: "failed",
      submits: 1,
    },
    {
      name: "pending",
      scenario: "pending",
      args: verify,
      exitCode: 4,
      expected: "not-confirmed",
      submits: 1,
    },
    {
      name: "resume",
      scenario: "verified",
      args: ["status", "$HANDLE", "--json", "--timeout", "3"],
      exitCode: 0,
      expected: "verified",
      submits: 0,
    },
    {
      name: "invalid-input",
      scenario: "verified",
      args: ["verify", "--input-json", input, "--json", "--nonsense"],
      exitCode: 2,
      expected: "invalid-input",
      submits: 0,
    },
    {
      name: "incomplete-input",
      scenario: "verified",
      args: [
        "verify",
        request.address,
        "--chain",
        "11155111",
        "--backend",
        "sourcify",
        "--input",
        incomplete,
        "--contract",
        request.contractName,
        "--compiler-version",
        request.compiler.version,
        "--json",
      ],
      exitCode: 2,
      expected: "incomplete-input",
      submits: 0,
    },
    {
      name: "recovered-with-complete-input",
      scenario: "verified",
      args: verify,
      exitCode: 0,
      expected: "verified",
      submits: 1,
    },
  ];
  const javaHome = process.env.JAVA_HOME;
  if (typeof javaHome !== "string" || javaHome.length === 0)
    throw new Error("Set JAVA_HOME to a JDK 17 installation before running the Java consumer.");
  const jar = join(work, "gson-2.11.0.jar");
  const jarHash = "57928d6e5a6edeb2abd3770a8f95ba44dce45f3b23b7a9dc2b309c581552a78b";
  const response = await fetch(
    "https://repo.maven.apache.org/maven2/com/google/code/gson/gson/2.11.0/gson-2.11.0.jar",
  );
  if (!response.ok) throw new Error("Gson download failed");
  const jarBytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(jarBytes).digest("hex") !== jarHash)
    throw new Error("Gson checksum mismatch");
  await writeFile(jar, jarBytes);
  run(join(javaHome, "bin/javac"), ["-cp", jar, "-d", work, join(root, "java/Client.java")]);
  run("go", ["build", "-o", join(work, "go-client"), "."], {
    cwd: join(root, "go"),
  });
  const languages = [
    { language: "python", executable: "python3", args: [join(root, "python/client.py")] },
    { language: "go", executable: join(work, "go-client"), args: [] },
    {
      language: "java",
      executable: join(javaHome, "bin/java"),
      args: ["-cp", work + delimiter + jar, "Client"],
    },
  ];
  const results = [];
  for (const { language, executable, args } of languages) {
    const cases = definitions.map((c) => ({
      ...c,
      log: join(work, `${language}-${c.name}.jsonl`),
    }));
    for (const c of cases) await writeFile(c.log, "");
    const config = join(work, `${language}-config.json`);
    await writeFile(config, JSON.stringify({ command, environment, cases }));
    try {
      const result = JSON.parse(run(executable, [...args, config]));
      for (const c of cases) {
        const requests = (await readFile(c.log, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        const submits = requests.filter((r) => r.submit).length;
        if (submits !== c.submits)
          throw new Error(`${language}/${c.name}: ${submits} submits, expected ${c.submits}`);
        if (["invalid-input", "incomplete-input"].includes(c.name) && requests.length !== 0)
          throw new Error("Invalid input reached network");
        Object.assign(
          result.scenarios.find((s) => s.name === c.name),
          { requests: requests.length, submits },
        );
      }
      results.push(result);
    } catch (error) {
      results.push({ language, success: false, failure: error.message });
    }
  }
  const version = JSON.parse(run(bin, ["--version", "--json"]));
  const report = {
    schemaVersion: 1,
    project: "polyglot",
    issue: 268,
    candidate: core.gitHead,
    mode: "local-preload-protocol-contract",
    success: results.every((r) => r.success),
    packages,
    version,
    runtimes: {
      node: process.version,
      python: run("python3", ["--version"]).trim(),
      go: run("go", ["version"]).trim(),
      java: run(join(javaHome, "bin/java"), ["--version"]).trim(),
    },
    results,
  };
  // Remove runtime-specific paths from diagnostics before writing portable evidence.
  const portable = JSON.stringify(report, null, 2).replaceAll(root, "<project>");
  await writeFile(join(output, "results.json"), portable + "\n");
  console.log(
    JSON.stringify({
      success: report.success,
      languages: results.map((r) => ({
        language: r.language,
        success: r.success,
        failure: r.failure,
      })),
      scenarios: definitions.length,
    }),
  );
  if (!report.success) process.exitCode = 1;
} catch (error) {
  const failure = {
    schemaVersion: 1,
    project: "polyglot",
    success: false,
    phase: "setup-or-runner",
    failure: error.message.replaceAll(root, "<project>"),
  };
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "results.json"), JSON.stringify(failure, null, 2) + "\n");
  console.error(JSON.stringify(failure));
  process.exitCode = 1;
}
