// stdout without --json: a short summary of a result, nothing for an error (R-AX-6).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExplorerVerifyError } from "explorer-verify";
import { toEnvelope } from "explorer-verify/envelope";

import { stdoutText } from "../../src/output.ts";

const URL = "https://repo.sourcify.dev/1/0x5fbdb2315678afecb367f032d93f642f64180aa3";

describe("stdoutText", () => {
  it("formats proxy result envelopes passed by SDK callers", () => {
    const implementation = `0x${"ab".repeat(20)}` as const;
    assert.equal(
      stdoutText(
        toEnvelope({
          status: "linked",
          backend: "blockscout",
          implementation,
          implementationVerified: true,
        }),
        false,
        false,
      ),
      `linked on blockscout: ${implementation}\n`,
    );
    assert.equal(
      stdoutText(
        toEnvelope({
          status: "mismatch",
          backend: "blockscout",
          expectedImplementation: implementation,
        }),
        false,
        false,
      ),
      `mismatch on blockscout: expected ${implementation}\n`,
    );
    assert.equal(
      stdoutText(
        toEnvelope({ status: "not-linked", backend: "blockscout", reason: "refused" }),
        false,
        false,
      ),
      "not-linked on blockscout: refused\n",
    );
  });
  // Decision 0063: the summary names the other contract whose source the explorer holds.
  it("names another contract's source in an already-verified result and a dry run", () => {
    const storedContract = { name: "SimpleStorage", compilerVersion: "0.8.33+commit.64118f21" };
    assert.equal(
      stdoutText(
        toEnvelope({
          status: "already-verified",
          backend: "sourcify",
          match: "partial",
          explorerUrl: URL,
          storedContract,
        }),
        false,
        false,
      ),
      `already-verified: partial match on sourcify, from another contract's source (SimpleStorage, compiler 0.8.33+commit.64118f21)\n${URL}\n`,
    );
    assert.equal(
      stdoutText(
        toEnvelope({
          status: "dry-run",
          backend: "blockscout",
          apiHost: "eth-sepolia.blockscout.com",
          lookup: "partial",
          storedContract: { name: "Auction\u001bProxy" },
        }),
        false,
        false,
      ),
      "dry run on blockscout at eth-sepolia.blockscout.com: partial match from another contract's source (Auction\\u001bProxy, compiler not given), so a run without --dry-run would submit. Nothing was submitted.\n",
    );
    assert.equal(
      stdoutText(
        toEnvelope({
          status: "already-verified",
          backend: "routescan",
          match: "partial",
          storedContract: { compilerVersion: "v0.8.27+commit.40a35a09" },
        }),
        false,
        false,
      ),
      "already-verified: partial match on routescan, from another contract's source (no name given, compiler v0.8.27+commit.40a35a09)\n",
    );
  });

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
  const tail = ": no match, so a run without --dry-run would submit. Nothing was submitted.\n";

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
