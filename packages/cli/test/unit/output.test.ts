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

describe("stdoutText of a dry run (R-AX-8)", () => {
  const base = {
    status: "dry-run",
    backend: "sourcify",
    apiHost: "sourcify.dev",
    lookup: "none",
  } as const;
  const tail = ": no match, so verify would submit. Nothing was submitted.\n";

  it("says how the backend was chosen, and says nothing for a backend the caller named", () => {
    const cases = [
      ["table", ", the routing table's pick"],
      ["fallback", ", the Sourcify fallback"],
      ["api-url", ", at the API URL given"],
      ["caller", ""],
    ] as const;
    for (const [routedBy, why] of cases) {
      assert.equal(
        stdoutText(toEnvelope({ ...base, routedBy }), false, false),
        `dry run on sourcify at sourcify.dev${why}${tail}`,
      );
    }
  });

  it("leaves the reason out for a result without routedBy, as an older one has", () => {
    assert.equal(
      stdoutText(toEnvelope(base), false, false),
      `dry run on sourcify at sourcify.dev${tail}`,
    );
  });
});
