import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir, copyFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { packedPackage } from "../packages.mjs";

const base = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const tarballs = option("--tarballs");
if (typeof tarballs !== "string")
  throw new Error(
    "Usage: node validation/cli-comparison/run.mjs --tarballs <directory> [--output <directory>]",
  );
const output = resolve(option("--output", join(base, ".work/results")));
const work = join(base, ".work");
const install = join(work, "install");
await mkdir(output, { recursive: true });
await mkdir(join(work, "home"), { recursive: true });
const toolDir = option("--foundry-bin", join(homedir(), ".foundry/bin"));
// Deliberate allowlist: never inherit credentials or provider configuration.
const env = {
  PATH: [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
  HOME: join(work, "home"),
  NO_COLOR: "1",
};
const report = {
  candidate: packedPackage(tarballs, "explorer-verify").gitHead,
  scope: "Local fixture only; no live acceptance",
  versions: {},
  tarballs: [],
  setup: [],
  scenarios: [],
};
let origin = "";
const clean = (value) =>
  value
    .replaceAll(process.execPath, "node")
    .replaceAll(base, "<project>")
    .replaceAll(toolDir, "<foundry-bin>")
    .replaceAll(resolve(tarballs), "<tarballs>")
    .replaceAll(origin || "UNUSED_ORIGIN", "<fixture>");
async function command(exe, argv, cwd = base) {
  const child = spawn(exe, argv, {
    cwd,
    env,
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
  const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
  const exitCode = await new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("close", accept);
  });
  clearTimeout(timer);
  assert.ok(Number.isInteger(exitCode), `Command terminated without exit code: ${clean(exe)}`);
  return {
    command: [clean(exe), ...argv.map(clean)],
    exitCode,
    stdout: clean(stdout),
    stderr: clean(stderr),
    rawStdout: stdout,
  };
}
function stored(result) {
  const { rawStdout: _rawStdout, ...rest } = result;
  return rest;
}
for (const name of (await readdir(resolve(tarballs)))
  .filter((fileName) => fileName.endsWith(".tgz"))
  .toSorted()) {
  const bytes = await readFile(join(resolve(tarballs), name));
  report.tarballs.push({
    name,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
assert.equal(report.tarballs.length, 4);
await mkdir(install, { recursive: true });
await copyFile(join(base, "package.json"), join(install, "package.json"));
await copyFile(join(base, "package-lock.json"), join(install, "package-lock.json"));
const dependencies = await command("npm", [
  "ci",
  "--prefix",
  install,
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
]);
assert.equal(dependencies.exitCode, 0, dependencies.stderr);
report.setup.push(stored(dependencies));
const installed = await command("npm", [
  "install",
  "--prefix",
  install,
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--package-lock=false",
  ...report.tarballs.map((item) => join(resolve(tarballs), item.name)),
]);
assert.equal(installed.exitCode, 0, installed.stderr);
report.setup.push(stored(installed));

const forge = join(toolDir, "forge");
const anvil = join(toolDir, "anvil");
for (const tool of ["forge", "cast", "anvil"]) {
  const version = await command(join(toolDir, tool), ["--version"]);
  assert.equal(version.exitCode, 0);
  report.versions[tool] = version.stdout.trim();
  assert.match(version.stdout, /1\.8\.1/);
}
report.versions.node = process.version;
report.versions.npm = (await command("npm", ["--version"])).stdout.trim();
const cli = join(install, "node_modules/@explorer-verify/cli/dist/src/bin.js");
for (const name of [
  "explorer-verify",
  "@explorer-verify/cli",
  "@explorer-verify/foundry",
  "@explorer-verify/hardhat",
]) {
  const manifest = JSON.parse(
    await readFile(join(install, "node_modules", name, "package.json"), "utf8"),
  );
  assert.equal(manifest.version, packedPackage(tarballs, name).version);
  assert.equal(manifest.gitHead ?? null, report.candidate);
}
report.versions.explorer = stored(await command(process.execPath, [cli, "--version", "--json"]));
report.versions.solc = stored(await command(join(base, "solc.cjs"), ["--version"]));
const project = join(base, "project");
const compiler = join(base, "solc.cjs");
const build = await command(forge, [
  "build",
  "--root",
  project,
  "--use",
  compiler,
  "--build-info",
  "--force",
]);
report.setup.push(stored(build));
assert.equal(build.exitCode, 0, build.stderr);
const address = "0x0000000000000000000000000000000000001234";
const contract = "src/Counter.sol:Counter";
const standard = await command(forge, [
  "verify-contract",
  address,
  contract,
  "--root",
  project,
  "--use",
  compiler,
  "--show-standard-json-input",
]);
assert.equal(standard.exitCode, 0, standard.stderr);
const input = JSON.parse(standard.rawStdout);
report.setup.push(stored(standard));
await writeFile(join(output, "compiler-input.json"), JSON.stringify(input, null, 2) + "\n");
const inputFile = join(work, "input.json");
await writeFile(inputFile, JSON.stringify(input));
const artifact = JSON.parse(await readFile(join(project, "out/Counter.sol/Counter.json"), "utf8"));
const solc = createRequire(join(install, "package.json"))("solc");
const compiled = JSON.parse(solc.compile(JSON.stringify(input)));
assert.equal(
  "0x" + compiled.contracts["src/Counter.sol"].Counter.evm.deployedBytecode.object,
  artifact.deployedBytecode.object,
);
let mode = "success",
  requests = [],
  submissions = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/ipfs/")) {
    res.setHeader("content-type", "application/json");
    if (mode === "metadata-missing") {
      res.writeHead(404);
      res.end("{}");
    } else res.end(artifact.rawMetadata);
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  const fields = req.method === "POST" ? new URLSearchParams(body) : url.searchParams;
  const action = fields.get("action");
  requests.push({ method: req.method, action });
  let answer;
  if (action === "getabi")
    answer = {
      status: "0",
      message: "NOTOK",
      result: "Contract source code not verified",
    };
  else if (action === "getsourcecode")
    answer = {
      status: "1",
      message: "OK",
      result: [
        {
          SourceCode: "",
          ABI: "Contract source code not verified",
          ContractName: "",
        },
      ],
    };
  else if (action === "verifysourcecode") {
    const submitted = JSON.parse(fields.get("sourceCode") ?? fields.get("sourcecode"));
    submissions.push({
      input: submitted,
      contract: fields.get("contractname"),
      address: fields.get("contractaddress"),
      compiler: fields.get("compilerversion"),
    });
    answer = { status: "1", message: "OK", result: "local-job-1" };
  } else if (action === "checkverifystatus")
    answer =
      mode === "pending"
        ? { status: "0", message: "NOTOK", result: "Pending in queue" }
        : mode === "rejection"
          ? { status: "0", message: "NOTOK", result: "Fail - Unable to verify" }
          : { status: "1", message: "OK", result: "Pass - Verified" };
  else {
    res.writeHead(400);
    res.end("{}");
    return;
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(answer));
});
await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
origin = `http://127.0.0.1:${server.address().port}`;
// No funded accounts, deployments, signing or transactions. Install compiled runtime directly.
const portProbe = createServer();
await new Promise((accept) => portProbe.listen(0, "127.0.0.1", accept));
const rpcPort = portProbe.address().port;
await new Promise((accept) => portProbe.close(accept));
const chain = spawn(
  anvil,
  ["--host", "127.0.0.1", "--port", String(rpcPort), "--accounts", "0", "--silent"],
  { env, stdio: "ignore" },
);
const rpcUrl = `http://127.0.0.1:${rpcPort}`;
async function rpc(method, params) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const result = await response.json();
  assert.equal(result.error, undefined);
  return result.result;
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await rpc("eth_chainId", []);
      ready = true;
      break;
    } catch {
      await new Promise((accept) => setTimeout(accept, 100));
    }
  }
  assert.ok(ready, "Anvil started");
  assert.deepEqual(await rpc("eth_accounts", []), []);
  await rpc("anvil_setCode", [address, artifact.deployedBytecode.object]);
  assert.equal(await rpc("eth_getCode", [address, "latest"]), artifact.deployedBytecode.object);
  report.target = {
    chainId: 31337,
    address,
    contract,
    installation: "anvil_setCode; zero accounts; no transaction",
    runtimeSha256: createHash("sha256").update(artifact.deployedBytecode.object).digest("hex"),
  };
  const route = [
    "--backend",
    "etherscan-compatible",
    "--api-url",
    `${origin}/api`,
    "--json",
    "--poll-interval",
    "1",
  ];
  const ev = [
    "verify",
    address,
    "--chain",
    "31337",
    "--input",
    inputFile,
    "--contract",
    contract,
    "--compiler-version",
    "0.8.24+commit.e11b9ed9",
    ...route,
  ];
  const fr = [
    "verify-contract",
    address,
    contract,
    "--root",
    project,
    "--use",
    compiler,
    "--chain",
    "31337",
    "--verifier",
    "blockscout",
    "--verifier-url",
    `${origin}/api`,
    "--retries",
    "1",
    "--delay",
    "1",
    "--json",
  ];
  async function scenario(tool, name, argv, expected, fixtureMode = name) {
    mode = fixtureMode;
    requests = [];
    submissions = [];
    const result = await command(
      tool === "explorer-verify" ? process.execPath : forge,
      tool === "explorer-verify" ? [cli, ...argv] : argv,
    );
    let json;
    try {
      json = JSON.parse(result.rawStdout);
    } catch {
      json = null;
    }
    if (["bad-input", "missing-build-data", "incomplete-input", "address-only"].includes(name))
      assert.equal(requests.length, 0);
    if (["resume", "pending-check"].includes(name)) assert.equal(submissions.length, 0);
    const row = {
      tool,
      name,
      ...stored(result),
      json,
      requests,
      counts: {
        invocations: 1,
        http: requests.length,
        submissions: submissions.length,
      },
      submittedInputsMatch: submissions.every(
        (item) =>
          JSON.stringify(item.input.sources) === JSON.stringify(input.sources) &&
          item.address.toLowerCase() === address &&
          item.contract === contract,
      ),
      success: expected(result, json),
    };
    assert.ok(row.submittedInputsMatch, "Submission target and sources match");
    if (
      [
        "success",
        "foundry-project-success",
        "rejection",
        "pending",
        "pending-submit",
        "recovered-input",
      ].includes(name)
    )
      assert.equal(submissions.length, 1);
    for (const submission of submissions) {
      assert.deepEqual(submission.input.sources, input.sources);
      assert.deepEqual(
        { appendCBOR: true, ...submission.input.settings.metadata },
        { appendCBOR: true, ...input.settings.metadata },
      );
      assert.deepEqual(submission.input.settings.optimizer, input.settings.optimizer);
      assert.equal(submission.input.settings.evmVersion, input.settings.evmVersion);
      assert.equal(submission.compiler, "v0.8.24+commit.e11b9ed9");
    }
    report.scenarios.push(row);
    await writeFile(join(output, "results.json"), JSON.stringify(report, null, 2) + "\n");
    assert.ok(row.success, `${tool}/${name}: ${result.stderr} ${result.stdout}`);
    return json;
  }
  await scenario(
    "explorer-verify",
    "success",
    ev,
    (r, j) => r.exitCode === 0 && j?.result?.status === "verified",
  );
  await scenario(
    "explorer-verify",
    "foundry-project-success",
    ["verify", address, "--chain", "31337", "--foundry", project, "--contract", contract, ...route],
    (r, j) => r.exitCode === 0 && j?.result?.status === "verified",
    "success",
  );
  await scenario("forge", "success", [...fr, "--watch"], (r) => r.exitCode === 0);
  await scenario(
    "explorer-verify",
    "rejection",
    ev,
    (r, j) => r.exitCode === 1 && j?.result?.status === "failed",
  );
  await scenario("forge", "rejection", [...fr, "--watch"], (r) => r.exitCode !== 0);
  const pending = await scenario(
    "explorer-verify",
    "pending",
    [...ev, "--timeout", "2"],
    (r, j) => r.exitCode === 4 && j?.error?.code === "not-confirmed",
  );
  const handle = pending.error.handle;
  await scenario(
    "explorer-verify",
    "resume",
    ["status", handle, ...route],
    (r, j) => r.exitCode === 0 && j?.result?.status === "verified",
    "success",
  );
  await scenario("forge", "pending-submit", fr, (r) => r.exitCode === 0, "pending");
  const check = [
    "verify-check",
    "local-job-1",
    "--chain",
    "31337",
    "--verifier",
    "blockscout",
    "--verifier-url",
    `${origin}/api`,
    "--retries",
    "1",
    "--delay",
    "1",
    "--json",
  ];
  await scenario("forge", "pending-check", check, (r) => r.exitCode !== 0, "pending");
  await scenario("forge", "resume", check, (r) => r.exitCode === 0, "success");
  await scenario(
    "explorer-verify",
    "bad-input",
    ev.map((value) => (value === address ? "bad-address" : value)),
    (r, j) => r.exitCode === 2 && j?.error?.code === "invalid-input",
  );
  await scenario(
    "forge",
    "bad-input",
    fr.map((value) => (value === address ? "bad-address" : value)),
    (r) => r.exitCode !== 0,
  );
  await scenario(
    "explorer-verify",
    "missing-build-data",
    ["verify", address, "--chain", "31337", "--foundry", work, "--contract", contract, ...route],
    (r, j) => r.exitCode === 2 && j?.error?.code === "invalid-input",
  );
  const incomplete = JSON.parse(artifact.rawMetadata);
  for (const source of Object.values(incomplete.sources)) delete source.content;
  const metadataFile = join(work, "incomplete-metadata.json");
  await writeFile(metadataFile, JSON.stringify(incomplete));
  await scenario(
    "explorer-verify",
    "incomplete-input",
    ["verify", address, "--chain", "31337", "--input", metadataFile, ...route],
    (r, j) => r.exitCode === 2 && j?.error?.code === "incomplete-input",
  );
  await scenario(
    "forge",
    "missing-build-data",
    fr.map((value) => (value === contract ? "src/Missing.sol:Missing" : value)),
    (r) => r.exitCode !== 0,
  );
  await scenario(
    "explorer-verify",
    "address-only",
    ["verify", address, "--chain", "31337", ...route],
    (r, j) => r.exitCode === 2 && j?.ok === false,
  );
  const { buildVerifyInputFromBytecode } = await import(
    pathToFileURL(createRequire(join(install, "package.json")).resolve("explorer-verify/resolve"))
      .href
  );
  mode = "metadata-missing";
  try {
    await buildVerifyInputFromBytecode(
      { chainId: 31337, address },
      {
        bytecode: artifact.deployedBytecode.object,
        allowSourcifyLookup: false,
        ipfsGateway: origin,
      },
    );
    throw new Error("Expected missing metadata");
  } catch (error) {
    assert.equal(error.code, "metadata-unavailable");
    report.scenarios.push({
      tool: "SDK",
      name: "metadata-unavailable",
      code: error.code,
      success: true,
    });
  }
  mode = "success";
  const recovered = await buildVerifyInputFromBytecode(
    { chainId: 31337, address },
    {
      bytecode: artifact.deployedBytecode.object,
      allowSourcifyLookup: false,
      ipfsGateway: origin,
    },
  );
  assert.equal(recovered.contractName, contract);
  assert.deepEqual(recovered.compiler.input.sources, input.sources);
  const recoveredCompilation = JSON.parse(
    solc.compile(
      JSON.stringify({
        ...recovered.compiler.input,
        settings: {
          ...recovered.compiler.input.settings,
          outputSelection: { "*": { "*": ["evm.deployedBytecode.object"] } },
        },
      }),
    ),
  );
  assert.equal(
    "0x" + recoveredCompilation.contracts["src/Counter.sol"].Counter.evm.deployedBytecode.object,
    artifact.deployedBytecode.object,
  );
  report.scenarios.push({
    tool: "SDK",
    name: "local-metadata-recovery",
    contractName: recovered.contractName,
    success: true,
  });
  const recoveredFile = join(work, "recovered.json");
  await writeFile(
    recoveredFile,
    JSON.stringify({
      chainId: 31337,
      address,
      ...recovered,
      route: { backend: "etherscan-compatible", apiUrl: `${origin}/api` },
    }),
  );
  await scenario(
    "explorer-verify",
    "recovered-input",
    ["verify", "--input-json", recoveredFile, "--json", "--poll-interval", "1"],
    (r, j) => r.exitCode === 0 && j?.result?.status === "verified",
  );
  report.completedAt = new Date().toISOString();
  report.success = report.scenarios.every((row) => row.success === true);
  await writeFile(join(output, "results.json"), JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(
    JSON.stringify({
      success: report.success,
      scenarios: report.scenarios.length,
    }) + "\n",
  );
} finally {
  chain.kill("SIGTERM");
  server.closeAllConnections();
  await new Promise((accept) => server.close(accept));
}
