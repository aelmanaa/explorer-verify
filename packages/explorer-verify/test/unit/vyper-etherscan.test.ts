// Vyper on Etherscan v2 and through the server handler (#424; R-BE-1, R-EXT-1, R-FLOW-1, R-FLOW-4,
// R-IN-3, R-SRV-3, R-SRV-5, R-SEC-1, decisions 0063 and 0078). Every Etherscan answer is a
// recording of 2026-11-19 in test/fixtures/etherscan/2026-11-19-vyper-*.json: three Vyper 0.4.3
// contracts on Ethereum Sepolia, TallyA, TallyB and TallyC, with the same body and so the same
// bytecode.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import type { Context } from "../../src/backends/backend.ts";
import { etherscanCompatible } from "../../src/backends/etherscan-compatible.ts";
import { etherscan } from "../../src/backends/etherscan.ts";
import { routescan } from "../../src/backends/routescan.ts";
import { kindCheck, VYPER_ROUTES } from "../../src/compiler-kinds.ts";
import { otherContract } from "../../src/flow/stored.ts";
import { ExplorerVerifyError, dryRun, validateInput, verify, verifyEach } from "../../src/index.ts";
import type { Hex, Logger, VerifyEvent, VerifyInput, VerifyOptions } from "../../src/index.ts";
import { createVerifyHandler } from "../../src/server/handler.ts";
import { loadFixture, replay } from "../helpers/fake-fetch.ts";
import type { Call } from "../helpers/fake-fetch.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";
import { resolveRoute } from "../helpers/route.ts";

const SEPOLIA = 11155111;
const TALLY_A: Hex = "0xb723519c03d0529dde21b1cd3dd255e83ab0f32b";
const TALLY_B: Hex = "0xbf4ed80f83025577717e4d5ddee115b52495419e";
const DEPLOYER = "0x9d087fc03ae39b088326b67fa3c788236645b717";
const HANDLER = "https://dapp.example/api/verify";
// A fake key in lowercase hex, the shape of a real one. Never a real key (R-SEC-1).
const DUMMY_KEY = "0123456789abcdef0123456789abcdef42";
// TallyA's constructor arguments as deployed: (uint256 7, string "ev-424-direct").
const ARGS_A =
  "0000000000000000000000000000000000000000000000000000000000000007" +
  "0000000000000000000000000000000000000000000000000000000000000040" +
  "000000000000000000000000000000000000000000000000000000000000000d" +
  "65762d3432342d64697265637400000000000000000000000000000000000000";
const MISMATCH =
  "Fail - Unable to verify. Compiled contract deployment bytecode does NOT match the transaction deployment bytecode.";

interface Recorded {
  readonly request: {
    readonly body: { readonly fields: Record<string, string> };
  };
  readonly response: {
    readonly status: number;
    readonly body: Record<string, unknown>;
  };
}

/** `test/fixtures/etherscan/2026-11-19-vyper-<name>.json`. */
function recorded(name: string): Recorded {
  const url = new URL(`../fixtures/etherscan/2026-11-19-vyper-${name}.json`, import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
  assert.ok(typeof parsed === "object" && parsed !== null);
  const request: unknown = Reflect.get(parsed, "request");
  const response: unknown = Reflect.get(parsed, "response");
  assert.ok(typeof request === "object" && request !== null);
  assert.ok(typeof response === "object" && response !== null);
  const body: unknown = Reflect.get(request, "body");
  assert.ok(typeof body === "object" && body !== null);
  const fields: unknown = Reflect.get(body, "fields");
  const status: unknown = Reflect.get(response, "status");
  const reply: unknown = Reflect.get(response, "body");
  assert.ok(typeof fields === "object" && fields !== null);
  assert.ok(typeof status === "number" && typeof reply === "object" && reply !== null);
  return {
    request: {
      body: {
        fields: Object.fromEntries(Object.entries(fields).map(stringEntry)),
      },
    },
    response: { status, body: { ...reply } },
  };
}

function stringEntry([key, value]: [string, unknown]): [string, string] {
  assert.equal(typeof value, "string");
  return [key, String(value)];
}

/** The recorded answer, with `edit` applied to its body. */
function answer(name: string, edit?: (body: Record<string, unknown>) => void): Response {
  const { response } = recorded(name);
  const body = structuredClone(response.body);
  edit?.(body);
  return new Response(JSON.stringify(body), {
    status: response.status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** The recorded request fields, with the redacted key replaced by `key`. */
function sentFields(name: string, key: string): Record<string, string> {
  return { ...recorded(name).request.body.fields, apikey: key };
}

/** The fields of a form call. */
function fieldsOf(call: Call | undefined): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(call?.body));
}

/** A Vyper input built from a recorded submit: the source it sent and its contract. */
function inputFrom(name: string, address: Hex): VerifyInput {
  const fields = recorded(name).request.body.fields;
  const json: unknown = JSON.parse(fields["sourceCode"] ?? "");
  return validateInput({
    chainId: SEPOLIA,
    address,
    contractName: fields["contractname"],
    compiler: { kind: "vyper", version: "0.4.3+commit.bff19ea2", input: json },
  });
}

/** TallyA's input with the compiled creation code, so verify() derives the arguments. */
function tallyA(): VerifyInput {
  const creation = recorded("getcontractcreation").response.body["result"];
  assert.ok(Array.isArray(creation));
  const code: unknown = Reflect.get(Object(creation[0]), "creationBytecode");
  assert.ok(typeof code === "string" && code.endsWith(ARGS_A));
  const compiled = code.slice(0, code.length - ARGS_A.length);
  assert.ok(compiled.startsWith("0x"));
  return {
    ...inputFrom("verifysourcecode", TALLY_A),
    creationBytecode: `0x${compiled.slice(2)}`,
  };
}

/** TallyB's input with its recorded arguments; `wrong` takes the changed source. */
function tallyB(wrong = false): VerifyInput {
  const name = wrong ? "verifysourcecode-wrong-source" : "handler-verifysourcecode";
  const args = recorded(name).request.body.fields["constructorArguments"] ?? "";
  return { ...inputFrom(name, TALLY_B), constructorArgs: `0x${args}` };
}

interface Run {
  readonly lines: string[];
  readonly events: VerifyEvent[];
  readonly options: VerifyOptions;
}

/** Options that record every log line and event. */
function run(fetch: typeof globalThis.fetch, extra: VerifyOptions = {}): Run {
  const lines: string[] = [];
  const events: VerifyEvent[] = [];
  const line =
    (level: string) =>
    (message: string, fields?: unknown): void => {
      lines.push(`${level} ${message} ${JSON.stringify(fields)}`);
    };
  const logger: Logger = {
    debug: line("debug"),
    info: line("info"),
    warn: line("warn"),
    error: line("error"),
  };
  return {
    lines,
    events,
    options: {
      fetch,
      route: { backend: "etherscan-v2" },
      apiKeys: { "etherscan-v2": DUMMY_KEY },
      pollIntervalMs: 1_000,
      logger,
      onEvent: (event) => {
        events.push(event);
      },
      ...extra,
    },
  };
}

async function drive<T>(t: TestContext, promise: Promise<T>): Promise<T> {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const tracked = promise.finally(() => undefined);
  tracked.catch(() => {});
  await driveMockClock(tracked, () => {
    t.mock.timers.runAll();
  });
  return await tracked;
}

/** Asserts the dummy key appears in no line, event or value. */
function assertNoKey(...values: unknown[]): void {
  for (const value of values) {
    assert.ok(!JSON.stringify(value).includes(DUMMY_KEY), "the key is shown");
  }
}

const PAGE_A = `https://sepolia.etherscan.io/address/${TALLY_A}#code`;
const PAGE_B = `https://sepolia.etherscan.io/address/${TALLY_B}#code`;

describe("verify() of a Vyper contract on Etherscan v2 (R-BE-1, R-EXT-1, R-IN-3)", () => {
  it("derives the arguments, sends vyper-json, vyper:0.4.3 and optimizationUsed 1, and returns verified", async (t) => {
    const fake = replay(
      answer("getsourcecode-not-verified"),
      answer("getcontractcreation"),
      answer("verifysourcecode"),
      answer("checkverifystatus-pass"),
    );
    const { options, lines, events } = run(fake.fetch);
    const result = await drive(t, verify(tallyA(), options));
    assert.deepEqual(result, {
      status: "verified",
      backend: "etherscan-v2",
      match: "exact",
      explorerUrl: PAGE_A,
    });
    assert.equal(fake.calls.length, 4);
    // The submit is the recorded one, field for field, the key aside.
    const submit = fieldsOf(fake.calls[2]);
    assert.deepEqual(submit, sentFields("verifysourcecode", DUMMY_KEY));
    assert.equal(submit["codeformat"], "vyper-json");
    assert.equal(submit["compilerversion"], "vyper:0.4.3");
    assert.equal(submit["optimizationUsed"], "1");
    assert.equal(submit["constructorArguments"], ARGS_A);
    assert.equal(submit["constructorArguements"], ARGS_A);
    assert.ok(lines.some((line) => line.includes("Derived the constructor arguments")));
    assertNoKey(result, lines, events);
  });

  it("polls through Pending in queue to Pass - Verified", async (t) => {
    const fake = replay(
      answer("getsourcecode-not-verified"),
      answer("getcontractcreation"),
      answer("verifysourcecode"),
      answer("checkverifystatus-pending"),
      answer("checkverifystatus-pass"),
    );
    const { options, events } = run(fake.fetch);
    const result = await drive(t, verify(tallyA(), options));
    assert.equal(result.status, "verified");
    assert.equal(fake.calls.length, 5);
    assert.deepEqual(
      events.filter((event) => event.type === "verify.poll").map((event) => event.state),
      ["pending"],
    );
  });

  it("submits again while Etherscan has not indexed the contract (R-FLOW-7)", async (t) => {
    const fake = replay(
      answer("getsourcecode-not-verified"),
      answer("getcontractcreation"),
      answer("verifysourcecode-not-indexed"),
      answer("verifysourcecode"),
      answer("checkverifystatus-pass"),
    );
    const { options, events } = run(fake.fetch);
    const result = await drive(t, verify(tallyA(), options));
    assert.equal(result.status, "verified");
    assert.deepEqual(fieldsOf(fake.calls[2]), fieldsOf(fake.calls[3]));
    assert.ok(
      events.some((event) => event.type === "verify.retry" && event.reason === "not-indexed"),
    );
  });
});

describe("the Vyper form of the Etherscan client (decision 0078)", () => {
  const ctx = (fetch: typeof globalThis.fetch): Context => ({
    route: resolveRoute(SEPOLIA, { backend: "etherscan-v2" }, { apiKeys }),
    apiKeys: () => apiKeys,
    http: {
      backend: "etherscan-v2",
      fetch,
      secrets: [DUMMY_KEY],
      random: () => 0,
    },
  });
  const apiKeys = { "etherscan-v2": DUMMY_KEY };

  /** The fields of one submit of `input` with `settings`. */
  async function submitted(settings: Record<string, unknown>): Promise<Record<string, string>> {
    const base = inputFrom("verifysourcecode", TALLY_A);
    assert.ok(base.compiler.kind === "vyper");
    const input: VerifyInput = {
      ...base,
      compiler: {
        ...base.compiler,
        input: { ...base.compiler.input, settings },
      },
    };
    const fake = replay(answer("verifysourcecode"));
    const outcome = await etherscan.submit(input, ctx(fake.fetch));
    assert.equal(outcome.state, "submitted");
    return fieldsOf(fake.calls[0]);
  }

  it("sends optimizationUsed 0 for optimize none or false, and 1 otherwise", async () => {
    for (const [optimize, used] of [
      ["none", "0"],
      [false, "0"],
      ["gas", "1"],
      ["codesize", "1"],
      [true, "1"],
      [undefined, "1"],
      [null, "1"],
    ] as const) {
      const fields = await submitted(optimize === undefined ? {} : { optimize });
      assert.equal(fields["optimizationUsed"], used, String(optimize));
    }
  });

  it("sends the version before + with vyper:, for any release", async () => {
    const base = inputFrom("verifysourcecode", TALLY_A);
    assert.ok(base.compiler.kind === "vyper");
    const input: VerifyInput = {
      ...base,
      compiler: { ...base.compiler, version: "0.3.10+commit.91361694" },
    };
    const fake = replay(answer("verifysourcecode"));
    await etherscan.submit(input, ctx(fake.fetch));
    assert.equal(fieldsOf(fake.calls[0])["compilerversion"], "vyper:0.3.10");
  });

  it("keeps the solc form byte for byte: no optimizationUsed, the solidity codeformat", async () => {
    const input = validateInput({
      chainId: SEPOLIA,
      address: TALLY_A,
      contractName: "A.sol:A",
      compiler: {
        kind: "solc",
        version: "0.8.24+commit.e11b9ed9",
        input: {
          language: "Solidity",
          sources: { "A.sol": { content: "" } },
          settings: {},
        },
      },
    });
    const fake = replay(answer("verifysourcecode"));
    await etherscan.submit(input, ctx(fake.fetch));
    // The whole body, in order: the solc form, with no Vyper field.
    assert.equal(
      fake.calls[0]?.body,
      new URLSearchParams({
        module: "contract",
        action: "verifysourcecode",
        codeformat: "solidity-standard-json-input",
        sourceCode: '{"language":"Solidity","sources":{"A.sol":{"content":""}},"settings":{}}',
        contractaddress: TALLY_A,
        contractname: "A.sol:A",
        compilerversion: "v0.8.24+commit.e11b9ed9",
        apikey: DUMMY_KEY,
      }).toString(),
    );
  });

  for (const [name, text] of [
    ["verifysourcecode-no-optimization-used", "Missing OptimizationUsed"],
    ["verifysourcecode-long-version", "Invalid compiler version."],
  ] as const) {
    it(`reads the recorded refusal "${text}" as unexpected-response, with no key`, async () => {
      const fake = replay(answer(name));
      const error = await etherscan.submit(tallyA(), ctx(fake.fetch)).then(
        () => assert.fail("the submit resolved"),
        (caught: unknown) => caught,
      );
      assert.ok(error instanceof ExplorerVerifyError);
      assert.ok(error.details.code === "unexpected-response");
      assert.ok(error.details.excerpt.includes(text));
      assertNoKey(error.message, error.toJSON());
    });
  }
});

describe("a rejected Vyper source (R-FLOW-4, R-SEC-1)", () => {
  it("maps the recorded Fail text to failed with the explorer's text, keys redacted", async (t) => {
    const fake = replay(
      answer("getsourcecode-not-verified-b"),
      answer("verifysourcecode-wrong-source"),
      // The recorded text, with the key appended: it must not reach the result.
      answer("checkverifystatus-fail", (body) => {
        body["result"] = `${String(body["result"])} ${DUMMY_KEY}`;
      }),
      answer("getsourcecode-not-verified-b"),
    );
    const { options, lines, events } = run(fake.fetch);
    const result = await drive(t, verify(tallyB(true), options));
    assert.equal(result.status, "failed");
    assert.ok(result.status === "failed");
    assert.equal(result.reasonCode, "bytecode-mismatch");
    assert.ok(result.reason.startsWith(MISMATCH));
    assert.equal(fieldsOf(fake.calls[1])["compilerversion"], "vyper:0.4.3");
    assertNoKey(result, lines, events);
  });
});

describe("the stored Vyper contract (R-FLOW-1, decision 0063)", () => {
  it("reads TallyA's verified lookup, vyper:0.4.3, as this contract: already-verified, no submit", async (t) => {
    const fake = replay(answer("getsourcecode-verified"));
    const { options } = run(fake.fetch);
    const result = await drive(t, verify(tallyA(), options));
    assert.deepEqual(result, {
      status: "already-verified",
      backend: "etherscan-v2",
      match: "exact",
      explorerUrl: PAGE_A,
    });
    assert.equal(fake.calls.length, 1);
  });

  it("reads the Similar Match lookup of TallyB, naming TallyA, as another contract, and submits", async (t) => {
    const fake = replay(
      answer("getsourcecode-similar-match"),
      answer("handler-verifysourcecode"),
      answer("handler-checkverifystatus-pass"),
    );
    const { options, lines } = run(fake.fetch);
    const result = await drive(t, verify(tallyB(), options));
    assert.deepEqual(result, {
      status: "verified",
      backend: "etherscan-v2",
      match: "exact",
      explorerUrl: PAGE_B,
    });
    assert.ok(lines.some((line) => line.includes("(TallyA, vyper:0.4.3)")));
  });

  it("gives the lookups' grade, name and version", async () => {
    const apiKeys = { "etherscan-v2": DUMMY_KEY };
    for (const [name, match] of [
      ["getsourcecode-verified", "exact"],
      ["getsourcecode-similar-match", "partial"],
    ] as const) {
      const fake = replay(answer(name));
      const found = await etherscan.lookup(
        { chainId: SEPOLIA, address: TALLY_B },
        {
          route: resolveRoute(SEPOLIA, { backend: "etherscan-v2" }, { apiKeys }),
          apiKeys: () => apiKeys,
          http: {
            backend: "etherscan-v2",
            fetch: fake.fetch,
            secrets: [DUMMY_KEY],
          },
        },
      );
      assert.deepEqual(found, {
        match,
        name: "TallyA",
        compilerVersion: "vyper:0.4.3",
      });
      assert.equal(
        otherContract({ name: "TallyA", compilerVersion: "vyper:0.4.3" }, tallyA()),
        undefined,
      );
      assert.deepEqual(
        otherContract({ name: "TallyA", compilerVersion: "vyper:0.4.3" }, tallyB()),
        { name: "TallyA", compilerVersion: "vyper:0.4.3" },
      );
    }
  });
});

/** The form of TallyB's submit as the client sends it to the handler: no key. */
function handlerForm(change: Record<string, string> = {}): URLSearchParams {
  const { apikey, ...fields } = recorded("handler-verifysourcecode").request.body.fields;
  assert.equal(apikey, "[redacted]");
  return new URLSearchParams({ ...fields, ...change });
}

function post(body: URLSearchParams): Request {
  return new Request(`${HANDLER}?chainid=${String(SEPOLIA)}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

/** A handler with the recorded upstream answers, and the lines it logged. */
function handlerWith(...steps: Response[]): {
  handler: (request: Request) => Promise<Response>;
  upstream: ReturnType<typeof replay>;
  lines: string[];
} {
  const upstream = replay(...steps);
  const lines: string[] = [];
  const log = (message: string, fields?: unknown): void => {
    lines.push(`${message} ${JSON.stringify(fields)}`);
  };
  const handler = createVerifyHandler({
    apiKey: DUMMY_KEY,
    chains: [SEPOLIA],
    deployers: [DEPLOYER],
    fetch: upstream.fetch,
    logger: { debug: log, info: log, warn: log, error: log },
  });
  return { handler, upstream, lines };
}

/** Answers every request with a 400 the clients do not read: only the backends that ran matter. */
const refuse: typeof fetch = async () => await Promise.resolve(new Response("{}", { status: 400 }));

/** A submit answer with a job id. */
function jobAnswer(): Response {
  return new Response(JSON.stringify({ status: "1", message: "OK", result: "abc123" }));
}

describe("Vyper through createVerifyHandler (R-SRV-3, R-SRV-5, R-SEC-1)", () => {
  it("forwards the Vyper lookup, submit and poll, and verify() returns verified", async (t) => {
    const { handler, upstream, lines } = handlerWith(
      answer("handler-getcontractcreation"),
      answer("getsourcecode-similar-match"),
      answer("handler-getcontractcreation"),
      answer("handler-verifysourcecode"),
      answer("handler-checkverifystatus-pass"),
    );
    const sent: Record<string, string>[] = [];
    const toHandler: typeof fetch = async (target, init) => {
      const request = new Request(target instanceof Request ? target : String(target), init);
      sent.push(Object.fromEntries(new URLSearchParams(await request.clone().text())));
      return await handler(request);
    };
    const result = await drive(
      t,
      verify(tallyB(), {
        fetch: toHandler,
        handlerUrl: HANDLER,
        pollIntervalMs: 1_000,
      }),
    );
    assert.deepEqual(result, {
      status: "verified",
      backend: "etherscan-v2",
      match: "exact",
      explorerUrl: PAGE_B,
    });
    assert.deepEqual(
      sent.map((fields) => fields["action"]),
      ["getsourcecode", "verifysourcecode", "checkverifystatus"],
    );
    for (const fields of sent) {
      assert.equal(Object.hasOwn(fields, "apikey"), false);
    }
    assert.equal(sent[1]?.["optimizationUsed"], "1");
    // The forwarded submit is the recorded one, field for field: the handler adds the key.
    assert.deepEqual(
      fieldsOf(upstream.calls[3]),
      sentFields("handler-verifysourcecode", DUMMY_KEY),
    );
    assertNoKey(lines);
  });

  it("forwards vyper:<x.y.z>, a solc version, and optimizationUsed 0 or 1", async () => {
    for (const change of [
      { compilerversion: "vyper:0.3.10" },
      { compilerversion: "vyper:9999.0.0" },
      {
        compilerversion: "v0.8.24+commit.e11b9ed9",
        codeformat: "solidity-standard-json-input",
      },
      { optimizationUsed: "0" },
    ]) {
      const { handler, upstream } = handlerWith(
        answer("handler-getcontractcreation"),
        answer("handler-verifysourcecode"),
      );
      const response = await handler(post(handlerForm(change)));
      assert.equal(response.status, 200, JSON.stringify(change));
      const forwarded = fieldsOf(upstream.calls[1]);
      for (const [name, value] of Object.entries(change)) {
        assert.equal(forwarded[name], value);
      }
    }
  });

  it("refuses a version of neither form, a bad optimizationUsed and an unlisted field, with no request and no key", async () => {
    const refusals: [Record<string, string>, RegExp][] = [
      [{ compilerversion: "vyper:0.4.3+commit.bff19ea2" }, /Invalid fields: compilerversion/],
      [{ compilerversion: "vyper:v0.5.0b1" }, /Invalid fields: compilerversion/],
      [{ compilerversion: "vyper:0.4.3rc1" }, /Invalid fields: compilerversion/],
      [{ compilerversion: "vyper:0.4" }, /Invalid fields: compilerversion/],
      [{ compilerversion: "vyper:00.4.3" }, /Invalid fields: compilerversion/],
      [{ compilerversion: "vyper:0.04.3" }, /Invalid fields: compilerversion/],
      [{ compilerversion: "vyper:0.4.03" }, /Invalid fields: compilerversion/],
      [{ compilerversion: "vyper:10000.0.0" }, /Invalid fields: compilerversion/],
      [{ compilerversion: `vyper:${"1".repeat(5000)}.0.0` }, /Invalid fields: compilerversion/],
      [{ compilerversion: "Vyper:0.4.3" }, /Invalid fields: compilerversion/],
      [{ compilerversion: "vyper:" }, /Invalid fields: compilerversion/],
      [{ compilerversion: " vyper:0.4.3" }, /Invalid fields: compilerversion/],
      [{ optimizationUsed: "2" }, /Invalid fields: optimizationUsed/],
      [{ optimizationUsed: "01" }, /Invalid fields: optimizationUsed/],
      [{ optimizationUsed: "true" }, /Invalid fields: optimizationUsed/],
      [{ runs: "0" }, /1 field that verifysourcecode does not take/],
      [{ optimizationused: "1" }, /1 field that verifysourcecode does not take/],
    ];
    for (const [change, message] of refusals) {
      const { handler, upstream, lines } = handlerWith();
      const response = await handler(post(handlerForm(change)));
      const text = await response.text();
      assert.equal(response.status, 400, JSON.stringify(change));
      assert.match(text, message);
      assert.deepEqual(upstream.calls, []);
      assertNoKey(text, lines);
    }
  });
});

describe("the Vyper routes (R-EXT-1, decisions 0077 and 0078)", () => {
  it("lists Sourcify and Etherscan v2 on every chain", () => {
    assert.deepEqual(VYPER_ROUTES, [
      ["sourcify", "every"],
      ["etherscan-v2", "every"],
    ]);
    for (const chainId of [1, SEPOLIA, 324, 999999]) {
      const check = kindCheck("vyper", chainId);
      assert.equal(check.verifies("etherscan-v2"), true);
      assert.equal(check.verifies("sourcify"), true);
      for (const backend of ["blockscout", "routescan", "etherscan-compatible"] as const) {
        assert.equal(check.verifies(backend), false);
      }
    }
  });

  it("keeps a chain list in an override", () => {
    const routes = { vyper: [["etherscan-v2", [1]]] } as const;
    assert.equal(kindCheck("vyper", 1, routes).verifies("etherscan-v2"), true);
    assert.throws(() => kindCheck("vyper", SEPOLIA, routes), ExplorerVerifyError);
    assert.equal(
      kindCheck("vyper", 5, { vyper: [["sourcify", "every"]] }).verifies("sourcify"),
      true,
    );
  });

  it("routes Vyper input on Sepolia to Etherscan v2, first in the row, when its key is set", async () => {
    const fake = replay(answer("getsourcecode-verified"));
    const result = await dryRun(tallyA(), {
      fetch: fake.fetch,
      apiKeys: { "etherscan-v2": DUMMY_KEY },
    });
    assert.equal(result.backend, "etherscan-v2");
    assert.equal(fake.calls.length, 1);
  });

  for (const route of [
    { backend: "routescan" },
    {
      backend: "routescan",
      apiUrl: "https://api.routescan.io/v2/network/testnet/evm/11155111/etherscan/api",
    },
    {
      backend: "etherscan-compatible",
      apiUrl: "https://explorer.example.org/api",
      apiKey: DUMMY_KEY,
    },
  ] as const) {
    it(`still refuses Vyper input on ${route.backend}${"apiUrl" in route ? " with apiUrl" : ""}, before any request`, async () => {
      for (const call of [verify, dryRun]) {
        const fake = replay();
        const error = await call(tallyA(), { fetch: fake.fetch, route }).then(
          () => assert.fail("resolved"),
          (caught: unknown) => caught,
        );
        assert.ok(ExplorerVerifyError.is(error, "unsupported-compiler"));
        assert.match(
          error.message,
          new RegExp(`The ${route.backend} backend does not verify vyper input`),
        );
        assert.deepEqual(fake.calls, []);
        assertNoKey(error.toJSON(), error.message);
      }
    });
  }

  it("routes Vyper input on Sepolia to Sourcify without an Etherscan key", async () => {
    // Sourcify's recorded "not verified" answer, for TallyA's address.
    const { response } = loadFixture("sourcify", "2026-11-19-vyper-lookup-not-verified");
    const recordedBody: unknown = response.body;
    assert.ok(typeof recordedBody === "object" && recordedBody !== null);
    const body = { ...recordedBody, address: TALLY_A };
    const fake = replay(new Response(JSON.stringify(body), { status: response.status }));
    const result = await dryRun(tallyA(), { fetch: fake.fetch });
    assert.equal(result.backend, "sourcify");
    assert.ok(fake.calls[0]?.url.startsWith("https://sourcify.dev/"));
  });

  it("verifyEach() with every backend: Sourcify alone without a key, both with one, a refusal per backend on a row with neither", async () => {
    const keyless = await verifyEach(tallyA(), { fetch: refuse, backends: "all" });
    assert.deepEqual(
      keyless.outcomes.map((outcome) => outcome.backend),
      ["sourcify"],
    );
    const keyed = await verifyEach(tallyA(), {
      fetch: refuse,
      backends: "all",
      apiKeys: { "etherscan-v2": DUMMY_KEY },
    });
    assert.deepEqual(
      keyed.outcomes.map((outcome) => outcome.backend),
      ["etherscan-v2", "sourcify"],
    );
    const fake = replay();
    const neither = await verifyEach(
      { ...tallyA(), chainId: 151 },
      { fetch: fake.fetch, backends: "all" },
    );
    assert.deepEqual(
      neither.outcomes.map((outcome) => [outcome.backend, outcome.error?.code]),
      [["routescan", "unsupported-compiler"]],
    );
    assert.deepEqual(fake.calls, []);
  });

  it("refuses Vyper input on a chain whose row lists neither Sourcify nor Etherscan v2", async () => {
    const fake = replay();
    const input = { ...tallyA(), chainId: 151 };
    await assert.rejects(verify(input, { fetch: fake.fetch }), (error: unknown) =>
      ExplorerVerifyError.is(error, "unsupported-compiler"),
    );
    assert.deepEqual(fake.calls, []);
  });

  it("keeps the Routescan and Etherscan-compatible clients on the solc form", async () => {
    for (const [backend, route] of [
      [routescan, resolveRoute(43113, { backend: "routescan" })],
      [
        etherscanCompatible,
        resolveRoute(SEPOLIA, {
          backend: "etherscan-compatible",
          apiUrl: "https://x.example/api",
        }),
      ],
    ] as const) {
      const fake = replay(jobAnswer());
      await backend.submit(tallyA(), {
        route,
        apiKeys: () => ({}),
        http: {
          backend: backend.name,
          fetch: fake.fetch,
          secrets: [],
          random: () => 0,
        },
      });
      const fields = fieldsOf(fake.calls[0]);
      assert.equal(fields["codeformat"], "solidity-standard-json-input");
      assert.equal(Object.hasOwn(fields, "optimizationUsed"), false);
    }
  });
});
