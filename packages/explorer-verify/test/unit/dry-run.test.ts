// Tests for dryRun() (R-AX-8): the steps of verify() before the submit. Every request goes to a
// fake fetch that replays recorded Sourcify answers; a submit or a poll fails the test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { Backend } from "../../src/backends/backend.ts";
import { sourcify } from "../../src/backends/sourcify.ts";
import { exitCodeOf, toEnvelope } from "../../src/envelope.ts";
import { ExplorerVerifyError, dryRun } from "../../src/index.ts";
import type { DryRunResult, VerifyEvent, VerifyInput } from "../../src/index.ts";
import { runDryRun } from "../helpers/defaults.ts";
import { loadFixture, replay } from "../helpers/fake-fetch.ts";
import { compileStrict, validateEnvelope } from "./envelope-schema.ts";

const SEPOLIA = 11155111;
// The Greeter deployed on Sepolia on 2026-11-02, whose responses the fixtures recorded.
const GREETER = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const GREETER_PAGE = `https://repo.sourcify.dev/${String(SEPOLIA)}/${GREETER}`;
const LOOKUP_URL = `https://sourcify.dev/server/v2/contract/${String(SEPOLIA)}/${GREETER}`;
const ETHERSCAN_API = "https://api.etherscan.io/v2/api";
// A fake key. Never a real one (R-SEC-1).
const KEY = "dryrun-dummy-key-7c1e";

function input(): VerifyInput {
  return {
    chainId: SEPOLIA,
    address: "0x8275D36F64F047D2D8a1F42c79Bf80Caea39D7cC",
    compiler: {
      kind: "solc",
      version: "0.8.24+commit.e11b9ed9",
      input: {
        language: "Solidity",
        sources: { "src/Greeter.sol": { content: "contract Greeter {}" } },
        settings: {},
      },
    },
    contractName: "src/Greeter.sol:Greeter",
  };
}

/** A submit or a poll, which a dry run never sends. */
function fail(): Promise<never> {
  return Promise.reject(new Error("no submit or poll expected"));
}

/** A keyed backend whose every request is counted; its lookup finds an exact match. */
function keyedBackend(): { backend: Backend; lookups: () => number } {
  let lookups = 0;
  return {
    backend: {
      name: "etherscan-v2",
      lookup: async () => {
        lookups += 1;
        return await Promise.resolve("exact");
      },
      submit: fail,
      poll: fail,
      explorerUrl: () => undefined,
    },
    lookups: () => lookups,
  };
}

describe("dryRun (R-AX-8)", () => {
  it("looks the contract up once and reports none, without a submit", async () => {
    const fake = replay(loadFixture("sourcify", "2026-11-02-lookup-not-verified"));
    const events: VerifyEvent[] = [];
    const result = await dryRun(input(), {
      fetch: fake.fetch,
      onEvent: (event) => {
        events.push(event);
      },
    });
    assert.deepEqual(result, {
      status: "dry-run",
      backend: "sourcify",
      apiHost: "sourcify.dev",
      lookup: "none",
      routedBy: "table",
    });
    assert.deepEqual(
      fake.calls.map(({ method, url }) => `${method} ${url}`),
      [`GET ${LOOKUP_URL}`],
    );
    assert.deepEqual(events, [
      { type: "verify.validated", chainId: SEPOLIA, address: GREETER },
      {
        type: "verify.routed",
        backend: "sourcify",
        apiHost: "sourcify.dev",
        routedBy: "table",
        skipped: "etherscan-v2",
      },
      { type: "verify.lookup", backend: "sourcify", lookup: "none" },
    ]);
  });

  it("reports an exact match with the explorer page, so verify() would not submit", async () => {
    const fake = replay(loadFixture("sourcify", "2026-11-02-lookup-exact-match"));
    const lines: string[] = [];
    const log = (message: string): void => {
      lines.push(message);
    };
    const result = await dryRun(input(), {
      fetch: fake.fetch,
      logger: { debug: log, info: log, warn: log, error: log },
    });
    assert.deepEqual(result, {
      status: "dry-run",
      backend: "sourcify",
      apiHost: "sourcify.dev",
      lookup: "exact",
      explorerUrl: GREETER_PAGE,
      routedBy: "table",
    });
    assert.ok(
      lines.includes(
        "Dry run: sourcify already holds the contract (exact match), so a verification would not submit.",
      ),
    );
  });

  it("gives no explorer page for a route to another server", async () => {
    const fake = replay(loadFixture("sourcify", "2026-11-02-lookup-exact-match"));
    const result = await dryRun(input(), {
      fetch: fake.fetch,
      route: { apiUrl: "http://127.0.0.1:5555" },
    });
    assert.deepEqual(result, {
      status: "dry-run",
      backend: "sourcify",
      apiHost: "127.0.0.1:5555",
      lookup: "exact",
      routedBy: "api-url",
    });
  });

  it("skips the lookup and sends nothing when a keyed backend has no key", async (t) => {
    const spy = t.mock.method(globalThis, "fetch", () => Promise.reject(new Error("no request")));
    const keyed = keyedBackend();
    const events: VerifyEvent[] = [];
    const lines: string[] = [];
    const result = await runDryRun(
      input(),
      {
        route: { backend: "etherscan-v2", apiUrl: ETHERSCAN_API },
        onEvent: (event) => {
          events.push(event);
        },
        logger: {
          debug: () => undefined,
          info: (message) => {
            lines.push(message);
          },
          warn: () => undefined,
          error: () => undefined,
        },
      },
      { backends: { sourcify, "etherscan-v2": keyed.backend } },
    );
    assert.deepEqual(result, {
      status: "dry-run",
      backend: "etherscan-v2",
      apiHost: "api.etherscan.io",
      lookup: "skipped",
      routedBy: "api-url",
    });
    assert.equal(keyed.lookups(), 0);
    assert.equal(spy.mock.callCount(), 0);
    assert.deepEqual(events.at(-1), {
      type: "verify.lookup",
      backend: "etherscan-v2",
      lookup: "skipped",
    });
    assert.ok(lines.some((line) => line.includes("skipped the lookup")));
  });

  it("looks up a keyed backend when the key is set", async () => {
    const keyed = keyedBackend();
    const result = await runDryRun(
      input(),
      { route: { backend: "etherscan-v2", apiUrl: ETHERSCAN_API, apiKey: KEY } },
      { backends: { sourcify, "etherscan-v2": keyed.backend } },
    );
    assert.equal(result.lookup, "exact");
    assert.equal(keyed.lookups(), 1);
    assert.ok(!JSON.stringify(result).includes(KEY));
  });

  it("skips the lookup of a keyed backend without a key, even when fetch is injected (decision 0046)", async () => {
    const keyed = keyedBackend();
    const result = await runDryRun(
      input(),
      {
        fetch: () => Promise.reject(new Error("no request")),
        route: { backend: "etherscan-v2", apiUrl: ETHERSCAN_API },
      },
      { backends: { sourcify, "etherscan-v2": keyed.backend } },
    );
    assert.equal(result.lookup, "skipped");
    assert.equal(keyed.lookups(), 0);
  });

  it("looks up a keyed backend without a key through handlerUrl (R-SRV-5, decision 0046)", async () => {
    const keyed = keyedBackend();
    const result = await runDryRun(
      input(),
      {
        fetch: () => Promise.reject(new Error("no request")),
        handlerUrl: "https://dapp.example/api/verify",
      },
      { backends: { sourcify, "etherscan-v2": keyed.backend } },
    );
    assert.equal(result.backend, "etherscan-v2");
    assert.equal(result.lookup, "exact");
    assert.equal(keyed.lookups(), 1);
  });

  it("throws invalid-input for a bad input before any request", async () => {
    const fake = replay();
    await assert.rejects(dryRun({ ...input(), chainId: 0 }, { fetch: fake.fetch }), (error) => {
      assert.ok(error instanceof ExplorerVerifyError);
      assert.equal(error.code, "invalid-input");
      return true;
    });
    assert.equal(fake.calls.length, 0);
  });

  it("rejects with the signal's reason, unchanged, when aborted (R-FLOW-6)", async () => {
    const reason = new Error("stop");
    const before = new AbortController();
    before.abort(reason);
    await assert.rejects(dryRun(input(), { signal: before.signal }), (error) => error === reason);

    const during = new AbortController();
    const fetch: typeof globalThis.fetch = async () => {
      during.abort(reason);
      return await Promise.reject(new Error("aborted"));
    };
    await assert.rejects(
      dryRun(input(), { fetch, signal: during.signal }),
      (error) => error === reason,
    );
  });
});

/** A value typed as a `DryRunResult` without a cast, as code that bypasses the types passes. */
function bypass(value: unknown): DryRunResult {
  const holder: { result: DryRunResult } = {
    result: { status: "dry-run", backend: "sourcify", apiHost: "sourcify.dev", lookup: "none" },
  };
  Reflect.set(holder, "result", value);
  return holder.result;
}

/** The fields an invalid-input error names. */
function fields(error: unknown): string[] {
  assert.ok(error instanceof ExplorerVerifyError);
  const { details } = error;
  assert.equal(details.code, "invalid-input");
  return details.code === "invalid-input" ? details.issues.map((issue) => issue.field) : [];
}

describe("toEnvelope and exitCodeOf of a DryRunResult (R-AX-5, R-AX-8)", () => {
  it("gives ok true and exit code 0, with the fields in the schema's order", () => {
    const result: DryRunResult = {
      explorerUrl: GREETER_PAGE,
      lookup: "exact",
      apiHost: "sourcify.dev",
      backend: "sourcify",
      status: "dry-run",
    };
    const envelope = toEnvelope(result);
    assert.equal(
      JSON.stringify(envelope),
      `{"schemaVersion":1,"ok":true,"result":{"status":"dry-run","backend":"sourcify","apiHost":"sourcify.dev","lookup":"exact","explorerUrl":"${GREETER_PAGE}"}}`,
    );
    assert.deepEqual(validateEnvelope(envelope), []);
    assert.equal(exitCodeOf(result), 0);
    const skipped: DryRunResult = {
      status: "dry-run",
      backend: "etherscan-v2",
      apiHost: "api.etherscan.io",
      lookup: "skipped",
    };
    assert.deepEqual(toEnvelope(skipped), { schemaVersion: 1, ok: true, result: skipped });
  });

  it("redacts the strings and drops fields the result does not declare", () => {
    const result = bypass({
      status: "dry-run",
      backend: "sourcify",
      apiHost: `${KEY}.example.org`,
      lookup: "partial",
      explorerUrl: `https://example.org/${KEY}`,
      extra: KEY,
    });
    const text = JSON.stringify(toEnvelope(result, { secrets: [KEY] }));
    assert.ok(!text.includes(KEY));
    assert.ok(!text.includes("extra"));
  });

  it("throws invalid-input for a dry-run result that bypassed the types", () => {
    const bad: unknown = { status: "dry-run", backend: "nowhere", lookup: "maybe", explorerUrl: 1 };
    assert.throws(
      () => exitCodeOf(bypass(bad)),
      (error) => {
        assert.deepEqual(fields(error), [
          "outcome.backend",
          "outcome.apiHost",
          "outcome.lookup",
          "outcome.explorerUrl",
        ]);
        return true;
      },
    );
  });
});

describe("the shipped schemas (R-AX-5, R-AX-16)", () => {
  it("the envelope schema accepts the dry-run envelope the CLI prints, and only that shape", () => {
    const base = { status: "dry-run", backend: "sourcify", apiHost: "sourcify.dev" };
    for (const lookup of ["exact", "partial", "none", "skipped"]) {
      const result = { ...base, lookup };
      assert.deepEqual(validateEnvelope({ schemaVersion: 1, ok: true, result }), [], lookup);
    }
    const page = { ...base, lookup: "exact", explorerUrl: GREETER_PAGE };
    assert.deepEqual(validateEnvelope({ schemaVersion: 1, ok: true, result: page }), []);
    const bad = { ...base, lookup: "maybe" };
    assert.notDeepEqual(validateEnvelope({ schemaVersion: 1, ok: true, result: bad }), []);
    const notOk = { ...base, lookup: "none" };
    assert.notDeepEqual(validateEnvelope({ schemaVersion: 1, ok: false, result: notOk }), []);
  });

  it("the input schema compiles in strict mode and has no key field", () => {
    const text = readFileSync(new URL("../../schema/input.schema.json", import.meta.url), "utf8");
    const check = compileStrict(JSON.parse(text));
    assert.deepEqual(check({ ...input(), route: { backend: "sourcify" } }), []);
    assert.deepEqual(check({ handle: `ev1:sourcify:${String(SEPOLIA)}:${GREETER}:job` }), []);
    assert.notDeepEqual(check({ ...input(), extra: 1 }), []);
    assert.notDeepEqual(check({ handle: "ev1:x", route: { apiKey: KEY } }), []);
    assert.ok(!/apikey|api_key|"key"/i.test(text));
  });
});
