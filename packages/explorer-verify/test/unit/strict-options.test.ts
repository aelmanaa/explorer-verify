// R-IN-6: every public function refuses an options key it does not read, names the key and the
// closest known name, and never repeats the key's value (R-SEC-1). A field set to `undefined`
// counts as absent.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { toEnvelope } from "../../src/envelope.ts";
import { eachOptionKeys } from "../../src/flow/verify-each.ts";
import { settingsOf } from "../../src/flow/verify.ts";
import { MAX_TIMER_MS } from "../../src/http/fetch.ts";
import {
  buildVerifyInput,
  checkStatus,
  dryRun,
  ExplorerVerifyError,
  linkProxy,
  routesFor,
  verify,
  verifyEach,
} from "../../src/index.ts";
import type {
  Handle,
  InputIssue,
  LinkProxyTarget,
  VerifyInput,
  VerifyOptions,
} from "../../src/index.ts";
import { buildVerifyInputFromBytecode } from "../../src/input/resolvers/bytecode.ts";
import { ownKeys, unknownKeys } from "../../src/internal/known-keys.ts";
import { createVerifyHandler } from "../../src/server/handler.ts";
import { loadFixture, replay } from "../helpers/fake-fetch.ts";

const SEPOLIA = 11155111;
const GREETER = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const DUMMY_KEY = "DUMMYKEY216ABCDEFGHIJKLMNOPQRSTU";

function input(): VerifyInput {
  return {
    chainId: SEPOLIA,
    address: GREETER,
    compiler: {
      kind: "solc",
      version: "0.8.24+commit.e11b9ed9",
      input: {
        language: "Solidity",
        sources: { "contracts/Greeter.sol": { content: "contract Greeter {}" } },
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
    },
    contractName: "contracts/Greeter.sol:Greeter",
  };
}

const HANDLE: Handle = {
  version: 1,
  backend: "sourcify",
  chainId: SEPOLIA,
  address: GREETER,
  jobId: "550e8400-e29b-41d4-a716-446655440000",
};

/** A fetch that fails the test if it is ever called. */
function noFetch(): { fetch: typeof fetch; calls: () => number } {
  let count = 0;
  return {
    fetch: async () => {
      count += 1;
      return await Promise.reject(new Error("no request expected"));
    },
    calls: () => count,
  };
}

/** A logger that records every line it gets. */
function lines(): { logger: VerifyOptions["logger"]; seen: string[] } {
  const seen: string[] = [];
  const log = (message: string, fields?: unknown): void => {
    seen.push(`${message} ${JSON.stringify(fields)}`);
  };
  return { logger: { debug: log, info: log, warn: log, error: log }, seen };
}

/** Calls `run` with arguments typed as `unknown`, as a JavaScript caller would pass them. */
function untyped(run: (...args: never[]) => unknown, ...args: unknown[]): unknown {
  const result: unknown = Reflect.apply(run, undefined, args);
  return result;
}

async function rejection(pending: unknown): Promise<ExplorerVerifyError> {
  const error = await Promise.resolve(pending).then(
    () => new Error("expected a rejection"),
    (reason: unknown) => reason,
  );
  assert.ok(error instanceof ExplorerVerifyError, String(error));
  return error;
}

function thrown(run: () => unknown): ExplorerVerifyError {
  let caught: unknown = new Error("expected a throw");
  try {
    run();
  } catch (error: unknown) {
    caught = error;
  }
  assert.ok(caught instanceof ExplorerVerifyError, String(caught));
  return caught;
}

function issuesOf(error: ExplorerVerifyError): readonly InputIssue[] {
  assert.equal(error.code, "invalid-input");
  assert.ok(error.details.code === "invalid-input");
  return error.details.issues;
}

/** Whether `text` shows up anywhere in the error: message, hint, details or JSON. */
function shows(error: ExplorerVerifyError, text: string): boolean {
  return [error.message, error.hint, JSON.stringify(error.details), JSON.stringify(error)].some(
    (part) => part.includes(text),
  );
}

describe("R-IN-6: verify() refuses an unknown option before any request", () => {
  it("names timeout and suggests timeoutMs, with zero fetch calls", async () => {
    const fake = noFetch();
    const error = await rejection(untyped(verify, input(), { fetch: fake.fetch, timeout: 5 }));
    assert.deepEqual(issuesOf(error), [
      { field: "timeout", message: "is not a known option; did you mean timeoutMs?" },
    ]);
    assert.equal(error.message, "The options are invalid: timeout.");
    assert.equal(fake.calls(), 0);
  });

  it("suggests signal for signa, and lists every unknown key with the other issues", async () => {
    const fake = noFetch();
    const error = await rejection(
      untyped(verify, input(), {
        fetch: fake.fetch,
        signa: new AbortController().signal,
        timeoutMs: -1,
        pollIntervalms: 5,
      }),
    );
    assert.deepEqual(issuesOf(error), [
      { field: "signa", message: "is not a known option; did you mean signal?" },
      { field: "pollIntervalms", message: "is not a known option; did you mean pollIntervalMs?" },
      { field: "timeoutMs", message: "must be a positive number of milliseconds" },
    ]);
    assert.equal(fake.calls(), 0);
  });

  it("never repeats the value of an unknown key in the error or a log line (R-SEC-1)", async () => {
    const fake = noFetch();
    const { logger, seen } = lines();
    const error = await rejection(
      untyped(verify, input(), {
        fetch: fake.fetch,
        logger,
        apikey: DUMMY_KEY,
        timeout: DUMMY_KEY,
      }),
    );
    assert.deepEqual(issuesOf(error), [
      { field: "apikey", message: "is not a known option; did you mean apiKeys?" },
      { field: "timeout", message: "is not a known option; did you mean timeoutMs?" },
    ]);
    assert.ok(!shows(error, DUMMY_KEY));
    assert.deepEqual(seen, []);
    assert.equal(fake.calls(), 0);
  });

  it("does not repeat a key that is not a short identifier with few digits (R-SEC-1)", async () => {
    const fake = noFetch();
    const long = `x${"a".repeat(32)}`;
    // Key-shaped: 32 characters, 16 of them digits.
    const hex = "abcdef0123456789abcdef0123456789";
    const error = await rejection(
      untyped(verify, input(), {
        fetch: fake.fetch,
        [DUMMY_KEY.replace("D", "0")]: 1,
        "has space": 1,
        [long]: 1,
        [hex]: 1,
        abc1234567: 1,
      }),
    );
    const issue = { field: "options", message: "is not a known option" };
    assert.deepEqual(issuesOf(error), [
      issue,
      issue,
      issue,
      issue,
      { field: "abc1234567", message: "is not a known option" },
    ]);
    for (const text of ["has space", long, hex, "0UMMY"]) {
      assert.ok(!shows(error, text), text);
    }
  });

  it("refuses an array as the options (D2)", async () => {
    for (const run of [verify, dryRun]) {
      const error = await rejection(untyped(run, input(), []));
      assert.deepEqual(issuesOf(error), [{ field: "options", message: "must be a plain object" }]);
    }
  });

  it("routesFor() names an unknown key, refuses an array and takes undefined as absent", async () => {
    const error = await rejection(untyped(routesFor, SEPOLIA, { allowFallback: true }));
    assert.deepEqual(issuesOf(error), [
      { field: "allowFallback", message: "is not a known option" },
    ]);
    const array = await rejection(untyped(routesFor, SEPOLIA, []));
    assert.deepEqual(issuesOf(array), [{ field: "options", message: "must be a plain object" }]);
    const misspelled = await rejection(untyped(routesFor, SEPOLIA, { apikeys: {} }));
    assert.deepEqual(issuesOf(misspelled), [
      { field: "apikeys", message: "is not a known option; did you mean apiKeys?" },
    ]);
    const routes = await routesFor(SEPOLIA, {
      apiKeys: undefined,
      allowSourcifyFallback: undefined,
    });
    assert.ok(routes.listed.length > 0);
  });

  it("buildVerifyInputFromBytecode() refuses an array as the options, with keys or without (D2)", async () => {
    const fake = noFetch();
    for (const options of [[], Object.assign([], { bytecode: "0x6080", fetch: fake.fetch })]) {
      const error = await rejection(
        untyped(buildVerifyInputFromBytecode, { chainId: SEPOLIA, address: GREETER }, options),
      );
      assert.deepEqual(issuesOf(error), [{ field: "options", message: "must be a plain object" }]);
    }
    assert.equal(fake.calls(), 0);
  });

  it("gives no suggestion when no name is close, or for a key of one or two characters", async () => {
    const error = await rejection(untyped(verify, input(), { zz: 1, unrelated: 1, s: 1 }));
    assert.deepEqual(issuesOf(error), [
      { field: "zz", message: "is not a known option" },
      { field: "unrelated", message: "is not a known option" },
      { field: "s", message: "is not a known option" },
    ]);
  });

  it("never runs a getter on an unknown key, and ignores Symbol and non-enumerable keys", async () => {
    let ran = false;
    const options = {
      get trap(): number {
        ran = true;
        return 1;
      },
    };
    const error = await rejection(untyped(verify, input(), options));
    assert.deepEqual(issuesOf(error), [{ field: "trap", message: "is not a known option" }]);
    assert.equal(ran, false);

    const fake = replay(loadFixture("sourcify", "2026-11-02-lookup-exact-match"));
    const hidden: VerifyOptions = { fetch: fake.fetch };
    Object.defineProperty(hidden, "timeout", { value: 5, enumerable: false });
    Reflect.set(hidden, Symbol("timeout"), 5);
    const result = await verify(input(), hidden);
    assert.equal(result.status, "already-verified");
  });

  it("gives could not be read when listing the keys throws, without the trap's text", async () => {
    const options = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error(DUMMY_KEY);
        },
      },
    );
    const error = await rejection(untyped(verify, input(), options));
    assert.deepEqual(issuesOf(error), [{ field: "options", message: "could not be read" }]);
    assert.ok(!shows(error, DUMMY_KEY));
  });

  it("refuses an unknown key of route with the closest name", async () => {
    const fake = noFetch();
    const error = await rejection(
      untyped(verify, input(), {
        fetch: fake.fetch,
        route: { backend: "sourcify", apiurl: "https://sourcify.example.org/server" },
      }),
    );
    assert.deepEqual(issuesOf(error), [
      { field: "route.apiurl", message: "is not a known option; did you mean apiUrl?" },
    ]);
    assert.equal(fake.calls(), 0);
  });
});

/** One options object for verify(), as a caller passes it to the other flow functions too. */
function sharedOptions(fetch: typeof globalThis.fetch): VerifyOptions {
  return { fetch, timeoutMs: 60_000, pollIntervalMs: 1_000, rpcUrl: "https://rpc.example.org" };
}

describe("R-IN-6: verify, dryRun, checkStatus and linkProxy accept every VerifyOptions key", () => {
  it("dryRun() checks pollIntervalMs and rpcUrl as verify() does, and refuses backends", async () => {
    const fake = noFetch();
    const error = await rejection(
      untyped(dryRun, input(), {
        fetch: fake.fetch,
        backends: ["sourcify"],
        pollIntervalMs: -1,
        rpcUrl: `ftp://rpc.example.org/${DUMMY_KEY}`,
      }),
    );
    assert.deepEqual(issuesOf(error), [
      { field: "backends", message: "is not a known option" },
      { field: "pollIntervalMs", message: "must be a positive finite number of milliseconds" },
      { field: "rpcUrl", message: "must use https, or http on localhost, 127.0.0.1 or [::1]" },
    ]);
    assert.ok(!shows(error, DUMMY_KEY));
    assert.equal(fake.calls(), 0);
  });

  it("checkStatus() takes an options object built for verify(), rpcUrl included, and checks it", async () => {
    const fake = noFetch();
    const error = await rejection(
      untyped(checkStatus, HANDLE, {
        fetch: fake.fetch,
        pollIntervalMs: 1_000,
        rpcUrl: "ftp://rpc.example.org",
      }),
    );
    assert.deepEqual(issuesOf(error), [
      { field: "rpcUrl", message: "must use https, or http on localhost, 127.0.0.1 or [::1]" },
    ]);
    assert.equal(fake.calls(), 0);
  });

  it("linkProxy() names a misspelled pollIntervalMs and checks rpcUrl", async () => {
    const fake = noFetch();
    const target: LinkProxyTarget = { chainId: SEPOLIA, address: GREETER };
    const error = await rejection(
      untyped(linkProxy, target, {
        fetch: fake.fetch,
        rpcUrl: "ftp://rpc.example.org",
        pollIntervalMS: 1_000,
      }),
    );
    assert.deepEqual(issuesOf(error), [
      { field: "pollIntervalMS", message: "is not a known option; did you mean pollIntervalMs?" },
      { field: "rpcUrl", message: "must use https, or http on localhost, 127.0.0.1 or [::1]" },
    ]);
    assert.equal(fake.calls(), 0);
  });

  it("one options object goes to verify(), dryRun() and checkStatus()", async () => {
    const dry = replay(loadFixture("sourcify", "2026-11-02-lookup-exact-match"));
    assert.equal((await dryRun(input(), sharedOptions(dry.fetch))).lookup, "exact");
    const status = replay(loadFixture("sourcify", "2026-11-02-job-exact-match"));
    const checked = await checkStatus(
      { ...HANDLE, jobId: "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718" },
      sharedOptions(status.fetch),
    );
    assert.equal(checked.status, "verified");
  });

  it("verifyEach() refuses a misspelled backends and keeps its own issue for route", async () => {
    const fake = noFetch();
    const misspelled = await rejection(
      untyped(verifyEach, input(), {
        fetch: fake.fetch,
        backend: ["sourcify"],
      }),
    );
    assert.deepEqual(issuesOf(misspelled), [
      { field: "backend", message: "is not a known option; did you mean backends?" },
    ]);
    const route = await rejection(
      untyped(verifyEach, input(), {
        fetch: fake.fetch,
        backends: ["sourcify"],
        route: { backend: "sourcify" },
      }),
    );
    assert.equal(issuesOf(route)[0]?.field, "route");
    assert.equal(fake.calls(), 0);
  });
});

describe("R-IN-6: an option set to undefined counts as absent", () => {
  it("verify() runs with every optional option and input field undefined", async () => {
    const fake = replay(loadFixture("sourcify", "2026-11-02-lookup-exact-match"));
    const options: Required<VerifyOptions> = {
      fetch: fake.fetch,
      handlerUrl: undefined,
      signal: undefined,
      timeoutMs: undefined,
      pollIntervalMs: undefined,
      indexWaitMs: undefined,
      logger: undefined,
      onEvent: undefined,
      route: { backend: "sourcify", apiUrl: undefined, apiKey: undefined },
      allowSourcifyFallback: undefined,
      apiKeys: undefined,
      rpcUrl: undefined,
    };
    const value: VerifyInput = {
      ...input(),
      constructorArgs: undefined,
      creationTxHash: undefined,
      creationBytecode: undefined,
      libraries: undefined,
    };
    const result = await verify(value, options);
    assert.equal(result.status, "already-verified");
    assert.equal(fake.calls.length, 1);
  });

  it("dryRun() and checkStatus() run with undefined options", async () => {
    const dry = replay(loadFixture("sourcify", "2026-11-02-lookup-exact-match"));
    const result = await dryRun(input(), {
      fetch: dry.fetch,
      timeoutMs: undefined,
      route: undefined,
    });
    assert.equal(result.lookup, "exact");
    const status = replay(loadFixture("sourcify", "2026-11-02-job-exact-match"));
    const checked = await checkStatus(
      { ...HANDLE, jobId: "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718" },
      {
        fetch: status.fetch,
        pollIntervalMs: undefined,
        apiKeys: undefined,
      },
    );
    assert.equal(checked.status, "verified");
  });
});

describe("R-IN-6: builders, the envelope and the handler refuse unknown options", () => {
  it("buildVerifyInput() names the key and the closest option", () => {
    const error = thrown(() =>
      untyped(buildVerifyInput, [input().compiler.input], { contracts: "a.sol:A", sources: {} }),
    );
    assert.deepEqual(issuesOf(error), [
      { field: "contracts", message: "is not a known option; did you mean contract?" },
    ]);
    assert.equal(error.hint, "Pass only contract, compilerVersion and sources as options.");
  });

  it("buildVerifyInput() and toEnvelope() never run a getter on an unknown key (D1)", () => {
    for (const run of [
      (options: object) => buildVerifyInput([input().compiler.input], options),
      (options: object) =>
        untyped(toEnvelope, { status: "failed", backend: "sourcify", reason: "x" }, options),
    ]) {
      let ran = false;
      const options = {};
      Object.defineProperty(options, "trap", {
        enumerable: true,
        get: () => {
          ran = true;
          throw new Error(DUMMY_KEY);
        },
      });
      const error = thrown(() => run(options));
      assert.deepEqual(issuesOf(error), [{ field: "trap", message: "is not a known option" }]);
      assert.equal(ran, false);
      assert.ok(!shows(error, DUMMY_KEY));
    }
  });

  it("buildVerifyInput() takes undefined options as absent", () => {
    const built = buildVerifyInput([input().compiler.input], {
      contract: "contracts/Greeter.sol:Greeter",
      compilerVersion: "0.8.24+commit.e11b9ed9",
      sources: undefined,
    });
    assert.equal(built.contractName, "contracts/Greeter.sol:Greeter");
  });

  it("buildVerifyInputFromBytecode() names the key with the other issues, before any request", async () => {
    const fake = noFetch();
    const error = await rejection(
      untyped(
        buildVerifyInputFromBytecode,
        { chainId: SEPOLIA, address: GREETER },
        {
          fetch: fake.fetch,
          rpcURL: `https://rpc.example.org/${DUMMY_KEY}`,
        },
      ),
    );
    assert.deepEqual(issuesOf(error), [
      { field: "rpcURL", message: "is not a known option; did you mean rpcUrl?" },
      { field: "rpcUrl", message: "must be passed exactly when bytecode is absent" },
    ]);
    assert.ok(!shows(error, DUMMY_KEY));
    assert.equal(fake.calls(), 0);
  });

  it("toEnvelope() names the key and lists it in the message, as the other functions do (D4)", () => {
    const error = thrown(() =>
      untyped(
        toEnvelope,
        { status: "failed", backend: "sourcify", reason: "x" },
        {
          secret: [DUMMY_KEY],
        },
      ),
    );
    assert.deepEqual(issuesOf(error), [
      { field: "secret", message: "is not a known option; did you mean secrets?" },
    ]);
    assert.equal(error.message, "The options are invalid: secret.");
    assert.ok(!shows(error, DUMMY_KEY));
    const envelope = toEnvelope(
      { status: "failed", backend: "sourcify", reason: "x" },
      { secrets: undefined },
    );
    assert.equal(envelope.ok, false);
  });

  it("createVerifyHandler() names the key and never repeats the operator's key", () => {
    const error = thrown(() =>
      untyped(createVerifyHandler, { apiKey: DUMMY_KEY, chains: [1], deployer: [GREETER] }),
    );
    assert.deepEqual(issuesOf(error), [
      { field: "deployer", message: "is not a known option; did you mean deployers?" },
    ]);
    assert.ok(!shows(error, DUMMY_KEY));
    const proxy = new Proxy(
      { apiKey: DUMMY_KEY, chains: [1] },
      {
        ownKeys: () => {
          throw new Error("trap");
        },
      },
    );
    assert.deepEqual(issuesOf(thrown(() => untyped(createVerifyHandler, proxy))), [
      { field: "options", message: "must be a plain object" },
    ]);
    assert.equal(
      typeof createVerifyHandler({ apiKey: DUMMY_KEY, chains: [1], deployers: undefined }),
      "function",
    );
  });
});

describe("unknownKeys(): the suggestion rule", () => {
  it("suggests a name equal ignoring case, or a prefix either way, the shortest first", () => {
    assert.deepEqual(
      unknownKeys(
        ["TIMEOUTMS", "timeout", "apikey", "tiemoutMs"],
        ["timeoutMs", "apiKeys"],
        "",
        "options",
      ),
      [
        { field: "TIMEOUTMS", message: "is not a known option; did you mean timeoutMs?" },
        { field: "timeout", message: "is not a known option; did you mean timeoutMs?" },
        { field: "apikey", message: "is not a known option; did you mean apiKeys?" },
        { field: "tiemoutMs", message: "is not a known option" },
      ],
    );
    assert.deepEqual(unknownKeys(["outDirectory"], ["outDirX", "out", "outDir"], "", "options"), [
      { field: "outDirectory", message: "is not a known option; did you mean out?" },
    ]);
    assert.deepEqual(unknownKeys(["abc"], ["abcd", "abce"], "", "options"), [
      { field: "abc", message: "is not a known option; did you mean abcd?" },
    ]);
  });

  it("names the prefix for a key it does not repeat", () => {
    assert.deepEqual(unknownKeys(["1x"], ["backend"], "route.", "route"), [
      { field: "route", message: "is not a known option" },
    ]);
  });
});

// The helpers cannot import an internal module of the core, so each holds a copy.
/** A copy of the rule without its imports and its first doc comment. */
const body = (url: URL): string =>
  readFileSync(url, "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("import "))
    .join("\n")
    .replace(/^\/\/ References:[^\n]*\n/, "")
    .replace(/^\/\*\*[\s\S]*?\*\/\n/, "");

// Mutation testing runs on an instrumented copy of the core in a sandbox without the helpers, so
// the source text cannot match there. The check runs in every normal test run.
const mutating = Reflect.has(globalThis, "__stryker__");

describe("the copies of the rule in the Foundry and Hardhat helpers", { skip: mutating }, () => {
  const core = mutating ? "" : body(new URL("../../src/internal/known-keys.ts", import.meta.url));

  for (const helper of ["foundry", "hardhat"]) {
    it(`${helper} holds the same code as the core`, () => {
      assert.equal(body(new URL(`../../../${helper}/src/known-keys.ts`, import.meta.url)), core);
    });
  }
});

describe("ownKeys() (R-IN-6)", () => {
  it("lists own enumerable keys, and gives undefined for a non-object, an array or a Proxy that throws", () => {
    assert.deepEqual(ownKeys({ a: 1 }), ["a"]);
    for (const value of [
      undefined,
      null,
      "x",
      [],
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error("trap");
          },
        },
      ),
    ]) {
      assert.equal(ownKeys(value), undefined);
    }
  });
});

describe("R-IN-6: indexWaitMs is checked like the other durations (decision 0066)", () => {
  for (const [value, label] of [
    [-1, "-1"],
    [0, "0"],
    [Number.NaN, "NaN"],
    ["60000", "a string"],
  ] as const) {
    it(`verify() and verifyEach() refuse an indexWaitMs of ${label} before any request`, async () => {
      const fake = noFetch();
      const expected = [
        { field: "indexWaitMs", message: "must be a positive number of milliseconds" },
      ];
      const one = await rejection(
        untyped(verify, input(), { fetch: fake.fetch, indexWaitMs: value }),
      );
      assert.deepEqual(issuesOf(one), expected);
      const each = await rejection(
        untyped(verifyEach, input(), {
          fetch: fake.fetch,
          backends: ["sourcify"],
          indexWaitMs: value,
        }),
      );
      assert.deepEqual(issuesOf(each), expected);
      assert.equal(fake.calls(), 0);
    });
  }

  it("names indexWaitMs for a misspelled key", async () => {
    const fake = noFetch();
    const error = await rejection(untyped(verify, input(), { fetch: fake.fetch, indexWait: 1 }));
    assert.deepEqual(issuesOf(error), [
      { field: "indexWait", message: "is not a known option; did you mean indexWaitMs?" },
    ]);
  });

  it("settingsOf() keeps a value, raises it to 1, lowers Infinity to 2147483647, and leaves it undefined when absent", () => {
    assert.equal(settingsOf({ indexWaitMs: 60_000 }).indexWaitMs, 60_000);
    assert.equal(settingsOf({ indexWaitMs: 0.5 }).indexWaitMs, 1);
    assert.equal(settingsOf({ indexWaitMs: Number.POSITIVE_INFINITY }).indexWaitMs, MAX_TIMER_MS);
    assert.equal(settingsOf({ timeoutMs: 1_000 }).indexWaitMs, undefined);
    assert.equal(settingsOf(undefined).indexWaitMs, undefined);
    assert.equal(settingsOf({ indexWaitMs: 5_000 }, eachOptionKeys()).indexWaitMs, 5_000);
  });

  it("dryRun() accepts it, as it accepts every verify() option", async () => {
    const fake = replay(loadFixture("sourcify", "2026-11-02-lookup-exact-match"));
    const options: VerifyOptions = {
      indexWaitMs: 60_000,
      fetch: fake.fetch,
      route: { backend: "sourcify" },
    };
    const dry = await dryRun(input(), options);
    assert.equal(dry.backend, "sourcify");
  });
});
