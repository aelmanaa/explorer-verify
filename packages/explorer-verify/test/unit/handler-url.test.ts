// `VerifyOptions.handlerUrl` (R-SRV-5, decision 0046): the check of the value, which routes go to
// the handler, the URL a request is sent to, and the option checks in settingsOf (R-SEC-1,
// R-SEC-2).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Answer } from "../../src/backends/common.ts";
import { newError } from "../../src/error-hints.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import { DEFAULT_DEPENDENCIES } from "../../src/flow/defaults.ts";
import { settingsOf, startBudget, withHandler } from "../../src/flow/verify.ts";
import {
  checkHandlerUrl,
  resolveHandler,
  sentUrl,
  throughHandler,
} from "../../src/http/handler-url.ts";
import type { VerifyOptions } from "../../src/types.ts";
import { onPage } from "../helpers/page.ts";
import { resolveRoute } from "../helpers/route.ts";

const ETHERSCAN = "https://api.etherscan.io/v2/api";
const ORIGIN = "https://api.etherscan.io";
const HANDLER = "https://dapp.example/api/verify";
const SEPOLIA = 11155111;
// Fake keys. Never real ones (R-SEC-1).
const ETHERSCAN_KEY = "DUMMYETHERSCANKEYhandler7w3e9r1";
const ROUTESCAN_KEY = "dummy-routescan-key-handler-4k8m";

function fieldsOf(error: ExplorerVerifyError): string[] {
  return error.details.code === "invalid-input"
    ? error.details.issues.map((issue) => issue.field)
    : [];
}

describe("checkHandlerUrl (decision 0046)", () => {
  it("resolves a path against the page, and normalises an absolute URL", (t) => {
    onPage(t, "https://page.example.com/app/");
    const cases: [string, string][] = [
      ["/api/verify", "https://page.example.com/api/verify"],
      ["/", "https://page.example.com/"],
      ["/%2F/evil.com", "https://page.example.com/%2F/evil.com"],
      [HANDLER, HANDLER],
      ["HTTPS://My.Example.ORG/api", "https://my.example.org/api"],
      ["http://localhost:3000/api/verify", "http://localhost:3000/api/verify"],
      ["http://LOCALHOST/api", "http://localhost/api"],
      ["http://127.0.0.1:8080/api/verify", "http://127.0.0.1:8080/api/verify"],
      ["http://[::1]:8080/api/verify", "http://[::1]:8080/api/verify"],
    ];
    for (const [value, url] of cases) {
      assert.deepEqual(checkHandlerUrl(value, ORIGIN), { url }, value);
    }
  });

  it("takes the page's http scheme for a path on a development server", (t) => {
    onPage(t, "http://192.168.1.20:5173/");
    assert.deepEqual(checkHandlerUrl("/api/verify", ORIGIN), {
      url: "http://192.168.1.20:5173/api/verify",
    });
  });

  it("refuses a path outside a browser page", () => {
    const checked = checkHandlerUrl("/api/verify", ORIGIN);
    assert.ok(typeof checked === "string");
    assert.match(checked, /needs a browser page/);
  });

  it("refuses every value that could reach another host or lose its query (R-SEC-2)", (t) => {
    onPage(t, "https://page.example.com/app/");
    const cases: [string, RegExp][] = [
      [`https://my.example.org/${"a".repeat(2048)}`, /at most 2048 characters/],
      // Whitespace, control characters and backslashes, which a URL parser drops or rewrites.
      ["/\t/evil.com", /whitespace/],
      ["/\n/evil.com", /whitespace/],
      ["/\r/evil.com", /whitespace/],
      ["/\t\\evil.com", /whitespace/],
      ["/\u000b/evil.com", /whitespace/],
      ["/\f/evil.com", /whitespace/],
      ["/ /evil.com", /whitespace/],
      ["/　/evil.com", /whitespace/],
      ["/ /evil.com", /whitespace/],
      ["/\u0000/evil.com", /whitespace/],
      ["/\u007f/evil.com", /whitespace/],
      [" /api", /whitespace/],
      ["/api ", /whitespace/],
      ["/a pi", /whitespace/],
      ["https://my.example.org/api\t", /whitespace/],
      ["https://my.example.org/a\tpi", /whitespace/],
      ["http://local\nhost/api", /whitespace/],
      ["https://evil.com\\@my.example.org/", /whitespace/],
      ["/\\evil.com", /whitespace/],
      ["https:\\\\my.example.org/api", /whitespace/],
      // A query or a fragment.
      ["/api?x=1", /query or a fragment/],
      ["/api#f", /query or a fragment/],
      ["https://my.example.org/api?", /query or a fragment/],
      ["https://my.example.org/api#", /query or a fragment/],
      // Not a path and not an absolute https:// or http:// URL.
      ["", /must be a path/],
      ["//evil.com/api", /must be a path/],
      ["api/verify", /must be a path/],
      ["./api", /must be a path/],
      ["https:my.example.org/api", /must be a path/],
      ["https:/my.example.org/api", /must be a path/],
      ["javascript:alert(1)", /must be a path/],
      ["data:text/plain,hi", /must be a path/],
      ["ftp://my.example.org/", /must be a path/],
      ["ws://localhost/", /must be a path/],
      ["https://", /must be a path/],
      // http only on loopback.
      ["http://my.example.org/api", /must use https/],
      ["http://localhost.evil.com/api", /must use https/],
      ["http://0.0.0.0/api", /must use https/],
      // Credentials.
      ["https://user:pw@my.example.org/api", /user name or password/],
      ["https://user@my.example.org/api", /user name or password/],
      // Etherscan's own host, whatever its case, port, trailing dot or spelling.
      [ETHERSCAN, /not Etherscan's API/],
      ["https://API.ETHERSCAN.IO/v2/api", /not Etherscan's API/],
      ["https://api.etherscan.io./v2/api", /not Etherscan's API/],
      ["https://api.etherscan.io。/v2/api", /not Etherscan's API/],
      ["https://api.etherscan.io.:443/v2/api", /not Etherscan's API/],
      ["https://api.etherscan.io:8443/v2/api", /not Etherscan's API/],
      ["https://api.etherscan.io.%2E/x", /not Etherscan's API/],
      ["https://api%2Eetherscan.io/v2/api", /not Etherscan's API/],
      ["https://ａｐｉ.etherscan.io/v2/api", /not Etherscan's API/],
      ["http://api.etherscan.io/v2/api", /must use https/],
    ];
    for (const [value, message] of cases) {
      const checked = checkHandlerUrl(value, ORIGIN);
      assert.ok(typeof checked === "string", JSON.stringify(value));
      assert.match(checked, message, JSON.stringify(value));
    }
  });
});

describe("throughHandler (decision 0046)", () => {
  it("is true only for an etherscan-v2 route on Etherscan's own API, with handlerUrl set", () => {
    const etherscan = resolveRoute(SEPOLIA, { backend: "etherscan-v2" });
    assert.equal(throughHandler(etherscan, HANDLER, ORIGIN), true);
    assert.equal(throughHandler(etherscan, undefined, ORIGIN), false);
    assert.equal(
      throughHandler(resolveRoute(SEPOLIA, { backend: "sourcify" }), HANDLER, ORIGIN),
      false,
    );
    const moved = resolveRoute(SEPOLIA, {
      backend: "etherscan-v2",
      apiUrl: "https://proxy.example.org/v2/api",
    });
    assert.equal(throughHandler(moved, HANDLER, ORIGIN), false);
  });
});

describe("sentUrl (R-SRV-5, R-SEC-2, decision 0046)", () => {
  it("sends an Etherscan request to the handler with its query", () => {
    assert.equal(sentUrl(`${ETHERSCAN}?chainid=1`, HANDLER, ORIGIN), `${HANDLER}?chainid=1`);
    assert.equal(sentUrl(ETHERSCAN, HANDLER, ORIGIN), HANDLER);
  });

  it("sends any other request unchanged, never to the handler", () => {
    const sourcify = "https://sourcify.dev/server/v2/contract/1/0x00";
    assert.equal(sentUrl(sourcify, HANDLER, ORIGIN), sourcify);
    const lookalike = "https://api.etherscan.io.attacker.example/v2/api?chainid=1";
    assert.equal(sentUrl(lookalike, HANDLER, ORIGIN), lookalike);
    assert.equal(sentUrl("not a url", HANDLER, ORIGIN), "not a url");
    assert.equal(sentUrl(`${ETHERSCAN}?chainid=1`, undefined, ORIGIN), `${ETHERSCAN}?chainid=1`);
  });
});

async function resolved(handlerUrl: string): Promise<string | undefined> {
  const settings = settingsOf({ handlerUrl });
  return (await withHandler(settings, startBudget(settings), DEFAULT_DEPENDENCIES.handler)).handler
    ?.url;
}

async function refused(
  handlerUrl: string,
  apiKeys: VerifyOptions["apiKeys"] = {},
): Promise<ExplorerVerifyError> {
  const settings = settingsOf({ handlerUrl, apiKeys });
  const outcome = await withHandler(
    settings,
    startBudget(settings),
    DEFAULT_DEPENDENCIES.handler,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(outcome instanceof ExplorerVerifyError, String(outcome));
  return outcome;
}

describe("settingsOf and withHandler: handlerUrl (decision 0046, R-SEC-1)", () => {
  it("keeps the raw value, and withHandler loads the check and normalises it", async (t) => {
    onPage(t);
    assert.equal(settingsOf({ handlerUrl: "/api/verify" }).handlerUrl, "/api/verify");
    assert.equal(settingsOf({ handlerUrl: "/api/verify" }).handler, undefined);
    assert.equal(await resolved("/api/verify"), HANDLER);
    assert.equal(settingsOf({ handlerUrl: undefined }).handlerUrl, undefined);
    assert.equal(settingsOf({}).handlerUrl, undefined);
    assert.equal(settingsOf(undefined).handlerUrl, undefined);
    // Without handlerUrl, withHandler loads nothing and returns the settings as they are.
    const plain = settingsOf({});
    assert.equal(await withHandler(plain, startBudget(plain), DEFAULT_DEPENDENCIES.handler), plain);
  });

  it("refuses a value that is not a string", async () => {
    for (const value of [42, null, new URL(HANDLER)]) {
      // As a JavaScript caller passes it: the type refuses it.
      const settings: unknown = Reflect.apply(settingsOf, undefined, [{ handlerUrl: value }]);
      assert.ok(typeof settings === "object" && settings !== null);
      const read = settingsOf({});
      const loose = { ...read, handlerUrl: Reflect.get(settings, "handlerUrl") };
      const outcome = await withHandler(
        loose,
        startBudget(read),
        DEFAULT_DEPENDENCIES.handler,
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      assert.ok(outcome instanceof ExplorerVerifyError);
      assert.deepEqual(fieldsOf(outcome), ["handlerUrl"]);
    }
  });

  it("refuses a bad handlerUrl with invalid-input naming the field, without the value", async () => {
    const error = await refused("//other.example/api");
    assert.deepEqual(fieldsOf(error), ["handlerUrl"]);
    assert.ok(!JSON.stringify(error.toJSON()).includes("other.example"));
    // Outside a browser page, a path throws too.
    assert.deepEqual(fieldsOf(await refused("/api/verify")), ["handlerUrl"]);
  });

  it("refuses a path when reading location throws, with invalid-input (R3)", async (t) => {
    const before = Object.getOwnPropertyDescriptor(globalThis, "location");
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      get: () => {
        throw new Error("location is not available");
      },
    });
    t.after(() => {
      if (before === undefined) {
        Reflect.deleteProperty(globalThis, "location");
      } else {
        Object.defineProperty(globalThis, "location", before);
      }
    });
    const error = await refused("/api/verify");
    assert.deepEqual(fieldsOf(error), ["handlerUrl"]);
    assert.doesNotMatch(error.message, /location is not available/);
  });

  it("refuses an Etherscan key next to handlerUrl, without repeating the key", async () => {
    const error = await refused(HANDLER, { "etherscan-v2": ETHERSCAN_KEY });
    assert.deepEqual(fieldsOf(error), ["apiKeys.etherscan-v2"]);
    // With a bad handlerUrl too, both issues show.
    const both = await refused("//x.example", { "etherscan-v2": ETHERSCAN_KEY });
    assert.deepEqual(fieldsOf(both), ["handlerUrl", "apiKeys.etherscan-v2"]);
    const shown = [error.message, error.hint, JSON.stringify(error.toJSON()), String(error)];
    assert.ok(!shown.join("\n").includes(ETHERSCAN_KEY));
  });

  it("keeps a Routescan key next to handlerUrl: the handler serves Etherscan only", () => {
    const settings = settingsOf({ handlerUrl: HANDLER, apiKeys: { routescan: ROUTESCAN_KEY } });
    assert.deepEqual(settings.apiKeys(), { routescan: ROUTESCAN_KEY });
  });
});

/** A refusal body of the handler with `code`. */
function refusal(code: string): string {
  return JSON.stringify({ status: "0", message: "NOTOK", result: "Refused.", code });
}

/** The `unexpected-response` the HTTP layer throws after its retries, with `attempts` when set. */
function thrown(excerpt: string, attempts?: number): ExplorerVerifyError {
  return newError(
    {
      code: "unexpected-response",
      backend: "etherscan-v2",
      status: 502,
      excerpt,
      ...(attempts === undefined ? {} : { attempts }),
    },
    "m",
    { secrets: [] },
  );
}

/** An answer of the handler that carries `code`. */
function answer(status: number, code: string): Answer {
  return { status, text: refusal(code), fields: new Map(Object.entries({ code })) };
}

describe("the errors of the handler's answers (decision 0048)", () => {
  const handler = resolveHandler(
    { handlerUrl: HANDLER, apiKeys: () => ({}), keySecrets: () => [] },
    ETHERSCAN,
  );

  it("leaves a rate-limited code to the HTTP layer, which throws for a 429 before reading it", () => {
    const error = handler.answerError(
      "etherscan-v2",
      answer(429, "rate-limited"),
      "the lookup",
      [],
    );
    assert.equal(error.code, "unexpected-response");
    assert.equal(error.retryable, true);
    assert.doesNotMatch(error.message, /rate-limited/);
  });

  it("takes the attempts from the thrown error's details, or 1 when it has none", () => {
    for (const attempts of [3, undefined]) {
      const error = handler.annotate(thrown(refusal("upstream-error"), attempts), []);
      assert.ok(ExplorerVerifyError.is(error, "network"));
      assert.equal(error.details.attempts, attempts ?? 1);
      assert.ok(error.cause instanceof Error);
    }
  });

  // R-SRV-5, decision 0066 (amendment of 2026-11-11), issue #354.
  it("maps address-not-indexed to not-indexed: the refused submits, and the time measured", () => {
    const notIndexed = (attempts: number | undefined, body: unknown, elapsedMs?: number) => {
      const excerpt = refusal("address-not-indexed");
      const error = handler.annotate(
        newError(
          {
            code: "unexpected-response",
            backend: "etherscan-v2",
            status: 503,
            excerpt,
            ...(attempts === undefined ? {} : { attempts }),
          },
          "m",
          { secrets: [] },
        ),
        [],
        body,
        elapsedMs,
      );
      assert.ok(ExplorerVerifyError.is(error, "not-indexed"));
      return error;
    };
    const submit = new URLSearchParams({ action: "verifysourcecode" });
    assert.deepEqual(notIndexed(5, submit, 21_000).details, {
      code: "not-indexed",
      backend: "etherscan-v2",
      submits: 5,
      elapsedMs: 21_000,
    });
    assert.equal(notIndexed(undefined, submit).details.submits, 1);
    assert.equal(notIndexed(undefined, submit).details.elapsedMs, 0);
    const lookup = new URLSearchParams({ action: "getsourcecode" });
    assert.equal(notIndexed(5, lookup, 21_000).details.submits, 0);
    assert.equal(notIndexed(5, undefined, 21_000).details.submits, 0);
    const error = notIndexed(5, lookup);
    assert.match(error.hint, /no creation record/);
    assert.doesNotMatch(error.hint, /indexWaitMs/);
    assert.equal(error.retryable, true);
    // An answer the client reads, outside the HTTP layer's retries: one answer, no time measured.
    const read = handler.answerError(
      "etherscan-v2",
      answer(503, "address-not-indexed"),
      "the submit",
      [],
    );
    assert.ok(ExplorerVerifyError.is(read, "not-indexed"));
    assert.deepEqual(read.details, {
      code: "not-indexed",
      backend: "etherscan-v2",
      submits: 1,
      elapsedMs: 0,
    });
    // With another status, the code maps nothing.
    const other = handler.answerError(
      "etherscan-v2",
      answer(500, "address-not-indexed"),
      "the submit",
      [],
    );
    assert.equal(other.code, "unexpected-response");
  });

  it("names the action of the request body in the message, or the request", () => {
    for (const [body, what] of [
      [new URLSearchParams({ action: "verifysourcecode" }), "the submit"],
      [new URLSearchParams({ action: "checkverifystatus" }), "the job status request"],
      [new URLSearchParams({ action: "verifyproxycontract" }), "the proxy link request"],
      [new URLSearchParams({ action: "getabi" }), "the request"],
      [new URLSearchParams(), "the request"],
      ["action=getsourcecode", "the request"],
    ] as const) {
      const error = handler.annotate(thrown(refusal("upstream-error")), [], body);
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(`answered ${what} with upstream-error`));
    }
  });

  it("leaves an error alone when it is not unexpected-response, or its excerpt holds no code", () => {
    const network = newError({ code: "network", backend: "etherscan-v2", attempts: 5 }, "m", {
      secrets: [],
    });
    assert.equal(handler.annotate(network, []), network);
    const plain = thrown("<html>");
    assert.equal(handler.annotate(plain, []), plain);
    const notOurs = new Error("x");
    assert.equal(handler.annotate(notOurs, []), notOurs);
  });

  it("ignores a code field that is not of the handler's shape", () => {
    const error = handler.answerError(
      "etherscan-v2",
      { status: 403, text: "{}", fields: new Map(Object.entries({ code: "Chain-Not-Allowed" })) },
      "the lookup",
      [],
    );
    assert.equal(error.code, "unexpected-response");
    assert.match(error.message, /gave an answer to the lookup that this client does not recognise/);
    assert.equal(error.retryable, false);
  });
});
