// Black-box tests for issue #65: VerifyInput.libraries and linkLibraries, written from the issue,
// R-IN-1, R-IN-4, docs/user/reference/verify.md "Linked libraries", the Hardhat and Foundry guides
// and the public declarations. Kept as a regression test; every request goes to a fake fetch.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { ExplorerVerifyError, linkLibraries, validateInput, verify } from "../../src/index.ts";
import type { Hex, VerifyInput } from "../../src/index.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";

/** linkLibraries called as untyped JavaScript calls it, so the runtime checks are tested. */
function linkUntyped(input: unknown): VerifyInput {
  const linked: unknown = Reflect.apply(linkLibraries, undefined, [input]);
  return validateInput(linked);
}

const CHAIN_ID = 11155111; // routing.md: sourcify
const ADDRESS: Hex = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const LIB_MIXED: Hex = "0xd0B737fC4e4195144824eB07b2d1bb778525b86B";
const LIB_LOWER = LIB_MIXED.toLowerCase();
const OTHER: Hex = "0x1111111111111111111111111111111111111111";
const JOB_ID = "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718";

/** A shallow copy of `value` as a record, or `undefined` when it is not a plain object. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

/** A shallow copy of `value` as a record. Its field values are the original objects. */
function rec(value: unknown): Record<string, unknown> {
  const copy = asRecord(value);
  assert.ok(copy !== undefined, "expected an object");
  return copy;
}

/** The original object at `keys` under `value`, for identity checks and changes in place. */
function at(value: unknown, ...keys: string[]): object {
  let current = value;
  for (const key of keys) {
    assert.ok(typeof current === "object" && current !== null, `no object at ${key}`);
    current = Reflect.get(current, key);
  }
  assert.ok(typeof current === "object" && current !== null, "expected an object");
  return current;
}

function typedInput(
  settings: Record<string, unknown> = {},
  libraries?: Record<string, Hex>,
): VerifyInput {
  return {
    chainId: CHAIN_ID,
    address: ADDRESS,
    compiler: {
      kind: "solc",
      version: "0.8.24+commit.e11b9ed9",
      input: {
        language: "Solidity",
        sources: {
          "src/Main.sol": { content: "import './MathLib.sol'; contract Main {}" },
          "src/MathLib.sol": { content: "library MathLib {}" },
          "lib/Other.sol": { content: "library Other {} library Second {}" },
        },
        settings: { optimizer: { enabled: false, runs: 200 }, ...settings },
      },
    },
    contractName: "src/Main.sol:Main",
    ...(libraries === undefined ? {} : { libraries }),
  };
}

/** The same input with any `libraries` value, for the checks of untrusted input. */
function makeInput(settings: Record<string, unknown> = {}, libraries?: unknown): unknown {
  const input = typedInput(settings);
  return libraries === undefined ? input : { ...input, libraries };
}

function rejectionOf(fn: () => unknown): ExplorerVerifyError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ExplorerVerifyError, `not an ExplorerVerifyError: ${String(caught)}`);
  return caught;
}

function issuesOf(error: ExplorerVerifyError): { field: string; message: string }[] {
  const issues = rec(error.details)["issues"];
  assert.ok(Array.isArray(issues), "details.issues must be an array");
  return issues.map((issue: unknown) => {
    const fields = rec(issue);
    return { field: String(fields["field"]), message: String(fields["message"]) };
  });
}

/** Asserts invalid-input naming exactly `field`, with none of `secrets` in message or JSON. */
function assertRejected(input: unknown, field: string, secrets: readonly string[]): void {
  for (const call of [() => validateInput(input), () => linkUntyped(input)]) {
    const error = rejectionOf(call);
    assert.equal(error.code, "invalid-input");
    const fields = issuesOf(error).map((issue) => issue.field);
    assert.ok(fields.includes(field), `expected issue ${field}, got ${JSON.stringify(fields)}`);
    const text = `${error.message}\n${JSON.stringify(error.toJSON())}\n${JSON.stringify(error.details)}`;
    for (const secret of secrets) {
      assert.ok(!text.includes(secret), `error echoes ${JSON.stringify(secret)}: ${text}`);
    }
  }
}

describe("validateInput accepts libraries (R-IN-1, R-IN-4)", () => {
  it("valid entries pass and addresses come back lower-cased", () => {
    const out = validateInput(
      makeInput({}, { "src/MathLib.sol:MathLib": LIB_MIXED, "lib/Other.sol:Other": OTHER }),
    );
    assert.deepEqual(out.libraries, {
      "src/MathLib.sol:MathLib": LIB_LOWER,
      "lib/Other.sol:Other": OTHER,
    });
  });

  it("validateInput does not add the addresses to settings.libraries", () => {
    const out = validateInput(makeInput({}, { "src/MathLib.sol:MathLib": LIB_MIXED }));
    assert.equal(out.compiler.input.settings["libraries"], undefined);
  });

  it("input without libraries passes and has no libraries field", () => {
    const out = validateInput(makeInput());
    assert.equal(out.libraries, undefined);
  });

  it("an empty libraries object passes", () => {
    assert.doesNotThrow(() => validateInput(makeInput({}, {})));
  });

  it("a matching address already in settings.libraries is accepted", () => {
    assert.doesNotThrow(() =>
      validateInput(
        makeInput(
          { libraries: { "src/MathLib.sol": { MathLib: LIB_LOWER } } },
          { "src/MathLib.sol:MathLib": LIB_MIXED },
        ),
      ),
    );
  });

  it("an address differing only in case from settings.libraries is accepted", () => {
    assert.doesNotThrow(() =>
      validateInput(
        makeInput(
          { libraries: { "src/MathLib.sol": { MathLib: LIB_MIXED } } },
          { "src/MathLib.sol:MathLib": LIB_LOWER },
        ),
      ),
    );
  });
});

describe("validateInput rejects bad libraries without echoing key or path (R-IN-4)", () => {
  const cases: { name: string; key: string; value: string; secrets: string[] }[] = [
    {
      name: "key without colon",
      key: "srcMathLibSecretKey",
      value: LIB_MIXED,
      secrets: ["srcMathLibSecretKey"],
    },
    {
      name: "key with empty name",
      key: "src/MathLib.sol:",
      value: LIB_MIXED,
      secrets: ["src/MathLib.sol"],
    },
    { name: "key with empty path", key: ":MathLib", value: LIB_MIXED, secrets: [":MathLib"] },
    {
      name: "path not in sources",
      key: "src/Hidden99.sol:MathLib",
      value: LIB_MIXED,
      secrets: ["Hidden99"],
    },
    {
      name: "absolute path",
      key: "/home/alice99/proj/src/MathLib.sol:MathLib",
      value: LIB_MIXED,
      secrets: ["alice99", "/home/"],
    },
    {
      name: "home path",
      key: "~/bob99/MathLib.sol:MathLib",
      value: LIB_MIXED,
      secrets: ["bob99", "~/"],
    },
    {
      name: "drive path",
      key: "C:\\Users\\carol99\\MathLib.sol:MathLib",
      value: LIB_MIXED,
      secrets: ["carol99"],
    },
    {
      name: "drive path with slash",
      key: "D:/dave99/MathLib.sol:MathLib",
      value: LIB_MIXED,
      secrets: ["dave99"],
    },
    {
      name: "file URL",
      key: "file:///erin99/MathLib.sol:MathLib",
      value: LIB_MIXED,
      secrets: ["erin99", "file:"],
    },
    {
      name: "climbing path",
      key: "../frank99/MathLib.sol:MathLib",
      value: LIB_MIXED,
      secrets: ["frank99"],
    },
    {
      name: "climbing path in middle",
      key: "src/../../gina99/MathLib.sol:MathLib",
      value: LIB_MIXED,
      secrets: ["gina99"],
    },
    {
      name: "bad address (short)",
      key: "src/MathLib.sol:MathLib",
      value: "0x1234",
      secrets: ["src/MathLib.sol"],
    },
    {
      name: "bad address (non-hex)",
      key: "src/MathLib.sol:MathLib",
      value: "0xzz37fC4e4195144824eB07b2d1bb778525b86B",
      secrets: ["src/MathLib.sol"],
    },
    {
      name: "bad address (no 0x)",
      key: "src/MathLib.sol:MathLib",
      value: "d0B737fC4e4195144824eB07b2d1bb778525b86B",
      secrets: ["src/MathLib.sol"],
    },
  ];
  for (const c of cases) {
    it(`${c.name} -> libraries.1`, () => {
      assertRejected(makeInput({}, { [c.key]: c.value }), "libraries.1", c.secrets);
    });
  }

  it("climbing path that also exists in sources is still rejected", () => {
    const input = makeInput({}, { "../hank99/MathLib.sol:MathLib": LIB_MIXED });
    Reflect.set(at(input, "compiler", "input", "sources"), "../hank99/MathLib.sol", {
      content: "library MathLib {}",
    });
    assertRejected(input, "libraries.1", ["hank99"]);
  });

  it("non-string address -> libraries.1", () => {
    assertRejected(makeInput({}, { "src/MathLib.sol:MathLib": 42 }), "libraries.1", [
      "src/MathLib.sol",
    ]);
  });

  it("libraries that is not an object is rejected naming libraries", () => {
    for (const bad of ["x", 5, [LIB_MIXED], null]) {
      const error = rejectionOf(() => validateInput(makeInput({}, bad)));
      assert.equal(error.code, "invalid-input");
      assert.ok(
        issuesOf(error).some((issue) => issue.field.startsWith("libraries")),
        `libraries=${JSON.stringify(bad)} -> ${JSON.stringify(issuesOf(error))}`,
      );
    }
  });

  it("position counts from 1 in key order: the third bad entry is libraries.3", () => {
    assertRejected(
      makeInput(
        {},
        {
          "src/MathLib.sol:MathLib": LIB_MIXED,
          "lib/Other.sol:Other": OTHER,
          "/abs/iris99/X.sol:X": OTHER,
        },
      ),
      "libraries.3",
      ["iris99"],
    );
  });

  it("conflicting address in settings.libraries -> libraries.1, no echo", () => {
    assertRejected(
      makeInput(
        { libraries: { "src/MathLib.sol": { MathLib: OTHER } } },
        { "src/MathLib.sol:MathLib": LIB_MIXED },
      ),
      "libraries.1",
      ["src/MathLib.sol", "MathLib"],
    );
  });
});

// ---------------------------------------------------------------------------------------------
// verify() sends compiler.input unchanged.

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
});
afterEach(() => {
  mock.timers.reset();
});

/** Runs the mock timers until `pending` settles. */
async function drive<T>(pending: Promise<T>): Promise<T> {
  await driveMockClock(pending, () => {
    mock.timers.runAll();
  });
  return await pending;
}

interface Call {
  method: string;
  url: string;
  body: string;
}

/** A Sourcify contract answer with `match`. */
function contract(match: string | null): Record<string, unknown> {
  return {
    match,
    creationMatch: match,
    runtimeMatch: match,
    chainId: String(CHAIN_ID),
    address: ADDRESS,
    ...(match === null ? {} : { verifiedAt: "2026-11-03T10:00:00Z", matchId: "1" }),
  };
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function sourcifyFetch(): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let lookups = 0;
  const fn: typeof fetch = async (target, init) => {
    const url = target instanceof Request ? target.url : String(target);
    const method = (
      target instanceof Request ? target.method : (init?.method ?? "GET")
    ).toUpperCase();
    const body =
      target instanceof Request
        ? await target.clone().text()
        : typeof init?.body === "string"
          ? init.body
          : "";
    calls.push({ method, url, body });
    const path = new URL(url).pathname;
    if (method === "GET" && /\/v2\/contract\//u.test(path)) {
      lookups += 1;
      return lookups === 1 ? json(404, contract(null)) : json(200, contract("exact_match"));
    }
    if (method === "POST" && /\/v2\/verify\//u.test(path)) {
      return json(202, { verificationId: JOB_ID });
    }
    if (method === "GET" && /\/v2\/verify\//u.test(path)) {
      return json(200, {
        isJobCompleted: true,
        verificationId: JOB_ID,
        jobStartTime: "2026-11-03T10:00:00Z",
        contract: contract("exact_match"),
      });
    }
    throw new Error(`unexpected request ${method} ${path}`);
  };
  return { fetch: fn, calls };
}

/** The Standard JSON input in a Sourcify submit body. */
function stdJsonOf(body: string | undefined): Record<string, unknown> {
  const parsed: unknown = JSON.parse(body ?? "{}");
  return rec(rec(parsed)["stdJsonInput"]);
}

describe("verify() sends compiler.input unchanged when libraries are given (R-IN-4)", () => {
  it("Sourcify: submitted std JSON input has no added settings.libraries", async () => {
    const input = typedInput({}, { "src/MathLib.sol:MathLib": LIB_MIXED });
    const fake = sourcifyFetch();
    const result = await drive(verify(input, { fetch: fake.fetch }));
    assert.equal(result.status, "verified");
    const posts = fake.calls.filter((call) => call.method === "POST");
    assert.equal(posts.length, 1, JSON.stringify(fake.calls.map((c) => `${c.method} ${c.url}`)));
    const sent = stdJsonOf(posts[0]?.body);
    assert.deepEqual(sent, JSON.parse(JSON.stringify(input.compiler.input)));
    assert.equal(rec(sent["settings"])["libraries"], undefined);
    for (const call of fake.calls) {
      assert.ok(!call.body.toLowerCase().includes(LIB_LOWER.slice(2)), "library address sent");
      assert.ok(!call.url.toLowerCase().includes(LIB_LOWER.slice(2)), "library address in a URL");
    }
  });

  it("Sourcify: existing settings.libraries is sent as is (no merge)", async () => {
    const input = typedInput(
      { libraries: { "lib/Other.sol": { Other: OTHER } } },
      { "src/MathLib.sol:MathLib": LIB_MIXED },
    );
    const fake = sourcifyFetch();
    await drive(verify(input, { fetch: fake.fetch }));
    const post = fake.calls.find((call) => call.method === "POST");
    assert.deepEqual(rec(stdJsonOf(post?.body)["settings"])["libraries"], {
      "lib/Other.sol": { Other: OTHER },
    });
  });

  it("verify() rejects bad libraries before any request", async () => {
    const fake = sourcifyFetch();
    let caught: unknown;
    try {
      await drive(
        verify(typedInput({}, { "/home/zed99/M.sol:M": LIB_MIXED }), { fetch: fake.fetch }),
      );
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof ExplorerVerifyError);
    assert.equal(caught.code, "invalid-input");
    assert.equal(fake.calls.length, 0);
    assert.ok(!JSON.stringify(caught.toJSON()).includes("zed99"));
  });
});

// ---------------------------------------------------------------------------------------------
// linkLibraries.

function settingsLibs(input: unknown): unknown {
  return rec(at(input, "compiler", "input", "settings"))["libraries"];
}

describe("linkLibraries (R-IN-4)", () => {
  it("merges into settings.libraries in Standard JSON shape, lower case (doc example)", () => {
    const linked = linkUntyped(makeInput({}, { "src/MathLib.sol:MathLib": LIB_MIXED }));
    assert.deepEqual(settingsLibs(linked), { "src/MathLib.sol": { MathLib: LIB_LOWER } });
  });

  it("keeps entries settings.libraries already holds, merging into the same path", () => {
    const linked = linkUntyped(
      makeInput(
        { libraries: { "lib/Other.sol": { Other: OTHER } } },
        { "lib/Other.sol:Second": LIB_MIXED, "src/MathLib.sol:MathLib": LIB_MIXED },
      ),
    );
    assert.deepEqual(settingsLibs(linked), {
      "lib/Other.sol": { Other: OTHER, Second: LIB_LOWER },
      "src/MathLib.sol": { MathLib: LIB_LOWER },
    });
  });

  it("without libraries, input comes back unchanged (deep equal)", () => {
    const input = makeInput();
    const linked = linkUntyped(input);
    assert.deepEqual(linked, validateInput(input));
    assert.equal(settingsLibs(linked), undefined);
  });

  it("is idempotent", () => {
    const once = linkUntyped(makeInput({}, { "src/MathLib.sol:MathLib": LIB_MIXED }));
    const twice = linkUntyped(once);
    assert.deepEqual(twice, once);
  });

  it("does not mutate its argument and shares no object with it", () => {
    const input = makeInput(
      { libraries: { "lib/Other.sol": { Other: OTHER } } },
      { "src/MathLib.sol:MathLib": LIB_MIXED },
    );
    const before: unknown = JSON.parse(JSON.stringify(input));
    const linked = linkUntyped(input);
    assert.deepEqual(input, before);
    assert.notEqual(linked, input);
    for (const path of [
      ["compiler"],
      ["compiler", "input"],
      ["compiler", "input", "settings"],
      ["compiler", "input", "sources"],
      ["compiler", "input", "settings", "libraries"],
      ["compiler", "input", "settings", "libraries", "lib/Other.sol"],
      ["libraries"],
    ]) {
      assert.notEqual(at(linked, ...path), at(input, ...path), path.join("."));
    }
  });

  it("rejects a conflicting address like validateInput", () => {
    const error = rejectionOf(() =>
      linkUntyped(
        makeInput(
          { libraries: { "src/MathLib.sol": { MathLib: OTHER } } },
          { "src/MathLib.sol:MathLib": LIB_MIXED },
        ),
      ),
    );
    assert.equal(error.code, "invalid-input");
  });

  for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    it(`library named ${name} is linked as an own data property, no prototype pollution`, () => {
      // JSON.parse creates "__proto__" as an own property.
      const libraries: unknown = JSON.parse(`{"src/MathLib.sol:${name}":"${LIB_MIXED}"}`);
      const linked = linkUntyped(makeInput({}, libraries));
      const byPath = at(settingsLibs(linked), "src/MathLib.sol");
      assert.ok(Object.hasOwn(byPath, name), `${name} not an own property`);
      assert.equal(Reflect.get(byPath, name), LIB_LOWER);
      assert.equal(Object.getPrototypeOf(byPath), Object.prototype);
      assert.equal(Object.hasOwn(Object.prototype, LIB_LOWER), false);
      assert.equal(Reflect.get({}, "polluted"), undefined);
      assert.equal(typeof Reflect.get({}, "constructor"), "function");
      // The settings.libraries record survives a JSON round trip with the entry intact.
      const round: unknown = JSON.parse(JSON.stringify(settingsLibs(linked)));
      assert.equal(Reflect.get(at(round, "src/MathLib.sol"), name), LIB_LOWER);
    });
  }

  it("a source path named __proto__ is handled safely", () => {
    const libraries: unknown = JSON.parse(`{"__proto__:MathLib":"${LIB_MIXED}"}`);
    const input = makeInput({}, libraries);
    Object.defineProperty(at(input, "compiler", "input", "sources"), "__proto__", {
      value: { content: "library MathLib {}" },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const linked = linkUntyped(input);
    const libs = at(settingsLibs(linked));
    assert.ok(Object.hasOwn(libs, "__proto__"));
    assert.equal(Reflect.get(at(libs, "__proto__"), "MathLib"), LIB_LOWER);
    assert.equal(Reflect.get({}, "MathLib"), undefined);
  });

  it("existing settings.libraries holding a __proto__ library is kept", () => {
    const settingsLib: unknown = JSON.parse(`{"src/MathLib.sol":{"__proto__":"${OTHER}"}}`);
    const linked = linkUntyped(
      makeInput({ libraries: settingsLib }, { "src/MathLib.sol:MathLib": LIB_MIXED }),
    );
    const byPath = at(settingsLibs(linked), "src/MathLib.sol");
    assert.ok(Object.hasOwn(byPath, "__proto__"));
    assert.equal(Reflect.get(byPath, "__proto__"), OTHER);
    assert.equal(Reflect.get(byPath, "MathLib"), LIB_LOWER);
  });
});
