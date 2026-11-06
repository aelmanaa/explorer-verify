// Tests added when the one-line handle code joined mutation testing (#202; R-FLOW-5, R-AX-5,
// R-SEC-1): each one fails on a code change in src/flow/format-handle.ts that the handle and
// envelope tests let pass.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatHandle,
  redactHandleLine,
  redactSplitHandle,
  splitHandle,
} from "../../src/flow/format-handle.ts";

const ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
// A made-up key shaped like an Etherscan key: 34 letters and digits. Never a real one (R-SEC-1).
const KEY_SHAPED = "ABCDEFGHIJKLMNOPQRSTUVWXYZ01234567";
const PREFIX = `ev1:etherscan-v2:11155111:${ADDRESS}:`;

describe("formatHandle writes the one-line form (R-FLOW-5, R-AX-5)", () => {
  it("joins version, backend, chain id, address and job id with colons", () => {
    assert.equal(
      formatHandle({
        version: 1,
        backend: "sourcify",
        chainId: 11155111,
        address: ADDRESS,
        jobId: "job-1",
      }),
      `ev1:sourcify:11155111:${ADDRESS}:job-1`,
    );
  });
});

describe("splitHandle finds the job id of a one-line handle (R-SEC-1)", () => {
  it("splits after the fourth colon, and keeps every later colon in the job id", () => {
    assert.deepEqual(splitHandle(`${PREFIX}job`), { prefix: PREFIX, jobId: "job" });
    assert.deepEqual(splitHandle(`${PREFIX}a:b`), { prefix: PREFIX, jobId: "a:b" });
    assert.deepEqual(splitHandle(PREFIX), { prefix: PREFIX, jobId: "" });
  });

  it("gives nothing for four parts or fewer, another prefix, or a value that is not text", () => {
    assert.equal(splitHandle(`ev1:etherscan-v2:11155111:${ADDRESS}`), undefined);
    assert.equal(splitHandle("ev1:"), undefined);
    assert.equal(splitHandle(`ev2:etherscan-v2:11155111:${ADDRESS}:job`), undefined);
    assert.equal(splitHandle(`xev1:etherscan-v2:11155111:${ADDRESS}:job`), undefined);
    assert.equal(splitHandle(undefined), undefined);
    assert.equal(splitHandle(1), undefined);
  });
});

describe("redactHandleLine redacts only the job id of a handle (R-SEC-1)", () => {
  it("keeps a key-shaped job id that is no known secret, so the handle still resumes", () => {
    assert.equal(redactHandleLine(`${PREFIX}${KEY_SHAPED}`, []), `${PREFIX}${KEY_SHAPED}`);
    assert.equal(
      redactSplitHandle({ prefix: PREFIX, jobId: KEY_SHAPED }, []),
      `${PREFIX}${KEY_SHAPED}`,
    );
  });

  it("redacts a job id that holds a known secret", () => {
    assert.equal(redactHandleLine(`${PREFIX}${KEY_SHAPED}`, [KEY_SHAPED]), `${PREFIX}[redacted]`);
  });

  it("redacts text that is not a handle as a whole, bare key shape included", () => {
    assert.equal(redactHandleLine(`id ${KEY_SHAPED}`, []), "id [redacted]");
  });
});
