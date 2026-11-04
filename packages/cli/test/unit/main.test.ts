// The main loop in-process: every exit path gives one envelope and its exit code (R-AX-5, R-AX-7),
// signals give `cancelled` (exit 130), and anything unexpected gives `internal-error` (R-SEC-1).
// The integration tests run the same contract on the built bin.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import { ExplorerVerifyError, formatHandle } from "explorer-verify";
import type { VerifyResult } from "explorer-verify";

import type { Command } from "../../src/command.ts";
import { main } from "../../src/main.ts";
import { POLL_MS } from "../../src/simulate.ts";
import { fakeIo, jsonLines } from "../helpers/fake-io.ts";
import type { FakeIoOptions } from "../helpers/fake-io.ts";
import { envelopeProblems, oneEnvelope } from "../helpers/schema.ts";

const DUMMY_KEY = "ABCDEFGHIJKLMNOPQRSTUVWXYZ12345678";
const HANDLE = formatHandle({
  version: 1,
  backend: "sourcify",
  chainId: 11155111,
  address: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  jobId: "00000000-0000-4000-8000-000000000000",
});

async function run(argv: readonly string[], options: FakeIoOptions = {}) {
  const fake = fakeIo(argv, options);
  const code = await main(fake.io);
  return { code, stdout: fake.stdout(), stderr: fake.stderr() };
}

/** Lets pending promise callbacks run; setImmediate is not mocked. */
async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Runs `simulate` with mock timers, ticking one poll at a time until it ends. */
async function runWithPolls(t: TestContext, argv: readonly string[]) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeIo(argv);
  const state: { code?: number } = {};
  const done = main(fake.io).then((value) => {
    state.code = value;
    return value;
  });
  for (let step = 0; step < 20 && state.code === undefined; step++) {
    await settle();
    t.mock.timers.tick(POLL_MS);
  }
  const code = await done;
  return { code, stdout: fake.stdout(), stderr: fake.stderr() };
}

/** A command table with one command that runs `body`. */
function table(body: Command["run"], name = "custom"): Command[] {
  return [
    {
      name,
      summary: "A test command.",
      usage: "",
      examples: [{ args: name, description: "Run it." }],
      options: {},
      maxPositionals: 0,
      run: body,
    },
  ];
}

describe("main: one envelope per exit code (R-AX-5, R-AX-7)", () => {
  const cases: readonly { argv: string[]; code: number; ok: boolean; field: string }[] = [
    { argv: [], code: 0, ok: true, field: "result" },
    { argv: ["--outcome", "already-verified"], code: 0, ok: true, field: "result" },
    { argv: ["--outcome", "failed"], code: 1, ok: false, field: "result" },
    { argv: ["--outcome", "missing-api-key"], code: 3, ok: false, field: "error" },
    { argv: ["--outcome", "not-confirmed"], code: 4, ok: false, field: "error" },
    { argv: ["--outcome", "network"], code: 5, ok: false, field: "error" },
    { argv: ["--outcome", "unknown-state"], code: 6, ok: false, field: "error" },
    { argv: ["--outcome", "internal-error"], code: 6, ok: false, field: "error" },
    { argv: ["--outcome", "nope"], code: 2, ok: false, field: "error" },
  ];
  for (const { argv, code, ok, field } of cases) {
    it(`exits ${String(code)} for simulate ${argv.join(" ") || "(verified)"}`, async () => {
      const result = await run(["simulate", "--json", ...argv]);
      assert.equal(result.code, code);
      const envelope = oneEnvelope(result.stdout);
      assert.deepEqual(envelopeProblems(envelope), []);
      assert.equal(envelope["ok"], ok);
      assert.equal(envelope["ok"], result.code === 0);
      assert.ok(field in envelope);
    });
  }

  it("prints an invalid-input envelope for a usage error, with exit code 2", async () => {
    const result = await run(["--json", "--color=pink", "--nope", "simulate", "extra"]);
    assert.equal(result.code, 2);
    const envelope = oneEnvelope(result.stdout);
    assert.deepEqual(envelopeProblems(envelope), []);
    const error = envelope["error"];
    assert.ok(typeof error === "object" && error !== null);
    assert.equal(Reflect.get(error, "code"), "invalid-input");
    assert.equal(
      Reflect.get(error, "message"),
      "The command line is invalid: argument 3 is not an option; --color must be one of auto, always, never; simulate takes no arguments.",
    );
    assert.equal(
      Reflect.get(error, "hint"),
      "Fix the arguments the message names, then run the command again. explorer-verify --help lists the commands and options.",
    );
  });

  it("refuses --quiet with --verbose with exit code 2 (R-AX-15)", async () => {
    const result = await run(["simulate", "--json", "-q", "--verbose"]);
    assert.equal(result.code, 2);
    assert.match(result.stdout, /--quiet cannot be combined with --verbose/);
  });

  it("refuses a missing command and a bad --log-format", async () => {
    const result = await run(["--json", "--log-format", "xml"]);
    assert.equal(result.code, 2);
    assert.match(
      result.stdout,
      /command is missing; this version has no public commands yet; see the CLI reference; --log-format must be one of text, json/,
    );
  });

  it("counts the polls before the outcome", async (t) => {
    const result = await runWithPolls(t, ["simulate", "--json", "--polls", "3", "--verbose"]);
    assert.equal(result.code, 0);
    assert.equal((result.stderr.match(/debug: Poll \d on sourcify: pending\./g) ?? []).length, 3);
  });

  it("refuses --polls and --retries outside 0 to 1000", async () => {
    for (const value of ["-1", "1001", "1.5", "x", "99999"]) {
      const result = await run(["simulate", "--json", `--polls=${value}`, "--retries", "2000"]);
      assert.equal(result.code, 2, value);
      assert.match(
        result.stdout,
        /--polls must be a whole number from 0 to 1000; --retries must be a whole number/,
      );
    }
  });
});

describe("main: stdout (R-AX-6, R-AX-12)", () => {
  it("prints a short summary without --json, and the error only on stderr", async () => {
    const verified = await run(["simulate"]);
    assert.equal(
      verified.stdout,
      "verified: exact match on sourcify\nhttps://repo.sourcify.dev/11155111/0x5fbdb2315678afecb367f032d93f642f64180aa3\n",
    );
    const failed = await run(["simulate", "--outcome", "network"]);
    assert.equal(failed.code, 5);
    assert.equal(failed.stdout, "");
    assert.match(
      failed.stderr,
      /^error: The simulated explorer could not be reached\. \(network\)$/m,
    );
  });

  it("gives byte-identical stdout for the same input", async () => {
    for (const argv of [["simulate", "--json"], ["simulate"], ["simulate", "--json", "--bad"]]) {
      const first = await run(argv);
      const second = await run(argv);
      assert.equal(first.stdout, second.stdout, argv.join(" "));
    }
  });

  it("gives the same stdout at every log level (R-AX-15)", async () => {
    const base = await run(["simulate", "--json", "--outcome", "not-confirmed"]);
    for (const extra of [["-q"], ["--verbose"], ["--log-format", "json"]]) {
      const other = await run(["simulate", "--json", "--outcome", "not-confirmed", ...extra]);
      assert.equal(other.stdout, base.stdout, extra.join(" "));
    }
    for (const level of ["debug", "warn", "error", "off"]) {
      const other = await run(["simulate", "--json", "--outcome", "not-confirmed"], {
        env: { EXPLORER_VERIFY_LOG: level },
      });
      assert.equal(other.stdout, base.stdout, level);
    }
  });

  it("colours stdout and stderr per stream (R-AX-6)", async () => {
    const terminal = await run(["simulate", "--retries", "1"], {
      stdoutIsTerminal: true,
      stderrIsTerminal: false,
    });
    assert.ok(terminal.stdout.includes("\u001B[32mverified"));
    assert.ok(!terminal.stderr.includes("\u001B"));
    const forced = await run(["simulate", "--retries", "1", "--color=always"], {
      env: { NO_COLOR: "1" },
    });
    assert.ok(forced.stdout.includes("\u001B[32mverified"));
    assert.ok(forced.stderr.includes("\u001B[33mwarning:"));
  });
});

describe("main: stderr (R-AX-14, R-AX-15)", () => {
  it("writes JSON lines that parse, with the reserved names nested", async () => {
    const result = await run(["simulate", "--verbose", "--log-format", "json"]);
    const lines = jsonLines(result.stderr);
    assert.equal(lines.length, result.stderr.split("\n").length - 1);
    for (const line of lines) {
      assert.deepEqual(Object.keys(line).slice(0, 4), [
        "schemaVersion",
        "level",
        "message",
        "type",
      ]);
    }
    const [first] = lines;
    assert.deepEqual(first?.["fields"], { type: "simulate", fields: "simulate" });
  });

  it("warns once about an invalid EXPLORER_VERIFY_LOG, naming the variable and never the value", async () => {
    const value = "LOUD-VALUE-123";
    const result = await run(["simulate"], { env: { EXPLORER_VERIFY_LOG: value } });
    assert.equal(
      result.stderr.split("\n")[0],
      "warning: EXPLORER_VERIFY_LOG is not one of debug, info, warn, error, off, so it is ignored.",
    );
    assert.ok(!result.stderr.includes(value));
    const verbose = await run(["simulate", "--verbose"], { env: { EXPLORER_VERIFY_LOG: value } });
    assert.match(verbose.stderr, /^warning: EXPLORER_VERIFY_LOG/);
    const quiet = await run(["simulate", "-q"], { env: { EXPLORER_VERIFY_LOG: value } });
    assert.equal(quiet.stderr, "");
  });

  it("logs the redacted stack of an unexpected error at debug", async () => {
    const result = await run([
      "simulate",
      "--verbose",
      "--outcome",
      "internal-error",
      "--message",
      `leak ${DUMMY_KEY}`,
    ]);
    assert.match(result.stderr, /debug: The stack of the unexpected error, redacted\. stack=/);
    assert.ok(!result.stderr.includes(DUMMY_KEY));
  });
});

describe("main: internal-error (R-AX-5, R-SEC-1)", () => {
  it("redacts a key from the message of an unexpected exception", async () => {
    const result = await run([
      "simulate",
      "--json",
      "--outcome",
      "internal-error",
      "--message",
      `failed with apikey=${DUMMY_KEY} and ${DUMMY_KEY}`,
    ]);
    assert.equal(result.code, 6);
    assert.ok(!result.stdout.includes(DUMMY_KEY));
    assert.ok(!result.stderr.includes(DUMMY_KEY));
    assert.deepEqual(oneEnvelope(result.stdout)["error"], {
      code: "internal-error",
      message: "An unexpected error occurred: Error: failed with apikey=[redacted] and [redacted]",
      hint: "This is a bug in explorer-verify. Report it with the command you ran, without your API key.",
      docsUrl: "https://aelmanaa.github.io/explorer-verify/reference/errors/internal-error",
      retryable: false,
    });
  });

  it("turns a thrown value that is not an Error, or a command that throws at once, into internal-error", async () => {
    const values: unknown[] = ["text", 42, null];
    for (const value of values) {
      const fake = fakeIo(["custom", "--json"]);
      const code = await main(
        fake.io,
        table(() => {
          throw value;
        }),
      );
      assert.equal(code, 6);
      assert.match(fake.stdout(), /"code":"internal-error"/);
    }
  });

  it("survives an exception whose message cannot be read", async () => {
    const fake = fakeIo(["custom", "--json"]);
    const hostile = new Error("x");
    Object.defineProperty(hostile, "message", {
      get: () => {
        throw new Error("no");
      },
    });
    const code = await main(
      fake.io,
      table(async () => await Promise.reject(hostile)),
    );
    assert.equal(code, 6);
    assert.match(
      fake.stdout(),
      /An unexpected error occurred: an exception whose message cannot be read/,
    );
  });

  it("gives internal-error when the CLI itself fails before the command runs", async () => {
    const broken: Command = {
      name: "broken",
      summary: "A command whose options cannot be read.",
      usage: "",
      examples: [{ args: "broken", description: "Run it." }],
      get options(): never {
        throw new Error(`table bug ${DUMMY_KEY}`);
      },
      maxPositionals: 0,
      run: async () => await Promise.reject(new Error("never")),
    };
    const fake = fakeIo(["broken", "--json"]);
    assert.equal(await main(fake.io, [broken]), 6);
    const envelope = oneEnvelope(fake.stdout());
    assert.deepEqual(envelopeProblems(envelope), []);
    assert.ok(!fake.stdout().includes(DUMMY_KEY));
    assert.match(
      fake.stderr(),
      /^error: An unexpected error occurred: Error: table bug \[redacted\]/,
    );
  });

  it("returns 6 without throwing when even stdout fails", async () => {
    const fake = fakeIo(["simulate", "--json"]);
    const io = {
      ...fake.io,
      stdout: {
        write: () => {
          throw new Error("EPIPE");
        },
      },
    };
    assert.equal(await main(io), 6);
  });

  it("keeps an ExplorerVerifyError a command throws", async () => {
    const fake = fakeIo(["custom", "--json"]);
    const code = await main(
      fake.io,
      table(
        async () =>
          await Promise.reject(
            new ExplorerVerifyError(
              { code: "timeout", backend: "sourcify", timeoutMs: 1 },
              "Slow.",
              {
                secrets: [],
              },
            ),
          ),
      ),
    );
    assert.equal(code, 5);
    assert.match(fake.stdout(), /"code":"timeout"/);
  });
});

/** A command that announces a submission with `handle`, then waits for the abort. */
function waiting(handle: string | undefined): Command[] {
  return table(async (context) => {
    if (handle !== undefined) {
      context.onEvent({ type: "verify.submitted", backend: "sourcify", handle });
    }
    return await new Promise<VerifyResult>((_resolve, reject) => {
      context.signal.addEventListener("abort", () => {
        reject(context.signal.reason);
      });
    });
  });
}

describe("main: signals (R-AX-7)", () => {
  it("exits 130 with a cancelled envelope that carries the handle of the submission", async () => {
    const fake = fakeIo(["custom", "--json"]);
    const done = main(fake.io, waiting(HANDLE));
    await settle();
    fake.signal("SIGINT");
    fake.signal("SIGTERM");
    assert.equal(await done, 130);
    const envelope = oneEnvelope(fake.stdout());
    assert.deepEqual(envelopeProblems(envelope), []);
    const error = envelope["error"];
    assert.ok(typeof error === "object" && error !== null);
    assert.equal(Reflect.get(error, "code"), "cancelled");
    assert.equal(Reflect.get(error, "message"), "The run was cancelled by SIGINT.");
    assert.equal(Reflect.get(error, "handle"), HANDLE);
    assert.equal(fake.listeners(), 0);
  });

  it("leaves the handle out when nothing was submitted, or the handle does not parse", async () => {
    for (const handle of [undefined, "not-a-handle"]) {
      const fake = fakeIo(["custom", "--json"]);
      const done = main(fake.io, waiting(handle));
      await settle();
      fake.signal("SIGTERM");
      assert.equal(await done, 130);
      const error = oneEnvelope(fake.stdout())["error"];
      assert.ok(typeof error === "object" && error !== null);
      assert.equal(Reflect.get(error, "message"), "The run was cancelled by SIGTERM.");
      assert.equal(Reflect.has(error, "handle"), false);
    }
  });

  it("ends at once on a signal even when the command ignores the abort", async () => {
    const fake = fakeIo(["custom", "--json"]);
    const done = main(
      fake.io,
      table(async () => await new Promise<VerifyResult>(() => undefined)),
    );
    await settle();
    fake.signal("SIGINT");
    assert.equal(await done, 130);
  });

  it("cancels simulate --outcome pending during a poll", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fake = fakeIo(["simulate", "--json", "--outcome", "pending"]);
    const done = main(fake.io);
    for (let step = 0; step < 3; step++) {
      await settle();
      t.mock.timers.tick(POLL_MS);
    }
    await settle();
    fake.signal("SIGINT");
    assert.equal(await done, 130);
    assert.match(fake.stderr(), /Submitted to sourcify\. Handle: /);
    assert.equal(Reflect.get(oneEnvelope(fake.stdout())["error"] ?? {}, "handle"), HANDLE);
  });
});
