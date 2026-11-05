// The verify and status commands in-process (R-DX-1, R-FLOW-5, R-AX-7, R-AX-8, R-AX-14, R-AX-16).
// Every request goes to the fake explorer in globalThis.fetch, so the CLI injects no fetch and the
// key checks stay on. Waits run on mock timers.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { TestContext } from "node:test";

import { main } from "../../src/main.ts";
import { JOB, fakeExplorer } from "../helpers/fake-explorer.ts";
import type { Scenario, Seen } from "../helpers/fake-explorer.ts";
import { fakeIo } from "../helpers/fake-io.ts";
import type { FakeIoOptions } from "../helpers/fake-io.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";
import { envelopeProblems, oneEnvelope } from "../helpers/schema.ts";
import { PROJECT } from "../helpers/spawn-bin.ts";

const ADDRESS = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const HANDLE = `ev1:sourcify:11155111:${ADDRESS}:${JOB}`;
const PAGE = `https://repo.sourcify.dev/11155111/${ADDRESS}`;
const ETHERSCAN = ["--backend", "etherscan-v2", "--api-url", "https://api.etherscan.io/v2/api"];
const SOURCIFY = ["--backend", "sourcify"];
const AUTO = ["--backend", "auto"];
const BUILDS = new URL("../../../explorer-verify/test/fixtures/build-formats/", import.meta.url);
const FOUNDRY = [
  "--input",
  join(PROJECT, "out/build-info/greeter.json"),
  "--input",
  join(PROJECT, "out/Greeter.sol/Greeter.json"),
];
const REQUEST_FILE = join(PROJECT, "verify-input.json");
const REQUEST_TEXT = readFileSync(REQUEST_FILE, "utf8");

/** The fields of a JSON object. */
function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

const REQUEST = record(JSON.parse(REQUEST_TEXT));
// A lower-case dummy key: nothing but the CLI's own redaction can remove it.
const KEY = "dummyverifycmdkey0q8z2m";

const DIR = mkdtempSync(join(tmpdir(), "explorer-verify-verify-"));
after(() => {
  rmSync(DIR, { recursive: true, force: true });
});
const KEY_FILE = join(DIR, "key.txt");
writeFileSync(KEY_FILE, `${KEY}\n`);

/** Writes `text` to a new file in the temporary folder and returns its path. */
function file(name: string, text: string): string {
  const path = join(DIR, name);
  writeFileSync(path, text);
  return path;
}

/** A path inside the core package's build-format fixtures. */
function build(path: string): string {
  return new URL(path, BUILDS).pathname;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  seen: Seen[];
  stdinOpened: number;
}

/**
 * Runs the CLI against the fake explorer, running the pending mock timers until the run ends, so
 * a poll interval or a time budget passes at once.
 */
async function run(
  t: TestContext,
  argv: readonly string[],
  scenario: Scenario = "verified",
  options: FakeIoOptions = {},
): Promise<Run> {
  const seen: Seen[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    fakeExplorer(scenario, (request) => {
      seen.push(request);
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
  return {
    code,
    stdout: fake.stdout(),
    stderr: fake.stderr(),
    seen,
    stdinOpened: fake.stdinOpened(),
  };
}

/** The envelope on stdout, checked against the shipped schema. */
function envelope(result: Run): Record<string, unknown> {
  const parsed = oneEnvelope(result.stdout);
  assert.deepEqual(envelopeProblems(parsed), [], result.stdout);
  return parsed;
}

/** The `result` or `error` object of the envelope. */
function part(result: Run, name: "result" | "error"): Record<string, unknown> {
  const value = envelope(result)[name];
  assert.ok(typeof value === "object" && value !== null);
  return Object.fromEntries(Object.entries(value));
}

/** The `invalid-input` message of a usage error, after checking exit code 2. */
function usage(result: Run): string {
  assert.equal(result.code, 2, result.stdout);
  const error = part(result, "error");
  assert.equal(error["code"], "invalid-input");
  return String(error["message"]);
}

const submits = (result: Run): number => result.seen.filter((request) => request.submit).length;

describe("verify from build files (R-DX-1)", () => {
  it("verifies from a Foundry build-info and artifact: submit, poll, verified", async (t) => {
    const result = await run(
      t,
      ["verify", ADDRESS, "--chain", "11155111", ...FOUNDRY, ...AUTO, "--json"],
      "new",
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(part(result, "result"), {
      status: "verified",
      backend: "sourcify",
      match: "exact",
      explorerUrl: PAGE,
    });
    assert.equal(submits(result), 1);
  });

  it("verifies from a Hardhat 3 build-info and artifact", async (t) => {
    const result = await run(
      t,
      [
        "verify",
        ADDRESS,
        "--chain",
        "11155111",
        "--input",
        build("hardhat-3.21.2/build-info.json"),
        "--input",
        build("hardhat-3.21.2/Greeter.json"),
        ...SOURCIFY,
        "--json",
      ],
      "new",
    );
    assert.equal(result.code, 0, result.stdout);
    assert.equal(part(result, "result")["status"], "verified");
    assert.equal(submits(result), 1);
  });

  it("verifies from a bare Standard JSON input, with --contract and --compiler-version", async (t) => {
    const result = await run(
      t,
      [
        "verify",
        ADDRESS,
        "--chain",
        "11155111",
        "--input",
        build("solc-0.8.24-library/input.json"),
        "--contract",
        "src/Counter.sol:Counter",
        "--compiler-version",
        "0.8.24+commit.e11b9ed9",
        "--library",
        "src/Tally.sol:Tally=0x5A0b54D5dc17e0AadC383d2db43B0a0D3E029c4c",
        ...SOURCIFY,
        "--json",
      ],
      "new",
    );
    assert.equal(result.code, 0, result.stdout);
    assert.equal(part(result, "result")["status"], "verified");
  });

  it("takes the address first, without the word verify, and returns already-verified", async (t) => {
    const result = await run(t, [ADDRESS, "--chain", "11155111", ...FOUNDRY, ...SOURCIFY]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `already-verified: exact match on sourcify\n${PAGE}\n`);
    assert.equal(submits(result), 0);
  });

  it("passes --constructor-args and --creation-tx to the input check", async (t) => {
    const message = usage(
      await run(t, [
        "verify",
        ADDRESS,
        "--chain",
        "11155111",
        ...FOUNDRY,
        "--constructor-args",
        "0x1",
        "--creation-tx",
        "0x12",
        "--json",
      ]),
    );
    assert.match(message, /constructorArgs/);
    assert.match(message, /creationTxHash/);
  });

  it("gives incomplete-input, exit 2, when the files are not enough", async (t) => {
    const result = await run(t, [
      "verify",
      ADDRESS,
      "--chain",
      "11155111",
      "--input",
      build("solc-0.8.24-library/input.json"),
      "--json",
    ]);
    assert.equal(result.code, 2);
    assert.equal(part(result, "error")["code"], "incomplete-input");
    assert.equal(result.seen.length, 0);
  });

  it("gives unsupported-compiler, exit 2, for a zksolc build-info (R-IN-7)", async (t) => {
    // A foundry-zksync build-info: the solc fixture with a ZkSolcVersionedInput as its input.
    const buildInfo = record(
      JSON.parse(readFileSync(build("foundry-1.8.1/build-info.json"), "utf8")),
    );
    const input = record(buildInfo["input"]);
    const zksolc = file(
      "zksolc-build-info.json",
      JSON.stringify({
        ...buildInfo,
        input: {
          language: input["language"],
          sources: input["sources"],
          settings: input["settings"],
          solc_version: "0.8.24",
          cli_settings: {},
          zksolc_version: "1.5.15",
        },
      }),
    );
    const result = await run(t, ["verify", ADDRESS, "--chain", "300", "--input", zksolc, "--json"]);
    assert.equal(result.code, 2, result.stdout);
    const error = part(result, "error");
    assert.equal(error["code"], "unsupported-compiler");
    // The envelope has no details; the message names the field.
    assert.match(String(error["message"]), /: input\.zksolc_version\.$/);
    assert.match(String(error["hint"]), /zksolc \(EraVM\)/);
    assert.equal(result.seen.length, 0);
  });
});

describe("verify: usage errors name options, never values (R-AX-5, R-AX-9)", () => {
  it("needs the address, --chain and --input", async (t) => {
    const message = usage(await run(t, ["verify", "--json"]));
    assert.match(message, /verify needs the contract address/);
    assert.match(message, /--chain is needed/);
    assert.match(message, /--input is needed/);
  });

  it("refuses a bad --chain, --timeout and --library", async (t) => {
    for (const chain of ["0", "-1", "1.5", "abc", "99999999999999999"]) {
      const message = usage(
        await run(t, ["verify", ADDRESS, "--chain", chain, ...FOUNDRY, "--json"]),
      );
      assert.match(message, /--chain must be a positive whole number/, chain);
    }
    for (const timeout of ["0", "1.5", "2147484", "x"]) {
      const message = usage(
        await run(t, [
          "verify",
          ADDRESS,
          "--chain",
          "1",
          ...FOUNDRY,
          "--timeout",
          timeout,
          "--json",
        ]),
      );
      assert.match(message, /--timeout must be a whole number of seconds/, timeout);
    }
    const libraries = usage(
      await run(t, [
        "verify",
        ADDRESS,
        "--chain",
        "1",
        ...FOUNDRY,
        "--library",
        "secretvalue",
        "--library",
        "a.sol:A=",
        "--library",
        "a.sol:A=0x1",
        "--library",
        "a.sol:A=0x2",
        "--json",
      ]),
    );
    assert.match(libraries, /--library\[1\] must be path:Name=address/);
    assert.match(libraries, /--library\[2\] must be path:Name=address/);
    assert.match(libraries, /--library\[4\] names a library that an earlier --library names/);
    assert.doesNotMatch(libraries, /secretvalue/);
  });

  it("names the --input that cannot be read or parsed, never its path", async (t) => {
    const broken = file("broken-input.json", "{ not json");
    const folder = join(DIR, "folder.json");
    mkdirSync(folder, { recursive: true });
    const message = usage(
      await run(t, [
        "verify",
        ADDRESS,
        "--chain",
        "1",
        "--input",
        join(DIR, "missing-secretname.json"),
        "--input",
        broken,
        "--input",
        folder,
        "--json",
      ]),
    );
    assert.match(message, /--input\[1\] names a file that cannot be read \(ENOENT\)/);
    assert.match(message, /--input\[2\] is not valid JSON/);
    assert.match(message, /--input\[3\] must name a regular file/);
    assert.doesNotMatch(message, /secretname|broken-input/);
  });

  it("refuses --backend given twice for status: one handle, one backend", async (t) => {
    const message = usage(
      await run(t, ["status", HANDLE, "--backend", "sourcify", "--backend", "sourcify", "--json"]),
    );
    assert.match(message, /--backend can be given only once/);
  });
});

describe("verify with --backend repeated runs verifyEach() (R-RT-4, R-AX-5, R-AX-7)", () => {
  const BOTH = ["--backend", "sourcify", "--backend", "etherscan-v2"];
  const VERIFY = ["verify", ADDRESS, "--chain", "11155111", ...FOUNDRY];

  it("prints one envelope with an outcome per backend, exits 0, and sends each key only to its backend", async (t) => {
    const result = await run(t, [...VERIFY, ...BOTH, "--json"], "verified", {
      env: { ETHERSCAN_API_KEY: KEY },
    });
    assert.equal(result.code, 0, result.stdout);
    const { outcomes } = part(result, "result");
    assert.ok(Array.isArray(outcomes));
    const list: readonly unknown[] = outcomes;
    assert.deepEqual(
      list.map((each) => [record(each)["backend"], record(each)["ok"]]),
      [
        ["sourcify", true],
        ["etherscan-v2", true],
      ],
    );
    assert.equal(envelope(result)["ok"], true);
    assert.deepEqual(
      result.seen.map((seen) => `${seen.host} keyed=${String(seen.keyed)}`).toSorted(),
      ["api.etherscan.io keyed=true", "sourcify.dev keyed=false"],
    );
    assert.ok(!result.stdout.includes(KEY) && !result.stderr.includes(KEY));
  });

  it("exits 3 when one backend has no key, and still verifies on the other", async (t) => {
    const result = await run(t, [...VERIFY, ...BOTH, "--json"], "verified");
    assert.equal(result.code, 3, result.stdout);
    assert.equal(envelope(result)["ok"], false);
    const { outcomes } = part(result, "result");
    assert.ok(Array.isArray(outcomes));
    const list: readonly unknown[] = outcomes;
    assert.equal(record(list[0])["ok"], true);
    assert.equal(record(record(list[1])["error"])["code"], "missing-api-key");
    assert.ok(result.seen.every((seen) => seen.host === "sourcify.dev"));
  });

  it("prints a line per backend without --json", async (t) => {
    const result = await run(t, [...VERIFY, ...BOTH], "verified");
    assert.equal(result.code, 3);
    assert.match(result.stdout, /^already-verified: exact match on sourcify\n/);
    assert.match(result.stdout, /\nmissing-api-key on etherscan-v2: /);
  });

  it("prints the handle of a backend that ends pending, and exits 4", async (t) => {
    const result = await run(
      t,
      [...VERIFY, "--backend", "sourcify", "--backend", "etherscan-compatible", "--timeout", "5"],
      "pending",
    );
    // No row lists etherscan-compatible: not-confirmed (4), resumable work, wins over
    // unsupported-chain (2). The exit code names one outcome; read every line.
    assert.equal(result.code, 4, result.stdout);
    assert.match(result.stdout, /^not-confirmed on sourcify: .*\nHandle: ev1:sourcify:/);
    assert.match(result.stdout, /\nunsupported-chain on etherscan-compatible: /);
  });

  const refused: [string, string[], RegExp][] = [
    ["--api-url", ["--api-url", "https://example.org/api"], /--api-url cannot be combined/],
    ["--api-key-file", ["--api-key-file", KEY_FILE], /--api-key-file cannot be combined/],
    ["--dry-run", ["--dry-run"], /--dry-run cannot be combined/],
    ["the same backend twice", ["--backend", "sourcify"], /--backend\[3\] names a backend/],
    ["an unknown backend", ["--backend", "nope"], /--backend\[3\] must be one of/],
  ];
  for (const [name, extra, expected] of refused) {
    it(`refuses ${name} with a repeated --backend, exit 2, sending nothing`, async (t) => {
      const result = await run(t, [...VERIFY, ...BOTH, ...extra, "--json"]);
      assert.match(usage(result), expected);
      assert.equal(result.seen.length, 0);
      assert.ok(!result.stdout.includes(KEY));
    });
  }
});

describe("timeout and resume (R-FLOW-5, R-AX-7, R-AX-14)", () => {
  it("exits 4 with the handle when the budget runs out, then status exits 0", async (t) => {
    const pending = await run(
      t,
      [
        "verify",
        ADDRESS,
        "--chain",
        "11155111",
        ...FOUNDRY,
        ...SOURCIFY,
        "--timeout",
        "5",
        "--json",
      ],
      "pending",
    );
    assert.equal(pending.code, 4, pending.stdout);
    const error = part(pending, "error");
    assert.equal(error["code"], "not-confirmed");
    assert.equal(error["handle"], HANDLE);
    // The verify.submitted line carries the handle at the default level (R-AX-14).
    assert.match(pending.stderr, new RegExp(`Handle: ${HANDLE}`));

    const resumed = await run(t, ["status", HANDLE, "--json"], "new");
    assert.equal(resumed.code, 0, resumed.stdout);
    assert.deepEqual(part(resumed, "result"), {
      status: "verified",
      backend: "sourcify",
      match: "exact",
      explorerUrl: PAGE,
    });
    assert.equal(submits(resumed), 0);
  });

  it("status needs a handle, and refuses a bad one with exit 2", async (t) => {
    assert.match(usage(await run(t, ["status", "--json"])), /status needs the handle/);
    const bad = await run(t, ["status", "ev1:nothing", "--json"]);
    assert.equal(bad.code, 2);
    assert.equal(bad.seen.length, 0);
  });
});

describe("--dry-run (R-AX-8)", () => {
  it("looks the contract up and sends no submit", async (t) => {
    const result = await run(
      t,
      ["verify", ADDRESS, "--chain", "11155111", ...FOUNDRY, "--dry-run", "--json"],
      "new",
    );
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(part(result, "result"), {
      status: "dry-run",
      backend: "sourcify",
      apiHost: "sourcify.dev",
      lookup: "none",
      routedBy: "table",
    });
    assert.equal(result.seen.length, 1);
    assert.equal(submits(result), 0);
  });

  it("prints a summary without --json", async (t) => {
    const none = await run(t, [ADDRESS, "--chain", "11155111", ...FOUNDRY, "--dry-run"], "new");
    assert.equal(
      none.stdout,
      "dry run on sourcify at sourcify.dev, the routing table's pick: no match, so verify would submit. Nothing was submitted.\n",
    );
    const found = await run(t, [ADDRESS, "--chain", "11155111", ...FOUNDRY, "--dry-run"]);
    assert.equal(
      found.stdout,
      `dry run on sourcify at sourcify.dev, the routing table's pick: exact match already, so verify would not submit.\n${PAGE}\n`,
    );
    const skipped = await run(t, [
      ADDRESS,
      "--chain",
      "11155111",
      ...FOUNDRY,
      ...ETHERSCAN,
      "--dry-run",
    ]);
    assert.equal(
      skipped.stdout,
      "dry run on etherscan-v2 at api.etherscan.io, at the API URL given: lookup skipped, because etherscan-v2 needs an API key and none is set. Nothing was submitted.\n",
    );
  });

  it("exits 0 with no key for Etherscan, says the lookup was skipped, and sends nothing", async (t) => {
    const result = await run(t, [
      "verify",
      ADDRESS,
      "--chain",
      "11155111",
      ...FOUNDRY,
      ...ETHERSCAN,
      "--dry-run",
      "--json",
    ]);
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(part(result, "result"), {
      status: "dry-run",
      backend: "etherscan-v2",
      apiHost: "api.etherscan.io",
      lookup: "skipped",
      routedBy: "api-url",
    });
    assert.deepEqual(result.seen, []);
    assert.match(result.stderr, /skipped the lookup/);
  });

  it("looks Etherscan up with a key from --api-key-file, and never prints the key", async (t) => {
    const result = await run(t, [
      "verify",
      ADDRESS,
      "--chain",
      "11155111",
      ...FOUNDRY,
      ...ETHERSCAN,
      "--api-key-file",
      KEY_FILE,
      "--dry-run",
      "--json",
      "--verbose",
    ]);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(part(result, "result")["lookup"], "exact");
    assert.deepEqual(
      result.seen.map(({ host, action, keyed, submit }) => [host, action, keyed, submit]),
      [["api.etherscan.io", "getsourcecode", true, false]],
    );
    assert.ok(!result.stdout.includes(KEY) && !result.stderr.includes(KEY));
  });
});

describe("a missing key (R-AX-7)", () => {
  it("exits 3 with missing-api-key before any request, for an Etherscan route with no key", async (t) => {
    const result = await run(t, [
      "verify",
      ADDRESS,
      "--chain",
      "11155111",
      ...FOUNDRY,
      ...ETHERSCAN,
      "--json",
    ]);
    assert.equal(result.code, 3, result.stdout);
    assert.equal(part(result, "error")["code"], "missing-api-key");
    assert.deepEqual(result.seen, []);
  });

  it("exits 3 for status too, before any request", async (t) => {
    const result = await run(t, [
      "status",
      `ev1:etherscan-v2:11155111:${ADDRESS}:abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmn`,
      ...ETHERSCAN,
      "--json",
    ]);
    assert.equal(result.code, 3, result.stdout);
    assert.deepEqual(result.seen, []);
  });
});

describe("--input-json (R-AX-16)", () => {
  it("gives the same stdout as the same request as flags, from a file and from stdin", async (t) => {
    const flags = await run(t, [
      "verify",
      ADDRESS,
      "--chain",
      "11155111",
      ...FOUNDRY,
      ...SOURCIFY,
      "--json",
    ]);
    const fromFile = await run(t, ["verify", "--input-json", REQUEST_FILE, "--json"]);
    const fromStdin = await run(t, ["verify", "--input-json", "-", "--json"], "verified", {
      stdin: [REQUEST_TEXT],
    });
    assert.equal(flags.code, 0, flags.stdout);
    assert.equal(fromFile.stdout, flags.stdout);
    assert.equal(fromStdin.stdout, flags.stdout);
    assert.equal(fromStdin.stdinOpened, 1);
  });

  it("takes the route from the request, so --api-key-file can name its key", async (t) => {
    const path = file(
      "etherscan-request.json",
      JSON.stringify({
        ...REQUEST,
        route: { backend: "etherscan-v2", apiUrl: "https://api.etherscan.io/v2/api" },
      }),
    );
    const keyed = await run(t, [
      "verify",
      "--input-json",
      path,
      "--api-key-file",
      KEY_FILE,
      "--dry-run",
      "--json",
    ]);
    assert.equal(keyed.code, 0, keyed.stdout);
    assert.equal(part(keyed, "result")["backend"], "etherscan-v2");
    assert.equal(keyed.seen[0]?.keyed, true);
    const missing = await run(t, ["verify", "--input-json", path, "--json"]);
    assert.equal(missing.code, 3);
    assert.deepEqual(missing.seen, []);
  });

  it("refuses malformed JSON, a request that is not an object, and a bad route", async (t) => {
    assert.match(
      usage(await run(t, ["verify", "--input-json", file("bad.json", "{ secretword"), "--json"])),
      /--input-json is not valid JSON/,
    );
    assert.match(
      usage(await run(t, ["verify", "--input-json", file("list.json", "[]"), "--json"])),
      /--input-json must be a JSON object/,
    );
    const route = usage(
      await run(t, [
        "verify",
        "--input-json",
        file("route.json", JSON.stringify({ route: { backend: 1, apiUrl: false } })),
        "--json",
      ]),
    );
    assert.match(route, /route\.backend must be a string/);
    assert.match(route, /route\.apiUrl must be a string/);
    assert.match(
      usage(
        await run(t, [
          "verify",
          "--input-json",
          file("route-list.json", JSON.stringify({ route: [] })),
          "--json",
        ]),
      ),
      /route must be an object/,
    );
  });

  it("names route.backend, not --backend, for a bad backend in the request", async (t) => {
    const path = file(
      "bad-backend.json",
      JSON.stringify({ ...REQUEST, route: { backend: "nowhere" } }),
    );
    const message = usage(await run(t, ["verify", "--input-json", path, "--json"]));
    assert.match(message, /route\.backend must be one of/);
    assert.doesNotMatch(message, /--backend must/);
    const flag = usage(
      await run(t, ["verify", ADDRESS, "--chain", "1", ...FOUNDRY, "--backend", "x", "--json"]),
    );
    assert.match(flag, /--backend must be one of/);
  });

  it("refuses --input-json given twice", async (t) => {
    const message = usage(
      await run(t, ["verify", "--input-json", REQUEST_FILE, "--input-json", "-", "--json"]),
    );
    assert.match(message, /--input-json can be given only once/);
  });

  it("refuses any other request flag and any argument, with exit 2", async (t) => {
    const message = usage(
      await run(t, [
        "verify",
        ADDRESS,
        "--input-json",
        REQUEST_FILE,
        "--chain",
        "1",
        "--backend",
        "sourcify",
        "--json",
      ]),
    );
    assert.match(message, /--chain cannot be combined with --input-json/);
    assert.match(message, /--backend cannot be combined with --input-json/);
    assert.match(message, /verify takes no arguments with --input-json/);
    const allowed = await run(t, [
      "verify",
      "--input-json",
      REQUEST_FILE,
      "--json",
      "--quiet",
      "--color",
      "never",
      "--log-format",
      "json",
      "--timeout",
      "60",
      "--dry-run",
    ]);
    assert.equal(allowed.code, 0, allowed.stdout);
  });

  it("counts unknown properties in one issue, without naming them", async (t) => {
    const base = REQUEST;
    const path = file(
      "unknown.json",
      JSON.stringify({
        ...base,
        secretfield: 1,
        compiler: { ...record(base["compiler"]), hiddenname: 2 },
        route: { otherprop: 3 },
      }),
    );
    const result = await run(t, ["verify", "--input-json", path, "--json"]);
    const message = usage(result);
    assert.match(message, /--input-json has 3 properties that are not request fields/);
    assert.doesNotMatch(message, /secretfield|hiddenname|otherprop/);
    const one = file("one-unknown.json", JSON.stringify({ ...base, extra: true }));
    assert.match(
      usage(await run(t, ["verify", "--input-json", one, "--json"])),
      /has 1 property that is not a request field/,
    );
    assert.deepEqual(result.seen, []);
  });

  it("refuses --input-json - with --api-key-stdin, and a terminal on stdin, without reading", async (t) => {
    const both = await run(t, ["verify", "--input-json", "-", "--api-key-stdin", "--json"]);
    assert.match(usage(both), /--api-key-stdin cannot be combined with --input-json -/);
    assert.equal(both.stdinOpened, 0);
    const terminal = await run(t, ["status", "--input-json", "-", "--json"], "verified", {
      stdinIsTerminal: true,
    });
    assert.match(
      usage(terminal),
      /--input-json needs the JSON piped on stdin, and stdin is a terminal/,
    );
  });

  it("reads a status request, and refuses one without a string handle", async (t) => {
    const ok = await run(
      t,
      ["status", "--input-json", file("status.json", JSON.stringify({ handle: HANDLE })), "--json"],
      "new",
    );
    assert.equal(ok.code, 0, ok.stdout);
    assert.equal(part(ok, "result")["status"], "verified");
    assert.match(
      usage(
        await run(t, [
          "status",
          "--input-json",
          file("status-bad.json", JSON.stringify({ handle: 5 })),
          "--json",
        ]),
      ),
      /handle must be the handle in its one-line form/,
    );
    assert.match(
      usage(await run(t, ["status", HANDLE, "--input-json", REQUEST_FILE, "--json"])),
      /status takes no arguments with --input-json/,
    );
  });
});

describe("verify with an RPC URL (R-IN-3, R-AX-9)", () => {
  // Plain lower-case dummies, in the path and in the query.
  const PATH_SECRET = "verifycmdrpcpathsecret";
  const QUERY_SECRET = "verifycmdrpcquerysecret";
  const RPC_FILE = file("rpc.txt", `https://rpc.example.org/v2/${PATH_SECRET}?k=${QUERY_SECRET}\n`);

  function assertNoSecret(result: Run): void {
    const output = `${result.stdout}${result.stderr}`.toLowerCase();
    assert.ok(!output.includes(PATH_SECRET) && !output.includes(QUERY_SECRET), output);
  }

  it("passes the URL of --rpc-url-file to a dry run, which checks it and calls nothing", async (t) => {
    const result = await run(t, [
      "verify",
      ADDRESS,
      "--chain",
      "11155111",
      ...FOUNDRY,
      "--rpc-url-file",
      RPC_FILE,
      "--dry-run",
      "--json",
      "--verbose",
    ]);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(part(result, "result")["status"], "dry-run");
    assert.ok(result.seen.every((request) => request.host !== "rpc.example.org"));
    assertNoSecret(result);
  });

  it("with --backend repeated, Etherscan's derivation calls the URL of --rpc-url-file, and no output shows it (R-RT-4, R-SEC-1)", async (t) => {
    const result = await run(
      t,
      [
        "verify",
        ADDRESS,
        "--chain",
        "11155111",
        ...FOUNDRY,
        "--creation-tx",
        `0x${"ab".repeat(32)}`,
        "--backend",
        "sourcify",
        "--backend",
        "etherscan-v2",
        "--rpc-url-file",
        RPC_FILE,
        "--json",
        "--verbose",
        "--log-format",
        "json",
      ],
      "new",
      { env: { ETHERSCAN_API_KEY: KEY } },
    );
    // The fake RPC endpoint and the fake Etherscan submit refuse, so Etherscan's outcome is an
    // error; what matters is that the request reached the RPC host and nothing printed the URL.
    assert.ok(result.seen.some((request) => request.host === "rpc.example.org"));
    const { outcomes } = part(result, "result");
    assert.ok(Array.isArray(outcomes));
    const list: readonly unknown[] = outcomes;
    assert.deepEqual(
      list.map((each) => record(each)["backend"]),
      ["sourcify", "etherscan-v2"],
    );
    assertNoSecret(result);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(KEY));
  });

  it("the library checks the URL: plain http to another host exits 2 naming rpcUrl", async (t) => {
    const path = file("rpc-http.txt", `http://rpc.example.org/${PATH_SECRET}`);
    const result = await run(t, [
      "verify",
      ADDRESS,
      "--chain",
      "11155111",
      ...FOUNDRY,
      "--rpc-url-file",
      path,
      "--dry-run",
      "--json",
    ]);
    assert.match(usage(result), /rpcUrl/);
    assert.deepEqual(result.seen, []);
    assertNoSecret(result);
  });

  it("lists the issues of --timeout and --rpc-url together, before reading the input", async (t) => {
    const result = await run(t, [
      "verify",
      "--timeout",
      "0",
      "--rpc-url",
      `https://rpc.example.org/${PATH_SECRET}`,
      "--json",
    ]);
    const message = usage(result);
    assert.match(message, /--timeout must be a whole number/);
    assert.match(message, /--rpc-url has a part that can hold a key/);
    assertNoSecret(result);
  });

  it("--rpc-url-file may accompany --input-json; the request has no field for it (R-AX-16)", async (t) => {
    const ok = await run(t, [
      "verify",
      "--input-json",
      REQUEST_FILE,
      "--rpc-url-file",
      RPC_FILE,
      "--dry-run",
      "--json",
    ]);
    assert.equal(ok.code, 0, ok.stdout);
    const inRequest = file("rpc-in-request.json", JSON.stringify({ ...REQUEST, rpcUrl: "x" }));
    assert.match(
      usage(await run(t, ["verify", "--input-json", inRequest, "--json"])),
      /has 1 property that is not a request field/,
    );
  });

  it("--rpc-url-file can be given only once, like --rpc-url", async (t) => {
    const result = await run(t, [
      "verify",
      "--rpc-url-file",
      RPC_FILE,
      "--rpc-url-file",
      RPC_FILE,
      "--json",
    ]);
    assert.match(usage(result), /--rpc-url-file can be given only once/);
  });

  it("status takes no RPC URL", async (t) => {
    assert.match(
      usage(await run(t, ["status", HANDLE, "--rpc-url-file", RPC_FILE, "--json"])),
      /--rpc-url-file is not an option of status/,
    );
  });
});

describe("--allow-sourcify-fallback (R-RT-2, R-AX-5, R-AX-8, R-AX-16)", () => {
  // No routing-table row lists this chain.
  const UNLISTED = ["verify", ADDRESS, "--chain", "999999", ...FOUNDRY];
  const UNLISTED_HANDLE = `ev1:sourcify:999999:${ADDRESS}:${JOB}`;
  const FALLBACK = "--allow-sourcify-fallback";
  const HINT =
    "Pass --allow-sourcify-fallback to verify on the public Sourcify API, or pass --api-url with --backend.";
  const SOURCIFY_URL = ["--api-url", "https://sourcify.dev/server"];

  /** The `unsupported-chain` error of a chain without a row, sent before any request. */
  function noRow(result: Run): void {
    assert.equal(result.code, 2, result.stdout);
    const error = part(result, "error");
    assert.equal(error["code"], "unsupported-chain");
    assert.equal(error["hint"], HINT);
    assert.deepEqual(result.seen, []);
  }

  it("dry runs a chain without a row on Sourcify, and shows the Sourcify contract page", async (t) => {
    const result = await run(t, [...UNLISTED, FALLBACK, "--dry-run", "--json"]);
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(part(result, "result"), {
      status: "dry-run",
      backend: "sourcify",
      apiHost: "sourcify.dev",
      lookup: "exact",
      explorerUrl: `https://repo.sourcify.dev/999999/${ADDRESS}`,
      routedBy: "fallback",
    });
    assert.equal(submits(result), 0);
  });

  it("without it, exits 2 with unsupported-chain and a hint that names it", async (t) => {
    noRow(await run(t, [...UNLISTED, "--dry-run", "--json"]));
    noRow(await run(t, [...UNLISTED, ...AUTO, "--json"]));
    noRow(await run(t, [...UNLISTED, "--backend", "sourcify", "--json"]));
    noRow(await run(t, ["status", UNLISTED_HANDLE, "--json"]));
    const text = await run(t, [...UNLISTED.slice(1), "--dry-run"]);
    assert.equal(text.code, 2);
    assert.match(text.stderr, /hint: Pass --allow-sourcify-fallback/);
  });

  it("verifies on Sourcify, alone or with --backend sourcify, and changes nothing on a listed chain", async (t) => {
    const alone = await run(t, [...UNLISTED, FALLBACK, ...AUTO, "--json"]);
    assert.equal(alone.code, 0, alone.stdout);
    assert.deepEqual(part(alone, "result"), {
      status: "already-verified",
      backend: "sourcify",
      match: "exact",
      explorerUrl: `https://repo.sourcify.dev/999999/${ADDRESS}`,
    });
    const named = await run(t, [...UNLISTED, "--backend", "sourcify", FALLBACK, "--json"]);
    assert.equal(named.code, 0, named.stdout);
    assert.equal(part(named, "result")["status"], "already-verified");
    const listed = ["verify", ADDRESS, "--chain", "11155111", ...FOUNDRY, ...AUTO, "--json"];
    const without = await run(t, listed);
    const withFlag = await run(t, [...listed, FALLBACK]);
    assert.equal(withFlag.code, 0, withFlag.stdout);
    assert.equal(withFlag.stdout, without.stdout);
  });

  it("status polls the Sourcify job of a chain without a row", async (t) => {
    const result = await run(t, ["status", UNLISTED_HANDLE, FALLBACK, "--json"], "new");
    assert.ok(result.seen.some((request) => request.path.endsWith(`/v2/verify/${JOB}`)));
    assert.ok(result.seen.every((request) => request.host === "sourcify.dev"));
    // The recorded job answers are about chain 11155111, so the polls do not confirm this job.
    assert.equal(result.code, 4, result.stdout);
    assert.equal(part(result, "error")["handle"], UNLISTED_HANDLE);
  });

  it("refuses --api-url and a --backend other than sourcify with exit 2, before any request", async (t) => {
    const url = await run(t, [
      ...UNLISTED,
      FALLBACK,
      "--backend",
      "sourcify",
      ...SOURCIFY_URL,
      "--json",
    ]);
    assert.match(
      usage(url),
      /--allow-sourcify-fallback cannot be combined with --api-url: the URL names the server/,
    );
    assert.deepEqual(url.seen, []);
    const other = usage(
      await run(t, [...UNLISTED, FALLBACK, "--backend", "blockscout", "--dry-run", "--json"]),
    );
    assert.match(
      other,
      /--allow-sourcify-fallback cannot be combined with a --backend other than sourcify/,
    );
    const repeated = usage(
      await run(t, [
        ...UNLISTED,
        FALLBACK,
        "--backend",
        "sourcify",
        "--backend",
        "blockscout",
        "--json",
      ]),
    );
    assert.match(repeated, /--backend other than sourcify/);
    const both = usage(
      await run(t, [...UNLISTED, FALLBACK, "--backend", "etherscan-v2", ...SOURCIFY_URL, "--json"]),
    );
    assert.match(
      both,
      /--api-url: .*; --allow-sourcify-fallback cannot be combined with a --backend/,
    );
    const status = usage(
      await run(t, ["status", UNLISTED_HANDLE, FALLBACK, ...SOURCIFY_URL, "--json"]),
    );
    assert.match(status, /--allow-sourcify-fallback cannot be combined with --api-url/);
    assert.match(
      usage(
        await run(t, ["status", UNLISTED_HANDLE, FALLBACK, "--backend", "blockscout", "--json"]),
      ),
      /--backend other than sourcify/,
    );
  });

  it("leaves a backend name that is no backend to the route check", async (t) => {
    const message = usage(await run(t, [...UNLISTED, FALLBACK, "--backend", "nowhere", "--json"]));
    assert.match(message, /--backend must be one of/);
    assert.doesNotMatch(message, /--allow-sourcify-fallback/);
  });

  it("may accompany --input-json, and names the route fields that it cannot be combined with", async (t) => {
    const unlisted = { ...REQUEST, chainId: 999999 };
    const plain = file("fallback.json", JSON.stringify(unlisted));
    const ok = await run(t, ["verify", "--input-json", plain, FALLBACK, "--dry-run", "--json"]);
    assert.equal(ok.code, 0, ok.stdout);
    assert.equal(part(ok, "result")["backend"], "sourcify");
    noRow(await run(t, ["verify", "--input-json", plain, "--dry-run", "--json"]));
    const routed = file(
      "fallback-route.json",
      JSON.stringify({
        ...unlisted,
        route: { backend: "blockscout", apiUrl: "https://example.org/api" },
      }),
    );
    const message = usage(await run(t, ["verify", "--input-json", routed, FALLBACK, "--json"]));
    assert.match(message, /cannot be combined with route\.apiUrl/);
    assert.match(message, /cannot be combined with a route\.backend other than sourcify/);
    const statusRequest = file(
      "fallback-status.json",
      JSON.stringify({
        handle: UNLISTED_HANDLE,
        route: { apiUrl: "https://example.org/api" },
      }),
    );
    assert.match(
      usage(await run(t, ["status", "--input-json", statusRequest, FALLBACK, "--json"])),
      /cannot be combined with route\.apiUrl/,
    );
  });
});
