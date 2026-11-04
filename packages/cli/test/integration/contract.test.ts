// The output contract on the built bin (R-QA-3): stdout piped, stdin closed, no terminal. Each test
// spawns `node dist/src/bin.js`; `pnpm test` builds first. The placeholder `simulate` command drives
// every exit path until the verify and status commands land.
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { describe, it } from "node:test";

import { jsonLines } from "../helpers/fake-io.ts";
import { envelopeProblems, oneEnvelope } from "../helpers/schema.ts";
import { runBin } from "../helpers/spawn-bin.ts";

const TIMEOUT = { timeout: 30_000 };
const DUMMY_KEY = "ABCDEFGHIJKLMNOPQRSTUVWXYZ12345678";
const HANDLE =
  "ev1:sourcify:11155111:0x5fbdb2315678afecb367f032d93f642f64180aa3:00000000-0000-4000-8000-000000000000";
const ESC = "\u001B";

/** Sends `signal` once, as soon as stderr shows the submission's handle. */
function signalAfterSubmit(signal: NodeJS.Signals) {
  let sent = false;
  return (text: string, child: ChildProcess): void => {
    if (!sent && text.includes("Handle:")) {
      sent = true;
      child.kill(signal);
    }
  };
}

describe("bin: one envelope on stdout for every exit code (R-AX-5, R-AX-7)", () => {
  const cases: readonly { name: string; args: string[]; code: number }[] = [
    { name: "verified", args: [], code: 0 },
    { name: "already-verified", args: ["--outcome", "already-verified"], code: 0 },
    { name: "failed", args: ["--outcome", "failed", "--polls", "1"], code: 1 },
    { name: "usage error", args: ["--outcome", "nope"], code: 2 },
    { name: "missing-api-key", args: ["--outcome", "missing-api-key"], code: 3 },
    { name: "not-confirmed", args: ["--outcome", "not-confirmed", "--polls", "2"], code: 4 },
    { name: "network", args: ["--outcome", "network", "--retries", "2"], code: 5 },
    { name: "unknown-state", args: ["--outcome", "unknown-state"], code: 6 },
    { name: "internal-error", args: ["--outcome", "internal-error"], code: 6 },
  ];
  for (const { name, args, code } of cases) {
    it(
      `exits ${String(code)} for ${name}, with a valid envelope whose ok matches`,
      TIMEOUT,
      async () => {
        const result = await runBin(["simulate", "--json", ...args]);
        assert.equal(result.code, code, result.stderr);
        const envelope = oneEnvelope(result.stdout);
        assert.deepEqual(envelopeProblems(envelope), []);
        assert.equal(envelope["ok"], code === 0);
      },
    );
  }

  it(
    "exits 2 with an invalid-input envelope when --json comes after a usage error",
    TIMEOUT,
    async () => {
      const result = await runBin(["--bogus", "--color", "pink", "--json"]);
      assert.equal(result.code, 2);
      const envelope = oneEnvelope(result.stdout);
      assert.deepEqual(envelopeProblems(envelope), []);
      assert.equal(Reflect.get(envelope["error"] ?? {}, "code"), "invalid-input");
    },
  );

  it("does not count --json after --", TIMEOUT, async () => {
    const result = await runBin(["simulate", "--", "--json"]);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^error: The command line is invalid/);
  });

  it("counts --json after an option that needs a value, and --json=true", TIMEOUT, async () => {
    for (const args of [
      ["simulate", "--color", "--json"],
      ["simulate", "--json=true"],
    ]) {
      const result = await runBin(args);
      assert.equal(result.code, 2, args.join(" "));
      const envelope = oneEnvelope(result.stdout);
      assert.deepEqual(envelopeProblems(envelope), []);
      assert.equal(Reflect.get(envelope["error"] ?? {}, "code"), "invalid-input");
    }
  });

  it("finishes with one envelope when more signals arrive during shutdown", TIMEOUT, async () => {
    let sent = false;
    const result = await runBin(["simulate", "--json", "--outcome", "pending"], {
      onStderr: (text, child) => {
        if (!sent && text.includes("Handle:")) {
          sent = true;
          child.kill("SIGINT");
          // These arrive while the CLI writes the envelope and drains its streams.
          child.kill("SIGTERM");
          child.kill("SIGINT");
        } else if (sent && child.exitCode === null) {
          child.kill("SIGINT");
        }
      },
    });
    assert.equal(result.signal, null);
    assert.equal(result.code, 130);
    const envelope = oneEnvelope(result.stdout);
    // The signals are pending together, and the OS may deliver either one first.
    assert.match(
      String(Reflect.get(envelope["error"] ?? {}, "message")),
      /^The run was cancelled by SIG(INT|TERM)\.$/,
    );
    assert.equal(result.stdout.split("\n").length, 2);
  });

  it("exits 2 for --quiet with --verbose (R-AX-15)", TIMEOUT, async () => {
    const result = await runBin(["simulate", "--json", "--quiet", "--verbose"]);
    assert.equal(result.code, 2);
    assert.match(result.stdout, /--quiet cannot be combined with --verbose/);
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it(
      `exits 130 with a cancelled envelope and the handle on ${signal} during a poll`,
      TIMEOUT,
      async () => {
        const result = await runBin(["simulate", "--json", "--outcome", "pending"], {
          onStderr: signalAfterSubmit(signal),
        });
        assert.equal(result.signal, null);
        assert.equal(result.code, 130);
        const envelope = oneEnvelope(result.stdout);
        assert.deepEqual(envelopeProblems(envelope), []);
        assert.equal(envelope["ok"], false);
        assert.deepEqual(envelope["error"], {
          code: "cancelled",
          message: `The run was cancelled by ${signal}.`,
          hint: "The run was cancelled. If error.handle is set, resume with explorer-verify status and that handle instead of submitting again.",
          docsUrl: "https://aelmanaa.github.io/explorer-verify/reference/errors/cancelled",
          retryable: false,
          handle: HANDLE,
        });
      },
    );
  }
});

describe("bin: streams and terminals (R-AX-6)", () => {
  it("writes no ANSI escape bytes when piped", TIMEOUT, async () => {
    const result = await runBin(["simulate", "--retries", "1", "--outcome", "network"]);
    assert.ok(!result.stdout.includes(ESC));
    assert.ok(!result.stderr.includes(ESC));
    assert.ok(result.stderr.includes("warning:"));
  });

  it(
    "removes colour with NO_COLOR=1 or --color=never, and --color=always wins over NO_COLOR",
    TIMEOUT,
    async () => {
      const noColor = await runBin(["simulate", "--retries", "1"], { env: { NO_COLOR: "1" } });
      assert.ok(!noColor.stdout.includes(ESC) && !noColor.stderr.includes(ESC));
      const never = await runBin(["simulate", "--retries", "1", "--color=never"]);
      assert.ok(!never.stdout.includes(ESC) && !never.stderr.includes(ESC));
      const always = await runBin(["simulate", "--retries", "1", "--color=always"], {
        env: { NO_COLOR: "1" },
      });
      assert.ok(always.stdout.includes(`${ESC}[32mverified`));
      assert.ok(always.stderr.includes(`${ESC}[33mwarning:`));
    },
  );

  it(
    "draws no spinner frames on stderr when it is not a terminal, with or without CI",
    TIMEOUT,
    async () => {
      for (const env of [{}, { CI: "true" }]) {
        const result = await runBin(["simulate", "--polls", "3"], { env });
        assert.ok(!result.stderr.includes("\r"), JSON.stringify(env));
      }
    },
  );

  it("never waits on stdin, whether it is closed, ended or open", TIMEOUT, async () => {
    for (const stdin of ["ignore", "ended", "open"] as const) {
      const result = await runBin(["simulate", "--json"], { stdin });
      assert.equal(result.code, 0, stdin);
    }
  });

  it("puts nothing but the summary on stdout without --json", TIMEOUT, async () => {
    const result = await runBin(["simulate", "--verbose"]);
    assert.equal(
      result.stdout,
      "verified: exact match on sourcify\nhttps://repo.sourcify.dev/11155111/0x5fbdb2315678afecb367f032d93f642f64180aa3\n",
    );
  });
});

describe("bin: same input, same stdout (R-AX-12)", () => {
  it("gives byte-identical stdout on two runs", TIMEOUT, async () => {
    for (const args of [
      ["simulate", "--json", "--polls", "1"],
      ["simulate", "--json", "--outcome", "not-confirmed"],
      ["simulate", "--outcome", "failed"],
    ]) {
      const first = await runBin(args);
      const second = await runBin(args);
      assert.equal(first.stdout, second.stdout, args.join(" "));
      assert.notEqual(first.stdout, "");
    }
  });
});

describe("bin: log levels and JSON lines (R-AX-14, R-AX-15)", () => {
  const ARGS = [
    "simulate",
    "--json",
    "--outcome",
    "not-confirmed",
    "--retries",
    "1",
    "--polls",
    "1",
  ];

  /** The `type/level` of each JSON line on stderr for one mode. */
  async function linesFor(extra: string[], env: Record<string, string> = {}) {
    const result = await runBin([...ARGS, "--log-format", "json", ...extra], { env });
    return {
      stdout: result.stdout,
      lines: jsonLines(result.stderr),
      kinds: jsonLines(result.stderr).map(
        (line) => `${String(line["type"])}/${String(line["level"])}`,
      ),
    };
  }

  it("matches the table at every level, with byte-identical stdout", TIMEOUT, async () => {
    const quiet = await linesFor(["--quiet"]);
    const normal = await linesFor([]);
    const verbose = await linesFor(["--verbose"]);
    const warn = await linesFor([], { EXPLORER_VERIFY_LOG: "warn" });
    const error = await linesFor([], { EXPLORER_VERIFY_LOG: "error" });
    const off = await linesFor([], { EXPLORER_VERIFY_LOG: "off" });
    assert.deepEqual(quiet.kinds, ["log/error"]);
    assert.deepEqual(error.kinds, ["log/error"]);
    assert.deepEqual(off.kinds, []);
    assert.deepEqual(warn.kinds, ["verify.retry/warn", "log/error"]);
    assert.deepEqual(normal.kinds, ["verify.retry/warn", "verify.submitted/info", "log/error"]);
    assert.deepEqual(verbose.kinds, [
      "log/debug",
      "verify.validated/debug",
      "verify.routed/debug",
      "verify.lookup/debug",
      "verify.retry/warn",
      "verify.submitted/info",
      "verify.poll/debug",
      "log/error",
    ]);
    for (const mode of [quiet, warn, error, off, verbose]) {
      assert.equal(mode.stdout, normal.stdout);
    }
  });

  it(
    "writes lines that parse and carry schemaVersion, level, message and type, with fields.fields",
    TIMEOUT,
    async () => {
      const { lines } = await linesFor(["--verbose"]);
      for (const line of lines) {
        assert.deepEqual(Object.keys(line).slice(0, 4), [
          "schemaVersion",
          "level",
          "message",
          "type",
        ]);
        assert.equal(line["schemaVersion"], 1);
        assert.equal(typeof line["message"], "string");
      }
      const debug = lines.find((line) => line["type"] === "log" && line["level"] === "debug");
      assert.deepEqual(debug?.["fields"], { type: "simulate", fields: "simulate" });
      const submitted = lines.find((line) => line["type"] === "verify.submitted");
      assert.equal(submitted?.["handle"], HANDLE);
    },
  );

  it(
    "warns about an invalid EXPLORER_VERIFY_LOG without its value, and keeps the default level",
    TIMEOUT,
    async () => {
      const value = "VERY-LOUD-PLEASE";
      const result = await runBin(["simulate", "--json"], { env: { EXPLORER_VERIFY_LOG: value } });
      assert.equal(result.code, 0);
      assert.ok(!result.stderr.includes(value));
      assert.match(result.stderr, /^warning: EXPLORER_VERIFY_LOG is not one of/);
      assert.match(result.stderr, /Submitted to sourcify/);
    },
  );
});

describe("bin: redaction (R-SEC-1)", () => {
  it("leaves a dummy key out of the internal-error envelope and stderr", TIMEOUT, async () => {
    const result = await runBin([
      "simulate",
      "--json",
      "--verbose",
      "--outcome",
      "internal-error",
      "--message",
      `request failed: https://api.example.org/?apikey=${DUMMY_KEY} key ${DUMMY_KEY}`,
    ]);
    assert.equal(result.code, 6);
    assert.ok(!result.stdout.includes(DUMMY_KEY));
    assert.ok(!result.stderr.includes(DUMMY_KEY));
    const envelope = oneEnvelope(result.stdout);
    assert.deepEqual(envelopeProblems(envelope), []);
    const error = envelope["error"] ?? {};
    assert.equal(Reflect.get(error, "code"), "internal-error");
    assert.equal(Reflect.get(error, "retryable"), false);
    assert.equal(Reflect.has(error, "handle"), false);
    assert.equal(
      Reflect.get(error, "hint"),
      "This is a bug in explorer-verify. Report it with the command you ran, without your API key.",
    );
  });
});
