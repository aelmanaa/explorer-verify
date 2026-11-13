// `onSubmitted` (R-FLOW-5, R-FLOW-6, R-SEC-1): `verify()` and `verifyEach()` give the caller the
// one-line handle of an accepted submission before the first poll, so a caller that aborts after
// the submit can resume the job with `checkStatus()`. Every answer is recorded or built in the
// recorded shape, every wait runs on mock timers, and the backoff jitter is fixed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import { etherscan } from "../../src/backends/etherscan.ts";
import { sourcify } from "../../src/backends/sourcify.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import { formatHandle } from "../../src/flow/handle.ts";
import type { FlowDependencies } from "../../src/flow/verify.ts";
import type {
  HandleString,
  LogFields,
  Logger,
  VerifyEachOptions,
  VerifyEvent,
  VerifyInput,
  VerifyOptions,
} from "../../src/index.ts";
import type { RoutingTable } from "../../src/routing/resolve.ts";
import { ROUTING_TABLE } from "../../src/routing/table.ts";
import { runCheckStatus, runDryRun, runVerify, runVerifyEach } from "../helpers/defaults.ts";
import { loadFixture, responseOf } from "../helpers/fake-fetch.ts";
import type { Fixture } from "../helpers/fake-fetch.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";

const SEPOLIA = 11155111;
// The Greeter deployed on Sepolia on 2026-11-02, whose responses the fixtures recorded.
const GREETER = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const GREETER_JOB = "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718";
const GREETER_PAGE = `https://repo.sourcify.dev/${String(SEPOLIA)}/${GREETER}`;
const SUBMITTED_HANDLE = formatHandle({
  version: 1,
  backend: "sourcify",
  chainId: SEPOLIA,
  address: GREETER,
  jobId: GREETER_JOB,
});
// Fake keys, lowercase hex. Never real ones (R-SEC-1).
const ROUTE_KEY = "5e1f0c9a7b3d2e4f6a8c0b1d3e5f7a9c";
const ETHERSCAN_KEY = "a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5";
const SUBMITTED_FAILED =
  "The onSubmitted callback threw. The error is ignored and the call goes on.";

const DEPENDENCIES: FlowDependencies = {
  backends: { sourcify },
  table: ROUTING_TABLE,
  random: () => 0,
};

function fixture(name: string): Fixture {
  return loadFixture("sourcify", `2026-11-02-${name}`);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

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

/** One answer of the fake fetch: a fixture, a response, or a function run when the request comes. */
type Step = Fixture | Response | ((init: RequestInit | undefined) => Promise<Response>);

/** A fake fetch that plays `steps` in order. A request after the last step rejects. */
function script(steps: readonly Step[]): { fetch: typeof fetch; sent: string[] } {
  const sent: string[] = [];
  const fake = async (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
    sent.push(`${init?.method ?? "GET"} ${url}`);
    const step = steps[sent.length - 1];
    if (step === undefined) {
      throw new Error(`unexpected request ${String(sent.length)}`);
    }
    if (typeof step === "function") {
      return await step(init);
    }
    return step instanceof Response ? step.clone() : responseOf(step);
  };
  return { fetch: fake, sent };
}

interface Line {
  readonly level: keyof Logger;
  readonly message: string;
  readonly fields: LogFields | undefined;
}

function recorder(): { logger: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const at =
    (level: keyof Logger) =>
    (message: string, fields?: LogFields): void => {
      lines.push({ level, message, fields });
    };
  return {
    logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") },
    lines,
  };
}

interface Run {
  readonly outcome: unknown;
  readonly events: VerifyEvent[];
  readonly lines: Line[];
}

/** Runs `call` on mock timers until it settles, with a logger and onEvent that record. */
async function settle(
  t: TestContext,
  call: (sinks: Pick<VerifyOptions, "logger" | "onEvent">) => Promise<unknown>,
): Promise<Run> {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const { logger, lines } = recorder();
  const events: VerifyEvent[] = [];
  const pending = call({
    logger,
    onEvent: (event) => {
      events.push(event);
    },
  }).then(
    (result: unknown): unknown => result,
    (error: unknown): unknown => error,
  );
  await driveMockClock(pending, () => {
    t.mock.timers.runAll();
  });
  const outcome = await pending;
  t.mock.timers.reset();
  return { outcome, events, lines };
}

/** Runs verify() with `options` on `steps`. */
async function verifyOn(
  t: TestContext,
  steps: readonly Step[],
  options: VerifyOptions,
): Promise<Run & { sent: string[] }> {
  const { fetch, sent } = script(steps);
  const r = await settle(t, (sinks) =>
    runVerify(input(), { fetch, ...sinks, ...options }, DEPENDENCIES),
  );
  return { ...r, sent };
}

function errorOf(outcome: unknown, code: string): ExplorerVerifyError {
  assert.ok(outcome instanceof ExplorerVerifyError, String(outcome));
  assert.equal(outcome.code, code, outcome.message);
  return outcome;
}

/** Resumes `handle` with checkStatus() on the recorded exact-match job answer. */
async function resume(t: TestContext, handle: HandleString | undefined): Promise<unknown> {
  assert.ok(handle !== undefined, "onSubmitted got no handle");
  const { fetch, sent } = script([fixture("job-exact-match")]);
  const r = await settle(t, (sinks) => runCheckStatus(handle, { fetch, ...sinks }, DEPENDENCIES));
  assert.deepEqual(sent, [`GET https://sourcify.dev/server/v2/verify/${GREETER_JOB}`]);
  return r.outcome;
}

const VERIFIED = {
  status: "verified",
  backend: "sourcify",
  match: "exact",
  explorerUrl: GREETER_PAGE,
};

describe("onSubmitted: the handle of an accepted submission (R-FLOW-5)", () => {
  it("R-FLOW-5: verify() passes the verify.submitted handle once", async (t) => {
    const calls: HandleString[] = [];
    const r = await verifyOn(
      t,
      [fixture("lookup-not-verified"), fixture("submit-accepted"), fixture("job-exact-match")],
      {
        onSubmitted: (handle) => {
          calls.push(handle);
        },
      },
    );
    assert.deepEqual(r.outcome, VERIFIED);
    const submitted = r.events.flatMap((event) =>
      event.type === "verify.submitted" ? [event.handle] : [],
    );
    assert.deepEqual(calls, [SUBMITTED_HANDLE]);
    assert.deepEqual(submitted, calls);
  });

  it("R-FLOW-5: verify() calls onSubmitted after verify.submitted and before the poll request", async (t) => {
    const order: string[] = [];
    const { fetch, sent } = script([
      fixture("lookup-not-verified"),
      fixture("submit-accepted"),
      async () => {
        order.push("poll request");
        return await Promise.resolve(responseOf(fixture("job-exact-match")));
      },
    ]);
    const r = await settle(t, ({ logger }) =>
      runVerify(
        input(),
        {
          fetch,
          logger,
          onEvent: (event) => {
            order.push(event.type);
          },
          onSubmitted: (handle) => {
            order.push(`onSubmitted ${handle}`);
          },
        },
        DEPENDENCIES,
      ),
    );
    assert.deepEqual(r.outcome, VERIFIED);
    assert.equal(sent.length, 3);
    assert.deepEqual(order, [
      "verify.validated",
      "verify.routed",
      "verify.lookup",
      "verify.submitted",
      `onSubmitted ${SUBMITTED_HANDLE}`,
      "poll request",
      "verify.result",
    ]);
  });
});

describe("onSubmitted: abort after the submit (R-FLOW-5, R-FLOW-6)", () => {
  it("R-FLOW-5, R-FLOW-6: an abort right after the recorded submit answer rejects with signal.reason, and checkStatus() resumes the job from the onSubmitted handle", async (t) => {
    const controller = new AbortController();
    const reason = new Error("stop");
    let kept: HandleString | undefined;
    const r = await verifyOn(t, [fixture("lookup-not-verified"), fixture("submit-accepted")], {
      signal: controller.signal,
      onSubmitted: (handle) => {
        kept = handle;
        controller.abort(reason);
      },
    });
    assert.equal(r.outcome, reason);
    assert.equal(kept, SUBMITTED_HANDLE);
    // No poll went out: the call stopped right after the submit answer.
    assert.equal(r.sent.length, 2);
    assert.deepEqual(await resume(t, kept), VERIFIED);
  });

  it("R-FLOW-5, R-FLOW-6: an abort during the first poll request rejects with signal.reason, and checkStatus() resumes the job from the onSubmitted handle", async (t) => {
    const controller = new AbortController();
    const reason = new Error("stop");
    let kept: HandleString | undefined;
    const r = await verifyOn(
      t,
      [
        fixture("lookup-not-verified"),
        fixture("submit-accepted"),
        async (init) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
            controller.abort(reason);
          }),
      ],
      {
        signal: controller.signal,
        onSubmitted: (handle) => {
          kept = handle;
        },
      },
    );
    assert.equal(r.outcome, reason);
    assert.equal(kept, SUBMITTED_HANDLE);
    assert.equal(r.sent.length, 3);
    assert.deepEqual(await resume(t, kept), VERIFIED);
  });
});

describe("onSubmitted: not called without an accepted submission (R-FLOW-5)", () => {
  const cases: { name: string; steps: readonly Step[]; check: (outcome: unknown) => void }[] = [
    {
      name: "the lookup finds an exact match",
      steps: [fixture("lookup-exact-match")],
      check: (outcome) => {
        assert.deepEqual(outcome, { ...VERIFIED, status: "already-verified" });
      },
    },
    {
      name: "the explorer refuses the submit as already verified",
      steps: [
        fixture("lookup-not-verified"),
        fixture("submit-already-verified"),
        fixture("lookup-exact-match"),
      ],
      check: (outcome) => {
        assert.ok(typeof outcome === "object" && outcome !== null && "status" in outcome);
        assert.equal(outcome.status, "already-verified");
      },
    },
    {
      name: "the explorer refuses the submit with an error",
      steps: [fixture("lookup-not-verified"), fixture("submit-invalid-parameter")],
      check: (outcome) => {
        assert.ok(outcome instanceof ExplorerVerifyError, String(outcome));
      },
    },
  ];
  for (const { name, steps, check } of cases) {
    it(`R-FLOW-5: verify() does not call onSubmitted when ${name}`, async (t) => {
      const calls: HandleString[] = [];
      const r = await verifyOn(t, steps, {
        onSubmitted: (handle) => {
          calls.push(handle);
        },
      });
      check(r.outcome);
      assert.deepEqual(calls, []);
      assert.equal(r.events.filter((event) => event.type === "verify.submitted").length, 0);
    });
  }

  it("R-FLOW-5: dryRun() and checkStatus() accept onSubmitted and never call it", async (t) => {
    const calls: HandleString[] = [];
    const onSubmitted = (handle: HandleString): void => {
      calls.push(handle);
    };
    // One object typed VerifyOptions goes to every function.
    const dry = script([fixture("lookup-not-verified")]);
    const planned = await settle(t, (sinks) => {
      const options: VerifyOptions = { fetch: dry.fetch, ...sinks, onSubmitted };
      return runDryRun(input(), options, DEPENDENCIES);
    });
    assert.ok(!(planned.outcome instanceof Error), String(planned.outcome));
    const status = script([fixture("job-exact-match")]);
    const resumed = await settle(t, (sinks) => {
      const options: VerifyOptions = { fetch: status.fetch, ...sinks, onSubmitted };
      return runCheckStatus(SUBMITTED_HANDLE, options, DEPENDENCIES);
    });
    assert.deepEqual(resumed.outcome, VERIFIED);
    assert.deepEqual(calls, []);
  });
});

describe("onSubmitted: a callback that fails does not change the outcome (R-SEC-1, decision 0010)", () => {
  const failures: { name: string; onSubmitted: VerifyOptions["onSubmitted"] }[] = [
    {
      name: "throws",
      onSubmitted: () => {
        throw new Error(`callback broke with ${ROUTE_KEY}`);
      },
    },
    {
      name: "returns a promise that rejects",
      onSubmitted: async () => {
        await Promise.resolve();
        throw new Error(`callback broke with ${ROUTE_KEY}`);
      },
    },
  ];
  for (const { name, onSubmitted } of failures) {
    it(`R-SEC-1: a callback that ${name} is logged once at warn with the key removed, and the call verifies`, async (t) => {
      const r = await verifyOn(
        t,
        [fixture("lookup-not-verified"), fixture("submit-accepted"), fixture("job-exact-match")],
        {
          route: {
            backend: "sourcify",
            apiUrl: `https://sourcify.dev/server?apikey=${ROUTE_KEY}`,
          },
          onSubmitted,
        },
      );
      assert.ok(typeof r.outcome === "object" && r.outcome !== null && "status" in r.outcome);
      assert.equal(r.outcome.status, "verified");
      const warnings = r.lines.filter((line) => line.message === SUBMITTED_FAILED);
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0]?.level, "warn");
      assert.equal(warnings[0]?.fields?.["backend"], "sourcify");
      assert.match(String(warnings[0]?.fields?.["error"]), /^Error: callback broke with /u);
      const text = JSON.stringify([r.lines, r.events, r.outcome]);
      assert.ok(!text.includes(ROUTE_KEY), text);
    });
  }

  it("R-SEC-1: an error that cannot be read as text is logged as [unloggable]", async (t) => {
    const unreadable = new Error("hidden");
    Object.defineProperty(unreadable, "message", {
      get: () => {
        throw new Error("no message");
      },
    });
    const r = await verifyOn(
      t,
      [fixture("lookup-not-verified"), fixture("submit-accepted"), fixture("job-exact-match")],
      {
        onSubmitted: () => {
          throw unreadable;
        },
      },
    );
    assert.deepEqual(r.outcome, VERIFIED);
    const warnings = r.lines.filter((line) => line.message === SUBMITTED_FAILED);
    assert.deepEqual(
      warnings.map((line) => line.fields),
      [{ backend: "sourcify", error: "[unloggable]" }],
    );
  });

  it("a callback whose promise resolves logs nothing", async (t) => {
    const r = await verifyOn(
      t,
      [fixture("lookup-not-verified"), fixture("submit-accepted"), fixture("job-exact-match")],
      { onSubmitted: async () => await Promise.resolve() },
    );
    assert.deepEqual(r.outcome, VERIFIED);
    assert.deepEqual(
      r.lines.filter((line) => line.level === "warn"),
      [],
    );
  });

  it("a value that is not a function throws invalid-input naming onSubmitted, before any request", async (t) => {
    const raw: unknown = "not a function";
    const options: Record<string, unknown> = { onSubmitted: raw };
    const { fetch, sent } = script([]);
    const r = await settle(t, () => runVerify(input(), { fetch, ...options }, DEPENDENCIES));
    const error = errorOf(r.outcome, "invalid-input");
    assert.ok(error.details.code === "invalid-input");
    assert.deepEqual(error.details.issues, [
      { field: "onSubmitted", message: "must be a function" },
    ]);
    assert.deepEqual(sent, []);
  });
});

// --- verifyEach() -------------------------------------------------------------------------------

const TABLE: RoutingTable = {
  schemaVersion: 2,
  checked: "2026-11-04",
  chains: [
    {
      chainId: SEPOLIA,
      backends: [
        { backend: "etherscan-v2", explorer: "sepolia.etherscan.io" },
        { backend: "sourcify" },
      ],
    },
  ],
};

const EACH_DEPENDENCIES: FlowDependencies = {
  backends: { sourcify, "etherscan-v2": etherscan },
  table: TABLE,
  random: () => 0,
};

/** The status and JSON body of a recorded answer, as a new Response. */
function recordedBody(backend: string, name: string): () => Response {
  return () => {
    const url = new URL(`../fixtures/${backend}/${name}.json`, import.meta.url);
    const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
    assert.ok(typeof parsed === "object" && parsed !== null);
    const response: unknown = Reflect.get(parsed, "response");
    assert.ok(typeof response === "object" && response !== null);
    const status: unknown = Reflect.get(response, "status");
    assert.ok(typeof status === "number");
    return json(status, Reflect.get(response, "body"));
  };
}

/** A fake fetch that answers each host from its own list, in order. */
function byHost(answers: Readonly<Record<string, readonly (() => Response)[]>>): typeof fetch {
  const counts = new Map<string, number>();
  return async (request: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
    const { host } = new URL(url);
    const count = (counts.get(host) ?? 0) + 1;
    counts.set(host, count);
    const step = answers[host]?.[count - 1];
    if (step === undefined) {
      throw new Error(`unexpected request ${String(count)} to ${host}`);
    }
    return await Promise.resolve(step());
  };
}

const sourcifyNotVerified = (): Response =>
  json(404, {
    match: null,
    creationMatch: null,
    runtimeMatch: null,
    chainId: String(SEPOLIA),
    address: GREETER,
  });
const SOURCIFY_ACCEPTED = (): Response => json(202, { verificationId: GREETER_JOB });
const SOURCIFY_EXACT_JOB = (): Response => responseOf(fixture("job-exact-match"));
const SOURCIFY_LOOKUP_EXACT = (): Response => responseOf(fixture("lookup-exact-match"));
const ETHERSCAN_NOT_VERIFIED = recordedBody("etherscan", "2026-11-03-getsourcecode-not-verified");
const ETHERSCAN_SUBMITTED = recordedBody("etherscan", "2026-11-03-verifysourcecode-factory-child");
const ETHERSCAN_FAIL = recordedBody("etherscan", "2026-11-02-documented-checkverifystatus-fail");

async function eachOn(
  t: TestContext,
  fake: typeof fetch,
  options: Omit<VerifyEachOptions, "fetch" | "backends">,
): Promise<Run> {
  return await settle(t, (sinks) =>
    runVerifyEach(
      input(),
      {
        fetch: fake,
        backends: ["sourcify", "etherscan-v2"],
        apiKeys: { "etherscan-v2": ETHERSCAN_KEY },
        pollIntervalMs: 1_000,
        ...sinks,
        ...options,
      },
      EACH_DEPENDENCIES,
    ),
  );
}

describe("onSubmitted in verifyEach() (R-FLOW-5, R-SEC-1)", () => {
  it("R-FLOW-5: calls onSubmitted once per backend that accepted a submission, with each verify.submitted handle", async (t) => {
    const calls: HandleString[] = [];
    const fetch = byHost({
      "sourcify.dev": [sourcifyNotVerified, SOURCIFY_ACCEPTED, SOURCIFY_EXACT_JOB],
      "api.etherscan.io": [
        ETHERSCAN_NOT_VERIFIED,
        ETHERSCAN_SUBMITTED,
        ETHERSCAN_FAIL,
        ETHERSCAN_NOT_VERIFIED,
      ],
    });
    const r = await eachOn(t, fetch, {
      onSubmitted: (handle) => {
        calls.push(handle);
      },
    });
    assert.ok(!(r.outcome instanceof Error), String(r.outcome));
    const submitted = r.events.flatMap((event) =>
      event.type === "verify.submitted" ? [event.handle] : [],
    );
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.toSorted(), submitted.toSorted());
    assert.ok(calls.includes(SUBMITTED_HANDLE));
    assert.ok(calls.some((handle) => handle.startsWith(`ev1:etherscan-v2:${String(SEPOLIA)}:`)));
  });

  it("R-FLOW-5: does not call onSubmitted for a backend whose lookup finds a match", async (t) => {
    const calls: HandleString[] = [];
    const fetch = byHost({
      "sourcify.dev": [SOURCIFY_LOOKUP_EXACT],
      "api.etherscan.io": [
        ETHERSCAN_NOT_VERIFIED,
        ETHERSCAN_SUBMITTED,
        ETHERSCAN_FAIL,
        ETHERSCAN_NOT_VERIFIED,
      ],
    });
    const r = await eachOn(t, fetch, {
      onSubmitted: (handle) => {
        calls.push(handle);
      },
    });
    assert.ok(!(r.outcome instanceof Error), String(r.outcome));
    assert.equal(calls.length, 1);
    assert.ok(calls[0]?.startsWith(`ev1:etherscan-v2:${String(SEPOLIA)}:`));
  });

  it("R-SEC-1: a callback that throws a key is logged at warn without it, once per backend call, and the outcomes do not change", async (t) => {
    const fetch = byHost({
      "sourcify.dev": [sourcifyNotVerified, SOURCIFY_ACCEPTED, SOURCIFY_EXACT_JOB],
      "api.etherscan.io": [
        ETHERSCAN_NOT_VERIFIED,
        ETHERSCAN_SUBMITTED,
        ETHERSCAN_FAIL,
        ETHERSCAN_NOT_VERIFIED,
      ],
    });
    const r = await eachOn(t, fetch, {
      onSubmitted: () => {
        throw new Error(`callback broke with ${ETHERSCAN_KEY}`);
      },
    });
    assert.ok(typeof r.outcome === "object" && r.outcome !== null && "outcomes" in r.outcome);
    const { outcomes } = r.outcome;
    assert.ok(Array.isArray(outcomes));
    assert.deepEqual(
      outcomes.map((outcome: unknown) =>
        typeof outcome === "object" && outcome !== null && "ok" in outcome ? outcome.ok : null,
      ),
      [true, false],
    );
    const warnings = r.lines.filter((line) => line.message === SUBMITTED_FAILED);
    assert.deepEqual(warnings.map((line) => String(line.fields?.["backend"])).toSorted(), [
      "etherscan-v2",
      "sourcify",
    ]);
    const text = JSON.stringify([r.lines, r.events, r.outcome]);
    assert.ok(!text.includes(ETHERSCAN_KEY), text);
  });
});
