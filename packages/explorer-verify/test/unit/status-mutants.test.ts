// Tests added after the second mutation pass (#158; R-AX-7, R-FLOW-5): each one fails on a code
// change in src/flow/status.ts that the other checkStatus tests let pass.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Backend } from "../../src/backends/backend.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import { runCheckStatus } from "../helpers/defaults.ts";

const SEPOLIA = 11155111;
const ADDRESS = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";

/** An Etherscan v2 client that must not be called: the key check comes first. */
const unreachable: Backend = {
  name: "etherscan-v2",
  lookup: () => Promise.reject(new Error("no lookup expected")),
  submit: () => Promise.reject(new Error("no submit expected")),
  poll: () => Promise.reject(new Error("no poll expected")),
  explorerUrl: () => undefined,
};

describe("checkStatus(): a keyed backend without a key (R-AX-7)", () => {
  it("throws missing-api-key before any request", async (t) => {
    const spy = t.mock.method(globalThis, "fetch", () =>
      Promise.reject(new Error("no request expected")),
    );
    const outcome = await runCheckStatus(
      `ev1:etherscan-v2:${String(SEPOLIA)}:${ADDRESS}:guid0123456789`,
      { route: { backend: "etherscan-v2" } },
      { backends: { "etherscan-v2": unreachable } },
    ).then(
      (value: unknown) => ({ resolved: value }),
      (error: unknown) => error,
    );
    assert.ok(outcome instanceof ExplorerVerifyError, `expected an error, got ${String(outcome)}`);
    assert.equal(outcome.code, "missing-api-key");
    assert.equal(spy.mock.callCount(), 0);
  });
});
