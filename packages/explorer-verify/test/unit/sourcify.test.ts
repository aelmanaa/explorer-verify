import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";
import { setImmediate } from "node:timers";
import { inspect } from "node:util";

import type { Context, Target } from "../../src/backends/backend.ts";
import {
  DEFINITIVE_CODES,
  REASON_LENGTH,
  TRANSIENT_CODES,
  sourcify,
} from "../../src/backends/sourcify.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import type { HttpContext } from "../../src/http/fetch.ts";
import { validateInput } from "../../src/input/validate.ts";
import { createObserver } from "../../src/observe.ts";
import type { Handle, Logger, RouteOverride, VerifyInput } from "../../src/types.ts";
import { loadFixture, replay, responseOf } from "../helpers/fake-fetch.ts";
import type { Fixture, Step } from "../helpers/fake-fetch.ts";
import { resolveRoute } from "../helpers/route.ts";

const API = "https://sourcify.dev/server";
const SEPOLIA = 11155111;
// The Greeter deployed on Sepolia on 2026-11-02, whose responses the fixtures recorded.
const GREETER = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const GREETER_TX = "0xbde6884cf580e2b10b46bf5f02138b989ad23b0d1619700baf46ee3cc1f31cf2";
const GREETER_JOB = "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718";
// The contract of the older recorded lookup and of the no_match job.
const OTHER = "0xa6b01960ea6e942ada412c76456bc9465682f3ab";
const NO_MATCH_JOB = "dea83eb0-3918-449b-a914-3038dd554b42";
// Fake keys. Never real ones (R-SEC-1).
const SECRET = "DUMMYSECRETq7w3e9r1t5y";
const PLANTED = "PLANTEDKEYz8x6c4v2b0n";

function fixture(name: string): Fixture {
  return loadFixture("sourcify", `2026-11-02-${name}`);
}

/** A fixture with its JSON body changed by `edit`. */
function edited(name: string, edit: (body: Record<string, unknown>) => void): Response {
  const recorded = fixture(name);
  const body: unknown = structuredClone(recorded.response.body);
  assert.ok(typeof body === "object" && body !== null && !Array.isArray(body));
  const copy: Record<string, unknown> = { ...body };
  edit(copy);
  return new Response(JSON.stringify(copy), {
    status: recorded.response.status,
    headers: { ...recorded.response.headers },
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

interface SetupOptions {
  route?: RouteOverride;
  chainId?: number;
  logger?: Logger;
  signal?: AbortSignal;
  secrets?: string[];
}

function setup(
  steps: Step[],
  options: SetupOptions = {},
): { ctx: Context; calls: ReturnType<typeof replay>["calls"] } {
  const fake = replay(...steps);
  const http: HttpContext = {
    backend: "sourcify",
    fetch: fake.fetch,
    secrets: options.secrets ?? [],
    random: () => 0,
    ...(options.logger === undefined
      ? {}
      : { observer: createObserver({ logger: options.logger, secrets: options.secrets ?? [] }) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  return {
    ctx: {
      route: resolveRoute(options.chainId ?? SEPOLIA, options.route, {
        allowSourcifyFallback: true,
      }),
      http,
    },
    calls: fake.calls,
  };
}

function target(address: string = GREETER, chainId: number = SEPOLIA): Target {
  const checked = validateInput({ ...rawInput(), chainId, address });
  return { chainId: checked.chainId, address: checked.address };
}

function handle(jobId: string, address: string = GREETER, chainId: number = SEPOLIA): Handle {
  const { address: hex } = target(address, chainId);
  return { version: 1, backend: "sourcify", chainId, address: hex, jobId };
}

function rawInput(): Record<string, unknown> {
  return {
    chainId: SEPOLIA,
    address: "0x8275D36F64F047D2D8a1F42c79Bf80Caea39D7cC",
    compiler: {
      kind: "solc",
      version: "v0.8.24+commit.e11b9ed9",
      input: {
        language: "Solidity",
        sources: {
          "contracts/Greeter.sol": { content: "contract Greeter {}" },
          "contracts/Base.sol": { content: "abstract contract Base {}" },
        },
        settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
      },
    },
    contractName: "contracts/Greeter.sol:Greeter",
    constructorArgs: "0x0000000000000000000000009d087fc03ae39b088326b67fa3c788236645b717",
    creationTxHash: GREETER_TX,
  };
}

function input(change: (raw: Record<string, unknown>) => void = () => {}): VerifyInput {
  const raw = rawInput();
  change(raw);
  return validateInput(raw);
}

async function errorOf(promise: Promise<unknown>): Promise<ExplorerVerifyError> {
  const outcome: unknown = await promise.then(
    () => "resolved",
    (error: unknown) => error,
  );
  assert.ok(
    outcome instanceof ExplorerVerifyError,
    `expected ExplorerVerifyError, got ${String(outcome)}`,
  );
  return outcome;
}

function bodyOf(calls: ReturnType<typeof replay>["calls"], index: number): Record<string, unknown> {
  const text = calls[index]?.body;
  assert.ok(text !== undefined);
  const parsed: unknown = JSON.parse(text);
  assert.ok(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
  return { ...parsed };
}

function spyLogger(): { logger: Logger; warnings: string[]; lines: string[] } {
  const warnings: string[] = [];
  const lines: string[] = [];
  return {
    logger: {
      debug: (m) => lines.push(m),
      info: (m) => lines.push(m),
      warn: (m) => {
        warnings.push(m);
        lines.push(m);
      },
      error: (m) => lines.push(m),
    },
    warnings,
    lines,
  };
}

/** A response whose headers arrive and whose body then fails. */
function brokenBody(status: number): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new TypeError("connection reset"));
    },
  });
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

/** Runs the mocked timers until `promise` settles; `setImmediate` is not mocked. */
async function drive<T>(t: TestContext, promise: Promise<T>): Promise<T> {
  const state = { done: false };
  const tracked = promise.finally(() => {
    state.done = true;
  });
  tracked.catch(() => {});
  for (let round = 0; round < 100 && !state.done; round += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    if (!state.done) {
      t.mock.timers.runAll();
    }
  }
  return await tracked;
}

/** Every text an error shows: message, hint, details, JSON and the inspected object. */
function surfaces(error: ExplorerVerifyError): string {
  return [
    error.message,
    error.hint,
    JSON.stringify(error),
    JSON.stringify(error.details),
    inspect(error, { depth: 10 }),
  ].join("\n");
}

describe("sourcify backend", () => {
  it("is named sourcify (R-BE-6)", () => {
    assert.equal(sourcify.name, "sourcify");
  });

  describe("lookup", () => {
    it("reads a 200 exact_match as exact, without fields=all (R-BE-4, R-FLOW-3)", async () => {
      const { ctx, calls } = setup([fixture("lookup-exact-match")]);
      assert.equal(await sourcify.lookup(target(), ctx), "exact");
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.method, "GET");
      assert.equal(calls[0]?.url, `${API}/v2/contract/${String(SEPOLIA)}/${GREETER}`);
    });

    it("reads a 200 match as partial (R-BE-4, R-FLOW-3)", async () => {
      const { ctx } = setup([fixture("lookup-match")]);
      assert.equal(await sourcify.lookup(target(OTHER), ctx), "partial");
    });

    it("reads a 404 with null match fields as not verified (R-BE-4)", async () => {
      const { ctx } = setup([fixture("lookup-not-verified")]);
      assert.equal(await sourcify.lookup(target(), ctx), undefined);
    });

    it("throws unsupported-chain on a 400 unsupported_chain (R-BE-4)", async () => {
      const { ctx } = setup([fixture("lookup-unsupported-chain")], { chainId: 9429413 });
      const error = await errorOf(sourcify.lookup(target(OTHER, 9429413), ctx));
      const { details } = error;
      assert.ok(details.code === "unsupported-chain", error.message);
      assert.equal(details.chainId, 9429413);
      assert.equal(details.backend, "sourcify");
    });

    it("throws on a 500 and never reads it as not verified (R-FLOW-4)", async () => {
      const { ctx, calls } = setup([fixture("lookup-internal-error")]);
      const error = await errorOf(sourcify.lookup(target(), ctx));
      const { details } = error;
      assert.ok(details.code === "unexpected-response", error.message);
      assert.equal(details.status, 500);
      assert.match(details.excerpt, /internal_error/);
      assert.equal(calls.length, 1);
    });

    const unrecognised: [string, () => Response][] = [
      ["a 200 without the match fields", () => json(200, { chainId: "11155111" })],
      ["a 200 with a null match", () => edited("lookup-exact-match", (b) => (b.match = null))],
      ["a 200 with an unknown grade", () => edited("lookup-exact-match", (b) => (b.match = "x"))],
      ["a 404 that is not JSON", () => new Response("<html>Not Found</html>", { status: 404 })],
      ["a 404 with a match", () => json(404, { match: "match" })],
      ["a 404 without the match fields", () => json(404, { error: "no route" })],
      ["a JSON array", () => json(200, [{ match: "exact_match" }])],
      [
        "a 400 with another code",
        () => json(400, { customCode: "invalid_parameter", message: "bad address" }),
      ],
      ["a 400 without a code", () => json(400, { message: "bad" })],
      ["a 403", () => json(403, { message: "forbidden" })],
      [
        "a 200 about another address",
        () => edited("lookup-exact-match", (b) => (b.address = OTHER)),
      ],
      ["a 200 about another chain", () => edited("lookup-exact-match", (b) => (b.chainId = "1"))],
      [
        "a 200 with the chain id in an array",
        () => edited("lookup-exact-match", (b) => (b.chainId = ["11155111"])),
      ],
      [
        "a 200 with the chain id in hex",
        () => edited("lookup-exact-match", (b) => (b.chainId = "0xaa36a7")),
      ],
      ["a 200 without a chain id", () => edited("lookup-exact-match", (b) => delete b.chainId)],
      ["a 200 without an address", () => edited("lookup-exact-match", (b) => delete b.address)],
      ["a 404 without an address", () => edited("lookup-not-verified", (b) => delete b.address)],
      [
        "a 500 that says unsupported_chain",
        () => json(500, { customCode: "unsupported_chain", message: "m" }),
      ],
      [
        "a 400 whose customCode is not a string",
        () => json(400, { customCode: ["unsupported_chain"], message: "m" }),
      ],
      [
        "a 200 with an address that is not a string",
        () => edited("lookup-exact-match", (b) => (b.address = 1)),
      ],
    ];
    for (const [name, response] of unrecognised) {
      it(`throws unexpected-response on ${name}, never "not verified" (R-FLOW-4)`, async () => {
        const { ctx } = setup([response()]);
        const error = await errorOf(sourcify.lookup(target(), ctx));
        assert.equal(error.code, "unexpected-response");
        assert.equal(error.retryable, true);
      });
    }

    it("accepts a numeric chain id and an address in another case (R-BE-4)", async () => {
      const response = edited("lookup-exact-match", (b) => {
        b.chainId = SEPOLIA;
        b.address = GREETER.toUpperCase().replace("0X", "0x");
      });
      const { ctx } = setup([response]);
      assert.equal(await sourcify.lookup(target(), ctx), "exact");
    });

    it("retries a network error, then reads the answer (R-FLOW-6)", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const { ctx, calls } = setup([new TypeError("fetch failed"), fixture("lookup-exact-match")]);
      assert.equal(await drive(t, sourcify.lookup(target(), ctx)), "exact");
      assert.equal(calls.length, 2);
    });

    it("keeps the caller's query string and sends it to the overridden server (R-RT-2)", async () => {
      const { ctx, calls } = setup([fixture("lookup-not-verified")], {
        route: { apiUrl: "http://127.0.0.1:5555/server/?token=abc" },
      });
      assert.equal(await sourcify.lookup(target(), ctx), undefined);
      assert.equal(
        calls[0]?.url,
        `http://127.0.0.1:5555/server/v2/contract/${String(SEPOLIA)}/${GREETER}?token=abc`,
      );
    });
  });

  describe("submit", () => {
    it("returns a handle for a 202 with a UUID verificationId (R-BE-4, R-FLOW-5)", async () => {
      const { ctx, calls } = setup([fixture("submit-accepted")]);
      const outcome = await sourcify.submit(input(), ctx);
      assert.deepEqual(outcome, {
        state: "submitted",
        handle: {
          version: 1,
          backend: "sourcify",
          chainId: SEPOLIA,
          address: GREETER,
          jobId: GREETER_JOB,
        },
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.method, "POST");
      assert.equal(calls[0]?.url, `${API}/v2/verify/${String(SEPOLIA)}/${GREETER}`);
      assert.equal(calls[0]?.headers.get("content-type"), "application/json");
    });

    it("sends stdJsonInput as an object with only language, sources and settings (R-BE-4)", async () => {
      const { ctx, calls } = setup([fixture("submit-accepted")]);
      const withExtras = input((raw) => {
        const compiler = raw.compiler;
        assert.ok(typeof compiler === "object" && compiler !== null);
        const stdJson: unknown = Reflect.get(compiler, "input");
        assert.ok(typeof stdJson === "object" && stdJson !== null);
        Reflect.set(stdJson, "auxiliaryInput", { smtlib2responses: {} });
      });
      await sourcify.submit(withExtras, ctx);
      const body = bodyOf(calls, 0);
      assert.deepEqual(Object.keys(body).toSorted(), [
        "compilerVersion",
        "contractIdentifier",
        "creationTransactionHash",
        "stdJsonInput",
      ]);
      const stdJson = body.stdJsonInput;
      assert.ok(typeof stdJson === "object" && stdJson !== null && !Array.isArray(stdJson));
      assert.deepEqual(Object.keys(stdJson).toSorted(), ["language", "settings", "sources"]);
      assert.deepEqual(stdJson, {
        language: "Solidity",
        sources: {
          "contracts/Greeter.sol": { content: "contract Greeter {}" },
          "contracts/Base.sol": { content: "abstract contract Base {}" },
        },
        settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
      });
      assert.equal(body.compilerVersion, "0.8.24+commit.e11b9ed9");
      assert.equal(body.contractIdentifier, "contracts/Greeter.sol:Greeter");
      assert.equal(body.creationTransactionHash, GREETER_TX);
    });

    it("never sends constructor arguments, and omits creationTransactionHash when unset (R-BE-4)", async () => {
      const { ctx, calls } = setup([fixture("submit-accepted")]);
      await sourcify.submit(
        input((raw) => {
          delete raw.creationTxHash;
        }),
        ctx,
      );
      const text = calls[0]?.body ?? "";
      assert.ok(!text.includes("9d087fc03ae39b088326b67fa3c788236645b717"));
      assert.ok(!Object.hasOwn(bodyOf(calls, 0), "creationTransactionHash"));
      assert.ok(!Object.hasOwn(bodyOf(calls, 0), "constructorArguments"));
    });

    it("sends a source path holding &apikey=x as data, not as a parameter (R-SEC-2)", async () => {
      const path = "contracts/a&apikey=x.sol";
      const { ctx, calls } = setup([fixture("submit-accepted")]);
      await sourcify.submit(
        input((raw) => {
          raw.compiler = {
            kind: "solc",
            version: "0.8.24+commit.e11b9ed9",
            input: { language: "Solidity", sources: { [path]: { content: "x" } }, settings: {} },
          };
          raw.contractName = `${path}:Greeter`;
        }),
        ctx,
      );
      const url = new URL(calls[0]?.url ?? "");
      assert.equal(url.search, "");
      assert.equal(url.searchParams.has("apikey"), false);
      const body = bodyOf(calls, 0);
      assert.equal(body.contractIdentifier, `${path}:Greeter`);
      const stdJson = body.stdJsonInput;
      assert.ok(typeof stdJson === "object" && stdJson !== null);
      assert.deepEqual(Reflect.get(stdJson, "sources"), { [path]: { content: "x" } });
    });

    it("returns already-verified exact on a 409 already_verified (R-BE-4, R-FLOW-3)", async () => {
      const { ctx } = setup([fixture("submit-already-verified")]);
      assert.deepEqual(await sourcify.submit(input(), ctx), {
        state: "already-verified",
        match: "exact",
      });
    });

    it("throws unsupported-chain on a 400 unsupported_chain (R-BE-4)", async () => {
      const { ctx } = setup([fixture("submit-unsupported-chain")], { chainId: 9429413 });
      const error = await errorOf(
        sourcify.submit(
          input((raw) => (raw.chainId = 9429413)),
          ctx,
        ),
      );
      const { details } = error;
      assert.ok(details.code === "unsupported-chain", error.message);
      assert.equal(details.chainId, 9429413);
    });

    it("throws unexpected-response on a 400 invalid_parameter (R-BE-4, R-FLOW-4)", async () => {
      const { ctx } = setup([fixture("submit-invalid-parameter")]);
      const error = await errorOf(sourcify.submit(input(), ctx));
      const { details } = error;
      assert.ok(details.code === "unexpected-response", error.message);
      assert.equal(details.status, 400);
      assert.match(details.excerpt, /invalid_parameter/);
    });

    it("throws in-progress on a 429 duplicate_verification_request (R-BE-4)", async () => {
      const { ctx, calls } = setup([fixture("submit-duplicate")]);
      const error = await errorOf(sourcify.submit(input(), ctx));
      const { details } = error;
      assert.ok(details.code === "in-progress", error.message);
      assert.equal(details.backend, "sourcify");
      assert.equal(calls.length, 1);
    });

    const unrecognised: [string, () => Response][] = [
      ["a 202 without a verificationId", () => json(202, {})],
      ["a 202 whose verificationId is not a UUID", () => json(202, { verificationId: "abc" })],
      [
        "a 202 whose verificationId has trailing text",
        () => json(202, { verificationId: `${GREETER_JOB}x` }),
      ],
      [
        "a 409 that says unsupported_chain",
        () => json(409, { customCode: "unsupported_chain", message: "m" }),
      ],
      ["a 200", () => json(200, { verificationId: GREETER_JOB })],
      ["a 409 with another code", () => json(409, { customCode: "conflict" })],
    ];
    for (const [name, response] of unrecognised) {
      it(`throws unexpected-response on ${name}, with no lookup (R-FLOW-4)`, async () => {
        const { ctx, calls } = setup([response()]);
        const error = await errorOf(sourcify.submit(input(), ctx));
        assert.equal(error.code, "unexpected-response");
        assert.equal(calls.length, 1);
      });
    }

    it("throws unexpected-response on a redirect, with no lookup (R-SEC-2)", async () => {
      const redirect = new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere.example.org/" },
      });
      const { ctx, calls } = setup([redirect]);
      const error = await errorOf(sourcify.submit(input(), ctx));
      const { details } = error;
      assert.ok(details.code === "unexpected-response", error.message);
      assert.equal(details.status, 302);
      assert.equal(calls.length, 1);
    });

    describe("after a submit that may have reached Sourcify", () => {
      it("looks up first and returns already-verified when the contract is verified", async () => {
        const { ctx, calls } = setup([
          new TypeError("fetch failed"),
          fixture("lookup-exact-match"),
        ]);
        assert.deepEqual(await sourcify.submit(input(), ctx), {
          state: "already-verified",
          match: "exact",
        });
        assert.deepEqual(
          calls.map((call) => call.method),
          ["POST", "GET"],
        );
      });

      it("returns the lookup's partial match after a 502", async () => {
        const { ctx, calls } = setup([
          json(502, { message: "bad gateway" }),
          fixture("lookup-match"),
        ]);
        const outcome = await sourcify.submit(
          input((raw) => (raw.address = OTHER)),
          ctx,
        );
        assert.deepEqual(outcome, { state: "already-verified", match: "partial" });
        assert.equal(calls.length, 2);
      });

      it("submits once more after a 500 when the lookup finds nothing, and logs it", async () => {
        const { logger, warnings } = spyLogger();
        const { ctx, calls } = setup(
          [
            fixture("submit-internal-error"),
            fixture("lookup-not-verified"),
            fixture("submit-accepted"),
          ],
          { logger },
        );
        const outcome = await sourcify.submit(input(), ctx);
        assert.equal(outcome.state, "submitted");
        assert.deepEqual(
          calls.map((call) => call.method),
          ["POST", "GET", "POST"],
        );
        assert.equal(calls[2]?.body, calls[0]?.body);
        assert.ok(warnings.some((line) => line.includes("Looking the contract up")));
      });

      it("throws in-progress when the second submit finds a job running, with no job id", async () => {
        const { ctx } = setup([
          new TypeError("fetch failed"),
          fixture("lookup-not-verified"),
          fixture("submit-duplicate"),
        ]);
        const error = await errorOf(sourcify.submit(input(), ctx));
        assert.equal(error.code, "in-progress");
      });

      it("looks up after a first 504", async () => {
        const { ctx, calls } = setup([
          json(504, { message: "gateway timeout" }),
          fixture("lookup-exact-match"),
        ]);
        assert.deepEqual(await sourcify.submit(input(), ctx), {
          state: "already-verified",
          match: "exact",
        });
        assert.deepEqual(
          calls.map((call) => call.method),
          ["POST", "GET"],
        );
      });

      it("looks up after a 202 whose body fails after the headers", async () => {
        const { ctx, calls } = setup([brokenBody(202), fixture("lookup-exact-match")]);
        assert.deepEqual(await sourcify.submit(input(), ctx), {
          state: "already-verified",
          match: "exact",
        });
        assert.equal(calls.length, 2);
      });

      it("looks up after a 202 that is not JSON, and submits once more", async () => {
        const { ctx, calls } = setup([
          new Response("accepted", { status: 202 }),
          fixture("lookup-not-verified"),
          fixture("submit-accepted"),
        ]);
        const outcome = await sourcify.submit(input(), ctx);
        assert.equal(outcome.state, "submitted");
        assert.equal(calls.length, 3);
      });

      it("throws the second failure and sends no third submit", async () => {
        const { ctx, calls } = setup([
          new TypeError("fetch failed"),
          fixture("lookup-not-verified"),
          json(504, { message: "gateway timeout" }),
        ]);
        const error = await errorOf(sourcify.submit(input(), ctx));
        const { details } = error;
        assert.ok(details.code === "unexpected-response", error.message);
        assert.equal(details.status, 504);
        assert.equal(calls.filter((call) => call.method === "POST").length, 2);
      });

      it("throws network when both submits get no response", async () => {
        const { ctx } = setup([
          new TypeError("fetch failed"),
          fixture("lookup-not-verified"),
          new TypeError("fetch failed"),
        ]);
        const error = await errorOf(sourcify.submit(input(), ctx));
        const { details } = error;
        assert.ok(details.code === "network", error.message);
        assert.equal(details.attempts, 1);
      });

      it("throws the lookup's error when the lookup fails, and submits no more", async () => {
        const { ctx, calls } = setup([
          new TypeError("fetch failed"),
          fixture("lookup-internal-error"),
        ]);
        const error = await errorOf(sourcify.submit(input(), ctx));
        const { details } = error;
        assert.ok(details.code === "unexpected-response", error.message);
        assert.equal(details.status, 500);
        assert.match(error.message, /may already have been accepted/);
        assert.equal(calls.length, 2);
      });

      it("rejects with the signal's reason when the recovery lookup is aborted (R-FLOW-6)", async () => {
        const controller = new AbortController();
        const reason = new Error("stop");
        const { logger } = spyLogger();
        const aborting: Logger = {
          ...logger,
          warn: () => {
            controller.abort(reason);
          },
        };
        const { ctx } = setup([new TypeError("fetch failed"), fixture("lookup-exact-match")], {
          logger: aborting,
          signal: controller.signal,
        });
        await assert.rejects(sourcify.submit(input(), ctx), (error) => error === reason);
      });
    });

    it("rejects with the signal's reason, unchanged, when aborted (R-FLOW-6)", async () => {
      const controller = new AbortController();
      const reason = new Error("stop");
      controller.abort(reason);
      const { ctx, calls } = setup([fixture("submit-accepted")], { signal: controller.signal });
      await assert.rejects(sourcify.submit(input(), ctx), (error) => error === reason);
      assert.equal(calls.length, 0);
    });

    it("throws timeout without a lookup when the budget is spent (R-FLOW-4)", async () => {
      const fake = replay(fixture("submit-accepted"));
      const { logger, warnings } = spyLogger();
      const ctx: Context = {
        route: resolveRoute(SEPOLIA),
        http: {
          backend: "sourcify",
          fetch: fake.fetch,
          secrets: [],
          observer: createObserver({ logger, secrets: [] }),
          budget: { deadline: Date.now() - 1, timeoutMs: 1_000 },
        },
      };
      const error = await errorOf(sourcify.submit(input(), ctx));
      assert.equal(error.code, "timeout");
      assert.equal(fake.calls.length, 0);
      assert.deepEqual(warnings, []);
    });
  });

  describe("poll", () => {
    it("returns pending while isJobCompleted is false (R-BE-4)", async () => {
      const { ctx, calls } = setup([fixture("job-pending")]);
      assert.deepEqual(await sourcify.poll(handle(GREETER_JOB), ctx), { state: "pending" });
      assert.equal(calls[0]?.method, "GET");
      assert.equal(calls[0]?.url, `${API}/v2/verify/${GREETER_JOB}`);
    });

    it("returns verified exact for a job with exact_match (R-BE-4, R-FLOW-3)", async () => {
      const { ctx } = setup([fixture("job-exact-match")]);
      assert.deepEqual(await sourcify.poll(handle(GREETER_JOB), ctx), {
        state: "verified",
        match: "exact",
      });
    });

    it("returns verified partial for a job with match (R-BE-4, R-FLOW-3)", async () => {
      const { ctx } = setup([fixture("job-match")], { chainId: 84532 });
      const job = handle(
        "c8dc71e8-7335-4b1b-b12a-112c7d9acf57",
        "0x840C7297C3BF0A65c465e6dc2cb147Bbf5040cB3",
        84532,
      );
      assert.deepEqual(await sourcify.poll(job, ctx), { state: "verified", match: "partial" });
    });

    it("returns verified exact when Sourcify's forwarding to Etherscan failed (live matrix 2026-11-04)", async () => {
      const { ctx } = setup([
        loadFixture("sourcify", "2026-11-04-job-exact-match-etherscan-forward-limit"),
      ]);
      const job = handle(
        "dcb7dba9-1b18-4c00-8fbf-9f700f5732fb",
        "0x0993438fBDE0A8Eb12028DC7B5d24d495277e1f8",
      );
      assert.deepEqual(await sourcify.poll(job, ctx), { state: "verified", match: "exact" });
    });

    it("returns already-verified without a match for an already_verified job (R-FLOW-3)", async () => {
      const { ctx } = setup([fixture("job-already-verified")]);
      assert.deepEqual(await sourcify.poll(handle(NO_MATCH_JOB, OTHER), ctx), {
        state: "already-verified",
      });
    });

    it("returns failed with code and message for no_match (R-FLOW-4)", async () => {
      const { ctx } = setup([fixture("job-no-match")]);
      assert.deepEqual(await sourcify.poll(handle(NO_MATCH_JOB, OTHER), ctx), {
        state: "failed",
        reason: "no_match: The deployed and recompiled bytecode don't match.",
      });
    });

    it("returns failed for contract_not_found_in_compiler_output, without the bytecode (R-FLOW-4)", async () => {
      const { ctx } = setup([fixture("job-contract-not-found-in-compiler-output")], {
        chainId: 421614,
      });
      const job = handle(
        "66e18ebd-f6ce-4a2e-a4cf-140a5a885141",
        "0xd5f7748BE5DC3AC5824c199988956C093D5a3602",
        421614,
      );
      assert.deepEqual(await sourcify.poll(job, ctx), {
        state: "failed",
        reason: "contract_not_found_in_compiler_output: Contract not found in compiler output.",
      });
    });

    it("throws verification-inconclusive, without a handle, for contract_not_deployed (R-FLOW-4)", async () => {
      const job = handle(
        "0bcf24fd-93f7-40aa-bf7d-1488b25446be",
        "0x000000000000000000000000000000000000dEaD",
      );
      const { ctx } = setup([fixture("job-contract-not-deployed")]);
      const error = await errorOf(sourcify.poll(job, ctx));
      assert.deepEqual(error.details, {
        code: "verification-inconclusive",
        backend: "sourcify",
        reason:
          "contract_not_deployed: Chain #11155111 does not have a contract deployed at 0x000000000000000000000000000000000000dEaD.",
      });
      assert.equal(error.retryable, true);
      assert.equal(error.toJSON().handle, undefined);
      assert.match(error.message, /contract_not_deployed/);
    });

    it("throws verification-inconclusive for internal_error (R-FLOW-4)", async () => {
      const { ctx } = setup([fixture("job-internal-error")]);
      const error = await errorOf(sourcify.poll(handle(NO_MATCH_JOB, OTHER), ctx));
      assert.equal(error.code, "verification-inconclusive");
    });

    it("throws unknown-state for an unknown customCode and never returns verified (R-FLOW-4)", async () => {
      const job = handle(NO_MATCH_JOB, OTHER);
      const { ctx } = setup([fixture("job-unknown-code")]);
      const error = await errorOf(sourcify.poll(job, ctx));
      const { details } = error;
      assert.ok(details.code === "unknown-state", error.message);
      assert.deepEqual(details.handle, job);
      assert.ok(details.excerpt.length <= 300);
      assert.match(details.excerpt, /^\{"isJobCompleted":true,"verificationId":"dea83eb0/);
      assert.match(error.message, /metadata_not_set/);
      assert.equal(error.retryable, false);
    });

    it("puts the unknown code in the unknown-state excerpt of a short body (R-FLOW-4)", async () => {
      const body = {
        isJobCompleted: true,
        contract: { match: null },
        error: { customCode: "brand_new_code", message: "m" },
      };
      const { ctx } = setup([json(200, body)]);
      const error = await errorOf(sourcify.poll(handle(GREETER_JOB), ctx));
      const { details } = error;
      assert.ok(details.code === "unknown-state", error.message);
      assert.equal(details.excerpt, JSON.stringify(body));
    });

    for (const code of DEFINITIVE_CODES) {
      it(`returns failed for the definitive code ${code} (R-FLOW-4)`, async () => {
        const response = edited("job-no-match", (b) => {
          b.error = { customCode: code, message: "m" };
        });
        const { ctx } = setup([response]);
        assert.deepEqual(await sourcify.poll(handle(NO_MATCH_JOB, OTHER), ctx), {
          state: "failed",
          reason: `${code}: m`,
        });
      });
    }

    for (const code of TRANSIENT_CODES) {
      it(`throws verification-inconclusive for the transient code ${code} (R-FLOW-4)`, async () => {
        const response = edited("job-no-match", (b) => {
          b.error = { customCode: code, message: "m" };
        });
        const { ctx } = setup([response]);
        const error = await errorOf(sourcify.poll(handle(NO_MATCH_JOB, OTHER), ctx));
        assert.deepEqual(error.details, {
          code: "verification-inconclusive",
          backend: "sourcify",
          reason: `${code}: m`,
        });
      });
    }

    for (const code of ["creation_bytecode_match_error", "metadata_not_set", "cbor_auxdata_x"]) {
      it(`throws unknown-state for the unclassified code ${code} (R-FLOW-4)`, async () => {
        const response = edited("job-no-match", (b) => {
          b.error = { customCode: code, message: "m" };
        });
        const { ctx } = setup([response]);
        const error = await errorOf(sourcify.poll(handle(NO_MATCH_JOB, OTHER), ctx));
        assert.equal(error.code, "unknown-state");
      });
    }

    it("uses the code alone as the reason when the message is not a string (R-FLOW-4)", async () => {
      const response = edited("job-no-match", (b) => {
        b.error = { customCode: "no_match" };
      });
      const { ctx } = setup([response]);
      assert.deepEqual(await sourcify.poll(handle(NO_MATCH_JOB, OTHER), ctx), {
        state: "failed",
        reason: "no_match",
      });
    });

    const unknown: [string, (b: Record<string, unknown>) => void][] = [
      [
        "neither a match nor an error",
        (b) => {
          b.contract = { match: null, chainId: "11155111", address: GREETER };
        },
      ],
      [
        "an error with a match",
        (b) => {
          b.error = { customCode: "no_match", message: "m" };
        },
      ],
      [
        "an error without a string code",
        (b) => {
          b.contract = { match: null };
          b.error = { customCode: 7 };
        },
      ],
      [
        "an unknown grade and no error",
        (b) => {
          b.contract = { match: "similar" };
        },
      ],
    ];
    for (const [name, edit] of unknown) {
      it(`throws unknown-state for a completed job with ${name} (R-FLOW-4)`, async () => {
        const { ctx } = setup([edited("job-exact-match", edit)]);
        const error = await errorOf(sourcify.poll(handle(GREETER_JOB), ctx));
        assert.equal(error.code, "unknown-state");
      });
    }

    it("reads a completed job without a contract field by its error (R-FLOW-4)", async () => {
      const response = edited("job-no-match", (b) => {
        delete b.contract;
      });
      const { ctx } = setup([response]);
      const outcome = await sourcify.poll(handle(NO_MATCH_JOB, OTHER), ctx);
      assert.equal(outcome.state, "failed");
    });

    it("throws job-not-found on a 404 job_not_found (R-BE-4)", async () => {
      const job = handle("461157eb-e4ea-4c5f-9aec-04c56924fd96");
      const { ctx } = setup([fixture("job-not-found")]);
      const error = await errorOf(sourcify.poll(job, ctx));
      const { details } = error;
      assert.ok(details.code === "job-not-found", error.message);
      assert.deepEqual(details.handle, job);
      assert.equal(error.retryable, false);
    });

    const unexpected: [string, () => Response][] = [
      ["a 404 with another code", () => json(404, { customCode: "not_found" })],
      [
        "a 500 with a full completed-job body",
        () => {
          const recorded = fixture("job-exact-match");
          return json(500, recorded.response.body);
        },
      ],
      ["a 400 that says job_not_found", () => json(400, { customCode: "job_not_found" })],
      [
        "a 404 whose customCode is not a string",
        () => json(404, { customCode: ["job_not_found"] }),
      ],
      [
        "a job with another verificationId",
        () => edited("job-exact-match", (b) => (b.verificationId = NO_MATCH_JOB)),
      ],
      ["a 200 that is not JSON", () => new Response("ok", { status: 200 })],
      ["a 200 without isJobCompleted", () => json(200, { verificationId: GREETER_JOB })],
      [
        "a 200 with a string isJobCompleted",
        () => edited("job-pending", (b) => (b.isJobCompleted = "false")),
      ],
      [
        "a pending job about another contract",
        () =>
          edited("job-pending", (b) => {
            b.contract = { match: null, chainId: "11155111", address: OTHER };
          }),
      ],
      [
        "a completed job about another chain",
        () =>
          edited("job-exact-match", (b) => {
            b.contract = { match: "exact_match", chainId: "1", address: GREETER };
          }),
      ],
    ];
    for (const [name, response] of unexpected) {
      it(`throws unexpected-response on ${name}, never verified (R-FLOW-4)`, async () => {
        const { ctx } = setup([response()]);
        const error = await errorOf(sourcify.poll(handle(GREETER_JOB), ctx));
        assert.equal(error.code, "unexpected-response");
      });
    }

    it("retries a network error, then reads the job (R-FLOW-6)", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const { ctx, calls } = setup([new TypeError("fetch failed"), fixture("job-exact-match")]);
      assert.deepEqual(await drive(t, sourcify.poll(handle(GREETER_JOB), ctx)), {
        state: "verified",
        match: "exact",
      });
      assert.equal(calls.length, 2);
    });

    const badHandles: [string, Handle, string][] = [
      ["another backend", { ...handle(GREETER_JOB), backend: "etherscan-v2" }, "backend"],
      ["a job id with a slash", handle("../v2/contract/1/x"), "jobId"],
      ["a job id with a query", handle("abc?x=1"), "jobId"],
      ["an empty job id", handle(""), "jobId"],
    ];
    for (const [name, bad, field] of badHandles) {
      it(`throws invalid-input before any request for a handle with ${name} (R-SEC-2)`, async () => {
        const { ctx, calls } = setup([fixture("job-exact-match")]);
        const error = await errorOf(sourcify.poll(bad, ctx));
        const { details } = error;
        assert.ok(details.code === "invalid-input", error.message);
        assert.deepEqual(
          details.issues.map((issue) => issue.field),
          [field],
        );
        assert.equal(calls.length, 0);
      });
    }

    it("throws invalid-input for a job id that is not a string (R-SEC-2)", async () => {
      const bad = handle(GREETER_JOB);
      Reflect.set(bad, "jobId", 42);
      const { ctx, calls } = setup([]);
      const error = await errorOf(sourcify.poll(bad, ctx));
      assert.equal(error.code, "invalid-input");
      assert.equal(calls.length, 0);
    });
  });

  describe("failed.reason", () => {
    it("is redacted with the call's keys and capped (R-SEC-1)", async () => {
      const message = `apikey=${PLANTED} and ${SECRET} ${"x".repeat(5_000_000)}`;
      const response = edited("job-no-match", (b) => {
        b.error = { customCode: "no_match", message };
      });
      const { ctx } = setup([response], { secrets: [SECRET] });
      const outcome = await sourcify.poll(handle(NO_MATCH_JOB, OTHER), ctx);
      assert.ok(outcome.state === "failed");
      assert.ok(outcome.reason.length <= REASON_LENGTH, String(outcome.reason.length));
      assert.ok(outcome.reason.startsWith("no_match: apikey=[redacted]"), outcome.reason);
      assert.ok(!outcome.reason.includes(SECRET));
      assert.ok(!outcome.reason.includes(PLANTED));
    });

    it("is the same capped value in verification-inconclusive (R-SEC-1)", async () => {
      const message = `apikey=${PLANTED} and ${SECRET} ${"x".repeat(1_000)}`;
      const response = edited("job-no-match", (b) => {
        b.error = { customCode: "internal_error", message };
      });
      const { ctx } = setup([response], { secrets: [SECRET] });
      const error = await errorOf(sourcify.poll(handle(NO_MATCH_JOB, OTHER), ctx));
      const { details } = error;
      assert.ok(details.code === "verification-inconclusive", error.message);
      assert.ok(details.reason.length <= REASON_LENGTH);
      assert.ok(details.reason.startsWith("internal_error: apikey=[redacted]"));
      assert.ok(!surfaces(error).includes(SECRET));
      assert.ok(!surfaces(error).includes(PLANTED));
    });
  });

  describe("keys across every surface (R-SEC-1)", () => {
    const route: RouteOverride = { apiUrl: `https://sourcify.example.org/server?key=${SECRET}` };
    const leaky = (code: string): Record<string, unknown> => ({
      isJobCompleted: true,
      verificationId: GREETER_JOB,
      contract: { match: null, chainId: "11155111", address: GREETER },
      error: { customCode: code, message: `see ${SECRET} and apikey=${SECRET}` },
    });
    const cases: [string, Step[], (ctx: Context) => Promise<unknown>][] = [
      [
        "the warning and the outcome of a submit retried after a 500",
        [json(500, { message: SECRET }), fixture("lookup-exact-match")],
        async (ctx) => await sourcify.submit(input(), ctx),
      ],
      [
        "a lookup that fails after an unclear submit",
        [new TypeError(`fetch failed ${SECRET}`), json(500, { message: SECRET })],
        async (ctx) => await sourcify.submit(input(), ctx),
      ],
      [
        "unexpected-response",
        [json(500, { message: `boom ${SECRET}` })],
        async (ctx) => await sourcify.lookup(target(), ctx),
      ],
      [
        "unknown-state",
        [json(200, leaky("brand_new_code"))],
        async (ctx) => await sourcify.poll(handle(GREETER_JOB), ctx),
      ],
      [
        "job-not-found",
        [json(404, { customCode: "job_not_found", message: `no job ${SECRET}` })],
        async (ctx) => await sourcify.poll(handle(GREETER_JOB), ctx),
      ],
      [
        "verification-inconclusive",
        [json(200, leaky("internal_error"))],
        async (ctx) => await sourcify.poll(handle(GREETER_JOB), ctx),
      ],
      [
        "failed.reason",
        [json(200, leaky("no_match"))],
        async (ctx) => await sourcify.poll(handle(GREETER_JOB), ctx),
      ],
    ];
    for (const [name, steps, run] of cases) {
      it(`keeps the key out of ${name}`, async () => {
        const { logger, lines } = spyLogger();
        const { ctx } = setup(steps, { route, logger, secrets: [SECRET] });
        let shown: string;
        try {
          shown = JSON.stringify(await run(ctx));
        } catch (error: unknown) {
          assert.ok(error instanceof ExplorerVerifyError, String(error));
          shown = surfaces(error);
        }
        assert.ok(shown.length > 0);
        assert.ok(!shown.includes(SECRET), shown);
        assert.ok(!lines.join("\n").includes(SECRET), lines.join("\n"));
      });
    }
  });

  describe("explorerUrl", () => {
    it("is the repository page on the public server (R-FLOW-3)", () => {
      const { ctx } = setup([]);
      assert.equal(
        sourcify.explorerUrl(target(), ctx),
        `https://repo.sourcify.dev/${String(SEPOLIA)}/${GREETER}`,
      );
    });

    it("is undefined when the route points at another server (R-FLOW-3)", () => {
      const { ctx } = setup([], { route: { apiUrl: "https://sourcify.example.org/server" } });
      assert.equal(sourcify.explorerUrl(target(), ctx), undefined);
    });
  });

  describe("fixtures", () => {
    const names = readdirSync(new URL("../fixtures/sourcify/", import.meta.url))
      .filter((file) => file.startsWith("2026-11-02-") && file.endsWith(".json"))
      .map((file) => file.slice(0, -".json".length));

    it("are named <date>-<endpoint> and each names its source (R-QA-1)", () => {
      assert.ok(names.length > 0);
      for (const name of names) {
        assert.match(name, /^\d{4}-\d{2}-\d{2}-(lookup|submit|job)-[a-z0-9-]+$/);
        const recorded = loadFixture("sourcify", name);
        assert.ok(recorded.source.length > 0, name);
        assert.equal(new URL(recorded.request.url).origin, "https://sourcify.dev");
      }
    });

    it("hold no API key (R-SEC-1)", () => {
      for (const name of names) {
        const text = JSON.stringify(loadFixture("sourcify", name));
        assert.doesNotMatch(text, /apikey|api_key|bearer/i, name);
        assert.doesNotMatch(text, /\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{34}\b/, name);
      }
    });

    it("replay the recorded status (R-QA-1)", async () => {
      const recorded = fixture("lookup-not-verified");
      assert.equal(responseOf(recorded).status, 404);
      const text = await responseOf(recorded).text();
      assert.match(text, /"match":null/);
    });
  });
});
