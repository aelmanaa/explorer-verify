// Hints that read without the library's field names (R-DX-3, R-AX-10, issue #286), and
// `hintFor(error, "user")`, the hint for the people who use a tool built on explorer-verify
// (issue #298, decision 0061).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import * as errorsEntry from "../../src/entries/errors.ts";
import { ERROR_HINTS, newError } from "../../src/error-hints.ts";
import { ERROR_CODES, hintFor } from "../../src/index.ts";
import type { ErrorDetails, ErrorJson, Handle } from "../../src/index.ts";
import { NOT_INDEXED_ANSWER } from "../../src/not-indexed.ts";
import { pageDetails, SAMPLE_DETAILS } from "../helpers/sample-details.ts";

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = path.join(PACKAGE, "src");

/** Every TypeScript file under `src/`. */
function sources(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sources(file);
    }
    return entry.name.endsWith(".ts") ? [file] : [];
  });
}

/** A module's code without its comments. */
function codeOf(text: string): string {
  return text.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "");
}

// A hint constant (`const X_HINT = "..."`), a `hint:` property, or a `hint =` or `hint ??=`
// assignment, with a string or template literal as its value.
const HINT_LITERAL =
  /(?:\b[A-Z_]*HINT\s*=|\bhint\s*(?:\?\?=|=|:))\s*(?:"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`)/g;

/** Each hint literal of the core's source, with the file it is in. Template parts become `X`. */
function specificHints(): { file: string; hint: string }[] {
  return sources().flatMap((file) =>
    [...codeOf(readFileSync(file, "utf8")).matchAll(HINT_LITERAL)].map((match) => ({
      file: path.relative(PACKAGE, file),
      hint: (match[1] ?? match[2] ?? "").replaceAll(/\$\{[^}]*\}/g, "X"),
    })),
  );
}

/** The hint with every parenthesised part removed. */
function withoutParentheses(hint: string): string {
  return hint.replaceAll(/\([^()]*\)/g, "");
}

/** The names of the functions that the package's entries export. */
async function functionNames(): Promise<Set<string>> {
  const manifest: unknown = JSON.parse(readFileSync(path.join(PACKAGE, "package.json"), "utf8"));
  const exports: unknown = Reflect.get(Object(manifest), "exports");
  const names = new Set<string>();
  const targets = typeof exports === "object" && exports !== null ? Object.values(exports) : [];
  for (const target of targets) {
    const file: unknown = Reflect.get(Object(target), "default");
    if (typeof file !== "string" || !file.endsWith(".js")) {
      continue;
    }
    const source = path.join(PACKAGE, file.replace("./dist/src/", "src/").replace(/\.js$/, ".ts"));
    const module: object = await import(source);
    for (const [name, value] of Object.entries(module)) {
      if (typeof value === "function") {
        names.add(name);
      }
    }
  }
  return names;
}

/** The property names of every interface in `src/` whose name ends with `Options`. */
function optionNames(): Set<string> {
  const names = new Set<string>();
  for (const file of sources()) {
    const code = codeOf(readFileSync(file, "utf8"));
    for (const block of code.matchAll(/^export interface \w*Options\b[^{]*\{([\s\S]*?)^\}/gm)) {
      for (const field of (block[1] ?? "").matchAll(/^\s+(?:readonly\s+)?(\w+)\??:/gm)) {
        names.add(field[1] ?? "");
      }
    }
  }
  return names;
}

/**
 * Option names that are also the plain words an end user needs: the contract and its bytecode.
 * Every other option name, such as `route`, `signal` or `fetch`, must not appear in a user hint.
 */
const PLAIN_WORDS: ReadonlySet<string> = new Set(["contract", "bytecode"]);

/** The end-user hint of `value` for any value, cast-free, as an untyped caller would pass it. */
function userHintOf(value: unknown, audience: unknown = "user"): string {
  const out: unknown = Reflect.apply(hintFor, undefined, [value, audience]);
  assert.equal(typeof out, "string");
  return String(out);
}

/** The error of `details`, built as the library builds it. */
function errorOf(details: ErrorDetails) {
  return newError(details, "m", { secrets: [] });
}

const HANDLE: Handle = {
  version: 1,
  backend: "sourcify",
  chainId: 11155111,
  address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  jobId: "550e8400-e29b-41d4-a716-446655440000",
};

/** The end-user hint of a `rate-limited` error with `retryAfterMs`, or without it. */
function rateLimitedUserHint(retryAfterMs?: number): string {
  const details: ErrorDetails = {
    code: "rate-limited",
    backend: "routescan",
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
  return hintFor(errorOf(details), "user");
}

/** The details of every code, and of each case whose end-user hint reads the details. */
function everyCase(): ErrorDetails[] {
  return [
    ...ERROR_CODES.map((code) => SAMPLE_DETAILS[code]),
    ...ERROR_CODES.map((code) => pageDetails(code)),
    { code: "rate-limited", backend: "etherscan-v2", retryAfterMs: 61_000 },
    {
      code: "unexpected-response",
      backend: "etherscan-v2",
      status: 200,
      excerpt: '{"status":"0","message":"NOTOK","result":"Unable to locate ContractCode at 0x5f"}',
    },
    { code: "cancelled", handles: [HANDLE] },
  ];
}

describe("hint wording without field names (R-DX-3, R-AX-10, #286)", () => {
  it("names no details., options. or error. field outside parentheses in ERROR_HINTS", () => {
    for (const code of ERROR_CODES) {
      const rest = withoutParentheses(ERROR_HINTS[code]);
      assert.doesNotMatch(rest, /\b(?:details|options|error)\.\w/, code);
    }
  });

  it("names no details., options. or error. field outside parentheses in a specific hint of the core", () => {
    const hints = specificHints();
    // The core holds dozens of hints; a scan that finds few means the pattern broke.
    assert.ok(hints.length >= 40, String(hints.length));
    for (const { file, hint } of hints) {
      assert.doesNotMatch(
        withoutParentheses(hint),
        /\b(?:details|options|error)\.\w/,
        `${file}: ${hint}`,
      );
    }
  });

  it("finds the hints that the rule rewrote", () => {
    const hints = specificHints().map(({ hint }) => hint);
    assert.ok(hints.some((hint) => hint.includes("(options.contract)")));
    assert.ok(hints.some((hint) => hint.includes("(details.path)")));
    assert.ok(hints.some((hint) => hint.includes("(details.issues)")));
  });

  it("does not name the CLI's status command in the cancelled hint", () => {
    assert.doesNotMatch(ERROR_HINTS.cancelled, /explorer-verify|\bstatus\b/);
    assert.match(ERROR_HINTS.cancelled, /\bcheckStatus\b/);
  });
});

describe("hintFor (R-DX-3, R-AX-10, #298)", () => {
  it("is exported from explorer-verify/errors as the same function", () => {
    assert.equal(errorsEntry.hintFor, hintFor);
  });

  it("gives error.hint for the developer, from the error and from its JSON form", () => {
    for (const code of ERROR_CODES) {
      const error = errorOf(SAMPLE_DETAILS[code]);
      assert.equal(hintFor(error, "developer"), error.hint, code);
      assert.equal(hintFor(error.toJSON(), "developer"), error.hint, code);
    }
    const specific = newError(SAMPLE_DETAILS.timeout, "m", { hint: "Use sourcify.", secrets: [] });
    assert.equal(hintFor(specific, "developer"), "Use sourcify.");
  });

  it("gives every code a user hint that differs from the developer hint", () => {
    for (const code of ERROR_CODES) {
      const error = errorOf(SAMPLE_DETAILS[code]);
      const hint = hintFor(error, "user");
      assert.ok(hint.length > 20, code);
      assert.notEqual(hint, error.hint, code);
      assert.equal(hintFor(error.toJSON(), "user"), hint, code);
    }
  });

  it("names no function, option, field or command in a user hint", async () => {
    const functions = await functionNames();
    const options = optionNames();
    // The scans must find the names they guard against.
    for (const name of ["verify", "checkStatus", "linkProxy", "buildVerifyInput", "hintFor"]) {
      assert.ok(functions.has(name), name);
    }
    for (const name of ["apiKeys", "timeoutMs", "rpcUrl", "route", "signal", "fetch"]) {
      assert.ok(options.has(name), name);
    }
    for (const details of everyCase()) {
      const hint = hintFor(errorOf(details), "user");
      const where = `${details.code}: ${hint}`;
      assert.doesNotMatch(hint, /[()]/, where);
      assert.doesNotMatch(hint, /\b(?:details|options|error)\.\w/, where);
      assert.doesNotMatch(hint, /\boptions\b/i, where);
      assert.doesNotMatch(hint, /--|\bexplorer-verify\b/, where);
      for (const name of functions) {
        assert.doesNotMatch(hint, new RegExp(`\\b${name}\\b`), `${where} names ${name}`);
      }
      for (const name of options) {
        if (PLAIN_WORDS.has(name)) {
          continue;
        }
        assert.doesNotMatch(hint, new RegExp(`\\b${name}\\b`), `${where} names ${name}`);
      }
    }
  });

  it("names the wait the explorer asked for, in whole seconds rounded up", () => {
    const user = rateLimitedUserHint;
    assert.equal(user(3_000), "The explorer is limiting requests. Wait 3 seconds, then try again.");
    assert.equal(user(2_001), "The explorer is limiting requests. Wait 3 seconds, then try again.");
    assert.equal(user(1_000), "The explorer is limiting requests. Wait 1 second, then try again.");
    assert.equal(user(1), "The explorer is limiting requests. Wait 1 second, then try again.");
    const generic = "The explorer is limiting requests. Wait a few seconds, then try again.";
    assert.equal(user(), generic);
    assert.equal(user(0), generic);
    assert.equal(user(-5), generic);
  });

  it("names minutes from 120 seconds, and says later above one hour", () => {
    const user = rateLimitedUserHint;
    assert.equal(
      user(119_000),
      "The explorer is limiting requests. Wait 119 seconds, then try again.",
    );
    assert.equal(
      user(120_000),
      "The explorer is limiting requests. Wait 2 minutes, then try again.",
    );
    assert.equal(
      user(299_001),
      "The explorer is limiting requests. Wait 5 minutes, then try again.",
    );
    assert.equal(
      user(3_600_000),
      "The explorer is limiting requests. Wait 60 minutes, then try again.",
    );
    const later = "The explorer is limiting requests. Try again later.";
    assert.equal(user(3_600_001), later);
    assert.equal(user(1e300), later);
  });

  it("ignores a wait in a JSON form that is not a finite number", () => {
    const json: ErrorJson = {
      ...errorOf({ code: "rate-limited", backend: "routescan" }).toJSON(),
      code: "rate-limited",
      details: {
        code: "rate-limited",
        backend: "routescan",
        retryAfterMs: Number.POSITIVE_INFINITY,
      },
    };
    assert.equal(
      hintFor(json, "user"),
      "The explorer is limiting requests. Wait a few seconds, then try again.",
    );
  });

  it("says the explorer has not found the contract when Etherscan has not indexed it", () => {
    const [notIndexed] = everyCase().filter(
      (details) => details.code === "unexpected-response" && details.status === 200,
    );
    assert.ok(notIndexed);
    assert.equal(
      hintFor(errorOf(notIndexed), "user"),
      "The explorer has not found the contract at this address yet. Check the chain and the address; if the contract was deployed moments ago, try again in a minute.",
    );
    assert.equal(
      hintFor(errorOf(SAMPLE_DETAILS["unexpected-response"]), "user"),
      "The explorer gave an answer that could not be read. Try again later; if it keeps failing, check the explorer's status page.",
    );
  });

  it("tells a cancelled run with a handle to check the explorer before submitting again", () => {
    const accepted =
      "The verification was cancelled after the explorer accepted it. Check the contract's page on the explorer before you submit it again.";
    assert.equal(hintFor(errorOf(SAMPLE_DETAILS.cancelled), "user"), accepted);
    assert.equal(hintFor(errorOf({ code: "cancelled", handles: [HANDLE] }), "user"), accepted);
    assert.equal(
      hintFor(errorOf({ code: "cancelled", handles: [HANDLE] }).toJSON(), "user"),
      accepted,
    );
    const before = "The verification was cancelled before the explorer accepted it. Try again.";
    assert.equal(hintFor(errorOf({ code: "cancelled" }), "user"), before);
    // An empty list, a null or empty handle from a foreign copy: nothing was accepted.
    assert.equal(userHintOf({ details: { code: "cancelled", handles: [] } }), before);
    assert.equal(userHintOf({ details: { code: "cancelled", handle: null } }), before);
    assert.equal(userHintOf({ details: { code: "cancelled", handle: "" } }), before);
    assert.equal(userHintOf({ details: { code: "cancelled", handle: "ev1:x" } }), accepted);
  });

  it("never throws, and gives the general hint for a value it cannot read (D1)", () => {
    const general =
      "The verification failed. Try again later; if it keeps failing, report the error to the tool's maintainer.";
    const throwing = {
      get details(): unknown {
        throw new Error("getter");
      },
      get hint(): unknown {
        throw new Error("getter");
      },
    };
    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error("trap");
        },
      },
    );
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    for (const value of [
      null,
      undefined,
      "rate-limited",
      42,
      {},
      { details: null },
      { details: "rate-limited" },
      { details: {} },
      { details: { code: 7 } },
      throwing,
      proxy,
      revocable.proxy,
      { details: proxy },
    ]) {
      assert.equal(userHintOf(value), general);
      assert.equal(typeof userHintOf(value, "developer"), "string");
    }
    assert.equal(userHintOf({}, "developer"), general);
    assert.equal(userHintOf({ hint: 5 }, "developer"), general);
    assert.equal(userHintOf(throwing, "developer"), general);
    // A known code with a field that cannot be read keeps the code's own hint.
    assert.equal(
      userHintOf({ details: { code: "rate-limited", retryAfterMs: proxy } }),
      "The explorer is limiting requests. Wait a few seconds, then try again.",
    );
    assert.equal(
      userHintOf({ details: { code: "cancelled", handles: proxy } }),
      "The verification was cancelled before the explorer accepted it. Try again.",
    );
    assert.equal(
      userHintOf({ details: { code: "unexpected-response", excerpt: proxy } }),
      hintFor(errorOf(SAMPLE_DETAILS["unexpected-response"]), "user"),
    );
  });

  it("gives the general hint for a code that is a key of Object.prototype (D2)", () => {
    const general =
      "The verification failed. Try again later; if it keeps failing, report the error to the tool's maintainer.";
    for (const code of ["toString", "constructor", "hasOwnProperty", "__proto__", "valueOf"]) {
      assert.equal(userHintOf({ details: { code } }), general, code);
    }
  });

  it("gives the user hint for any audience other than developer", () => {
    const error = errorOf(SAMPLE_DETAILS.network);
    const user = hintFor(error, "user");
    assert.equal(userHintOf(error, "end-user"), user);
    assert.equal(userHintOf(error, undefined), user);
    assert.equal(userHintOf(error, "Developer"), user);
  });

  it("reads the not-indexed answer from the module the Etherscan-style client uses", () => {
    const etherscan = readFileSync(path.join(SRC, "backends/etherscan.ts"), "utf8");
    assert.match(etherscan, /import \{ NOT_INDEXED_ANSWER \} from "\.\.\/not-indexed\.ts";/);
    assert.doesNotMatch(codeOf(etherscan), /"Unable to locate ContractCode/);
    assert.equal(NOT_INDEXED_ANSWER, "Unable to locate ContractCode at");
  });

  it("gives a code this copy does not know a general user hint", () => {
    // A code from a newer copy, which no type of this copy allows.
    const details: ErrorDetails = { code: "internal-error" };
    Object.defineProperty(details, "code", { value: "from-a-newer-copy" });
    const foreign = { hint: "h", details };
    assert.equal(
      hintFor(foreign, "user"),
      "The verification failed. Try again later; if it keeps failing, report the error to the tool's maintainer.",
    );
    assert.equal(hintFor(foreign, "developer"), "h");
  });

  it("keeps every user hint to one or two sentences", () => {
    for (const details of everyCase()) {
      const hint = hintFor(errorOf(details), "user");
      const sentences = hint.split(/(?<=\.) /).length;
      assert.ok(sentences <= 2, `${details.code}: ${String(sentences)} sentences`);
      assert.match(hint, /^[A-Z].*\.$/, details.code);
    }
  });
});
