import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Logger } from "../../src/index.ts";
import {
  MIN_SECRET_LENGTH,
  REDACTED,
  REDACTION_PATTERNS,
  redact,
  redactExcerpt,
  redactingLogger,
} from "../../src/redact.ts";

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

// The fastest of three runs, so another test process on the same machine cannot fail the check.
function fastest(run: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let round = 0; round < 3; round++) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}
describe("redact: linear time on adversarial input (R-SEC-1)", () => {
  const adversarial: [string, string][] = [
    ["hex", `0x${"6080604052a1b2c3d4e5f6".repeat(MB / 22)}`],
    ["upper hex", "ABCDEF0123456789".repeat(MB / 16)],
    ["a", "a".repeat(MB)],
    ["https:// + x", `https://${"x".repeat(MB)}`],
    ["a://", "a://".repeat(MB / 4)],
    ["a.a", "a.".repeat(MB / 2)],
    ["&key=", "&key=".repeat(MB / 5)],
    ["&apikey", "&apikey".repeat(MB / 7)],
    ["apikey + spaces", `apikey${" ".repeat(MB)}`],
    ["%", "%".repeat(MB)],
    ["%26key%3D", "%26key%3D".repeat(MB / 9)],
    ["%2525", `%${"25".repeat(MB / 2)}`],
    ["bearer ", "bearer ".repeat(MB / 7)],
    ["bearer + spaces", `bearer${" ".repeat(MB)}`],
    ['"apikey":"', `"apikey":"${"x".repeat(MB)}`],
    ["\\n", String.raw`\n`.repeat(MB / 2)],
  ];

  it("runs every pattern on every 1 MB adversarial input in under 100 ms", () => {
    for (const { pattern, replacement } of REDACTION_PATTERNS) {
      for (const [name, text] of adversarial) {
        const took = fastest(() => text.replace(pattern, replacement));
        assert.ok(took < 100, `${pattern.source.slice(0, 40)} on ${name}: ${took.toFixed(0)} ms`);
      }
    }
  });

  const inputs: [string, string][] = [
    ["1 MB of hex", `0x${"6080604052a1b2c3d4e5f6".repeat(MB / 22)}`],
    ["1 MB of a", "a".repeat(MB)],
    ["https:// and 1 MB of x", `https://${"x".repeat(MB)}`],
  ];
  for (const [name, text] of inputs) {
    it(`redacts ${name} in under 100 ms`, () => {
      const took = fastest(() => redact(text, [DUMMY_KEY]));
      assert.ok(took < 100, `${took.toFixed(0)} ms`);
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

  it("keeps extra arguments, each redacted, and never throws on values that are not strings", () => {
    const { logger, seen } = recorder();
    const log = redactingLogger(logger, [DUMMY_KEY]);
    const hostile = {
      toJSON(): never {
        throw new Error(DUMMY_KEY);
      },
    };
    Reflect.apply(log.info, log, [
      "x",
      { url: `?apikey=${DUMMY_KEY}` },
      new TypeError(`fetch ${DUMMY_KEY}`),
      7,
      true,
      10n,
      Symbol(DUMMY_KEY),
      undefined,
      null,
      () => DUMMY_KEY,
      hostile,
      { toJSON: () => undefined },
    ]);
    assert.deepEqual(seen, [
      [
        "info",
        "x",
        `{"url":"?apikey=${R}"}`,
        `TypeError: fetch ${R}`,
        "7",
        "true",
        "10",
        `Symbol(${R})`,
        "undefined",
        "null",
        "function",
        "[unloggable]",
        "[unloggable]",
      ],
    ]);
    assert.ok(!JSON.stringify(seen).includes(DUMMY_KEY));
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
