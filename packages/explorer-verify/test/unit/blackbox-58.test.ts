// Black-box tests for issue #58: per-backend API keys bound to their hosts. They use only the
// issue, docs/user/reference/api-keys.md, the three new error pages, verify.md, json-output.md,
// check-status.md, llms.txt, the skill and the TSDoc of `VerifyOptions.apiKeys` and
// `RouteOverride.apiKey`. Every call goes through the package entry point with a fake `fetch`
// shaped like Sourcify's answers. Time runs on node:test mock timers.
//
// The tests run on chain 31, whose routing table row lists Sourcify only, which takes no key. So
// they check that a key is validated, never sent, and never shows up anywhere the caller can see.
// (Chain 11155111 lists Etherscan v2 first since #122, so a key goes to Etherscan there.)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { inspect } from "node:util";

import { Ajv2020 } from "ajv/dist/2020.js";

import { ERROR_EXIT_CODES, exitCodeOf, toEnvelope } from "../../src/envelope.ts";
import type { VerifyOutcome } from "../../src/envelope.ts";
import {
  ERROR_CODES,
  ERROR_HINTS,
  ExplorerVerifyError,
  checkStatus,
  verify,
} from "../../src/index.ts";
import type {
  ErrorCode,
  Handle,
  Hex,
  LogFields,
  Logger,
  RouteOverride,
  VerifyEvent,
  VerifyInput,
  VerifyOptions,
  VerifyResult,
} from "../../src/index.ts";
import { docsUrlOf } from "../helpers/docs-url.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";

// Lower-case dummy keys: no generic redaction rule (34-char upper-case shape, key-like parameter
// names) matches them, so only the library's knowledge of `apiKeys` can remove them.
const ETHERSCAN_KEY = "zz9dummyetherscankeyqq7xv";
const ROUTESCAN_KEY = "rr4dummyroutescankeyww2pl";
const ROUTE_KEY = "ss8dummystandalonekeyyy3m";
const KEYS = [ETHERSCAN_KEY, ROUTESCAN_KEY, ROUTE_KEY];

const CHAIN_ID = 31;
const ADDRESS: Hex = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const JOB_ID = "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718";
const NEW_CODES = ["missing-api-key", "api-key-rejected", "quota-exceeded"] as const;

const REPO = new URL("../../../../", import.meta.url);

function readRepo(path: string): string {
  return readFileSync(new URL(path, REPO), "utf8");
}

function makeInput(): VerifyInput {
  return {
    chainId: CHAIN_ID,
    address: ADDRESS,
    compiler: {
      kind: "solc",
      version: "0.8.24+commit.e11b9ed9",
      input: {
        language: "Solidity",
        sources: { "contracts/Tiny.sol": { content: "contract Tiny {}" } },
        settings: { optimizer: { enabled: false, runs: 200 } },
      },
    },
    contractName: "contracts/Tiny.sol:Tiny",
  };
}

function makeHandle(overrides: Partial<Handle> = {}): Handle {
  return {
    version: 1,
    backend: "sourcify",
    chainId: CHAIN_ID,
    address: ADDRESS,
    jobId: JOB_ID,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// Mock time.

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
});

afterEach(() => {
  mock.timers.reset();
});

/** Runs every pending mock timer after each real turn until `pending` settles. */
function drive<T>(pending: Promise<T>): Promise<T> {
  void driveMockClock(pending, () => {
    mock.timers.runAll();
  });
  return pending;
}

async function outcomeOf(promise: Promise<VerifyResult>): Promise<VerifyOutcome> {
  try {
    return await drive(promise);
  } catch (error) {
    if (error instanceof ExplorerVerifyError) {
      return error;
    }
    throw error;
  }
}

async function errorOf(promise: Promise<VerifyResult>): Promise<ExplorerVerifyError> {
  const outcome = await outcomeOf(promise);
  if (!(outcome instanceof ExplorerVerifyError)) {
    assert.fail(`expected an error, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

// ---------------------------------------------------------------------------------------------
// Fake fetch with Sourcify-shaped answers.

type Step = "lookup" | "submit" | "status";

interface Call {
  readonly step: Step;
  readonly method: string;
  readonly url: string;
  readonly body: string;
  readonly headers: string;
}

interface Reply {
  readonly status?: number;
  readonly body?: unknown;
  readonly networkError?: string;
}

type Script = Partial<Record<Step, readonly Reply[]>>;

function stepOf(method: string, path: string): Step {
  if (method === "GET" && /\/v2\/contract\/\d+\/0x[0-9a-fA-F]{40}$/u.test(path)) {
    return "lookup";
  }
  if (method === "POST" && /\/v2\/verify\/\d+\/0x[0-9a-fA-F]{40}$/u.test(path)) {
    return "submit";
  }
  if (method === "GET" && /\/v2\/verify\/[^/]+$/u.test(path)) {
    return "status";
  }
  throw new Error(`unexpected request ${method} ${path}`);
}

function headerText(headers: HeadersInit | undefined): string {
  return JSON.stringify([...new Headers(headers).entries()]);
}

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

function fakeFetch(script: Script): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const used: Record<Step, number> = { lookup: 0, submit: 0, status: 0 };
  const fn: typeof fetch = async (target, init) => {
    const url = target instanceof Request ? target.url : String(target);
    const method = (
      target instanceof Request ? target.method : (init?.method ?? "GET")
    ).toUpperCase();
    const step = stepOf(method, new URL(url).pathname);
    calls.push({
      step,
      method,
      url,
      body: target instanceof Request ? await target.clone().text() : bodyText(init?.body),
      headers: headerText(target instanceof Request ? target.headers : init?.headers),
    });
    const replies = script[step] ?? [];
    const reply = replies[Math.min(used[step], replies.length - 1)];
    used[step] += 1;
    if (reply === undefined) {
      throw new Error(`no reply scripted for ${step}`);
    }
    if (reply.networkError !== undefined) {
      throw new TypeError(reply.networkError);
    }
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };
  return { fetch: fn, calls };
}

type WireMatch = "exact_match" | "match" | null;

function lookup(match: WireMatch): Reply {
  return {
    status: match === null ? 404 : 200,
    body: {
      match,
      creationMatch: match,
      runtimeMatch: match,
      chainId: String(CHAIN_ID),
      address: ADDRESS,
      ...(match === null ? {} : { verifiedAt: "2026-11-03T10:00:00Z", matchId: "1" }),
    },
  };
}

const ACCEPTED: Reply = { status: 202, body: { verificationId: JOB_ID } };

function job(completed: boolean, match: WireMatch, error?: object): Reply {
  return {
    status: 200,
    body: {
      isJobCompleted: completed,
      verificationId: JOB_ID,
      jobStartTime: "2026-11-03T10:00:00Z",
      contract: {
        match,
        creationMatch: match,
        runtimeMatch: match,
        chainId: String(CHAIN_ID),
        address: ADDRESS,
      },
      ...(error === undefined ? {} : { error }),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Observers.

interface Seen {
  logger: Logger;
  onEvent: (event: VerifyEvent) => void;
  lines: { level: string; message: string; fields: LogFields | undefined }[];
  events: VerifyEvent[];
}

function observer(): Seen {
  const lines: Seen["lines"] = [];
  const events: VerifyEvent[] = [];
  const at =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      lines.push({ level, message, fields });
    };
  return {
    lines,
    events,
    logger: {
      debug: at("debug"),
      info: at("info"),
      warn: at("warn"),
      error: at("error"),
    },
    onEvent: (event) => {
      events.push(event);
    },
  };
}

function strictValidator(schema: unknown): (value: unknown) => string[] {
  if (typeof schema !== "object" || schema === null) {
    throw new TypeError("schema must be an object");
  }
  const compiled = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  return (value) =>
    compiled(value)
      ? []
      : (compiled.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ""}`);
}

const validateEnvelope = strictValidator(
  JSON.parse(readFileSync(new URL("../../schema/envelope.schema.json", import.meta.url), "utf8")),
);

/** Every text a caller can see from one call: requests, log lines, events, the outcome. */
function everything(
  outcome: VerifyOutcome | ExplorerVerifyError,
  seen: Seen,
  calls: readonly Call[],
): string {
  const parts: string[] = [];
  for (const call of calls) {
    parts.push(call.url, call.body, call.headers);
  }
  parts.push(inspect(seen.lines, { depth: 10 }), JSON.stringify(seen.lines));
  parts.push(inspect(seen.events, { depth: 10 }), JSON.stringify(seen.events));
  parts.push(JSON.stringify(toEnvelope(outcome)));
  if (outcome instanceof ExplorerVerifyError) {
    parts.push(
      outcome.message,
      outcome.hint,
      String(outcome.stack),
      JSON.stringify(outcome),
      JSON.stringify(outcome.toJSON()),
      JSON.stringify(outcome.details),
      inspect(outcome, { depth: 10 }),
      inspect(outcome.cause, { depth: 10 }),
    );
  } else {
    parts.push(JSON.stringify(outcome), inspect(outcome, { depth: 10 }));
  }
  return parts.join("\n");
}

function assertNoKey(text: string, keys: readonly string[] = KEYS): void {
  for (const key of keys) {
    assert.ok(!text.includes(key), `key ${key.slice(0, 4)}… leaked`);
    assert.ok(
      !text.toLowerCase().includes(key.toLowerCase()),
      `key ${key.slice(0, 4)}… leaked, other case`,
    );
    assert.ok(!text.includes(encodeURIComponent(key)), `key ${key.slice(0, 4)}… leaked, encoded`);
  }
}

function withOption(base: VerifyOptions, name: string, value: unknown): VerifyOptions {
  const options: VerifyOptions = { ...base };
  Reflect.set(options, name, value);
  return options;
}

function apiKeysOf(value: unknown, base: VerifyOptions = {}): VerifyOptions {
  return withOption(base, "apiKeys", value);
}

function routeWithKey(route: RouteOverride, apiKey: unknown): RouteOverride {
  const copy: RouteOverride = { ...route };
  Reflect.set(copy, "apiKey", apiKey);
  return copy;
}

function issueFields(error: ExplorerVerifyError): string[] {
  return error.details.code === "invalid-input"
    ? error.details.issues.map((issue) => issue.field)
    : [];
}

/** Asserts the call threw invalid-input naming `field`, sent nothing and never echoed `secret`. */
async function assertRefused(
  run: (options: VerifyOptions) => Promise<VerifyResult>,
  options: VerifyOptions,
  field: string | RegExp,
  secret?: string,
): Promise<ExplorerVerifyError> {
  const seen = observer();
  const fake = fakeFetch({ lookup: [lookup("exact_match")] });
  const error = await errorOf(
    run({
      ...options,
      fetch: fake.fetch,
      logger: seen.logger,
      onEvent: seen.onEvent,
    }),
  );
  assert.equal(error.code, "invalid-input");
  assert.equal(exitCodeOf(error), 2);
  assert.equal(fake.calls.length, 0, "nothing is sent");
  const fields = issueFields(error);
  assert.ok(
    fields.some((f) => (typeof field === "string" ? f === field : field.test(f))),
    `issues name ${String(field)}: ${JSON.stringify(fields)}`,
  );
  if (secret !== undefined && secret.length > 0) {
    assertNoKey(everything(error, seen, fake.calls), [secret]);
  }
  return error;
}

const runVerify = (options: VerifyOptions): Promise<VerifyResult> => verify(makeInput(), options);
const runCheck = (options: VerifyOptions): Promise<VerifyResult> =>
  checkStatus(makeHandle(), options);

// ---------------------------------------------------------------------------------------------

describe("apiKeys: accepted backends (api-keys.md table, TSDoc)", () => {
  for (const [backend, key] of [
    ["etherscan-v2", ETHERSCAN_KEY],
    ["routescan", ROUTESCAN_KEY],
  ] as const) {
    it(`accepts apiKeys["${backend}"] and still verifies a Sourcify-routed chain without sending it`, async () => {
      const seen = observer();
      const fake = fakeFetch({ lookup: [lookup("exact_match")] });
      const outcome = await outcomeOf(
        verify(makeInput(), {
          apiKeys: { [backend]: key },
          fetch: fake.fetch,
          logger: seen.logger,
          onEvent: seen.onEvent,
        }),
      );
      assert.ok(!(outcome instanceof ExplorerVerifyError), "no error");
      assert.equal(outcome.status, "already-verified");
      assert.equal(fake.calls.length, 1);
      assertNoKey(everything(outcome, seen, fake.calls));
    });
  }

  it("accepts both keys at once and an undefined value as absent", async () => {
    const fake = fakeFetch({ lookup: [lookup("exact_match")] });
    const result = await drive(
      // The type forbids `routescan: undefined` under exactOptionalPropertyTypes, though the
      // docs accept it at run time; Reflect sets it without a cast.
      verify(
        makeInput(),
        apiKeysOf({ "etherscan-v2": ETHERSCAN_KEY, routescan: undefined }, { fetch: fake.fetch }),
      ),
    );
    assert.equal(result.status, "already-verified");
    const both = await drive(
      verify(makeInput(), {
        apiKeys: { "etherscan-v2": ETHERSCAN_KEY, routescan: ROUTESCAN_KEY },
        fetch: fakeFetch({ lookup: [lookup("exact_match")] }).fetch,
      }),
    );
    assert.equal(both.status, "already-verified");
  });

  it("accepts apiKeys: undefined and an empty object", async () => {
    for (const options of [apiKeysOf(undefined), { apiKeys: {} }]) {
      const fake = fakeFetch({ lookup: [lookup("exact_match")] });
      const result = await drive(verify(makeInput(), { ...options, fetch: fake.fetch }));
      assert.equal(result.status, "already-verified");
    }
  });

  it("accepts apiKeys in checkStatus() and polls without sending the key", async () => {
    const seen = observer();
    const fake = fakeFetch({ status: [job(true, "exact_match")] });
    const outcome = await outcomeOf(
      checkStatus(makeHandle(), {
        apiKeys: { "etherscan-v2": ETHERSCAN_KEY, routescan: ROUTESCAN_KEY },
        fetch: fake.fetch,
        logger: seen.logger,
        onEvent: seen.onEvent,
      }),
    );
    assert.ok(!(outcome instanceof ExplorerVerifyError));
    assert.equal(outcome.status, "verified");
    assertNoKey(everything(outcome, seen, fake.calls));
  });
});

describe("apiKeys: refused backends (api-keys.md table, TSDoc)", () => {
  for (const backend of ["etherscan-compatible", "sourcify", "blockscout"] as const) {
    for (const [name, run] of [
      ["verify", runVerify],
      ["checkStatus", runCheck],
    ] as const) {
      it(`${name}: apiKeys["${backend}"] throws invalid-input naming apiKeys.${backend}, without the value`, async () => {
        await assertRefused(
          run,
          { apiKeys: { [backend]: ETHERSCAN_KEY } },
          `apiKeys.${backend}`,
          ETHERSCAN_KEY,
        );
      });
    }
  }
});

describe("apiKeys: value rules (api-keys.md: 8 to 1024 letters, digits, '.', '_', '~' or '-')", () => {
  const ok: [string, string][] = [
    ["8 characters", "abcd1234"],
    ["1024 characters", "k".repeat(1024)],
    ["the unreserved punctuation", "dummy.key_val~ue-7z"],
    ["a UUID-style key", "550e8400-e29b-41d4-a716-446655440000"],
  ];
  for (const [label, value] of ok) {
    it(`accepts ${label}`, async () => {
      const fake = fakeFetch({ lookup: [lookup("exact_match")] });
      const result = await drive(
        verify(makeInput(), {
          apiKeys: { "etherscan-v2": value },
          fetch: fake.fetch,
        }),
      );
      assert.equal(result.status, "already-verified");
      assertNoKey(fake.calls.map((c) => `${c.url}${c.body}${c.headers}`).join(""), [value]);
    });
  }

  const bad: [string, unknown][] = [
    ["an empty string", ""],
    ["7 characters", "abc1234"],
    ["1025 characters", "k".repeat(1025)],
    ["a space", "dummykey withspace01"],
    ["a leading space", " dummykeyleading01"],
    ["a trailing newline", "dummykeytrailing01\n"],
    ["a tab", "dummy\tkeywithtab01"],
    ["a NUL", "dummy\u0000keywithnul1"],
    ["DEL", "dummy\u007fkeywithdel1"],
    ["a C1 control", "dummy\u0085keywithc101"],
    ["a no-break space", "dummy keywithnbsp1"],
    ["a line separator", "dummy keywithls01"],
    ["URL-special characters", "dummy+key/val=ue%7Ez"],
    ["an ampersand", "dummykey&amp01"],
    ["a less-than sign", "dummykey<lt0001"],
    ["a double quote", 'dummykey"quote01'],
    ["a slash", "dummykey/slash01"],
    ["a non-ASCII letter", "dummykeyéaccent01"],
    ["only digits", "123456789012"],
    ["a number", 12345678901],
    ["null", null],
    ["a boolean", true],
    ["a String object", new String("dummykeyobject0001")],
    ["an object", { key: "dummykeyinobject01" }],
  ];
  for (const [label, value] of bad) {
    for (const [name, run] of [
      ["verify", runVerify],
      ["checkStatus", runCheck],
    ] as const) {
      it(`${name}: refuses ${label} and never echoes it`, async () => {
        const secret = typeof value === "string" ? value.trim() : undefined;
        await assertRefused(
          run,
          apiKeysOf({ "etherscan-v2": value }),
          "apiKeys.etherscan-v2",
          secret,
        );
      });
    }
  }

  it("never echoes either part of a key that holds a space", async () => {
    const error = await assertRefused(
      runVerify,
      { apiKeys: { routescan: "firstpartqq1 secondpartqq2" } },
      "apiKeys.routescan",
    );
    const text = `${JSON.stringify(error)}${error.message}${JSON.stringify(error.details)}${inspect(error)}`;
    assert.ok(!text.includes("firstpartqq1"));
    assert.ok(!text.includes("secondpartqq2"));
  });

  for (const [label, value] of [
    ["a piece of the contract address", "8275d36f"],
    ["the backend name in the handle", "SOURCIFY"],
  ] as const) {
    for (const [name, run] of [
      ["verify", runVerify],
      ["checkStatus", runCheck],
    ] as const) {
      it(`${name}: refuses a key that is ${label}, which redaction would corrupt`, async () => {
        await assertRefused(run, { apiKeys: { routescan: value } }, "apiKeys.routescan");
      });
    }
  }

  it("names each bad backend in its own issue", async () => {
    const error = await assertRefused(
      runVerify,
      { apiKeys: { "etherscan-v2": "short", routescan: "has space in it" } },
      "apiKeys.etherscan-v2",
    );
    assert.ok(issueFields(error).includes("apiKeys.routescan"), JSON.stringify(issueFields(error)));
  });
});

describe("apiKeys: object rules (api-keys.md, verify.md)", () => {
  const notPlain: [string, unknown][] = [
    ["null", null],
    ["a string", ETHERSCAN_KEY],
    ["a number", 42],
    ["an array", [ETHERSCAN_KEY]],
    ["a Map", new Map([["etherscan-v2", ETHERSCAN_KEY]])],
    [
      "a class instance",
      new (class Keys {
        "etherscan-v2" = ETHERSCAN_KEY;
      })(),
    ],
    ["a function", () => ETHERSCAN_KEY],
    ["a Date", new Date(0)],
  ];
  for (const [label, value] of notPlain) {
    it(`refuses apiKeys as ${label}, naming apiKeys`, async () => {
      await assertRefused(runVerify, apiKeysOf(value), /^apiKeys/u, ETHERSCAN_KEY);
    });
  }

  it("counts a field that is not a backend name in an apiKeys issue and never names it", async () => {
    const fieldName = "my-secret-field-name-zq9";
    const error = await assertRefused(
      runVerify,
      apiKeysOf({ [fieldName]: ETHERSCAN_KEY }),
      "apiKeys",
      ETHERSCAN_KEY,
    );
    const text = `${JSON.stringify(error)}${error.message}${JSON.stringify(error.details)}${inspect(error, { depth: 10 })}`;
    assert.ok(!text.includes(fieldName), "the field name is not repeated");
  });

  it("never names a field that looks like a key, even next to a valid key", async () => {
    const fieldName = "UNKNOWNFIELDKEY123lowercase";
    const error = await assertRefused(
      runVerify,
      apiKeysOf({
        "etherscan-v2": ETHERSCAN_KEY,
        [fieldName]: "whatever-value-1",
      }),
      "apiKeys",
    );
    assert.ok(!inspect(error, { depth: 10 }).includes(fieldName));
    assert.ok(!JSON.stringify(error.details).includes(fieldName));
  });

  it("reads each own property once", async () => {
    const reads = { count: 0 };
    const keys = {};
    Object.defineProperty(keys, "etherscan-v2", {
      enumerable: true,
      get: () => {
        reads.count += 1;
        return ETHERSCAN_KEY;
      },
    });
    const fake = fakeFetch({ lookup: [lookup("exact_match")] });
    const result = await drive(verify(makeInput(), apiKeysOf(keys, { fetch: fake.fetch })));
    assert.equal(result.status, "already-verified");
    assert.equal(reads.count, 1);
  });

  it("throws invalid-input, before any request, when a property cannot be read", async () => {
    const keys = {};
    Object.defineProperty(keys, "etherscan-v2", {
      enumerable: true,
      get: () => {
        throw new Error(`getter broke ${ETHERSCAN_KEY}`);
      },
    });
    await assertRefused(runVerify, apiKeysOf(keys), /^apiKeys/u, ETHERSCAN_KEY);
  });

  it("refuses an apiKeys Proxy whose ownKeys trap throws", async () => {
    const keys = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error(`trap ${ETHERSCAN_KEY}`);
        },
      },
    );
    await assertRefused(runVerify, apiKeysOf(keys), /^apiKeys/u, ETHERSCAN_KEY);
  });

  // verify.md names no field for an unreadable option; the options reader reports "options".
  it("throws invalid-input when the apiKeys option itself cannot be read", async () => {
    const fake = fakeFetch({ lookup: [lookup("exact_match")] });
    const options: VerifyOptions = { fetch: fake.fetch };
    Object.defineProperty(options, "apiKeys", {
      enumerable: true,
      get: () => {
        throw new Error(`option broke ${ETHERSCAN_KEY}`);
      },
    });
    const error = await errorOf(verify(makeInput(), options));
    assert.equal(error.code, "invalid-input");
    assert.ok(
      issueFields(error).some((field) => field === "options" || field.startsWith("apiKeys")),
      JSON.stringify(issueFields(error)),
    );
    assert.equal(fake.calls.length, 0);
    assertNoKey(inspect(error, { depth: 10 }) + JSON.stringify(error), [ETHERSCAN_KEY]);
  });
});

describe("route.apiKey (api-keys.md, TSDoc)", () => {
  for (const [name, run] of [
    ["verify", runVerify],
    ["checkStatus", runCheck],
  ] as const) {
    it(`${name}: route.apiKey on the default Sourcify route throws invalid-input naming route.apiKey`, async () => {
      await assertRefused(run, { route: { apiKey: ROUTE_KEY } }, "route.apiKey", ROUTE_KEY);
    });

    it(`${name}: route.apiKey on a sourcify override throws invalid-input naming route.apiKey`, async () => {
      await assertRefused(
        run,
        {
          route: {
            backend: "sourcify",
            apiUrl: "https://sourcify.example.org/server",
            apiKey: ROUTE_KEY,
          },
        },
        "route.apiKey",
        ROUTE_KEY,
      );
    });
  }

  it("accepts route.apiKey: undefined as absent", async () => {
    const fake = fakeFetch({ lookup: [lookup("exact_match")] });
    const result = await drive(
      verify(makeInput(), {
        route: routeWithKey({ backend: "sourcify" }, undefined),
        fetch: fake.fetch,
      }),
    );
    assert.equal(result.status, "already-verified");
  });

  const badValues: [string, unknown][] = [
    ["a space", "route key with space"],
    ["7 characters", "abc1234"],
    ["an empty string", ""],
    ["a number", 123456789],
  ];
  for (const [label, value] of badValues) {
    it(`refuses route.apiKey with ${label} and never echoes it`, async () => {
      const secret = typeof value === "string" ? value : undefined;
      await assertRefused(runVerify, { route: routeWithKey({}, value) }, "route.apiKey", secret);
    });
  }

  it("sends the standalone-explorer example's key only to its host, in the form body, and never echoes it (#63)", async () => {
    // Copied from api-keys.md, `## route.apiKey`.
    const explorerKey = ROUTE_KEY;
    const options = {
      route: {
        backend: "etherscan-compatible",
        apiUrl: "https://explorer.example.org/api",
        apiKey: explorerKey,
      },
    } satisfies VerifyOptions;
    const seen = observer();
    const calls: Call[] = [];
    const verified = {
      status: "1",
      message: "OK",
      result: [{ SourceCode: "contract Tiny {}", ContractName: "Tiny" }],
    };
    const fetchEtherscanStyle: typeof fetch = async (target, init) => {
      const url = target instanceof Request ? target.url : String(target);
      calls.push({
        step: "lookup",
        method: init?.method ?? "GET",
        url,
        body: bodyText(init?.body),
        headers: headerText(init?.headers),
      });
      return new Response(JSON.stringify(verified), { status: 200 });
    };
    const outcome = await outcomeOf(
      runVerify({
        ...options,
        fetch: fetchEtherscanStyle,
        logger: seen.logger,
        onEvent: seen.onEvent,
      }),
    );
    assert.ok(!(outcome instanceof ExplorerVerifyError), JSON.stringify(outcome));
    assert.equal(outcome.status, "already-verified");
    assert.equal(outcome.backend, "etherscan-compatible");
    assert.equal(calls.length, 1);
    const [only] = calls;
    assert.ok(only !== undefined);
    assert.equal(only.method, "POST");
    assert.equal(only.url, "https://explorer.example.org/api");
    assert.equal(new URLSearchParams(only.body).get("apikey"), ROUTE_KEY);
    assert.ok(!only.headers.includes(ROUTE_KEY));
    assertNoKey(everything(outcome, seen, []));
  });

  it("refuses route.apiKey even when apiKeys is valid, and echoes neither key", async () => {
    const error = await assertRefused(
      runVerify,
      {
        apiKeys: { "etherscan-v2": ETHERSCAN_KEY },
        route: { apiKey: ROUTE_KEY },
      },
      "route.apiKey",
    );
    assertNoKey(inspect(error, { depth: 10 }) + JSON.stringify(error));
  });
});

describe("missing-api-key check (api-keys.md `## A missing key`)", () => {
  // No route resolves to etherscan-v2 in this release, so the check cannot fire. These tests show
  // what the public API does instead: every way to reach a keyed backend throws invalid-input and
  // sends nothing.
  const original = globalThis.fetch;
  const globalCalls: string[] = [];

  beforeEach(() => {
    globalCalls.length = 0;
    globalThis.fetch = async (target) => {
      globalCalls.push(target instanceof Request ? target.url : String(target));
      return new Response("{}", { status: 500 });
    };
  });

  afterEach(() => {
    globalThis.fetch = original;
  });

  for (const backend of ["etherscan-v2", "routescan"] as const) {
    it(`route.backend "${backend}" on a chain whose row lists only Sourcify throws unsupported-chain, sends nothing (R-RT-2)`, async () => {
      const error = await errorOf(verify(makeInput(), { route: { backend } }));
      assert.equal(error.code, "unsupported-chain");
      assert.equal(globalCalls.length, 0);
    });
  }

  it('route.backend "blockscout", which has a client since #92, on a chain whose row lists only Sourcify throws unsupported-chain, sends nothing', async () => {
    // Chain 31 has a Blockscout entry since #169; Avalanche Fuji (43113) lists only Sourcify.
    const error = await errorOf(
      verify({ ...makeInput(), chainId: 43113 }, { route: { backend: "blockscout" } }),
    );
    assert.equal(error.code, "unsupported-chain");
    assert.equal(globalCalls.length, 0);
  });

  it('route.backend "etherscan-compatible" without route.apiUrl throws unsupported-chain, not missing-api-key, and sends nothing (#63)', async () => {
    // The routing table lists no standalone explorer, so only route.apiUrl reaches one.
    const error = await errorOf(
      verify(makeInput(), {
        route: { backend: "etherscan-compatible" },
        apiKeys: { "etherscan-v2": ETHERSCAN_KEY },
      }),
    );
    assert.equal(error.code, "unsupported-chain");
    assertNoKey(JSON.stringify(error) + inspect(error, { depth: 10 }));
    assert.equal(globalCalls.length, 0);
  });

  it('route.backend "etherscan-compatible" with route.apiUrl and no key sends the request keyless: no missing-api-key check (#63)', async () => {
    // A standalone explorer may not need a key; only its answer can tell. The default fetch here
    // answers 500 to every request.
    const error = await errorOf(
      verify(makeInput(), {
        route: { backend: "etherscan-compatible", apiUrl: "https://explorer.example.org/api" },
      }),
    );
    assert.notEqual(error.code, "missing-api-key");
    assert.ok(globalCalls.length > 0);
    assert.ok(globalCalls.every((url) => url.split("?")[0] === "https://explorer.example.org/api"));
  });

  it("a handle for etherscan-v2 throws invalid-input naming backend, with and without fetch, and sends nothing", async () => {
    const handle = makeHandle({
      backend: "etherscan-v2",
      jobId: "abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmn",
    });
    const bare = await errorOf(checkStatus(handle));
    assert.equal(bare.code, "invalid-input");
    assert.ok(issueFields(bare).includes("backend"), JSON.stringify(issueFields(bare)));
    assert.equal(globalCalls.length, 0);

    const fake = fakeFetch({});
    const injected = await errorOf(
      checkStatus(handle, {
        fetch: fake.fetch,
        apiKeys: { "etherscan-v2": ETHERSCAN_KEY },
      }),
    );
    assert.equal(injected.code, "invalid-input");
    assert.ok(issueFields(injected).includes("backend"));
    assert.equal(fake.calls.length, 0);
    assertNoKey(inspect(injected, { depth: 10 }));
  });

  it("without fetch and without a key, a Sourcify-routed call does not throw missing-api-key", async () => {
    globalThis.fetch = async (target) => {
      globalCalls.push(target instanceof Request ? target.url : String(target));
      return new Response(JSON.stringify(lookup("exact_match").body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const result = await drive(verify(makeInput()));
    assert.equal(result.status, "already-verified");
    assert.equal(globalCalls.length, 1);
  });

  it("without fetch and with a key, the default fetch never sees the key", async () => {
    const seen: string[] = [];
    globalThis.fetch = async (target, init) => {
      seen.push(
        target instanceof Request ? target.url : String(target),
        bodyText(init?.body),
        headerText(init?.headers),
      );
      return new Response(JSON.stringify(lookup("exact_match").body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const result = await drive(
      verify(makeInput(), {
        apiKeys: { "etherscan-v2": ETHERSCAN_KEY, routescan: ROUTESCAN_KEY },
      }),
    );
    assert.equal(result.status, "already-verified");
    assertNoKey(seen.join("\n"));
  });
});

describe("keys never reach requests, logs, events, errors or results (R-SEC-1)", () => {
  const options = (): VerifyOptions => ({
    apiKeys: { "etherscan-v2": ETHERSCAN_KEY, routescan: ROUTESCAN_KEY },
    timeoutMs: 60_000,
    pollIntervalMs: 1_000,
  });

  // Each scenario has the explorer repeat the keys in its answer, as api-keys.md says can happen.
  const echo = `${ETHERSCAN_KEY} ${ROUTESCAN_KEY} ${ETHERSCAN_KEY.toUpperCase()} ${encodeURIComponent(ETHERSCAN_KEY)}`;
  const scenarios: [string, Script, string][] = [
    ["already-verified", { lookup: [lookup("exact_match")] }, "already-verified"],
    [
      "verified",
      {
        lookup: [lookup(null)],
        submit: [ACCEPTED],
        status: [job(true, "exact_match")],
      },
      "verified",
    ],
    [
      "failed, with the key in the reason",
      {
        lookup: [lookup(null)],
        submit: [ACCEPTED],
        status: [
          job(true, null, {
            customCode: "no_match",
            message: `bytecode differs ${echo}`,
            errorId: JOB_ID,
          }),
        ],
      },
      "failed",
    ],
    [
      "unexpected-response, with the key in the body",
      { lookup: [{ status: 418, body: { message: `teapot ${echo}` } }] },
      "unexpected-response",
    ],
    [
      "5xx on every try, with the key in the body",
      {
        lookup: [
          {
            status: 500,
            body: { customCode: "internal_error", message: `boom ${echo}` },
          },
        ],
      },
      "*",
    ],
    [
      "network error, with the key in the message",
      { lookup: [{ networkError: `fetch failed ${echo}` }] },
      "network",
    ],
    [
      "submit refused, with the key in the message",
      {
        lookup: [lookup(null)],
        submit: [
          {
            status: 400,
            body: {
              customCode: "invalid_parameter",
              message: `bad ${echo}`,
              errorId: JOB_ID,
            },
          },
        ],
      },
      "*",
    ],
    [
      "job error, with the key in the message",
      {
        lookup: [lookup(null)],
        submit: [ACCEPTED],
        status: [
          job(true, null, {
            customCode: "internal_error",
            message: `oops ${echo}`,
            errorId: JOB_ID,
          }),
        ],
      },
      "*",
    ],
    [
      "unknown job state, with the key in the body",
      {
        lookup: [lookup(null)],
        submit: [ACCEPTED],
        status: [{ status: 200, body: { isJobCompleted: "weird", note: echo } }],
      },
      "*",
    ],
    [
      "not-confirmed after a pending job",
      {
        lookup: [lookup(null)],
        submit: [ACCEPTED],
        status: [job(false, null)],
      },
      "not-confirmed",
    ],
  ];

  for (const [label, script, expected] of scenarios) {
    it(`verify: ${label}`, async () => {
      const seen = observer();
      const fake = fakeFetch(script);
      const outcome = await outcomeOf(
        verify(makeInput(), {
          ...options(),
          fetch: fake.fetch,
          logger: seen.logger,
          onEvent: seen.onEvent,
        }),
      );
      const code = outcome instanceof ExplorerVerifyError ? outcome.code : outcome.status;
      if (expected !== "*") {
        assert.equal(code, expected);
      }
      assert.ok(fake.calls.length > 0);
      assertNoKey(everything(outcome, seen, fake.calls));
      assert.deepEqual(validateEnvelope(JSON.parse(JSON.stringify(toEnvelope(outcome)))), []);
    });
  }

  it("checkStatus: a job error repeating the keys", async () => {
    const seen = observer();
    const fake = fakeFetch({
      status: [
        job(true, null, {
          customCode: "no_match",
          message: `differs ${echo}`,
          errorId: JOB_ID,
        }),
      ],
    });
    const outcome = await outcomeOf(
      checkStatus(makeHandle(), {
        ...options(),
        fetch: fake.fetch,
        logger: seen.logger,
        onEvent: seen.onEvent,
      }),
    );
    assertNoKey(everything(outcome, seen, fake.calls));
  });

  it("an invalid key in apiKeys is removed too when a valid route.apiUrl call fails", async () => {
    // A bad value throws before any request, so the closest reachable case is the invalid-input
    // error itself: neither the key nor its parts appear.
    const badKey = "invalidkeyzz11 tail22part";
    const seen = observer();
    const fake = fakeFetch({ lookup: [lookup("exact_match")] });
    const outcome = await outcomeOf(
      verify(
        makeInput(),
        apiKeysOf(
          { "etherscan-v2": badKey },
          { fetch: fake.fetch, logger: seen.logger, onEvent: seen.onEvent },
        ),
      ),
    );
    assertNoKey(everything(outcome, seen, fake.calls), [badKey, "invalidkeyzz11", "tail22part"]);
  });
});

function pageOf(code: string): string {
  return readRepo(`docs/user/reference/errors/${code}.md`);
}

function defaultHint(page: string): string {
  const match = /Default hint: ([\s\S]*?)\n\n/u.exec(page);
  assert.ok(match?.[1] !== undefined, "page has a default hint");
  return match[1].replace(/\s+/gu, " ").trim();
}

function rowOf(markdown: string, code: string): string | undefined {
  return markdown.split("\n").find((line) => line.startsWith(`| \`${code}\``));
}

describe("new error codes (api-keys.md, error pages, json-output.md, verify.md)", () => {
  it("lists the three codes in ERROR_CODES", () => {
    for (const code of NEW_CODES) {
      assert.ok(ERROR_CODES.includes(code));
    }
  });

  for (const code of NEW_CODES) {
    it(`${code}: exit code 3, not retryable, docsUrl to its page, hint matches the page, key redacted`, () => {
      assert.equal(ERROR_EXIT_CODES[code], 3);
      const error = new ExplorerVerifyError(
        { code, backend: "etherscan-v2" },
        `the explorer said ${ETHERSCAN_KEY}`,
        {
          hint: ERROR_HINTS[code],
          secrets: [ETHERSCAN_KEY],
          cause: new Error(`inner ${ETHERSCAN_KEY}`),
        },
      );
      assert.equal(error.code, code);
      assert.equal(error.retryable, false);
      assert.equal(error.docsUrl, docsUrlOf(code));
      assert.equal(exitCodeOf(error), 3);
      assert.deepEqual(error.details, { code, backend: "etherscan-v2" });
      const page = pageOf(code);
      assert.equal(page.split("\n")[0], `# ${code}`);
      assert.match(page, /\nRetryable: no\.\n/u);
      assert.match(page, /\nExit code: 3\n/u);
      assert.equal(error.hint, defaultHint(page));
      const envelope = toEnvelope(error);
      assert.deepEqual(validateEnvelope(JSON.parse(JSON.stringify(envelope))), []);
      assert.ok(envelope.error !== undefined && envelope.error.code === code);
      assertNoKey(
        `${error.message}${JSON.stringify(error)}${inspect(error, { depth: 10 })}${JSON.stringify(envelope)}`,
      );
    });

    it(`${code}: an unknown backend in details reads etherscan-compatible, as in a handle`, () => {
      const details = { code, backend: "nope" };
      const error = Reflect.construct(ExplorerVerifyError, [details, "m", { secrets: [] }]);
      assert.ok(error instanceof ExplorerVerifyError);
      assert.deepEqual(error.details, { code, backend: "etherscan-compatible" });
    });

    it(`${code}: toEnvelope with secrets removes a key from the message`, () => {
      const error = new ExplorerVerifyError(
        { code, backend: "routescan" },
        `said ${ROUTESCAN_KEY}`,
        { secrets: [] },
      );
      const envelope = toEnvelope(error, { secrets: [ROUTESCAN_KEY] });
      assertNoKey(JSON.stringify(envelope), [ROUTESCAN_KEY]);
    });
  }

  it("json-output.md lists each code as an error, not retryable, exit 3", () => {
    const page = readRepo("docs/user/reference/json-output.md");
    for (const code of NEW_CODES) {
      const cells = rowOf(page, code)
        ?.split("|")
        .map((cell) => cell.trim());
      assert.deepEqual(cells?.slice(1, 5), [`\`${code}\``, "Error", "`false`", "3"]);
    }
  });

  it("verify.md lists each code with exit code 3", () => {
    const page = readRepo("docs/user/reference/verify.md");
    for (const code of NEW_CODES) {
      const cells = rowOf(page, code)
        ?.split("|")
        .map((cell) => cell.trim());
      assert.equal(cells?.at(-2), "3");
    }
  });

  it("errors/index.md maps exit code 3 to the three codes and links each page", () => {
    const page = readRepo("docs/user/reference/errors/index.md");
    const row = page.split("\n").find((line) => line.startsWith("| 3 "));
    for (const code of NEW_CODES) {
      assert.ok(row?.includes(`\`${code}\``), `exit-3 row names ${code}`);
      assert.ok(page.includes(`- [\`${code}\`](${code}.md)`));
    }
  });

  it("llms.txt and the skill list the codes and the API keys page", () => {
    const llms = readRepo("llms.txt");
    const skill = readRepo("skills/explorer-verify/SKILL.md");
    assert.ok(llms.includes("docs/user/reference/api-keys.md"));
    for (const code of NEW_CODES) {
      assert.ok(llms.includes(`docs/user/reference/errors/${code}.md`));
    }
    const row = skill.split("\n").find((line) => line.startsWith("| 3 "));
    for (const code of NEW_CODES) {
      assert.ok(row?.includes(`\`${code}\``));
    }
  });

  it("api-keys.md says all three exit with code 3 and are not retryable, matching the catalogue", () => {
    const page = readRepo("docs/user/reference/api-keys.md");
    assert.ok(page.includes("All three exit with code 3 and are not retryable."));
    const codes: readonly ErrorCode[] = NEW_CODES;
    for (const code of codes) {
      assert.ok(page.includes(`(errors/${code}.md)`));
    }
  });
});

describe("doc examples, copied in", () => {
  it("api-keys.md: verify(input, { apiKeys: { 'etherscan-v2': etherscanKey } })", async () => {
    const etherscanKey = ETHERSCAN_KEY;
    const input = makeInput();
    const fake = fakeFetch({ lookup: [lookup("exact_match")] });
    // On a server. Never ship an Etherscan key to a browser.
    const result = await drive(
      verify(input, {
        apiKeys: { "etherscan-v2": etherscanKey },
        fetch: fake.fetch,
      }),
    );
    assert.equal(result.status, "already-verified");
    assertNoKey(JSON.stringify(fake.calls) + JSON.stringify(result));
  });

  it("TSDoc of VerifyOptions.apiKeys: const options: VerifyOptions = { apiKeys: { 'etherscan-v2': etherscanKey } }", async () => {
    const etherscanKey: string = ETHERSCAN_KEY; // read on a server, never shipped to a browser
    const options: VerifyOptions = {
      apiKeys: { "etherscan-v2": etherscanKey },
    };
    const fake = fakeFetch({ lookup: [lookup("exact_match")] });
    const result = await drive(verify(makeInput(), { ...options, fetch: fake.fetch }));
    assert.equal(result.status, "already-verified");
  });

  it("SKILL.md: { apiKeys: { 'etherscan-v2': key } }", async () => {
    const key = ETHERSCAN_KEY;
    const fake = fakeFetch({ lookup: [lookup("exact_match")] });
    const result = await drive(
      verify(makeInput(), {
        apiKeys: { "etherscan-v2": key },
        fetch: fake.fetch,
      }),
    );
    assert.equal(result.status, "already-verified");
  });
});
