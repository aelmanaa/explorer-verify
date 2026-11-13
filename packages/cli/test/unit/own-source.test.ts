// --require-own-source (R-AX-5, R-AX-7, decision 0069, issue #351): the walk over the exit-code
// table. With the flag, `ok` is true exactly when the exit code is 0 for every row, and only
// already-verified with storedContract moves, from exit 0 to 1.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ERROR_CODES, ExplorerVerifyError, parseHandle } from "explorer-verify";
import type {
  BackendOutcome,
  ErrorDetails,
  ErrorJson,
  VerifyEachResult,
  VerifyResult,
} from "explorer-verify";
import { ERROR_EXIT_CODES, exitCodeOf, toEnvelope } from "explorer-verify/envelope";
import type { ExitCode } from "explorer-verify/envelope";

import { cliEnvelope } from "../../src/output.ts";
import type { CliEnvelope } from "../../src/output.ts";
import { isOtherSource, requireOwnSource } from "../../src/own-source.ts";
import { sampleError } from "../helpers/error-samples.ts";
import { envelopeProblems } from "../helpers/schema.ts";

const ADDRESS = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const HANDLE = parseHandle(`ev1:sourcify:11155111:${ADDRESS}:550e8400-e29b-41d4-a716-446655440000`);

/** The error object of `details`, as a run on several backends holds it. */
function errorOf(details: ErrorDetails): ErrorJson {
  return new ExplorerVerifyError(details, "The run ended.", { hint: "h", secrets: [] }).toJSON();
}

const OWN: VerifyResult = { status: "already-verified", backend: "sourcify", match: "exact" };
const OTHER: VerifyResult = {
  status: "already-verified",
  backend: "sourcify",
  match: "partial",
  storedContract: { name: "simplestorage2.sol:SimpleStorage", compilerVersion: "0.8.33" },
};

/** The envelope the CLI prints for a result, and its exit code, before the flag. */
function plain(outcome: VerifyResult | VerifyEachResult<ErrorJson>): {
  envelope: CliEnvelope;
  code: ExitCode;
} {
  return { envelope: cliEnvelope(toEnvelope(outcome), {}), code: exitCodeOf(outcome) };
}

/** Checks the gated envelope against the shipped schema and R-AX-5, and returns its code. */
function gated(outcome: VerifyResult | VerifyEachResult<ErrorJson>): ExitCode {
  const { envelope, code } = plain(outcome);
  const result = requireOwnSource(envelope, code);
  assert.deepEqual(envelopeProblems(JSON.parse(JSON.stringify(result.envelope))), []);
  assert.equal(result.envelope.ok, result.code === 0, JSON.stringify(result.envelope));
  return result.code;
}

/** A backend outcome of a result, or of an error object. */
function outcomeOf(
  backend: "sourcify" | "etherscan-v2",
  value: VerifyResult | ErrorJson,
): BackendOutcome<ErrorJson> {
  if ("code" in value) {
    return { backend, ok: false, error: value };
  }
  if (value.status === "failed") {
    return { backend, ok: false, result: { ...value, backend } };
  }
  return { backend, ok: true, result: { ...value, backend } };
}

describe("--require-own-source walks the exit-code table (R-AX-5, R-AX-7)", () => {
  it("moves only already-verified with storedContract, from 0 to 1", () => {
    const rows: [VerifyResult, ExitCode][] = [
      [{ status: "verified", backend: "sourcify", match: "exact" }, 0],
      [OWN, 0],
      [OTHER, 1],
      [{ status: "failed", backend: "sourcify", reason: "no match", reasonCode: "unknown" }, 1],
    ];
    for (const [result, code] of rows) {
      assert.equal(gated(result), code, JSON.stringify(result));
      assert.equal(isOtherSource(result), result === OTHER);
    }
  });

  it("keeps a dry run, which never carries an outcome of another contract's source", () => {
    const { envelope } = plain(OWN);
    const dry = cliEnvelope(
      toEnvelope({
        status: "dry-run",
        backend: "sourcify",
        apiHost: "sourcify.dev",
        lookup: "partial",
        storedContract: { name: "Other" },
      }),
      {},
    );
    assert.deepEqual(requireOwnSource(dry, 0), { envelope: dry, code: 0, backends: [] });
    assert.deepEqual(requireOwnSource(envelope, 0).backends, []);
  });

  it("keeps every error as it is", () => {
    for (const code of ERROR_CODES) {
      const envelope: CliEnvelope = { schemaVersion: 1, ok: false, error: sampleError(code) };
      const exit = ERROR_EXIT_CODES[code];
      assert.deepEqual(requireOwnSource(envelope, exit), { envelope, code: exit, backends: [] });
    }
  });

  it("places another contract's source at 1 in the order 6, 4, 3, 2, 5, 1, 130 on several backends", () => {
    const cases: [readonly (VerifyResult | ErrorJson)[], ExitCode][] = [
      [[OWN, OWN], 0],
      [[OTHER, OWN], 1],
      [[OWN, OTHER], 1],
      [[OTHER, errorOf({ code: "cancelled" })], 1],
      [[OTHER, errorOf({ code: "not-confirmed", handle: HANDLE })], 4],
      [[OTHER, errorOf({ code: "unknown-state", handle: HANDLE, excerpt: "x" })], 6],
      [[OTHER, errorOf({ code: "network", backend: "sourcify", attempts: 3 })], 5],
      [[OTHER, { status: "failed", backend: "sourcify", reason: "no", reasonCode: "unknown" }], 1],
    ];
    for (const [values, code] of cases) {
      const outcomes = values.map((value, index) =>
        outcomeOf(index === 0 ? "etherscan-v2" : "sourcify", value),
      );
      assert.equal(gated({ outcomes }), code, JSON.stringify(values));
    }
  });

  it("names each backend that holds another contract's source, and sets only its ok to false", () => {
    const { envelope, code } = plain({
      outcomes: [outcomeOf("sourcify", OTHER), outcomeOf("etherscan-v2", OWN)],
    });
    const result = requireOwnSource(envelope, code);
    assert.deepEqual(result.backends, ["sourcify"]);
    assert.ok(result.envelope.error === undefined && "outcomes" in result.envelope.result);
    assert.deepEqual(
      result.envelope.result.outcomes.map((outcome) => outcome.ok),
      [false, true],
    );
    const single = requireOwnSource(plain(OTHER).envelope, 0);
    assert.deepEqual(single.backends, ["sourcify"]);
  });
});
