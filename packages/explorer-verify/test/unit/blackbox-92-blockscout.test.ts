// Black-box tests for issue #92: the Blockscout client for single-chain instances. They use only the
// issue, docs/user/reference/blockscout.md, verify.md, check-status.md, routing.md, api-keys.md,
// logging-and-events.md, the error pages, requirements.md and the package entry point. Every call
// goes through `verify()` or `checkStatus()` with a fake `fetch` that answers like a Blockscout
// instance. Time runs on node:test mock timers. No network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
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
import { jsKeys } from "../helpers/js-keys.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";
import { compileStrict } from "./envelope-schema.ts";

// A host the routing table does not list, so a route.apiUrl call has no table page (#169 gave Base
// Sepolia's own instance a row entry).
const ORIGIN = "https://blockscout.example.org";
const API = `${ORIGIN}/api`;
const CHAIN_ID = 84532;
const ADDRESS: Hex = "0x0d7ba9133629d6732a3ef5a3f5f09c68dac4be65";
const LOOKUP_PATH = `/api/v2/smart-contracts/${ADDRESS}`;
const GUID = "0d7ba9133629d6732a3ef5a3f5f09c68dac4be656aeaee3f";
const VERSION = "0.8.24+commit.e11b9ed9";
const ARGS_HEX = "000000000000000000000000000000000000000000000000000000000000002a";
// Dummy keys, never real (R-SEC-1).
const OTHER_KEY = "zz9dummyetherscankeyqq7xv";

const eventSchema: unknown = JSON.parse(
  readFileSync(new URL("../../schema/event.schema.json", import.meta.url), "utf8"),
);
const validateEvent = compileStrict(eventSchema);

// ---------------------------------------------------------------------------------------------
// Mock time.

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
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
// Fake Blockscout instance.

type Kind = "lookup" | "verifysourcecode" | "checkverifystatus";

interface Call {
  readonly kind: Kind;
  readonly method: string;
  readonly url: URL;
  readonly headers: [string, string][];
  readonly body: URLSearchParams;
  readonly redirect: string | undefined;
  readonly at: number;
}

interface Reply {
  readonly http?: number;
  readonly body?: unknown;
  readonly text?: string;
  readonly contentType?: string;
}

type Script = Partial<Record<Kind, readonly Reply[]>>;

const ok = (body: unknown): Reply => ({ body });
const LOOKUP_404: Reply = { http: 404, body: { message: "Not found" } };
const LOOKUP_FULL = ok({
  is_verified: true,
  is_fully_verified: true,
  is_partially_verified: false,
  name: "Greeter",
});
const LOOKUP_PARTIAL = ok({
  is_verified: true,
  is_fully_verified: false,
  is_partially_verified: true,
  name: "Greeter",
});
const LOOKUP_UNVERIFIED_FLAG = ok({ is_verified: false, name: null });
// The recorded shape of an unverified contract: code fields and no verification field.
const LOOKUP_CODE_ONLY = ok({
  conflicting_implementations: null,
  creation_bytecode: "0x60a0",
  creation_status: "success",
  deployed_bytecode: "0x6080",
  implementations: [],
  proxy_type: null,
});
const LOOKUP_NEITHER = ok({
  is_verified: true,
  is_fully_verified: false,
  is_partially_verified: false,
});
const HTML_PAGE: Reply = {
  http: 200,
  text: "<!doctype html><html><body>Bad gateway</body></html>",
  contentType: "text/html",
};

const SUBMIT_OK = ok({ message: "OK", result: GUID, status: "1" });
const SUBMIT_EMPTY = ok({ message: "OK", result: "", status: "1" });
const SUBMIT_ABSENT = ok({ message: "OK", status: "1" });
const SUBMIT_ALREADY = ok({
  message: "Smart-contract already verified.",
  result: "Smart-contract already verified.",
  status: "0",
});
const SUBMIT_NOT_CONTRACT = ok({
  message: "Address is not a smart-contract",
  result: "Address is not a smart-contract",
  status: "0",
});
const RATE_429: Reply = {
  http: 429,
  body: {
    message: "Too many requests. Increase limits now at https://dev.blockscout.com",
    result: null,
    status: "0",
  },
};
const status = (result: string): Reply => ok({ message: "OK", result, status: "1" });
const PENDING = status("Pending in queue");
const PASS = status("Pass - Verified");
const FAIL = status("Fail - Unable to verify");
const UNKNOWN_UID = status("Unknown UID");

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

function fakeBlockscout(script: Script): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const used: Record<Kind, number> = {
    lookup: 0,
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
    const redirect = target instanceof Request ? target.redirect : init?.redirect;
    let kind: Kind;
    if (method === "GET" && url.pathname.includes("/api/v2/smart-contracts/")) {
      kind = "lookup";
    } else {
      const action = body.get("action") ?? url.searchParams.get("action") ?? "";
      if (action !== "verifysourcecode" && action !== "checkverifystatus") {
        throw new Error(`unexpected request ${method} ${url.href} action=${action}`);
      }
      kind = action;
    }
    calls.push({ kind, method, url, headers, body, redirect, at: Date.now() });
    const replies = script[kind];
    if (replies === undefined || replies.length === 0) {
      throw new Error(`no reply scripted for ${kind}`);
    }
    const reply = replies[Math.min(used[kind], replies.length - 1)];
    used[kind] += 1;
    if (reply === undefined) {
      throw new Error("unreachable");
    }
    return new Response(reply.text ?? JSON.stringify(reply.body), {
      status: reply.http ?? 200,
      headers: {
        "content-type": reply.contentType ?? "application/json; charset=utf-8",
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
        sources: {
          "contracts/Greeter.sol": { content: "contract Greeter {}" },
        },
        settings: { optimizer: { enabled: false, runs: 200 } },
      },
    },
    contractName: "contracts/Greeter.sol:Greeter",
    ...overrides,
  };
}

function makeHandle(): Handle {
  return {
    version: 1,
    backend: "blockscout",
    chainId: CHAIN_ID,
    address: ADDRESS,
    jobId: GUID,
  };
}

const HANDLE_TEXT = `ev1:blockscout:${CHAIN_ID}:${ADDRESS}:${GUID}`;

interface Run {
  readonly options: VerifyOptions;
  readonly calls: Call[];
  readonly events: VerifyEvent[];
  readonly logs: {
    level: string;
    message: string;
    fields: LogFields | undefined;
  }[];
}

function setup(script: Script, extra: Partial<VerifyOptions> = {}): Run {
  const fake = fakeBlockscout(script);
  const events: VerifyEvent[] = [];
  const logs: Run["logs"] = [];
  const line =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      logs.push({ level, message, fields });
    };
  const logger: Logger = {
    debug: line("debug"),
    info: line("info"),
    warn: line("warn"),
    error: line("error"),
  };
  const options: VerifyOptions = {
    fetch: fake.fetch,
    route: { backend: "blockscout", apiUrl: API },
    pollIntervalMs: 3_000,
    timeoutMs: 120_000,
    logger,
    onEvent: (event) => {
      events.push(event);
    },
    ...extra,
  };
  return { options, calls: fake.calls, events, logs };
}

function kinds(run: Run): Kind[] {
  return run.calls.map((call) => call.kind);
}

function eventTypes(run: Run): string[] {
  return run.events.map((event) => event.type);
}

function retryReasons(run: Run): string[] {
  return run.events.flatMap((event) => (event.type === "verify.retry" ? [event.reason] : []));
}

/** blockscout.md "Requests", api-keys.md, R-SEC-2: origin, method, no key, no chainid. */
function assertRequestsSafe(run: Run, keys: readonly string[] = [OTHER_KEY]): void {
  assert.ok(run.calls.length > 0, "no request was sent");
  for (const call of run.calls) {
    assert.equal(call.url.origin, ORIGIN, `${call.kind} origin`);
    assert.equal(call.redirect, "manual", `${call.kind} redirect`);
    assert.ok(!call.url.searchParams.has("apikey"), `${call.kind} URL has apikey`);
    assert.ok(!call.body.has("apikey"), `${call.kind} body has apikey`);
    assert.ok(!call.url.searchParams.has("chainid"), `${call.kind} URL has chainid`);
    assert.ok(!call.body.has("chainid"), `${call.kind} body has chainid`);
    for (const [name, value] of call.headers) {
      assert.notEqual(name.toLowerCase(), "apikey");
      assert.notEqual(name.toLowerCase(), "authorization");
      for (const key of keys) {
        assert.ok(!value.includes(key), `${call.kind} header ${name} holds a key`);
      }
    }
    for (const key of keys) {
      assert.ok(!call.url.href.includes(key), `${call.kind} URL holds a key`);
      assert.ok(!call.body.toString().includes(key), `${call.kind} body holds a key`);
    }
    if (call.kind === "lookup") {
      assert.equal(call.method, "GET");
      assert.equal(call.url.pathname, LOOKUP_PATH);
    } else {
      assert.equal(call.method, "POST");
      assert.equal(`${call.url.origin}${call.url.pathname}`, API);
      const type = call.headers.find(([name]) => name === "content-type")?.[1] ?? "";
      assert.match(type, /^application\/x-www-form-urlencoded/u, `${call.kind} content-type`);
      assert.equal(call.body.get("module"), "contract");
    }
  }
}

function assertEventsValid(run: Run): void {
  for (const event of run.events) {
    assert.deepEqual(
      validateEvent(event),
      [],
      `breaks event.schema.json: ${JSON.stringify(event)}`,
    );
    assert.ok(Object.isFrozen(event), `event not frozen: ${event.type}`);
  }
  for (const event of run.events) {
    if ("backend" in event) {
      assert.equal(event.backend, "blockscout", `${event.type} backend`);
    }
    if (event.type === "verify.routed") {
      assert.equal(event.apiHost, "blockscout.example.org");
    }
  }
}

function lookupMatch(run: Run): string | undefined {
  const event = run.events.find((entry) => entry.type === "verify.lookup");
  return event?.type === "verify.lookup" ? event.lookup : undefined;
}

// ---------------------------------------------------------------------------------------------

describe("blackbox #92: submit, poll and lookup (R-BE-3)", () => {
  it("404 lookup, submit, pending, pass, full lookup: verified exact with events in order", async () => {
    const run = setup({
      lookup: [LOOKUP_404, LOOKUP_FULL],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [PENDING, PASS],
    });
    const result = await drive(
      verify(makeInput({ constructorArgs: `0x${ARGS_HEX}` }), run.options),
    );
    assert.deepEqual(result, {
      status: "verified",
      backend: "blockscout",
      match: "exact",
    });
    assert.deepEqual(kinds(run), [
      "lookup",
      "verifysourcecode",
      "checkverifystatus",
      "checkverifystatus",
      "lookup",
    ]);
    assert.deepEqual(eventTypes(run), [
      "verify.validated",
      "verify.routed",
      "verify.lookup",
      "verify.submitted",
      "verify.poll",
      "verify.result",
    ]);
    assert.equal(lookupMatch(run), "none");
    const submitted = run.events.find((event) => event.type === "verify.submitted");
    assert.ok(submitted?.type === "verify.submitted");
    assert.equal(submitted.handle, HANDLE_TEXT);
    const poll = run.events.find((event) => event.type === "verify.poll");
    assert.ok(poll?.type === "verify.poll");
    assert.equal(poll.state, "pending");
    assertEventsValid(run);
    assertRequestsSafe(run);
    // The handle is logged at info once the explorer accepts the submission.
    assert.ok(
      run.logs.some((line) => line.level === "info" && JSON.stringify(line).includes(GUID)),
    );
  });

  it("sends the documented submit fields, form-encoded", async () => {
    const run = setup({
      lookup: [LOOKUP_404, LOOKUP_FULL],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [PASS],
    });
    await drive(verify(makeInput({ constructorArgs: `0x${ARGS_HEX}` }), run.options));
    const submit = run.calls.find((call) => call.kind === "verifysourcecode");
    assert.ok(submit);
    assert.equal(submit.body.get("codeformat"), "solidity-standard-json-input");
    assert.equal(submit.body.get("contractaddress"), ADDRESS);
    assert.equal(submit.body.get("contractname"), "contracts/Greeter.sol:Greeter");
    assert.equal(submit.body.get("compilerversion"), `v${VERSION}`);
    assert.equal(submit.body.get("constructorArguments"), `0x${ARGS_HEX}`);
    const source: unknown = JSON.parse(submit.body.get("sourceCode") ?? "null");
    assert.deepEqual(source, makeInput().compiler.input);
    const poll = run.calls.find((call) => call.kind === "checkverifystatus");
    assert.equal(poll?.body.get("guid"), GUID);
  });

  it("sends compilerversion with one leading v when the input already has it", async () => {
    const run = setup({
      lookup: [LOOKUP_404, LOOKUP_FULL],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [PASS],
    });
    const base = makeInput();
    const input = makeInput({
      compiler: { ...base.compiler, version: `v${VERSION}` },
    });
    await drive(verify(input, run.options));
    const submit = run.calls.find((call) => call.kind === "verifysourcecode");
    assert.equal(submit?.body.get("compilerversion"), `v${VERSION}`);
  });

  it("leaves constructorArguments out when the input has none", async () => {
    const run = setup({
      lookup: [LOOKUP_404, LOOKUP_FULL],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [PASS],
    });
    await drive(verify(makeInput(), run.options));
    const submit = run.calls.find((call) => call.kind === "verifysourcecode");
    assert.equal(submit?.body.has("constructorArguments"), false);
  });

  it("strips compiler.input to language, sources and settings in sourceCode", async () => {
    const run = setup({
      lookup: [LOOKUP_404, LOOKUP_FULL],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [PASS],
    });
    const base = makeInput();
    const withExtra = { ...base.compiler.input, extra: "drop-me" };
    const input: VerifyInput = {
      ...base,
      compiler: { ...base.compiler, input: withExtra },
    };
    let outcome: unknown;
    try {
      outcome = await drive(verify(input, run.options));
    } catch (error) {
      outcome = error;
    }
    const submit = run.calls.find((call) => call.kind === "verifysourcecode");
    if (submit === undefined) {
      // validateInput may refuse the extra key; then nothing was sent, which is also safe.
      assert.ok(outcome instanceof ExplorerVerifyError);
      assert.equal(outcome.details.code, "invalid-input");
      return;
    }
    const source: unknown = JSON.parse(submit.body.get("sourceCode") ?? "{}");
    assert.ok(typeof source === "object" && source !== null);
    assert.deepEqual(Object.keys(source).toSorted(), ["language", "settings", "sources"]);
  });

  it("the full and partial lookup on submit never carry an explorerUrl for an apiUrl route", async () => {
    const run = setup({ lookup: [LOOKUP_FULL] });
    const result = await drive(verify(makeInput(), run.options));
    assert.equal("explorerUrl" in result, false);
  });
});

describe("blackbox #92: full and partial matches (R-FLOW-1, R-FLOW-7)", () => {
  it("Pass - Verified then a partial lookup: verified partial, never failed", async () => {
    const run = setup({
      lookup: [LOOKUP_404, LOOKUP_PARTIAL],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [PASS],
    });
    const result = await drive(verify(makeInput(), run.options));
    assert.deepEqual(result, {
      status: "verified",
      backend: "blockscout",
      match: "partial",
    });
    const final = run.events.at(-1);
    assert.deepEqual(final, {
      type: "verify.result",
      backend: "blockscout",
      status: "verified",
      match: "partial",
    });
    assertEventsValid(run);
  });

  it("a full match on the first lookup returns already-verified exact with no submit", async () => {
    const run = setup({ lookup: [LOOKUP_FULL] });
    const result = await drive(verify(makeInput(), run.options));
    assert.deepEqual(result, {
      status: "already-verified",
      backend: "blockscout",
      match: "exact",
    });
    assert.deepEqual(kinds(run), ["lookup"]);
    assert.deepEqual(eventTypes(run), [
      "verify.validated",
      "verify.routed",
      "verify.lookup",
      "verify.result",
    ]);
    assert.equal(lookupMatch(run), "exact");
    assertEventsValid(run);
    assertRequestsSafe(run);
  });

  it("a partial match on the first lookup returns already-verified partial with no submit", async () => {
    const run = setup({ lookup: [LOOKUP_PARTIAL] });
    const result = await drive(verify(makeInput(), run.options));
    assert.deepEqual(result, {
      status: "already-verified",
      backend: "blockscout",
      match: "partial",
    });
    assert.deepEqual(kinds(run), ["lookup"]);
    assert.equal(lookupMatch(run), "partial");
  });

  it("a bytecode-database partial match returns already-verified partial", async () => {
    const run = setup({
      lookup: [
        ok({
          is_verified: true,
          is_fully_verified: false,
          is_partially_verified: true,
          is_verified_via_eth_bytecode_db: true,
        }),
      ],
    });
    const result = await drive(verify(makeInput(), run.options));
    assert.deepEqual(result, {
      status: "already-verified",
      backend: "blockscout",
      match: "partial",
    });
  });

  it("Pass - Verified then a lookup that finds it not verified throws unknown-state", async () => {
    const run = setup({
      lookup: [LOOKUP_404, LOOKUP_404],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [PASS],
    });
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "unknown-state");
    assert.ok(!eventTypes(run).includes("verify.result"));
  });
});

describe("blackbox #92: already verified on submit", () => {
  it("Smart-contract already verified. then a full lookup: already-verified exact", async () => {
    const run = setup({
      lookup: [LOOKUP_404, LOOKUP_FULL],
      verifysourcecode: [SUBMIT_ALREADY],
    });
    const result = await drive(verify(makeInput(), run.options));
    assert.deepEqual(result, {
      status: "already-verified",
      backend: "blockscout",
      match: "exact",
    });
    assert.deepEqual(kinds(run), ["lookup", "verifysourcecode", "lookup"]);
    assert.ok(!eventTypes(run).includes("verify.submitted"));
    assertEventsValid(run);
  });

  it("Smart-contract already verified. then a lookup that finds it not verified: unexpected-response", async () => {
    const run = setup({
      lookup: [LOOKUP_404, LOOKUP_404],
      verifysourcecode: [SUBMIT_ALREADY],
    });
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "unexpected-response");
  });
});

describe("blackbox #92: submit answers that end the call", () => {
  it("Address is not a smart-contract throws invalid-input naming address", async () => {
    const run = setup({
      lookup: [LOOKUP_404],
      verifysourcecode: [SUBMIT_NOT_CONTRACT],
    });
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "invalid-input");
    assert.ok(error.details.code === "invalid-input");
    assert.ok(
      error.details.issues.some((issue) => issue.field === "address"),
      JSON.stringify(error.details),
    );
  });

  it("an unknown submit text throws unexpected-response with an excerpt, never failed", async () => {
    const text = "Something odd happened on the instance";
    const run = setup({
      lookup: [LOOKUP_404],
      verifysourcecode: [ok({ message: "NOTOK", result: text, status: "0" })],
    });
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "unexpected-response");
    assert.ok(error.details.code === "unexpected-response");
    assert.ok(error.details.excerpt.includes(text), error.details.excerpt);
    assert.ok(!eventTypes(run).includes("verify.submitted"));
  });

  it("an HTML page on submit throws, never a result", async () => {
    const run = setup({ lookup: [LOOKUP_404], verifysourcecode: [HTML_PAGE] });
    const error = await errorOf(verify(makeInput(), run.options));
    assert.ok(["unexpected-response", "network"].includes(error.details.code), error.details.code);
  });

  it("status 1 with a non-guid text is not read as a job", async () => {
    // `status` "1" alone never means success (blockscout.md "How answers are read").
    const run = setup({
      lookup: [LOOKUP_404],
      verifysourcecode: [ok({ message: "OK", result: "Unknown UID", status: "1" })],
      checkverifystatus: [PASS],
    });
    let outcome: unknown;
    try {
      outcome = await drive(verify(makeInput(), run.options));
    } catch (error) {
      outcome = error;
    }
    // Either it treats the text as a job id (documented: "status 1 and a job id") or throws.
    // It must never return verified without asking a status endpoint and a lookup.
    if (!(outcome instanceof ExplorerVerifyError)) {
      assert.ok(kinds(run).includes("checkverifystatus"), JSON.stringify(outcome));
    }
  });
});

describe("blackbox #92: status answers", () => {
  it("Fail - Unable to verify returns failed with the text as reason", async () => {
    const run = setup({
      lookup: [LOOKUP_404],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [FAIL],
    });
    const result = await drive(verify(makeInput(), run.options));
    assert.deepEqual(result, {
      status: "failed",
      backend: "blockscout",
      reason: "Fail - Unable to verify",
    });
    const final = run.events.at(-1);
    assert.ok(final?.type === "verify.result");
    assert.equal(final.status, "failed");
    assert.equal("match" in final, false);
    assertEventsValid(run);
  });

  it("Unknown UID with status 1 and a not-verified lookup throws job-not-found, never verified", async () => {
    const run = setup({
      lookup: [LOOKUP_404, LOOKUP_404],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [UNKNOWN_UID],
    });
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "job-not-found");
    assert.ok(error.details.code === "job-not-found");
    assert.deepEqual(error.details.handle, makeHandle());
    assert.deepEqual(kinds(run), ["lookup", "verifysourcecode", "checkverifystatus", "lookup"]);
  });

  it("Unknown UID and a lookup that finds a full match returns verified exact", async () => {
    const run = setup({
      lookup: [LOOKUP_404, LOOKUP_FULL],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [UNKNOWN_UID],
    });
    const result = await drive(verify(makeInput(), run.options));
    assert.deepEqual(result, {
      status: "verified",
      backend: "blockscout",
      match: "exact",
    });
  });

  it("an unknown status text throws unknown-state with the handle", async () => {
    const run = setup({
      lookup: [LOOKUP_404, LOOKUP_FULL],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [status("Something new from Blockscout")],
    });
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "unknown-state");
    assert.ok(error.details.code === "unknown-state");
    assert.deepEqual(error.details.handle, makeHandle());
  });

  it("an unknown status text with status 0 also throws, never failed", async () => {
    const run = setup({
      lookup: [LOOKUP_404, LOOKUP_FULL],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [ok({ message: "NOTOK", result: "Odd failure text", status: "0" })],
    });
    let outcome: unknown;
    try {
      outcome = await drive(verify(makeInput(), run.options));
    } catch (error) {
      outcome = error;
    }
    assert.ok(outcome instanceof ExplorerVerifyError, JSON.stringify(outcome));
  });
});

describe("blackbox #92: lookup answers (R-FLOW-4)", () => {
  it("an unverified lookup with no is_verified field reads as not verified and submits", async () => {
    const run = setup({
      lookup: [LOOKUP_CODE_ONLY, LOOKUP_FULL],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [PASS],
    });
    const result = await drive(verify(makeInput(), run.options));
    assert.deepEqual(result, {
      status: "verified",
      backend: "blockscout",
      match: "exact",
    });
    assert.equal(lookupMatch(run), "none");
    assert.equal(kinds(run)[1], "verifysourcecode");
  });

  it("is_verified false reads as not verified and submits", async () => {
    const run = setup({
      lookup: [LOOKUP_UNVERIFIED_FLAG, LOOKUP_FULL],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [PASS],
    });
    const result = await drive(verify(makeInput(), run.options));
    assert.equal(result.status, "verified");
    assert.equal(lookupMatch(run), "none");
  });

  it("a 404 Not found lookup reads as not verified and submits", async () => {
    const run = setup({
      lookup: [LOOKUP_404, LOOKUP_FULL],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [PASS],
    });
    await drive(verify(makeInput(), run.options));
    assert.equal(kinds(run)[1], "verifysourcecode");
  });

  it("a 200 with is_verified true and neither flag throws before any submit", async () => {
    const run = setup({ lookup: [LOOKUP_NEITHER] });
    const error = await errorOf(verify(makeInput(), run.options));
    // blockscout.md says unexpected-response; issue #92 says unknown-state.
    assert.equal(error.details.code, "unexpected-response");
    assert.ok(!kinds(run).includes("verifysourcecode"));
  });

  it("an HTML 200 lookup throws unexpected-response before any submit", async () => {
    const run = setup({ lookup: [HTML_PAGE] });
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "unexpected-response");
    assert.ok(!kinds(run).includes("verifysourcecode"));
  });

  it("a 422 lookup throws unexpected-response, never not verified", async () => {
    const run = setup({
      lookup: [
        {
          http: 422,
          body: {
            errors: [{ title: "Invalid value", detail: "Invalid format." }],
          },
        },
      ],
    });
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "unexpected-response");
    assert.ok(!kinds(run).includes("verifysourcecode"));
  });

  it("a 404 with another body throws, never not verified", async () => {
    const run = setup({
      lookup: [{ http: 404, text: "<html>404</html>", contentType: "text/html" }],
    });
    let outcome: unknown;
    try {
      outcome = await drive(verify(makeInput(), run.options));
    } catch (error) {
      outcome = error;
    }
    assert.ok(outcome instanceof ExplorerVerifyError, `got ${JSON.stringify(outcome)}`);
    assert.ok(!kinds(run).includes("verifysourcecode"));
  });

  it("a lookup with is_verified as a string throws, never not verified", async () => {
    const run = setup({ lookup: [ok({ is_verified: "false" })] });
    let outcome: unknown;
    try {
      outcome = await drive(verify(makeInput(), run.options));
    } catch (error) {
      outcome = error;
    }
    assert.ok(outcome instanceof ExplorerVerifyError, `got ${JSON.stringify(outcome)}`);
    assert.ok(!kinds(run).includes("verifysourcecode"));
  });
});

describe("blackbox #92: the empty submit answer (R-FLOW-7)", () => {
  it("an empty result: warn, verify.retry empty-submit, wait, lookup, new submit, verified", async () => {
    const run = setup({
      lookup: [LOOKUP_404, LOOKUP_404, LOOKUP_FULL],
      verifysourcecode: [SUBMIT_EMPTY, SUBMIT_OK],
      checkverifystatus: [PASS],
    });
    const result = await drive(verify(makeInput(), run.options));
    assert.deepEqual(result, {
      status: "verified",
      backend: "blockscout",
      match: "exact",
    });
    assert.deepEqual(kinds(run), [
      "lookup",
      "verifysourcecode",
      "lookup",
      "verifysourcecode",
      "checkverifystatus",
      "lookup",
    ]);
    assert.deepEqual(retryReasons(run), ["empty-submit"]);
    assert.deepEqual(eventTypes(run), [
      "verify.validated",
      "verify.routed",
      "verify.lookup",
      "verify.retry",
      "verify.submitted",
      "verify.result",
    ]);
    const retry = run.events.find((event) => event.type === "verify.retry");
    assert.ok(retry?.type === "verify.retry");
    assert.equal(retry.attempt, 2);
    assert.equal(retry.delayMs, 3_000);
    assert.ok(
      run.logs.some((line) => line.level === "warn"),
      "no warn line",
    );
    const [first, second] = run.calls.filter((call) => call.kind === "verifysourcecode");
    const between = run.calls[2];
    assert.ok(first && second && between);
    assert.ok(second.at - first.at >= 3_000, `waited ${second.at - first.at} ms`);
    assert.ok(between.at - first.at >= 3_000, "lookup came before the wait");
    assertEventsValid(run);
    assertRequestsSafe(run);
  });

  it("an absent result is handled the same way", async () => {
    const run = setup({
      lookup: [LOOKUP_404, LOOKUP_404, LOOKUP_FULL],
      verifysourcecode: [SUBMIT_ABSENT, SUBMIT_OK],
      checkverifystatus: [PASS],
    });
    const result = await drive(verify(makeInput(), run.options));
    assert.equal(result.status, "verified");
    assert.deepEqual(retryReasons(run), ["empty-submit"]);
  });

  it("a match found by the lookup after an empty answer ends as already-verified, no new submit", async () => {
    const run = setup({
      lookup: [LOOKUP_404, LOOKUP_PARTIAL],
      verifysourcecode: [SUBMIT_EMPTY],
    });
    const result = await drive(verify(makeInput(), run.options));
    assert.deepEqual(result, {
      status: "already-verified",
      backend: "blockscout",
      match: "partial",
    });
    assert.deepEqual(kinds(run), ["lookup", "verifysourcecode", "lookup"]);
  });

  it("an empty answer every time stops within 30 s with unexpected-response", async () => {
    const run = setup({
      lookup: [LOOKUP_404],
      verifysourcecode: [SUBMIT_EMPTY],
    });
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "unexpected-response");
    const submits = run.calls.filter((call) => call.kind === "verifysourcecode");
    assert.ok(submits.length >= 2, `${submits.length} submits`);
    const first = submits[0];
    const last = submits.at(-1);
    assert.ok(first && last);
    assert.ok(last.at - first.at <= 30_000, `last submit ${last.at - first.at} ms after the first`);
    assert.ok(submits.length <= 11, `${submits.length} submits`);
    assert.equal(retryReasons(run).filter((r) => r === "empty-submit").length, submits.length - 1);
    assert.match(error.hint, /try again later/, error.hint);
    assert.ok(!eventTypes(run).includes("verify.result"));
    assertEventsValid(run);
  });

  it("an empty answer every time with a short budget throws timeout", async () => {
    const run = setup(
      { lookup: [LOOKUP_404], verifysourcecode: [SUBMIT_EMPTY] },
      { timeoutMs: 10_000 },
    );
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "timeout");
    assert.ok(Date.now() <= 10_000 + 3_000, `ended at ${Date.now()} ms`);
  });
});

describe("blackbox #92: rate limits (never failed)", () => {
  it("a 429 on submit is retried with backoff and verify.retry rate-limited", async () => {
    const run = setup({
      lookup: [LOOKUP_404, LOOKUP_FULL],
      verifysourcecode: [RATE_429, SUBMIT_OK],
      checkverifystatus: [PASS],
    });
    const result = await drive(verify(makeInput(), run.options));
    assert.equal(result.status, "verified");
    assert.ok(retryReasons(run).includes("rate-limited"));
    assertEventsValid(run);
  });

  it("a 429 on every submit ends rate-limited, never failed", async () => {
    const run = setup({ lookup: [LOOKUP_404], verifysourcecode: [RATE_429] });
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "rate-limited");
  });

  it("a 429 on every lookup ends rate-limited before any submit", async () => {
    const run = setup({ lookup: [RATE_429] });
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "rate-limited");
    assert.ok(!kinds(run).includes("verifysourcecode"));
  });

  it("a 429 on every poll ends not-confirmed with the handle, never failed", async () => {
    const run = setup({
      lookup: [LOOKUP_404, LOOKUP_404],
      verifysourcecode: [SUBMIT_OK],
      checkverifystatus: [RATE_429],
    });
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "not-confirmed");
    assert.ok(error.details.code === "not-confirmed");
    assert.deepEqual(error.details.handle, makeHandle());
  });

  it("the rate-limit body with status 200 is never read as a result", async () => {
    const run = setup({
      lookup: [LOOKUP_404],
      verifysourcecode: [{ body: RATE_429.body }],
    });
    const error = await errorOf(verify(makeInput(), run.options));
    assert.ok(["unexpected-response", "rate-limited"].includes(error.details.code));
  });
});

describe("blackbox #92: route and keys (R-SEC-2)", () => {
  for (const apiUrl of [
    "https://blockscout.example.org",
    "https://blockscout.example.org/",
    "https://blockscout.example.org/api/v2",
    "https://blockscout.example.org/apis",
    "https://blockscout.example.org/v1/rpc",
  ]) {
    it(`apiUrl ${apiUrl} throws invalid-input naming route.apiUrl before any request`, async () => {
      const run = setup({}, { route: { backend: "blockscout", apiUrl } });
      const error = await errorOf(verify(makeInput(), run.options));
      assert.equal(error.details.code, "invalid-input");
      assert.ok(error.details.code === "invalid-input");
      assert.ok(
        error.details.issues.some((issue) => issue.field === "route.apiUrl"),
        JSON.stringify(error.details),
      );
      assert.equal(run.calls.length, 0);
      assert.deepEqual(run.events, []);
    });
  }

  it("an apiUrl with a trailing slash is accepted and requests go to <origin>/api", async () => {
    // routing.md "Request URLs": trailing slashes are removed.
    const run = setup(
      { lookup: [LOOKUP_FULL] },
      { route: { backend: "blockscout", apiUrl: `${ORIGIN}/api/` } },
    );
    await drive(verify(makeInput(), run.options));
    assert.equal(run.calls[0]?.url.origin, ORIGIN);
    assert.equal(run.calls[0]?.url.pathname, LOOKUP_PATH);
  });

  it("an apiUrl under a path prefix keeps the prefix: <apiUrl>/v2/smart-contracts/<address>", async () => {
    // routing.md "Request URLs": the lookup is `<apiUrl>/v2/smart-contracts/<address>`, so a
    // prefix before /api is kept.
    const run = setup(
      { lookup: [LOOKUP_FULL] },
      { route: { backend: "blockscout", apiUrl: `${ORIGIN}/explorer/api` } },
    );
    await drive(verify(makeInput(), run.options));
    assert.equal(run.calls[0]?.url.origin, ORIGIN);
    assert.equal(run.calls[0]?.url.pathname, `/explorer${LOOKUP_PATH}`);
  });

  it("checkStatus also refuses an apiUrl that does not end in /api", async () => {
    const run = setup({}, { route: { backend: "blockscout", apiUrl: ORIGIN } });
    const error = await errorOf(checkStatus(makeHandle(), run.options));
    assert.equal(error.details.code, "invalid-input");
    assert.equal(run.calls.length, 0);
  });

  it("apiKeys.blockscout throws invalid-input before any request", async () => {
    const run = setup({}, { apiKeys: jsKeys("blockscout", OTHER_KEY) });
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "invalid-input");
    assert.equal(run.calls.length, 0);
    assert.ok(!JSON.stringify(error.toJSON()).includes(OTHER_KEY));
  });

  it("route.apiKey throws invalid-input before any request", async () => {
    const run = setup({}, { route: { backend: "blockscout", apiUrl: API, apiKey: OTHER_KEY } });
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "invalid-input");
    assert.equal(run.calls.length, 0);
    assert.ok(!JSON.stringify(error.toJSON()).includes(OTHER_KEY));
  });

  it("an etherscan-v2 key in apiKeys never reaches the instance", async () => {
    const run = setup(
      {
        lookup: [LOOKUP_404, LOOKUP_404, LOOKUP_FULL],
        verifysourcecode: [SUBMIT_EMPTY, SUBMIT_OK],
        checkverifystatus: [PENDING, PASS],
      },
      { apiKeys: { "etherscan-v2": OTHER_KEY } },
    );
    const result = await drive(verify(makeInput(), run.options));
    assert.equal(result.status, "verified");
    assertRequestsSafe(run, [OTHER_KEY]);
    const seen = [JSON.stringify(run.events), JSON.stringify(run.logs), JSON.stringify(result)];
    for (const text of seen) {
      assert.ok(!text.includes(OTHER_KEY));
    }
  });

  it("every request of a checkStatus run stays on the instance origin, with no key", async () => {
    const run = setup(
      { checkverifystatus: [PENDING, UNKNOWN_UID], lookup: [LOOKUP_FULL] },
      { apiKeys: { "etherscan-v2": OTHER_KEY } },
    );
    const result = await drive(checkStatus(makeHandle(), run.options));
    assert.deepEqual(result, {
      status: "verified",
      backend: "blockscout",
      match: "exact",
    });
    assertRequestsSafe(run, [OTHER_KEY]);
  });
});

describe("blackbox #92: checkStatus", () => {
  it("polls at once, then pass and a lookup: verified exact; events routed, poll, result", async () => {
    const run = setup({
      checkverifystatus: [PENDING, PASS],
      lookup: [LOOKUP_FULL],
    });
    const result = await drive(checkStatus(HANDLE_TEXT, run.options));
    assert.deepEqual(result, {
      status: "verified",
      backend: "blockscout",
      match: "exact",
    });
    assert.deepEqual(kinds(run), ["checkverifystatus", "checkverifystatus", "lookup"]);
    assert.equal(run.calls[0]?.at, 0, "first poll not sent at once");
    assert.deepEqual(eventTypes(run), ["verify.routed", "verify.poll", "verify.result"]);
    assertEventsValid(run);
    assertRequestsSafe(run);
  });

  it("pass and a partial lookup: verified partial", async () => {
    const run = setup({ checkverifystatus: [PASS], lookup: [LOOKUP_PARTIAL] });
    const result = await drive(checkStatus(makeHandle(), run.options));
    assert.deepEqual(result, {
      status: "verified",
      backend: "blockscout",
      match: "partial",
    });
  });

  it("Fail - Unable to verify returns failed", async () => {
    const run = setup({ checkverifystatus: [FAIL] });
    const result = await drive(checkStatus(makeHandle(), run.options));
    assert.deepEqual(result, {
      status: "failed",
      backend: "blockscout",
      reason: "Fail - Unable to verify",
    });
  });

  it("Unknown UID and a not-verified lookup throws job-not-found", async () => {
    const run = setup({
      checkverifystatus: [UNKNOWN_UID],
      lookup: [LOOKUP_404],
    });
    const error = await errorOf(checkStatus(makeHandle(), run.options));
    assert.equal(error.details.code, "job-not-found");
    assert.deepEqual(kinds(run), ["checkverifystatus", "lookup"]);
  });

  it("Unknown UID and a failed lookup throws job-not-found with the lookup's error as cause", async () => {
    const run = setup({
      checkverifystatus: [UNKNOWN_UID],
      lookup: [HTML_PAGE],
    });
    const error = await errorOf(checkStatus(makeHandle(), run.options));
    assert.equal(error.details.code, "job-not-found");
    assert.ok(error.cause !== undefined);
  });

  it("an unknown status text throws unknown-state", async () => {
    const run = setup({
      checkverifystatus: [status("Queued for later")],
      lookup: [LOOKUP_FULL],
    });
    const error = await errorOf(checkStatus(makeHandle(), run.options));
    assert.equal(error.details.code, "unknown-state");
  });

  it("a handle of another backend throws invalid-input naming backend, nothing sent", async () => {
    const run = setup({});
    const error = await errorOf(
      checkStatus(`ev1:sourcify:${CHAIN_ID}:${ADDRESS}:${GUID}`, run.options),
    );
    assert.equal(error.details.code, "invalid-input");
    assert.ok(error.details.code === "invalid-input");
    assert.ok(error.details.issues.some((issue) => issue.field === "backend"));
    assert.equal(run.calls.length, 0);
  });

  it("pending until the budget ends: not-confirmed with the same handle, never timeout", async () => {
    const run = setup(
      { checkverifystatus: [PENDING], lookup: [LOOKUP_404] },
      { timeoutMs: 10_000 },
    );
    const error = await errorOf(checkStatus(makeHandle(), run.options));
    assert.equal(error.details.code, "not-confirmed");
    assert.ok(error.details.code === "not-confirmed");
    assert.deepEqual(error.details.handle, makeHandle());
    assert.ok(Date.now() <= 10_000 + 3_000, `ended at ${Date.now()}`);
  });
});

describe("blackbox #92: abort and timeout (R-FLOW-6)", () => {
  it("an abort while polling rejects with signal.reason unchanged", async () => {
    const controller = new AbortController();
    const reason = new Error("stop here");
    const run = setup(
      {
        lookup: [LOOKUP_404],
        verifysourcecode: [SUBMIT_OK],
        checkverifystatus: [PENDING],
      },
      {
        signal: controller.signal,
        onEvent: (event) => {
          run.events.push(event);
          if (event.type === "verify.poll") {
            controller.abort(reason);
          }
        },
      },
    );
    await assert.rejects(drive(verify(makeInput(), run.options)), (error) => error === reason);
    assert.ok(!eventTypes(run).includes("verify.result"));
    assert.equal(run.calls.filter((call) => call.kind === "checkverifystatus").length, 1);
  });

  it("an abort during the empty-submit wait rejects with signal.reason, no second submit", async () => {
    const controller = new AbortController();
    const reason = new Error("stop at retry");
    const run = setup(
      { lookup: [LOOKUP_404], verifysourcecode: [SUBMIT_EMPTY] },
      {
        signal: controller.signal,
        onEvent: (event) => {
          run.events.push(event);
          if (event.type === "verify.retry") {
            controller.abort(reason);
          }
        },
      },
    );
    await assert.rejects(drive(verify(makeInput(), run.options)), (error) => error === reason);
    assert.equal(run.calls.filter((call) => call.kind === "verifysourcecode").length, 1);
  });

  it("an already aborted signal rejects with its reason and sends nothing", async () => {
    const controller = new AbortController();
    const reason = new Error("before start");
    controller.abort(reason);
    const run = setup({ lookup: [LOOKUP_FULL] }, { signal: controller.signal });
    await assert.rejects(drive(verify(makeInput(), run.options)), (error) => error === reason);
    assert.equal(run.calls.length, 0);
  });

  it("pending until the budget runs out: last lookup, then not-confirmed with the handle", async () => {
    const run = setup(
      {
        lookup: [LOOKUP_404, LOOKUP_404],
        verifysourcecode: [SUBMIT_OK],
        checkverifystatus: [PENDING],
      },
      { timeoutMs: 15_000 },
    );
    const error = await errorOf(verify(makeInput(), run.options));
    assert.equal(error.details.code, "not-confirmed");
    assert.ok(error.details.code === "not-confirmed");
    assert.deepEqual(error.details.handle, makeHandle());
    assert.equal(run.calls.at(-1)?.kind, "lookup");
    assert.ok(Date.now() <= 15_000 + 3_000, `ended at ${Date.now()}`);
    for (const event of run.events) {
      if (event.type === "verify.poll") {
        assert.equal(event.state, "pending");
      }
    }
    assertEventsValid(run);
  });

  it("pending, then the last lookup finds a partial match: verified partial", async () => {
    const run = setup(
      {
        lookup: [LOOKUP_404, LOOKUP_PARTIAL],
        verifysourcecode: [SUBMIT_OK],
        checkverifystatus: [PENDING],
      },
      { timeoutMs: 15_000 },
    );
    const result = await drive(verify(makeInput(), run.options));
    assert.deepEqual(result, {
      status: "verified",
      backend: "blockscout",
      match: "partial",
    });
  });
});
