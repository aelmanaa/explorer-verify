// Black-box tests for issue #61: the Etherscan v2 client. They use only the issue's mapping table,
// docs/user/reference/etherscan.md, verify.md, check-status.md, api-keys.md, routing.md,
// logging-and-events.md, the error pages, requirements.md and the package entry point. Every call
// goes through `verify()` or `checkStatus()` with a fake `fetch` that answers like Etherscan, with
// a dummy key. Time runs on node:test mock timers.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { inspect } from "node:util";

import { ExplorerVerifyError, checkStatus, verify } from "../../src/index.ts";
import type {
  Handle,
  Hex,
  LogFields,
  Logger,
  VerifyEvent,
  VerifyInput,
  VerifyOptions,
  VerifyResult,
} from "../../src/index.ts";

// Lower-case dummy key: no generic redaction rule (the 34-character upper-case shape, key-like
// parameter names) matches it, so only the library's knowledge of the key can remove it.
const KEY = "zz9dummyetherscankeyqq7xv";
const API = "https://api.etherscan.io/v2/api";
const CHAIN_ID = 421614;
const ADDRESS: Hex = "0x6355ef85c81f3545ad9cb404f3defb7f219810ec";
const GUID = "yatwfd5yijmxufgkexd8ygesyexubjazunjnbgkemvwbm7vhrw";
const VERSION = "0.8.24+commit.e11b9ed9";
// Arbitrum Sepolia's explorer host in the routing table (#122): a route whose apiUrl is the table's
// own Etherscan API keeps the table's contract page (routing.md).
const EXPLORER_URL = `https://sepolia.arbiscan.io/address/${ADDRESS}#code`;
const ARGS_HEX = "000000000000000000000000000000000000000000000000000000000000002a";

// ---------------------------------------------------------------------------------------------
// Mock time.

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
});

afterEach(() => {
  mock.timers.reset();
});

function drive<T>(pending: Promise<T>): Promise<T> {
  const state = { settled: false };
  pending
    .catch(() => undefined)
    .finally(() => {
      state.settled = true;
    });
  void (async () => {
    for (let round = 0; round < 5_000 && !state.settled; round += 1) {
      await nextTurn();
      if (!state.settled) {
        mock.timers.runAll();
      }
    }
  })();
  return pending;
}

async function errorOf(promise: Promise<VerifyResult>): Promise<ExplorerVerifyError> {
  try {
    const result = await drive(promise);
    return assert.fail(`expected an error, got ${JSON.stringify(result)}`);
  } catch (error) {
    if (error instanceof ExplorerVerifyError) {
      return error;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Fake Etherscan.

type Action = "getsourcecode" | "verifysourcecode" | "checkverifystatus";

interface Call {
  readonly action: Action;
  readonly method: string;
  readonly url: URL;
  readonly headers: [string, string][];
  readonly body: URLSearchParams;
  readonly rawBody: string;
}

interface Reply {
  readonly http?: number;
  readonly body: unknown;
}

type Script = Partial<Record<Action, readonly Reply[]>>;

const json = (status: string, result: unknown): Reply => ({
  body: { status, message: status === "1" ? "OK" : "NOTOK", result },
});
const notok = (result: string): Reply => json("0", result);

const SOURCE_EXACT = '{{"language":"Solidity","sources":{}}}';
const LOOKUP_NONE = json("1", [
  {
    SourceCode: "",
    ABI: "Contract source code not verified",
    ContractName: "",
    CompilerVersion: "",
    SimilarMatch: "",
  },
]);
const LOOKUP_EXACT = json("1", [
  {
    SourceCode: SOURCE_EXACT,
    ABI: "[]",
    ContractName: "Tiny",
    CompilerVersion: `v${VERSION}`,
    SimilarMatch: "",
  },
]);
const LOOKUP_EXACT_NO_SIMILAR = json("1", [
  { SourceCode: SOURCE_EXACT, ABI: "[]", ContractName: "Tiny", CompilerVersion: `v${VERSION}` },
]);
const LOOKUP_PARTIAL = json("1", [
  {
    SourceCode: SOURCE_EXACT,
    ABI: "[]",
    ContractName: "Tiny",
    CompilerVersion: `v${VERSION}`,
    SimilarMatch: "0x37e6e91f168c4aafd405444596b42de58dfc84ef",
  },
]);
const SUBMIT_OK = json("1", GUID);
const PENDING = notok("Pending in queue");
const PASS = json("1", "Pass - Verified");
const RATE = notok("Max calls per sec rate limit reached (3/sec)");
const FAIL_TEXT =
  "Fail - Unable to verify. Compiled contract runtime bytecode does NOT match the on-chain runtime bytecode.";

function bodyText(body: BodyInit | null | undefined): string {
  if (body === undefined || body === null) {
    return "";
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  return inspect(body);
}

function fakeEtherscan(script: Script): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const used: Record<Action, number> = {
    getsourcecode: 0,
    verifysourcecode: 0,
    checkverifystatus: 0,
  };
  const fn: typeof fetch = async (target, init) => {
    const url = new URL(target instanceof Request ? target.url : String(target));
    const method = (
      target instanceof Request ? target.method : (init?.method ?? "GET")
    ).toUpperCase();
    const rawBody = target instanceof Request ? await target.clone().text() : bodyText(init?.body);
    const headers = [
      ...new Headers(target instanceof Request ? target.headers : init?.headers).entries(),
    ];
    const body = new URLSearchParams(rawBody);
    const actionText = body.get("action") ?? url.searchParams.get("action") ?? "";
    if (
      actionText !== "getsourcecode" &&
      actionText !== "verifysourcecode" &&
      actionText !== "checkverifystatus"
    ) {
      throw new Error(`unexpected action ${actionText}`);
    }
    const action: Action = actionText;
    calls.push({ action, method, url, headers, body, rawBody });
    const replies = script[action];
    if (replies === undefined || replies.length === 0) {
      throw new Error(`no reply scripted for ${action}`);
    }
    const reply = replies[Math.min(used[action], replies.length - 1)];
    used[action] += 1;
    if (reply === undefined) {
      throw new Error("unreachable");
    }
    return new Response(JSON.stringify(reply.body), {
      status: reply.http ?? 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };
  return { fetch: fn, calls };
}

function makeInput(overrides: Partial<VerifyInput> = {}): VerifyInput {
  return {
    chainId: CHAIN_ID,
    address: ADDRESS,
    compiler: {
      kind: "solc",
      version: VERSION,
      input: {
        language: "Solidity",
        sources: { "contracts/Tiny.sol": { content: "contract Tiny {}" } },
        settings: { optimizer: { enabled: false, runs: 200 } },
      },
    },
    contractName: "contracts/Tiny.sol:Tiny",
    ...overrides,
  };
}

function makeHandle(): Handle {
  return { version: 1, backend: "etherscan-v2", chainId: CHAIN_ID, address: ADDRESS, jobId: GUID };
}

interface Run {
  readonly options: VerifyOptions;
  readonly calls: Call[];
  readonly events: VerifyEvent[];
  readonly logs: string[];
}

function setup(script: Script, extra: Partial<VerifyOptions> = {}): Run {
  const fake = fakeEtherscan(script);
  const events: VerifyEvent[] = [];
  const logs: string[] = [];
  const line =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      logs.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`);
    };
  const logger: Logger = {
    debug: line("debug"),
    info: line("info"),
    warn: line("warn"),
    error: line("error"),
  };
  const options: VerifyOptions = {
    fetch: fake.fetch,
    route: { backend: "etherscan-v2", apiUrl: API, apiKey: KEY },
    pollIntervalMs: 1_000,
    timeoutMs: 60_000,
    logger,
    onEvent: (event) => {
      events.push(event);
    },
    ...extra,
  };
  return { options, calls: fake.calls, events, logs };
}

function actions(run: Run): Action[] {
  return run.calls.map((call) => call.action);
}

/** Asserts the transport rules of etherscan.md "Requests" and api-keys.md for every call. */
function assertRequestsSafe(run: Run, key: string | null = KEY): void {
  assert.ok(run.calls.length > 0, "no request was sent");
  for (const call of run.calls) {
    assert.equal(call.method, "POST", `${call.action} method`);
    assert.equal(`${call.url.origin}${call.url.pathname}`, API, `${call.action} endpoint`);
    assert.equal(call.url.searchParams.get("chainid"), String(CHAIN_ID), `${call.action} chainid`);
    assert.equal(call.url.searchParams.getAll("chainid").length, 1, "one chainid");
    assert.ok(!call.url.href.toLowerCase().includes(KEY), `${call.action} URL holds the key`);
    assert.ok(!call.url.searchParams.has("apikey"), `${call.action} URL has apikey`);
    for (const [name, value] of call.headers) {
      assert.ok(!value.includes(KEY), `${call.action} header ${name} holds the key`);
      assert.notEqual(name.toLowerCase(), "apikey");
    }
    const type = call.headers.find(([name]) => name === "content-type")?.[1] ?? "";
    assert.match(type, /^application\/x-www-form-urlencoded/u, `${call.action} content-type`);
    assert.equal(call.body.get("module"), "contract");
    if (key === null) {
      assert.ok(!call.body.has("apikey") || call.body.get("apikey") === "");
    } else {
      assert.deepEqual(call.body.getAll("apikey"), [key], `${call.action} body apikey`);
    }
  }
}

function deepText(value: unknown): string {
  return inspect(value, { depth: Infinity, showHidden: true, getters: true });
}

/** Asserts that no event, log line, result or error the caller sees holds the key. */
function assertNoKeyVisible(run: Run, outcome: unknown): void {
  const lower = KEY.toLowerCase();
  const texts = [deepText(run.events), JSON.stringify(run.events), ...run.logs, deepText(outcome)];
  if (outcome instanceof ExplorerVerifyError) {
    texts.push(outcome.message, String(outcome.stack), JSON.stringify(outcome.toJSON()));
    texts.push(deepText(outcome.details), deepText(outcome.cause));
  } else {
    texts.push(JSON.stringify(outcome));
  }
  for (const text of texts) {
    assert.ok(!text.toLowerCase().includes(lower), `key visible in: ${text.slice(0, 400)}`);
  }
}

function eventTypes(run: Run): string[] {
  return run.events.map((event) => event.type);
}

function retryReasons(run: Run): string[] {
  return run.events.flatMap((event) => (event.type === "verify.retry" ? [event.reason] : []));
}

function handleText(error: ExplorerVerifyError): string {
  return JSON.stringify(error.toJSON());
}

// ---------------------------------------------------------------------------------------------

describe("blackbox #61: full verify run (R-BE-1, R-DX-6)", () => {
  it("lookup, submit, two polls end verified exact with events in order and safe requests", async () => {
    const run = setup({
      getsourcecode: [LOOKUP_NONE],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [PENDING, PASS],
    });
    const result = await drive(verify(makeInput(), run.options));
    assert.deepEqual(result, {
      status: "verified",
      backend: "etherscan-v2",
      match: "exact",
      explorerUrl: EXPLORER_URL,
    });
    assert.deepEqual(actions(run), [
      "getsourcecode",
      "verifysourcecode",
      "checkverifystatus",
      "checkverifystatus",
    ]);
    assert.deepEqual(eventTypes(run), [
      "verify.validated",
      "verify.routed",
      "verify.lookup",
      "verify.submitted",
      "verify.poll",
      "verify.result",
    ]);
    const routed = run.events[1];
    assert.ok(routed?.type === "verify.routed");
    assert.equal(routed.backend, "etherscan-v2");
    assert.equal(routed.apiHost, "api.etherscan.io");
    const lookup = run.events[2];
    assert.ok(lookup?.type === "verify.lookup");
    assert.equal(lookup.match, "none");
    const submitted = run.events[3];
    assert.ok(submitted?.type === "verify.submitted");
    assert.equal(submitted.handle, `ev1:etherscan-v2:${CHAIN_ID}:${ADDRESS}:${GUID}`);
    const poll = run.events[4];
    assert.ok(poll?.type === "verify.poll");
    assert.equal(poll.state, "pending");
    assertRequestsSafe(run);
    assertNoKeyVisible(run, result);
    assert.equal(result.explorerUrl, EXPLORER_URL, "the table's own API keeps the table's page");
    const look = run.calls[0];
    assert.equal(look?.body.get("address")?.toLowerCase(), ADDRESS);
    const status = run.calls[2];
    assert.equal(status?.body.get("guid"), GUID);
  });

  it("submit body: codeformat, sourceCode with language/sources/settings only, address, contractname, compilerversion", async () => {
    const run = setup({
      getsourcecode: [LOOKUP_NONE],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [PASS],
    });
    const base = makeInput();
    const extended = { ...base.compiler.input, outputSelection: { "*": {} }, remappings: ["a=b"] };
    const input = makeInput({ compiler: { kind: "solc", version: VERSION, input: extended } });
    await drive(verify(input, run.options));
    const submit = run.calls.find((call) => call.action === "verifysourcecode");
    assert.ok(submit !== undefined);
    assert.equal(submit.body.get("codeformat"), "solidity-standard-json-input");
    assert.equal(submit.body.get("contractaddress")?.toLowerCase(), ADDRESS);
    assert.equal(submit.body.get("contractname"), "contracts/Tiny.sol:Tiny");
    assert.equal(submit.body.get("compilerversion"), `v${VERSION}`);
    const source: unknown = JSON.parse(submit.body.get("sourceCode") ?? "null");
    assert.ok(typeof source === "object" && source !== null);
    assert.deepEqual(Object.keys(source).toSorted(), ["language", "settings", "sources"]);
    assert.ok(!submit.body.has("constructorArguments"));
    assert.ok(!submit.body.has("constructorArguements"));
  });

  it("compilerversion has one leading v when the input version already starts with v", async () => {
    const run = setup({
      getsourcecode: [LOOKUP_NONE],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [PASS],
    });
    const base = makeInput();
    const input = makeInput({
      compiler: { kind: "solc", version: `v${VERSION}`, input: base.compiler.input },
    });
    await drive(verify(input, run.options));
    const submit = run.calls.find((call) => call.action === "verifysourcecode");
    assert.equal(submit?.body.get("compilerversion"), `v${VERSION}`);
  });

  it("submit body carries both constructor-argument spellings as bare hex", async () => {
    const run = setup({
      getsourcecode: [LOOKUP_NONE],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [PASS],
    });
    await drive(verify(makeInput({ constructorArgs: `0x${ARGS_HEX}` }), run.options));
    const submit = run.calls.find((call) => call.action === "verifysourcecode");
    assert.deepEqual(submit?.body.getAll("constructorArguments"), [ARGS_HEX]);
    assert.deepEqual(submit?.body.getAll("constructorArguements"), [ARGS_HEX]);
  });

  it("submit body carries neither constructor-argument field when constructorArgs is 0x", async () => {
    const run = setup({
      getsourcecode: [LOOKUP_NONE],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [PASS],
    });
    await drive(verify(makeInput({ constructorArgs: "0x" }), run.options));
    const submit = run.calls.find((call) => call.action === "verifysourcecode");
    assert.ok(submit !== undefined);
    assert.ok(!submit.body.has("constructorArguments"));
    assert.ok(!submit.body.has("constructorArguements"));
  });

  it("a source path containing &apikey=x reaches the explorer as data", async () => {
    const run = setup({
      getsourcecode: [LOOKUP_NONE],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [PASS],
    });
    const path = "contracts/A&apikey=x&chainid=1.sol";
    const input = makeInput({
      compiler: {
        kind: "solc",
        version: VERSION,
        input: {
          language: "Solidity",
          sources: { [path]: { content: "contract Tiny {}" } },
          settings: {},
        },
      },
      contractName: `${path}:Tiny`,
    });
    await drive(verify(input, run.options));
    const submit = run.calls.find((call) => call.action === "verifysourcecode");
    assert.ok(submit !== undefined);
    assert.deepEqual(submit.body.getAll("apikey"), [KEY]);
    assert.equal(submit.body.get("contractname"), `${path}:Tiny`);
    const source: unknown = JSON.parse(submit.body.get("sourceCode") ?? "null");
    assert.ok(typeof source === "object" && source !== null && "sources" in source);
    assert.ok(deepText(source.sources).includes(path));
    assertRequestsSafe(run);
  });

  it("a chainid in route.apiUrl's query is dropped; the call's chain id goes in the query", async () => {
    const run = setup(
      { getsourcecode: [LOOKUP_EXACT] },
      { route: { backend: "etherscan-v2", apiUrl: `${API}?chainid=1`, apiKey: KEY } },
    );
    await drive(verify(makeInput(), run.options));
    assertRequestsSafe(run);
  });
});

describe("blackbox #61: submit mapping (R-FLOW-4, R-FLOW-7)", () => {
  it("status 1 with a result that is not a GUID throws unexpected-response", async () => {
    for (const result of ["", "not a guid!", "Pass - Verified"]) {
      const run = setup({ getsourcecode: [LOOKUP_NONE], verifysourcecode: [json("1", result)] });
      const error = await errorOf(verify(makeInput(), run.options));
      assert.equal(error.details.code, "unexpected-response", `result ${JSON.stringify(result)}`);
      assert.ok(!actions(run).includes("checkverifystatus"));
    }
  });

  for (const text of ["Contract source code already verified", "Already Verified"]) {
    it(`submit maps ${text} to already-verified with the lookup's grade (R-FLOW-7)`, async () => {
      const run = setup({
        getsourcecode: [LOOKUP_NONE, LOOKUP_PARTIAL],
        verifysourcecode: [notok(text)],
      });
      const result = await drive(verify(makeInput(), run.options));
      assert.deepEqual(result, {
        status: "already-verified",
        backend: "etherscan-v2",
        match: "partial",
        explorerUrl: EXPLORER_URL,
      });
      assert.ok(!actions(run).includes("checkverifystatus"));
      assertRequestsSafe(run);
    });
  }

  // etherscan.md and verify.md do not say which code this case throws; the client throws
  // unexpected-response. The test checks only that no grade is invented and nothing is re-sent.
  it("submit already verified with a lookup that says not verified throws, inventing no grade", async () => {
    const run = setup({
      getsourcecode: [LOOKUP_NONE],
      verifysourcecode: [notok("Contract source code already verified")],
    });
    const error = await errorOf(verify(makeInput(), run.options));
    assert.ok(["unexpected-response", "unknown-state"].includes(error.details.code));
    assert.deepEqual(actions(run), ["getsourcecode", "verifysourcecode", "getsourcecode"]);
  });

  it("Unable to locate ContractCode at is sent again, then the job verifies", async () => {
    const run = setup({
      getsourcecode: [LOOKUP_NONE],
      verifysourcecode: [
        notok(`Unable to locate ContractCode at ${ADDRESS}`),
        notok(`Unable to locate ContractCode at ${ADDRESS}`),
        SUBMIT_OK,
      ],
      checkverifystatus: [PASS],
    });
    const result = await drive(verify(makeInput(), run.options));
    assert.equal(result.status, "verified");
    assert.equal(actions(run).filter((action) => action === "verifysourcecode").length, 3);
  });

  it("Unable to locate ContractCode at until the budget is spent throws timeout without a handle", async () => {
    const run = setup(
      {
        getsourcecode: [LOOKUP_NONE],
        verifysourcecode: [notok(`Unable to locate ContractCode at ${ADDRESS}`)],
      },
      { timeoutMs: 10_000 },
    );
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "timeout");
    assert.ok(!("handle" in error.details) || error.details.handle === undefined);
    const submits = actions(run).filter((action) => action === "verifysourcecode").length;
    assert.ok(submits >= 2 && submits <= 12, `submits ${submits}`);
  });

  it("any other status 0 submit answer throws unexpected-response, never failed", async () => {
    for (const text of [
      "Error! Invalid constructor arguments provided. Please verify that they are in ABI-encoded format",
      "Fail - Unable to verify. Something",
      "Source code exceeds max accepted (500k chars) length",
    ]) {
      const run = setup({ getsourcecode: [LOOKUP_NONE], verifysourcecode: [notok(text)] });
      const error = await errorOf(verify(makeInput(), run.options));
      assert.equal(error.details.code, "unexpected-response", text);
    }
  });

  it("submit unexpected-response excerpt is redacted when the explorer echoes the key", async () => {
    const run = setup({
      getsourcecode: [LOOKUP_NONE],
      verifysourcecode: [notok(`Error! bad request apikey ${KEY} and ${KEY.toUpperCase()}`)],
    });
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "unexpected-response");
    assertNoKeyVisible(run, error);
  });
});

describe("blackbox #61: any-call answers (R-BE-1, R-FLOW-6)", () => {
  it("rate-limit answer with HTTP 200 on lookup is retried, emits verify.retry rate-limited", async () => {
    const run = setup({
      getsourcecode: [RATE, LOOKUP_EXACT],
    });
    const result = await drive(verify(makeInput(), run.options));
    assert.deepEqual(result, {
      status: "already-verified",
      backend: "etherscan-v2",
      match: "exact",
      explorerUrl: EXPLORER_URL,
    });
    assert.deepEqual(retryReasons(run), ["rate-limited"]);
    const retry = run.events.find((event) => event.type === "verify.retry");
    assert.ok(retry?.type === "verify.retry");
    assert.equal(retry.attempt, 2);
    assert.equal(retry.backend, "etherscan-v2");
  });

  it("rate-limit answer with HTTP 200 on submit retries and is never failed", async () => {
    const run = setup({
      getsourcecode: [LOOKUP_NONE],
      verifysourcecode: [RATE, RATE, SUBMIT_OK],
      checkverifystatus: [PASS],
    });
    const result = await drive(verify(makeInput(), run.options));
    assert.equal(result.status, "verified");
    assert.deepEqual(retryReasons(run), ["rate-limited", "rate-limited"]);
  });

  it("rate-limit answer with HTTP 200 on a poll retries, then the job verifies", async () => {
    const run = setup({
      getsourcecode: [LOOKUP_NONE],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [RATE, PASS],
    });
    const result = await drive(verify(makeInput(), run.options));
    assert.equal(result.status, "verified");
    assert.deepEqual(retryReasons(run), ["rate-limited"]);
  });

  it("lookup rate-limit answer throws rate-limited and is never read as not verified (R-FLOW-4)", async () => {
    const run = setup({
      getsourcecode: [RATE],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [PASS],
    });
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "rate-limited");
    assert.ok(!actions(run).includes("verifysourcecode"), "submitted after a rate-limited lookup");
    assert.ok(retryReasons(run).length >= 1);
    assert.ok(retryReasons(run).every((reason) => reason === "rate-limited"));
  });

  it("submit rate-limit forever throws rate-limited, never failed", async () => {
    const run = setup({ getsourcecode: [LOOKUP_NONE], verifysourcecode: [RATE] });
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "rate-limited");
  });

  it("poll rate-limit forever never yields failed or verified; ends not-confirmed with the handle", async () => {
    const run = setup({
      getsourcecode: [LOOKUP_NONE],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [RATE],
    });
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "not-confirmed");
    assert.ok(handleText(error).includes(GUID));
  });

  const atOnce: [string, string][] = [
    ["Max daily rate limit reached. 100000 (100%) of 100000 day/limit", "quota-exceeded"],
    ["Daily limit of 500 source code submissions reached", "quota-exceeded"],
    ["Missing/Invalid API Key", "missing-api-key"],
    ["Invalid API Key (#err2)", "api-key-rejected"],
    [
      "Missing or unsupported chainid parameter (required for v2 api), please see https://api.etherscan.io/v2/chainlist for the list of supported chainids",
      "unsupported-chain",
    ],
    [
      "You are using a deprecated V1 endpoint, switch to Etherscan API V2 using https://docs.etherscan.io/v2-migration",
      "unexpected-response",
    ],
  ];
  for (const [text, code] of atOnce) {
    for (const where of ["getsourcecode", "verifysourcecode", "checkverifystatus"] as const) {
      if (where === "checkverifystatus" && code === "unexpected-response") {
        // verify.md step 4: a poll that fails with unexpected-response is logged and polling goes
        // on; 3 failed polls in a row end in not-confirmed after a last lookup.
        it(`checkverifystatus answer "${text.slice(0, 40)}" is a failed poll, ending not-confirmed`, async () => {
          const run = setup({
            getsourcecode: [LOOKUP_NONE],
            verifysourcecode: [SUBMIT_OK],
            checkverifystatus: [notok(text)],
          });
          const error = await errorOf(verify(makeInput(), run.options));
          assert.equal(error.details.code, "not-confirmed");
          assert.ok(handleText(error).includes(GUID));
          const cause: unknown = error.cause;
          assert.ok(typeof cause === "object" && cause !== null && "code" in cause);
          assert.equal(cause.code, "unexpected-response");
          assert.equal(actions(run).filter((action) => action === where).length, 3);
          assertNoKeyVisible(run, error);
        });
        continue;
      }
      it(`${where} answer "${text.slice(0, 40)}" throws ${code} at once`, async () => {
        const script: Script =
          where === "getsourcecode"
            ? { getsourcecode: [notok(text)] }
            : where === "verifysourcecode"
              ? { getsourcecode: [LOOKUP_NONE], verifysourcecode: [notok(text)] }
              : {
                  getsourcecode: [LOOKUP_NONE],
                  verifysourcecode: [SUBMIT_OK],
                  checkverifystatus: [notok(text)],
                };
        const run = setup(script);
        const error = await errorOf(verify(makeInput(), run.options));
        assert.equal(error.details.code, code);
        assert.equal(actions(run).filter((action) => action === where).length, 1, "sent once");
        assert.deepEqual(retryReasons(run), []);
        assertNoKeyVisible(run, error);
      });
    }
  }

  it("key echoed by an Invalid API Key answer is redacted everywhere", async () => {
    const run = setup({ getsourcecode: [notok(`Invalid API Key (#err2)|${KEY}`)] });
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "api-key-rejected");
    assertNoKeyVisible(run, error);
  });
});

describe("blackbox #61: poll mapping (R-FLOW-3, R-FLOW-4, R-FLOW-7)", () => {
  for (const text of ["Contract source code already verified", "Already Verified"]) {
    it(`poll ${text} returns already-verified with the lookup's grade`, async () => {
      const run = setup({
        getsourcecode: [LOOKUP_NONE, LOOKUP_EXACT],
        verifysourcecode: [SUBMIT_OK],
        checkverifystatus: [notok(text)],
      });
      const result = await drive(verify(makeInput(), run.options));
      assert.deepEqual(result, {
        status: "already-verified",
        backend: "etherscan-v2",
        match: "exact",
        explorerUrl: EXPLORER_URL,
      });
    });
  }

  it("poll already verified with a not-verified lookup throws unknown-state", async () => {
    const run = setup({
      getsourcecode: [LOOKUP_NONE, LOOKUP_NONE],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [notok("Already Verified")],
    });
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "unknown-state");
  });

  it("Fail - Unable to verify with a verified lookup returns verified", async () => {
    const run = setup({
      getsourcecode: [LOOKUP_NONE, LOOKUP_EXACT],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [notok(FAIL_TEXT)],
    });
    const result = await drive(verify(makeInput(), run.options));
    assert.deepEqual(result, {
      status: "verified",
      backend: "etherscan-v2",
      match: "exact",
      explorerUrl: EXPLORER_URL,
    });
  });

  it("Fail - Unable to verify with a not-verified lookup returns failed with the text", async () => {
    const run = setup({
      getsourcecode: [LOOKUP_NONE, LOOKUP_NONE],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [notok(FAIL_TEXT)],
    });
    const result = await drive(verify(makeInput(), run.options));
    assert.equal(result.status, "failed");
    assert.ok(result.status === "failed" && result.reason.includes("Fail - Unable to verify"));
    assert.equal(actions(run).filter((action) => action === "getsourcecode").length, 2);
    const last = run.events.at(-1);
    assert.ok(last?.type === "verify.result" && last.status === "failed");
  });

  it("Fail - Unable to verify with a failing lookup throws, never failed (R-FLOW-4)", async () => {
    const run = setup({
      getsourcecode: [LOOKUP_NONE, RATE],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [notok(FAIL_TEXT)],
    });
    const error = await errorOf(verify(makeInput(), run.options));
    assert.ok(error instanceof ExplorerVerifyError);
    assert.ok(!eventTypes(run).includes("verify.result"));
  });

  // etherscan.md "Behaviour to know": a lookup that fails after Fail - Unable to verify counts as a
  // failed status poll; when every later one fails too, the call ends not-confirmed with the handle.
  it("Fail - Unable to verify with a failing lookup counts as a failed poll and ends not-confirmed (etherscan.md)", async () => {
    const run = setup({
      getsourcecode: [LOOKUP_NONE, RATE],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [notok(FAIL_TEXT)],
    });
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "not-confirmed");
    assert.ok(error.details.code === "not-confirmed");
    assert.equal(error.details.handle.jobId, GUID);
    assert.match(error.message, /status polls in a row failed/u);
    assert.ok(!eventTypes(run).includes("verify.result"));
  });

  // verify.md: the cause of not-confirmed is "the last poll error, or the last lookup's error".
  // When the last lookup itself fails, the message must not claim it found no match.
  it("not-confirmed message does not say the last lookup found no match when that lookup failed", async () => {
    const run = setup({
      getsourcecode: [LOOKUP_NONE, RATE],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [RATE],
    });
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "not-confirmed");
    assert.doesNotMatch(error.message, /found no match/u);
  });

  it("failed reason is redacted (key in any case) and at most 300 characters", async () => {
    const text = `${FAIL_TEXT} ${KEY} ${KEY.toUpperCase()} ${"x".repeat(600)}`;
    const run = setup({
      getsourcecode: [LOOKUP_NONE, LOOKUP_NONE],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [notok(text)],
    });
    const result = await drive(verify(makeInput(), run.options));
    assert.ok(result.status === "failed");
    assert.ok(result.reason.length <= 300, `reason length ${result.reason.length}`);
    assertNoKeyVisible(run, result);
    const shortRun = setup({
      getsourcecode: [LOOKUP_NONE, LOOKUP_NONE],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [notok(`Fail - Unable to verify. ${KEY}`)],
    });
    const short = await drive(verify(makeInput(), shortRun.options));
    assert.ok(short.status === "failed");
    assert.ok(short.reason.includes("[redacted]"), short.reason);
    assertNoKeyVisible(shortRun, short);
  });

  for (const text of ["Unable to locate guid", "Invalid GUID length"]) {
    it(`poll ${text} with a not-verified lookup throws job-not-found with the handle`, async () => {
      const run = setup({
        getsourcecode: [LOOKUP_NONE, LOOKUP_NONE],
        verifysourcecode: [SUBMIT_OK],
        checkverifystatus: [notok(text)],
      });
      const error = await errorOf(verify(makeInput(), run.options));
      assert.equal(error.details.code, "job-not-found");
      assert.ok(handleText(error).includes(GUID));
    });

    it(`poll ${text} with a verified lookup returns verified`, async () => {
      const run = setup({
        getsourcecode: [LOOKUP_NONE, LOOKUP_EXACT],
        verifysourcecode: [SUBMIT_OK],
        checkverifystatus: [notok(text)],
      });
      const result = await drive(verify(makeInput(), run.options));
      assert.deepEqual(result, {
        status: "verified",
        backend: "etherscan-v2",
        match: "exact",
        explorerUrl: EXPLORER_URL,
      });
    });
  }

  it("unknown poll string throws unknown-state with the handle and never returns verified", async () => {
    for (const reply of [
      notok("Fail - Something new"),
      notok("Pass - Partially Verified"),
      json("1", "Verified, sort of"),
      notok("Pending"),
      json("1", ""),
    ]) {
      const run = setup({
        getsourcecode: [LOOKUP_NONE, LOOKUP_EXACT],
        verifysourcecode: [SUBMIT_OK],
        checkverifystatus: [reply],
      });
      const error = await errorOf(verify(makeInput(), run.options));
      assert.equal(error.details.code, "unknown-state", JSON.stringify(reply.body));
      assert.ok(handleText(error).includes(GUID));
    }
  });

  it("unknown-state excerpt is redacted when the explorer echoes the key", async () => {
    const run = setup({
      getsourcecode: [LOOKUP_NONE],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [notok(`Weird ${KEY}`)],
    });
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "unknown-state");
    assertNoKeyVisible(run, error);
  });
});

describe("blackbox #61: lookup mapping (R-FLOW-3, R-FLOW-4)", () => {
  it("SourceCode non-empty, SimilarMatch empty: already-verified exact, no submit", async () => {
    for (const reply of [LOOKUP_EXACT, LOOKUP_EXACT_NO_SIMILAR]) {
      const run = setup({ getsourcecode: [reply] });
      const result = await drive(verify(makeInput(), run.options));
      assert.deepEqual(result, {
        status: "already-verified",
        backend: "etherscan-v2",
        match: "exact",
        explorerUrl: EXPLORER_URL,
      });
      assert.deepEqual(actions(run), ["getsourcecode"]);
      const lookup = run.events.find((event) => event.type === "verify.lookup");
      assert.ok(lookup?.type === "verify.lookup" && lookup.match === "exact");
    }
  });

  it("SourceCode non-empty, SimilarMatch non-empty: partial", async () => {
    const run = setup({ getsourcecode: [LOOKUP_PARTIAL] });
    const result = await drive(verify(makeInput(), run.options));
    assert.deepEqual(result, {
      status: "already-verified",
      backend: "etherscan-v2",
      match: "partial",
      explorerUrl: EXPLORER_URL,
    });
  });

  it("SourceCode empty: not verified, so the source is submitted", async () => {
    const run = setup({
      getsourcecode: [LOOKUP_NONE],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [PASS],
    });
    await drive(verify(makeInput(), run.options));
    assert.ok(actions(run).includes("verifysourcecode"));
  });

  it("result not an array, or without the fields, throws unexpected-response, never not verified", async () => {
    for (const reply of [
      json("1", '[{"SourceCode":""}]'),
      json("1", { SourceCode: "" }),
      json("1", null),
      json("1", []),
      json("1", [{ ABI: "[]" }]),
      json("1", [{ SourceCode: 5 }]),
      json("1", ["x"]),
      { body: { message: "OK" } },
      { body: "just text" },
    ]) {
      const run = setup({
        getsourcecode: [reply],
        verifysourcecode: [SUBMIT_OK],
        checkverifystatus: [PASS],
      });
      const error = await errorOf(verify(makeInput(), run.options));
      assert.equal(error.details.code, "unexpected-response", JSON.stringify(reply.body));
      assert.ok(
        !actions(run).includes("verifysourcecode"),
        `submitted after ${JSON.stringify(reply.body)}`,
      );
    }
  });

  it("unknown status 0 lookup answer throws and is never read as not verified", async () => {
    const run = setup({
      getsourcecode: [notok("Query Timeout occured. Please select a smaller result dataset")],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [PASS],
    });
    const error = await errorOf(verify(makeInput(), run.options));
    assert.ok(error instanceof ExplorerVerifyError);
    assert.ok(!actions(run).includes("verifysourcecode"));
  });
});

describe("blackbox #61: checkStatus (R-FLOW-5)", () => {
  it("polls a handle: Pending in queue then Pass - Verified gives verified exact", async () => {
    const run = setup({ checkverifystatus: [PENDING, PASS] });
    const result = await drive(checkStatus(makeHandle(), run.options));
    assert.deepEqual(result, {
      status: "verified",
      backend: "etherscan-v2",
      match: "exact",
      explorerUrl: EXPLORER_URL,
    });
    assert.deepEqual(eventTypes(run), ["verify.routed", "verify.poll", "verify.result"]);
    assertRequestsSafe(run);
    assertNoKeyVisible(run, result);
  });

  it("one-line handle with an unknown poll string throws unknown-state", async () => {
    const run = setup({ checkverifystatus: [notok("Something else")] });
    const line = `ev1:etherscan-v2:${CHAIN_ID}:${ADDRESS}:${GUID}`;
    const error = await errorOf(checkStatus(line, run.options));
    assert.equal(error.details.code, "unknown-state");
    assert.ok(handleText(error).includes(GUID));
  });

  // Decided in review: a partial match after Fail is Etherscan's own match from another contract's
  // source; the submitted source was rejected, so the result is already-verified, not verified.
  it("Fail - Unable to verify on checkStatus with a partial lookup returns already-verified partial", async () => {
    const run = setup({ checkverifystatus: [notok(FAIL_TEXT)], getsourcecode: [LOOKUP_PARTIAL] });
    const result = await drive(checkStatus(makeHandle(), run.options));
    assert.deepEqual(result, {
      status: "already-verified",
      backend: "etherscan-v2",
      match: "partial",
      explorerUrl: EXPLORER_URL,
    });
  });

  it("Fail - Unable to verify on checkStatus with an exact lookup returns verified exact", async () => {
    const run = setup({ checkverifystatus: [notok(FAIL_TEXT)], getsourcecode: [LOOKUP_EXACT] });
    const result = await drive(checkStatus(makeHandle(), run.options));
    assert.deepEqual(result, {
      status: "verified",
      backend: "etherscan-v2",
      match: "exact",
      explorerUrl: EXPLORER_URL,
    });
  });

  it("checkStatus pending until the budget is spent throws not-confirmed with the same handle", async () => {
    const run = setup(
      { checkverifystatus: [PENDING], getsourcecode: [LOOKUP_NONE] },
      { timeoutMs: 5_000 },
    );
    const error = await errorOf(checkStatus(makeHandle(), run.options));
    assert.equal(error.details.code, "not-confirmed");
    assert.ok(handleText(error).includes(GUID));
  });
});

describe("blackbox #61: abort and timeout mid-poll (R-FLOW-6)", () => {
  it("abort during polling rejects with signal.reason unchanged", async () => {
    const controller = new AbortController();
    const reason = new Error("stop now");
    const run = setup(
      {
        getsourcecode: [LOOKUP_NONE],
        verifysourcecode: [SUBMIT_OK],
        checkverifystatus: [PENDING],
      },
      { signal: controller.signal },
    );
    const inner = run.options.onEvent;
    const options: VerifyOptions = {
      ...run.options,
      onEvent: (event) => {
        void inner?.(event);
        if (event.type === "verify.poll" && event.attempt === 2) {
          controller.abort(reason);
        }
      },
    };
    await assert.rejects(drive(verify(makeInput(), options)), (error) => error === reason);
    const polls = actions(run).filter((action) => action === "checkverifystatus").length;
    assert.ok(polls >= 2 && polls <= 3, `polls ${polls}`);
    assert.ok(!eventTypes(run).includes("verify.result"));
  });

  it("abort during a rate-limit backoff on a poll rejects with signal.reason unchanged", async () => {
    const controller = new AbortController();
    const reason = "user-cancelled";
    const run = setup(
      {
        getsourcecode: [LOOKUP_NONE],
        verifysourcecode: [SUBMIT_OK],
        checkverifystatus: [RATE],
      },
      { signal: controller.signal },
    );
    const inner = run.options.onEvent;
    const options: VerifyOptions = {
      ...run.options,
      onEvent: (event) => {
        void inner?.(event);
        if (event.type === "verify.retry") {
          controller.abort(reason);
        }
      },
    };
    await assert.rejects(drive(verify(makeInput(), options)), (error) => error === reason);
    assert.equal(actions(run).filter((action) => action === "checkverifystatus").length, 1);
  });

  it("checkStatus aborted mid-poll rejects with signal.reason", async () => {
    const controller = new AbortController();
    const reason = new Error("bye");
    const run = setup({ checkverifystatus: [PENDING] }, { signal: controller.signal });
    const inner = run.options.onEvent;
    const options: VerifyOptions = {
      ...run.options,
      onEvent: (event) => {
        void inner?.(event);
        if (event.type === "verify.poll") {
          controller.abort(reason);
        }
      },
    };
    await assert.rejects(drive(checkStatus(makeHandle(), options)), (error) => error === reason);
  });

  it("budget spent while pending throws not-confirmed with a handle after one last lookup", async () => {
    const run = setup(
      {
        getsourcecode: [LOOKUP_NONE],
        verifysourcecode: [SUBMIT_OK],
        checkverifystatus: [PENDING],
      },
      { timeoutMs: 10_000 },
    );
    const started = Date.now();
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "not-confirmed");
    assert.ok(handleText(error).includes(`ev1:etherscan-v2:${CHAIN_ID}:${ADDRESS}:${GUID}`));
    assert.equal(actions(run).at(-1), "getsourcecode", "last request is the final lookup");
    assert.ok(Date.now() - started <= 10_000 + 1_000, `elapsed ${Date.now() - started}`);
    assert.ok(!eventTypes(run).includes("verify.result"));
    assertNoKeyVisible(run, error);
  });

  it("budget spent while pending, final lookup verified, returns verified", async () => {
    const run = setup(
      {
        getsourcecode: [LOOKUP_NONE, LOOKUP_EXACT],
        verifysourcecode: [SUBMIT_OK],
        checkverifystatus: [PENDING],
      },
      { timeoutMs: 5_000 },
    );
    const result = await drive(verify(makeInput(), run.options));
    assert.equal(result.status, "verified");
  });
});

describe("blackbox #61: key binding (api-keys.md)", () => {
  it("apiKeys etherscan-v2 is not sent to a route.apiUrl; with fetch injected the request goes keyless", async () => {
    const run = setup(
      { getsourcecode: [notok("Missing/Invalid API Key")] },
      { route: { backend: "etherscan-v2", apiUrl: API }, apiKeys: { "etherscan-v2": KEY } },
    );
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "missing-api-key");
    assertRequestsSafe(run, null);
    assertNoKeyVisible(run, error);
  });

  it("without fetch and without a key, etherscan-v2 throws missing-api-key before any request", async () => {
    const original = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = async (target) => {
      seen.push(target instanceof Request ? target.url : String(target));
      return new Response("{}", { status: 500 });
    };
    try {
      const error = await errorOf(
        verify(makeInput(), {
          route: { backend: "etherscan-v2", apiUrl: API },
          pollIntervalMs: 1_000,
        }),
      );
      assert.equal(error.details.code, "missing-api-key");
      assert.deepEqual(seen, []);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("route.apiKey reaches the explorer via the default globalThis.fetch only in the body", async () => {
    const original = globalThis.fetch;
    const fake = fakeEtherscan({ getsourcecode: [LOOKUP_EXACT] });
    globalThis.fetch = fake.fetch;
    try {
      const result = await drive(
        verify(makeInput(), { route: { backend: "etherscan-v2", apiUrl: API, apiKey: KEY } }),
      );
      assert.equal(result.status, "already-verified");
      assertRequestsSafe({ options: {}, calls: fake.calls, events: [], logs: [] });
    } finally {
      globalThis.fetch = original;
    }
  });
});
