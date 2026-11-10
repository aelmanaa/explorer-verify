// The sample request docs/user/start/greeter-sepolia.json: it is valid against the core's
// input.schema.json, it is what the library's builders make from the Greeter fixture, and a dry
// run of it on the built bin, against the fake explorer's recorded Sourcify answers, prints the
// documented envelope. No test here touches the network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { buildVerifyInput, validateInput } from "explorer-verify";

import { envelopeProblems, inputProblems, oneEnvelope } from "../helpers/schema.ts";
import { shellExamples } from "../helpers/shell-examples.ts";
import { PROJECT, runBin } from "../helpers/spawn-bin.ts";

const TIMEOUT = { timeout: 30_000 };
const SAMPLE = fileURLToPath(
  new URL("../../../../docs/user/start/greeter-sepolia.json", import.meta.url),
);
const START = fileURLToPath(new URL("../../../../docs/user/start/", import.meta.url));
const PACKAGES_PAGE = "which-package.md";
const ADDRESS = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const SEPOLIA = 11155111;

/** The parsed sample request. */
function sample(): unknown {
  return JSON.parse(readFileSync(SAMPLE, "utf8"));
}

/** The parsed JSON file `relative` of the Foundry fixture project. */
function fixture(relative: string): unknown {
  return JSON.parse(readFileSync(new URL(relative, `file://${PROJECT}`), "utf8"));
}

/** A field of a JSON object, or `undefined`. */
function field(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const found: unknown = Reflect.get(value, name);
  return found;
}

describe("sample request greeter-sepolia.json", { concurrency: true }, () => {
  it("is valid against input.schema.json and validateInput()", () => {
    const request = sample();
    assert.deepEqual(inputProblems(request), []);
    assert.deepEqual(validateInput(request), request);
  });

  it("is what the builders make from the Greeter fixture, with no route", () => {
    const built = buildVerifyInput(
      [fixture("out/build-info/greeter.json"), fixture("out/Greeter.sol/Greeter.json")],
      { contract: "src/Greeter.sol:Greeter" },
    );
    assert.deepEqual(sample(), validateInput({ chainId: SEPOLIA, address: ADDRESS, ...built }));
    assert.equal(field(sample(), "route"), undefined);
  });

  it("holds no local path and no key", () => {
    const text = readFileSync(SAMPLE, "utf8");
    assert.doesNotMatch(text, /\/Users\/|\/home\/|[A-Za-z]:\\|file:\/\//);
    assert.doesNotMatch(text, /apikey|api_key|apiKey/i);
  });

  it("dry-runs to status dry-run, backend sourcify, lookup exact", TIMEOUT, async () => {
    const result = await runBin(["verify", "--input-json", SAMPLE, "--dry-run", "--json"], {
      cwd: PROJECT,
      fake: { scenario: "verified" },
    });
    assert.equal(result.code, 0, result.stderr);
    const envelope = oneEnvelope(result.stdout);
    assert.deepEqual(envelopeProblems(envelope), [], result.stdout);
    assert.equal(envelope["ok"], true, result.stdout);
    const output = envelope["result"];
    assert.equal(field(output, "status"), "dry-run", result.stdout);
    assert.equal(field(output, "backend"), "sourcify", result.stdout);
    assert.equal(field(output, "lookup"), "exact", result.stdout);
    assert.equal(field(output, "routedBy"), "table", result.stdout);
  });
});

describe("the dry run on start/which-package.md", { concurrency: true }, () => {
  const examples = shellExamples(readFileSync(`${START}${PACKAGES_PAGE}`, "utf8"), PACKAGES_PAGE);

  it("is one dry run of the sample request", () => {
    assert.deepEqual(
      examples.map(({ args }) => args.join(" ")),
      ["verify --input-json greeter-sepolia.json --dry-run --json"],
    );
  });

  for (const example of examples) {
    it(`line ${String(example.line)} prints what the page shows`, TIMEOUT, async () => {
      const result = await runBin(example.args, { cwd: START, fake: { scenario: "verified" } });
      assert.equal(result.code, example.exitCode, result.stderr);
      assert.equal(result.stdout, example.stdout);
    });
  }
});
