// The CLI contract harness (#7): every command in the command table, run on the built bin the way
// an agent runs it, with no terminal, stdin closed, stdout and stderr piped and a hang timeout,
// against the fake explorer loaded before the bin. One table row per command lists the outcome
// kinds it drives; the walk over `COMMANDS` fails for a command without a row, for an outcome kind
// of the R-AX-7 table that no row reaches, and for a secret-carrying option (`*-file`, `*-stdin`)
// that no run covers.
//
// The expected values are written here, from requirements.md, and never read from the code under
// test: the exit code of each kind, the exit codes, the variables and the links that help lists.
//
// Per command it checks: one envelope on stdout that validates against the shipped schema, with
// `ok` true exactly on exit 0 (R-AX-5); the R-AX-7 exit code of each kind (R-AX-7); no ANSI escape
// byte on a pipe (R-AX-6); no submit for `--dry-run` (R-AX-8); a dummy key or keyed RPC URL from
// each source never in the output, and no flag that takes a key (R-AX-9); help with examples,
// variables and exit codes (R-AX-11); and byte-identical stdout on a second run (R-AX-12).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, describe, it } from "node:test";

import { ERROR_EXIT_CODES } from "explorer-verify";

import { GLOBAL_OPTIONS, commandOptions } from "../../src/arguments.ts";
import { COMMANDS } from "../../src/commands.ts";
import { RPC_HOST } from "../helpers/fake-explorer.ts";
import type { Scenario } from "../helpers/fake-explorer.ts";
import { envelopeProblems, helpProblems, oneEnvelope } from "../helpers/schema.ts";
import { PROJECT, runBin } from "../helpers/spawn-bin.ts";
import type { BinOptions, BinResult } from "../helpers/spawn-bin.ts";

/**
 * A bin that runs longer than this is killed and its test fails as a hang (R-AX-6). The slowest
 * run waits one 3 s poll; on a loaded machine a run takes up to about 10 s.
 */
const HANG_MS = 25_000;
/** The most bins this file runs at once, so a loaded machine is not flooded. */
const MAX_BINS = 4;
/**
 * The Node 22 budget of one integration file (`scripts/node-test.ts`). Node 22 ends a file that
 * runs longer without naming the test, so even with every run hanging the file must end inside
 * it; a test then fails on its own run's hang, with the command line.
 */
const FILE_BUDGET_MS = 600_000;
/**
 * A test's time includes its wait for a slot, which on a loaded machine is most of the file's run.
 * So a test may run almost as long as the file, and a hang is caught by {@link HANG_MS} instead.
 */
const TIMEOUT = { timeout: FILE_BUDGET_MS - 40_000 };
// Dummy secrets: lower-case hex, so no generic redaction pattern catches them and only the CLI's
// knowledge of the secrets it read can remove them.
const KEY = "5f3a9c7e1b2d4f60a8e7c6b5d4e3f2a1";
const RPC_PATH_SECRET = "c4d2e8a91b7f3e05";
const RPC_QUERY_SECRET = "9e1f7a3c5b2d8e60";
const ESC = "\u001B";

const ADDRESS = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const FOUNDRY = [
  "--input",
  "out/build-info/greeter.json",
  "--input",
  "out/Greeter.sol/Greeter.json",
];
const VERIFY = ["verify", ADDRESS, "--chain", "11155111", ...FOUNDRY];
const ETHERSCAN = ["--backend", "etherscan-v2"];
const CREATION_TX = `0x${"ab".repeat(32)}`;
const SOURCIFY_HANDLE = `ev1:sourcify:11155111:${ADDRESS}:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718`;
const ETHERSCAN_HANDLE = `ev1:etherscan-v2:11155111:${ADDRESS}:cqmxkhtaudvs5yhbzgv5nryiczguab4g3ppjj6mb3gakhzxjcn`;

const DIR = mkdtempSync(join(tmpdir(), "explorer-verify-contract-"));
const KEY_FILE = join(DIR, "key.txt");
writeFileSync(KEY_FILE, `${KEY}\n`);
const RPC_FILE = join(DIR, "rpc.txt");
writeFileSync(RPC_FILE, `https://${RPC_HOST}/v3/${RPC_PATH_SECRET}?token=${RPC_QUERY_SECRET}\n`);
const STARTED = Date.now();
after(() => {
  rmSync(DIR, { recursive: true, force: true });
  // The wall time of the harness, for the pull request and for keeping it fast.
  process.stderr.write(`cli-contract: ${String(Date.now() - STARTED)} ms\n`);
});

// ---------------------------------------------------------------------------------------------
// The expected values, from requirements.md
// ---------------------------------------------------------------------------------------------

/** The R-AX-7 table: every outcome kind an agent acts on, and its exit code. */
const EXPECTED_EXIT = {
  verified: 0,
  "already-verified": 0,
  "dry-run": 0,
  failed: 1,
  "invalid-input": 2,
  "missing-api-key": 3,
  "not-confirmed": 4,
  "verification-inconclusive": 4,
  network: 5,
  "unknown-state": 6,
  "internal-error": 6,
  cancelled: 130,
} as const;
type Kind = keyof typeof EXPECTED_EXIT;
const KINDS = Object.keys(EXPECTED_EXIT).filter((kind) => Object.hasOwn(EXPECTED_EXIT, kind));

/** The kinds that are a result status; every other kind is an error code. */
const RESULT_KINDS: readonly string[] = ["verified", "already-verified", "dry-run", "failed"];

/** Every exit code of the CLI (R-AX-7), in help order. */
const EXIT_CODES = [0, 1, 2, 3, 4, 5, 6, 130];

/** The environment variables the help lists (R-AX-6, R-AX-9, R-AX-15), in help order. */
const VARIABLES = [
  "EXPLORER_VERIFY_LOG",
  "NO_COLOR",
  "TERM",
  "CI",
  "ETHERSCAN_API_KEY",
  "ROUTESCAN_API_KEY",
];
/** The key variables of R-AX-9. */
const KEY_VARIABLES = ["ETHERSCAN_API_KEY", "ROUTESCAN_API_KEY"];

/** The links the help ends with (R-AX-11). */
const DOCS_URL = "https://aelmanaa.github.io/explorer-verify/reference/cli";
const LLMS_URL = "https://aelmanaa.github.io/explorer-verify/llms.txt";

/**
 * The options that carry a secret but have no run here, and the tests that cover them. A
 * `--*-stdin` option needs a pipe that this harness does not give.
 */
const COVERED_ELSEWHERE: Readonly<Record<string, string>> = {
  "api-key-stdin": "keys.test.ts, blackbox-102-keys.test.ts",
  "rpc-url-stdin": "rpc-url.test.ts",
};

// ---------------------------------------------------------------------------------------------
// The table: one row per command
// ---------------------------------------------------------------------------------------------

/** One run of a command that ends with `kind`. `--json` is added. */
interface Case {
  readonly kind: Kind;
  readonly args: readonly string[];
  /** What the fake explorer holds. Default `verified`. */
  readonly scenario?: Scenario;
  readonly env?: Record<string, string>;
  /** Sends SIGINT once stderr matches it: the run is then cancelled. */
  readonly cancelAfter?: RegExp;
  /** Whether `error.handle` is set (`true`) or absent (`false`); unchecked when undefined. */
  readonly handle?: boolean;
  /** The expected `error.retryable`; unchecked when undefined. */
  readonly retryable?: boolean;
  /** Fields the result must hold, such as `lookup`. */
  readonly result?: Readonly<Record<string, string>>;
  /** Whether the run must send no request at all. */
  readonly noRequests?: boolean;
  /** Runs the case twice and compares stdout (R-AX-12). */
  readonly twice?: boolean;
}

/** A run that reads a secret from one source (R-AX-9). `--json` and debug JSON lines are added. */
interface SecretRun {
  /** The key variable or the option that gives the secret. */
  readonly source: string;
  readonly args: readonly string[];
  readonly env?: Record<string, string>;
  readonly scenario?: Scenario;
  /** The strings that must never reach stdout or stderr. */
  readonly secrets: readonly string[];
  /**
   * What proves the secret was used: `key`, a request that carried a key; `rpc`, a request to
   * the fake JSON-RPC endpoint; or a reason why nothing sends it.
   */
  readonly used: "key" | "rpc" | { readonly unsent: string };
}

/** The contract row of one command. */
interface Contract {
  /** The runs, one kind each. */
  readonly cases: readonly Case[];
  /** The secret runs; empty for a command that is not `routed`, which reads no key. */
  readonly secretRuns: readonly SecretRun[];
}

/** A run with `source` as the key variable, which sends the key. */
function variableRun(source: string, args: readonly string[]): SecretRun {
  return { source, args, env: { [source]: KEY }, secrets: [KEY], used: "key" };
}

/** The routing table lists no Routescan route (checked 2026-11-04), so the key is never sent. */
const NO_ROUTESCAN = {
  unsent:
    "the routing table lists no Routescan route, so the CLI reads the key and sends it nowhere",
};

const CONTRACTS: Readonly<Record<string, Contract>> = {
  verify: {
    cases: [
      { kind: "already-verified", args: VERIFY, twice: true },
      { kind: "verified", args: VERIFY, scenario: "new" },
      {
        kind: "dry-run",
        args: [...VERIFY, "--dry-run"],
        scenario: "new",
        result: { lookup: "none" },
        twice: true,
      },
      {
        // R-AX-8: no key for a backend that needs one, so the lookup is skipped.
        kind: "dry-run",
        args: [...VERIFY, "--dry-run", ...ETHERSCAN],
        scenario: "new",
        result: { lookup: "skipped" },
        noRequests: true,
      },
      { kind: "failed", args: VERIFY, scenario: "rejected", twice: true },
      {
        kind: "invalid-input",
        args: ["verify", ADDRESS, "--chain", "0", ...FOUNDRY],
        noRequests: true,
        twice: true,
      },
      { kind: "missing-api-key", args: [...VERIFY, ...ETHERSCAN], noRequests: true },
      {
        kind: "not-confirmed",
        args: [...VERIFY, "--timeout", "2"],
        scenario: "pending",
        handle: true,
        twice: true,
      },
      {
        kind: "verification-inconclusive",
        args: VERIFY,
        scenario: "inconclusive",
        handle: false,
      },
      { kind: "network", args: VERIFY, scenario: "offline", handle: false, twice: true },
      { kind: "unknown-state", args: VERIFY, scenario: "unclassified", handle: true },
      {
        kind: "cancelled",
        args: VERIFY,
        scenario: "pending",
        cancelAfter: /Handle:/,
        handle: true,
      },
    ],
    secretRuns: [
      variableRun("ETHERSCAN_API_KEY", [...VERIFY, "--dry-run"]),
      { ...variableRun("ROUTESCAN_API_KEY", [...VERIFY, "--dry-run"]), used: NO_ROUTESCAN },
      {
        source: "--api-key-file",
        args: [...VERIFY, "--dry-run", ...ETHERSCAN, "--api-key-file", KEY_FILE],
        secrets: [KEY],
        used: "key",
      },
      {
        // The Etherscan route derives the constructor arguments through the RPC URL, whose
        // endpoint answers an error that repeats the whole URL.
        source: "--rpc-url-file",
        args: [...VERIFY, "--creation-tx", CREATION_TX, "--rpc-url-file", RPC_FILE],
        env: { ETHERSCAN_API_KEY: KEY },
        scenario: "new",
        secrets: [RPC_PATH_SECRET, RPC_QUERY_SECRET, KEY],
        used: "rpc",
      },
    ],
  },
  status: {
    cases: [
      { kind: "verified", args: ["status", SOURCIFY_HANDLE], twice: true },
      {
        kind: "failed",
        args: ["status", SOURCIFY_HANDLE],
        scenario: "rejected",
        twice: true,
      },
      { kind: "invalid-input", args: ["status", "ev1:nope"], noRequests: true, twice: true },
      {
        kind: "missing-api-key",
        args: ["status", ETHERSCAN_HANDLE, ...ETHERSCAN],
        noRequests: true,
      },
      {
        kind: "not-confirmed",
        args: ["status", SOURCIFY_HANDLE, "--timeout", "2"],
        scenario: "pending",
        handle: true,
        twice: true,
      },
      {
        kind: "verification-inconclusive",
        args: ["status", SOURCIFY_HANDLE],
        scenario: "inconclusive",
        handle: false,
      },
      {
        kind: "unknown-state",
        args: ["status", SOURCIFY_HANDLE],
        scenario: "unclassified",
        handle: true,
      },
      {
        kind: "cancelled",
        args: ["status", SOURCIFY_HANDLE, "--verbose"],
        scenario: "pending",
        cancelAfter: /Poll 1 on sourcify/,
      },
    ],
    secretRuns: [
      variableRun("ETHERSCAN_API_KEY", ["status", ETHERSCAN_HANDLE]),
      { ...variableRun("ROUTESCAN_API_KEY", ["status", SOURCIFY_HANDLE]), used: NO_ROUTESCAN },
      {
        source: "--api-key-file",
        args: ["status", ETHERSCAN_HANDLE, ...ETHERSCAN, "--api-key-file", KEY_FILE],
        secrets: [KEY],
        used: "key",
      },
    ],
  },
  // A placeholder for tests that a later release removes; its row goes with it. It sends nothing,
  // so its keys are read and never sent.
  simulate: {
    cases: [
      { kind: "verified", args: ["simulate", "--polls", "1"], twice: true },
      { kind: "already-verified", args: ["simulate", "--outcome", "already-verified"] },
      { kind: "failed", args: ["simulate", "--outcome", "failed"], twice: true },
      { kind: "invalid-input", args: ["simulate", "--outcome", "nope"], twice: true },
      { kind: "missing-api-key", args: ["simulate", "--outcome", "missing-api-key"] },
      {
        kind: "not-confirmed",
        args: ["simulate", "--outcome", "not-confirmed"],
        handle: true,
        twice: true,
      },
      {
        kind: "network",
        args: ["simulate", "--outcome", "network", "--retries", "1"],
        handle: false,
        twice: true,
      },
      { kind: "unknown-state", args: ["simulate", "--outcome", "unknown-state"], handle: true },
      {
        kind: "internal-error",
        args: ["simulate", "--outcome", "internal-error"],
        handle: false,
        retryable: false,
      },
      {
        kind: "cancelled",
        args: ["simulate", "--outcome", "pending"],
        cancelAfter: /Handle:/,
        handle: true,
      },
    ],
    secretRuns: [
      {
        ...variableRun("ETHERSCAN_API_KEY", ["simulate"]),
        used: { unsent: "simulate sends nothing" },
      },
      {
        ...variableRun("ROUTESCAN_API_KEY", ["simulate"]),
        used: { unsent: "simulate sends nothing" },
      },
      {
        source: "--api-key-file",
        args: ["simulate", ...ETHERSCAN, "--api-key-file", KEY_FILE],
        secrets: [KEY],
        used: { unsent: "simulate sends nothing" },
      },
    ],
  },
};

/** The row of a command, or a failure naming the command that has none. */
function contractOf(name: string): Contract {
  const contract = Object.hasOwn(CONTRACTS, name) ? CONTRACTS[name] : undefined;
  assert.ok(contract !== undefined, `the command ${name} has no row in the contract table`);
  return contract;
}

/** The runs per command besides its cases and secret runs: colour (3), key flags (2), help (2). */
const OTHER_RUNS = 7;

/** How many bins the table runs. */
function plannedRuns(): number {
  return Object.values(CONTRACTS).reduce(
    (sum, { cases, secretRuns }) =>
      sum +
      cases.reduce((count, { twice }) => count + (twice === true ? 2 : 1), 0) +
      secretRuns.length +
      OTHER_RUNS,
    0,
  );
}

// ---------------------------------------------------------------------------------------------
// Running the bin
// ---------------------------------------------------------------------------------------------

let running = 0;
const waiting: (() => void)[] = [];

/** Runs `task` once fewer than {@link MAX_BINS} bins run. */
async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (running >= MAX_BINS) {
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
    });
  }
  running += 1;
  try {
    return await task();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

let runs = 0;

/** One run: the bin's result and the requests the fake explorer got. */
interface Run extends BinResult {
  /** The requests, in order. */
  readonly requests: readonly Record<string, unknown>[];
}

/** Runs the bin in the Foundry project against the fake explorer, with a hang timeout. */
async function run(
  args: readonly string[],
  options: { scenario?: Scenario; env?: Record<string, string>; cancelAfter?: RegExp } = {},
): Promise<Run> {
  runs += 1;
  const log = join(DIR, `requests-${String(runs)}.jsonl`);
  const { cancelAfter } = options;
  let sent = false;
  const binOptions: BinOptions = {
    cwd: PROJECT,
    fake: { scenario: options.scenario ?? "verified", log },
    timeoutMs: HANG_MS,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(cancelAfter === undefined
      ? {}
      : {
          onStderr: (text, child) => {
            if (!sent && cancelAfter.test(text)) {
              sent = true;
              child.kill("SIGINT");
            }
          },
        }),
  };
  const result = await limited(async () => await runBin(args, binOptions));
  assert.equal(result.timedOut, false, `hung: ${args.join(" ")} (R-AX-6)`);
  const requests = existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line): Record<string, unknown> => fieldsOf(JSON.parse(line)))
    : [];
  return { ...result, requests };
}

/** The fields of an object in the envelope, or an empty record. */
function fieldsOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

/** The envelope on stdout, checked against the shipped schema and the exit code (R-AX-5). */
function envelopeOf(result: Run, label: string): Record<string, unknown> {
  const envelope = oneEnvelope(result.stdout);
  assert.deepEqual(envelopeProblems(envelope), [], `${label}: the envelope breaks the schema`);
  assert.equal(envelope["ok"], result.code === 0, `${label}: ok must be true exactly on exit 0`);
  return envelope;
}

/** Fails when either stream holds an ANSI escape byte (R-AX-6). */
function assertPlain(result: Run, label: string): void {
  assert.ok(!result.stdout.includes(ESC), `${label}: an escape byte on stdout`);
  assert.ok(!result.stderr.includes(ESC), `${label}: an escape byte on stderr`);
}

/** A case's command line, for test names. */
function nameOf(args: readonly string[]): string {
  return args
    .join(" ")
    .replace(ADDRESS, "<address>")
    .replace(KEY_FILE, "<key file>")
    .replace(RPC_FILE, "<rpc file>")
    .slice(0, 70);
}

// ---------------------------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------------------------

describe("CLI contract: the table covers every command and every kind", () => {
  it("has one row per command of the command table, hidden ones included", () => {
    assert.deepEqual(
      Object.keys(CONTRACTS).toSorted(),
      COMMANDS.map((command) => command.name).toSorted(),
    );
  });

  it("drives every kind of the R-AX-7 table with at least one command", () => {
    const covered = new Set<string>(
      Object.values(CONTRACTS).flatMap(({ cases }) => cases.map(({ kind }) => kind)),
    );
    assert.deepEqual(
      KINDS.filter((kind) => !covered.has(kind)),
      [],
    );
  });

  it("agrees with the catalogue's exit code for every error kind (R-AX-7)", () => {
    const catalogue = new Map<string, number>(Object.entries(ERROR_EXIT_CODES));
    for (const [kind, code] of Object.entries(EXPECTED_EXIT)) {
      assert.ok(EXIT_CODES.includes(code), kind);
      if (!RESULT_KINDS.includes(kind)) {
        assert.equal(catalogue.get(kind), code, kind);
      }
    }
  });

  it("ends inside the Node 22 file budget and each test's timeout even when every run hangs", () => {
    assert.ok(
      (plannedRuns() * HANG_MS) / MAX_BINS < TIMEOUT.timeout,
      `${String(plannedRuns())} runs`,
    );
  });

  for (const command of COMMANDS) {
    it(`${command.name}: a success, a usage error, a repeat and its secret options`, () => {
      const contract = contractOf(command.name);
      const kinds = contract.cases.map(({ kind }) => kind);
      assert.ok(
        kinds.some((kind) => EXPECTED_EXIT[kind] === 0),
        "no case that exits 0",
      );
      assert.ok(kinds.includes("invalid-input"), "no usage error");
      assert.ok(
        contract.cases.some(({ twice }) => twice === true),
        "no case run twice (R-AX-12)",
      );
      if ("dry-run" in command.options) {
        assert.ok(kinds.includes("dry-run"), "has --dry-run, but no dry-run case (R-AX-8)");
      }
      // R-AX-9: a routed command reads the key variables, and every option that reads a file or
      // stdin may carry a secret. Each needs a run here, or a named test elsewhere.
      const sources = new Set(contract.secretRuns.map(({ source }) => source));
      const needed = [
        ...(command.routed === true ? KEY_VARIABLES : []),
        ...Object.keys(commandOptions(command))
          .filter((name) => /-(file|stdin)$/.test(name) && !Object.hasOwn(COVERED_ELSEWHERE, name))
          .map((name) => `--${name}`),
      ];
      assert.deepEqual(
        needed.filter((source) => !sources.has(source)),
        [],
        "a secret source without a run",
      );
    });
  }

  it("has no option that takes a key value: the only key option takes a path (R-AX-9)", () => {
    for (const command of COMMANDS) {
      const options = { ...GLOBAL_OPTIONS, ...commandOptions(command) };
      const keyed = Object.entries(options)
        .filter(([name, spec]) => /key/i.test(name) && spec.type === "string")
        .map(([name]) => name);
      assert.deepEqual(keyed, command.routed === true ? ["api-key-file"] : [], command.name);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Each command
// ---------------------------------------------------------------------------------------------

describe("CLI contract: each command on the built bin", { concurrency: true }, () => {
  for (const command of COMMANDS) {
    const contract = Object.hasOwn(CONTRACTS, command.name) ? CONTRACTS[command.name] : undefined;
    const cases = contract?.cases ?? [];
    const first = cases[0];

    describe(
      `${command.name}: one envelope and the exit code of each kind (R-AX-5, R-AX-7)`,
      { concurrency: true },
      () => {
        for (const test of cases) {
          it(`${test.kind}: ${nameOf(test.args)}`, TIMEOUT, async () => {
            const label = `${command.name} ${test.kind}`;
            const result = await run([...test.args, "--json"], test);
            assert.equal(result.code, EXPECTED_EXIT[test.kind], `${label}\n${result.stderr}`);
            const envelope = envelopeOf(result, label);
            assertPlain(result, label);
            const error = fieldsOf(envelope["error"]);
            const outcome = fieldsOf(envelope["result"]);
            if (RESULT_KINDS.includes(test.kind)) {
              assert.equal(outcome["status"], test.kind, label);
            } else {
              assert.equal(error["code"], test.kind, label);
              // stderr holds the rest: the error line names the code (R-AX-6).
              assert.ok(result.stderr.includes(test.kind), `${label}: stderr does not name it`);
            }
            if (test.handle !== undefined) {
              assert.equal(typeof error["handle"] === "string", test.handle, `${label}: handle`);
            }
            if (test.retryable !== undefined) {
              assert.equal(error["retryable"], test.retryable, `${label}: retryable`);
            }
            for (const [name, value] of Object.entries(test.result ?? {})) {
              assert.equal(outcome[name], value, `${label}: result.${name}`);
            }
            if (test.noRequests === true) {
              assert.deepEqual(result.requests, [], `${label}: sent a request`);
            }
            const submits = result.requests.filter(({ submit }) => submit === true);
            if (test.kind === "dry-run" || EXPECTED_EXIT[test.kind] === 2) {
              // R-AX-7, R-AX-8: a dry run or a usage error submits nothing.
              assert.deepEqual(submits, [], `${label}: submitted`);
            }
            if (test.twice === true) {
              const second = await run([...test.args, "--json"], test);
              assert.equal(second.stdout, result.stdout, `${label}: stdout changed (R-AX-12)`);
            }
          });
        }
      },
    );

    describe(`${command.name}: streams and colour (R-AX-6)`, { concurrency: true }, () => {
      // Only stdin can be a pseudo-terminal in these runs; NO_COLOR and TERM on a terminal stream
      // are covered by the unit tests in terminal.test.ts.
      it(
        "without --json on a pipe: no escape byte, with NO_COLOR or with FORCE_COLOR",
        TIMEOUT,
        async () => {
          assert.ok(first !== undefined, `${command.name} has no case`);
          for (const env of [{ NO_COLOR: "1" }, { FORCE_COLOR: "1", TERM: "xterm-256color" }]) {
            const result = await run(first.args, { ...first, env });
            assert.equal(result.code, EXPECTED_EXIT[first.kind], JSON.stringify(env));
            assertPlain(result, JSON.stringify(env));
            assert.notEqual(result.stdout, "", "no summary on stdout");
            assert.ok(!result.stdout.startsWith("{"), "a JSON envelope without --json");
          }
        },
      );

      it("--color=always colours the summary, so the check above can fail", TIMEOUT, async () => {
        assert.ok(first !== undefined, `${command.name} has no case`);
        const result = await run([...first.args, "--color=always"], first);
        assert.ok(result.stdout.includes(`${ESC}[`), result.stdout);
      });
    });

    describe(`${command.name}: secrets (R-AX-9)`, { concurrency: true }, () => {
      for (const secretRun of contract?.secretRuns ?? []) {
        const { source, used } = secretRun;
        it(`a secret from ${source} never reaches stdout or stderr`, TIMEOUT, async () => {
          const result = await run(
            [...secretRun.args, "--json", "--verbose", "--log-format", "json"],
            { scenario: secretRun.scenario ?? "verified", env: secretRun.env ?? {} },
          );
          envelopeOf(result, source);
          for (const secret of secretRun.secrets) {
            assert.ok(!result.stdout.includes(secret), `${source}: a secret on stdout`);
            assert.ok(!result.stderr.includes(secret), `${source}: a secret on stderr`);
          }
          // The secret was used, so its absence from the output means something.
          if (used === "key" || used === "rpc") {
            assert.ok(
              result.requests.some(({ keyed }) => keyed === true),
              `${source}: no request carried the key`,
            );
          }
          if (used === "rpc") {
            assert.ok(
              result.requests.some(({ host }) => host === RPC_HOST),
              `${source}: no request reached the RPC endpoint`,
            );
          }
        });
      }

      it("refuses a key given as a flag value, and never echoes it", TIMEOUT, async () => {
        assert.ok(first !== undefined, `${command.name} has no case`);
        for (const flag of [["--api-key", KEY], [`--apikey=${KEY}`]]) {
          const result = await run([...first.args, ...flag, "--json"], first);
          assert.equal(result.code, 2, flag.join(" "));
          const envelope = envelopeOf(result, flag.join(" "));
          assert.equal(fieldsOf(envelope["error"])["code"], "invalid-input");
          assert.ok(!(result.stdout + result.stderr).includes(KEY), "the key was echoed");
          assert.deepEqual(result.requests, [], "a request was sent");
        }
      });
    });

    describe(`${command.name}: help (R-AX-11)`, { concurrency: true }, () => {
      const declared = command.examples.map(({ args }) => `explorer-verify ${args}`);

      it("--help --json: its examples, every variable and every exit code", TIMEOUT, async () => {
        const result = await run([command.name, "--help", "--json"]);
        assert.equal(result.code, 0);
        assert.equal(result.stderr, "");
        const envelope = oneEnvelope(result.stdout);
        assert.deepEqual(helpProblems(envelope), []);
        const help = fieldsOf(envelope["result"]);
        assert.equal(help["topic"], command.name);
        const examples = help["examples"];
        assert.ok(Array.isArray(examples), "no examples");
        assert.deepEqual(
          examples.map((example) => fieldsOf(example)["command"]),
          declared,
        );
        const environment = help["environment"];
        assert.ok(Array.isArray(environment), "no environment");
        assert.deepEqual(
          environment.map((variable) => fieldsOf(variable)["name"]),
          VARIABLES,
        );
        const exitCodes = help["exitCodes"];
        assert.ok(Array.isArray(exitCodes), "no exit codes");
        assert.deepEqual(
          exitCodes.map((code) => fieldsOf(code)["code"]),
          EXIT_CODES,
        );
        assert.equal(help["docsUrl"], DOCS_URL);
        assert.equal(help["llmsUrl"], LLMS_URL);
      });

      it("--help: examples first, then the variables, exit codes and links", TIMEOUT, async () => {
        const result = await run([command.name, "--help"]);
        assert.equal(result.code, 0);
        assert.equal(result.stderr, "");
        const text = result.stdout;
        const start = text.indexOf("\nExamples:\n");
        const usage = text.indexOf("\nUsage:\n");
        assert.ok(start !== -1 && start < usage, "examples not first");
        const section = text.slice(start, usage);
        assert.equal(
          section.split("\n").filter((line) => line.startsWith("  explorer-verify ")).length,
          declared.length,
          "examples",
        );
        for (const example of declared) {
          assert.ok(section.includes(`\n  ${example}\n`), example);
        }
        for (const name of VARIABLES) {
          assert.match(text, new RegExp(`\\n  ${name} `), name);
        }
        for (const code of EXIT_CODES) {
          assert.match(text, new RegExp(`\\n  ${String(code)} `), String(code));
        }
        assert.ok(text.includes(DOCS_URL) && text.includes(LLMS_URL), "no docs links");
      });
    });
  }
});

/** The outcomes of a run on several backends, after the envelope and stream checks. */
function outcomesOf(result: Run, label: string): Record<string, unknown>[] {
  const envelope = envelopeOf(result, label);
  assertPlain(result, label);
  const list: unknown = fieldsOf(envelope["result"])["outcomes"];
  assert.ok(Array.isArray(list), `${label}: no result.outcomes`);
  const items: readonly unknown[] = list;
  return items.map((item) => fieldsOf(item));
}

describe("CLI contract: verify with --backend repeated (R-RT-4, R-AX-5, R-AX-7)", () => {
  const BOTH = ["--backend", "sourcify", "--backend", "etherscan-v2"];

  it(
    "one outcome per backend; Etherscan with no key exits 3 and is sent nothing",
    TIMEOUT,
    async () => {
      const result = await run([...VERIFY, ...BOTH, "--json"]);
      assert.equal(result.code, 3, result.stderr);
      const outcomes = outcomesOf(result, "verify, two backends");
      assert.deepEqual(
        outcomes.map((outcome) => [outcome["backend"], outcome["ok"]]),
        [
          ["sourcify", true],
          ["etherscan-v2", false],
        ],
      );
      assert.equal(fieldsOf(outcomes[1]?.["error"])["code"], "missing-api-key");
    },
  );

  it("every backend verified, with the key from its variable: exit 0", TIMEOUT, async () => {
    const result = await run([...VERIFY, ...BOTH, "--json"], { env: { ETHERSCAN_API_KEY: KEY } });
    assert.equal(result.code, 0, result.stderr);
    const outcomes = outcomesOf(result, "verify, two backends, key");
    assert.ok(outcomes.every((outcome) => outcome["ok"] === true));
    assert.ok(!`${result.stdout}${result.stderr}`.includes(KEY), "the key was printed");
  });

  it(
    "a pending backend (4) wins over an unlisted one (2): resumable work first",
    TIMEOUT,
    async () => {
      const result = await run(
        [...VERIFY, "--backend", "sourcify", "--backend", "blockscout", "--timeout", "2", "--json"],
        { scenario: "pending" },
      );
      assert.equal(result.code, 4, result.stderr);
      const outcomes = outcomesOf(result, "verify, pending and unlisted");
      assert.equal(fieldsOf(outcomes[0]?.["error"])["code"], "not-confirmed");
      assert.equal(fieldsOf(outcomes[1]?.["error"])["code"], "unsupported-chain");
    },
  );

  it("status keeps one --backend: a second exits 2 and sends nothing", TIMEOUT, async () => {
    const result = await run([
      "status",
      SOURCIFY_HANDLE,
      "--backend",
      "sourcify",
      "--backend",
      "sourcify",
      "--json",
    ]);
    assert.equal(result.code, 2, result.stderr);
    envelopeOf(result, "status, two backends");
    assert.deepEqual(result.requests, []);
  });
});
