// verify and status on the built bin (R-AX-7, R-AX-8, R-AX-16), against the fake explorer loaded
// before the bin. The fake writes one line per request to a log, so a test counts the submits.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { envelopeProblems, oneEnvelope } from "../helpers/schema.ts";
import { PROJECT, runBin } from "../helpers/spawn-bin.ts";

const TIMEOUT = { timeout: 30_000 };
const ADDRESS = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const FOUNDRY = [
  "--input",
  "out/build-info/greeter.json",
  "--input",
  "out/Greeter.sol/Greeter.json",
];
const ETHERSCAN = ["--backend", "etherscan-v2", "--api-url", "https://api.etherscan.io/v2/api"];

const DIR = mkdtempSync(join(tmpdir(), "explorer-verify-bin-verify-"));
after(() => {
  rmSync(DIR, { recursive: true, force: true });
});
let runs = 0;

/** A field of a JSON object, or `undefined`. */
function field(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const found: unknown = Reflect.get(value, name);
  return found;
}

/** Runs the bin in the Foundry project against the fake explorer; returns its requests too. */
async function bin(args: string[], scenario = "verified", stdin?: string) {
  runs += 1;
  const log = join(DIR, `requests-${String(runs)}.jsonl`);
  const result = await runBin(args, {
    cwd: PROJECT,
    fake: { scenario, log },
    ...(stdin === undefined ? {} : { stdin: { text: stdin } }),
  });
  const lines = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  const requests = lines.map((line): unknown => JSON.parse(line));
  const submits = requests.filter((request) => field(request, "submit") === true).length;
  const envelope = oneEnvelope(result.stdout);
  assert.deepEqual(envelopeProblems(envelope), [], result.stdout);
  return { ...result, envelope, requests: requests.length, submits };
}

describe("bin: verify and status", { concurrency: true }, () => {
  it("--dry-run sends no submit and exits 0 (R-AX-8)", TIMEOUT, async () => {
    const result = await bin(
      ["verify", ADDRESS, "--chain", "11155111", ...FOUNDRY, "--dry-run", "--json"],
      "new",
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests, 1);
    assert.equal(result.submits, 0);
    assert.equal(field(result.envelope["result"], "lookup"), "none");
  });

  it(
    "--dry-run with no Etherscan key sends nothing and says the lookup was skipped (R-AX-8)",
    TIMEOUT,
    async () => {
      const result = await bin([
        "verify",
        ADDRESS,
        "--chain",
        "11155111",
        ...FOUNDRY,
        ...ETHERSCAN,
        "--dry-run",
        "--json",
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.requests, 0);
      assert.equal(field(result.envelope["result"], "lookup"), "skipped");
    },
  );

  it("exits 3 with missing-api-key before any request (R-AX-7)", TIMEOUT, async () => {
    const result = await bin([
      "verify",
      ADDRESS,
      "--chain",
      "11155111",
      ...FOUNDRY,
      ...ETHERSCAN,
      "--json",
    ]);
    assert.equal(result.code, 3);
    assert.equal(field(result.envelope["error"], "code"), "missing-api-key");
    assert.equal(result.requests, 0);
  });

  it("reads the request piped on stdin with --input-json - (R-AX-16)", TIMEOUT, async () => {
    const text = readFileSync(join(PROJECT, "verify-input.json"), "utf8");
    const result = await bin(["verify", "--input-json", "-", "--json"], "verified", text);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(field(result.envelope["result"], "status"), "already-verified");
    assert.equal(result.submits, 0);
  });
});
