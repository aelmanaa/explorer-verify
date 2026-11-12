// --require-own-source on the built bin (R-AX-5, R-AX-7, R-AX-11, R-AX-16, decision 0069, issue
// #351): a run whose explorer holds another contract's source at the address, already-verified with
// storedContract, exits 1 with ok false; without the flag it exits 0, as before. The fake explorer's
// other-source scenario replays Sourcify's recorded match of another contract (#293) and its
// refusal of the submit.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { envelopeProblems, oneEnvelope } from "../helpers/schema.ts";
import { PROJECT, runBin } from "../helpers/spawn-bin.ts";
import type { BinResult } from "../helpers/spawn-bin.ts";

const TIMEOUT = { timeout: 30_000 };
const ADDRESS = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const INPUTS = [
  "--input",
  "out/build-info/greeter.json",
  "--input",
  "out/Greeter.sol/Greeter.json",
];
const VERIFY = ["verify", ADDRESS, "--chain", "11155111", ...INPUTS];
// A dummy key in lower-case hex. Never a real one.
const KEY = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";
const FLAG = "--require-own-source";

const DIR = mkdtempSync(join(tmpdir(), "explorer-verify-own-source-"));
after(() => {
  rmSync(DIR, { recursive: true, force: true });
});

/** Runs the bin in the CLI's project fixture against the fake explorer. */
async function run(args: readonly string[], scenario = "other-source"): Promise<BinResult> {
  return await runBin(args, {
    cwd: PROJECT,
    fake: { scenario },
    env: { ETHERSCAN_API_KEY: KEY },
  });
}

/** The envelope of a run, checked against the shipped schema, and `ok` against the exit code. */
function envelopeOf(result: BinResult): Record<string, unknown> {
  const envelope = oneEnvelope(result.stdout);
  assert.deepEqual(envelopeProblems(envelope), [], result.stdout);
  assert.equal(envelope["ok"], result.code === 0, result.stdout);
  return envelope;
}

/** A field of an object read from JSON. */
function field(value: unknown, name: string): unknown {
  assert.ok(typeof value === "object" && value !== null);
  return Reflect.get(value, name);
}

describe("bin: --require-own-source (#351)", { concurrency: true }, () => {
  it(
    "leaves another contract's source at exit 0 and ok true without the flag",
    TIMEOUT,
    async () => {
      const result = await run([...VERIFY, "--backend", "sourcify", "--json"]);
      assert.equal(result.code, 0, result.stderr);
      const envelope = envelopeOf(result);
      assert.equal(field(envelope["result"], "status"), "already-verified");
      assert.notEqual(field(envelope["result"], "storedContract"), undefined);
    },
  );

  it("exits 1 with ok false and the result kept, and says why on stderr", TIMEOUT, async () => {
    const result = await run([...VERIFY, "--backend", "sourcify", FLAG, "--json"]);
    assert.equal(result.code, 1, result.stderr);
    const envelope = envelopeOf(result);
    assert.equal(envelope["ok"], false);
    assert.equal(envelope["error"], undefined);
    const stored = field(envelope["result"], "storedContract");
    assert.equal(field(stored, "name"), "simplestorage2.sol:SimpleStorage");
    assert.match(
      result.stderr,
      /sourcify holds another contract's source at the address, not this one, so --require-own-source fails the run\./,
    );
    // The summary without --json marks the status as a failure.
    const text = await run([...VERIFY, "--backend", "sourcify", FLAG]);
    assert.equal(text.code, 1);
    assert.match(
      text.stdout,
      /^already-verified: partial match on sourcify, from another contract's source/,
    );
  });

  // References: decision 0067. A partial match of the caller's own source is not another
  // contract's source, with --submit-over-partial or without it.
  for (const [scenario, extra, status] of [
    ["partial", [], "already-verified"],
    ["partial", ["--submit-over-partial"], "verified"],
    ["partial-rejected", ["--submit-over-partial"], "already-verified"],
  ] as const) {
    it(
      `keeps exit 0 for a partial match of the caller's own source: ${scenario} ${extra.join(" ")}`,
      TIMEOUT,
      async () => {
        const result = await run(
          [...VERIFY, "--backend", "sourcify", ...extra, FLAG, "--json"],
          scenario,
        );
        assert.equal(result.code, 0, result.stderr);
        const envelope = envelopeOf(result);
        assert.equal(field(envelope["result"], "status"), status);
        assert.equal(field(envelope["result"], "storedContract"), undefined);
      },
    );
  }

  it("keeps exit 0 for the caller's own source with the flag", TIMEOUT, async () => {
    const result = await run([...VERIFY, "--backend", "sourcify", FLAG, "--json"], "verified");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(field(envelopeOf(result)["result"], "storedContract"), undefined);
  });

  it("is accepted next to --input-json (R-AX-16)", TIMEOUT, async () => {
    const path = join(DIR, "request.json");
    writeFileSync(path, readFileSync(join(PROJECT, "verify-input.json"), "utf8"));
    const result = await run(["verify", "--input-json", path, FLAG, "--json"]);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(envelopeOf(result)["ok"], false);
  });

  it(
    "fails only the backend that holds another contract's source, on several backends",
    TIMEOUT,
    async () => {
      const backends = ["--backend", "sourcify", "--backend", "etherscan-v2"];
      const plain = await run([...VERIFY, ...backends, "--json"]);
      assert.equal(plain.code, 0, plain.stderr);
      assert.equal(envelopeOf(plain)["ok"], true);
      const gated = await run([...VERIFY, ...backends, FLAG, "--json"]);
      assert.equal(gated.code, 1, gated.stderr);
      const outcomes = field(envelopeOf(gated)["result"], "outcomes");
      assert.ok(Array.isArray(outcomes));
      assert.deepEqual(
        outcomes.map((outcome) => [field(outcome, "backend"), field(outcome, "ok")]),
        [
          ["sourcify", false],
          ["etherscan-v2", true],
        ],
      );
      assert.equal(field(field(outcomes[0], "result"), "status"), "already-verified");
    },
  );

  it(
    "is not an option of status, which never sees another contract's source",
    TIMEOUT,
    async () => {
      const handle = `ev1:sourcify:11155111:${ADDRESS}:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718`;
      const result = await run(["status", handle, FLAG, "--json"]);
      assert.equal(result.code, 2);
      assert.equal(field(envelopeOf(result)["error"], "code"), "invalid-input");
    },
  );

  it("is listed in verify --help (R-AX-11)", TIMEOUT, async () => {
    const result = await run(["verify", "--help"]);
    assert.equal(result.code, 0);
    assert.match(
      result.stdout,
      /--require-own-source +Exit 1, with ok false, when the explorer holds/,
    );
  });
});
