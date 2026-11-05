// Black-box tests for #101 (R-DX-1, R-FLOW-5, R-AX-7, R-AX-8, R-AX-16), written from the public
// contract only: docs/user/reference/cli.md, json-output.md, verify.md, api-keys.md, the skill's
// command-line section, the shipped JSON schemas and the CLI's help. Each test spawns the built bin
// against a local HTTP server on 127.0.0.1 that answers like Sourcify and Etherscan with recorded
// bodies, reached with --backend and --api-url. Each test owns a URL prefix on that server, so it
// counts its own requests while the tests run concurrently.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { buildVerifyInput, validateInput } from "explorer-verify";

import { envelopeProblems, oneEnvelope } from "../helpers/schema.ts";
import { PROJECT, hasPty, runBin } from "../helpers/spawn-bin.ts";
import type { BinOptions, BinResult } from "../helpers/spawn-bin.ts";

const TIMEOUT = { timeout: 40_000 };
// A few bins at a time: dozens at once under coverage and a loaded machine stretch every run.
const CONCURRENT = { concurrency: 4 };
// Dummy keys: plain lower-case letters, so no generic redaction pattern catches them.
const KEY = "plainlowercasedummykeyforblackbox";
const ENV_KEY = "anotherdummyenvironmentkeyvalue";
const ADDRESS = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const CHAIN = "11155111";
const JOB = "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718";
const SOLC = "0.8.24+commit.e11b9ed9";

const CORE_FIXTURES = fileURLToPath(
  new URL("../../../explorer-verify/test/fixtures/", import.meta.url),
);
const DIR = mkdtempSync(join(tmpdir(), "bb101-"));

// ---------------------------------------------------------------------------------------------
// Fixture files
// ---------------------------------------------------------------------------------------------

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The fields of a JSON object, or `undefined` for any other value. */
function fieldsOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function record(value: unknown, label: string): Record<string, unknown> {
  const fields = fieldsOf(value);
  assert.ok(fields !== undefined, `${label} is not an object`);
  return fields;
}

/** The recorded response body of a core fixture. */
function recordedBody(file: string): Record<string, unknown> {
  const fixture = record(readJson(join(CORE_FIXTURES, file)), file);
  return record(record(fixture.response, `${file} response`).body, `${file} body`);
}

function writeFile(name: string, content: string): string {
  const path = join(DIR, name);
  writeFileSync(path, content);
  return path;
}

const FOUNDRY_INPUTS = ["out/build-info/greeter.json", "out/Greeter.sol/Greeter.json"];
const HARDHAT_INPUTS = [
  join(CORE_FIXTURES, "build-formats/hardhat-3.21.2/build-info.json"),
  join(CORE_FIXTURES, "build-formats/hardhat-3.21.2/Greeter.json"),
];
const FOUNDRY_181_INPUTS = [
  join(CORE_FIXTURES, "build-formats/foundry-1.8.1/build-info.json"),
  join(CORE_FIXTURES, "build-formats/foundry-1.8.1/Greeter.json"),
];

// ---------------------------------------------------------------------------------------------
// The fake explorer
// ---------------------------------------------------------------------------------------------

interface Recorded {
  method: string;
  url: string;
  body: string;
  headers: string;
}

type Lookup = "none" | "exact" | "partial";
type Poll = "pending" | "exact" | "no-match";

interface Bucket {
  lookup: Lookup;
  poll: Poll;
  requests: Recorded[];
}

const buckets = new Map<string, Bucket>();
let server: Server | undefined;
let origin = "";

function bucket(name: string, lookup: Lookup = "none", poll: Poll = "exact"): Bucket {
  const created: Bucket = { lookup, poll, requests: [] };
  buckets.set(name, created);
  return created;
}

function sourcifyUrl(name: string): string {
  return `${origin}/b/${name}/server`;
}

function etherscanUrl(name: string): string {
  return `${origin}/b/${name}/v2/api`;
}

/** Copies a recorded body with the chain and the address of this request. */
function withContract(body: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {
    ...body,
    chainId: CHAIN,
    address: ADDRESS,
  };
  const contract = fieldsOf(body.contract);
  if (contract !== undefined) {
    copy.contract = { ...contract, chainId: CHAIN, address: ADDRESS };
  }
  return copy;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function answerSourcify(state: Bucket, method: string, path: string, response: ServerResponse) {
  if (method === "GET" && path.startsWith("/v2/contract/")) {
    if (state.lookup === "none") {
      send(
        response,
        404,
        withContract(recordedBody("sourcify/2026-11-02-lookup-not-verified.json")),
      );
    } else if (state.lookup === "exact") {
      send(
        response,
        200,
        withContract(recordedBody("sourcify/2026-11-02-lookup-exact-match.json")),
      );
    } else {
      send(response, 200, withContract(recordedBody("sourcify/2026-11-02-lookup-match.json")));
    }
    return;
  }
  if (method === "POST" && path.startsWith("/v2/verify/")) {
    send(response, 202, { verificationId: JOB });
    return;
  }
  if (method === "GET" && path.startsWith("/v2/verify/")) {
    const file =
      state.poll === "pending"
        ? "sourcify/2026-11-02-job-pending.json"
        : state.poll === "exact"
          ? "sourcify/2026-11-02-job-exact-match.json"
          : "sourcify/2026-11-02-job-no-match.json";
    send(response, 200, {
      ...withContract(recordedBody(file)),
      verificationId: JOB,
    });
    return;
  }
  send(response, 500, { error: "unexpected request" });
}

/** The creation bytecode of the project's Foundry Greeter artifact, with `0x`. */
function greeterBytecode(): string {
  const artifact = record(readJson(join(PROJECT, "out/Greeter.sol/Greeter.json")), "artifact");
  const object = record(artifact["bytecode"], "bytecode")["object"];
  assert.ok(typeof object === "string" && object.startsWith("0x"));
  return object;
}

function answerEtherscan(url: URL, body: string, response: ServerResponse) {
  const form = new URLSearchParams(body);
  const action = form.get("action") ?? url.searchParams.get("action");
  if (action === "getsourcecode") {
    send(response, 200, recordedBody("etherscan/2026-11-03-getsourcecode-not-verified.json"));
  } else if (action === "verifysourcecode") {
    send(response, 200, recordedBody("etherscan/2026-11-03-verifysourcecode-factory-child.json"));
  } else if (action === "checkverifystatus") {
    send(
      response,
      200,
      recordedBody("etherscan/2026-11-03-checkverifystatus-factory-child-02-pass.json"),
    );
  } else if (action === "getcontractcreation") {
    // The build files fill creationBytecode, so verify() derives the constructor arguments
    // (R-IN-3): the creation code is the project's compiled bytecode plus one argument word.
    send(response, 200, {
      status: "1",
      message: "OK",
      result: [
        {
          contractAddress: form.get("contractaddresses"),
          creationBytecode: `${greeterBytecode()}${"0".repeat(63)}1`,
        },
      ],
    });
  } else {
    send(response, 500, {
      status: "0",
      message: "NOTOK",
      result: "unexpected request",
    });
  }
}

function handle(request: IncomingMessage, response: ServerResponse): void {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk: string) => {
    body += chunk;
  });
  request.on("end", () => {
    const url = new URL(request.url ?? "/", origin);
    const match = /^\/b\/([^/]+)(\/.*)$/u.exec(url.pathname);
    const state = match === null ? undefined : buckets.get(match[1] ?? "");
    if (match === null || state === undefined) {
      send(response, 500, { error: "no bucket" });
      return;
    }
    const method = request.method ?? "GET";
    state.requests.push({
      method,
      url: request.url ?? "",
      body,
      headers: JSON.stringify(request.headers),
    });
    const rest = match[2] ?? "/";
    if (rest.startsWith("/server/")) {
      answerSourcify(state, method, rest.slice("/server".length), response);
    } else {
      answerEtherscan(url, body, response);
    }
  });
}

before(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => {
    server?.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  origin = `http://127.0.0.1:${String(address.port)}`;
});

after(async () => {
  await new Promise<void>((resolve) => {
    server?.closeAllConnections();
    server?.close(() => {
      resolve();
    });
  });
  rmSync(DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

async function run(args: readonly string[], options: BinOptions = {}): Promise<BinResult> {
  return await runBin(args, { cwd: PROJECT, ...options });
}

function inputs(files: readonly string[]): string[] {
  return files.flatMap((file) => ["--input", file]);
}

function sourcify(name: string): string[] {
  return ["--backend", "sourcify", "--api-url", sourcifyUrl(name)];
}

function etherscan(name: string): string[] {
  return ["--backend", "etherscan-v2", "--api-url", etherscanUrl(name)];
}

function submits(state: Bucket): Recorded[] {
  return state.requests.filter(
    (request) =>
      (request.method === "POST" && request.url.includes("/server/v2/verify/")) ||
      request.body.includes("verifysourcecode") ||
      request.url.includes("verifysourcecode"),
  );
}

/** The envelope on stdout, checked against the shipped envelope schema. */
function envelope(res: BinResult, label: string): Record<string, unknown> {
  const parsed = oneEnvelope(res.stdout);
  assert.deepEqual(envelopeProblems(parsed), [], `${label}: envelope breaks the schema`);
  assert.equal(parsed.ok, res.code === 0, `${label}: ok must be true exactly on exit 0`);
  return parsed;
}

function errorCode(parsed: Record<string, unknown>): unknown {
  return fieldsOf(parsed.error)?.["code"];
}

function result(parsed: Record<string, unknown>): Record<string, unknown> {
  return record(parsed.result, "result");
}

function show(res: BinResult): string {
  const text = `exit ${String(res.code)}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`;
  return text.replaceAll(KEY, "<KEY>").replaceAll(ENV_KEY, "<KEY>");
}

function assertNoKey(res: BinResult): void {
  const text = (res.stdout + res.stderr).toLowerCase();
  assert.ok(!text.includes(KEY), "key in the output");
  assert.ok(!text.includes(ENV_KEY), "environment key in the output");
}

/** The verify request as JSON, built with the public API from the same files as the flags. */
function requestJson(files: readonly string[], route?: Record<string, string>, extra = {}): string {
  const built = buildVerifyInput(files.map((file) => readJson(join(PROJECT, file))));
  const input = validateInput({
    chainId: Number(CHAIN),
    address: ADDRESS,
    ...built,
  });
  return JSON.stringify({
    ...input,
    ...(route === undefined ? {} : { route }),
    ...extra,
  });
}

const KEY_FILE = writeFile("key.txt", `${KEY}\n`);
const VALID_HANDLE = `ev1:sourcify:${CHAIN}:${ADDRESS}:${JOB}`;

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

describe("#101 verify from build files (R-DX-1)", CONCURRENT, () => {
  it("verifies from the Foundry build-info and artifact", TIMEOUT, async () => {
    const state = bucket("foundry");
    const res = await run([
      "verify",
      ADDRESS,
      "--chain",
      CHAIN,
      ...inputs(FOUNDRY_INPUTS),
      ...sourcify("foundry"),
      "--json",
    ]);
    assert.equal(res.code, 0, show(res));
    const parsed = envelope(res, "foundry");
    assert.equal(result(parsed).status, "verified", show(res));
    assert.equal(submits(state).length, 1, "one submit");
  });

  it(
    "verifies from the Foundry 1.8.1 build-info recorded in the core fixtures",
    TIMEOUT,
    async () => {
      const state = bucket("foundry181");
      const res = await run([
        "verify",
        ADDRESS,
        "--chain",
        CHAIN,
        ...inputs(FOUNDRY_181_INPUTS),
        ...sourcify("foundry181"),
        "--json",
      ]);
      assert.equal(res.code, 0, show(res));
      assert.equal(result(envelope(res, "foundry181")).status, "verified");
      assert.equal(submits(state).length, 1);
    },
  );

  it("verifies from a Hardhat 3 build-info and artifact", TIMEOUT, async () => {
    const state = bucket("hardhat");
    const res = await run([
      "verify",
      ADDRESS,
      "--chain",
      CHAIN,
      ...inputs(HARDHAT_INPUTS),
      ...sourcify("hardhat"),
      "--json",
    ]);
    assert.equal(res.code, 0, show(res));
    assert.equal(result(envelope(res, "hardhat")).status, "verified");
    assert.equal(submits(state).length, 1);
  });

  it(
    "verifies from a bare Standard JSON input with --contract and --compiler-version",
    TIMEOUT,
    async () => {
      const state = bucket("standard");
      const built = record(readJson(join(PROJECT, "verify-input.json")), "verify-input");
      const standard = writeFile(
        "standard.json",
        JSON.stringify(record(built.compiler, "compiler").input),
      );
      const res = await run([
        "verify",
        ADDRESS,
        "--chain",
        CHAIN,
        "--input",
        standard,
        "--contract",
        "src/Greeter.sol:Greeter",
        "--compiler-version",
        SOLC,
        ...sourcify("standard"),
        "--json",
      ]);
      assert.equal(res.code, 0, show(res));
      assert.equal(result(envelope(res, "standard")).status, "verified");
      assert.equal(submits(state).length, 1);
    },
  );

  it(
    "refuses a bare Standard JSON input without --contract and --compiler-version: exit 2, no request",
    TIMEOUT,
    async () => {
      const state = bucket("standard-bare");
      const built = record(readJson(join(PROJECT, "verify-input.json")), "verify-input");
      const standard = writeFile(
        "standard-bare.json",
        JSON.stringify(record(built.compiler, "compiler").input),
      );
      const res = await run([
        "verify",
        ADDRESS,
        "--chain",
        CHAIN,
        "--input",
        standard,
        ...sourcify("standard-bare"),
        "--json",
      ]);
      assert.equal(res.code, 2, show(res));
      envelope(res, "standard-bare");
      assert.equal(state.requests.length, 0);
    },
  );

  it(
    "accepts the bare form with the address first and prints a text summary",
    TIMEOUT,
    async () => {
      const state = bucket("bare");
      const res = await run([
        ADDRESS,
        "--chain",
        CHAIN,
        ...inputs(FOUNDRY_INPUTS),
        ...sourcify("bare"),
      ]);
      assert.equal(res.code, 0, show(res));
      assert.match(res.stdout, /^verified/u, show(res));
      assert.equal(submits(state).length, 1);
    },
  );

  it(
    "returns already-verified without a submit when the lookup finds a partial match",
    TIMEOUT,
    async () => {
      const state = bucket("partial", "partial");
      const res = await run([
        "verify",
        ADDRESS,
        "--chain",
        CHAIN,
        ...inputs(FOUNDRY_INPUTS),
        ...sourcify("partial"),
        "--json",
      ]);
      assert.equal(res.code, 0, show(res));
      const out = result(envelope(res, "partial"));
      assert.equal(out.status, "already-verified");
      assert.equal(out.match, "partial");
      assert.equal(submits(state).length, 0);
    },
  );

  it("exits 1 with a failed result when the explorer rejects the job", TIMEOUT, async () => {
    bucket("nomatch", "none", "no-match");
    const res = await run([
      "verify",
      ADDRESS,
      "--chain",
      CHAIN,
      ...inputs(FOUNDRY_INPUTS),
      ...sourcify("nomatch"),
      "--json",
    ]);
    assert.equal(res.code, 1, show(res));
    const parsed = envelope(res, "nomatch");
    assert.equal(result(parsed).status, "failed");
    assert.equal(parsed.error, undefined);
  });

  it(
    "prints the verify.submitted event with the handle on stderr at the default level",
    TIMEOUT,
    async () => {
      bucket("submitted");
      const res = await run([
        "verify",
        ADDRESS,
        "--chain",
        CHAIN,
        ...inputs(FOUNDRY_INPUTS),
        ...sourcify("submitted"),
        "--json",
        "--log-format",
        "json",
      ]);
      assert.equal(res.code, 0, show(res));
      const events = res.stderr
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => record(JSON.parse(line), "stderr line"));
      const submitted = events.find((event) => event.type === "verify.submitted");
      assert.ok(submitted !== undefined, show(res));
      assert.equal(submitted.handle, VALID_HANDLE);
    },
  );
});

describe("#101 usage errors before any request", CONCURRENT, () => {
  it("names --input[2] for a bad second --input and never repeats its path", TIMEOUT, async () => {
    const state = bucket("bad-input");
    const bad = writeFile("not-json-secretname.json", "{ not json");
    const res = await run([
      "verify",
      ADDRESS,
      "--chain",
      CHAIN,
      "--input",
      FOUNDRY_INPUTS[0] ?? "",
      "--input",
      bad,
      ...sourcify("bad-input"),
      "--json",
    ]);
    assert.equal(res.code, 2, show(res));
    envelope(res, "bad-input");
    assert.ok((res.stdout + res.stderr).includes("--input[2]"), show(res));
    assert.ok(!(res.stdout + res.stderr).includes("secretname"), show(res));
    assert.equal(state.requests.length, 0);
  });

  it("refuses --backend given twice: exit 2", TIMEOUT, async () => {
    const state = bucket("two-backends");
    const res = await run([
      "verify",
      ADDRESS,
      "--chain",
      CHAIN,
      ...inputs(FOUNDRY_INPUTS),
      ...sourcify("two-backends"),
      "--backend",
      "blockscout",
      "--json",
    ]);
    assert.equal(res.code, 2, show(res));
    envelope(res, "two-backends");
    assert.equal(state.requests.length, 0);
  });
});

describe("#101 --dry-run (R-AX-8)", CONCURRENT, () => {
  it(
    "looks the contract up on Sourcify, sends no submit and reports lookup none",
    TIMEOUT,
    async () => {
      const state = bucket("dry-none");
      const res = await run([
        "verify",
        ADDRESS,
        "--chain",
        CHAIN,
        ...inputs(FOUNDRY_INPUTS),
        ...sourcify("dry-none"),
        "--dry-run",
        "--json",
      ]);
      assert.equal(res.code, 0, show(res));
      const out = result(envelope(res, "dry-none"));
      assert.equal(out.status, "dry-run");
      assert.equal(out.backend, "sourcify");
      // The doc says "its API host"; the host of the URL carries the port.
      assert.equal(out.apiHost, new URL(origin).host);
      assert.equal(out.lookup, "none");
      assert.equal(submits(state).length, 0);
      assert.equal(state.requests.length, 1, "one lookup request");
    },
  );

  it("reports lookup exact when the explorer holds the contract", TIMEOUT, async () => {
    const state = bucket("dry-exact", "exact");
    const res = await run([
      "verify",
      ADDRESS,
      "--chain",
      CHAIN,
      ...inputs(FOUNDRY_INPUTS),
      ...sourcify("dry-exact"),
      "--dry-run",
      "--json",
    ]);
    assert.equal(res.code, 0, show(res));
    assert.equal(result(envelope(res, "dry-exact")).lookup, "exact");
    assert.equal(submits(state).length, 0);
  });

  it(
    "skips the lookup on etherscan-v2 without a key: lookup skipped, no request, exit 0",
    TIMEOUT,
    async () => {
      const state = bucket("dry-skip");
      const res = await run([
        "verify",
        ADDRESS,
        "--chain",
        CHAIN,
        ...inputs(FOUNDRY_INPUTS),
        ...etherscan("dry-skip"),
        "--dry-run",
        "--json",
      ]);
      assert.equal(res.code, 0, show(res));
      const out = result(envelope(res, "dry-skip"));
      assert.equal(out.status, "dry-run");
      assert.equal(out.backend, "etherscan-v2");
      assert.equal(out.lookup, "skipped");
      assert.equal(state.requests.length, 0);
    },
  );

  it(
    "prints the documented dry-run line for etherscan-v2 at api.etherscan.io without a key",
    TIMEOUT,
    async () => {
      // cli.md "Dry run": no key, so no request leaves the machine.
      const res = await run([
        "verify",
        ADDRESS,
        "--chain",
        CHAIN,
        ...inputs(FOUNDRY_INPUTS),
        "--backend",
        "etherscan-v2",
        "--api-url",
        "https://api.etherscan.io/v2/api",
        "--dry-run",
        "--json",
      ]);
      assert.equal(res.code, 0, show(res));
      envelope(res, "doc example");
      assert.equal(
        res.stdout,
        '{"schemaVersion":1,"ok":true,"result":{"status":"dry-run","backend":"etherscan-v2","apiHost":"api.etherscan.io","lookup":"skipped","routedBy":"api-url"}}\n',
      );
    },
  );

  it(
    "with a key from --api-key-file, looks up on etherscan-v2 but sends no verifysourcecode",
    TIMEOUT,
    async () => {
      const state = bucket("dry-key");
      const res = await run([
        "verify",
        ADDRESS,
        "--chain",
        CHAIN,
        ...inputs(FOUNDRY_INPUTS),
        ...etherscan("dry-key"),
        "--api-key-file",
        KEY_FILE,
        "--dry-run",
        "--json",
      ]);
      assert.equal(res.code, 0, show(res));
      assert.equal(result(envelope(res, "dry-key")).lookup, "none");
      assert.ok(state.requests.length >= 1);
      assert.equal(submits(state).length, 0);
      assertNoKey(res);
    },
  );

  it("still exits 2 for an input error under --dry-run", TIMEOUT, async () => {
    const state = bucket("dry-bad");
    const res = await run([
      "verify",
      "0x1234",
      "--chain",
      CHAIN,
      ...inputs(FOUNDRY_INPUTS),
      ...sourcify("dry-bad"),
      "--dry-run",
      "--json",
    ]);
    assert.equal(res.code, 2, show(res));
    assert.equal(errorCode(envelope(res, "dry-bad")), "invalid-input");
    assert.equal(state.requests.length, 0);
  });
});

describe("#101 API keys on etherscan-v2 (R-AX-7)", CONCURRENT, () => {
  it("exits 3 with missing-api-key before any request when no key is given", TIMEOUT, async () => {
    const state = bucket("nokey");
    const res = await run([
      "verify",
      ADDRESS,
      "--chain",
      CHAIN,
      ...inputs(FOUNDRY_INPUTS),
      ...etherscan("nokey"),
      "--json",
    ]);
    assert.equal(res.code, 3, show(res));
    assert.equal(errorCode(envelope(res, "nokey")), "missing-api-key");
    assert.equal(state.requests.length, 0);
  });

  it(
    "does not send ETHERSCAN_API_KEY to an --api-url host: exit 3, no request, key not printed",
    TIMEOUT,
    async () => {
      const state = bucket("envkey");
      const res = await run(
        [
          "verify",
          ADDRESS,
          "--chain",
          CHAIN,
          ...inputs(FOUNDRY_INPUTS),
          ...etherscan("envkey"),
          "--json",
        ],
        { env: { ETHERSCAN_API_KEY: ENV_KEY } },
      );
      assert.equal(res.code, 3, show(res));
      assert.equal(errorCode(envelope(res, "envkey")), "missing-api-key");
      assert.equal(state.requests.length, 0);
      assertNoKey(res);
    },
  );

  it(
    "sends the --api-key-file key only in the POST form body, never in a URL or the output",
    TIMEOUT,
    async () => {
      const state = bucket("filekey");
      const res = await run([
        "verify",
        ADDRESS,
        "--chain",
        CHAIN,
        ...inputs(FOUNDRY_INPUTS),
        ...etherscan("filekey"),
        "--api-key-file",
        KEY_FILE,
        "--json",
        "--verbose",
      ]);
      assert.equal(res.code, 0, show(res));
      assert.equal(result(envelope(res, "filekey")).status, "verified");
      assertNoKey(res);
      assert.ok(state.requests.length >= 3, "lookup, submit and poll");
      assert.equal(submits(state).length, 1);
      for (const request of state.requests) {
        assert.equal(request.method, "POST", `${request.url} is not a POST`);
        assert.ok(!request.url.includes(KEY), "key in a URL");
        assert.ok(!request.headers.includes(KEY), "key in a header");
        assert.equal(
          new URLSearchParams(request.body).get("apikey"),
          KEY,
          "key not in the form body",
        );
      }
    },
  );

  it("with --api-key-stdin sends the key and keeps it out of the output", TIMEOUT, async () => {
    const state = bucket("stdinkey");
    const res = await run(
      [
        "verify",
        ADDRESS,
        "--chain",
        CHAIN,
        ...inputs(FOUNDRY_INPUTS),
        ...etherscan("stdinkey"),
        "--api-key-stdin",
        "--json",
        "--verbose",
      ],
      { stdin: { text: `${KEY}\n` } },
    );
    assert.equal(res.code, 0, show(res));
    assertNoKey(res);
    assert.ok(
      state.requests.every((request) => new URLSearchParams(request.body).get("apikey") === KEY),
    );
  });
});

describe("#101 timeout and status (R-FLOW-5)", CONCURRENT, () => {
  it(
    "exits 4 with the handle after --timeout while the job is pending; status resumes and exits 0 without a submit",
    TIMEOUT,
    async () => {
      const state = bucket("pending", "none", "pending");
      const res = await run([
        "verify",
        ADDRESS,
        "--chain",
        CHAIN,
        ...inputs(FOUNDRY_INPUTS),
        ...sourcify("pending"),
        // Long enough that the lookup and the submit finish inside the budget on a loaded machine,
        // so the run ends not-confirmed with the handle rather than timeout.
        "--timeout",
        "5",
        "--json",
      ]);
      assert.equal(res.code, 4, show(res));
      const parsed = envelope(res, "pending");
      assert.equal(errorCode(parsed), "not-confirmed");
      const pendingHandle = record(parsed.error, "error").handle;
      assert.equal(pendingHandle, VALID_HANDLE);
      assert.ok(res.stderr.includes(VALID_HANDLE), "verify.submitted line carries the handle");
      assert.equal(submits(state).length, 1);

      state.poll = "exact";
      const seen = state.requests.length;
      const status = await run(["status", VALID_HANDLE, ...sourcify("pending"), "--json"]);
      assert.equal(status.code, 0, show(status));
      assert.equal(result(envelope(status, "status")).status, "verified");
      const statusRequests = state.requests.slice(seen);
      assert.ok(statusRequests.length >= 1, "status polled");
      assert.equal(statusRequests.filter((request) => request.method === "POST").length, 0);
    },
  );

  it("status of a pending job exits 4 with the handle after its --timeout", TIMEOUT, async () => {
    const state = bucket("status-pending", "none", "pending");
    const res = await run([
      "status",
      VALID_HANDLE,
      ...sourcify("status-pending"),
      "--timeout",
      "1",
      "--json",
    ]);
    assert.equal(res.code, 4, show(res));
    const parsed = envelope(res, "status-pending");
    assert.equal(errorCode(parsed), "not-confirmed");
    assert.equal(record(parsed.error, "error").handle, VALID_HANDLE);
    assert.equal(submits(state).length, 0);
  });

  it("status refuses a malformed handle: exit 2, no request", TIMEOUT, async () => {
    const state = bucket("status-bad");
    const res = await run(["status", "ev1:nope", ...sourcify("status-bad"), "--json"]);
    assert.equal(res.code, 2, show(res));
    envelope(res, "status-bad");
    assert.equal(state.requests.length, 0);
  });
});

describe("#101 --input-json (R-AX-16)", CONCURRENT, () => {
  it("verify: flags, a JSON file and JSON on stdin give the same stdout", TIMEOUT, async () => {
    bucket("same");
    const route = { backend: "sourcify", apiUrl: sourcifyUrl("same") };
    const json = requestJson(FOUNDRY_INPUTS, route);
    const file = writeFile("same.json", json);
    const common = ["--dry-run", "--json"];
    const [flags, fromFile, fromStdin] = await Promise.all([
      run([
        "verify",
        ADDRESS,
        "--chain",
        CHAIN,
        ...inputs(FOUNDRY_INPUTS),
        ...sourcify("same"),
        ...common,
      ]),
      run(["verify", "--input-json", file, ...common]),
      run(["verify", "--input-json", "-", ...common], {
        stdin: { text: json },
      }),
    ]);
    assert.equal(flags.code, 0, show(flags));
    assert.equal(fromFile.code, 0, show(fromFile));
    assert.equal(fromStdin.code, 0, show(fromStdin));
    envelope(flags, "flags");
    assert.equal(fromFile.stdout, flags.stdout);
    assert.equal(fromStdin.stdout, flags.stdout);
  });

  it(
    "verify: the same full run as flags and as JSON prints the same stdout (text mode)",
    TIMEOUT,
    async () => {
      bucket("same-full-a");
      bucket("same-full-b");
      const json = requestJson(FOUNDRY_INPUTS, {
        backend: "sourcify",
        apiUrl: sourcifyUrl("same-full-b"),
      });
      const file = writeFile("same-full.json", json);
      const [flags, fromFile] = await Promise.all([
        run([
          "verify",
          ADDRESS,
          "--chain",
          CHAIN,
          ...inputs(FOUNDRY_INPUTS),
          ...sourcify("same-full-a"),
        ]),
        run(["verify", "--input-json", file]),
      ]);
      assert.equal(flags.code, 0, show(flags));
      assert.equal(fromFile.code, 0, show(fromFile));
      assert.equal(fromFile.stdout, flags.stdout);
    },
  );

  it("status: flags and JSON give the same stdout and never submit", TIMEOUT, async () => {
    const state = bucket("status-same");
    const file = writeFile(
      "status.json",
      JSON.stringify({
        handle: VALID_HANDLE,
        route: { backend: "sourcify", apiUrl: sourcifyUrl("status-same") },
      }),
    );
    const [flags, fromFile] = await Promise.all([
      run(["status", VALID_HANDLE, ...sourcify("status-same"), "--json"]),
      run(["status", "--input-json", file, "--json"]),
    ]);
    assert.equal(flags.code, 0, show(flags));
    assert.equal(fromFile.code, 0, show(fromFile));
    envelope(flags, "status flags");
    assert.equal(fromFile.stdout, flags.stdout);
    assert.equal(submits(state).length, 0);
  });

  it(
    "the route in the request carries an --api-key-file key to etherscan-v2",
    TIMEOUT,
    async () => {
      const state = bucket("json-key");
      const file = writeFile(
        "json-key.json",
        requestJson(FOUNDRY_INPUTS, {
          backend: "etherscan-v2",
          apiUrl: etherscanUrl("json-key"),
        }),
      );
      const res = await run(["verify", "--input-json", file, "--api-key-file", KEY_FILE, "--json"]);
      assert.equal(res.code, 0, show(res));
      assertNoKey(res);
      assert.ok(state.requests.length >= 1);
      assert.ok(
        state.requests.every((request) => new URLSearchParams(request.body).get("apikey") === KEY),
      );
    },
  );

  it("malformed JSON exits 2 with invalid-input", TIMEOUT, async () => {
    const file = writeFile("malformed.json", '{"chainId": 11155111,');
    const res = await run(["verify", "--input-json", file, "--json"]);
    assert.equal(res.code, 2, show(res));
    assert.equal(errorCode(envelope(res, "malformed")), "invalid-input");
  });

  it("malformed JSON on stdin exits 2", TIMEOUT, async () => {
    const res = await run(["verify", "--input-json", "-", "--json"], {
      stdin: { text: "nope" },
    });
    assert.equal(res.code, 2, show(res));
    envelope(res, "malformed stdin");
  });

  it(
    "unknown properties exit 2 with one issue that counts them and names none",
    TIMEOUT,
    async () => {
      const state = bucket("unknown");
      const file = writeFile(
        "unknown.json",
        requestJson(
          FOUNDRY_INPUTS,
          { backend: "sourcify", apiUrl: sourcifyUrl("unknown") },
          { zzzMysteryField: 1, qqqOtherField: "x", apiKey: KEY },
        ),
      );
      const res = await run(["verify", "--input-json", file, "--json", "--verbose"]);
      assert.equal(res.code, 2, show(res));
      const parsed = envelope(res, "unknown");
      assert.equal(errorCode(parsed), "invalid-input");
      const text = res.stdout + res.stderr;
      for (const name of ["zzzMysteryField", "qqqOtherField", "apiKey"]) {
        assert.ok(!text.includes(name), `${name} named in the output:\n${show(res)}`);
      }
      assert.match(
        String(record(parsed.error, "error").message),
        /3/u,
        "the issue counts the properties",
      );
      assertNoKey(res);
      assert.equal(state.requests.length, 0);
    },
  );

  it("an unknown property inside route exits 2 and names none", TIMEOUT, async () => {
    const file = writeFile(
      "unknown-route.json",
      requestJson(FOUNDRY_INPUTS, {
        backend: "sourcify",
        apiUrl: sourcifyUrl("x"),
        xyzRouteKey: "a",
      }),
    );
    const res = await run(["verify", "--input-json", file, "--json"]);
    assert.equal(res.code, 2, show(res));
    envelope(res, "unknown-route");
    assert.ok(!(res.stdout + res.stderr).includes("xyzRouteKey"), show(res));
  });

  it("unknown properties in a status request exit 2 and name none", TIMEOUT, async () => {
    const file = writeFile(
      "status-unknown.json",
      JSON.stringify({ handle: VALID_HANDLE, pqrsField: 1 }),
    );
    const res = await run(["status", "--input-json", file, "--json"]);
    assert.equal(res.code, 2, show(res));
    envelope(res, "status-unknown");
    assert.ok(!(res.stdout + res.stderr).includes("pqrsField"), show(res));
  });

  for (const extra of [
    ["--chain", CHAIN],
    ["--backend", "sourcify"],
    ["--api-url", "http://127.0.0.1:1/x"],
    ["--input", "out/build-info/greeter.json"],
    ["--contract", "src/Greeter.sol:Greeter"],
    ["--compiler-version", SOLC],
    ["--constructor-args", "0x"],
    ["--creation-tx", `0x${"a".repeat(64)}`],
    ["--library", `src/Base.sol:Base=${ADDRESS}`],
  ]) {
    it(`an extra ${extra[0] ?? ""} with --input-json exits 2`, TIMEOUT, async () => {
      const state = bucket(`extra${extra[0] ?? ""}`);
      const file = writeFile(
        `extra${extra[0] ?? ""}.json`,
        requestJson(FOUNDRY_INPUTS, {
          backend: "sourcify",
          apiUrl: sourcifyUrl(`extra${extra[0] ?? ""}`),
        }),
      );
      const res = await run(["verify", "--input-json", file, ...extra, "--dry-run", "--json"]);
      assert.equal(res.code, 2, show(res));
      envelope(res, String(extra[0]));
      assert.equal(state.requests.length, 0);
    });
  }

  it("a positional argument with --input-json exits 2 (verify and status)", TIMEOUT, async () => {
    const state = bucket("positional");
    const file = writeFile(
      "positional.json",
      requestJson(FOUNDRY_INPUTS, {
        backend: "sourcify",
        apiUrl: sourcifyUrl("positional"),
      }),
    );
    const statusFile = writeFile(
      "positional-status.json",
      JSON.stringify({ handle: VALID_HANDLE }),
    );
    const [verify, bare, status] = await Promise.all([
      run(["verify", ADDRESS, "--input-json", file, "--dry-run", "--json"]),
      run([ADDRESS, "--input-json", file, "--dry-run", "--json"]),
      run(["status", VALID_HANDLE, "--input-json", statusFile, "--json"]),
    ]);
    for (const res of [verify, bare, status]) {
      assert.equal(res.code, 2, show(res));
      envelope(res, "positional");
    }
    assert.equal(state.requests.length, 0);
  });

  it("the allowed flags may accompany --input-json", TIMEOUT, async () => {
    bucket("allowed");
    const file = writeFile(
      "allowed.json",
      requestJson(FOUNDRY_INPUTS, {
        backend: "sourcify",
        apiUrl: sourcifyUrl("allowed"),
      }),
    );
    const res = await run([
      "verify",
      "--input-json",
      file,
      "--json",
      "--log-format",
      "json",
      "--quiet",
      "--color",
      "never",
      "--dry-run",
      "--timeout",
      "30",
    ]);
    assert.equal(res.code, 0, show(res));
    assert.equal(result(envelope(res, "allowed")).status, "dry-run");
  });

  it("--api-key-stdin with --input-json - exits 2", TIMEOUT, async () => {
    const state = bucket("both-stdin");
    const json = requestJson(FOUNDRY_INPUTS, {
      backend: "etherscan-v2",
      apiUrl: etherscanUrl("both-stdin"),
    });
    const res = await run(["verify", "--input-json", "-", "--api-key-stdin", "--json"], {
      stdin: { text: json },
    });
    assert.equal(res.code, 2, show(res));
    envelope(res, "both-stdin");
    assertNoKey(res);
    assert.equal(state.requests.length, 0);
  });

  it(
    "--input-json - exits 2 at once when stdin is a terminal",
    { ...TIMEOUT, skip: hasPty() ? false : "needs python3 with pty" },
    async () => {
      const res = await run(["verify", "--input-json", "-", "--json"], {
        stdinTerminal: true,
      });
      assert.equal(res.code, 2, show(res));
      envelope(res, "tty");
    },
  );

  it("a status request given to verify exits 2", TIMEOUT, async () => {
    const file = writeFile("cross.json", JSON.stringify({ handle: VALID_HANDLE }));
    const res = await run(["verify", "--input-json", file, "--json"]);
    assert.equal(res.code, 2, show(res));
    envelope(res, "cross");
  });
});
