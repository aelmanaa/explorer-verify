// Tests for the handle checks that do not throw and the HandleString type (#218; R-FLOW-5,
// R-SEC-2): `tryParseHandle`, `isHandleString` and `checkHandle`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkHandle } from "../../src/flow/check-handle.ts";
import { redactSplitHandle, splitHandle } from "../../src/flow/format-handle.ts";
import {
  ExplorerVerifyError,
  formatHandle,
  isHandleString,
  parseHandle,
  tryParseHandle,
} from "../../src/index.ts";
import type { ErrorJson, Handle, HandleString, InputIssue, VerifyEvent } from "../../src/index.ts";
import { redactEvent } from "../../src/observe.ts";

const ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const JOB = "550e8400-e29b-41d4-a716-446655440000";
// A made-up key. Never a real one (R-SEC-1).
const DUMMY_KEY = "check-handle-dummy-key-7q2w";

function handle(overrides: Partial<Handle> = {}): Handle {
  return {
    version: 1,
    backend: "sourcify",
    chainId: 11155111,
    address: ADDRESS,
    jobId: JOB,
    ...overrides,
  };
}

/** The first issue of the error parseHandle throws for a value in neither form. */
function shapeIssue(): InputIssue {
  try {
    parseHandle("x");
  } catch (error: unknown) {
    assert.ok(error instanceof ExplorerVerifyError);
    const { details } = error;
    if (details.code === "invalid-input" && details.issues[0] !== undefined) {
      return details.issues[0];
    }
  }
  return assert.fail("parseHandle gave no shape issue");
}

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// Each constant only compiles when its type is `true`; the runtime assertion keeps it used.
const formatReturns: Equals<ReturnType<typeof formatHandle>, HandleString> = true;
const submittedHandle: Equals<
  Extract<VerifyEvent, { type: "verify.submitted" }>["handle"],
  HandleString
> = true;
const jsonHandle: Equals<ErrorJson["handle"], HandleString | undefined> = true;
const jsonHandles: Equals<NonNullable<ErrorJson["handles"]>[number]["handle"], HandleString> = true;
const tryReturns: Equals<ReturnType<typeof tryParseHandle>, Handle | undefined> = true;
// A literal in the one-line form fits the type; text in another shape does not.
const literalFits: "ev1:sourcify:1:0xab:job" extends HandleString ? true : false = true;
const otherVersion: "ev2:sourcify:1:0xab:job" extends HandleString ? true : false = false;
const unknownBackend: "ev1:nope:1:0xab:job" extends HandleString ? true : false = false;
const textChainId: "ev1:sourcify:one:0xab:job" extends HandleString ? true : false = false;
const noHexPrefix: "ev1:sourcify:1:ab:job" extends HandleString ? true : false = false;
const plainString: string extends HandleString ? true : false = false;

/** `value` narrowed by isHandleString, or `undefined`: compiles only when it narrows to HandleString. */
function narrowed(value: unknown): HandleString | undefined {
  return isHandleString(value) ? value : undefined;
}

describe("HandleString (#218)", () => {
  it("types formatHandle, the verify.submitted event and ErrorJson with the one-line form", () => {
    for (const check of [formatReturns, submittedHandle, jsonHandle, jsonHandles, tryReturns]) {
      assert.equal(check, true);
    }
    assert.equal(literalFits, true);
    for (const check of [otherVersion, unknownBackend, textChainId, noHexPrefix, plainString]) {
      assert.equal(check, false);
    }
  });
});

describe("tryParseHandle (R-FLOW-5, #218)", () => {
  it("reads both forms parseHandle reads, and returns a new handle", () => {
    const original = handle();
    for (const value of [original, formatHandle(original)]) {
      const read = tryParseHandle(value);
      assert.deepEqual(read, original);
      assert.notEqual(read, original);
      assert.deepEqual(read, parseHandle(value));
    }
  });

  it("returns undefined, never throws, for every value parseHandle rejects", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("trap");
        },
      },
    );
    const line = formatHandle(handle());
    for (const value of [
      undefined,
      null,
      7,
      "",
      "garbage",
      // Near misses: JSON text, a leading space or BOM, a JSON-quoted line, a String object.
      JSON.stringify(handle()),
      ` ${line}`,
      `﻿${line}`,
      JSON.stringify(line),
      new String(line),
      `${line}:extra`,
      { ...handle(), url: "https://evil.example" },
      hostile,
    ]) {
      assert.equal(tryParseHandle(value), undefined);
      assert.throws(() => parseHandle(value), ExplorerVerifyError);
    }
  });

  it("gives each error its own copy of the shape issue", () => {
    const first = shapeIssue();
    first.message = "changed";
    assert.equal(shapeIssue().message.startsWith("must be a handle object"), true);
  });

  it("reads a string only as the one-line form, so JSON text names the shape (R-SEC-2)", () => {
    assert.deepEqual(checkHandle(JSON.stringify(handle())).issues, [
      {
        field: "handle",
        message:
          "must be a handle object or its one-line form ev1:<backend>:<chainId>:<address>:<jobId>",
      },
    ]);
  });
});

describe("isHandleString (R-FLOW-5, #218)", () => {
  it("is true for a valid one-line handle and narrows it to HandleString", () => {
    const line: string = formatHandle(handle());
    assert.equal(isHandleString(line), true);
    assert.equal(narrowed(line), line);
  });

  it("is false for the handle object, JSON text and every invalid value", () => {
    for (const value of [
      handle(),
      JSON.stringify(handle()),
      undefined,
      1,
      "ev1:",
      "garbage",
      formatHandle(handle({ jobId: "a/b" })),
      formatHandle(handle()).replace("ev1", "ev2"),
      ` ${formatHandle(handle())}`,
    ]) {
      assert.equal(isHandleString(value), false);
      assert.equal(narrowed(value), undefined);
    }
  });

  it("is false for a handle whose job id was redacted, though its type is HandleString (R-SEC-1)", () => {
    const split = splitHandle(formatHandle(handle({ jobId: DUMMY_KEY })));
    assert.ok(split !== undefined);
    const redacted: HandleString = redactSplitHandle(split, [DUMMY_KEY]);
    assert.equal(redacted.endsWith(":[redacted]"), true);
    assert.equal(isHandleString(redacted), false);
    assert.throws(() => parseHandle(redacted), ExplorerVerifyError);
  });

  it("is false for the stand-in line of an event handle that untyped code broke", () => {
    const out: unknown = Reflect.apply(redactEvent, undefined, [
      { type: "verify.submitted", backend: "sourcify", handle: "not a handle" },
      [],
    ]);
    const line: unknown = Reflect.get(Object(out), "handle");
    assert.equal(line, "ev1:sourcify:0:0x:not a handle");
    assert.equal(isHandleString(line), false);
    assert.throws(() => parseHandle(line), ExplorerVerifyError);
  });
});
