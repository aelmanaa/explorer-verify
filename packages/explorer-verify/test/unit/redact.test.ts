import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Logger, LogValue } from "../../src/index.ts";
import {
  EXCERPT_MARGIN,
  MIN_SECRET_LENGTH,
  REDACTED,
  REDACTION_PATTERNS,
  redact,
  redactExcerpt,
  redactingLogger,
} from "../../src/redact.ts";
import { assertLinear } from "./linear.ts";

// Fake keys. Never real ones (R-SEC-1).
const DUMMY_KEY = "DUMMYKEY0123456789ABCDEFGHIJKLMNO";
const BARE_KEY = "FAKEKEY0REDACT0TEST00Z9Y8X7W6V5U4T";
const R = REDACTED;
const MB = 1 << 20;

describe("redact: known secrets (R-SEC-1)", () => {
  it("replaces every occurrence of a known secret", () => {
    assert.equal(redact(`a ${DUMMY_KEY} b ${DUMMY_KEY} c`, [DUMMY_KEY]), `a ${R} b ${R} c`);
  });

  it("replaces a known key anywhere, such as a URL path", () => {
    assert.equal(
      redact(`https://rpc.example/v2/${DUMMY_KEY}/x`, [DUMMY_KEY]),
      `https://rpc.example/v2/${R}/x`,
    );
  });

  it("replaces a known secret in any case", () => {
    assert.equal(redact(`lower ${DUMMY_KEY.toLowerCase()}`, [DUMMY_KEY]), `lower ${R}`);
  });

  it("replaces every occurrence of a secret that is not URL-safe, raw, URL-encoded and form-encoded", () => {
    const secret = "ab(c)d'e!f*g h.$1";
    const url = encodeURIComponent(secret);
    const form = new URLSearchParams({ s: secret }).toString().slice(2);
    assert.notEqual(url, form);
    assert.equal(
      redact(`${secret} | ${secret} | ${url} | ${url} | ${form} | ${form}`, [secret]),
      `${R} | ${R} | ${R} | ${R} | ${R} | ${R}`,
    );
  });

  it("replaces the longest secret first, so a shorter one cannot leave part of it", () => {
    assert.equal(redact("ABCDEFGHIJKLMNOP", ["ABCDEFGH", "ABCDEFGHIJKLMNOP"]), R);
  });

  it(`ignores secrets shorter than ${String(MIN_SECRET_LENGTH)} characters`, () => {
    assert.equal(MIN_SECRET_LENGTH, 8);
    assert.equal(redact("abc 1234567", ["", "abc", "1234567"]), "abc 1234567");
    assert.equal(redact("x 12345678 y", ["12345678"]), `x ${R} y`);
  });

  it("replaces a secret that cannot be URL-encoded (a lone surrogate) without throwing", () => {
    const lone = "abcd\uD800efgh";
    assert.equal(redact(`x ${lone} y`, [lone]), `x ${R} y`);
  });

  it("leaves text without secrets unchanged", () => {
    assert.equal(redact("nothing to hide"), "nothing to hide");
  });
});

describe("redact: key-like parameters (R-SEC-1, R-AX-9)", () => {
  it("replaces a key in a URL query string and keeps the other parameters", () => {
    assert.equal(
      redact(`https://api.example.org/v2/api?chainid=1&apikey=${DUMMY_KEY}&module=contract`),
      `https://api.example.org/v2/api?chainid=1&apikey=${R}&module=contract`,
    );
  });

  it("replaces a key in a form body", () => {
    assert.equal(
      redact(`module=contract&apikey=${DUMMY_KEY}&codeformat=solidity`),
      `module=contract&apikey=${R}&codeformat=solidity`,
    );
    assert.equal(redact(`apikey=${DUMMY_KEY}`), `apikey=${R}`);
  });

  it("replaces every occurrence of a parameter", () => {
    assert.equal(redact("?token=one&a=1&token=two"), `?token=${R}&a=1&token=${R}`);
  });

  it("replaces every name in the list, in any case", () => {
    const names = [
      "apikey",
      "APIKEY",
      "ApiKey",
      "api_key",
      "api-key",
      "x-api-key",
      "X-Api-Key",
      "key",
      "token",
      "access_token",
      "access-token",
      "refresh_token",
      "client_secret",
      "auth",
      "secret",
      "password",
    ];
    for (const name of names) {
      assert.equal(redact(`?a=1&${name}=v4lue&b=2`), `?a=1&${name}=${R}&b=2`, name);
    }
  });

  it("starts a name after a separator or a quote, never after a letter or digit", () => {
    assert.equal(redact(`a=1;apikey=${DUMMY_KEY}`), `a=1;apikey=${R}`);
    assert.equal(redact(`"apikey=${DUMMY_KEY}"`), `"apikey=${R}"`);
    assert.equal(redact(`'token=${DUMMY_KEY}'`), `'token=${R}'`);
    assert.equal(redact(`#apikey=${DUMMY_KEY}`), `#apikey=${R}`);
    const text = "https://x.example/?monkey=1&tokenizer=2&passkey=3&keyword=4&xtoken=5";
    assert.equal(redact(text), text);
  });

  it("starts a name after a JSON-escaped newline, carriage return or tab", () => {
    for (const escape of [String.raw`\n`, String.raw`\r`, String.raw`\t`]) {
      assert.equal(redact(`"line1${escape}apikey=${DUMMY_KEY}"`), `"line1${escape}apikey=${R}"`);
    }
  });

  it("replaces a key in a URL fragment", () => {
    assert.equal(
      redact(`https://x.example/page#apikey=${DUMMY_KEY}`),
      `https://x.example/page#apikey=${R}`,
    );
  });

  it("keeps the quote after a value", () => {
    assert.equal(
      redact(`{"url":"https://x.example/api?apikey=${DUMMY_KEY}"}`),
      `{"url":"https://x.example/api?apikey=${R}"}`,
    );
  });

  it("ends a value at #, ;, &, <, a quote, whitespace, a backslash and an encoded separator", () => {
    for (const end of [
      "#x",
      ";x",
      "&x",
      "<x",
      '"x',
      "'x",
      " x",
      "\\nx",
      "%26x",
      "%23x",
      "%3bx",
      "%22x",
      "%27x",
      "%20x",
      "%2526x",
    ]) {
      assert.equal(redact(`?apikey=${DUMMY_KEY}${end}`), `?apikey=${R}${end}`, end);
    }
  });

  it("continues a value through other percent escapes", () => {
    assert.equal(redact(`?apikey=AB%2FCD${DUMMY_KEY}&x=1`), `?apikey=${R}&x=1`);
    assert.equal(redact("?apikey=%&x=1"), `?apikey=${R}&x=1`);
  });

  it("replaces a parameter percent-encoded inside another URL, encoded once or twice", () => {
    const once = encodeURIComponent(`https://h/api?a=1&apikey=${DUMMY_KEY}`);
    const twice = encodeURIComponent(once);
    assert.equal(redact(`https://p/?u=${once}`).includes(DUMMY_KEY), false);
    assert.equal(redact(`https://p/?u=${twice}`).includes(DUMMY_KEY), false);
    assert.equal(redact(`x%26apikey%3D${DUMMY_KEY}%26y`), `x%26apikey%3D${R}%26y`);
    assert.equal(redact(`x%3Fapikey%3D${DUMMY_KEY}`), `x%3Fapikey%3D${R}`);
    assert.equal(redact(`x%2526token%253D${DUMMY_KEY}%2526y`), `x%2526token%253D${R}%2526y`);
  });

  it("accepts a colon and spaces after apikey, api_key, api-key and x-api-key only", () => {
    assert.equal(redact(`apikey: ${DUMMY_KEY}`), `apikey: ${R}`);
    assert.equal(redact(`?api_key = ${DUMMY_KEY}`), `?api_key = ${R}`);
    assert.equal(redact(`X-API-Key: ${DUMMY_KEY}`), `X-API-Key: ${R}`);
    assert.equal(redact("token: abc"), "token: abc");
  });

  it("leaves a name with no value or no = alone", () => {
    assert.equal(redact("apikey=&x=1"), "apikey=&x=1");
    assert.equal(redact("the apikey is missing"), "the apikey is missing");
  });
});

describe("redact: JSON members, URL user info and bearer tokens", () => {
  it("replaces a JSON apiKey member", () => {
    assert.equal(redact(`{"apiKey": "${DUMMY_KEY}"}`), `{"apiKey": "${R}"}`);
    assert.equal(redact(`{"api_key":"${DUMMY_KEY}","x":1}`), `{"api_key":"${R}","x":1}`);
    assert.equal(redact(`{"x-api-key" : "${DUMMY_KEY}"}`), `{"x-api-key" : "${R}"}`);
  });

  it("replaces every URL user name and password", () => {
    assert.equal(
      redact(`a https://user:${DUMMY_KEY}@api.example.org/ b wss://u:p@h.example/`),
      `a https://${R}@api.example.org/ b wss://${R}@h.example/`,
    );
    assert.equal(redact("HTTP://only-user@host.example/"), `HTTP://${R}@host.example/`);
  });

  it("leaves an @ outside URL user info alone", () => {
    for (const text of ["/users/me@host", "file:///home/user@host/a.sol", "mailto:me@host"]) {
      assert.equal(redact(text), text);
    }
  });

  it("replaces every bearer token", () => {
    assert.equal(
      redact(`Authorization: Bearer ${DUMMY_KEY}, then bearer abcdefgh.ijk`),
      `Authorization: Bearer ${R}, then bearer ${R}`,
    );
  });

  it("leaves bearer followed by a word that is not a token alone", () => {
    for (const text of ["bearer of bad news", "xbearer abcdefghijk", "Bearer short"]) {
      assert.equal(redact(text), text);
    }
  });
});

describe("redact: bare Etherscan-style keys", () => {
  it("replaces a bare 34-character key of upper-case letters and digits", () => {
    assert.equal(redact(`Invalid API Key ${BARE_KEY} rejected`), `Invalid API Key ${R} rejected`);
    assert.equal(redact(`(${BARE_KEY})`), `(${R})`);
  });

  it("leaves addresses, hashes, guids and runs of other lengths alone", () => {
    const keep = [
      "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      "0xDEADBEEF00000000000000000000000000000000",
      `0x${"ab12".repeat(16)}`,
      `0x${"AB12".repeat(16)}`,
      "ezq878u486pzijkvvmerl6a9mzwhv6sefgvqi5tkwceejc7tvn",
      "550e8400-e29b-41d4-a716-446655440000",
      "A".repeat(34),
      "1".repeat(34),
      `${BARE_KEY}X`,
      BARE_KEY.slice(1),
      `x${BARE_KEY}`,
      `${BARE_KEY}x`,
    ];
    for (const text of keep) {
      assert.equal(redact(text), text, text);
    }
  });
});

describe("redact: linear time on adversarial input (R-SEC-1)", () => {
  // Each input, built at a given size. Linear code takes about 16 times as long on 1 MB as on
  // 64 KB; quadratic code takes about 256 times as long.
  const adversarial: [string, (size: number) => string][] = [
    ["hex", (size) => `0x${"6080604052a1b2c3d4e5f6".repeat(size / 22)}`],
    ["upper hex", (size) => "ABCDEF0123456789".repeat(size / 16)],
    ["a", (size) => "a".repeat(size)],
    ["https:// + x", (size) => `https://${"x".repeat(size)}`],
    ["a://", (size) => "a://".repeat(size / 4)],
    ["a.a", (size) => "a.".repeat(size / 2)],
    ["&key=", (size) => "&key=".repeat(size / 5)],
    ["&apikey", (size) => "&apikey".repeat(size / 7)],
    ["apikey + spaces", (size) => `apikey${" ".repeat(size)}`],
    ["%", (size) => "%".repeat(size)],
    ["%26key%3D", (size) => "%26key%3D".repeat(size / 9)],
    ["%2525", (size) => `%${"25".repeat(size / 2)}`],
    ["bearer ", (size) => "bearer ".repeat(size / 7)],
    ["bearer + spaces", (size) => `bearer${" ".repeat(size)}`],
    ['"apikey":"', (size) => `"apikey":"${"x".repeat(size)}`],
    ["\\n", (size) => String.raw`\n`.repeat(size / 2)],
    ["@ lines", (size) => `${"@".repeat(998)}\n`.repeat(size / 999)],
    // One line that grows with the size, of each character a pattern starts at, stops at or
    // repeats. Work quadratic in the line length shows here, not in short lines.
    ...[
      "@",
      ":",
      "/",
      "=",
      "%",
      "&",
      "#",
      "?",
      ";",
      ".",
      "+",
      "-",
      "_",
      '"',
      "'",
      "\\",
      " ",
      "\t",
      "<",
      ">",
    ].map((char): [string, (size: number) => string] => [
      `one line of ${JSON.stringify(char)}`,
      (size) => char.repeat(size),
    ]),
    ['"apikey":" + backslashes', (size) => `"apikey":"${"\\".repeat(size)}`],
  ];

  // One test per pattern, so each has its own time budget.
  for (const [index, { pattern, replacement }] of REDACTION_PATTERNS.entries()) {
    it(`runs pattern ${String(index)} in linear time on every adversarial input (R-SEC-1)`, () => {
      for (const [name, make] of adversarial) {
        assertLinear(`pattern ${String(index)} on ${name}`, make, (text) =>
          text.replace(pattern, replacement),
        );
      }
    });
  }

  const inputs: [string, (size: number) => string][] = [
    ["hex", (size) => `0x${"6080604052a1b2c3d4e5f6".repeat(size / 22)}`],
    ["a", (size) => "a".repeat(size)],
    ["https:// and x", (size) => `https://${"x".repeat(size)}`],
  ];
  for (const [name, make] of inputs) {
    it(`redacts ${name} in linear time`, () => {
      assertLinear(name, make, (text) => redact(text, [DUMMY_KEY]));
    });
  }
});

describe("redactExcerpt", () => {
  it("redacts a short text, then cuts it", () => {
    assert.equal(redactExcerpt(`ok ${DUMMY_KEY} and more`, [DUMMY_KEY], 8), "ok [reda");
  });

  it("redacts only a window of a long text and drops the window's tail", () => {
    const text = `${"x".repeat(290)}${DUMMY_KEY}${"y".repeat(MB)}`;
    assert.equal(redactExcerpt(text, [DUMMY_KEY], 300), `${"x".repeat(290)}${R}`);
  });

  it("returns an empty excerpt when redaction shrinks the window below its tail", () => {
    // The window holds 3 whole secrets and part of a 4th; the part must not show.
    const secret = "S".repeat(100);
    assert.equal(redactExcerpt(secret.repeat(10) + "z".repeat(1000), [secret], 10), "");
    const longer = redactExcerpt(secret.repeat(4) + "z".repeat(1000), [secret], 300);
    assert.equal(longer, `${R.repeat(4)}${"z".repeat(260)}`);
  });
});

/** A logger that records every call. */
function recorder(): { logger: Logger; seen: unknown[][] } {
  const seen: unknown[][] = [];
  const record =
    (level: string) =>
    (...args: unknown[]): void => {
      seen.push([level, ...args]);
    };
  return {
    seen,
    logger: {
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    },
  };
}

/**
 * A logger method declared as `void`, as `Logger` declares it, whose body returns a rejected
 * promise, as an async method does.
 */
function rejectingMethod(text: string): (message: string) => void {
  function method(message: string): void;
  function method(): unknown {
    return Promise.reject(new Error(text));
  }
  return method;
}

describe("redact: a known key echoed in a JSON body (R-SEC-1)", () => {
  // Fake keys that JSON escapes: a backslash, or a double quote.
  const keys = ["ab\\cd`ef{g}|h^", 'quote"key12345'];

  for (const key of keys) {
    it(`redacts ${JSON.stringify(key)} JSON-escaped in a message`, () => {
      const escaped = JSON.stringify(key).slice(1, -1);
      assert.notEqual(escaped, key);
      const body = JSON.stringify({ message: `Invalid API key ${key}` });
      assert.equal(redact(body, [key]), `{"message":"Invalid API key ${R}"}`);
    });

    it(`redacts ${JSON.stringify(key)} whole in a JSON apikey member, known or not`, () => {
      const body = JSON.stringify({ apikey: key, x: 1 });
      assert.equal(redact(body), `{"apikey":"${R}","x":1}`);
      assert.equal(redact(body, [key]), `{"apikey":"${R}","x":1}`);
    });
  }

  it("redacts a JSON-escaped key in an excerpt without showing part of it", () => {
    const key = 'quote"key12345';
    const body = JSON.stringify({ message: "x".repeat(280) + key + "y".repeat(2_000) });
    assert.doesNotMatch(redactExcerpt(body, [key], 300), /quote|key12345/);
  });

  it("ends a JSON apikey member at its closing quote, after any escape", () => {
    assert.equal(
      redact(String.raw`{"apiKey":"a\"b\\","next":"kept"}`),
      `{"apiKey":"${R}","next":"kept"}`,
    );
    assert.equal(redact('{"apiKey":"a\\u0041b","n":1}'), `{"apiKey":"${R}","n":1}`);
    // A backslash before a raw newline, which a JSON parser rejects but an explorer may send.
    assert.equal(redact('{"apiKey":"a\\\nb","n":1}'), `{"apiKey":"${R}","n":1}`);
  });

  it("redacts an empty JSON apikey member value", () => {
    assert.equal(redact('{"apiKey":"","n":1}'), `{"apiKey":"${R}","n":1}`);
  });

  it("runs a JSON apikey member value through 1024 escape sequences, not 1025", () => {
    const escapes = '\\"'.repeat(1_024);
    assert.equal(redact(`{"apiKey":"${escapes}"}`), `{"apiKey":"${R}"}`);
    assert.equal(redact(`{"apiKey":"${escapes}\\""}`), `{"apiKey":"${R}\\""}`);
  });

  it("redacts an 8 MB JSON apikey member value without a stack overflow", () => {
    // 8 MB is the smallest power of two at which a value pattern with one repetition per
    // character, `(?:[^"\\]|\\[^])*`, threw a RangeError on Node 24.
    const value = "a".repeat(8 << 20);
    assert.equal(redact(`{"apiKey":"${value}","n":1}`), `{"apiKey":"${R}","n":1}`);
  });

  for (const key of keys) {
    it(`redacts ${JSON.stringify(key)} JSON-escaped twice, in a JSON text inside another`, () => {
      const body = JSON.stringify({ inner: JSON.stringify({ message: key }) });
      assert.equal(redact(body, [key]), JSON.stringify({ inner: JSON.stringify({ message: R }) }));
    });

    it(`redacts ${JSON.stringify(key)} with each character but letters and digits as \\uXXXX`, () => {
      for (const hex of [(code: string) => code, (code: string) => code.toUpperCase()]) {
        const escaped = key.replaceAll(
          /[^A-Za-z0-9]/g,
          (char) => `\\u${hex(char.charCodeAt(0).toString(16).padStart(4, "0"))}`,
        );
        assert.notEqual(escaped, key);
        assert.equal(redact(`{"message":"bad ${escaped}"}`, [key]), `{"message":"bad ${R}"}`);
      }
    });
  }

  it("redacts a key with a lone surrogate in the JSON form JSON.stringify gives it", () => {
    // The `-` keeps the JSON form apart from the \uXXXX form, which would also match.
    const lone = "abcd\uD800ef-gh";
    const body = JSON.stringify({ message: lone });
    assert.equal(body, String.raw`{"message":"abcd\ud800ef-gh"}`);
    assert.equal(redact(body, [lone]), `{"message":"${R}"}`);
  });
});

describe("redact: a known key encoded twice (R-SEC-1)", () => {
  it("redacts a key that was URL-encoded twice, as in a URL inside another URL's parameter", () => {
    const key = "dummy key/with+marks=1";
    const twice = encodeURIComponent(encodeURIComponent(key));
    assert.notEqual(twice, encodeURIComponent(key));
    assert.equal(redact(`next=${twice}&x=1`, [key]), `next=${R}&x=1`);
  });
});

describe("redactingLogger: key-named fields (R-SEC-1, R-DX-5)", () => {
  it("replaces a string value whole when the field name is a key name, even when the key is unknown", () => {
    const { logger, seen } = recorder();
    redactingLogger(logger).info("x", {
      apikey: "unknown-value-1",
      "X-Api-Key": "unknown-value-2",
      access_token: "unknown-value-3",
      password: "hunter2",
      key: "k",
      attempt: 2,
      apikeys: "kept: not a key name",
    });
    assert.deepEqual(seen, [
      [
        "info",
        "x",
        {
          apikey: R,
          "X-Api-Key": R,
          access_token: R,
          password: R,
          key: R,
          attempt: 2,
          apikeys: "kept: not a key name",
        },
      ],
    ]);
  });
});

describe("redactingLogger: async methods (decision 0010)", () => {
  it("catches a rejected promise from an async logger method", async (t) => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    t.after(() => {
      process.off("unhandledRejection", listener);
    });
    const rejecting = rejectingMethod("async logger");
    const log = redactingLogger({
      debug: rejecting,
      info: rejecting,
      warn: rejecting,
      error: rejecting,
    });
    assert.doesNotThrow(() => {
      log.warn("x", { a: 1 });
      log.error("y");
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.deepEqual(unhandled, []);
  });
});

describe("redactingLogger (R-SEC-1)", () => {
  it("redacts every message before it reaches each of the four methods", () => {
    const { logger, seen } = recorder();
    const log = redactingLogger(logger, [DUMMY_KEY]);
    log.debug(`GET https://x.example/api?apikey=${DUMMY_KEY}`);
    log.info(`key ${DUMMY_KEY}`);
    log.warn("retry token=abc");
    log.error(`https://u:${DUMMY_KEY}@x.example/`);
    assert.deepEqual(seen, [
      ["debug", `GET https://x.example/api?apikey=${R}`],
      ["info", `key ${R}`],
      ["warn", `retry token=${R}`],
      ["error", `https://${R}@x.example/`],
    ]);
  });

  it("redacts unknown apikey values with no secrets given", () => {
    const { logger, seen } = recorder();
    redactingLogger(logger).debug("?apikey=zzz");
    assert.deepEqual(seen, [["debug", `?apikey=${R}`]]);
  });

  it("redacts every field name and string value, and keeps numbers, booleans and null (R-DX-5)", () => {
    const { logger, seen } = recorder();
    const log = redactingLogger(logger, [DUMMY_KEY]);
    log.warn(`retry ${DUMMY_KEY}`, {
      url: `https://x.example/api?apikey=${DUMMY_KEY}`,
      [`k-${DUMMY_KEY}`]: "name",
      attempt: 2,
      final: false,
      status: null,
      plain: "sourcify",
    });
    assert.deepEqual(seen, [
      [
        "warn",
        `retry ${R}`,
        {
          url: `https://x.example/api?apikey=${R}`,
          [`k-${R}`]: "name",
          attempt: 2,
          final: false,
          status: null,
          plain: "sourcify",
        },
      ],
    ]);
    assert.ok(!JSON.stringify(seen).includes(DUMMY_KEY));
  });

  it("passes no second argument when there are no fields, so console prints no `undefined`", () => {
    const { logger, seen } = recorder();
    redactingLogger(logger).info("x");
    redactingLogger(logger).info("y", {});
    assert.deepEqual(seen, [
      ["info", "x"],
      ["info", "y", {}],
    ]);
  });

  it("passes a new fields object, and a `__proto__` field stays an own field", () => {
    const { logger, seen } = recorder();
    const fields: Record<string, LogValue> = Object.fromEntries([["__proto__", "p"]]);
    redactingLogger(logger).debug("x", fields);
    const passed = seen[0]?.[2];
    assert.notEqual(passed, fields);
    assert.deepEqual(Object.entries(passed ?? {}), [["__proto__", "p"]]);
    assert.equal(Object.getPrototypeOf(passed), Object.prototype);
  });

  it("turns a field value that is not flat into redacted text, and never throws on it", () => {
    const { logger, seen } = recorder();
    const log = redactingLogger(logger, [DUMMY_KEY]);
    const hostile = {
      toJSON(): never {
        throw new Error(DUMMY_KEY);
      },
    };
    const values: unknown[] = [
      { url: `?apikey=${DUMMY_KEY}` },
      new TypeError(`fetch ${DUMMY_KEY}`),
      10n,
      Symbol(DUMMY_KEY),
      undefined,
      () => DUMMY_KEY,
      hostile,
      { toJSON: () => undefined },
    ];
    // A JavaScript caller can pass any value; the entries mimic that without a cast.
    Reflect.apply(log.info, log, ["x", Object.fromEntries(values.map((v, i) => [`f${i}`, v]))]);
    // The same for a message that is not a string.
    Reflect.apply(log.debug, log, [null]);
    Reflect.apply(log.debug, log, [7]);
    assert.deepEqual(seen, [
      [
        "info",
        "x",
        {
          f0: `{"url":"?apikey=${R}"}`,
          f1: `TypeError: fetch ${R}`,
          f2: "10",
          f3: `Symbol(${R})`,
          f4: "undefined",
          f5: "function",
          f6: "[unloggable]",
          f7: "[unloggable]",
        },
      ],
      ["debug", "null"],
      ["debug", "7"],
    ]);
    assert.ok(!JSON.stringify(seen).includes(DUMMY_KEY));
  });

  it("never throws when the caller's logger throws, lacks a method or gets unreadable fields (decision 0010)", () => {
    const throwing: Logger = {
      debug: () => {
        throw new Error(DUMMY_KEY);
      },
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };
    assert.doesNotThrow(() => {
      redactingLogger(throwing, [DUMMY_KEY]).debug("x", { a: 1 });
    });
    // A JavaScript caller may pass a logger with a missing method.
    const partial: Logger = { ...throwing };
    const wrapped = redactingLogger(partial);
    Reflect.deleteProperty(partial, "warn");
    assert.doesNotThrow(() => {
      wrapped.warn("x");
    });
    const { logger, seen } = recorder();
    const unreadable = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error(DUMMY_KEY);
        },
      },
    );
    assert.doesNotThrow(() => {
      redactingLogger(logger, [DUMMY_KEY]).error("x", unreadable);
    });
    assert.deepEqual(seen, []);
  });

  it("calls the caller's method with the logger as this", () => {
    let boundToLogger = false;
    const logger: Logger = {
      debug() {
        boundToLogger = this === logger;
      },
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };
    redactingLogger(logger).debug("x");
    assert.equal(boundToLogger, true);
  });
});

describe("redactExcerpt: window bounds (R-SEC-1)", () => {
  it("never shows part of a long URL password cut at the window end", () => {
    for (let pad = 0; pad <= 727; pad++) {
      const text = `${`${BARE_KEY} `.repeat(17)}${"z".repeat(pad)} https://u:${"p".repeat(200)}@h.example/`;
      const out = redactExcerpt(text, [], 300);
      assert.doesNotMatch(out, /pppp/, `pad ${String(pad)}`);
    }
  });

  it("never shows part of a bare key cut at the window end", () => {
    const out = redactExcerpt(`${BARE_KEY} `.repeat(100), [], 300);
    assert.doesNotMatch(out, /[A-Z0-9]{4,}/);
  });

  it("never shows part of a long known secret cut at the window end", () => {
    const secret = "S".repeat(200);
    assert.equal(redactExcerpt(secret.repeat(10), [secret], 10), "");
    // A secret longer than the margin: the tail must grow with it.
    const longer = "S".repeat(400);
    assert.doesNotMatch(redactExcerpt(longer.repeat(10), [longer], 300), /S/);
  });

  it("gives an empty excerpt, not the start of the text, when the cut is negative", () => {
    const secret = "S".repeat(100);
    for (let pad = 0; pad < 400; pad++) {
      const out = redactExcerpt("z".repeat(pad) + secret.repeat(10), [secret], 10);
      assert.doesNotMatch(out, /S/, String(pad));
    }
  });

  it("never shows part of a URL-encoded non-ASCII secret cut at the window end", () => {
    const secret = "€€€€€€€€";
    assert.equal(encodeURIComponent(secret).length, 72);
    const out = redactExcerpt(encodeURIComponent(secret).repeat(40), [secret], 10);
    assert.doesNotMatch(out, /%E2/);
  });
});

describe("redact: known secrets in any case, Unicode included (R-SEC-1)", () => {
  it("replaces a secret whose upper-case and lower-case forms differ in length or letter", () => {
    assert.equal(redact("x ABCDEFGΣX y", ["ABCDEFGΣ"]), `x ${R}X y`);
    assert.equal(redact("x abcdefgς y", ["ABCDEFGΣ"]), `x ${R} y`);
  });

  it("matches regex metacharacters in a known secret only as themselves", () => {
    assert.equal(redact("abcXdefgh abc.defgh", ["abc.defgh"]), `abcXdefgh ${R}`);
    // Unescaped, `b{2}` would be a quantifier and match `bb`.
    assert.equal(redact("abbcdefgh ab{2}cdefgh", ["ab{2}cdefgh"]), `abbcdefgh ${R}`);
  });
});

describe("redact: pattern bounds", () => {
  it("redacts a bearer token after a tab", () => {
    assert.equal(redact("Bearer\tabcdefgh12"), `Bearer\t${R}`);
  });

  it("accepts up to 16 spaces around the colon after apikey, not 17", () => {
    const s16 = " ".repeat(16);
    assert.equal(redact(`apikey${s16}:${s16}v4lue1`), `apikey${s16}:${s16}${R}`);
    const s17 = " ".repeat(17);
    assert.equal(redact(`apikey${s17}: v4lue1`), `apikey${s17}: v4lue1`);
  });

  it("accepts up to 16 spaces around the colon of a JSON apiKey member", () => {
    const s16 = " ".repeat(16);
    assert.equal(redact(`{"apiKey"${s16}:${s16}"v4lue1"}`), `{"apiKey"${s16}:${s16}"${R}"}`);
  });

  it("accepts a URL scheme of up to 32 characters, not 33", () => {
    const scheme = `a${"b".repeat(31)}`;
    assert.equal(redact(`${scheme}://u:p@h`), `${scheme}://${R}@h`);
    const longer = `a${"b".repeat(32)}`;
    assert.equal(redact(`${longer}://u:p@h`), `${longer}://u:p@h`);
  });

  it("accepts URL user info of up to 256 characters, not 257", () => {
    const userinfo = "u".repeat(256);
    assert.equal(redact(`https://${userinfo}@h`), `https://${R}@h`);
    const longer = "u".repeat(257);
    assert.equal(redact(`https://${longer}@h`), `https://${longer}@h`);
  });

  it("redacts a bearer token of 8 characters after 16 spaces, and keeps one of 7", () => {
    assert.equal(redact(`bearer${" ".repeat(16)}abcdefgh`), `bearer${" ".repeat(16)}${R}`);
    assert.equal(redact("Bearer abcdefgh"), `Bearer ${R}`);
    assert.equal(redact("Bearer abcdefg"), "Bearer abcdefg");
  });

  it("redacts a bare key whose only letter or only digit is last", () => {
    assert.equal(redact(`${"1".repeat(33)}A`), R);
    assert.equal(redact(`${"A".repeat(33)}1`), R);
  });

  it("redacts every apikey parameter, JSON member and bare key", () => {
    assert.equal(redact("apikey=v4lue1&apikey=v4lue2"), `apikey=${R}&apikey=${R}`);
    assert.equal(
      redact('{"apiKey":"v1","b":{"apiKey":"v2"}}'),
      `{"apiKey":"${R}","b":{"apiKey":"${R}"}}`,
    );
    assert.equal(redact(`${BARE_KEY} ${BARE_KEY}`), `${R} ${R}`);
  });
});

describe("redactExcerpt: window size", () => {
  it("covers URL user info, the longest bounded pattern span", () => {
    assert.equal(EXCERPT_MARGIN, 32 + "://".length + 256 + "@".length);
  });

  it("redacts a text exactly as long as the window whole, without dropping a tail", () => {
    const window = 2 * (300 + EXCERPT_MARGIN);
    // Redaction shrinks the window below 300 plus the tail, so dropping a tail would show.
    const start = `${BARE_KEY} `.repeat(33);
    const text = start + "z".repeat(window - start.length);
    assert.equal(text.length, window);
    const whole = redact(text);
    assert.ok(whole.length - EXCERPT_MARGIN < 300);
    assert.equal(redactExcerpt(text, [], 300), whole.slice(0, 300));
    const longer = `${text}z`;
    assert.equal(redactExcerpt(longer, [], 300), whole.slice(0, whole.length - EXCERPT_MARGIN));
  });
});
