// Tests added after the first full mutation run (#158; R-FLOW-4, R-DX-5, R-SEC-1): each one fails
// on a code change in src/backends/common.ts that the client tests let pass.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import type { Context, Target } from "../../src/backends/backend.ts";
import {
  attemptSubmit,
  checkHandle,
  submitOnce,
  unexpected,
  waitToResubmit,
} from "../../src/backends/common.ts";
import type { Answer } from "../../src/backends/common.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import type { LogFields, Logger } from "../../src/index.ts";
import { createObserver } from "../../src/observe.ts";
import type { Handle } from "../../src/types.ts";
import { resolveRoute } from "../helpers/route.ts";

const SEPOLIA = 11155111;
const ADDRESS = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const TARGET: Target = { chainId: SEPOLIA, address: ADDRESS };
const ANSWER: Answer = { status: 200, text: "{}", fields: new Map() };

type Line = [level: string, message: string, fields?: LogFields];

function recorder(): { logger: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const at =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      lines.push(fields === undefined ? [level, message] : [level, message, fields]);
    };
  return {
    logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") },
    lines,
  };
}

function contextOf(fetch: typeof globalThis.fetch, logger?: Logger): Context {
  const secrets: string[] = [];
  return {
    route: resolveRoute(SEPOLIA, undefined, { allowSourcifyFallback: true }),
    http: {
      backend: "sourcify",
      fetch,
      secrets,
      random: () => 0,
      ...(logger === undefined ? {} : { observer: createObserver({ logger, secrets }) }),
    },
    pollIntervalMs: 1_000,
  };
}

/** A fetch whose 200 answer fails after the headers arrived. */
const broken: typeof globalThis.fetch = async () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new TypeError("connection reset"));
      },
    }),
    { status: 200 },
  );

/** A fetch that answers with a redirect. */
const redirect: typeof globalThis.fetch = async () => new Response(null, { status: 302 });

const noFetch: typeof globalThis.fetch = () => Promise.reject(new Error("no request expected"));

function caught(run: () => unknown): ExplorerVerifyError {
  try {
    run();
  } catch (error: unknown) {
    assert.ok(error instanceof ExplorerVerifyError);
    return error;
  }
  return assert.fail("expected an ExplorerVerifyError");
}

describe("attemptSubmit: cases from the first full mutation run (#158, R-FLOW-4)", () => {
  it("returns unconfirmed when a 2xx body fails after the headers arrived", async () => {
    const sent = await attemptSubmit(
      contextOf(broken),
      { url: "https://sourcify.dev/server/v2/verify", method: "POST", retry: "submit" },
      () => undefined,
    );
    assert.equal(sent.kind, "unconfirmed");
  });

  it("throws a redirect: the submit never reached the explorer", async () => {
    await assert.rejects(
      attemptSubmit(
        contextOf(redirect),
        { url: "https://sourcify.dev/server/v2/verify", method: "POST", retry: "submit" },
        () => undefined,
      ),
      (error: unknown) =>
        error instanceof ExplorerVerifyError &&
        error.details.code === "unexpected-response" &&
        error.details.status === 302,
    );
  });
});

describe("submitOnce and waitToResubmit: log fields (#158, R-DX-5)", () => {
  it("logs the backend and the error code before the lookup", async () => {
    const { logger, lines } = recorder();
    const ctx = contextOf(noFetch, logger);
    const error = new ExplorerVerifyError(
      { code: "network", backend: "sourcify", attempts: 1 },
      "Sourcify got no response.",
      { secrets: [] },
    );
    const outcome = await submitOnce(
      ctx,
      "sourcify",
      "Sourcify",
      TARGET,
      () => Promise.resolve({ kind: "unconfirmed", error }),
      () => assert.fail("no answer to read"),
      () => Promise.resolve("exact"),
    );
    assert.deepEqual(outcome, { state: "already-verified", match: "exact" });
    assert.deepEqual(
      lines.filter(([level]) => level === "warn").map(([, , fields]) => fields),
      [{ backend: "sourcify", code: "network" }],
    );
  });

  it("logs the next submit's number before it waits", async (t: TestContext) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { logger, lines } = recorder();
    const waiting = waitToResubmit(contextOf(noFetch, logger), ANSWER, 2, {
      backend: "etherscan-v2",
      reason: "not-indexed",
      what: "Etherscan found no contract code at the address",
      hint: "Wait.",
      maxTries: 5,
    });
    t.mock.timers.tick(1_000);
    await waiting;
    assert.deepEqual(
      lines.filter(([level]) => level === "warn").map(([, , fields]) => fields),
      [{ backend: "etherscan-v2", attempt: 3, reason: "not-indexed", delayMs: 1_000 }],
    );
  });
});

describe("unexpected and checkHandle: messages (#158, R-FLOW-4)", () => {
  it("builds the message from the label and the request unless `whole` is set", () => {
    const answer: Answer = { status: 418, text: "teapot", fields: undefined };
    const ctx = contextOf(noFetch);
    assert.equal(
      unexpected(ctx, "sourcify", "Sourcify", answer, "the lookup").message,
      "Sourcify gave an answer to the lookup that this client does not recognise (status 418).",
    );
    assert.equal(
      unexpected(ctx, "sourcify", "Sourcify", answer, "Whole message.", true).message,
      "Whole message.",
    );
  });

  it("names the invalid fields, the job id rule and the hint", () => {
    const handle: Handle = {
      version: 1,
      backend: "etherscan-v2",
      chainId: SEPOLIA,
      address: ADDRESS,
      jobId: "-bad",
    };
    const error = caught(() => {
      checkHandle(handle, "sourcify", "Sourcify", contextOf(noFetch));
    });
    assert.equal(error.message, "The handle is invalid: backend, jobId.");
    assert.equal(error.hint, "Pass the handle exactly as verify() or parseHandle() returned it.");
    assert.deepEqual(error.details, {
      code: "invalid-input",
      issues: [
        { field: "backend", message: "must be sourcify for the Sourcify client" },
        {
          field: "jobId",
          message:
            "must be 1 to 128 characters from A-Z, a-z, 0-9, '_' and '-', starting with a letter or digit",
        },
      ],
    });
  });
});
