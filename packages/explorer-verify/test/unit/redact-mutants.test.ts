// Tests added after the first full mutation run (#158; R-SEC-1, R-DX-5): each one fails on a code
// change in src/redact.ts that the other redaction tests let pass.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { LogFields, Logger } from "../../src/index.ts";
import {
  EXCERPT_MARGIN,
  MIN_SECRET_LENGTH,
  REDACTED,
  redact,
  redactExcerpt,
  redactJobId,
  redactingLogger,
} from "../../src/redact.ts";

type Line = [message: unknown, fields?: LogFields];

function recorder(): { logger: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const record = (message: string, fields?: LogFields): void => {
    lines.push(fields === undefined ? [message] : [message, fields]);
  };
  return { logger: { debug: record, info: record, warn: record, error: record }, lines };
}

/**
 * A text whose first `prefix` characters are `x`, then an `apikey` parameter whose value runs past
 * any excerpt window. Redaction shrinks the window to `prefix + 18` characters, so the excerpt's
 * length shows the tail that redactExcerpt dropped.
 */
function shrinkingText(prefix: number): string {
  return `${"x".repeat(prefix)}&apikey=${"v".repeat(5_000)}`;
}

describe("redact: cases from the first full mutation run (#158, R-SEC-1)", () => {
  it("redacts the form of a secret with a backslash that a URL path shows, of the same length", () => {
    // The WHATWG URL parser turns `\` into `/` in a path: the form has the secret's length.
    const secret = String.raw`path\key-0158`;
    assert.equal(new URL(`http://h/${secret}`).pathname.slice(1).length, secret.length);
    assert.equal(
      redact("GET https://rpc.example/v2/path/key-0158/x", [secret]),
      `GET https://rpc.example/v2/${REDACTED}/x`,
    );
  });

  it("leaves a job id unchanged when no secret matches, even one holding `undefined`", () => {
    assert.equal(redactJobId("job-undefined-158", []), "job-undefined-158");
    assert.equal(redactJobId("job-undefined-158", ["not-in-the-job"]), "job-undefined-158");
  });
});

describe("redactExcerpt: the tail follows the longest known secret (#158, R-SEC-1)", () => {
  // Short enough that the excerpt ends before `length`, which the tail then decides.
  const prefix = EXCERPT_MARGIN + 32;
  // The window ends inside the `apikey` value, so the redacted window is `prefix + 18` long.
  const redactedWindow = prefix + "&apikey=".length + REDACTED.length;

  it("ignores a secret shorter than the minimum length", () => {
    const short = "a".repeat(MIN_SECRET_LENGTH - 1);
    const excerpt = redactExcerpt(shrinkingText(prefix), [short], 100);
    assert.equal(excerpt.length, redactedWindow - EXCERPT_MARGIN);
  });

  it("counts a secret of exactly the minimum length", () => {
    const exact = "b".repeat(MIN_SECRET_LENGTH);
    const excerpt = redactExcerpt(shrinkingText(prefix), [exact], 100);
    assert.equal(excerpt.length, redactedWindow - EXCERPT_MARGIN - MIN_SECRET_LENGTH);
  });
});

describe("redactingLogger: cases from the first full mutation run (#158, R-DX-5)", () => {
  it("logs a boolean message as its text", () => {
    const { logger, lines } = recorder();
    const log = redactingLogger(logger);
    // A caller without types can pass any value as the message.
    Reflect.apply(log.info, undefined, [true]);
    Reflect.apply(log.warn, undefined, [false]);
    assert.deepEqual(lines, [["true"], ["false"]]);
  });

  it("replaces only a string value of a key-named field, and keeps a number", () => {
    const { logger, lines } = recorder();
    redactingLogger(logger).info("x", { token: 5, apikey: true, secret: null, key: "k-0158" });
    assert.deepEqual(lines, [["x", { token: 5, apikey: true, secret: null, key: REDACTED }]]);
  });
});
