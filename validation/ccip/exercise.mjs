import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";

import { AbiCoder } from "ethers";
import { buildVerifyInput } from "explorer-verify";

import { artifact, names, verifyCcipBatch } from "./sdk.mjs";
const output = process.argv[2];
const scenarios = [];
const payloads = [];
let mode = "success";
let sequence = 0;
const jobs = new Map();
const fixtures = new Map(
  await Promise.all(names.map(async (name) => [name, await artifact(name)])),
);
const provenance = JSON.parse(await readFile("artifacts/provenance.json", "utf8"));
for (const entry of provenance.files)
  assert.equal(
    createHash("sha256")
      .update(await readFile(`artifacts/${entry.file}`))
      .digest("hex"),
    entry.sha256,
  );
scenarios.push({ name: "exact-upstream-artifact-hashes", success: true });
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
    if (action === "getsourcecode") answer = { status: "1", message: "OK", result: [] };
    else if (action === "verifysourcecode") {
      const name = fields.get("contractname").split(":").at(-1);
      const expected = fixtures.get(name);
      assert.ok(expected);
      assert.equal(req.method, "POST");
      assert.equal(fields.get("codeformat"), "solidity-standard-json-input");
      assert.equal(fields.get("compilerversion"), "v0.8.26+commit.8a97fa7a");
      assert.deepEqual(JSON.parse(fields.get("sourceCode")), expected.compiler.input);
      assert.equal(fields.get("constructorArguements"), expected.constructorArgs.slice(2));
      assert.equal(Object.keys(expected.compiler.input.settings.libraries ?? {}).length, 0);
      assert.match(expected.creationBytecode, /^0x[0-9a-f]+$/u);
      if (name === "BurnMintTokenPool") {
        const decoded = AbiCoder.defaultAbiCoder().decode(
          ["address", "uint8", "address", "address", "address"],
          expected.constructorArgs,
        );
        assert.equal(decoded[1], 18n);
        assert.equal(decoded[2], "0x0000000000000000000000000000000000000000");
      } else {
        const decoded = AbiCoder.defaultAbiCoder().decode(
          ["tuple(string,string,uint256,uint256,address,uint8,address)", "address", "address"],
          expected.constructorArgs,
        );
        assert.equal(decoded[0][0], "Validation CCIP");
        assert.equal(decoded[0][5], 18n);
      }
      const id = `job-${++sequence}`;
      jobs.set(id, { name, mode });
      payloads.push({
        name,
        address: fields.get("contractaddress"),
        constructorArgs: expected.constructorArgs,
        sourceSha256: createHash("sha256").update(fields.get("sourceCode")).digest("hex"),
        jobId: id,
      });
      answer = { status: "1", message: "OK", result: id };
    } else if (action === "checkverifystatus") {
      const job = jobs.get(fields.get("guid"));
      assert.ok(job);
      const pending = job.mode === "pending" && mode !== "resume";
      const rejected = job.mode === "mixed" && job.name === "CrossChainToken";
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
  name,
  chainId: 31337,
  address: `0x${String(index + 1).padStart(40, "0")}`,
}));
const options = {
  route: { backend: "etherscan-compatible", apiUrl },
  timeoutMs: 1500,
  pollIntervalMs: 1000,
};
async function cli(command, file) {
  const child = spawn(process.execPath, ["cli.mjs", command, file, apiUrl], {
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
try {
  const success = await verifyCcipBatch(deployments, options);
  assert.deepEqual(
    success.map((result) => result.status),
    ["verified", "verified"],
  );
  scenarios.push({ name: "sdk-token-and-pool", success: true, results: success });
  await writeFile("deployments.json", JSON.stringify(deployments));
  mode = "mixed";
  const mixed = await cli("verify", "deployments.json");
  assert.deepEqual(
    mixed.map((result) => result.status),
    ["failed", "verified"],
  );
  scenarios.push({ name: "cli-per-contract-rejection-isolation", success: true, results: mixed });
  mode = "pending";
  const pending = await cli("verify", "deployments.json");
  assert.deepEqual(
    pending.map((result) => result.status),
    ["pending", "pending"],
  );
  const before = payloads.length;
  mode = "resume";
  const resumed = [];
  for (const item of pending) {
    await writeFile("handle.json", JSON.stringify({ handle: item.handle }));
    resumed.push(await cli("resume", "handle.json"));
  }
  assert.deepEqual(
    resumed.map((result) => result.status),
    ["verified", "verified"],
  );
  assert.equal(payloads.length, before);
  scenarios.push({
    name: "cli-pending-persist-and-resume-without-resubmit",
    success: true,
    pending,
    resumed,
  });
  let incomplete;
  try {
    buildVerifyInput([
      JSON.parse(await readFile("artifacts/CrossChainToken.standard-input.json", "utf8")),
    ]);
  } catch (error) {
    incomplete = error.code;
  }
  assert.equal(incomplete, "incomplete-input");
  const recovered = await artifact("CrossChainToken");
  assert.equal(recovered.contractName, "contracts/tokens/CrossChainToken.sol:CrossChainToken");
  scenarios.push({
    name: "incomplete-standard-json-recovered-with-pinned-manifest",
    success: true,
    errorCode: incomplete,
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
  issue: 265,
  success: scenarios.every((scenario) => scenario.success),
  scenarios,
  payloads,
};
await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
