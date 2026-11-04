// stdout without --json: a short summary of a result, nothing for an error (R-AX-6).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExplorerVerifyError, toEnvelope } from "explorer-verify";

import { stdoutText } from "../../src/output.ts";

const URL = "https://repo.sourcify.dev/1/0x5fbdb2315678afecb367f032d93f642f64180aa3";

describe("stdoutText", () => {
  it("prints the envelope as one JSON line with --json", () => {
    const envelope = toEnvelope({ status: "verified", backend: "sourcify", match: "exact" });
    assert.equal(stdoutText(envelope, true, true), `${JSON.stringify(envelope)}\n`);
  });

  it("summarises a success, with the explorer page when there is one", () => {
    assert.equal(
      stdoutText(
        toEnvelope({ status: "verified", backend: "sourcify", match: "exact", explorerUrl: URL }),
        false,
        false,
      ),
      `verified: exact match on sourcify\n${URL}\n`,
    );
    assert.equal(
      stdoutText(
        toEnvelope({ status: "already-verified", backend: "sourcify", match: "partial" }),
        false,
        true,
      ),
      "\u001B[32malready-verified\u001B[0m: partial match on sourcify\n",
    );
  });

  it("summarises a failure with its reason", () => {
    assert.equal(
      stdoutText(
        toEnvelope({ status: "failed", backend: "sourcify", reason: "Bytecode differs." }),
        false,
        false,
      ),
      "failed on sourcify: Bytecode differs.\n",
    );
  });

  it("prints nothing for an error without --json", () => {
    const error = new ExplorerVerifyError({ code: "invalid-input", issues: [] }, "Bad.", {
      secrets: [],
    });
    assert.equal(stdoutText(toEnvelope(error), false, false), "");
  });
});
