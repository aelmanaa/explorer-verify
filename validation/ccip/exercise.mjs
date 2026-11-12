import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";

import { AbiCoder, Interface, getAddress } from "ethers";
import { buildVerifyInput } from "explorer-verify";

import { inputFromDeployResult, qualifiedName, verifyDeployResults } from "./sdk.mjs";
const output = process.argv[2];
const scenarios = [];
const payloads = [];
const names = ["CrossChainToken", "BurnMintTokenPool"];
const owner = "0x1111111111111111111111111111111111111111";
const constructorValues = {
  CrossChainToken: [["Validation CCIP", "VCCIP", 1000000, 100, owner, 18, owner], owner, owner],
  BurnMintTokenPool: [owner, 18, "0x0000000000000000000000000000000000000000", owner, owner],
};
const compilerVersion = "v0.8.26+commit.8a97fa7a";

/**
 * Stands in for an SDK deploy: the same `DeployResult` shape, with the constructor arguments
 * encoded from the contract's ABI as the SDK encodes them. No transaction is sent.
 */
const abis = new Map(
  await Promise.all(
    names.map(async (name) => [
      name,
      JSON.parse(await readFile(`artifacts/${name}.abi.json`, "utf8")),
    ]),
  ),
);
function deployResult(name, index) {
  return {
    hash: `0x${index.toString(16).padStart(64, "0")}`,
    contractAddress: getAddress(`0x${index.toString(16).padStart(40, "0")}`),
    verification: {
      contract: name,
      encodedConstructorArgs: new Interface(abis.get(name)).encodeDeploy(constructorValues[name]),
    },
  };
}
const fixtures = new Map();
for (const name of names) {
  const bytecodeModule = await readFile(`artifacts/${name}.bytecode.ts`, "utf8");
  const creationBytecode = bytecodeModule.match(/'(?<code>0x[0-9a-f]+)'/u)?.groups?.code;
  assert.ok(creationBytecode, "Missing exact upstream bytecode");
  const deploy = deployResult(name, 0x99);
  const input = await inputFromDeployResult({ chainId: 31337, deploy });
  fixtures.set(name, { ...input, creationBytecode });
}

const provenance = JSON.parse(await readFile("artifacts/provenance.json", "utf8"));
for (const entry of provenance.files)
  assert.equal(
    createHash("sha256")
      .update(await readFile(`artifacts/${entry.file}`))
      .digest("hex"),
    entry.sha256,
  );
scenarios.push({ name: "exact-upstream-artifact-hashes", success: true });

/**
 * The explorer's behaviour for the next requests: `lookup` is `none`, `other` (a match of another
 * contract's source) or `partial` (a partial match of this source); `notIndexed` is the number
 * of submits answered with no contract code; `job` is `pass`, `pending` or `mixed`.
 */
let mode = { lookup: "none", notIndexed: 0, job: "pass" };
let sequence = 0;
let notIndexedAnswers = 0;
let submitRequests = 0;
const jobs = new Map();
const serverErrors = [];
const server = createServer(async (req, res) => {
  try {
    let body = "";
    for await (const chunk of req) body += chunk;
    const fields =
      req.method === "POST"
        ? new URLSearchParams(body)
        : new URL(req.url, "http://localhost").searchParams;
    assert.equal(fields.has("apikey"), false);
    assert.equal(fields.has("chainid"), false);
    let answer;
    const action = fields.get("action");
    if (action === "getsourcecode") {
      const stored =
        mode.lookup === "other"
          ? "LockReleaseTokenPool"
          : mode.lookup === "partial"
            ? "BurnMintTokenPool"
            : undefined;
      answer = {
        status: "1",
        message: "OK",
        result: stored
          ? [
              {
                SourceCode: "{{}}",
                ContractName: stored,
                CompilerVersion: compilerVersion,
                SimilarMatch: "0x00000000000000000000000000000000000000aa",
              },
            ]
          : [],
      };
    } else if (action === "verifysourcecode") {
      submitRequests++;
      const name = fields.get("contractname").split(":").at(-1);
      const expected = fixtures.get(name);
      assert.ok(expected);
      assert.equal(req.method, "POST");
      assert.equal(fields.get("codeformat"), "solidity-standard-json-input");
      assert.equal(fields.get("contractname"), expected.contractName);
      assert.equal(fields.get("compilerversion"), compilerVersion);
      assert.deepEqual(JSON.parse(fields.get("sourceCode")), expected.compiler.input);
      assert.equal(Object.keys(expected.compiler.input.settings.libraries ?? {}).length, 0);
      assert.match(expected.creationBytecode, /^0x[0-9a-f]+$/u);
      const args = fields.get("constructorArguements");
      if (name === "BurnMintTokenPool") {
        const decoded = AbiCoder.defaultAbiCoder().decode(
          ["address", "uint8", "address", "address", "address"],
          `0x${args}`,
        );
        assert.equal(decoded[1], 18n);
        assert.equal(decoded[2], "0x0000000000000000000000000000000000000000");
      } else {
        const decoded = AbiCoder.defaultAbiCoder().decode(
          ["tuple(string,string,uint256,uint256,address,uint8,address)", "address", "address"],
          `0x${args}`,
        );
        assert.equal(decoded[0][0], "Validation CCIP");
        assert.equal(decoded[0][5], 18n);
      }
      if (notIndexedAnswers < mode.notIndexed) {
        notIndexedAnswers++;
        answer = {
          status: "0",
          message: "NOTOK",
          result: `Unable to locate ContractCode at ${fields.get("contractaddress")}`,
        };
      } else if (mode.lookup === "other") {
        answer = { status: "0", message: "NOTOK", result: "Contract source code already verified" };
      } else {
        const id = `job-${++sequence}`;
        jobs.set(id, { name, job: mode.job });
        payloads.push({
          name,
          address: fields.get("contractaddress"),
          contractName: fields.get("contractname"),
          constructorArgs: `0x${args}`,
          sourceSha256: createHash("sha256").update(fields.get("sourceCode")).digest("hex"),
          jobId: id,
        });
        answer = { status: "1", message: "OK", result: id };
      }
    } else if (action === "checkverifystatus") {
      const job = jobs.get(fields.get("guid"));
      assert.ok(job);
      const pending = job.job === "pending" && mode.job !== "resume";
      const rejected = job.job === "mixed" && job.name === "CrossChainToken";
      answer = {
        status: pending || rejected ? "0" : "1",
        message: pending || rejected ? "NOTOK" : "OK",
        result: pending
          ? "Pending in queue"
          : rejected
            ? "Fail - Unable to verify. Compiled contract runtime bytecode does NOT match the on-chain runtime bytecode."
            : "Pass - Verified",
      };
    } else throw new Error("Unexpected explorer action");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(answer));
  } catch (error) {
    serverErrors.push(String(error));
    res.statusCode = 500;
    res.end("{}");
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
if (!address || typeof address === "string") throw new Error("No loopback listener");
const apiUrl = `http://127.0.0.1:${address.port}/api`;
const deployments = names.map((name, index) => ({
  chainId: 31337,
  version: "2.0.0",
  deploy: deployResult(name, index + 1),
}));
const options = {
  route: { backend: "etherscan-compatible", apiUrl },
  timeoutMs: 1500,
  pollIntervalMs: 1000,
};
async function cli(command, file, ...flags) {
  const child = spawn(process.execPath, ["cli.mjs", command, file, apiUrl, ...flags], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((done) => child.on("exit", done));
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout);
}
const pool = deployments[1];
try {
  const success = await verifyDeployResults(deployments, options);
  assert.deepEqual(
    success.map((result) => result.status),
    ["verified", "verified"],
  );
  scenarios.push({ name: "sdk-token-and-pool", success: true, results: success });

  // A deploy result in, verified: each field reaches the explorer where it belongs.
  const before = payloads.length;
  const [fromDeploy] = await verifyDeployResults([pool], options);
  assert.equal(fromDeploy.status, "verified");
  const sent = payloads.at(-1);
  assert.equal(payloads.length, before + 1);
  assert.equal(getAddress(sent.address), pool.deploy.contractAddress);
  assert.equal(sent.contractName, "contracts/pools/BurnMintTokenPool.sol:BurnMintTokenPool");
  assert.equal(sent.constructorArgs, pool.deploy.verification.encodedConstructorArgs);
  scenarios.push({
    name: "deploy-result-in-verified",
    success: true,
    deployResult: pool.deploy,
    mapped: {
      address: sent.address,
      contractname: sent.contractName,
      constructorArguements: sent.constructorArgs.slice(2),
    },
    result: fromDeploy,
  });

  await writeFile("deployments.json", JSON.stringify(deployments));
  mode = { lookup: "none", notIndexed: 0, job: "mixed" };
  const mixed = await cli("verify", "deployments.json");
  assert.deepEqual(
    mixed.map((result) => result.status),
    ["failed", "verified"],
  );
  scenarios.push({ name: "cli-per-contract-rejection-isolation", success: true, results: mixed });

  mode = { lookup: "none", notIndexed: 0, job: "pending" };
  const pending = await cli("verify", "deployments.json");
  assert.deepEqual(
    pending.map((result) => result.status),
    ["pending", "pending"],
  );
  const beforeResume = payloads.length;
  mode = { lookup: "none", notIndexed: 0, job: "resume" };
  const resumed = [];
  for (const item of pending) {
    await writeFile("handle.json", JSON.stringify({ handle: item.handle }));
    resumed.push(await cli("resume", "handle.json"));
  }
  assert.deepEqual(
    resumed.map((result) => result.status),
    ["verified", "verified"],
  );
  assert.equal(payloads.length, beforeResume);
  scenarios.push({
    name: "cli-pending-persist-and-resume-without-resubmit",
    success: true,
    pending,
    resumed,
  });

  // The explorer holds another contract's source for the address: the wrapper submits, the
  // explorer refuses, and the result names the stored contract.
  mode = { lookup: "other", notIndexed: 0, job: "pass" };
  const submitsBeforeOther = submitRequests;
  const [other] = await verifyDeployResults([pool], options);
  assert.equal(other.status, "already-verified");
  assert.equal(other.match, "partial");
  assert.deepEqual(other.storedContract, {
    name: "LockReleaseTokenPool",
    compilerVersion,
  });
  assert.equal(submitRequests, submitsBeforeOther + 1);
  scenarios.push({
    name: "other-contract-source-submit-then-stored-contract",
    success: true,
    submits: submitRequests - submitsBeforeOther,
    result: other,
  });

  // Right after the deploy the explorer has not indexed the contract: two submits find no code,
  // and indexWaitMs keeps submitting until the third is accepted.
  mode = { lookup: "none", notIndexed: 2, job: "pass" };
  notIndexedAnswers = 0;
  const submitsBeforeIndex = submitRequests;
  const retries = [];
  const [indexed] = await verifyDeployResults([pool], {
    ...options,
    timeoutMs: 20_000,
    indexWaitMs: 10_000,
    onEvent: (event) => {
      if (event.type === "verify.retry") retries.push(event.reason);
    },
  });
  assert.equal(indexed.status, "verified");
  assert.equal(notIndexedAnswers, 2);
  assert.equal(submitRequests, submitsBeforeIndex + 3);
  assert.deepEqual(retries, ["not-indexed", "not-indexed"]);
  scenarios.push({
    name: "not-indexed-wait-then-verified",
    success: true,
    submits: submitRequests - submitsBeforeIndex,
    retries,
    result: indexed,
  });

  // A partial match of this source, as an explorer shows for bytecode it matched to another
  // address: no submit by default; the CLI's --submit-over-partial passes submitOverPartial.
  mode = { lookup: "partial", notIndexed: 0, job: "pass" };
  await writeFile("pool.json", JSON.stringify([pool]));
  const beforePartial = payloads.length;
  const [kept] = await cli("verify", "pool.json");
  assert.equal(kept.status, "already-verified");
  assert.equal(kept.match, "partial");
  assert.equal(kept.storedContract, undefined);
  assert.equal(payloads.length, beforePartial);
  const [upgraded] = await cli("verify", "pool.json", "--submit-over-partial");
  assert.equal(upgraded.status, "verified");
  assert.equal(upgraded.match, "exact");
  assert.equal(payloads.length, beforePartial + 1);
  scenarios.push({ name: "partial-match-submit-over-partial", success: true, kept, upgraded });

  // A bare name is not enough for a Standard JSON; the wrapper maps it to path:Name.
  let incomplete;
  try {
    buildVerifyInput([
      JSON.parse(await readFile("artifacts/BurnMintTokenPool.standard-input.json", "utf8")),
    ]);
  } catch (error) {
    incomplete = error.code;
  }
  assert.equal(incomplete, "incomplete-input");
  const standardJson = JSON.parse(
    await readFile("artifacts/BurnMintTokenPool.standard-input.json", "utf8"),
  );
  const mappedName = qualifiedName(standardJson, "BurnMintTokenPool");
  assert.equal(mappedName, "contracts/pools/BurnMintTokenPool.sol:BurnMintTokenPool");
  // Two sources declare the name: the wrapper refuses and lists both; the build's `contract`
  // settles it.
  const twice = structuredClone(standardJson);
  twice.sources["copy/BurnMintTokenPool.sol"] = {
    content: "// contract Decoy {}\ncontract BurnMintTokenPool {}\n",
  };
  assert.throws(
    () => qualifiedName(twice, "BurnMintTokenPool"),
    /contracts\/pools\/BurnMintTokenPool\.sol:BurnMintTokenPool, copy\/BurnMintTokenPool\.sol:BurnMintTokenPool/u,
  );
  const settled = await inputFromDeployResult(pool, {
    "BurnMintTokenPool@2.0.0": {
      standardJson: twice,
      compilerVersion: "0.8.26+commit.8a97fa7a",
      contract: "contracts/pools/BurnMintTokenPool.sol:BurnMintTokenPool",
    },
  });
  assert.equal(settled.contractName, mappedName);
  scenarios.push({
    name: "unqualified-name-mapped-from-standard-json",
    success: true,
    errorCode: incomplete,
    mappedName,
  });

  assert.deepEqual(serverErrors, []);
  scenarios.push({
    name: "http-payload-constructor-and-no-external-library-assertions",
    success: true,
    submissions: payloads.length,
  });
} catch (error) {
  scenarios.push({ name: "validation-error", success: false, error: String(error), serverErrors });
  process.exitCode = 1;
} finally {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
const report = {
  project: "ccip",
  success: scenarios.every((scenario) => scenario.success),
  scenarios,
  payloads,
};
await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
