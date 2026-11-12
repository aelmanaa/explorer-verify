// Smoke test of the published packages on the oldest Node.js release they declare (decision 0071).
//
// The repository's own tests are TypeScript that Node runs natively from 22.18.0, so they cannot
// run on an older Node. This file is plain JavaScript. CI packs the four packages with pnpm,
// installs the tarballs with npm into an empty folder on the floor Node, and runs this file from
// that folder:
//
//   node <repo>/test/node-floor/smoke.mjs <repo>
//
// It imports every entry the packages export, then runs, with no request leaving the machine:
// - `verify()` and `checkStatus()` against a local server that replays recorded Sourcify answers,
//   through the global `fetch`;
// - `verify()` from `explorer-verify/core` and from the routing table, with an injected `fetch`;
// - `createVerifyHandler` against a fake Etherscan `fetch`;
// - the handle, errors, backends and envelope entries;
// - `buildVerifyInputFromFoundry` and `buildVerifyInputFromHardhat` on the repository's fixtures;
// - the `explorer-verify` bin: `--version --json`, `help --json`, and a Foundry and a Hardhat dry
//   run against the replay server.
// The bin must write nothing on stderr: a runtime warning, such as an experimental feature, fails.
//
// Exits 1 on the first failure.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const repo = path.resolve(process.argv[2] ?? ".");
const require = createRequire(path.join(process.cwd(), "package.json"));
const SOURCIFY = path.join(repo, "packages/explorer-verify/test/fixtures/sourcify");
const GREETER = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const SEPOLIA = 11155111;
const INPUT = {
  chainId: SEPOLIA,
  address: GREETER,
  compiler: {
    kind: "solc",
    version: "0.8.24+commit.e11b9ed9",
    input: {
      language: "Solidity",
      sources: { "contracts/Greeter.sol": { content: "contract Greeter {}" } },
      settings: { optimizer: { enabled: true, runs: 200 } },
    },
  },
  contractName: "contracts/Greeter.sol:Greeter",
};

/** A recorded Sourcify answer, by fixture name. */
function recorded(name) {
  return JSON.parse(readFileSync(path.join(SOURCIFY, `${name}.json`), "utf8")).response;
}

/** A `Response` built from a recorded answer. */
function responseOf(name) {
  const { status, headers, body } = recorded(name);
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Starts a server on 127.0.0.1 that answers with the recorded answers in order. A lookup of the
 * Greeter (`GET /v2/contract/...`) after the queue is empty gets the exact match.
 */
async function replayServer(queue) {
  const server = createServer((request, response) => {
    const name =
      queue.shift() ??
      (request.method === "GET" && String(request.url).startsWith("/v2/contract/")
        ? "2026-11-02-lookup-exact-match"
        : undefined);
    request.resume();
    if (name === undefined) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end('{"customCode":"smoke_unexpected_request"}');
      return;
    }
    const { status, headers, body } = recorded(name);
    response.writeHead(status, { ...headers, "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return { server, url: `http://127.0.0.1:${String(address.port)}` };
}

/** Imports every entry the core package exports, JSON files with an import attribute. */
async function importEveryEntry(name) {
  const manifest = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), "utf8"));
  const names = [];
  for (const subpath of Object.keys(manifest.exports)) {
    const specifier = subpath === "." ? name : `${name}/${subpath.slice(2)}`;
    const module = subpath.endsWith(".json")
      ? await import(specifier, { with: { type: "json" } })
      : await import(specifier);
    assert.ok(Object.keys(module).length > 0, `${specifier} exports nothing`);
    names.push(specifier);
  }
  return names;
}

/** Runs the installed bin and returns its exit code, stdout and stderr. */
async function runBin(args, cwd) {
  const bin = path.join(process.cwd(), "node_modules/@explorer-verify/cli/dist/src/bin.js");
  const child = spawn(process.execPath, [bin, ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "", NO_COLOR: "1", CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const code = await new Promise((resolve) => child.on("close", resolve));
  return { code, stdout, stderr };
}

/** Runs the bin, and checks the exit code, an `ok` envelope and an empty stderr. */
async function binEnvelope(args, cwd) {
  const result = await runBin(args, cwd);
  const label = args.join(" ");
  assert.equal(result.code, 0, `${label}: exit ${String(result.code)}\n${result.stderr}`);
  assert.equal(result.stderr, "", `${label} wrote on stderr`);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true, result.stdout);
  return envelope.result;
}

const steps = [];
function pass(step) {
  steps.push(step);
  process.stdout.write(`ok ${String(steps.length)} - ${step}\n`);
}

process.stdout.write(`Node ${process.version}\n`);

for (const name of [
  "explorer-verify",
  "@explorer-verify/foundry",
  "@explorer-verify/hardhat",
  "@explorer-verify/cli",
]) {
  pass(`imports ${(await importEveryEntry(name)).join(", ")}`);
}

const { checkStatus, verify } = await import("explorer-verify");
const { verify: coreVerify } = await import("explorer-verify/core");
const { sourcify } = await import("explorer-verify/clients/sourcify");
const { createVerifyHandler } = await import("explorer-verify/server");
const { formatHandle, parseHandle, tryParseHandle } = await import("explorer-verify/handle");
const { ERROR_CODES, ExplorerVerifyError } = await import("explorer-verify/errors");
const { BACKEND_NAMES, toBackendName } = await import("explorer-verify/backends");
const { exitCodeOf, toEnvelope } = await import("explorer-verify/envelope");
const { buildVerifyInputFromFoundry } = await import("@explorer-verify/foundry");
const { buildVerifyInputFromHardhat } = await import("@explorer-verify/hardhat");

const replay = await replayServer([
  "2026-11-02-lookup-not-verified",
  "2026-11-02-submit-accepted",
  "2026-11-02-job-pending",
  "2026-11-02-job-exact-match",
  "2026-11-02-job-exact-match",
]);
try {
  const handles = [];
  const options = { route: { apiUrl: replay.url }, timeoutMs: 20_000 };
  const verified = await verify(INPUT, {
    ...options,
    pollIntervalMs: 1_000,
    onEvent: (event) => {
      if (event.type === "verify.submitted") {
        handles.push(event.handle);
      }
    },
  });
  assert.equal(verified.status, "verified");
  assert.equal(verified.match, "exact");
  assert.equal(handles.length, 1);
  pass("verify() submits, polls and verifies through the global fetch");

  const resumed = await checkStatus(handles[0], options);
  assert.equal(resumed.status, "verified");
  pass("checkStatus() resumes the handle");

  assert.equal(formatHandle(parseHandle(handles[0])), handles[0]);
  assert.equal(tryParseHandle("ev1:nowhere"), undefined);
  assert.throws(() => parseHandle("ev1:nowhere"), ExplorerVerifyError);
  assert.ok(ERROR_CODES.includes("network"));
  assert.ok(BACKEND_NAMES.includes("sourcify"));
  assert.equal(toBackendName("sourcify"), "sourcify");
  assert.equal(exitCodeOf(verified), 0);
  assert.equal(toEnvelope(verified).ok, true);
  pass("the handle, errors, backends and envelope entries");

  const fromCore = await coreVerify(INPUT, {
    clients: [sourcify()],
    route: { backend: "sourcify", apiUrl: "https://sourcify.example/server" },
    fetch: async () => responseOf("2026-11-02-lookup-exact-match"),
  });
  assert.equal(fromCore.status, "already-verified");
  pass("verify() from explorer-verify/core with an injected fetch");

  const fromTable = await verify(INPUT, {
    fetch: async () => responseOf("2026-11-02-lookup-exact-match"),
  });
  assert.equal(fromTable.status, "already-verified");
  assert.equal(fromTable.backend, "sourcify");
  pass("verify() routed by the routing table");

  const handler = createVerifyHandler({
    apiKey: "dummy-key-0001",
    chains: [SEPOLIA],
    fetch: async () =>
      new Response(JSON.stringify({ status: "1", message: "OK", result: "Pass - Verified" }), {
        headers: { "content-type": "application/json" },
      }),
  });
  const form = (fields) =>
    new Request(`https://dapp.example/api/verify?chainid=${String(SEPOLIA)}`, {
      method: "POST",
      body: new URLSearchParams(fields),
    });
  const forwarded = await handler(
    form({ module: "contract", action: "checkverifystatus", guid: "abc123" }),
  );
  assert.equal(forwarded.status, 200);
  const refused = await handler(form({ module: "contract", action: "getabi", address: GREETER }));
  assert.notEqual(refused.status, 200);
  pass("createVerifyHandler forwards a status poll and refuses getabi");

  const foundryRoot = path.join(repo, "packages/foundry/test/fixtures/project");
  const fromFoundry = await buildVerifyInputFromFoundry({
    root: foundryRoot,
    contract: "Greeter",
    outDir: "out-build-info",
  });
  assert.equal(fromFoundry.contractName, "src/Greeter.sol:Greeter");
  pass("buildVerifyInputFromFoundry reads a Foundry build");

  for (const fixture of ["hardhat-2.29.1", "hardhat-3.21.2"]) {
    const root = path.join(repo, "packages/hardhat/test/fixtures", fixture);
    const built = await buildVerifyInputFromHardhat({ root, contract: "Greeter" });
    assert.match(built.contractName, /Greeter\.sol:Greeter$/);
    pass(`buildVerifyInputFromHardhat reads a ${fixture} build`);
  }

  const version = await binEnvelope(["--version", "--json"], process.cwd());
  assert.equal(typeof version.core, "string");
  pass(`explorer-verify --version --json: cli ${String(version.cli)}`);
  await binEnvelope(["help", "--json"], process.cwd());
  pass("explorer-verify help --json");

  for (const [flag, root, contract] of [
    ["--foundry", foundryRoot, "src/Greeter.sol:Greeter"],
    ["--hardhat", path.join(repo, "packages/hardhat/test/fixtures/hardhat-3.21.2"), "Greeter"],
  ]) {
    const extra = flag === "--foundry" ? ["--out-dir", "out-build-info"] : [];
    const dry = await binEnvelope(
      [
        "verify",
        GREETER,
        "--chain",
        String(SEPOLIA),
        flag,
        root,
        ...extra,
        "--contract",
        contract,
        "--backend",
        "sourcify",
        "--api-url",
        replay.url,
        "--dry-run",
        "--json",
      ],
      process.cwd(),
    );
    assert.equal(dry.status, "dry-run");
    pass(`explorer-verify verify ${flag} --dry-run`);
  }
} finally {
  replay.server.close();
}

process.stdout.write(`${String(steps.length)} checks passed on Node ${process.version}\n`);
