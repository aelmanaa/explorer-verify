// The flags, help and progress lines a shell user expects (#225), in-process against the fake
// explorer on mock timers: chain names (R-AX-12), --backend all (R-RT-4), --poll-interval, a
// repeated option refused (#221), the short help of a bare command line (R-AX-11) and one stderr
// line per event (R-AX-14). A count of zero requests means nothing left the process.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { TestContext } from "node:test";

import { routesFor } from "explorer-verify";
import type { VerifyInput } from "explorer-verify";

import { CHAIN_NAMES, chainIdOf } from "../../src/chains.ts";
import { main } from "../../src/main.ts";
import { allDryRunRefusal, skippedByAll } from "../../src/target.ts";
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
// A key-shaped dummy: an issue that echoed a value would show it.
const KEY = "DUMMYSHELLFLAGSKEY0Q8Z2M4X6C";
// Keys for both keyed backends of the Sepolia row, so every backend runs.
const KEYS = {
  ETHERSCAN_API_KEY: "dummyetherscankey0q8z2m",
  ROUTESCAN_API_KEY: "dummyroutescankey0q8z2m",
};

const DIR = mkdtempSync(join(tmpdir(), "explorer-verify-shell-flags-"));
after(() => {
  rmSync(DIR, { recursive: true, force: true });
});

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
  return { code, stdout: fake.stdout(), stderr: fake.stderr(), seen };
}

/** Checks exit 2 `invalid-input` with zero requests, and returns the message and the hint. */
function refused(result: Run): { message: string; hint: string } {
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.deepEqual(result.seen, []);
  const envelope = oneEnvelope(result.stdout);
  assert.deepEqual(envelopeProblems(envelope), [], result.stdout);
  const error = envelope["error"];
  assert.ok(typeof error === "object" && error !== null);
  assert.equal(Reflect.get(error, "code"), "invalid-input");
  return {
    message: String(Reflect.get(error, "message")),
    hint: String(Reflect.get(error, "hint")),
  };
}

/** The not-indexed error of a run that exits 4, and the submits the fake got. */
function notIndexed(result: Run): { elapsedMs: number; submits: number } {
  assert.equal(result.code, 4, result.stdout + result.stderr);
  const envelope = oneEnvelope(result.stdout);
  assert.deepEqual(envelopeProblems(envelope), [], result.stdout);
  const error = envelope["error"];
  assert.ok(typeof error === "object" && error !== null);
  assert.equal(Reflect.get(error, "code"), "not-indexed");
  const details: unknown = Reflect.get(error, "details");
  assert.ok(typeof details === "object" && details !== null);
  const submits = result.seen.filter((request) => request.submit).length;
  assert.equal(Reflect.get(details, "submits"), submits);
  return { elapsedMs: Number(Reflect.get(details, "elapsedMs")), submits };
}

/** The chain name the hint of a mistyped `--chain` value suggests. */
function suggest(typed: string): string | undefined {
  const read = chainIdOf(typed);
  return "suggestion" in read ? read.suggestion : undefined;
}

describe("--chain takes a chain name (R-AX-12, #225)", () => {
  it("gives the same stdout for sepolia, SEPOLIA, -c sepolia and 11155111", async (t) => {
    const outputs: string[] = [];
    for (const chain of [
      ["--chain", "11155111"],
      ["--chain", "sepolia"],
      ["--chain=SEPOLIA"],
      ["-c", "sepolia"],
      ["-csepolia"],
    ]) {
      const result = await run(t, ["verify", ADDRESS, ...chain, ...FOUNDRY, "--dry-run", "--json"]);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      outputs.push(result.stdout);
    }
    assert.equal(new Set(outputs).size, 1, outputs.join("\n"));
  });

  it("refuses an unknown name with the closest one, never echoing the value", async (t) => {
    const typo = refused(
      await run(t, ["verify", ADDRESS, "--chain", "sepolai", ...FOUNDRY, "--json"]),
    );
    assert.match(typo.message, /--chain must be a chain ID, such as 11155111, or a chain name/);
    assert.match(typo.hint, /^Did you mean sepolia\?/);
    for (const chain of [KEY, "0", "-1", "1.5", "99999999999999999"]) {
      const { message, hint } = refused(
        await run(t, ["verify", ADDRESS, "--chain", chain, ...FOUNDRY, "--json"]),
      );
      assert.match(message, /--chain must be a chain ID/, chain);
      assert.doesNotMatch(hint, /Did you mean/, chain);
      assert.ok(!message.includes(KEY) && !hint.includes(KEY));
    }
  });

  it("maps every name to a chain the routing table lists, and each name once", async () => {
    for (const [name, chainId] of CHAIN_NAMES) {
      assert.match(name, /^[a-z][a-z0-9-]*$/);
      const routes = await routesFor(chainId);
      assert.ok(
        routes.listed.length > 0,
        `${name} (${String(chainId)}) has no row in the routing table: remove it from packages/cli/src/chains.ts`,
      );
    }
    assert.deepEqual(chainIdOf("mainnet"), { chainId: 1 });
    assert.deepEqual(chainIdOf("ethereum"), { chainId: 1 });
    assert.deepEqual(chainIdOf("999999"), { chainId: 999999 });
    assert.ok(!("suggestion" in chainIdOf("zzzzzzzz")));
  });

  it("takes the aliases op, op-sepolia, amoy, avalanche-fuji, gnosis-chiado, bnb and zksync-sepolia", () => {
    for (const [alias, chainId] of [
      ["op", 10],
      ["op-sepolia", 11155420],
      ["amoy", 80002],
      ["avalanche-fuji", 43113],
      ["gnosis-chiado", 10200],
      ["bnb", 56],
      ["zksync-sepolia", 300],
    ] as const) {
      assert.deepEqual(chainIdOf(alias), { chainId }, alias);
    }
  });

  it("suggests the name with the same form without case, - or _, else the closest one sharing its start", () => {
    for (const [typed, expected] of [
      ["opsepolia", "op-sepolia"],
      ["op_sepolia", "op-sepolia"],
      ["base_sepolia", "base-sepolia"],
      ["basesepolia", "base-sepolia"],
      ["polygonamoy", "polygon-amoy"],
      ["arbitrumsepolia", "arbitrum-sepolia"],
      ["ARBITRUM_SEPOLIA", "arbitrum-sepolia"],
      ["optimism_sepolia", "optimism-sepolia"],
      ["bsc_testnet", "bsc-testnet"],
      ["zk-sync", "zksync"],
      ["op-sepolai", "op-sepolia"],
      ["base-sepolai", "base-sepolia"],
      ["optimsm-sepolia", "optimism-sepolia"],
      ["sepolai", "sepolia"],
      ["ob-sepolia", undefined],
      ["opp-sepolia", "op-sepolia"],
      ["xsepolia", undefined],
      ["zzzzzzzz", undefined],
    ] as const) {
      assert.equal(suggest(typed), expected, typed);
    }
    // A suggestion never drops the start of the typed name: opsepolia is not Ethereum's Sepolia.
    assert.notEqual(suggest("opsepolia"), "sepolia");
    assert.notEqual(suggest("op-sepolai"), "ink-sepolia");
  });
});

describe("a single-value option given twice exits 2 (#221)", () => {
  for (const [option, first, second] of [
    ["--contract", "src/Greeter.sol:Greeter", "src/Other.sol:Other"],
    ["--compiler-version", "0.8.24+commit.e11b9ed9", "0.8.25+commit.b61c2a91"],
    ["--chain", "11155111", "1"],
    ["--timeout", "10", "20"],
    ["--poll-interval", "5", "6"],
  ] as const) {
    it(`refuses ${option} twice, before any request`, async (t) => {
      const chain = option === "--chain" ? [] : ["--chain", "11155111"];
      const argv = ["verify", ADDRESS, ...chain, ...FOUNDRY, option, first, option, second];
      const { message } = refused(await run(t, [...argv, "--dry-run", "--json"]));
      assert.match(message, new RegExp(`${option} can be given only once`));
      assert.ok(!message.includes(second));
    });
  }
});

describe("--api-url needs --backend (#225)", () => {
  it("exits 2 with zero requests", async (t) => {
    const { message } = refused(
      await run(t, [
        "verify",
        ADDRESS,
        "-c",
        "sepolia",
        ...FOUNDRY,
        "--api-url",
        "https://my.blockscout.example/api",
        "-n",
        "--json",
      ]),
    );
    assert.match(message, /--api-url needs --backend naming the backend that serves this API/);
  });

  it("holds for status too, from the flags and from route.apiUrl in --input-json", async (t) => {
    const handle = `ev1:sourcify:11155111:${ADDRESS}:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718`;
    const flags = refused(
      await run(t, ["status", handle, "--api-url", "https://my.blockscout.example/api", "--json"]),
    );
    assert.match(
      flags.message,
      /--api-url needs --backend naming the backend that serves this API/,
    );
    const path = join(DIR, "status.json");
    writeFileSync(
      path,
      JSON.stringify({ handle, route: { apiUrl: "https://my.blockscout.example/api" } }),
    );
    const request = refused(await run(t, ["status", "--input-json", path, "--json"]));
    assert.match(
      request.message,
      /route\.apiUrl needs route\.backend naming the backend that serves this API/,
    );
  });
});

describe("--poll-interval with --input-json (#225)", () => {
  it("is accepted next to the request, as --timeout is", async (t) => {
    const handle = `ev1:sourcify:11155111:${ADDRESS}:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718`;
    const path = join(DIR, "status-poll.json");
    writeFileSync(path, JSON.stringify({ handle }));
    const result = await run(
      t,
      ["status", "--input-json", path, "--poll-interval", "5", "--json"],
      "verified",
    );
    assert.equal(result.code, 0, result.stdout);
  });
});

describe("a run on several backends writes each backend's error to stderr (#225)", () => {
  it("prints the error line and the hint of a backend that failed", async (t) => {
    const result = await run(t, [
      "verify",
      ADDRESS,
      "--chain",
      "11155111",
      ...FOUNDRY,
      "--backend",
      "sourcify",
      "--backend",
      "etherscan-v2",
    ]);
    assert.match(result.stderr, /^error: etherscan-v2: .*\(missing-api-key\)$/m);
    assert.match(result.stderr, /^ {2}hint: .*ETHERSCAN_API_KEY/m);
  });
});

describe("a text dry run prints the routed line and stdout, not the library's lookup line (#225)", () => {
  it("shows the lookup line only at --verbose", async (t) => {
    const argv = ["verify", ADDRESS, "-c", "sepolia", ...FOUNDRY, "-n"];
    const plain = await run(t, argv, "verified");
    assert.equal(plain.code, 0);
    assert.doesNotMatch(plain.stderr, /Dry run: /);
    assert.match(plain.stderr, /^Routed to sourcify/m);
    const verbose = await run(t, [...argv, "--verbose"], "verified");
    assert.match(verbose.stderr, /^debug: Dry run: Sourcify already holds the contract/m);
  });
});

describe("--backend all verifies on every backend of the chain's row (R-RT-4, #225)", () => {
  it("gives the same envelope and exit code as naming each backend of the row", async (t) => {
    const base = ["verify", ADDRESS, "--chain", "11155111", ...FOUNDRY, "--json"];
    const all = await run(t, [...base, "--backend", "all"], "verified", {
      env: KEYS,
    });
    const routes = await routesFor(11155111);
    const named = await run(
      t,
      [...base, ...routes.listed.flatMap((backend) => ["--backend", backend])],
      "verified",
      { env: KEYS },
    );
    assert.equal(all.code, named.code);
    assert.equal(all.stdout, named.stdout);
    assert.deepEqual(envelopeProblems(oneEnvelope(all.stdout)), []);
    const result = oneEnvelope(all.stdout)["result"];
    assert.ok(typeof result === "object" && result !== null);
    const outcomes = Reflect.get(result, "outcomes");
    assert.ok(Array.isArray(outcomes));
    assert.equal(outcomes.length, routes.listed.length);
  });

  it("stands alone: not with another backend, --api-url, a key flag or --dry-run", async (t) => {
    const base = [
      "verify",
      ADDRESS,
      "--chain",
      "11155111",
      ...FOUNDRY,
      "--backend",
      "all",
      "--json",
    ];
    const other = refused(await run(t, [...base, "--backend", "sourcify"]));
    assert.match(other.message, /--backend cannot combine all with another backend/);
    const url = refused(await run(t, [...base, "--api-url", "https://sourcify.dev/server"]));
    assert.match(
      url.message,
      /--api-url needs --backend naming the backend that serves this API, not all/,
    );
    const key = refused(await run(t, [...base, "--api-key-stdin"], "new", { stdin: [KEY] }));
    assert.match(key.message, /--api-key-stdin cannot be used with --backend all/);
    const dry = refused(await run(t, [...base, "-n"]));
    assert.match(dry.message, /--dry-run cannot be combined with --backend all/);
    // The hint names the backends the chain lists, so each can be dry run.
    assert.equal(
      dry.hint,
      "chain 11155111 lists etherscan-v2, sourcify, blockscout, routescan: dry run each with --backend <name> --dry-run.",
    );
  });

  it("names on stderr each backend of the row it skipped for lack of a key, and why", async (t) => {
    const base = ["verify", ADDRESS, "--chain", "11155111", ...FOUNDRY, "--backend", "all"];
    const result = await run(t, base, "verified");
    assert.match(
      result.stderr,
      /^warning: --backend all skipped etherscan-v2: it needs an API key and ETHERSCAN_API_KEY is not set\.$/m,
    );
    const keyed = await run(t, base, "verified", { env: KEYS });
    assert.doesNotMatch(keyed.stderr, /skipped/);
  });

  it("names a skipped backend without a key variable, and words the refusal without a table", async () => {
    assert.deepEqual(skippedByAll(["sourcify", "etherscan-compatible"], ["sourcify"]), [
      "--backend all skipped etherscan-compatible: it needs an API key and no API key is set for it.",
    ]);
    const input: VerifyInput = {
      chainId: 999999,
      address: ADDRESS,
      compiler: {
        kind: "solc",
        version: "0.8.24+commit.e11b9ed9",
        input: { language: "Solidity", sources: {}, settings: {} },
      },
      contractName: "src/Greeter.sol:Greeter",
    };
    const none = await allDryRunRefusal(input, "--backend", async () => ({
      listed: [],
      pick: { backend: "sourcify", routedBy: "fallback", skipped: [], keyMissing: false },
    }));
    assert.equal(none.hint, "The routing table has no row for chain 999999.");
    const broken = await allDryRunRefusal(input, "route.backend", async () => {
      throw new TypeError("no table");
    });
    assert.equal(broken.hint, "Dry run each backend with route.backend <name> --dry-run.");
  });

  it("is refused by status, which resumes one backend", async (t) => {
    const handle = `ev1:sourcify:11155111:${ADDRESS}:job`;
    const { message } = refused(await run(t, ["status", handle, "--backend", "all", "--json"]));
    assert.match(message, /--backend must be one of .*, or auto or all for verify/);
  });
});

describe("--poll-interval (#225)", () => {
  it("waits that many seconds between two polls", async (t) => {
    const handle = `ev1:sourcify:11155111:${ADDRESS}:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718`;
    const result = await run(
      t,
      ["status", handle, "--poll-interval", "30", "--timeout", "100", "--json"],
      "pending",
    );
    assert.equal(result.code, 4, result.stdout);
    // 100 seconds at one poll every 30 seconds: the first poll and three more.
    const polls = result.seen.filter((request) => request.method === "GET").length;
    const fast = await run(
      t,
      ["status", handle, "--poll-interval", "5", "--timeout", "100", "--json"],
      "pending",
    );
    const fastPolls = fast.seen.filter((request) => request.method === "GET").length;
    assert.ok(polls < fastPolls, `${String(polls)} polls at 30 s, ${String(fastPolls)} at 5 s`);
  });

  it("refuses 0, a fraction and a word, for verify and status", async (t) => {
    for (const value of ["0", "1.5", "x", "2147484"]) {
      const verify = refused(
        await run(t, [
          "verify",
          ADDRESS,
          "--chain",
          "1",
          ...FOUNDRY,
          "--poll-interval",
          value,
          "--json",
        ]),
      );
      assert.match(verify.message, /--poll-interval must be a whole number of seconds from 1 to/);
      const status = refused(await run(t, ["status", "ev1:x", "--poll-interval", value, "--json"]));
      assert.match(status.message, /--poll-interval must be a whole number of seconds from 1 to/);
    }
  });
});

// References: R-FLOW-7, R-AX-16, decision 0066.
describe("--index-wait (#352)", () => {
  const VERIFY = [
    "verify",
    ADDRESS,
    "--chain",
    "11155111",
    ...FOUNDRY,
    "--backend",
    "etherscan-v2",
  ];
  const ENV = { env: { ETHERSCAN_API_KEY: KEYS.ETHERSCAN_API_KEY } };

  it("keeps submitting past 10 submits, within the wait, then exits 4 not-indexed", async (t) => {
    const capped = notIndexed(await run(t, [...VERIFY, "--json"], "not-indexed", ENV));
    assert.equal(capped.submits, 10);
    const waited = notIndexed(
      await run(t, [...VERIFY, "--index-wait", "60", "--json"], "not-indexed", ENV),
    );
    assert.ok(waited.submits > 10, String(waited.submits));
    assert.ok(waited.elapsedMs <= 60_000, String(waited.elapsedMs));
  });

  it("prints one warning line per new submit, not two", async (t) => {
    const result = await run(t, [...VERIFY, "--index-wait", "9", "--json"], "not-indexed", ENV);
    const { submits } = notIndexed(result);
    const retries = result.stderr
      .split("\n")
      .filter((line) => line.startsWith("warning: Retrying"));
    assert.equal(retries.length, submits - 1, result.stderr);
    assert.doesNotMatch(result.stderr, /found no contract code at the address yet/);
  });

  it("warns once when every backend named ignores it, and not for an Etherscan-style one", async (t) => {
    const sourcify = [
      ...VERIFY.slice(0, -1),
      "sourcify",
      "--index-wait",
      "60",
      "--dry-run",
      "--json",
    ];
    const ignored = await run(t, sourcify);
    assert.equal(ignored.code, 0, ignored.stderr);
    const warnings = ignored.stderr.split("\n").filter((line) => line.includes("--index-wait"));
    assert.deepEqual(warnings, [
      "warning: --index-wait has no effect on sourcify: only etherscan-v2, routescan and etherscan-compatible send the submit again while the explorer finds no contract code.",
    ]);
    const used = await run(t, [...VERIFY, "--index-wait", "60", "--dry-run", "--json"], "new", ENV);
    assert.doesNotMatch(used.stderr, /--index-wait has no effect/);
  });

  it("stops within --timeout when it ends first", async (t) => {
    const result = notIndexed(
      await run(
        t,
        [...VERIFY, "--index-wait", "600", "--timeout", "45", "--json"],
        "not-indexed",
        ENV,
      ),
    );
    assert.ok(result.submits > 10, String(result.submits));
    assert.ok(result.elapsedMs <= 45_000, String(result.elapsedMs));
  });

  it("is accepted next to --input-json (R-AX-16)", async (t) => {
    const path = join(DIR, "verify-etherscan.json");
    writeFileSync(
      path,
      JSON.stringify({
        ...JSON.parse(readFileSync(join(PROJECT, "verify-input.json"), "utf8")),
        route: { backend: "etherscan-v2" },
      }),
    );
    const result = notIndexed(
      await run(
        t,
        ["verify", "--input-json", path, "--index-wait", "60", "--json"],
        "not-indexed",
        ENV,
      ),
    );
    assert.ok(result.submits > 10, String(result.submits));
  });

  it("refuses 0, a fraction and a word, with --input-json too, and status does not take it", async (t) => {
    const path = join(PROJECT, "verify-input.json");
    for (const value of ["0", "1.5", "x", "2147484"]) {
      for (const argv of [VERIFY, ["verify", "--input-json", path]]) {
        const { message } = refused(await run(t, [...argv, "--index-wait", value, "--json"]));
        assert.match(message, /--index-wait must be a whole number of seconds from 1 to 2147483/);
        assert.ok(!message.includes(` ${value} `));
      }
    }
    const status = refused(await run(t, ["status", "ev1:x", "--index-wait", "60", "--json"]));
    assert.match(status.message, /--index-wait/);
  });
});

describe("a bare command line prints the short help on stderr and exits 2 (R-AX-11, #225)", () => {
  for (const argv of [[], ["verify"], ["status"]]) {
    it(`explorer-verify ${argv.join(" ")}`.trimEnd(), async (t) => {
      const result = await run(t, argv);
      assert.equal(result.code, 2);
      assert.equal(result.stdout, "");
      assert.deepEqual(result.seen, []);
      assert.match(result.stderr, /^Usage:$/m);
      const examples = result.stderr
        .split("\n")
        .filter((line) => /^ {2}explorer-verify .*(0x|ev1:)/.test(line));
      assert.ok(examples.length >= 2, result.stderr);
      assert.match(result.stderr, /^Every option: explorer-verify (--help|help (verify|status))$/m);
    });
  }

  it("keeps the usage error for anything more, such as verify --json", async (t) => {
    const result = await run(t, ["verify", "--json"]);
    assert.equal(result.code, 2);
    assert.match(result.stdout, /verify needs the contract address/);
  });
});

describe("one stderr line per event at the default level (R-AX-14, #225)", () => {
  it("prints each fact once: the submit and the result", async (t) => {
    const result = await run(t, [
      "verify",
      ADDRESS,
      "--chain",
      "sepolia",
      ...FOUNDRY,
      "--backend",
      "sourcify",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const handle = /Handle: (\S+)/.exec(result.stderr)?.[1];
    assert.ok(handle !== undefined, result.stderr);
    assert.equal(
      result.stderr,
      [
        `Submitted to sourcify. Handle: ${handle}`,
        "Result from sourcify: verified, exact match.",
        "",
      ].join("\n"),
    );
  });

  it("keeps the core's lines at debug and in --log-format json", async (t) => {
    const verbose = await run(t, [
      "verify",
      ADDRESS,
      "-c",
      "sepolia",
      ...FOUNDRY,
      "--backend",
      "sourcify",
      "--verbose",
    ]);
    assert.match(verbose.stderr, /^debug: Sourcify accepted the submission/m);
    const json = await run(t, [
      "verify",
      ADDRESS,
      "-c",
      "sepolia",
      ...FOUNDRY,
      "--backend",
      "sourcify",
      "--log-format",
      "json",
    ]);
    const lines = json.stderr.split("\n").filter((line) => line.startsWith("{"));
    assert.equal(lines.filter((line) => line.includes('"level":"info"')).length, 4, json.stderr);
  });
});
