// Vyper on Sourcify (#423; R-BE-4, R-EXT-1, R-FLOW-1, R-FLOW-4, R-FLOW-5, decisions 0075 and
// 0077). The Scoreboard contract, built with Vyper 0.4.3 and one `.vyi` interface, was deployed on
// Ethereum Sepolia and submitted to Sourcify first on 2026-11-19. The fixtures under
// test/fixtures/sourcify/2026-11-19-vyper-* are its recorded answers, and the lookups of the
// 0.3.10 and 0.4.0 contracts of docs/contributor/research/2026-11-15-vyper-support.md.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import { sourcify } from "../../src/backends/sourcify.ts";
import { VYPER_ROUTES, inputCheck, kindCheck } from "../../src/compiler-kinds.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import { DEFAULT_DEPENDENCIES } from "../../src/flow/defaults.ts";
import { validateInput } from "../../src/input/validate.ts";
import type {
  Handle,
  RouteOverride,
  SolidityStandardJsonInput,
  VerifyInput,
} from "../../src/types.ts";
import { runCheckStatus, runDryRun, runVerify, runVerifyEach } from "../helpers/defaults.ts";
import { loadFixture, replay, responseOf } from "../helpers/fake-fetch.ts";
import type { Call, Fixture, Step } from "../helpers/fake-fetch.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";
import { resolveRoute } from "../helpers/route.ts";

const SEPOLIA = 11155111;
const SCOREBOARD = "0xf3dc8196fd8dfdacc30040c47f383212c0581caa";
const JOB = "6d8983b4-4730-4487-bf7e-578c45d39efc";
// Contracts B (0.3.10) and C (0.4.0) of the 2026-11-15 research note.
const B = "0xb0de5e59ce0236e6a4b51de0ceb6b20c90dfdd36";
const C = "0xc4d2674d90d008bd32a36d438efc4c6f9f2bbb6b";
// A fake key. Never a real one (R-SEC-1).
const DUMMY_KEY = "DUMMYKEYsourcifyvyper423";

/** The live target's input: the Scoreboard source and its `.vyi` interface. */
function scoreboard(): VerifyInput {
  const url = new URL("../../../../test/live/sourcify-sepolia-vyper-input.json", import.meta.url);
  return validateInput(JSON.parse(readFileSync(url, "utf8")));
}

/** A Vyper input at `address` built with `version`, named `contractName`. */
function older(address: string, version: string, contractName: string): VerifyInput {
  const path = contractName.slice(0, contractName.indexOf(":"));
  return validateInput({
    chainId: SEPOLIA,
    address,
    contractName,
    compiler: {
      kind: "vyper",
      version,
      input: {
        language: "Vyper",
        sources: { [path]: { content: "# pragma version 0.4.0\n" } },
        settings: {},
      },
    },
  });
}

const OLDER = [
  { label: "0.3.10", address: B, version: "0.3.10+commit.91361694", name: "Greeter.vy:Greeter" },
  { label: "0.4.0", address: C, version: "0.4.0+commit.e9db8d9f", name: "src/Counter.vy:Counter" },
] as const;

/** `test/fixtures/sourcify/2026-11-19-vyper-<name>.json`. */
function recorded(name: string): Fixture {
  return loadFixture("sourcify", `2026-11-19-vyper-${name}`);
}

/** The recorded not-verified lookup, about `address`. */
function notVerified(address: string): Response {
  const fixture = recorded("lookup-not-verified");
  return responseOf({
    ...fixture,
    response: {
      ...fixture.response,
      body: { match: null, creationMatch: null, runtimeMatch: null, chainId: "11155111", address },
    },
  });
}

/** Settles `promise` with the timers mocked, so the polls wait no real time. */
async function drive<T>(t: TestContext, promise: Promise<T>): Promise<T> {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  promise.catch(() => {});
  await driveMockClock(promise, () => {
    t.mock.timers.runAll();
  });
  return await promise;
}

const DEPENDENCIES = { backends: DEFAULT_DEPENDENCIES.backends, random: () => 0 };

/** Runs `verify()` on `input` and `route`, answered by `steps`. */
async function verifyWith(
  t: TestContext,
  input: VerifyInput,
  steps: Step[],
  route: RouteOverride | undefined = { backend: "sourcify" },
): Promise<{ result: unknown; calls: Call[] }> {
  const fake = replay(...steps);
  const result = await drive(
    t,
    runVerify(
      input,
      { fetch: fake.fetch, route, apiKeys: { "etherscan-v2": DUMMY_KEY }, pollIntervalMs: 1000 },
      DEPENDENCIES,
    ),
  );
  return { result, calls: fake.calls };
}

/** The JSON body of a call. */
function bodyOf(call: Call | undefined): Record<string, unknown> {
  const parsed: unknown = JSON.parse(call?.body ?? "null");
  assert.ok(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
  return Object.fromEntries(Object.entries(parsed));
}

const EXPLORER_URL = (address: string): string => `https://repo.sourcify.dev/11155111/${address}`;

describe("verify() of Vyper input on Sourcify (R-BE-4, R-EXT-1, recorded 2026-11-19)", () => {
  it("verifies the 0.4.3 Scoreboard exact, sending its interface as a source", async (t) => {
    const input = scoreboard();
    const r = await verifyWith(t, input, [
      recorded("lookup-not-verified"),
      recorded("submit-accepted"),
      recorded("job-pending"),
      recorded("job-exact-match"),
    ]);
    assert.deepEqual(r.result, {
      status: "verified",
      backend: "sourcify",
      match: "exact",
      explorerUrl: EXPLORER_URL(SCOREBOARD),
    });
    assert.equal(r.calls.length, 4);
    const submit = r.calls[1];
    assert.equal(submit?.method, "POST");
    assert.equal(submit?.url, `https://sourcify.dev/server/v2/verify/11155111/${SCOREBOARD}`);
    const body = bodyOf(submit);
    assert.deepEqual(Object.keys(body), [
      "stdJsonInput",
      "compilerVersion",
      "contractIdentifier",
      "creationTransactionHash",
    ]);
    assert.equal(body["compilerVersion"], "0.4.3+commit.bff19ea2");
    assert.equal(body["contractIdentifier"], "src/Scoreboard.vy:Scoreboard");
    assert.equal(body["creationTransactionHash"], input.creationTxHash);
    assert.ok(input.compiler.kind === "vyper");
    const { sources, interfaces, settings } = input.compiler.input;
    assert.ok(interfaces !== undefined);
    // Sourcify refuses a top-level `interfaces` field: the interface goes in `sources`.
    assert.deepEqual(body["stdJsonInput"], {
      language: "Vyper",
      sources: { ...sources, ...interfaces },
      settings,
    });
    assert.ok(!JSON.stringify(body).includes(DUMMY_KEY));
  });

  for (const { label, address, version, name } of OLDER) {
    it(`verifies a ${label} contract partial`, async (t) => {
      const r = await verifyWith(t, older(address, version, name), [
        notVerified(address),
        recorded("submit-accepted"),
        recorded(`job-match-${label.replaceAll(".", "-")}`),
      ]);
      assert.deepEqual(r.result, {
        status: "verified",
        backend: "sourcify",
        match: "partial",
        explorerUrl: EXPLORER_URL(address),
      });
      assert.equal(bodyOf(r.calls[1])["compilerVersion"], version);
    });
  }

  it("routes Vyper input to Sourcify when the table's pick, Etherscan, does not map it", async (t) => {
    const r = await verifyWith(t, scoreboard(), [recorded("lookup-exact-match")], undefined);
    assert.deepEqual(r.result, {
      status: "already-verified",
      backend: "sourcify",
      match: "exact",
      explorerUrl: EXPLORER_URL(SCOREBOARD),
    });
    assert.ok(r.calls[0]?.url.startsWith("https://sourcify.dev/server/v2/contract/"));
  });

  it("verifyEach() with every backend runs Sourcify only", async (t) => {
    const fake = replay(recorded("lookup-exact-match"));
    const results = await drive(
      t,
      runVerifyEach(
        scoreboard(),
        { fetch: fake.fetch, backends: "all", apiKeys: { "etherscan-v2": DUMMY_KEY } },
        DEPENDENCIES,
      ),
    );
    assert.deepEqual(
      results.outcomes.map((each) => each.backend),
      ["sourcify"],
    );
    assert.equal(fake.calls.length, 1);
  });
});

describe("a lookup of a verified Vyper contract (R-FLOW-1, recorded 2026-11-19)", () => {
  it("returns already-verified exact for the 0.4.3 Scoreboard, without a submit", async (t) => {
    const r = await verifyWith(t, scoreboard(), [recorded("lookup-exact-match")]);
    assert.deepEqual(r.result, {
      status: "already-verified",
      backend: "sourcify",
      match: "exact",
      explorerUrl: EXPLORER_URL(SCOREBOARD),
    });
    assert.equal(r.calls.length, 1);
  });

  for (const { label, address, version, name } of OLDER) {
    it(`returns already-verified partial for the ${label} contract, without a submit`, async (t) => {
      const r = await verifyWith(t, older(address, version, name), [
        recorded(`lookup-match-${label.replaceAll(".", "-")}`),
      ]);
      assert.deepEqual(r.result, {
        status: "already-verified",
        backend: "sourcify",
        match: "partial",
        explorerUrl: EXPLORER_URL(address),
      });
      assert.equal(r.calls.length, 1);
    });
  }

  it("reads the stored Vyper name and version, so another Vyper contract's source is submitted over", async () => {
    const route = resolveRoute(SEPOLIA, { backend: "sourcify" });
    const fake = replay(recorded("lookup-exact-match"));
    const found = await sourcify.lookup(
      { chainId: SEPOLIA, address: SCOREBOARD },
      { route, http: { backend: "sourcify", fetch: fake.fetch, secrets: [], random: () => 0 } },
    );
    assert.deepEqual(found, {
      match: "exact",
      name: "src/Scoreboard.vy:Scoreboard",
      compilerVersion: "0.4.3+commit.bff19ea2",
    });
  });
});

describe("a Vyper job that Sourcify rejects (R-FLOW-4, recorded 2026-11-19)", () => {
  it("maps no_match to failed, bytecode-mismatch", async (t) => {
    const r = await verifyWith(t, scoreboard(), [
      recorded("lookup-not-verified"),
      recorded("submit-no-match-accepted"),
      recorded("job-no-match"),
    ]);
    assert.deepEqual(r.result, {
      status: "failed",
      backend: "sourcify",
      reason: "no_match: The deployed and recompiled bytecode don't match.",
      reasonCode: "bytecode-mismatch",
    });
  });

  it("maps a Vyper compiler_error to failed, compiler, as for solc", async (t) => {
    const r = await verifyWith(t, scoreboard(), [
      recorded("lookup-not-verified"),
      recorded("submit-compiler-error-accepted"),
      recorded("job-compiler-error"),
    ]);
    assert.ok(typeof r.result === "object" && r.result !== null);
    assert.equal(Reflect.get(r.result, "status"), "failed");
    assert.equal(Reflect.get(r.result, "reasonCode"), "compiler");
    assert.match(String(Reflect.get(r.result, "reason")), /^compiler_error: Compiler error\./);
    assert.ok(String(Reflect.get(r.result, "reason")).length <= 300);
  });

  it("reads a resubmit's job that ends with already_verified as already-verified", async () => {
    const route = resolveRoute(SEPOLIA, { backend: "sourcify" });
    const fixture = recorded("job-already-verified");
    const jobId = fixture.request.url.slice(fixture.request.url.lastIndexOf("/") + 1);
    const handle: Handle = {
      version: 1,
      backend: "sourcify",
      chainId: SEPOLIA,
      address: SCOREBOARD,
      jobId,
    };
    const fake = replay(fixture);
    const state = await sourcify.poll(handle, {
      route,
      http: { backend: "sourcify", fetch: fake.fetch, secrets: [], random: () => 0 },
    });
    assert.deepEqual(state, { state: "already-verified" });
  });

  it("refuses a top-level interfaces field with 400 invalid_parameter, read as unexpected-response", async () => {
    // The recorded answer of a submit that sent `interfaces`; the client no longer sends it.
    const route = resolveRoute(SEPOLIA, { backend: "sourcify" });
    const fake = replay(recorded("submit-interfaces-refused"));
    await assert.rejects(
      sourcify.submit(scoreboard(), {
        route,
        http: { backend: "sourcify", fetch: fake.fetch, secrets: [], random: () => 0 },
      }),
      (error) => ExplorerVerifyError.is(error, "unexpected-response"),
    );
    const sent = bodyOf(fake.calls[0])["stdJsonInput"];
    assert.ok(typeof sent === "object" && sent !== null);
    assert.equal(Object.hasOwn(sent, "interfaces"), false);
  });
});

describe("checkStatus() of a Vyper job (R-FLOW-5, recorded 2026-11-19)", () => {
  const handle: Handle = {
    version: 1,
    backend: "sourcify",
    chainId: SEPOLIA,
    address: SCOREBOARD,
    jobId: JOB,
  };

  it("resumes the job from its handle and returns verified exact", async () => {
    const fake = replay(recorded("job-exact-match"));
    const result = await runCheckStatus(handle, { fetch: fake.fetch }, DEPENDENCIES);
    assert.deepEqual(result, {
      status: "verified",
      backend: "sourcify",
      match: "exact",
      explorerUrl: EXPLORER_URL(SCOREBOARD),
    });
    assert.equal(fake.calls[0]?.url, `https://sourcify.dev/server/v2/verify/${JOB}`);
  });

  it("polls a job that is still running until it ends", async (t) => {
    const fake = replay(recorded("job-pending"), recorded("job-exact-match"));
    const result = await drive(
      t,
      runCheckStatus(handle, { fetch: fake.fetch, pollIntervalMs: 1000 }, DEPENDENCIES),
    );
    assert.equal(result.status, "verified");
    assert.equal(fake.calls.length, 2);
  });
});

/** The `stdJsonInput` the client sends for `interfaces`. */
async function sentFor(
  interfaces: Record<string, unknown> | undefined,
  sources: Record<string, unknown> = { "src/A.vy": { content: "x: uint256\n" } },
): Promise<unknown> {
  const route = resolveRoute(SEPOLIA, { backend: "sourcify" });
  const fake = replay(recorded("submit-accepted"));
  const input = validateInput({
    chainId: SEPOLIA,
    address: SCOREBOARD,
    contractName: "src/A.vy:A",
    compiler: {
      kind: "vyper",
      version: "0.4.3+commit.bff19ea2",
      input: {
        language: "Vyper",
        sources,
        ...(interfaces === undefined ? {} : { interfaces }),
        settings: { evmVersion: "cancun" },
      },
    },
  });
  await sourcify.submit(input, {
    route,
    http: { backend: "sourcify", fetch: fake.fetch, secrets: [], random: () => 0 },
  });
  return bodyOf(fake.calls[0])["stdJsonInput"];
}

describe("the Vyper interfaces Sourcify gets as sources (decision 0077)", () => {
  // Python 3's json.dumps of ENTRY, the text Vyper builds for an ABI interface.
  const ENTRY = {
    abi: [
      {
        type: "function",
        name: "total",
        inputs: [],
        outputs: [{ name: "", type: "uint256", components: [] }],
        stateMutability: "view",
        constant: false,
        payable: null,
        gas: 3000,
        note: 'café \u007f \u{1F600} "q" \\ \n\t\u0001 ~',
      },
      {
        type: "event",
        name: "Bumped",
        inputs: [
          { name: "by", type: "uint256" },
          { name: "score", type: "uint256" },
        ],
      },
    ],
  };
  const PYTHON =
    '{"abi": [{"type": "function", "name": "total", "inputs": [], "outputs": [{"name": "", "type": "uint256", "components": []}], "stateMutability": "view", "constant": false, "payable": null, "gas": 3000, "note": "caf\\u00e9 \\u007f \\ud83d\\ude00 \\"q\\" \\\\ \\n\\t\\u0001 ~"}, {"type": "event", "name": "Bumped", "inputs": [{"name": "by", "type": "uint256"}, {"name": "score", "type": "uint256"}]}]}';

  it("gives an ABI interface the text of Python's json.dumps", async () => {
    const sent = await sentFor({ "src/IOld.json": ENTRY, "src/IEmpty.json": { abi: [] } });
    assert.deepEqual(sent, {
      language: "Vyper",
      sources: {
        "src/A.vy": { content: "x: uint256\n" },
        "src/IOld.json": { content: PYTHON },
        "src/IEmpty.json": { content: '{"abi": []}' },
      },
      settings: { evmVersion: "cancun" },
    });
  });

  it("keeps a content interface's text, and a source over an interface of its path", async () => {
    const sent = await sentFor({
      "src/I.vyi": { content: "@external\ndef f():\n    ...\n" },
      "src/A.vy": { abi: [] },
    });
    assert.deepEqual(sent, {
      language: "Vyper",
      sources: {
        "src/A.vy": { content: "x: uint256\n" },
        "src/I.vyi": { content: "@external\ndef f():\n    ...\n" },
      },
      settings: { evmVersion: "cancun" },
    });
  });

  it("sends an input without interfaces as it is", async () => {
    assert.deepEqual(await sentFor(undefined), {
      language: "Vyper",
      sources: { "src/A.vy": { content: "x: uint256\n" } },
      settings: { evmVersion: "cancun" },
    });
  });

  it("sends no interfaces key for Foundry's empty interfaces object", async () => {
    const sent = await sentFor({});
    assert.deepEqual(sent, {
      language: "Vyper",
      sources: { "src/A.vy": { content: "x: uint256\n" } },
      settings: { evmVersion: "cancun" },
    });
    assert.ok(typeof sent === "object" && sent !== null);
    assert.equal(Object.hasOwn(sent, "interfaces"), false);
  });

  it("keeps an interface whose path is __proto__ as a key of sources", async () => {
    const interfaces: unknown = JSON.parse('{"__proto__": {"content": "# interface\\n"}}');
    assert.ok(typeof interfaces === "object" && interfaces !== null);
    const sent = await sentFor(Object.fromEntries(Object.entries(interfaces)));
    assert.ok(typeof sent === "object" && sent !== null);
    const sources: unknown = Reflect.get(sent, "sources");
    assert.ok(typeof sources === "object" && sources !== null);
    assert.deepEqual(Object.keys(sources), ["src/A.vy", "__proto__"]);
    assert.deepEqual(Object.getOwnPropertyDescriptor(sources, "__proto__")?.value, {
      content: "# interface\n",
    });
  });
});

const INTERFACE = {
  "IGreeter.vyi": { content: "@external\ndef greet() -> uint256:\n    ...\n" },
};

/** Contract B's input, with `interfaces` when given. */
function withInterfaces(version: string, interfaces?: Record<string, unknown>): VerifyInput {
  const base = older(B, version, "Greeter.vy:Greeter");
  assert.ok(base.compiler.kind === "vyper");
  return validateInput({
    ...base,
    compiler: {
      ...base.compiler,
      input: { ...base.compiler.input, ...(interfaces === undefined ? {} : { interfaces }) },
    },
  });
}

/** Asserts the refusal of 0.3.x input with interfaces. */
function isRefusal(error: unknown): true {
  assert.ok(error instanceof ExplorerVerifyError, String(error));
  assert.deepEqual(error.details, {
    code: "unsupported-compiler",
    field: "compiler.input.interfaces",
  });
  assert.equal(
    error.message,
    "Sourcify does not verify Vyper 0.3.10+commit.91361694 input with interfaces: before Vyper 0.4.0 the compiler cannot read an interface from sources, and Sourcify refuses a top-level interfaces field.",
  );
  assert.equal(
    error.hint,
    "Inline each interface into the contract source, or build the contract with Vyper 0.4.0 or later, then verify again.",
  );
  return true;
}

describe("Vyper 0.3.x input with interfaces (decision 0077)", () => {
  it("is refused by verify(), dryRun() and verifyEach() before any request", async () => {
    const input = withInterfaces("0.3.10+commit.91361694", INTERFACE);
    for (const route of [undefined, { backend: "sourcify" } as const]) {
      const fake = replay();
      await assert.rejects(runVerify(input, { fetch: fake.fetch, route }, DEPENDENCIES), isRefusal);
      await assert.rejects(runDryRun(input, { fetch: fake.fetch, route }, DEPENDENCIES), isRefusal);
      assert.deepEqual(fake.calls, []);
    }
    const fake = replay();
    await assert.rejects(
      runVerifyEach(input, { fetch: fake.fetch, backends: "all" }, DEPENDENCIES),
      isRefusal,
    );
    assert.deepEqual(fake.calls, []);
  });

  it("passes 0.3.10 input with an empty interfaces object, and 0.4.0 input with interfaces", () => {
    assert.equal(
      inputCheck(withInterfaces("0.3.10+commit.91361694", {})).verifies("sourcify"),
      true,
    );
    assert.equal(inputCheck(withInterfaces("0.3.10+commit.91361694")).verifies("sourcify"), true);
    assert.equal(
      inputCheck(withInterfaces("0.4.0+commit.e9db8d9f", INTERFACE)).verifies("sourcify"),
      true,
    );
    assert.equal(inputCheck(scoreboard()).verifies("blockscout"), false);
    // A solc 0.3.x input that carries an extra interfaces key is not Vyper: every backend maps it.
    const solidity: SolidityStandardJsonInput = {
      language: "Solidity",
      sources: { "A.sol": { content: "contract A {}" } },
      settings: {},
    };
    const extras = { interfaces: INTERFACE };
    const solc: VerifyInput = {
      chainId: SEPOLIA,
      address: B,
      contractName: "A.sol:A",
      compiler: {
        kind: "solc",
        version: "0.3.6+commit.3fc68da5",
        input: { ...solidity, ...extras },
      },
    };
    assert.equal(inputCheck(solc).verifies("sourcify"), true);
    assert.equal(inputCheck(solc).verifies("blockscout"), true);
  });

  it("leaves another backend that maps Vyper, and refuses Sourcify by name", () => {
    const routes = {
      vyper: [
        ["sourcify", "every"],
        ["blockscout", [SEPOLIA]],
      ],
    } as const;
    const check = inputCheck(withInterfaces("0.3.10+commit.91361694", INTERFACE), routes);
    assert.equal(check.verifies("sourcify"), false);
    assert.equal(check.verifies("blockscout"), true);
    assert.equal(check.verifies("routescan"), false);
    isRefusal(check.refused("sourcify"));
    const other = check.refused("routescan");
    assert.equal(
      other.message,
      "The routescan backend does not verify vyper input on chain 11155111.",
    );
    assert.throws(
      () =>
        inputCheck(withInterfaces("0.3.10+commit.91361694", INTERFACE), {
          vyper: [["blockscout", [1]]],
        }),
      (error) =>
        ExplorerVerifyError.is(error, "unsupported-compiler") &&
        error.message.startsWith("No backend"),
    );
  });
});

describe("the Vyper capability list (R-EXT-1, decision 0075)", () => {
  it("maps Sourcify on every chain and no other backend", () => {
    assert.deepEqual(VYPER_ROUTES, [["sourcify", "every"]]);
    for (const chainId of [1, SEPOLIA, 324, 300, 8453, 999999]) {
      const check = kindCheck("vyper", chainId);
      assert.equal(check.verifies("sourcify"), true);
      for (const other of [
        "etherscan-v2",
        "blockscout",
        "blockscout-hosted",
        "routescan",
        "etherscan-compatible",
      ] as const) {
        assert.equal(check.verifies(other), false, other);
      }
    }
  });
});
