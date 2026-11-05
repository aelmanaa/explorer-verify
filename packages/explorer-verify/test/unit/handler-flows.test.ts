// `handlerUrl` through the public flows (R-SRV-5, R-SEC-1, R-SEC-2, decision 0046): a key bound
// to a route through the handler is refused by every entry point before any request; the routing
// table chooses as if an Etherscan key were set; log lines, events and errors name the handler;
// a refusal of the handler names its code.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ExplorerVerifyError,
  checkStatus,
  dryRun,
  linkProxy,
  verify,
  verifyEach,
} from "../../src/index.ts";
import type { VerifyEvent, VerifyInput } from "../../src/index.ts";
import { loadFixture, responseOf } from "../helpers/fake-fetch.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";

const SEPOLIA = 11155111;
const GREETER = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const GREETER_JOB = "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718";
const HANDLER = "https://dapp.example/api/verify";
// A fake key. Never a real one (R-SEC-1).
const ROUTE_KEY = "dummy-route-key-handler-217";

function input(chainId: number = SEPOLIA): VerifyInput {
  return {
    chainId,
    address: GREETER,
    compiler: {
      kind: "solc",
      version: "0.8.24+commit.e11b9ed9",
      input: {
        language: "Solidity",
        sources: { "contracts/Greeter.sol": { content: "contract Greeter {}" } },
        settings: {},
      },
    },
    contractName: "contracts/Greeter.sol:Greeter",
  };
}

/** A fetch that records each URL and answers with `answer`, or throws when there is none. */
function recorder(answer?: () => Response): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (target, init) => {
      urls.push(
        typeof target === "string" ? target : target instanceof URL ? target.href : target.url,
      );
      assert.ok(answer !== undefined, "no request expected");
      const body = init?.body;
      assert.ok(
        !(body instanceof URLSearchParams) || body.get("apikey") === null,
        "a key was sent",
      );
      return await Promise.resolve(answer());
    },
  };
}

async function rejection(call: Promise<unknown>): Promise<ExplorerVerifyError> {
  const outcome = await call.then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(outcome instanceof ExplorerVerifyError, String(outcome));
  return outcome;
}

function fieldsOf(error: ExplorerVerifyError): string[] {
  return error.details.code === "invalid-input"
    ? error.details.issues.map((issue) => issue.field)
    : [];
}

describe("a key bound to a route through the handler is refused by every entry point (decision 0046)", () => {
  // Spellings of Etherscan's own API URL that resolve to its origin.
  for (const apiUrl of [
    "https://api.etherscan.io/v2/api",
    "https://api.etherscan.io/v2/api/",
    "https://API.ETHERSCAN.IO/v2/api",
    "https://api.etherscan.io:443/v2/api",
  ]) {
    const route = { backend: "etherscan-v2" as const, apiUrl, apiKey: ROUTE_KEY };
    const calls: [string, (fetch: typeof globalThis.fetch) => Promise<unknown>][] = [
      ["verify", async (fetch) => await verify(input(), { fetch, handlerUrl: HANDLER, route })],
      ["dryRun", async (fetch) => await dryRun(input(), { fetch, handlerUrl: HANDLER, route })],
      [
        "checkStatus",
        async (fetch) =>
          await checkStatus(`ev1:etherscan-v2:${String(SEPOLIA)}:${GREETER}:guid0001`, {
            fetch,
            handlerUrl: HANDLER,
            route,
          }),
      ],
      [
        "linkProxy",
        async (fetch) =>
          await linkProxy(
            { chainId: SEPOLIA, address: GREETER },
            {
              fetch,
              handlerUrl: HANDLER,
              route,
            },
          ),
      ],
      [
        "verifyEach",
        async (fetch) =>
          await verifyEach(input(), { fetch, handlerUrl: HANDLER, backends: [route] }).then(
            (result) => {
              const [only] = result.outcomes;
              if (only !== undefined && "error" in only) {
                throw only.error;
              }
              return result;
            },
          ),
      ],
    ];
    for (const [name, call] of calls) {
      it(`${name} with apiUrl ${apiUrl}: invalid-input naming route.apiKey, no request, no key shown`, async () => {
        const net = recorder();
        const error = await rejection(call(net.fetch));
        assert.deepEqual(fieldsOf(error), ["route.apiKey"]);
        assert.deepEqual(net.urls, []);
        assert.ok(!JSON.stringify([error.message, error.hint, error.toJSON()]).includes(ROUTE_KEY));
      });
    }
  }
});

describe("the routing table chooses as if an Etherscan key were set (decision 0046)", () => {
  it("a chain whose row lists Etherscan first goes to the handler, which the result and events name", async () => {
    const net = recorder(() =>
      responseOf(loadFixture("etherscan", "2026-11-04-getsourcecode-sepolia-greeter")),
    );
    const events: VerifyEvent[] = [];
    const lines: string[] = [];
    const record = (message: string, fields?: unknown): void => {
      lines.push(`${message} ${JSON.stringify(fields)}`);
    };
    const result = await dryRun(input(), {
      fetch: net.fetch,
      handlerUrl: HANDLER,
      logger: { debug: record, info: record, warn: record, error: record },
      onEvent: (event) => {
        events.push(event);
      },
    });
    assert.equal(result.backend, "etherscan-v2");
    assert.equal(result.apiHost, "dapp.example");
    assert.deepEqual(net.urls, [`${HANDLER}?chainid=${String(SEPOLIA)}`]);
    const routed = events.find((event) => event.type === "verify.routed");
    assert.ok(routed !== undefined && routed.type === "verify.routed");
    assert.equal(routed.apiHost, "dapp.example");
    assert.ok(lines.some((line) => line.includes("https://dapp.example/api/verify")));
    assert.ok(
      lines.every((line) => !line.includes("api.etherscan.io")),
      lines.join("\n"),
    );
  });

  it("a chain whose row lists no Etherscan entry still goes to Sourcify", async () => {
    // Chain 14 (Flare) has a Sourcify row and no Etherscan entry.
    const net = recorder(
      () =>
        new Response(
          JSON.stringify({
            match: null,
            creationMatch: null,
            runtimeMatch: null,
            chainId: "14",
            address: GREETER,
          }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await dryRun(input(14), { fetch: net.fetch, handlerUrl: HANDLER });
    assert.equal(result.backend, "sourcify");
    assert.ok(net.urls.every((url) => !url.startsWith(HANDLER)));
  });

  it("checkStatus resumes a Sourcify handle with handlerUrl set, on a chain where verify() chose Sourcify", async () => {
    // Base Sepolia (84532) needs a paid Etherscan plan, so its row lists Sourcify first: with
    // handlerUrl, as with a key, verify() and checkStatus() both route there.
    const recorded = responseOf(loadFixture("sourcify", "2026-11-02-job-exact-match"));
    const job = (await recorded.text()).replaceAll("11155111", "84532");
    const net = recorder(
      () => new Response(job, { headers: { "content-type": "application/json" } }),
    );
    const result = await checkStatus(`ev1:sourcify:84532:${GREETER}:${GREETER_JOB}`, {
      fetch: net.fetch,
      handlerUrl: HANDLER,
    });
    assert.equal(result.status, "verified");
    assert.equal(result.backend, "sourcify");
    assert.ok(net.urls.every((url) => !url.startsWith(HANDLER)));
  });
});

/** A JSON answer of the server handler. */
function handlerAnswer(status: number, body: unknown): () => Response {
  return () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

function refusalOf(code: string): unknown {
  return { status: "0", message: "NOTOK", result: "Refused.", code };
}

describe("a refusal of the server handler names its code (decision 0046)", () => {
  for (const [code, status] of [
    ["chain-not-allowed", 403],
    ["address-not-allowed", 403],
    ["address-not-indexed", 404],
    ["action-not-allowed", 403],
    ["forbidden-field", 400],
    ["body-too-large", 413],
    ["method-not-allowed", 405],
    ["unsupported-media-type", 415],
    ["bad-request", 400],
  ] as const) {
    it(`a ${String(status)} ${code} is not retryable and points at the handler's options (R1)`, async () => {
      const net = recorder(handlerAnswer(status, refusalOf(code)));
      const error = await rejection(dryRun(input(), { fetch: net.fetch, handlerUrl: HANDLER }));
      assert.equal(error.code, "unexpected-response");
      assert.equal(error.retryable, false);
      assert.equal(error.toJSON().retryable, false);
      assert.match(
        error.message,
        new RegExp(`Your server handler refused the lookup with ${code}`),
      );
      assert.doesNotMatch(error.message, /Etherscan/);
      assert.match(error.hint, /createVerifyHandler options/);
      assert.deepEqual(net.urls, [`${HANDLER}?chainid=${String(SEPOLIA)}`]);
    });
  }

  it("a 500 internal-error stays retryable and names the code", async () => {
    const net = recorder(handlerAnswer(500, refusalOf("internal-error")));
    const error = await rejection(dryRun(input(), { fetch: net.fetch, handlerUrl: HANDLER }));
    assert.equal(error.retryable, true);
    assert.match(error.message, /refused the lookup with internal-error \(status 500\)/);
    assert.doesNotMatch(error.hint, /createVerifyHandler/);
  });

  it("a 502 upstream-error stays retryable, after the retries, and names the code", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const net = recorder(handlerAnswer(502, refusalOf("upstream-error")));
    const call = dryRun(input(), { fetch: net.fetch, handlerUrl: HANDLER });
    await driveMockClock(call, () => {
      t.mock.timers.runAll();
    });
    const error = await rejection(call);
    assert.equal(error.code, "unexpected-response");
    assert.equal(error.retryable, true);
    assert.match(
      error.message,
      /^POST https:\/\/dapp\.example\/api\/verify\?REDACTED answered 502 after .* The handler's code: upstream-error\.$/,
    );
    assert.ok(net.urls.length > 1, "retried");
  });

  it("an answer it does not recognise names the server handler, not Etherscan (item 1)", async () => {
    const net = recorder(handlerAnswer(418, { hello: "world" }));
    const error = await rejection(dryRun(input(), { fetch: net.fetch, handlerUrl: HANDLER }));
    assert.equal(error.code, "unexpected-response");
    assert.match(error.message, /^Your server handler gave an answer to the lookup/);
    assert.equal(error.retryable, true);
  });

  it("without handlerUrl, an answer with a code field is Etherscan's own", async () => {
    const answer = handlerAnswer(403, refusalOf("chain-not-allowed"));
    const error = await rejection(
      dryRun(input(), {
        fetch: async () => await Promise.resolve(answer()),
        apiKeys: { "etherscan-v2": "dummy-etherscan-key-217" },
      }),
    );
    assert.match(error.message, /^Etherscan gave an answer to the lookup/);
    assert.equal(error.retryable, true);
  });
});
