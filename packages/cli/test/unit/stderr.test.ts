// The stderr writer: levels (R-AX-15), JSON lines and reserved names (R-AX-14), colour and the
// spinner (R-AX-6).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ErrorJson, VerifyEvent } from "explorer-verify";

import type { LogLevel } from "../../src/log-level.ts";
import { createStderr, eventMessage, jsonLine, repeats, stageText } from "../../src/stderr.ts";
import type { StderrOptions } from "../../src/stderr.ts";
import { jsonLines } from "../helpers/fake-io.ts";

const HANDLE = "ev1:sourcify:1:0x5fbdb2315678afecb367f032d93f642f64180aa3:job-1";

const EVENTS: readonly VerifyEvent[] = [
  { type: "verify.validated", chainId: 1, address: "0x5fbdb2315678afecb367f032d93f642f64180aa3" },
  { type: "verify.routed", backend: "sourcify", apiHost: "sourcify.dev" },
  { type: "verify.lookup", backend: "sourcify", lookup: "none" },
  { type: "verify.retry", backend: "sourcify", attempt: 2, reason: "network", delayMs: 10 },
  { type: "verify.submitted", backend: "sourcify", handle: HANDLE },
  { type: "verify.poll", backend: "sourcify", attempt: 1, state: "pending" },
  { type: "verify.result", backend: "sourcify", status: "verified", match: "exact" },
  { type: "verify.result", backend: "sourcify", status: "failed" },
];

const ERROR: ErrorJson = {
  code: "not-confirmed",
  message: "Still pending.",
  hint: "Call checkStatus later.",
  docsUrl: "https://example.org/not-confirmed",
  retryable: true,
  handle: HANDLE,
  details: { code: "not-confirmed", handle: HANDLE },
};

function writer(options: Partial<StderrOptions> = {}) {
  let text = "";
  const stderr = createStderr({
    stream: {
      write: (chunk) => {
        text += chunk;
      },
    },
    level: "info",
    format: "json",
    color: false,
    spinner: false,
    ...options,
  });
  return { stderr, text: () => text };
}

/** Writes one line of each kind at `level` and returns the `type`/`level` pairs that appeared. */
function shown(level: LogLevel): string[] {
  const { stderr, text } = writer({ level });
  stderr.logger.debug("d");
  stderr.logger.info("i");
  stderr.logger.warn("w");
  stderr.logger.error("e");
  for (const event of EVENTS) {
    stderr.onEvent(event);
  }
  stderr.error(ERROR);
  return jsonLines(text()).map((line) => `${String(line["type"])}/${String(line["level"])}`);
}

describe("stderr levels (R-AX-15)", () => {
  it("shows only errors at error (--quiet)", () => {
    assert.deepEqual(shown("error"), ["log/error", "log/error"]);
  });

  it("shows nothing at off", () => {
    assert.deepEqual(shown("off"), []);
  });

  it("shows errors, warnings and verify.retry at warn, without submitted and result", () => {
    assert.deepEqual(shown("warn"), ["log/warn", "log/error", "verify.retry/warn", "log/error"]);
  });

  it("adds info logs, verify.submitted and verify.result at info (the default)", () => {
    assert.deepEqual(shown("info"), [
      "log/info",
      "log/warn",
      "log/error",
      "verify.retry/warn",
      "verify.submitted/info",
      "verify.result/info",
      "verify.result/info",
      "log/error",
    ]);
  });

  it("adds debug logs and every other event at debug (--verbose)", () => {
    assert.deepEqual(shown("debug"), [
      "log/debug",
      "log/info",
      "log/warn",
      "log/error",
      "verify.validated/debug",
      "verify.routed/debug",
      "verify.lookup/debug",
      "verify.retry/warn",
      "verify.submitted/info",
      "verify.poll/debug",
      "verify.result/info",
      "verify.result/info",
      "log/error",
    ]);
  });
});

describe("JSON lines (R-AX-14)", () => {
  it("starts each line with schemaVersion, level, message and type, then the event's fields", () => {
    const { stderr, text } = writer();
    stderr.onEvent({ type: "verify.submitted", backend: "sourcify", handle: HANDLE });
    assert.equal(
      text(),
      `{"schemaVersion":1,"level":"info","message":"Submitted to sourcify. Handle: ${HANDLE}","type":"verify.submitted","backend":"sourcify","handle":"${HANDLE}"}\n`,
    );
  });

  it("puts a field with a reserved name under fields, so fields appears as fields.fields", () => {
    const { stderr, text } = writer();
    stderr.logger.info("m", {
      a: 1,
      fields: "f",
      type: "t",
      level: "l",
      message: "x",
      schemaVersion: 2,
      b: null,
    });
    const [line] = jsonLines(text());
    assert.deepEqual(line, {
      schemaVersion: 1,
      level: "info",
      message: "m",
      type: "log",
      a: 1,
      b: null,
      fields: { fields: "f", type: "t", level: "l", message: "x", schemaVersion: 2 },
    });
  });

  it("keeps a field named __proto__ as a field", () => {
    const fields: Record<string, string> = Object.fromEntries([["__proto__", "p"]]);
    const line = jsonLine("info", "m", "log", fields);
    assert.equal(
      line,
      '{"schemaVersion":1,"level":"info","message":"m","type":"log","__proto__":"p"}',
    );
  });

  it("writes the error with its code, hint, docs URL, retry flag and handle", () => {
    const { stderr, text } = writer();
    stderr.error(ERROR);
    assert.deepEqual(jsonLines(text()), [
      {
        schemaVersion: 1,
        level: "error",
        message: "Still pending.",
        type: "log",
        code: "not-confirmed",
        hint: "Call checkStatus later.",
        docsUrl: "https://example.org/not-confirmed",
        retryable: true,
        handle: HANDLE,
      },
    ]);
  });
});

describe("text lines", () => {
  it("prefixes debug, warning and error lines, and writes fields as name=value", () => {
    const { stderr, text } = writer({ format: "text", level: "debug" });
    stderr.logger.debug("d", { a: "plain", b: "two words", c: 'q"uote', d: "x=y", e: "", f: 2 });
    stderr.logger.info("i");
    stderr.logger.warn("w");
    stderr.logger.error("e", { ok: false });
    assert.equal(
      text(),
      'debug: d a=plain b="two words" c="q\\"uote" d="x=y" e="" f=2\ni\nwarning: w\nerror: e ok=false\n',
    );
  });

  // R-SEC-1, decision 0063: a log message can hold explorer text, such as a stored contract name.
  it("shows control characters in a message as escapes, so none reaches the terminal", () => {
    const { stderr, text } = writer({ format: "text", level: "debug" });
    stderr.logger.warn("Sourcify holds another contract's source (A\r\u001b[2KB)");
    assert.equal(
      text(),
      "warning: Sourcify holds another contract's source (A\\u000d\\u001b[2KB)\n",
    );
  });

  it("writes each event's message, with the level prefix", () => {
    const { stderr, text } = writer({ format: "text", level: "debug" });
    for (const event of EVENTS) {
      stderr.onEvent(event);
    }
    assert.equal(
      text(),
      [
        "debug: Input is valid: chain 1, contract 0x5fbdb2315678afecb367f032d93f642f64180aa3.",
        "debug: Routed to sourcify at sourcify.dev.",
        "debug: Lookup on sourcify: none.",
        "warning: Retrying sourcify after network: attempt 2 in 10 ms.",
        `Submitted to sourcify. Handle: ${HANDLE}`,
        "debug: Poll 1 on sourcify: pending.",
        "Result from sourcify: verified, exact match.",
        "Result from sourcify: failed.",
        "",
      ].join("\n"),
    );
  });

  it("writes the error over several lines, with the handle only when there is one", () => {
    const { stderr, text } = writer({ format: "text" });
    stderr.error(ERROR);
    const { handle: _handle, ...withoutHandle } = ERROR;
    stderr.error(withoutHandle);
    assert.equal(
      text(),
      [
        "error: Still pending. (not-confirmed)",
        "  hint: Call checkStatus later.",
        "  docs: https://example.org/not-confirmed",
        `  handle: ${HANDLE}`,
        "error: Still pending. (not-confirmed)",
        "  hint: Call checkStatus later.",
        "  docs: https://example.org/not-confirmed",
        "",
      ].join("\n"),
    );
  });

  it("colours the prefixes when colour is on", () => {
    const { stderr, text } = writer({ format: "text", color: true });
    stderr.logger.warn("w");
    stderr.error(ERROR);
    assert.ok(text().startsWith("\u001B[33mwarning:\u001B[0m w\n\u001B[31merror:\u001B[0m Still"));
  });

  it("names every event type in eventMessage", () => {
    for (const event of EVENTS) {
      assert.ok(eventMessage(event).length > 0, event.type);
    }
  });

  it("formats proxy stages without verification labels", () => {
    const events: VerifyEvent[] = [
      { type: "proxy.routed", backend: "blockscout", apiHost: "scan.example" },
      { type: "proxy.poll", backend: "blockscout", attempt: 1, state: "pending" },
      { type: "proxy.retry", backend: "blockscout", attempt: 2, reason: "network", delayMs: 100 },
      { type: "proxy.result", backend: "blockscout", status: "not-linked", reason: "refused" },
    ];
    for (const event of events) {
      assert.ok(eventMessage(event).includes("blockscout"));
      assert.ok(stageText(event).includes("blockscout"));
    }
  });
});

describe("one line per fact in text at info (R-AX-14, #225)", () => {
  const SUBMITTED = EVENTS[4];
  const RESULT = EVENTS[6];
  assert.ok(SUBMITTED !== undefined && RESULT !== undefined);
  // The library's own wording, as flow/verify.ts and flow/dry-run.ts write it.
  const ACCEPTED = `Sourcify accepted the submission. Resume it with this handle: ${HANDLE}`;
  const DRY_RUN = "Dry run: Sourcify holds no match, so a verification would submit the source.";

  it("shows the event, and the core's info line that repeats it only at debug", () => {
    for (const level of ["info", "debug"] as const) {
      const { stderr, text } = writer({ format: "text", level });
      stderr.onEvent(SUBMITTED);
      // A line of another backend in between changes nothing: the match reads each line alone.
      stderr.logger.info("Routescan accepted the submission. Resume it with this handle: h", {
        backend: "routescan",
        handle: "h",
      });
      stderr.logger.info(ACCEPTED, { backend: "sourcify", handle: HANDLE });
      stderr.onEvent(RESULT);
      stderr.logger.info("Result: verified (exact) on Sourcify", {
        backend: "sourcify",
        status: "verified",
      });
      stderr.logger.info(DRY_RUN, { backend: "sourcify", routedBy: "table" });
      const lines = text().trimEnd().split("\n");
      if (level === "info") {
        assert.deepEqual(lines, [
          `Submitted to sourcify. Handle: ${HANDLE}`,
          "Result from sourcify: verified, exact match.",
        ]);
      } else {
        assert.equal(lines.length, 6);
        assert.match(lines[1] ?? "", /^debug: Routescan accepted the submission\./);
        assert.match(lines[2] ?? "", /^debug: Sourcify accepted the submission\./);
        assert.match(lines[4] ?? "", /^debug: Result: verified/);
        assert.match(lines[5] ?? "", /^debug: Dry run: /);
      }
    }
  });

  it("keeps a line without the marker's field, at any other level, and any other info line", () => {
    const { stderr, text } = writer({ format: "text" });
    stderr.logger.info(ACCEPTED, { backend: "sourcify" });
    stderr.logger.info("Result: something", {});
    stderr.logger.info(DRY_RUN);
    stderr.logger.warn("Result: a warning", { status: "x" });
    stderr.logger.info("Derived the constructor arguments", { backend: "sourcify" });
    assert.equal(text().trimEnd().split("\n").length, 5);
    assert.equal(repeats(ACCEPTED, { handle: HANDLE }), true);
    assert.equal(repeats("Other", { handle: HANDLE }), false);
  });

  it("keeps both lines with --log-format json", () => {
    const { stderr, text } = writer({ format: "json" });
    stderr.onEvent(SUBMITTED);
    stderr.logger.info(ACCEPTED, { backend: "sourcify", handle: HANDLE });
    assert.deepEqual(
      jsonLines(text()).map((line) => [line["type"], line["level"]]),
      [
        ["verify.submitted", "info"],
        ["log", "info"],
      ],
    );
  });
});

describe("spinner (R-AX-6)", () => {
  it("draws frames, clears its line before each log line, and clears it when stopped", (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const { stderr, text } = writer({ format: "text", spinner: true, now: () => 0 });
    stderr.startSpinner("Working");
    stderr.startSpinner("Ignored");
    t.mock.timers.tick(100);
    stderr.logger.info("line");
    stderr.stopSpinner();
    stderr.stopSpinner();
    t.mock.timers.tick(1000);
    assert.equal(
      text(),
      "\r\u001B[2K| Working (0 s)\r\u001B[2K/ Working (0 s)\r\u001B[2Kline\n\r\u001B[2K- Working (0 s)\r\u001B[2K",
    );
  });

  it("shows the stage of the last event and the whole seconds since the start (#225)", (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 5_000 });
    const { stderr, text } = writer({ format: "text", spinner: true, level: "error" });
    stderr.startSpinner("Running verify");
    t.mock.timers.tick(1_900);
    // The event's line is hidden at error, but the spinner still shows its stage.
    stderr.onEvent({ type: "verify.poll", backend: "sourcify", attempt: 3, state: "pending" });
    t.mock.timers.tick(100);
    stderr.stopSpinner();
    const frames = text()
      .split("\r\u001B[2K")
      .filter((frame) => frame !== "");
    assert.equal(frames[0], "| Running verify (0 s)");
    assert.equal(frames.at(-2)?.slice(2), "Running verify (1 s)");
    assert.equal(frames.at(-1)?.slice(2), "Waiting for sourcify: pending, poll 3 (2 s)");
  });

  it("gives every event type a stage", () => {
    assert.deepEqual(
      EVENTS.map((event) => stageText(event)),
      [
        "Checked the input",
        "Routed to sourcify",
        "Looked the contract up on sourcify",
        "Retrying sourcify after network",
        "Submitted to sourcify, waiting for the result",
        "Waiting for sourcify: pending, poll 1",
        "Result from sourcify: verified",
        "Result from sourcify: failed",
      ],
    );
  });

  it("draws nothing when the terminal rules forbid a spinner", (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const { stderr, text } = writer({ format: "text", spinner: false });
    stderr.startSpinner("Working");
    t.mock.timers.tick(1000);
    stderr.stopSpinner();
    assert.equal(text(), "");
  });
});
