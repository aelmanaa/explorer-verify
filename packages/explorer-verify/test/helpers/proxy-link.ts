// What the proxy-link mutation tests share (#194): a context whose requests a fake fetch answers
// in order, and checks of the errors the linkers throw.
import assert from "node:assert/strict";

import type { Context } from "../../src/backends/backend.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import { createObserver } from "../../src/observe.ts";
import type { Hex, Logger, RouteOverride } from "../../src/types.ts";
import { replay } from "./fake-fetch.ts";
import type { Call, Step } from "./fake-fetch.ts";
import { resolveRoute } from "./route.ts";
export const SEPOLIA = 11155111;
export const PROXY: Hex = "0xed5b8413e605598ef86cd7617f12701f74ca255c";
export const BOX: Hex = "0x75038a8c55f5ec7196b54384fdbcffb1f2ce9920";
// A fake key. Never a real one (R-SEC-1).
const KEY = "deadbeef0123456789abcdef94a10003";

/** A JSON answer. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export interface SetupOptions {
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
  /** Runs before each request, with the number of requests sent before it. */
  readonly before?: (sent: number) => void;
}

/** A context on `route` whose requests the fake fetch answers with `steps`, in order. */
export function setup(
  route: RouteOverride,
  steps: Step[],
  options: SetupOptions = {},
): { ctx: Context; calls: Call[] } {
  const fake = replay(...steps);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    options.before?.(fake.calls.length);
    return await fake.fetch(input, init);
  };
  const apiKeys = { "etherscan-v2": KEY };
  const resolved = resolveRoute(SEPOLIA, route, { allowSourcifyFallback: true, apiKeys });
  const { logger, signal } = options;
  return {
    ctx: {
      route: resolved,
      apiKeys: () => apiKeys,
      http: {
        backend: resolved.backend,
        fetch,
        secrets: [KEY],
        random: () => 0,
        ...(signal === undefined ? {} : { signal }),
        ...(logger === undefined ? {} : { observer: createObserver({ logger, secrets: [KEY] }) }),
      },
    },
    calls: fake.calls,
  };
}

/** The error a call rejects with. */
export async function rejection(call: Promise<unknown>): Promise<ExplorerVerifyError> {
  const outcome = await call.then(
    (value: unknown) => ({ resolved: value }),
    (error: unknown) => error,
  );
  assert.ok(
    outcome instanceof ExplorerVerifyError,
    `expected an error, got ${JSON.stringify(outcome)}`,
  );
  return outcome;
}

/** Asserts an `unexpected-response` from `backend` whose message names `label` and `what`. */
export function assertUnexpected(
  error: ExplorerVerifyError,
  backend: string,
  message: string,
): void {
  assert.equal(error.code, "unexpected-response");
  assert.equal(error.details.code === "unexpected-response" && error.details.backend, backend);
  assert.equal(error.message, message);
}

/** A logger that records each line with its level. */
export function recorder(lines: [string, string, unknown][]): Logger {
  return {
    debug: (message, fields) => {
      lines.push(["debug", message, fields]);
    },
    info: (message, fields) => {
      lines.push(["info", message, fields]);
    },
    warn: (message, fields) => {
      lines.push(["warn", message, fields]);
    },
    error: (message, fields) => {
      lines.push(["error", message, fields]);
    },
  };
}
