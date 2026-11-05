// A submitting verify needs an explicit target (#212, decision 0043, R-AX-8, R-AX-9, R-AX-15,
// R-AX-16): --backend <name> or --backend auto, and --api-url only with --backend (#225). Without
// one, verify exits 2 before any request, whatever the terminal, CI or --json. Every request goes
// to the fake explorer in globalThis.fetch, so a count of zero means nothing left the process.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { TestContext } from "node:test";

import type { VerifyInput } from "explorer-verify";

import { main } from "../../src/main.ts";
import { eventMessage } from "../../src/stderr.ts";
import { refusal } from "../../src/target.ts";
import { fakeExplorer } from "../helpers/fake-explorer.ts";
import type { Scenario, Seen } from "../helpers/fake-explorer.ts";
import { fakeIo } from "../helpers/fake-io.ts";
import type { FakeIoOptions } from "../helpers/fake-io.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";
import { envelopeProblems, oneEnvelope } from "../helpers/schema.ts";
import { PROJECT } from "../helpers/spawn-bin.ts";

const ADDRESS = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const FOUNDRY = [
  "--input",
  join(PROJECT, "out/build-info/greeter.json"),
  "--input",
  join(PROJECT, "out/Greeter.sol/Greeter.json"),
];
const BARE = ["verify", ADDRESS, "--chain", "11155111", ...FOUNDRY];
const UNLISTED = ["verify", ADDRESS, "--chain", "999999", ...FOUNDRY];
const AUTO = ["--backend", "auto"];
const FALLBACK = "--allow-sourcify-fallback";
// A lower-case dummy key: nothing but the CLI's own redaction can remove it.
const KEY = "dummytargetkey0q8z2m4x";
// The Sepolia row, in its order of preference.
const LISTED = "etherscan-v2, sourcify, blockscout and routescan";

const DIR = mkdtempSync(join(tmpdir(), "explorer-verify-target-"));
after(() => {
  rmSync(DIR, { recursive: true, force: true });
});
const KEY_FILE = join(DIR, "key.txt");
writeFileSync(KEY_FILE, `${KEY}\n`);

/** The project's request, without its route, with `route` when given. */
function request(route?: Record<string, string>): string {
  const parsed: unknown = JSON.parse(readFileSync(join(PROJECT, "verify-input.json"), "utf8"));
  assert.ok(typeof parsed === "object" && parsed !== null);
  const fields = new Map(Object.entries(parsed));
  fields.delete("route");
  if (route !== undefined) {
    fields.set("route", route);
  }
  return JSON.stringify(Object.fromEntries(fields));
}

/** Writes the request to a new file and returns its path. */
function requestFile(name: string, route?: Record<string, string>): string {
  const path = join(DIR, name);
  writeFileSync(path, request(route));
  return path;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  seen: Seen[];
}

/** Runs the CLI against the fake explorer on mock timers. */
async function run(
  t: TestContext,
  argv: readonly string[],
  scenario: Scenario = "new",
  options: FakeIoOptions = {},
): Promise<Run> {
  const seen: Seen[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    fakeExplorer(scenario, (seenRequest) => {
      seen.push(seenRequest);
    }),
  );
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const fake = fakeIo(argv, options);
  const running = main(fake.io);
  await driveMockClock(running, () => {
    t.mock.timers.runAll();
  });
  const code = await running;
  t.mock.timers.reset();
  return { code, stdout: fake.stdout(), stderr: fake.stderr(), seen };
}

/** The error object of the envelope, after checking it against the schema. */
function errorOf(result: Run): Record<string, unknown> {
  const envelope = oneEnvelope(result.stdout);
  assert.deepEqual(envelopeProblems(envelope), [], result.stdout);
  const error = envelope["error"];
  assert.ok(typeof error === "object" && error !== null, result.stdout);
  return Object.fromEntries(Object.entries(error));
}

/** Checks exit 2 `invalid-input` with zero requests, and returns the message and the hint. */
function refused(result: Run): { message: string; hint: string } {
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.deepEqual(result.seen, []);
  const error = errorOf(result);
  assert.equal(error["code"], "invalid-input");
  return { message: String(error["message"]), hint: String(error["hint"]) };
}

const submits = (result: Run): number => result.seen.filter((each) => each.submit).length;

describe("verify without a target exits 2 before any request (R-AX-8)", () => {
  it("is the same with and without a terminal, CI and --json", async (t) => {
    const cases: { json: boolean; tty: boolean; ci: boolean }[] = [];
    for (const json of [true, false]) {
      for (const tty of [true, false]) {
        for (const ci of [true, false]) {
          cases.push({ json, tty, ci });
        }
      }
    }
    for (const { json, tty, ci } of cases) {
      const label = `json=${String(json)} tty=${String(tty)} ci=${String(ci)}`;
      const result = await run(t, json ? [...BARE, "--json"] : BARE, "new", {
        stdoutIsTerminal: tty,
        stderrIsTerminal: tty,
        stdinIsTerminal: tty,
        env: ci ? { CI: "true" } : {},
      });
      assert.equal(result.code, 2, label);
      assert.deepEqual(result.seen, [], label);
      if (json) {
        assert.equal(errorOf(result)["code"], "invalid-input", label);
      } else {
        assert.equal(result.stdout, "", label);
        assert.match(result.stderr, /--backend is needed to submit/, label);
      }
    }
  });

  it("names the backends the chain lists and auto's pick without a key", async (t) => {
    const { message, hint } = refused(await run(t, [...BARE, "--json"]));
    assert.match(message, /--backend is needed to submit/);
    assert.equal(
      hint,
      `Name where to submit: pass --backend with one of the backends chain 11155111 lists (${LISTED}) or blockscout-hosted with BLOCKSCOUT_API_KEY, or pass --backend auto for the routing table's pick, which is sourcify, because no API key is set for etherscan-v2. Add --dry-run to see the target without submitting.`,
    );
  });

  it("names auto's pick with a key, and never the key", async (t) => {
    const result = await run(t, [...BARE, "--json"], "new", {
      env: { ETHERSCAN_API_KEY: KEY },
    });
    const { hint } = refused(result);
    assert.match(
      hint,
      /pass --backend auto for the routing table's pick, which is etherscan-v2, the first backend chain 11155111 lists\./,
    );
    assert.ok(!result.stdout.includes(KEY) && !result.stderr.includes(KEY));
  });

  it("does not take --allow-sourcify-fallback as a target", async (t) => {
    refused(await run(t, [...BARE, FALLBACK, "--json"]));
    const { hint } = refused(await run(t, [...UNLISTED, FALLBACK, "--json"]));
    assert.match(
      hint,
      /pass --backend auto for the routing table's pick, which is the public Sourcify API, because the routing table has no row for chain 999999\./,
    );
    assert.doesNotMatch(hint, /lists \(/);
  });

  it("says a chain without a row needs the fallback or --api-url", async (t) => {
    const { hint } = refused(await run(t, [...UNLISTED, "--json"]));
    assert.match(
      hint,
      /no row for chain 999999: pass --backend auto with --allow-sourcify-fallback to use the public Sourcify API, --backend blockscout-hosted with BLOCKSCOUT_API_KEY, or --backend with --api-url\./,
    );
  });

  it("refuses --input-json without route.backend, naming the request field", async (t) => {
    const result = await run(t, ["verify", "--input-json", requestFile("bare.json"), "--json"]);
    const { message, hint } = refused(result);
    assert.match(message, /route\.backend is needed to submit/);
    assert.match(hint, /set route\.backend to one of the backends chain 11155111 lists/);
    assert.match(hint, /set route\.backend "auto" for the routing table's pick, which is sourcify/);
  });

  it("names route.apiUrl for a chain without a row in --input-json", async (t) => {
    const path = join(DIR, "unlisted.json");
    writeFileSync(path, request().replace('"chainId":11155111', '"chainId":999999'));
    const { hint } = refused(await run(t, ["verify", "--input-json", path, "--json"]));
    assert.match(
      hint,
      /no row for chain 999999: set route\.backend with route\.apiUrl, or set route\.backend "blockscout-hosted" with BLOCKSCOUT_API_KEY\./,
    );
  });

  it("refuses with a key the address holds, and never prints it", async (t) => {
    const key = "8275d36f64f047d2d8a1";
    const result = await run(t, [...BARE, "--json"], "new", { env: { ETHERSCAN_API_KEY: key } });
    const { message, hint } = refused(result);
    assert.match(message, /--backend is needed/);
    assert.ok(!hint.includes(key));
  });
});

describe("--backend auto submits to the routing table's pick (R-AX-15)", () => {
  it("submits to sourcify without a key and prints the routed line at info", async (t) => {
    const result = await run(t, [...BARE, ...AUTO]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(submits(result), 1);
    assert.match(
      result.stderr,
      /^Routed to sourcify at sourcify\.dev, the routing table's pick: etherscan-v2 skipped, because no API key is set for it\.$/m,
    );
  });

  it("writes routedBy and skipped in the JSON line", async (t) => {
    const result = await run(t, [...BARE, ...AUTO, "--log-format", "json"]);
    assert.equal(result.code, 0, result.stderr);
    const routed = result.stderr
      .split("\n")
      .filter((line) => line.includes('"verify.routed"'))
      .map((line): unknown => JSON.parse(line));
    assert.deepEqual(routed, [
      {
        schemaVersion: 1,
        level: "info",
        message:
          "Routed to sourcify at sourcify.dev, the routing table's pick: etherscan-v2 skipped, because no API key is set for it.",
        type: "verify.routed",
        backend: "sourcify",
        apiHost: "sourcify.dev",
        routedBy: "table",
        skipped: "etherscan-v2",
      },
    ]);
  });

  it("accepts --backend blockscout-hosted as a target, with its key from BLOCKSCOUT_API_KEY", async (t) => {
    // Without the key: a target all the same, so the run reaches the key check, exit 3.
    const noKey = await run(t, [...BARE, "--backend", "blockscout-hosted", "--json"]);
    assert.equal(noKey.code, 3, noKey.stdout);
    assert.equal(errorOf(noKey)["code"], "missing-api-key");
    assert.deepEqual(noKey.seen, []);
    // A dry run resolves the hosted API: without the key it skips the lookup and sends nothing.
    const dry = await run(t, [...BARE, "--backend", "blockscout-hosted", "--dry-run", "--json"]);
    assert.equal(dry.code, 0, dry.stdout);
    assert.match(dry.stdout, /"backend":"blockscout-hosted","apiHost":"api\.blockscout\.com"/);
    assert.match(dry.stdout, /"lookup":"skipped","routedBy":"caller"/);
    assert.deepEqual(dry.seen, []);
    // With the key from BLOCKSCOUT_API_KEY, the run goes to the hosted host and never prints it.
    const keyed = await run(t, [...BARE, "--backend", "blockscout-hosted", "--json"], "new", {
      env: { BLOCKSCOUT_API_KEY: KEY },
    });
    assert.notEqual(keyed.code, 2, keyed.stdout);
    assert.ok(keyed.seen.every((sent) => sent.host === "api.blockscout.com"));
    assert.ok(!keyed.stdout.includes(KEY) && !keyed.stderr.includes(KEY));
  });

  it("keeps the routed line at debug for a named backend", async (t) => {
    const result = await run(t, [...BARE, "--backend", "sourcify"]);
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /Routed to/);
  });

  it("takes route.backend auto from --input-json, and route.backend sourcify", async (t) => {
    const auto = await run(t, [
      "verify",
      "--input-json",
      requestFile("auto.json", { backend: "auto" }),
      "--json",
    ]);
    assert.equal(auto.code, 0, auto.stdout);
    assert.equal(submits(auto), 1);
    const named = await run(t, [
      "verify",
      "--input-json",
      requestFile("named.json", { backend: "sourcify" }),
      "--json",
    ]);
    assert.equal(named.code, 0, named.stdout);
    assert.equal(submits(named), 1);
  });
});

describe("auto stands alone, and --api-url needs --backend (R-AX-9, #225)", () => {
  it("refuses auto with another --backend", async (t) => {
    const { message } = refused(
      await run(t, [...BARE, ...AUTO, "--backend", "sourcify", "--json"]),
    );
    assert.match(message, /--backend cannot combine auto with another backend/);
  });

  it("refuses --api-url alone and with auto, in a dry run too", async (t) => {
    const url = ["--api-url", "https://sourcify.dev/server"];
    for (const extra of [[], ["--dry-run"]]) {
      const { message } = refused(await run(t, [...BARE, ...url, ...extra, "--json"]));
      assert.match(message, /--api-url needs --backend naming the backend that serves this API/);
    }
    const { message } = refused(await run(t, [...BARE, ...url, ...AUTO, "--dry-run", "--json"]));
    assert.match(message, /not auto: the URL replaces the routing table/);
  });

  it("refuses route.apiUrl without route.backend in --input-json", async (t) => {
    const path = requestFile("url.json", { apiUrl: "https://sourcify.dev/server" });
    const { message } = refused(
      await run(t, ["verify", "--input-json", path, "--dry-run", "--json"]),
    );
    assert.match(message, /route\.apiUrl needs route\.backend naming the backend/);
  });

  it("refuses a key from --api-key-file or --api-key-stdin with auto", async (t) => {
    const file = await run(t, [...BARE, ...AUTO, "--api-key-file", KEY_FILE, "--json"]);
    assert.match(refused(file).message, /--api-key-file cannot be used with --backend auto/);
    const stdin = await run(t, [...BARE, ...AUTO, "--api-key-stdin", "--json"], "new", {
      stdin: [KEY],
    });
    assert.match(refused(stdin).message, /--api-key-stdin cannot be used with --backend auto/);
    for (const result of [file, stdin]) {
      assert.ok(!result.stdout.includes(KEY) && !result.stderr.includes(KEY));
    }
  });
});

describe("--dry-run needs no target and says where it would submit (R-AX-8)", () => {
  it("reports routedBy and prints the routed line at info", async (t) => {
    const json = await run(t, [...BARE, "--dry-run", "--json"]);
    assert.equal(json.code, 0, json.stdout);
    const envelope = oneEnvelope(json.stdout);
    assert.deepEqual(envelopeProblems(envelope), []);
    assert.deepEqual(envelope["result"], {
      status: "dry-run",
      backend: "sourcify",
      apiHost: "sourcify.dev",
      lookup: "none",
      routedBy: "table",
    });
    assert.match(json.stderr, /^Routed to sourcify at sourcify\.dev, the routing table's pick/m);
    const text = await run(t, [...BARE, "--dry-run", "--backend", "sourcify"]);
    assert.equal(
      text.stdout,
      "dry run on sourcify at sourcify.dev: no match, so verify would submit. Nothing was submitted.\n",
    );
    const fallback = await run(t, [...UNLISTED, FALLBACK, "--dry-run"]);
    assert.match(fallback.stdout, /^dry run on sourcify at sourcify\.dev, the Sourcify fallback:/);
    assert.match(
      fallback.stderr,
      /the Sourcify fallback for a chain the routing table does not list\./,
    );
  });

  it("leaves status unchanged: no routed line at the default level", async (t) => {
    const handle = `ev1:sourcify:11155111:${ADDRESS}:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718`;
    const result = await run(t, ["status", handle]);
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /Routed to/);
  });
});

describe("the refusal's hint from routesFor() (R-AX-8)", () => {
  const input: VerifyInput = {
    chainId: 7,
    address: ADDRESS,
    compiler: {
      kind: "solc",
      version: "0.8.24+commit.e11b9ed9",
      input: { language: "Solidity", sources: {}, settings: {} },
    },
    contractName: "src/Greeter.sol:Greeter",
  };

  it("still refuses, with a hint of the options alone, when the routing table cannot be read", async () => {
    const error = await refusal(input, {}, "--backend", async () => {
      throw new TypeError("chunk failed to load");
    });
    assert.equal(error.code, "invalid-input");
    assert.equal(
      error.hint,
      "Name where to submit: --backend with a backend name, or auto for the routing table's pick. Add --dry-run to see the target without submitting.",
    );
  });

  it("says the key is missing when every backend of the row needs one", async () => {
    const error = await refusal(input, {}, "--backend", async () => ({
      listed: ["etherscan-v2"],
      pick: { backend: "etherscan-v2", routedBy: "table", skipped: [], keyMissing: true },
    }));
    assert.match(
      error.hint,
      /which is etherscan-v2, but every backend chain 7 lists needs an API key and none is set, so the submit would exit 3 with missing-api-key\./,
    );
  });
});

describe("the verify.routed line (R-AX-15)", () => {
  const base = { type: "verify.routed", backend: "sourcify", apiHost: "sourcify.dev" } as const;

  it("says how the backend was chosen, for one or several skipped backends", () => {
    assert.equal(
      eventMessage({ ...base, routedBy: "table", skipped: "etherscan-v2,etherscan-compatible" }),
      "Routed to sourcify at sourcify.dev, the routing table's pick: etherscan-v2, etherscan-compatible skipped, because no API key is set for them.",
    );
    assert.equal(
      eventMessage({ ...base, routedBy: "table" }),
      "Routed to sourcify at sourcify.dev, the first backend the routing table lists for the chain.",
    );
    assert.equal(
      eventMessage({ ...base, routedBy: "caller" }),
      "Routed to sourcify at sourcify.dev, the backend the caller named.",
    );
    assert.equal(
      eventMessage({ ...base, routedBy: "api-url" }),
      "Routed to sourcify at sourcify.dev, the API URL the caller gave.",
    );
    assert.equal(eventMessage(base), "Routed to sourcify at sourcify.dev.");
  });
});
