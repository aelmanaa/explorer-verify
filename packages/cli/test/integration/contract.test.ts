// The output contract on the built bin (R-QA-3): stdout piped, stdin closed, no terminal. Each test
// spawns `node dist/src/bin.js` with the fake explorer loaded first, and runs `verify` or `status`;
// `pnpm test` builds first. cli-contract.test.ts runs every outcome kind and its exit code for each
// command; this file covers the process: signals, streams, stdin, log levels and redaction.
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { describe, it } from "node:test";

import { jsonLines } from "../helpers/fake-io.ts";
import { envelopeProblems, oneEnvelope } from "../helpers/schema.ts";
import { PROJECT, runBin } from "../helpers/spawn-bin.ts";
import type { BinOptions } from "../helpers/spawn-bin.ts";

const TIMEOUT = { timeout: 60_000 };
const DUMMY_KEY = "ABCDEFGHIJKLMNOPQRSTUVWXYZ12345678";
const ADDRESS = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const HANDLE = `ev1:sourcify:11155111:${ADDRESS}:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718`;
const VERIFY = [
  "verify",
  ADDRESS,
  "--chain",
  "11155111",
  "--input",
  "out/build-info/greeter.json",
  "--input",
  "out/Greeter.sol/Greeter.json",
  "--backend",
  "sourcify",
];
/** A status run that ends `verified` at once against the default scenario. */
const STATUS = ["status", HANDLE];
const ESC = "\u001B";

/** Runs the bin in the Foundry project against the fake explorer with `scenario`. */
async function run(args: readonly string[], scenario = "verified", options: BinOptions = {}) {
  return await runBin(args, { cwd: PROJECT, fake: { scenario }, ...options });
}

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

describe("bin: the command line and --json (R-AX-5)", () => {
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
    const result = await runBin(["status", HANDLE, "--", "--json"]);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^error: The command line is invalid/);
  });

  it("counts --json after an option that needs a value, and --json=true", TIMEOUT, async () => {
    for (const args of [
      ["status", HANDLE, "--color", "--json"],
      ["status", HANDLE, "--json=true"],
    ]) {
      const result = await runBin(args);
      assert.equal(result.code, 2, args.join(" "));
      const envelope = oneEnvelope(result.stdout);
      assert.deepEqual(envelopeProblems(envelope), []);
      assert.equal(Reflect.get(envelope["error"] ?? {}, "code"), "invalid-input");
    }
  });

  it("exits 2 for --quiet with --verbose (R-AX-15)", TIMEOUT, async () => {
    const result = await runBin([...STATUS, "--json", "--quiet", "--verbose"]);
    assert.equal(result.code, 2);
    assert.match(result.stdout, /--quiet cannot be combined with --verbose/);
  });
});

describe("bin: signals during a poll (R-AX-7)", { concurrency: true }, () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it(`exits 130 with a cancelled envelope and the handle on ${signal}`, TIMEOUT, async () => {
      const result = await run([...VERIFY, "--json"], "pending", {
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
        hint: `Resume the accepted submission with explorer-verify status ${HANDLE} instead of submitting again.`,
        docsUrl: "https://aelmanaa.github.io/explorer-verify/reference/errors/cancelled",
        retryable: false,
        handle: HANDLE,
        details: { code: "cancelled", handle: HANDLE },
      });
      // The next command resumes the job and never submits.
      assert.deepEqual(envelope["nextCommand"], ["explorer-verify", "status", HANDLE, "--json"]);
    });
  }

  it("finishes with one envelope when more signals arrive during shutdown", TIMEOUT, async () => {
    let sent = false;
    const result = await run([...VERIFY, "--json"], "pending", {
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
});

describe("bin: streams and terminals (R-AX-6)", { concurrency: true }, () => {
  // An invalid EXPLORER_VERIFY_LOG gives a warning on stderr, so both streams have something to
  // colour.
  const WARN = { EXPLORER_VERIFY_LOG: "bogus" };

  it("writes no ANSI escape bytes when piped", TIMEOUT, async () => {
    const result = await run(STATUS, "verified", { env: WARN });
    assert.equal(result.code, 0);
    assert.ok(!result.stdout.includes(ESC));
    assert.ok(!result.stderr.includes(ESC));
    assert.ok(result.stderr.includes("warning:"));
  });

  it(
    "removes colour with NO_COLOR=1 or --color=never, and --color=always wins over NO_COLOR",
    TIMEOUT,
    async () => {
      const noColor = await run(STATUS, "verified", { env: { ...WARN, NO_COLOR: "1" } });
      assert.ok(!noColor.stdout.includes(ESC) && !noColor.stderr.includes(ESC));
      const never = await run([...STATUS, "--color=never"], "verified", { env: WARN });
      assert.ok(!never.stdout.includes(ESC) && !never.stderr.includes(ESC));
      const always = await run([...STATUS, "--color=always"], "verified", {
        env: { ...WARN, NO_COLOR: "1" },
      });
      assert.ok(always.stdout.includes(`${ESC}[32mverified`));
      assert.ok(always.stderr.includes(`${ESC}[33mwarning:`));
    },
  );

  it(
    "draws no spinner frames on stderr when it is not a terminal, with or without CI",
    TIMEOUT,
    async () => {
      // `new` submits and waits for one poll, so a spinner would have time to draw.
      const results = await Promise.all(
        [{}, { CI: "true" }].map(async (env) => await run(VERIFY, "new", { env })),
      );
      for (const result of results) {
        assert.equal(result.code, 0);
        assert.ok(!result.stderr.includes("\r"));
      }
    },
  );

  it("never waits on stdin, whether it is closed, ended or open", TIMEOUT, async () => {
    for (const stdin of ["ignore", "ended", "open"] as const) {
      const result = await run([...STATUS, "--json"], "verified", { stdin });
      assert.equal(result.code, 0, stdin);
    }
  });

  it("puts nothing but the summary on stdout without --json", TIMEOUT, async () => {
    const result = await run([...STATUS, "--verbose"]);
    assert.equal(
      result.stdout,
      `verified: exact match on sourcify\nhttps://repo.sourcify.dev/11155111/${ADDRESS}\n`,
    );
  });
});

describe("bin: log levels and JSON lines (R-AX-14, R-AX-15)", () => {
  // `flaky` drops the first job status request, so the run has a verify.retry warning; the job
  // stays pending, so it ends not-confirmed with an error line once the 5 s budget runs out.
  const ARGS = [...VERIFY, "--json", "--timeout", "5", "--log-format", "json"];

  /** The JSON lines on stderr for one mode, the `type/level` of its events, and its levels. */
  async function linesFor(extra: string[], env: Record<string, string> = {}) {
    const result = await run([...ARGS, ...extra], "flaky", { env });
    assert.equal(result.code, 4, result.stderr);
    const lines = jsonLines(result.stderr);
    return {
      stdout: result.stdout,
      lines,
      events: lines
        .filter((line) => String(line["type"]).startsWith("verify."))
        .map((line) => `${String(line["type"])}/${String(line["level"])}`),
      levels: [...new Set(lines.map((line) => String(line["level"])))].toSorted(),
    };
  }

  it("matches the table at every level, with byte-identical stdout", TIMEOUT, async () => {
    const [quiet, normal, verbose, warn, error, off] = await Promise.all([
      linesFor(["--quiet"]),
      linesFor([]),
      linesFor(["--verbose"]),
      linesFor([], { EXPLORER_VERIFY_LOG: "warn" }),
      linesFor([], { EXPLORER_VERIFY_LOG: "error" }),
      linesFor([], { EXPLORER_VERIFY_LOG: "off" }),
    ]);
    assert.deepEqual(quiet.levels, ["error"]);
    assert.deepEqual(quiet.events, []);
    assert.deepEqual(error.levels, ["error"]);
    assert.deepEqual(off.lines, []);
    assert.deepEqual(warn.levels, ["error", "warn"]);
    assert.deepEqual(warn.events, ["verify.retry/warn"]);
    assert.deepEqual(normal.levels, ["error", "info", "warn"]);
    assert.deepEqual(normal.events, ["verify.submitted/info", "verify.retry/warn"]);
    assert.deepEqual(verbose.levels, ["debug", "error", "info", "warn"]);
    assert.deepEqual(verbose.events, [
      "verify.validated/debug",
      "verify.routed/debug",
      "verify.lookup/debug",
      "verify.submitted/info",
      "verify.retry/warn",
      "verify.poll/debug",
    ]);
    for (const mode of [quiet, warn, error, off, verbose]) {
      assert.equal(mode.stdout, normal.stdout);
    }
  });

  it(
    "writes lines that parse and carry schemaVersion, level, message and type",
    TIMEOUT,
    async () => {
      // The reserved field names `type` and `fields` are covered in-process by main.test.ts.
      const { lines } = await linesFor(["--verbose"]);
      assert.ok(lines.length > 0);
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
      const submitted = lines.find((line) => line["type"] === "verify.submitted");
      assert.equal(submitted?.["handle"], HANDLE);
    },
  );

  it(
    "warns about an invalid EXPLORER_VERIFY_LOG without its value, and keeps the default level",
    TIMEOUT,
    async () => {
      const value = "VERY-LOUD-PLEASE";
      const result = await run([...VERIFY, "--json"], "new", {
        env: { EXPLORER_VERIFY_LOG: value },
      });
      assert.equal(result.code, 0);
      assert.ok(!result.stderr.includes(value));
      assert.match(result.stderr, /^warning: EXPLORER_VERIFY_LOG is not one of/);
      assert.match(result.stderr, /Submitted to sourcify/);
    },
  );
});

describe("bin: internal-error and redaction (R-AX-5, R-SEC-1)", () => {
  it("leaves a dummy key out of the internal-error envelope and stderr", TIMEOUT, async () => {
    // The test preload makes the command throw this once it has read its keys.
    const message = `request failed: https://api.example.org/?apikey=${DUMMY_KEY} key ${DUMMY_KEY}`;
    const result = await runBin([...STATUS, "--json", "--verbose"], { fake: { bug: message } });
    assert.equal(result.code, 6);
    assert.ok(!result.stdout.includes(DUMMY_KEY));
    assert.ok(!result.stderr.includes(DUMMY_KEY));
    // The stack line of --verbose shows the error was the one the preload threw.
    assert.match(result.stderr, /^debug: The stack of the unexpected error, redacted\./m);
    const envelope = oneEnvelope(result.stdout);
    assert.deepEqual(envelopeProblems(envelope), []);
    const error = envelope["error"] ?? {};
    assert.equal(Reflect.get(error, "code"), "internal-error");
    assert.match(String(Reflect.get(error, "message")), /^An unexpected error occurred: Error: /);
    assert.equal(Reflect.get(error, "retryable"), false);
    assert.equal(Reflect.has(error, "handle"), false);
    assert.equal(
      Reflect.get(error, "hint"),
      "This is a bug in explorer-verify. Report it with the command you ran, without your API key.",
    );
  });
});
