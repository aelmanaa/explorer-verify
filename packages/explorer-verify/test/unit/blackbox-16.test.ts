// Black-box tests for issue #16: the Backend interface and the Sourcify v2 client. They use only
// the declarations of backends/backend.ts, the exported `sourcify`, the issue and its comments,
// docs/user/reference/sourcify.md and docs/contributor/research/2026-11-02-sourcify-v2.md. Every
// request goes to a fake `fetch`; one opt-in test (BLACKBOX_LIVE=1) reads a lookup from sourcify.dev.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspect } from "node:util";

import type { Backend, Context, Match, Target } from "../../src/backends/backend.ts";
import { sourcify } from "../../src/backends/sourcify.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import { parseHandle } from "../../src/flow/handle.ts";
import { resolveRoute } from "../../src/routing/resolve.ts";
import type { Handle, Hex, SolidityStandardJsonInput, VerifyInput } from "../../src/types.ts";

const CHAIN_ID = 11155111;
const ADDRESS: Hex = "0x8275D36F64F047D2D8a1F42c79Bf80Caea39D7cC";
const OTHER_ADDRESS: Hex = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const JOB_ID = "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718";
const SECRET = "DUMMYSECRETq7w3e9r1t5y";
const API = "https://sourcify.dev/server";
const TARGET: Target = { chainId: CHAIN_ID, address: ADDRESS };
const HANDLE: Handle = {
  version: 1,
  backend: "sourcify",
  chainId: CHAIN_ID,
  address: ADDRESS,
  jobId: JOB_ID,
};

const DEFINITIVE = [
  "no_match",
  "bytecode_length_mismatch",
  "compiler_error",
  "missing_source",
  "missing_or_invalid_source",
  "invalid_compilation_target",
  "contract_not_found_in_compiler_output",
  "runtime_bytecode_not_found_in_compiler_output",
  "invalid_compiler_version",
  "unsupported_compiler_version",
  "invalid_language",
  "unsupported_language",
  "compiled_bytecode_is_zero",
  "onchain_bytecode_is_zero",
  "extra_file_input_bug",
];
const TRANSIENT = [
  "internal_error",
  "job_abandoned",
  "compiler_timeout",
  "compiler_out_of_memory",
  "no_compiler_output",
  "cannot_fetch_bytecode",
  "onchain_runtime_bytecode_not_available",
  "onchain_creation_bytecode_not_available",
  "contract_not_deployed",
];
const UNCLASSIFIED = ["creation_bytecode_match_error", "metadata_not_set", "brand_new_code"];

// ---------------------------------------------------------------------------------------------
// Fake fetch

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | undefined;
  readonly signal: AbortSignal | undefined;
}

type Responder = (call: Call) => Response | Promise<Response>;

async function readCall(input: RequestInfo | URL, init: RequestInit | undefined): Promise<Call> {
  if (input instanceof Request) {
    const text = await input.clone().text();
    return {
      url: input.url,
      method: input.method,
      headers: new Headers(input.headers),
      body: text === "" ? undefined : text,
      signal: input.signal,
    };
  }
  const url = typeof input === "string" ? input : input.href;
  const rawBody = init?.body;
  let body: string | undefined;
  if (typeof rawBody === "string") {
    body = rawBody;
  } else if (rawBody !== undefined && rawBody !== null) {
    body = await new Response(rawBody).text();
  }
  return {
    url,
    method: (init?.method ?? "GET").toUpperCase(),
    headers: new Headers(init?.headers),
    body,
    signal: init?.signal ?? undefined,
  };
}

function fakeFetch(...responders: Responder[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...responders];
  const fn: typeof fetch = async (input, init) => {
    const call = await readCall(input, init);
    calls.push(call);
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`unexpected request ${call.method} ${call.url}`);
    }
    return await next(call);
  };
  return { fetch: fn, calls };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Responder {
  return () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", ...headers },
    });
}

function raw(status: number, text: string): Responder {
  return () => new Response(text, { status, headers: { "content-type": "application/json" } });
}

const networkError: Responder = () => {
  throw new TypeError("fetch failed");
};

function errorBody(customCode: string, message = `message for ${customCode}`): object {
  return { customCode, message, errorId: "5f8f2b5e-0000-4000-8000-000000000000" };
}

type WireMatch = "exact_match" | "match" | null;

function lookupBody(
  match: WireMatch,
  over: { chainId?: string; address?: string } = {},
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    match,
    creationMatch: match,
    runtimeMatch: match,
    chainId: over.chainId ?? String(CHAIN_ID),
    address: over.address ?? ADDRESS,
  };
  if (match !== null) {
    base["verifiedAt"] = "2026-11-02T23:39:56Z";
    base["matchId"] = "58142236";
  }
  return base;
}

function jobBody(opts: {
  completed: boolean;
  match?: WireMatch;
  error?: object;
  chainId?: string;
  address?: string;
}): Record<string, unknown> {
  const match = opts.match ?? null;
  const body: Record<string, unknown> = {
    isJobCompleted: opts.completed,
    verificationId: JOB_ID,
    jobStartTime: "2026-11-02T23:39:56Z",
    contract: {
      match,
      creationMatch: match,
      runtimeMatch: match,
      chainId: opts.chainId ?? String(CHAIN_ID),
      address: opts.address ?? ADDRESS,
    },
  };
  if (opts.completed) {
    body["jobFinishTime"] = "2026-11-02T23:39:57Z";
  }
  if (opts.error !== undefined) {
    body["error"] = opts.error;
  }
  return body;
}

// ---------------------------------------------------------------------------------------------
// Context and assertions

/** One retry, read back from the HTTP layer's warn line. */
interface Retry {
  readonly reason: "rate-limited" | "server-error" | "network";
  readonly delayMs: number;
}

interface Harness {
  readonly ctx: Context;
  readonly calls: Call[];
  readonly logs: string[];
  readonly retries: Retry[];
}

/** The retries the warn lines report: `...: answered 429; retrying in 1000 ms ...`. */
function retriesOf(logs: readonly string[]): Retry[] {
  const retries: Retry[] = [];
  for (const line of logs) {
    const found = /^warn .*: (answered (\d+)|no response); retrying in (\d+) ms/.exec(line);
    if (found !== null) {
      const status = found[2];
      retries.push({
        reason:
          status === undefined ? "network" : status === "429" ? "rate-limited" : "server-error",
        delayMs: Number(found[3]),
      });
    }
  }
  return retries;
}

function harness(
  responders: Responder[],
  opts: { apiUrl?: string; secrets?: string[]; signal?: AbortSignal } = {},
): Harness {
  const { fetch, calls } = fakeFetch(...responders);
  const logs: string[] = [];
  const route =
    opts.apiUrl === undefined
      ? resolveRoute(CHAIN_ID)
      : resolveRoute(CHAIN_ID, { backend: "sourcify", apiUrl: opts.apiUrl });
  const log = (level: string) => (message: string) => {
    logs.push(`${level} ${message}`);
  };
  const ctx: Context = {
    route,
    http: {
      backend: "sourcify",
      fetch,
      secrets: opts.secrets ?? [],
      logger: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
      random: () => 0,
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    },
  };
  return {
    ctx,
    calls,
    logs,
    get retries(): Retry[] {
      return retriesOf(logs);
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return assert.fail("expected a rejection");
}

async function evError(promise: Promise<unknown>, code: string): Promise<ExplorerVerifyError> {
  const error = await rejection(promise);
  assert.ok(
    error instanceof ExplorerVerifyError,
    `expected ExplorerVerifyError, got ${inspect(error)}`,
  );
  assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
  return error;
}

function errorText(error: ExplorerVerifyError): string {
  return [
    error.message,
    error.hint,
    String(error.stack),
    JSON.stringify(error),
    JSON.stringify(error.details),
    inspect(error, { depth: 10 }),
  ].join("\n");
}

function lower(url: string): string {
  return url.toLowerCase();
}

const SOURCES: Record<string, { content: string }> = {
  "contracts/Greeter.sol": { content: "pragma solidity ^0.8.24; contract Greeter {}" },
};
const SETTINGS: Record<string, unknown> = {
  optimizer: { enabled: true, runs: 200 },
  evmVersion: "cancun",
  outputSelection: { "*": { "*": ["abi"] } },
};

function verifyInput(over: Partial<VerifyInput> = {}): VerifyInput {
  const input: SolidityStandardJsonInput = {
    language: "Solidity",
    sources: SOURCES,
    settings: SETTINGS,
  };
  return {
    chainId: CHAIN_ID,
    address: ADDRESS,
    compiler: { kind: "solc", version: "0.8.24+commit.e11b9ed9", input },
    contractName: "contracts/Greeter.sol:Greeter",
    ...over,
  };
}

function parsedBody(call: Call | undefined): Record<string, unknown> {
  assert.ok(call !== undefined, "no call");
  assert.ok(call.body !== undefined, "no body");
  const parsed: unknown = JSON.parse(call.body);
  assert.ok(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
  return Object.fromEntries(Object.entries(parsed));
}

const backend: Backend = sourcify;

// ---------------------------------------------------------------------------------------------

describe("blackbox #16: Backend shape", () => {
  it("is named sourcify and has the four methods", () => {
    assert.equal(backend.name, "sourcify");
    assert.equal(typeof backend.lookup, "function");
    assert.equal(typeof backend.submit, "function");
    assert.equal(typeof backend.poll, "function");
    assert.equal(typeof backend.explorerUrl, "function");
  });

  it("explorerUrl is repo.sourcify.dev on the default route", () => {
    const h = harness([]);
    const url = backend.explorerUrl(TARGET, h.ctx);
    assert.ok(url !== undefined);
    assert.equal(lower(url), lower(`https://repo.sourcify.dev/${String(CHAIN_ID)}/${ADDRESS}`));
    assert.equal(h.calls.length, 0);
  });

  it("explorerUrl is undefined when the route points at another server", () => {
    const h = harness([], { apiUrl: "https://sourcify.example.org/server" });
    assert.equal(backend.explorerUrl(TARGET, h.ctx), undefined);
  });
});

describe("blackbox #16: lookup mapping (R-BE-4, R-FLOW-4)", () => {
  const cases: { wire: WireMatch; expected: Match }[] = [
    { wire: "exact_match", expected: "exact" },
    { wire: "match", expected: "partial" },
  ];
  for (const { wire, expected } of cases) {
    it(`200 ${String(wire)} -> ${expected}`, async () => {
      const h = harness([json(200, lookupBody(wire), { "cache-control": "public,max-age=3600" })]);
      assert.equal(await backend.lookup(TARGET, h.ctx), expected);
    });
  }

  it("404 with match null -> undefined (not verified)", async () => {
    const h = harness([json(404, lookupBody(null))]);
    assert.equal(await backend.lookup(TARGET, h.ctx), undefined);
  });

  it("400 unsupported_chain -> unsupported-chain naming the chain and backend", async () => {
    const h = harness([json(400, errorBody("unsupported_chain"))]);
    const error = await evError(backend.lookup(TARGET, h.ctx), "unsupported-chain");
    assert.deepEqual(error.details, {
      code: "unsupported-chain",
      chainId: CHAIN_ID,
      backend: "sourcify",
    });
  });

  it("500 -> unexpected-response, never 'not verified'", async () => {
    const h = harness([json(500, errorBody("internal_error"))]);
    const error = await evError(backend.lookup(TARGET, h.ctx), "unexpected-response");
    if (error.details.code === "unexpected-response") {
      assert.equal(error.details.status, 500);
    }
  });

  it("400 with another customCode -> unexpected-response", async () => {
    const h = harness([json(400, errorBody("invalid_parameter"))]);
    await evError(backend.lookup(TARGET, h.ctx), "unexpected-response");
  });

  it("200 with match null -> unexpected-response", async () => {
    const h = harness([json(200, lookupBody(null))]);
    await evError(backend.lookup(TARGET, h.ctx), "unexpected-response");
  });

  it("200 without the match fields -> unexpected-response", async () => {
    const h = harness([json(200, { chainId: String(CHAIN_ID), address: ADDRESS })]);
    await evError(backend.lookup(TARGET, h.ctx), "unexpected-response");
  });

  it("200 with an unknown match value -> unexpected-response", async () => {
    const body = { ...lookupBody("exact_match"), match: "perfect_match" };
    const h = harness([json(200, body)]);
    await evError(backend.lookup(TARGET, h.ctx), "unexpected-response");
  });

  it("404 with a non-null match -> unexpected-response", async () => {
    const h = harness([json(404, lookupBody("exact_match"))]);
    await evError(backend.lookup(TARGET, h.ctx), "unexpected-response");
  });

  it("404 with an error body instead of the match fields -> unexpected-response", async () => {
    const h = harness([json(404, errorBody("not_found"))]);
    await evError(backend.lookup(TARGET, h.ctx), "unexpected-response");
  });

  it("an HTML 200 page -> unexpected-response", async () => {
    const h = harness([() => new Response("<html>hi</html>", { status: 200 })]);
    await evError(backend.lookup(TARGET, h.ctx), "unexpected-response");
  });
});

describe("blackbox #16: submit mapping", () => {
  it("202 with a UUID verificationId -> submitted with a handle for the input's contract", async () => {
    const h = harness([json(202, { verificationId: JOB_ID })]);
    const outcome = await backend.submit(verifyInput(), h.ctx);
    assert.equal(outcome.state, "submitted");
    if (outcome.state === "submitted") {
      assert.equal(outcome.handle.version, 1);
      assert.equal(outcome.handle.backend, "sourcify");
      assert.equal(outcome.handle.chainId, CHAIN_ID);
      assert.equal(lower(outcome.handle.address), lower(ADDRESS));
      assert.equal(outcome.handle.jobId, JOB_ID);
    }
  });

  it("202 without a verificationId -> unexpected-response", async () => {
    const h = harness([json(202, {})]);
    await evError(backend.submit(verifyInput(), h.ctx), "unexpected-response");
  });

  it("202 with a verificationId that is not a job id (path characters) -> unexpected-response", async () => {
    const h = harness([json(202, { verificationId: "../../v2/contract/1/x" })]);
    await evError(backend.submit(verifyInput(), h.ctx), "unexpected-response");
  });

  it("202 with a numeric verificationId -> unexpected-response", async () => {
    const h = harness([json(202, { verificationId: 42 })]);
    await evError(backend.submit(verifyInput(), h.ctx), "unexpected-response");
  });

  it("409 already_verified -> already-verified exact, one request", async () => {
    const h = harness([json(409, errorBody("already_verified"))]);
    assert.deepEqual(await backend.submit(verifyInput(), h.ctx), {
      state: "already-verified",
      match: "exact",
    });
    assert.equal(h.calls.length, 1);
  });

  it("409 with another customCode -> unexpected-response", async () => {
    const h = harness([json(409, errorBody("something_else"))]);
    await evError(backend.submit(verifyInput(), h.ctx), "unexpected-response");
  });

  it("400 unsupported_chain -> unsupported-chain", async () => {
    const h = harness([json(400, errorBody("unsupported_chain"))]);
    const error = await evError(backend.submit(verifyInput(), h.ctx), "unsupported-chain");
    assert.deepEqual(error.details, {
      code: "unsupported-chain",
      chainId: CHAIN_ID,
      backend: "sourcify",
    });
  });

  it("400 invalid_parameter -> unexpected-response, not retried", async () => {
    const h = harness([json(400, errorBody("invalid_parameter"))]);
    const error = await evError(backend.submit(verifyInput(), h.ctx), "unexpected-response");
    if (error.details.code === "unexpected-response") {
      assert.equal(error.details.status, 400);
    }
    assert.equal(h.calls.length, 1);
  });

  it("429 duplicate_verification_request -> in-progress, not retried", async () => {
    const h = harness([json(429, errorBody("duplicate_verification_request"))]);
    const error = await evError(backend.submit(verifyInput(), h.ctx), "in-progress");
    assert.deepEqual(error.details, { code: "in-progress", backend: "sourcify" });
    assert.equal(h.calls.length, 1);
    assert.equal(h.retries.length, 0);
  });

  it("200 instead of 202 -> unexpected-response", async () => {
    const h = harness([json(200, { verificationId: JOB_ID })]);
    await evError(backend.submit(verifyInput(), h.ctx), "unexpected-response");
  });
});

describe("blackbox #16: poll mapping", () => {
  it("isJobCompleted false -> pending", async () => {
    const h = harness([json(200, jobBody({ completed: false }))]);
    assert.deepEqual(await backend.poll(HANDLE, h.ctx), { state: "pending" });
  });

  it("completed exact_match -> verified exact", async () => {
    const h = harness([json(200, jobBody({ completed: true, match: "exact_match" }))]);
    assert.deepEqual(await backend.poll(HANDLE, h.ctx), { state: "verified", match: "exact" });
  });

  it("completed match -> verified partial", async () => {
    const h = harness([json(200, jobBody({ completed: true, match: "match" }))]);
    assert.deepEqual(await backend.poll(HANDLE, h.ctx), { state: "verified", match: "partial" });
  });

  it("completed with error already_verified -> already-verified", async () => {
    const h = harness([
      json(200, jobBody({ completed: true, error: errorBody("already_verified") })),
    ]);
    const outcome = await backend.poll(HANDLE, h.ctx);
    assert.equal(outcome.state, "already-verified");
  });

  for (const code of DEFINITIVE) {
    it(`completed with ${code} -> failed with '<code>: <message>'`, async () => {
      const h = harness([
        json(200, jobBody({ completed: true, error: errorBody(code, `why ${code}`) })),
      ]);
      assert.deepEqual(await backend.poll(HANDLE, h.ctx), {
        state: "failed",
        reason: `${code}: why ${code}`,
      });
    });
  }

  for (const code of TRANSIENT) {
    it(`completed with ${code} -> verification-inconclusive, retryable, no handle`, async () => {
      const h = harness([json(200, jobBody({ completed: true, error: errorBody(code) }))]);
      const error = await evError(backend.poll(HANDLE, h.ctx), "verification-inconclusive");
      assert.equal(error.retryable, true);
      assert.deepEqual(error.details, {
        code: "verification-inconclusive",
        backend: "sourcify",
        reason: `${code}: message for ${code}`,
      });
    });
  }

  for (const code of UNCLASSIFIED) {
    it(`completed with unclassified ${code} -> unknown-state, never verified`, async () => {
      const h = harness([json(200, jobBody({ completed: true, error: errorBody(code) }))]);
      const error = await evError(backend.poll(HANDLE, h.ctx), "unknown-state");
      if (error.details.code === "unknown-state") {
        assert.deepEqual(error.details.handle, HANDLE);
      }
    });
  }

  it("completed with neither match nor error -> unknown-state", async () => {
    const h = harness([json(200, jobBody({ completed: true }))]);
    await evError(backend.poll(HANDLE, h.ctx), "unknown-state");
  });

  it("unknown-state excerpt stays within 300 characters for a large onchainRuntimeCode", async () => {
    const error = {
      ...errorBody("creation_bytecode_match_error"),
      onchainRuntimeCode: `0x${"ab".repeat(50_000)}`,
    };
    const h = harness([json(200, jobBody({ completed: true, error }))]);
    const thrown = await evError(backend.poll(HANDLE, h.ctx), "unknown-state");
    if (thrown.details.code === "unknown-state") {
      assert.ok(
        thrown.details.excerpt.length <= 300,
        `excerpt ${String(thrown.details.excerpt.length)}`,
      );
    }
    assert.ok(thrown.message.length < 2000, "message carries the whole body");
  });

  it("404 job_not_found -> job-not-found with the handle", async () => {
    const h = harness([json(404, errorBody("job_not_found"))]);
    const error = await evError(backend.poll(HANDLE, h.ctx), "job-not-found");
    assert.deepEqual(error.details, { code: "job-not-found", handle: HANDLE });
  });

  it("404 with another code -> not job-not-found and not success", async () => {
    const h = harness([json(404, errorBody("route_not_found"))]);
    const error = await rejection(backend.poll(HANDLE, h.ctx));
    assert.ok(error instanceof ExplorerVerifyError);
    assert.notEqual(error.code, "job-not-found");
  });

  it("500 on poll -> throws, never pending or verified", async () => {
    const h = harness([json(500, errorBody("internal_error"))]);
    const error = await rejection(backend.poll(HANDLE, h.ctx));
    assert.ok(error instanceof ExplorerVerifyError);
  });

  it("isJobCompleted missing -> throws", async () => {
    const body = jobBody({ completed: true, match: "exact_match" });
    delete body["isJobCompleted"];
    const h = harness([json(200, body)]);
    const error = await rejection(backend.poll(HANDLE, h.ctx));
    assert.ok(error instanceof ExplorerVerifyError);
  });
});

describe("blackbox #16: request shapes", () => {
  it("lookup is GET {api}/v2/contract/{chainId}/{address} with no body and no fields=all", async () => {
    const h = harness([json(200, lookupBody("exact_match"))]);
    await backend.lookup(TARGET, h.ctx);
    assert.equal(h.calls.length, 1);
    const call = h.calls[0];
    assert.ok(call !== undefined);
    assert.equal(call.method, "GET");
    assert.equal(lower(call.url), lower(`${API}/v2/contract/${String(CHAIN_ID)}/${ADDRESS}`));
    assert.equal(call.body, undefined);
    assert.ok(!call.url.includes("fields"));
    assert.equal(call.headers.get("authorization"), null);
  });

  it("poll is GET {api}/v2/verify/{jobId}", async () => {
    const h = harness([json(200, jobBody({ completed: false }))]);
    await backend.poll(HANDLE, h.ctx);
    const call = h.calls[0];
    assert.ok(call !== undefined);
    assert.equal(call.method, "GET");
    assert.equal(call.url, `${API}/v2/verify/${JOB_ID}`);
    assert.equal(call.body, undefined);
  });

  it("submit is POST {api}/v2/verify/{chainId}/{address} with JSON content-type", async () => {
    const h = harness([json(202, { verificationId: JOB_ID })]);
    await backend.submit(verifyInput(), h.ctx);
    const call = h.calls[0];
    assert.ok(call !== undefined);
    assert.equal(call.method, "POST");
    assert.equal(lower(call.url), lower(`${API}/v2/verify/${String(CHAIN_ID)}/${ADDRESS}`));
    const type = call.headers.get("content-type");
    assert.ok(type !== null && type.toLowerCase().startsWith("application/json"), String(type));
    assert.equal(call.headers.get("authorization"), null);
  });

  it("submit body: stdJsonInput object with only language, sources, settings; documented fields only", async () => {
    const wide: SolidityStandardJsonInput & { evmVersion: string; remappings: string[] } = {
      language: "Solidity",
      sources: SOURCES,
      settings: SETTINGS,
      evmVersion: "cancun",
      remappings: ["a=b"],
    };
    const input = verifyInput({
      compiler: { kind: "solc", version: "0.8.24+commit.e11b9ed9", input: wide },
      constructorArgs: "0x000000000000000000000000000000000000000000000000000000000000beef",
    });
    const h = harness([json(202, { verificationId: JOB_ID })]);
    await backend.submit(input, h.ctx);
    const body = parsedBody(h.calls[0]);
    assert.deepEqual(Object.keys(body).toSorted(), [
      "compilerVersion",
      "contractIdentifier",
      "stdJsonInput",
    ]);
    assert.deepEqual(body["stdJsonInput"], {
      language: "Solidity",
      sources: SOURCES,
      settings: SETTINGS,
    });
    assert.equal(body["compilerVersion"], "0.8.24+commit.e11b9ed9");
    assert.equal(body["contractIdentifier"], "contracts/Greeter.sol:Greeter");
    const call = h.calls[0];
    assert.ok(call?.body !== undefined);
    assert.ok(!call.body.includes("beef"), "constructor arguments were sent");
  });

  it("submit body carries creationTransactionHash when creationTxHash is set", async () => {
    const tx: Hex = `0x${"1".repeat(64)}`;
    const h = harness([json(202, { verificationId: JOB_ID })]);
    await backend.submit(verifyInput({ creationTxHash: tx }), h.ctx);
    const body = parsedBody(h.calls[0]);
    assert.equal(body["creationTransactionHash"], tx);
    assert.deepEqual(Object.keys(body).toSorted(), [
      "compilerVersion",
      "contractIdentifier",
      "creationTransactionHash",
      "stdJsonInput",
    ]);
  });

  it("a source path with &apikey=x reaches Sourcify as data and adds no URL parameter", async () => {
    const sources = { "contracts/a&apikey=x.sol": { content: "contract A {}" } };
    const h = harness([json(202, { verificationId: JOB_ID })]);
    await backend.submit(
      verifyInput({
        compiler: {
          kind: "solc",
          version: "0.8.24+commit.e11b9ed9",
          input: { language: "Solidity", sources, settings: {} },
        },
        contractName: "contracts/a&apikey=x.sol:A",
      }),
      h.ctx,
    );
    const call = h.calls[0];
    assert.ok(call !== undefined);
    assert.equal(new URL(call.url).search, "");
    const body = parsedBody(call);
    assert.deepEqual(body["stdJsonInput"], { language: "Solidity", sources, settings: {} });
    assert.equal(body["contractIdentifier"], "contracts/a&apikey=x.sol:A");
  });

  it("requests on an override route keep the caller's query string", async () => {
    const h = harness([json(200, lookupBody("match"))], {
      apiUrl: "https://sourcify.example.org/server?token=abc",
    });
    await backend.lookup(TARGET, h.ctx);
    const call = h.calls[0];
    assert.ok(call !== undefined);
    const url = new URL(call.url);
    assert.equal(url.origin, "https://sourcify.example.org");
    assert.equal(lower(url.pathname), lower(`/server/v2/contract/${String(CHAIN_ID)}/${ADDRESS}`));
    assert.equal(url.searchParams.get("token"), "abc");
  });
});

describe("blackbox #16: answers about another contract (R-SEC)", () => {
  it("lookup 200 with another chainId -> unexpected-response", async () => {
    const h = harness([json(200, lookupBody("exact_match", { chainId: "1" }))]);
    await evError(backend.lookup(TARGET, h.ctx), "unexpected-response");
  });

  it("lookup 200 with another address -> unexpected-response", async () => {
    const h = harness([json(200, lookupBody("exact_match", { address: OTHER_ADDRESS }))]);
    await evError(backend.lookup(TARGET, h.ctx), "unexpected-response");
  });

  it("lookup 404 with another address -> unexpected-response, not 'not verified'", async () => {
    const h = harness([json(404, lookupBody(null, { address: OTHER_ADDRESS }))]);
    await evError(backend.lookup(TARGET, h.ctx), "unexpected-response");
  });

  it("lookup 200 with the same address in lower case is accepted", async () => {
    const h = harness([json(200, lookupBody("exact_match", { address: ADDRESS.toLowerCase() }))]);
    assert.equal(await backend.lookup(TARGET, h.ctx), "exact");
  });

  it("poll with another chainId -> unexpected-response", async () => {
    const h = harness([
      json(200, jobBody({ completed: true, match: "exact_match", chainId: "137" })),
    ]);
    await evError(backend.poll(HANDLE, h.ctx), "unexpected-response");
  });

  it("poll with another address -> unexpected-response", async () => {
    const h = harness([
      json(200, jobBody({ completed: true, match: "exact_match", address: OTHER_ADDRESS })),
    ]);
    await evError(backend.poll(HANDLE, h.ctx), "unexpected-response");
  });
});

describe("blackbox #16: malformed bodies", () => {
  it("lookup 200 with malformed JSON -> unexpected-response", async () => {
    const h = harness([raw(200, '{"match": "exact_match",')]);
    await evError(backend.lookup(TARGET, h.ctx), "unexpected-response");
  });

  it("lookup 404 with malformed JSON -> unexpected-response, not 'not verified'", async () => {
    const h = harness([raw(404, "not json")]);
    await evError(backend.lookup(TARGET, h.ctx), "unexpected-response");
  });

  it("submit 202 with malformed JSON -> lookup, one more submit, then unexpected-response", async () => {
    const h = harness([
      raw(202, "{verificationId"),
      json(404, lookupBody(null)),
      raw(202, "{verificationId"),
    ]);
    await evError(backend.submit(verifyInput(), h.ctx), "unexpected-response");
    assert.deepEqual(
      h.calls.map((call) => call.method),
      ["POST", "GET", "POST"],
    );
  });

  it("poll 200 with malformed JSON -> unexpected-response", async () => {
    const h = harness([raw(200, "{")]);
    await evError(backend.poll(HANDLE, h.ctx), "unexpected-response");
  });

  it("poll 200 with a JSON array -> throws", async () => {
    const h = harness([json(200, [1, 2])]);
    const error = await rejection(backend.poll(HANDLE, h.ctx));
    assert.ok(error instanceof ExplorerVerifyError);
  });
});

describe("blackbox #16: lookup, submit, handle round-trip, poll", () => {
  it("looks up first, submits, stores the handle as JSON, parses it back and polls to verified", async () => {
    const h = harness([
      json(404, lookupBody(null)),
      json(202, { verificationId: JOB_ID }),
      json(200, jobBody({ completed: false })),
      json(200, jobBody({ completed: true, match: "exact_match" })),
    ]);
    assert.equal(await backend.lookup(TARGET, h.ctx), undefined);
    const outcome = await backend.submit(verifyInput(), h.ctx);
    assert.equal(outcome.state, "submitted");
    if (outcome.state !== "submitted") return;
    const stored = JSON.stringify(outcome.handle);
    const handle = parseHandle(JSON.parse(stored));
    assert.deepEqual(handle, outcome.handle);
    assert.deepEqual(await backend.poll(handle, h.ctx), { state: "pending" });
    assert.deepEqual(await backend.poll(handle, h.ctx), { state: "verified", match: "exact" });
    assert.deepEqual(
      h.calls.map((c) => c.method),
      ["GET", "POST", "GET", "GET"],
    );
    assert.ok(h.calls[0]?.url.includes("/v2/contract/"));
    assert.ok(h.calls[1]?.url.includes("/v2/verify/"));
    assert.equal(h.calls[2]?.url, `${API}/v2/verify/${JOB_ID}`);
  });

  it("poll builds its URL from the route, never from the handle", async () => {
    const h = harness([json(200, jobBody({ completed: false }))], {
      apiUrl: "https://sourcify.example.org/server",
    });
    await backend.poll(HANDLE, h.ctx);
    assert.equal(h.calls[0]?.url, `https://sourcify.example.org/server/v2/verify/${JOB_ID}`);
  });
});

function hangingResponder(): Responder {
  return (call) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = call.signal;
      if (signal === undefined) {
        return;
      }
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => {
        reject(signal.reason);
      });
    });
}

describe("blackbox #16: abort", () => {
  it("abort during a poll request rejects with the signal's reason, unchanged", async () => {
    const controller = new AbortController();
    const reason = new Error("user stopped");
    const h = harness([hangingResponder()], { signal: controller.signal });
    const pending = backend.poll(HANDLE, h.ctx);
    setTimeout(() => {
      controller.abort(reason);
    }, 20);
    const error = await rejection(pending);
    assert.equal(error, reason);
    assert.equal(h.calls.length, 1);
  });

  it("abort between polls: the next poll rejects with the reason and sends nothing", async () => {
    const controller = new AbortController();
    const reason = new Error("stop now");
    const h = harness([json(200, jobBody({ completed: false }))], { signal: controller.signal });
    assert.deepEqual(await backend.poll(HANDLE, h.ctx), { state: "pending" });
    controller.abort(reason);
    const error = await rejection(backend.poll(HANDLE, h.ctx));
    assert.equal(error, reason);
    assert.equal(h.calls.length, 1);
  });

  it("abort during a submit rejects with the reason and does not look up or resubmit", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel submit");
    const h = harness([hangingResponder()], { signal: controller.signal });
    const pending = backend.submit(verifyInput(), h.ctx);
    setTimeout(() => {
      controller.abort(reason);
    }, 20);
    assert.equal(await rejection(pending), reason);
    assert.equal(h.calls.length, 1);
  });
});

describe("blackbox #16: rate limits and server errors", () => {
  it("lookup 429 with Retry-After: 1 waits at least 1 s, retries, then maps the answer", async () => {
    const h = harness([
      json(429, errorBody("too_many_requests"), { "retry-after": "1" }),
      json(200, lookupBody("match")),
    ]);
    const started = Date.now();
    assert.equal(await backend.lookup(TARGET, h.ctx), "partial");
    assert.ok(Date.now() - started >= 950, "did not wait for Retry-After");
    assert.equal(h.calls.length, 2);
    assert.equal(h.retries.length, 1);
    assert.equal(h.retries[0]?.reason, "rate-limited");
    assert.ok((h.retries[0]?.delayMs ?? 0) >= 1000);
  });

  it("submit 429 too_many_requests with Retry-After: 1 is retried, then submitted", async () => {
    const h = harness([
      json(429, errorBody("too_many_requests"), { "retry-after": "1" }),
      json(202, { verificationId: JOB_ID }),
    ]);
    const outcome = await backend.submit(verifyInput(), h.ctx);
    assert.equal(outcome.state, "submitted");
    assert.deepEqual(
      h.calls.map((c) => c.method),
      ["POST", "POST"],
    );
  });

  it("lookup 429 with a Retry-After past the limit -> rate-limited with retryAfterMs, no wait", async () => {
    const h = harness([json(429, errorBody("too_many_requests"), { "retry-after": "120" })]);
    const error = await evError(backend.lookup(TARGET, h.ctx), "rate-limited");
    if (error.details.code === "rate-limited") {
      assert.equal(error.details.retryAfterMs, 120_000);
    }
    assert.equal(h.calls.length, 1);
  });

  it("submit 503 is retried in place (refused before processing), then submitted", async () => {
    const h = harness([
      json(503, errorBody("service_unavailable")),
      json(202, { verificationId: JOB_ID }),
    ]);
    const outcome = await backend.submit(verifyInput(), h.ctx);
    assert.equal(outcome.state, "submitted");
    assert.deepEqual(
      h.calls.map((c) => c.method),
      ["POST", "POST"],
    );
    assert.equal(h.retries[0]?.reason, "server-error");
  });
});

describe("blackbox #16: recovery after a submit without a clear answer", () => {
  const unclear: { name: string; responder: Responder }[] = [
    { name: "500", responder: json(500, errorBody("internal_error")) },
    { name: "502", responder: raw(502, "<html>bad gateway</html>") },
    { name: "504", responder: raw(504, "<html>gateway timeout</html>") },
    { name: "a network error", responder: networkError },
  ];

  for (const { name, responder } of unclear) {
    it(`${name}, then lookup finds exact -> already-verified exact, no second submit`, async () => {
      const h = harness([responder, json(200, lookupBody("exact_match"))]);
      assert.deepEqual(await backend.submit(verifyInput(), h.ctx), {
        state: "already-verified",
        match: "exact",
      });
      assert.deepEqual(
        h.calls.map((c) => c.method),
        ["POST", "GET"],
      );
      assert.ok(h.calls[1]?.url.includes("/v2/contract/"));
    });
  }

  it("500, then lookup finds partial -> already-verified partial", async () => {
    const h = harness([json(500, errorBody("internal_error")), json(200, lookupBody("match"))]);
    assert.deepEqual(await backend.submit(verifyInput(), h.ctx), {
      state: "already-verified",
      match: "partial",
    });
  });

  it("500, lookup 404, second submit 202 -> submitted", async () => {
    const h = harness([
      json(500, errorBody("internal_error")),
      json(404, lookupBody(null)),
      json(202, { verificationId: JOB_ID }),
    ]);
    const outcome = await backend.submit(verifyInput(), h.ctx);
    assert.equal(outcome.state, "submitted");
    if (outcome.state === "submitted") {
      assert.equal(outcome.handle.jobId, JOB_ID);
    }
    assert.deepEqual(
      h.calls.map((c) => c.method),
      ["POST", "GET", "POST"],
    );
    assert.equal(h.calls[0]?.body, h.calls[2]?.body);
  });

  it("network error, lookup 404, second submit 429 duplicate -> in-progress without a job id", async () => {
    const h = harness([
      networkError,
      json(404, lookupBody(null)),
      json(429, errorBody("duplicate_verification_request")),
    ]);
    const error = await evError(backend.submit(verifyInput(), h.ctx), "in-progress");
    assert.deepEqual(error.details, { code: "in-progress", backend: "sourcify" });
    assert.equal(h.calls.length, 3);
  });

  it("500, lookup 404, second submit 500 -> throws that error, no third submit", async () => {
    const h = harness([
      json(500, errorBody("internal_error", "first")),
      json(404, lookupBody(null)),
      json(500, errorBody("internal_error", "second")),
    ]);
    const error = await evError(backend.submit(verifyInput(), h.ctx), "unexpected-response");
    if (error.details.code === "unexpected-response") {
      assert.equal(error.details.status, 500);
    }
    assert.equal(h.calls.length, 3);
  });

  it("network error, lookup 404, network error -> network error, no third submit", async () => {
    const h = harness([networkError, json(404, lookupBody(null)), networkError]);
    await evError(backend.submit(verifyInput(), h.ctx), "network");
    assert.deepEqual(
      h.calls.map((c) => c.method),
      ["POST", "GET", "POST"],
    );
  });

  it("500, then a failing lookup -> throws, never submits again", async () => {
    const h = harness([
      json(500, errorBody("internal_error")),
      json(500, errorBody("internal_error")),
    ]);
    const error = await rejection(backend.submit(verifyInput(), h.ctx));
    assert.ok(error instanceof ExplorerVerifyError);
    assert.deepEqual(
      h.calls.map((c) => c.method),
      ["POST", "GET"],
    );
  });
});

describe("blackbox #16: secrets never leak (R-SEC-1)", () => {
  const apiUrl = `https://sourcify.example.org/server?apikey=${SECRET}`;

  it("a key in the route query is sent but kept out of errors and logs", async () => {
    const h = harness(
      [
        // The server echoes the request URL, key included, in its error.
        (call) =>
          new Response(JSON.stringify(errorBody("internal_error", `failed for ${call.url}`)), {
            status: 500,
          }),
      ],
      { apiUrl, secrets: [SECRET] },
    );
    const error = await evError(backend.lookup(TARGET, h.ctx), "unexpected-response");
    assert.ok(h.calls[0]?.url.includes(SECRET), "the key was not sent");
    assert.ok(!errorText(error).includes(SECRET), "key in error");
    assert.ok(!h.logs.join("\n").includes(SECRET), "key in logs");
  });

  it("the key stays out of results, logs and errors across a full submit and poll", async () => {
    const h = harness(
      [
        json(404, lookupBody(null)),
        json(202, { verificationId: JOB_ID }),
        json(200, jobBody({ completed: true, error: errorBody("no_match", `bad ${SECRET}`) })),
        json(200, jobBody({ completed: true, error: errorBody("brand_new", `odd ${SECRET}`) })),
        json(200, jobBody({ completed: true, error: errorBody("internal_error", `t ${SECRET}`) })),
      ],
      { apiUrl, secrets: [SECRET] },
    );
    const results: unknown[] = [];
    results.push(await backend.lookup(TARGET, h.ctx));
    const outcome = await backend.submit(verifyInput(), h.ctx);
    results.push(outcome);
    const failed = await backend.poll(HANDLE, h.ctx);
    results.push(failed);
    const unknown = await evError(backend.poll(HANDLE, h.ctx), "unknown-state");
    const transient = await evError(backend.poll(HANDLE, h.ctx), "verification-inconclusive");
    assert.ok(!errorText(unknown).includes(SECRET), "key in unknown-state error");
    assert.ok(!errorText(transient).includes(SECRET), "key in verification-inconclusive error");
    assert.ok(!h.logs.join("\n").includes(SECRET), "key in logs");
    assert.equal(backend.explorerUrl(TARGET, h.ctx), undefined);
    // R-SEC-1 names results too. Checked last so the checks above always run.
    assert.ok(
      !JSON.stringify(results).includes(SECRET),
      `key in results: ${JSON.stringify(results)}`,
    );
  });

  it("the key stays out of a rate-limited error and the retry logs", async () => {
    const h = harness(
      [json(429, { ...errorBody("too_many_requests"), url: SECRET }, { "retry-after": "999" })],
      {
        apiUrl,
        secrets: [SECRET],
      },
    );
    const error = await evError(backend.lookup(TARGET, h.ctx), "rate-limited");
    assert.ok(!errorText(error).includes(SECRET));
    assert.ok(!h.logs.join("\n").includes(SECRET));
  });
});

describe("blackbox #16: live, keyless, read-only", () => {
  it(
    "looks up a verified Sepolia contract on sourcify.dev",
    { skip: process.env["BLACKBOX_LIVE"] === "1" ? false : "set BLACKBOX_LIVE=1" },
    async () => {
      const ctx: Context = {
        route: resolveRoute(CHAIN_ID),
        http: { backend: "sourcify", secrets: [], fetch: globalThis.fetch },
      };
      const match = await backend.lookup(TARGET, ctx);
      assert.equal(match, "exact");
      assert.equal(
        lower(backend.explorerUrl(TARGET, ctx) ?? ""),
        lower(`https://repo.sourcify.dev/${String(CHAIN_ID)}/${ADDRESS}`),
      );
    },
  );
});
