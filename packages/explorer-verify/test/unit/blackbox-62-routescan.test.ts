// Black-box tests for issue #62: the Routescan client. They use only the issue, the user reference
// pages (routescan.md, etherscan.md, api-keys.md, routing.md, verify.md, check-status.md, the error
// pages), requirements.md and the package entry point. Every call goes through `verify()` or
// `checkStatus()` with a fake `fetch` that answers like Routescan. Time runs on node:test mock timers.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { inspect } from "node:util";

import { ExplorerVerifyError, checkStatus, verify } from "../../src/index.ts";
import type {
  Hex,
  LogFields,
  Logger,
  VerifyEvent,
  VerifyInput,
  VerifyOptions,
  VerifyResult,
} from "../../src/index.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";

// Lower-case dummy key, not 34 upper-case characters, no key-like name around it: only the
// library's knowledge of this call's key can redact it.
const KEY = "qq7dummyroutescankeyzz4xw";
const API = "https://api.routescan.io/v2/network/testnet/evm/43113/etherscan/api";
const CHAIN_ID = 43113;
const ADDRESS: Hex = "0x636522c3785337399aa9105498d2bd95dc01d749";
const GUID = "f111a4c8-368c-51d2-8163-c7ab477a1d91";
const VERSION = "0.8.24+commit.e11b9ed9";
const HANDLE = `ev1:routescan:${CHAIN_ID}:${ADDRESS}:${GUID}`;

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_793_781_000_000 });
});

afterEach(() => {
  mock.timers.reset();
});

function drive<T>(pending: Promise<T>): Promise<T> {
  void driveMockClock(pending, () => {
    mock.timers.runAll();
  });
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
// Fake Routescan.

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
  readonly text?: string;
}

type Script = Partial<Record<Action, readonly Reply[]>>;

const json = (status: string, result: unknown, message?: string): Reply => ({
  body: { status, message: message ?? (status === "1" ? "OK" : "NOTOK"), result },
});
const notok = (result: string): Reply => json("0", result);

const LOOKUP_NONE = json("1", [
  { SourceCode: "", ABI: "Contract source code not verified", ContractName: "" },
]);
const LOOKUP_EXACT = json("1", [
  {
    SourceCode: '{{"language":"Solidity","sources":{}}}',
    ABI: "[]",
    ContractName: "Tiny",
    CompilerVersion: `v${VERSION}`,
  },
]);
const SUBMIT_OK = json("1", GUID);
const PENDING = notok("Pending in queue");
const PASS = json("1", "Pass - Verified");
const NOT_FOUND = notok("Verification not found");
const MISSING_GUID = notok("Missing guid");
const CHAIN_NOT_SUPPORTED: Reply = {
  body: { status: "0", message: "chain not supported", result: null },
};
const RATE_TEXT = notok("Max calls per sec rate limit reached (2/sec)");
const HTTP_429: Reply = { http: 429, body: { status: "0", message: "NOTOK", result: "Too Many" } };
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

function fakeRoutescan(script: Script): { fetch: typeof fetch; calls: Call[] } {
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
    const signal = target instanceof Request ? target.signal : init?.signal;
    if (signal?.aborted === true) {
      throw signal.reason;
    }
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
    return new Response(reply.text ?? JSON.stringify(reply.body), {
      status: reply.http ?? 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
      },
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

interface Run {
  readonly options: VerifyOptions;
  readonly calls: Call[];
  readonly events: VerifyEvent[];
  readonly logs: string[];
}

function setup(script: Script, extra: Partial<VerifyOptions> = {}, withKey = true): Run {
  const fake = fakeRoutescan(script);
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
    route: withKey
      ? { backend: "routescan", apiUrl: API, apiKey: KEY }
      : { backend: "routescan", apiUrl: API },
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

/** routescan.md "Requests" and "API key", api-keys.md table: transport rules for every call. */
function assertRequestsSafe(run: Run, withKey = true, uniqueGets = true): void {
  assert.ok(run.calls.length > 0, "no request was sent");
  for (const call of run.calls) {
    const where = `${call.method} ${call.action}`;
    // Full row URL, origin and path.
    assert.equal(`${call.url.origin}${call.url.pathname}`, API, `${where}: wrong base URL`);
    // No chainid anywhere.
    for (const name of [...call.url.searchParams.keys(), ...call.body.keys()]) {
      assert.notEqual(name.toLowerCase(), "chainid", `${where}: sent chainid`);
    }
    // The key never in URL or body.
    assert.ok(!call.url.href.toLowerCase().includes(KEY), `${where}: key in URL`);
    assert.ok(!call.rawBody.toLowerCase().includes(KEY), `${where}: key in body`);
    assert.ok(!decodeURIComponent(call.url.href).includes(KEY), `${where}: key in URL (decoded)`);
    for (const name of [...call.url.searchParams.keys(), ...call.body.keys()]) {
      assert.notEqual(name.toLowerCase(), "apikey", `${where}: apikey parameter sent`);
    }
    // The key only in the apikey header, and only to api.routescan.io.
    const keyed = call.headers.filter(([, value]) => value.includes(KEY));
    if (withKey) {
      assert.equal(call.url.hostname, "api.routescan.io");
      assert.deepEqual(keyed, [["apikey", KEY]], `${where}: key header wrong`);
    } else {
      assert.equal(keyed.length, 0, `${where}: key sent`);
      assert.ok(
        !call.headers.some(([name]) => name.toLowerCase() === "apikey"),
        `${where}: apikey header sent without a key`,
      );
    }
    // Lookup and status are GET with module=contract and nocache; submit is a form POST.
    if (call.action === "verifysourcecode") {
      assert.equal(call.method, "POST");
      assert.equal(call.body.get("module"), "contract");
      const contentType = call.headers.find(([name]) => name === "content-type")?.[1] ?? "";
      assert.match(contentType, /application\/x-www-form-urlencoded/);
    } else {
      assert.equal(call.method, "GET", `${where}: not a GET`);
      assert.equal(call.url.searchParams.get("module"), "contract");
      assert.ok(call.url.searchParams.has("nocache"), `${where}: no nocache`);
      if (call.action === "getsourcecode") {
        assert.equal(call.url.searchParams.get("address")?.toLowerCase(), ADDRESS);
      } else {
        assert.equal(call.url.searchParams.get("guid"), GUID);
      }
    }
  }
  if (!uniqueGets) {
    return;
  }
  // Every GET URL unique.
  const gets = run.calls.filter((call) => call.method === "GET").map((call) => call.url.href);
  assert.equal(new Set(gets).size, gets.length, `repeated GET URL: ${gets.join(" | ")}`);
}

/** R-SEC-1: the key appears nowhere the caller can see. */
function assertNoKey(run: Run, ...values: unknown[]): void {
  const seen = [
    ...run.logs,
    ...run.events.map((event) => JSON.stringify(event)),
    ...values.map((value) =>
      value instanceof Error
        ? `${inspect(value, { depth: 10 })} ${JSON.stringify(value)} ${String(value.stack)}`
        : JSON.stringify(value),
    ),
  ].join("\n");
  assert.ok(!seen.toLowerCase().includes(KEY), "the key leaked into logs, events or the outcome");
}

// ---------------------------------------------------------------------------------------------

describe("#62 Routescan: submit, poll, lookup (R-BE-5, R-FLOW-2)", () => {
  it("lookup none, submit, pending, pass gives verified partial with the routescan backend (decision 0063)", async () => {
    const run = setup({
      getsourcecode: [LOOKUP_NONE],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [PENDING, PENDING, PASS],
    });
    const result = await drive(verify(makeInput(), run.options));
    assert.equal(result.status, "verified");
    assert.equal(result.backend, "routescan");
    assert.ok("match" in result && result.match === "partial");
    assert.ok(!("explorerUrl" in result) || result.explorerUrl === undefined);
    assert.deepEqual(actions(run), [
      "getsourcecode",
      "verifysourcecode",
      "checkverifystatus",
      "checkverifystatus",
      "checkverifystatus",
    ]);
    assertRequestsSafe(run);
    assertNoKey(run, result);
    const submitted = run.events.find((event) => event.type === "verify.submitted");
    assert.ok(submitted !== undefined && "handle" in submitted);
    assert.equal(submitted.handle, HANDLE);
  });

  it("submit sends the Etherscan fields in the form body", async () => {
    const run = setup({
      getsourcecode: [LOOKUP_NONE],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [PASS],
    });
    await drive(
      verify(
        makeInput({
          constructorArgs: "0x000000000000000000000000000000000000000000000000000000000000002a",
        }),
        run.options,
      ),
    );
    const submit = run.calls.find((call) => call.action === "verifysourcecode");
    assert.ok(submit !== undefined);
    assert.equal(submit.body.get("codeformat"), "solidity-standard-json-input");
    assert.equal(submit.body.get("contractaddress")?.toLowerCase(), ADDRESS);
    assert.equal(submit.body.get("contractname"), "contracts/Tiny.sol:Tiny");
    assert.equal(submit.body.get("compilerversion"), `v${VERSION}`);
    assert.equal(
      submit.body.get("constructorArguements"),
      "000000000000000000000000000000000000000000000000000000000000002a",
    );
    const source: unknown = JSON.parse(submit.body.get("sourceCode") ?? "null");
    assert.deepEqual(Object.keys(source ?? {}).toSorted(), ["language", "settings", "sources"]);
    assertRequestsSafe(run);
  });

  it("lookup with SourceCode gives already-verified partial, no submit (decision 0063)", async () => {
    const run = setup({ getsourcecode: [LOOKUP_EXACT] });
    const result = await drive(verify(makeInput(), run.options));
    assert.equal(result.status, "already-verified");
    assert.ok("match" in result && result.match === "partial");
    assert.deepEqual(actions(run), ["getsourcecode"]);
    assertRequestsSafe(run);
  });

  it("checkStatus polls once and returns verified on pass", async () => {
    const run = setup({ checkverifystatus: [PASS] });
    const result = await drive(checkStatus(HANDLE, run.options));
    assert.equal(result.status, "verified");
    assert.equal(result.backend, "routescan");
    assert.deepEqual(actions(run), ["checkverifystatus"]);
    assertRequestsSafe(run);
    assertNoKey(run, result);
  });

  it("submit answers already verified: already-verified with the lookup's match", async () => {
    const run = setup({
      getsourcecode: [LOOKUP_NONE, LOOKUP_EXACT],
      verifysourcecode: [notok("Contract source code already verified")],
    });
    const result = await drive(verify(makeInput(), run.options));
    assert.equal(result.status, "already-verified");
    assert.ok("match" in result && result.match === "partial");
    assertRequestsSafe(run);
  });

  it("status answers Already Verified: already-verified", async () => {
    const run = setup({
      getsourcecode: [LOOKUP_EXACT],
      checkverifystatus: [notok("Already Verified")],
    });
    const result = await drive(checkStatus(HANDLE, run.options));
    assert.equal(result.status, "already-verified");
    assertRequestsSafe(run);
  });

  it("Fail - Unable to verify with no match after one lookup gives failed with reason", async () => {
    const run = setup({
      getsourcecode: [LOOKUP_NONE, LOOKUP_NONE],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [notok(FAIL_TEXT)],
    });
    const result = await drive(verify(makeInput(), run.options));
    assert.equal(result.status, "failed");
    assert.ok(result.status === "failed" && result.reason.startsWith("Fail - Unable to verify"));
    assert.deepEqual(actions(run), [
      "getsourcecode",
      "verifysourcecode",
      "checkverifystatus",
      "getsourcecode",
    ]);
    assertRequestsSafe(run);
  });

  it("Fail with a lookup that finds the source gives already-verified partial (R-FLOW-4, decision 0063)", async () => {
    const run = setup({
      getsourcecode: [LOOKUP_EXACT],
      checkverifystatus: [notok(FAIL_TEXT)],
    });
    const result = await drive(checkStatus(HANDLE, run.options));
    assert.equal(result.status, "already-verified");
  });
});

describe("#62 Routescan: transport (R-SEC-1)", () => {
  it("without a key, no apikey header is sent, and requests go out", async () => {
    const run = setup(
      {
        getsourcecode: [LOOKUP_NONE],
        verifysourcecode: [SUBMIT_OK],
        checkverifystatus: [PENDING, PASS],
      },
      {},
      false,
    );
    const result = await drive(verify(makeInput(), run.options));
    assert.equal(result.status, "verified");
    assertRequestsSafe(run, false);
  });

  it("without a key and without an injected fetch override, no missing-api-key is thrown", async () => {
    // routing.md: only etherscan-v2 needs a key. Here fetch is set, so we check it does not ask.
    const run = setup({ checkverifystatus: [PASS] }, {}, false);
    const result = await drive(checkStatus(HANDLE, run.options));
    assert.equal(result.status, "verified");
  });

  it("apiKeys.routescan with a route.apiUrl is not sent (api-keys.md, routescan.md)", async () => {
    const run = setup({ checkverifystatus: [PASS] }, { apiKeys: { routescan: KEY } }, false);
    await drive(checkStatus(HANDLE, run.options));
    assertRequestsSafe(run, false);
  });

  it("no chainid even when route.apiUrl carries none and the chain is 43113", async () => {
    const run = setup({ getsourcecode: [LOOKUP_EXACT] });
    await drive(verify(makeInput(), run.options));
    assert.ok(!run.calls[0]?.url.href.toLowerCase().includes("chainid"));
  });

  it("every GET URL differs across many polls and across two checkStatus calls", async () => {
    const run = setup({
      checkverifystatus: [PENDING, PENDING, PENDING, PENDING, PENDING, PASS, PASS],
    });
    await drive(checkStatus(HANDLE, run.options));
    await drive(checkStatus(HANDLE, run.options));
    const urls = run.calls.map((call) => call.url.href);
    assert.equal(urls.length, 7);
    assert.equal(new Set(urls).size, urls.length, urls.join("\n"));
  });

  it("GET URLs differ even when the clock does not move (two lookups in one call)", async () => {
    // Fail -> lookup; the final lookup and the first lookup must not share a URL.
    mock.timers.reset();
    mock.timers.enable({ apis: ["setTimeout"] });
    const run = setup({
      getsourcecode: [LOOKUP_NONE, LOOKUP_NONE],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [notok(FAIL_TEXT)],
    });
    await drive(verify(makeInput(), run.options));
    const gets = run.calls.filter((call) => call.method === "GET").map((call) => call.url.href);
    assert.equal(new Set(gets).size, gets.length, gets.join("\n"));
  });
});

describe("#62 Routescan: documented answers", () => {
  for (const [label, action] of [
    ["lookup", "getsourcecode"],
    ["submit", "verifysourcecode"],
    ["status", "checkverifystatus"],
  ] as const) {
    it(`chain not supported on ${label} throws unsupported-chain, never failed (R-FLOW-4)`, async () => {
      const script: Script =
        action === "getsourcecode"
          ? { getsourcecode: [CHAIN_NOT_SUPPORTED] }
          : action === "verifysourcecode"
            ? { getsourcecode: [LOOKUP_NONE], verifysourcecode: [CHAIN_NOT_SUPPORTED] }
            : { checkverifystatus: [CHAIN_NOT_SUPPORTED] };
      const run = setup(script);
      const pending =
        action === "checkverifystatus"
          ? checkStatus(HANDLE, run.options)
          : verify(makeInput(), run.options);
      const error = await errorOf(pending);
      assert.equal(error.details.code, "unsupported-chain");
      assert.equal(error.details.backend, "routescan");
      assert.equal("chainId" in error.details ? error.details.chainId : undefined, CHAIN_ID);
      assertNoKey(run, error);
      assertRequestsSafe(run);
    });
  }

  it("chain not supported on a later poll is not retried as a poll failure", async () => {
    const run = setup({ checkverifystatus: [PENDING, CHAIN_NOT_SUPPORTED, PASS] });
    const error = await errorOf(checkStatus(HANDLE, run.options));
    assert.equal(error.details.code, "unsupported-chain");
  });

  it("Verification not found with a verified lookup returns verified (checkStatus)", async () => {
    const run = setup({ checkverifystatus: [NOT_FOUND], getsourcecode: [LOOKUP_EXACT] });
    const result = await drive(checkStatus(HANDLE, run.options));
    assert.equal(result.status, "verified");
    assert.equal(result.backend, "routescan");
    assert.deepEqual(actions(run), ["checkverifystatus", "getsourcecode"]);
    assertRequestsSafe(run);
  });

  it("Verification not found with a verified lookup returns verified (verify)", async () => {
    const run = setup({
      getsourcecode: [LOOKUP_NONE, LOOKUP_EXACT],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [PENDING, NOT_FOUND],
    });
    const result = await drive(verify(makeInput(), run.options));
    assert.equal(result.status, "verified");
    assertRequestsSafe(run);
  });

  it("Verification not found with a not-verified lookup throws job-not-found with the handle", async () => {
    const run = setup({ checkverifystatus: [NOT_FOUND], getsourcecode: [LOOKUP_NONE] });
    const error = await errorOf(checkStatus(HANDLE, run.options));
    assert.equal(error.details.code, "job-not-found");
    const text = JSON.stringify(error);
    assert.ok(text.includes(HANDLE), text);
    assert.deepEqual(actions(run), ["checkverifystatus", "getsourcecode"]);
    assertNoKey(run, error);
  });

  it("Missing guid on a poll ends in unexpected-response, directly or as not-confirmed's cause", async () => {
    const run = setup({ checkverifystatus: [MISSING_GUID], getsourcecode: [LOOKUP_NONE] });
    const error = await errorOf(checkStatus(HANDLE, run.options));
    // Note: verify.md step 4 says an unexpected-response poll is logged and polling goes on, so
    // after 3 in a row the call may end not-confirmed with this as cause.
    const code = error.details.code;
    const causeCode =
      error.cause instanceof Error && "code" in error.cause ? error.cause.code : undefined;
    assert.ok(
      code === "unexpected-response" ||
        (code === "not-confirmed" && causeCode === "unexpected-response"),
      `got ${code} / cause ${String(causeCode)}`,
    );
    assertNoKey(run, error);
  });

  it("Missing guid on submit (a job id missing) throws unexpected-response", async () => {
    const run = setup({ getsourcecode: [LOOKUP_NONE], verifysourcecode: [MISSING_GUID] });
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "unexpected-response");
  });

  it("pending at the budget is resolved by the final lookup: verified (R-FLOW-2)", async () => {
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
    assert.equal(run.calls.at(-1)?.action, "getsourcecode");
    assertRequestsSafe(run);
  });

  it("pending at the budget with no match throws not-confirmed with the handle", async () => {
    const run = setup(
      {
        getsourcecode: [LOOKUP_NONE, LOOKUP_NONE],
        verifysourcecode: [SUBMIT_OK],
        checkverifystatus: [PENDING],
      },
      { timeoutMs: 5_000 },
    );
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "not-confirmed");
    assert.ok(JSON.stringify(error).includes(HANDLE));
    assertNoKey(run, error);
  });

  it("an unknown status text throws unknown-state with the handle", async () => {
    const run = setup({ checkverifystatus: [notok(`Something new ${KEY}`)] });
    const error = await errorOf(checkStatus(HANDLE, run.options));
    assert.equal(error.details.code, "unknown-state");
    assert.ok(JSON.stringify(error).includes(HANDLE));
    assertNoKey(run, error);
  });

  it("an unknown submit text throws unexpected-response", async () => {
    const run = setup({
      getsourcecode: [LOOKUP_NONE],
      verifysourcecode: [notok(`Odd answer from the server ${KEY}`)],
    });
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "unexpected-response");
    assertNoKey(run, error);
  });

  it("an unknown lookup answer throws unexpected-response, never not-verified", async () => {
    const run = setup({ getsourcecode: [notok(`weird ${KEY}`)] });
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "unexpected-response");
    assert.ok(!actions(run).includes("verifysourcecode"));
    assertNoKey(run, error);
  });
});

describe("#62 Routescan: rate limits (R-FLOW-6)", () => {
  it("HTTP 429 on lookup is retried with verify.retry reason rate-limited", async () => {
    const run = setup({
      getsourcecode: [HTTP_429, LOOKUP_EXACT],
    });
    const result = await drive(verify(makeInput(), run.options));
    assert.equal(result.status, "already-verified");
    const retries = run.events.filter((event) => event.type === "verify.retry");
    assert.ok(retries.length >= 1);
    assert.ok(retries.every((event) => "reason" in event && event.reason === "rate-limited"));
    assertRequestsSafe(run, true, false);
  });

  it("HTTP 429 on every try throws rate-limited", async () => {
    const run = setup({ getsourcecode: [HTTP_429] });
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "rate-limited");
    assertNoKey(run, error);
  });

  it("HTTP-200 rate-limit text on submit is retried and never fails", async () => {
    const run = setup({
      getsourcecode: [LOOKUP_NONE],
      verifysourcecode: [RATE_TEXT, SUBMIT_OK],
      checkverifystatus: [PASS],
    });
    const result = await drive(verify(makeInput(), run.options));
    assert.equal(result.status, "verified");
    const retries = run.events.filter((event) => event.type === "verify.retry");
    assert.ok(retries.some((event) => "reason" in event && event.reason === "rate-limited"));
    assertRequestsSafe(run);
  });

  it("HTTP-200 rate-limit text on poll is retried and never fails", async () => {
    const run = setup({ checkverifystatus: [RATE_TEXT, RATE_TEXT, PASS] });
    const result = await drive(checkStatus(HANDLE, run.options));
    assert.equal(result.status, "verified");
    assertRequestsSafe(run, true, false);
  });

  it("HTTP 429 on poll is retried and never fails", async () => {
    const run = setup({ checkverifystatus: [HTTP_429, PENDING, PASS] });
    const result = await drive(checkStatus(HANDLE, run.options));
    assert.equal(result.status, "verified");
    assertRequestsSafe(run, true, false);
  });

  it("a retried GET uses a new nocache value (routescan.md: nocache differs on every request)", async () => {
    const run = setup({ checkverifystatus: [RATE_TEXT, PASS] });
    await drive(checkStatus(HANDLE, run.options));
    const urls = run.calls.map((call) => call.url.href);
    assert.equal(urls.length, 2);
    assert.notEqual(urls[0], urls[1], "the retry repeated the cached URL");
  });

  it("a GET retried after HTTP 429 uses a new nocache value", async () => {
    const run = setup({ getsourcecode: [HTTP_429, LOOKUP_EXACT] });
    await drive(verify(makeInput(), run.options));
    const urls = run.calls.map((call) => call.url.href);
    assert.equal(urls.length, 2);
    assert.notEqual(urls[0], urls[1], "the retry repeated the cached URL");
  });
});

describe("#62 Routescan: abort and timeout", () => {
  it("an abort during polling rejects with signal.reason unchanged", async () => {
    const controller = new AbortController();
    const reason = new Error("stop now");
    const run = setup(
      {
        getsourcecode: [LOOKUP_NONE],
        verifysourcecode: [SUBMIT_OK],
        checkverifystatus: [PENDING],
      },
      {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "verify.poll") {
            controller.abort(reason);
          }
        },
      },
    );
    await assert.rejects(drive(verify(makeInput(), run.options)), (error) => error === reason);
  });

  it("an aborted signal before the call sends nothing", async () => {
    const controller = new AbortController();
    const reason = new Error("never started");
    controller.abort(reason);
    const run = setup({ getsourcecode: [LOOKUP_NONE] }, { signal: controller.signal });
    await assert.rejects(drive(verify(makeInput(), run.options)), (error) => error === reason);
    assert.equal(run.calls.length, 0);
  });

  it("a budget spent before the submit is accepted throws timeout without a handle", async () => {
    const run = setup({ getsourcecode: [LOOKUP_NONE] }, { timeoutMs: 3_000 });
    const inner = run.options.fetch;
    assert.ok(inner !== undefined);
    const options: VerifyOptions = {
      ...run.options,
      // The submit never answers until the library's own signal aborts it.
      fetch: async (target, init) => {
        if (init?.method === "POST") {
          return await new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              reject(init.signal?.reason ?? new Error("aborted"));
            });
          });
        }
        return await inner(target, init);
      },
    };
    const error = await errorOf(verify(makeInput(), options));
    assert.equal(error.details.code, "timeout");
    assert.ok(!("handle" in error.details) || error.details.handle === undefined);
    assertNoKey(run, error);
  });

  it("HTTP-200 rate-limit text on every submit ends in rate-limited or timeout, never failed", async () => {
    const run = setup(
      { getsourcecode: [LOOKUP_NONE], verifysourcecode: [RATE_TEXT] },
      { timeoutMs: 3_000 },
    );
    const error = await errorOf(verify(makeInput(), run.options));
    assert.ok(["rate-limited", "timeout"].includes(error.details.code), error.details.code);
    assertNoKey(run, error);
  });

  it("checkStatus never throws timeout: pending to the end gives not-confirmed", async () => {
    const run = setup(
      { checkverifystatus: [PENDING], getsourcecode: [LOOKUP_NONE] },
      {
        timeoutMs: 4_000,
      },
    );
    const error = await errorOf(checkStatus(HANDLE, run.options));
    assert.equal(error.details.code, "not-confirmed");
  });
});

describe("#62 Routescan: key never surfaces (R-SEC-1)", () => {
  it("the key echoed in a failed reason is redacted in the result", async () => {
    const run = setup({
      getsourcecode: [LOOKUP_NONE, LOOKUP_NONE],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [notok(`${FAIL_TEXT} key=${KEY} upper ${KEY.toUpperCase()}`)],
    });
    const result = await drive(verify(makeInput(), run.options));
    assert.equal(result.status, "failed");
    assertNoKey(run, result);
  });

  it("the key echoed in an HTTP 500 body is not in the error", async () => {
    const run = setup({
      getsourcecode: [{ http: 500, body: null, text: `<html>boom ${KEY}</html>` }],
    });
    const error = await errorOf(verify(makeInput(), run.options));
    assertNoKey(run, error);
  });

  it("a fetch that rejects with the key in its message does not leak it", async () => {
    const run = setup({});
    const options: VerifyOptions = {
      ...run.options,
      fetch: async () => {
        throw new TypeError(`fetch failed for apikey header ${KEY}`);
      },
    };
    const error = await errorOf(verify(makeInput(), options));
    assert.equal(error.details.code, "network");
    assertNoKey(run, error);
  });

  it("the key in a chain-not-supported message is redacted", async () => {
    const run = setup({
      getsourcecode: [{ body: { status: "0", message: "chain not supported", result: KEY } }],
    });
    const error = await errorOf(verify(makeInput(), run.options));
    assertNoKey(run, error);
  });
});

describe("#62 regression: Etherscan routes keep the key in the POST body", () => {
  it("etherscan-v2 sends apikey in the form body, chainid in the query, no apikey header", async () => {
    const ETHERSCAN = "https://api.etherscan.io/v2/api";
    const calls: { url: URL; body: URLSearchParams; headers: Headers; method: string }[] = [];
    const fn: typeof fetch = async (target, init) => {
      const url = new URL(target instanceof Request ? target.url : target);
      calls.push({
        url,
        body: new URLSearchParams(bodyText(init?.body)),
        headers: new Headers(init?.headers),
        method: init?.method ?? "GET",
      });
      return new Response(JSON.stringify(LOOKUP_EXACT.body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const result = await drive(
      verify(makeInput({ chainId: 11155111 }), {
        fetch: fn,
        route: { backend: "etherscan-v2", apiUrl: ETHERSCAN, apiKey: KEY },
      }),
    );
    assert.equal(result.status, "already-verified");
    assert.ok(calls.length > 0);
    for (const call of calls) {
      assert.equal(call.method, "POST");
      assert.equal(call.body.get("apikey"), KEY);
      assert.equal(call.url.searchParams.get("chainid"), "11155111");
      assert.ok(!call.url.href.includes(KEY));
      assert.equal(call.headers.get("apikey"), null);
    }
  });
});
