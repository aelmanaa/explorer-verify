// More tests of createVerifyHandler against a fake Etherscan (R-QA-3): the read-only lookup and
// its reduced answer (decision 0021), the field cap, the request deadline, the logger, the retry
// limit, deep redaction, and boundary tests that each fail on a mutant of the handler (R-SRV-3,
// R-SRV-4, R-SEC-1, R-SEC-2).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createVerifyHandler,
  DEFAULT_MAX_BODY_BYTES,
  SOURCE_MARKER,
} from "../../src/server/handler.ts";
import type { VerifyHandlerOptions } from "../../src/server/handler.ts";
import type { LogFields } from "../../src/types.ts";
import { etherscanFixture, fakeExplorer, json } from "../helpers/fake-explorer.ts";
import type { ExplorerStep } from "../helpers/fake-explorer.ts";

// A made-up key. Never a real one (R-SEC-1). It matches no redaction pattern, so only the
// known-key rule can hide it.
const KEY = "dummy.key_abc~def-0001";
const HANDLER_URL = "https://dapp.example/api/verify";
const ETHERSCAN_API_URL = "https://api.etherscan.io/v2/api";
const ARB_SEPOLIA = 421614;
const SUBMIT = etherscanFixture("2026-11-03-verifysourcecode-factory-child");
const STATUS = etherscanFixture("2026-11-03-checkverifystatus-factory-child-02-pass");
const CREATION = etherscanFixture("2026-11-03-getcontractcreation-factory-children");
const SIMILAR = etherscanFixture("2026-11-03-getsourcecode-similar-match");
const NOT_VERIFIED = etherscanFixture("2026-11-03-getsourcecode-not-verified");
const DEPLOYER = "0x9d087fc03ae39b088326b67fa3c788236645b717";
const CHILD = "0x80798fEd44d6ec40d283bD44DDb08A6Eb2d30BE5";
const OK_GUID = {
  status: "1",
  message: "OK",
  result: "yatwfd5yijmxufgkexd8ygesyexubjazunjnbgkemvwbm7vhrw",
};

function setup(
  steps: ExplorerStep[] = [],
  options: Partial<VerifyHandlerOptions> = {},
): {
  handler: (request: Request) => Promise<Response>;
  explorer: ReturnType<typeof fakeExplorer>;
} {
  const explorer = fakeExplorer(...steps);
  const handler = createVerifyHandler({
    apiKey: KEY,
    chains: [ARB_SEPOLIA],
    fetch: explorer.fetch,
    ...options,
  });
  return { handler, explorer };
}

function post(
  fields: Record<string, string> | string,
  query = `?chainid=${String(ARB_SEPOLIA)}`,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${HANDLER_URL}${query}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: typeof fields === "string" ? fields : new URLSearchParams(fields).toString(),
  });
}

/** A form POST whose body streams from `source`, with no Content-Length. */
function streamed(source: UnderlyingDefaultSource<Uint8Array>): Request {
  // `duplex` is required for a stream body, and the DOM types do not declare it yet.
  const init: RequestInit & { readonly duplex: "half" } = {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new ReadableStream<Uint8Array>(source),
    duplex: "half",
  };
  return new Request(`${HANDLER_URL}?chainid=${String(ARB_SEPOLIA)}`, init);
}

/** A stream source that sends `chunks` in order, then ends. */
function chunks(list: Uint8Array[], onCancel?: () => void): UnderlyingDefaultSource<Uint8Array> {
  let next = 0;
  return {
    pull(controller) {
      const chunk = list[next];
      next += 1;
      if (chunk === undefined) {
        controller.close();
      } else {
        controller.enqueue(chunk);
      }
    },
    cancel() {
      onCancel?.();
    },
  };
}

async function code(response: Response): Promise<{ status: number; code: unknown }> {
  const body: unknown = await response.json();
  return { status: response.status, code: Reflect.get(Object(body), "code") };
}

async function turn(): Promise<void> {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe("createVerifyHandler forwards a read-only lookup (R-SRV-3, R-FLOW-1, decision 0021)", () => {
  it("forwards getsourcecode with the key and reduces the answer to what the client reads", async () => {
    const { handler, explorer } = setup([json(SIMILAR.body)]);
    const response = await handler(post(SIMILAR.fields));
    assert.equal(response.status, 200);
    const [call] = explorer.calls;
    assert.ok(call !== undefined);
    assert.equal(call.url, `${ETHERSCAN_API_URL}?chainid=${String(ARB_SEPOLIA)}`);
    assert.equal(call.redirect, "manual");
    assert.deepEqual(Object.fromEntries(call.form), {
      module: "contract",
      action: "getsourcecode",
      address: SIMILAR.fields["address"],
      apikey: KEY,
    });
    assert.deepEqual(await response.json(), {
      status: "1",
      message: "OK",
      result: [
        {
          SourceCode: SOURCE_MARKER,
          SimilarMatch: "0x80798fEd44d6ec40d283bD44DDb08A6Eb2d30BE5",
          ContractName: "ProbeDChild",
          CompilerVersion: "v0.8.24+commit.e11b9ed9",
        },
      ],
    });
  });

  it("keeps an empty SourceCode empty, so an unverified contract reads as unverified", async () => {
    const { handler } = setup([json(NOT_VERIFIED.body)]);
    const body: unknown = await (await handler(post(NOT_VERIFIED.fields))).json();
    assert.deepEqual(body, {
      status: "1",
      message: "OK",
      result: [{ SourceCode: "", SimilarMatch: "", ContractName: "", CompilerVersion: "" }],
    });
  });

  it("never relays source, ABI or any other field, also in a large answer", async () => {
    const source = `contract Secret {} ${"x".repeat(2 * 1024 * 1024)}`;
    const answer = {
      status: "1",
      message: "OK",
      result: [
        { SourceCode: source, ABI: "[]", ContractName: 5, Proxy: "1", Implementation: CHILD },
        { SourceCode: "second" },
      ],
      extra: "dropped",
    };
    const { handler } = setup([json(answer)]);
    const response = await handler(post(SIMILAR.fields));
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.ok(!text.includes("Secret") && !text.includes("second") && !text.includes("extra"));
    assert.deepEqual(JSON.parse(text), {
      status: "1",
      message: "OK",
      result: [{ SourceCode: SOURCE_MARKER }],
    });
  });

  it("keeps a text result such as a key error, redacted, and drops any other result", async () => {
    const cases: [unknown, unknown][] = [
      [`Invalid API Key (#err2) ${KEY}`, "Invalid API Key (#err2) [redacted]"],
      [[], []],
      [[null], []],
      [{ SourceCode: "x" }, undefined],
    ];
    for (const [result, want] of cases) {
      const { handler } = setup([json({ status: "0", message: "NOTOK", result })]);
      const body: unknown = await (await handler(post(SIMILAR.fields))).json();
      assert.deepEqual(Reflect.get(Object(body), "result"), want, JSON.stringify(result));
    }
  });

  it("refuses a lookup of more than one address, or of no address", async () => {
    for (const address of [`${CHILD},${DEPLOYER}`, "", "0x1234"]) {
      const { handler, explorer } = setup();
      const response = await handler(
        post({ module: "contract", action: "getsourcecode", address }),
      );
      assert.deepEqual(await code(response), { status: 400, code: "bad-request" });
      assert.equal(explorer.calls.length, 0);
    }
  });

  it("runs the deployer check before a lookup", async () => {
    const { handler, explorer } = setup([json(CREATION.body), json(SIMILAR.body)], {
      deployers: [DEPLOYER],
    });
    const response = await handler(
      post({ module: "contract", action: "getsourcecode", address: CHILD }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(
      explorer.calls.map((call) => call.form.get("action")),
      ["getcontractcreation", "getsourcecode"],
    );
  });

  it("does not forward proxy verification yet (#94)", async () => {
    for (const action of ["verifyproxycontract", "checkproxyverification"]) {
      const { handler } = setup();
      const response = await handler(post({ module: "contract", action, guid: "abc" }));
      assert.deepEqual(await code(response), { status: 403, code: "action-not-allowed" });
    }
  });
});

describe("createVerifyHandler limits fields, time and encodings (R-SRV-4)", () => {
  it("refuses an 8 MiB flood of empty fields with a fast 400, before parsing", async () => {
    const flood = "a=&".repeat(Math.floor((8 * 1024 * 1024) / 3));
    const { handler, explorer } = setup();
    const started = performance.now();
    const response = await handler(post(flood));
    const elapsed = performance.now() - started;
    const { status, code: refused } = await code(response);
    assert.equal(status, 400);
    assert.equal(refused, "bad-request");
    assert.ok(elapsed < 2_000, `took ${String(elapsed)} ms`);
    assert.equal(explorer.calls.length, 0);
  });

  it("counts the query and the body together: 16 fields pass the cap, 17 do not", async () => {
    const fields = { ...SUBMIT.fields, constructorArguments: "00", licenseType: "1" };
    // The body fields, `chainid` in the query, and unknown fields up to 16 in all.
    const unknown = 16 - Object.keys(fields).length - 1;
    assert.ok(unknown > 1);
    const extra = Array.from({ length: unknown }, (_, index) => `&u${String(index)}=1`).join("");
    const body = new URLSearchParams(fields).toString();
    const atCap = await setup().handler(post(`${body}${extra}`));
    const atCapBody: unknown = await atCap.json();
    assert.match(
      String(Reflect.get(Object(atCapBody), "result")),
      new RegExp(`^The request has ${String(unknown)} fields that`),
    );
    const overCap = await setup().handler(post(`${body}${extra}`, "?chainid=421614&x=1"));
    const overCapBody: unknown = await overCap.json();
    assert.match(String(Reflect.get(Object(overCapBody), "result")), /more than 16 fields/);
    assert.equal(overCap.status, 400);
  });

  it("refuses a body that does not arrive within timeoutMs with 408, and cancels it", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    let cancelled = 0;
    let pulled: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      pulled = resolve;
    });
    const { handler, explorer } = setup([], { timeoutMs: 5_000 });
    const pending = handler(
      streamed({
        pull: async () => {
          pulled?.();
          await new Promise(() => {});
        },
        cancel: () => {
          cancelled += 1;
        },
      }),
    );
    await started;
    await turn();
    t.mock.timers.tick(5_000);
    assert.deepEqual(await code(await pending), { status: 408, code: "request-timeout" });
    await turn();
    assert.equal(cancelled, 1);
    assert.equal(explorer.calls.length, 0);
  });

  it("refuses a body that trickles in past the deadline (slow client)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const { handler } = setup([], { timeoutMs: 3_000 });
    let sent = 0;
    const pending = handler(
      streamed({
        pull: async (controller) => {
          sent += 1;
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 1_000);
          });
          controller.enqueue(new TextEncoder().encode("a"));
        },
      }),
    );
    for (let step = 0; step < 4; step += 1) {
      await turn();
      t.mock.timers.tick(1_000);
    }
    assert.deepEqual(await code(await pending), { status: 408, code: "request-timeout" });
    assert.ok(sent <= 4);
  });

  it("refuses a POST without a content type with 415", async () => {
    const { handler } = setup();
    const response = await handler(new Request(HANDLER_URL, { method: "POST" }));
    assert.deepEqual(await code(response), { status: 415, code: "unsupported-media-type" });
  });

  it("refuses a Content-Encoding other than identity with 415", async () => {
    for (const encoding of ["gzip", "br", "deflate, identity"]) {
      const { handler } = setup();
      const response = await handler(
        post(STATUS.fields, undefined, { "content-encoding": encoding }),
      );
      assert.deepEqual(await code(response), { status: 415, code: "unsupported-media-type" });
    }
    for (const encoding of ["identity", " Identity ", ""]) {
      const { handler } = setup([json(STATUS.body)]);
      const response = await handler(
        post(STATUS.fields, undefined, { "content-encoding": encoding }),
      );
      assert.equal(response.status, 200, encoding);
    }
  });
});

describe("createVerifyHandler retries an upstream call at most once", () => {
  it("retries a status poll once after a 503, then answers 502", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const busy = json({ status: "0", message: "NOTOK", result: "busy" }, 503);
    const { handler, explorer } = setup([busy, busy, json(STATUS.body)]);
    const pending = handler(post(STATUS.fields));
    while (explorer.calls.length < 2) {
      await turn();
      t.mock.timers.tick(250);
    }
    assert.deepEqual(await code(await pending), { status: 502, code: "upstream-error" });
    assert.equal(explorer.calls.length, 2);
  });

  it("retries a status poll after a network error, and a submit never", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const status = setup([new TypeError("fetch failed"), json(STATUS.body)]);
    const pending = status.handler(post(STATUS.fields));
    while (status.explorer.calls.length < 2) {
      await turn();
      t.mock.timers.tick(250);
    }
    assert.equal((await pending).status, 200);

    for (const first of [new TypeError("fetch failed"), json({ status: "0" }, 502)]) {
      const submit = setup([first, json(OK_GUID)]);
      const response = await submit.handler(post(SUBMIT.fields));
      assert.equal(response.status, 502);
      assert.equal(submit.explorer.calls.length, 1, "a submit is never sent twice");
    }
  });
});

/** A logger that records each line as `<level> <message> <fields>`. */
function recorder(): {
  logger: Required<VerifyHandlerOptions>["logger"];
  lines: string[];
} {
  const lines: string[] = [];
  const line =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      lines.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`);
    };
  return {
    logger: {
      debug: line("debug"),
      info: line("info"),
      warn: line("warn"),
      error: line("error"),
    },
    lines,
  };
}

describe("createVerifyHandler logs through the logger (R-DX-5, R-SEC-1)", () => {
  it("logs a refusal at info, an upstream failure at warn and an internal error at error", async () => {
    const { logger, lines } = recorder();
    const { handler } = setup([new TypeError(`fetch failed ${KEY}`)], {
      logger,
      rateLimit: (request) => {
        if (request.headers.has("x-break")) {
          throw new Error(`hook failed for ${KEY}`);
        }
        return true;
      },
    });
    await handler(post({ module: "contract", action: "getabi" }));
    await handler(post(STATUS.fields));
    const broken = await handler(post(STATUS.fields, undefined, { "x-break": "1" }));
    assert.equal(broken.status, 500);
    const text = lines.join("\n");
    assert.match(text, /^info explorer-verify\/server: refused with action-not-allowed/m);
    assert.match(text, /^warn explorer-verify\/server: upstream failed: .*"code":"network"/m);
    assert.match(
      text,
      /^error explorer-verify\/server: internal error: Error: hook failed for \[redacted\]/m,
    );
    assert.ok(!text.includes(KEY), text);
  });

  it("logs a thrown value that is not an Error by its type, and survives a logger that throws", async () => {
    const lines: string[] = [];
    const logger = {
      debug: (): void => {},
      info: (): void => {
        throw new Error("logger broke");
      },
      warn: (): void => {},
      error: (message: string): void => {
        lines.push(message);
      },
    };
    const { handler } = setup([], {
      logger,
      rateLimit: () => {
        // A hook may throw anything.
        throw Object.assign(Object.create(null), { reason: KEY });
      },
    });
    const response = await handler(post(STATUS.fields));
    assert.deepEqual(await code(response), { status: 500, code: "internal-error" });
    assert.deepEqual(lines, ["explorer-verify/server: internal error: object"]);
  });

  it("refuses a logger that is not an object", () => {
    assert.throws(
      () =>
        Reflect.apply(createVerifyHandler, undefined, [{ apiKey: KEY, chains: [1], logger: 5 }]),
      /logger/,
    );
    assert.throws(
      () =>
        Reflect.apply(createVerifyHandler, undefined, [{ apiKey: KEY, chains: [1], logger: null }]),
      /logger/,
    );
  });
});

describe("createVerifyHandler redacts every string of an answer (R-SEC-1)", () => {
  it("redacts a key written with \\u escapes, and in object keys", async () => {
    // The key is ASCII, so one UTF-16 unit per character.
    const escaped = Array.from(
      { length: KEY.length },
      (_, index) => `\\u${KEY.charCodeAt(index).toString(16).padStart(4, "0")}`,
    ).join("");
    const text = `{"status":"0","message":"NOTOK","result":"${escaped}","${escaped}":["${escaped}"]}`;
    assert.ok(!text.includes(KEY));
    const { handler } = setup([new Response(text, { status: 200 })]);
    const response = await handler(post(STATUS.fields));
    const shown = await response.text();
    assert.ok(!shown.includes(KEY), shown);
    assert.deepEqual(JSON.parse(shown), {
      status: "0",
      message: "NOTOK",
      result: "[redacted]",
      "[redacted]": ["[redacted]"],
    });
  });

  it("keeps numbers, booleans and null as they are", async () => {
    const answer = { status: "1", message: "OK", result: [1, true, null, { n: 2 }] };
    const { handler } = setup([json(answer)]);
    assert.deepEqual(await (await handler(post(STATUS.fields))).json(), answer);
  });
});

describe("createVerifyHandler boundaries (mutation tests)", () => {
  it("refuses when an async rate limit hook resolves false (M07)", async () => {
    const { handler, explorer } = setup([json(OK_GUID)], {
      rateLimit: async () => await Promise.resolve(false),
    });
    assert.deepEqual(await code(await handler(post(STATUS.fields))), {
      status: 429,
      code: "rate-limited",
    });
    assert.equal(explorer.calls.length, 0);
  });

  it("never calls the rate limit hook for a non-POST, and rate-limits before the type check (M09, M10)", async () => {
    let calls = 0;
    const { handler } = setup([], {
      rateLimit: () => {
        calls += 1;
        return false;
      },
    });
    const get = await handler(new Request(HANDLER_URL, { method: "GET" }));
    assert.equal(get.status, 405);
    assert.equal(calls, 0);
    const wrongType = await handler(
      new Request(HANDLER_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    assert.equal(wrongType.status, 429);
    assert.equal(calls, 1);
  });

  it("accepts a Content-Length equal to the limit, and refuses one byte more (M15)", async () => {
    const body = new URLSearchParams(STATUS.fields).toString();
    const at = setup([json(STATUS.body)], { maxBodyBytes: body.length });
    const ok = await at.handler(post(body, undefined, { "content-length": String(body.length) }));
    assert.equal(ok.status, 200);
    const over = setup([], { maxBodyBytes: body.length - 1 });
    const request = post(body, undefined, { "content-length": String(body.length) });
    assert.deepEqual(await code(await over.handler(request)), {
      status: 413,
      code: "body-too-large",
    });
    assert.equal(request.bodyUsed, false, "refused before any byte is read");
  });

  it("refuses a streamed body one byte over the limit (M18)", async () => {
    const { handler, explorer } = setup([], { maxBodyBytes: 10 });
    const response = await handler(streamed(chunks([new Uint8Array(11).fill(0x61)])));
    assert.deepEqual(await code(response), { status: 413, code: "body-too-large" });
    assert.equal(explorer.calls.length, 0);
  });

  it("counts the limit in bytes, not characters (M19)", async () => {
    const { handler, explorer } = setup([], { maxBodyBytes: 4 });
    const response = await handler(streamed(chunks([new TextEncoder().encode("ééé")])));
    assert.deepEqual(await code(response), { status: 413, code: "body-too-large" });
    assert.equal(explorer.calls.length, 0);
  });

  it("cancels the body stream once it passes the limit (M20)", async () => {
    let cancelled = 0;
    const { handler } = setup([], { maxBodyBytes: 4 });
    const response = await handler(
      streamed(
        chunks([new Uint8Array(8).fill(0x61), new Uint8Array(8).fill(0x61)], () => {
          cancelled += 1;
        }),
      ),
    );
    assert.equal(response.status, 413);
    await turn();
    assert.equal(cancelled, 1);
  });

  it("refuses every forbidden spelling with forbidden-field (M28, M29)", async () => {
    const names = [
      "apikey",
      "api_key",
      "api-key",
      "x-api-key",
      "route",
      "apiurl",
      "api_url",
      "api-url",
      "backend",
      "url",
      "host",
    ];
    for (const name of names) {
      for (const spelled of [name, name.toUpperCase()]) {
        const { handler } = setup();
        const result = await code(await handler(post({ ...STATUS.fields, [spelled]: "x" })));
        assert.deepEqual(result, { status: 400, code: "forbidden-field" }, spelled);
      }
    }
  });

  it("refuses a forbidden field given twice as forbidden-field (M33)", async () => {
    const { handler } = setup();
    const result = await code(
      await handler(post(`${new URLSearchParams(STATUS.fields).toString()}&apikey=a&apikey=b`)),
    );
    assert.deepEqual(result, { status: 400, code: "forbidden-field" });
  });

  it("accepts a contractname of exactly 1024 characters (M52)", async () => {
    const { handler } = setup([json(OK_GUID)]);
    const response = await handler(post({ ...SUBMIT.fields, contractname: "a".repeat(1024) }));
    assert.equal(response.status, 200);
  });

  it("refuses a licenseType of three digits (M54)", async () => {
    const { handler } = setup();
    const result = await code(await handler(post({ ...SUBMIT.fields, licenseType: "100" })));
    assert.deepEqual(result, { status: 400, code: "bad-request" });
  });

  it("accepts a creation record in checksum case (M59, M61)", async () => {
    const checksummed = {
      status: "1",
      message: "OK",
      result: [
        {
          contractAddress: CHILD,
          contractCreator: "0x9D087fC03ae39b088326b67fA3C788236645b717",
          contractFactory: "",
        },
      ],
    };
    const { handler, explorer } = setup([json(checksummed), json(OK_GUID)], {
      deployers: [DEPLOYER],
    });
    const response = await handler(post({ ...SUBMIT.fields, contractaddress: CHILD }));
    assert.equal(response.status, 200);
    assert.equal(explorer.calls.length, 2);
  });

  it("does not trust a creation record whose status is 0, even when it names the deployer (M64)", async () => {
    const answer = {
      status: "0",
      message: "NOTOK",
      result: [{ contractAddress: CHILD.toLowerCase(), contractCreator: DEPLOYER }],
    };
    const { handler, explorer } = setup([json(answer)], { deployers: [DEPLOYER] });
    const result = await code(await handler(post({ ...SUBMIT.fields, contractaddress: CHILD })));
    assert.deepEqual(result, { status: 502, code: "upstream-error" });
    assert.equal(explorer.calls.length, 1);
  });

  it("never sends the submit after a failed creation lookup (M58)", async () => {
    for (const step of [new Response("<html>", { status: 200 }), json({ status: "0" }, 500)]) {
      const { handler, explorer } = setup([step, json(OK_GUID)], { deployers: [DEPLOYER] });
      const response = await handler(post({ ...SUBMIT.fields, contractaddress: CHILD }));
      assert.notEqual(response.status, 200);
      assert.ok(explorer.calls.every((call) => call.form.get("action") === "getcontractcreation"));
    }
  });

  it("redacts a key that no pattern recognises (M72)", async () => {
    const { handler } = setup([json({ status: "0", message: "NOTOK", result: `bad ${KEY}` })]);
    const text = await (await handler(post(STATUS.fields))).text();
    assert.ok(!text.includes(KEY), text);
    assert.ok(text.includes("bad [redacted]"), text);
  });

  it("rounds a fractional Retry-After up (M77)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_500 });
    const date = new Date(1_000_000 + 120_000).toUTCString(); // 119.5 s from now
    const { handler } = setup([
      json({ status: "0", message: "NOTOK", result: "busy" }, 429, { "retry-after": date }),
    ]);
    const response = await handler(post(STATUS.fields));
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "120");
  });

  it("refuses an upstream status answer above 1 MiB with 502 (M86)", async () => {
    const big = json({ status: "1", message: "OK", result: "a".repeat(1024 * 1024 + 1) });
    const { handler } = setup([big]);
    const result = await code(await handler(post(STATUS.fields)));
    assert.deepEqual(result, { status: 502, code: "upstream-error" });
  });

  it("applies the 8 MiB default when maxBodyBytes is not set (M101)", async () => {
    const { handler, explorer } = setup();
    const response = await handler(
      streamed(chunks([new Uint8Array(DEFAULT_MAX_BODY_BYTES + 1).fill(0x61)])),
    );
    assert.deepEqual(await code(response), { status: 413, code: "body-too-large" });
    assert.equal(explorer.calls.length, 0);
  });

  it("applies the 20 s default when timeoutMs is not set (M102)", { timeout: 5_000 }, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const { handler, explorer } = setup(["hang"]);
    const pending = handler(post(STATUS.fields));
    await explorer.called;
    t.mock.timers.tick(19_999);
    await turn();
    const early = await Promise.race([
      pending.then(() => "answered"),
      turn().then(() => "pending"),
    ]);
    assert.equal(early, "pending", "answered before 20 s");
    t.mock.timers.tick(1);
    assert.deepEqual(await code(await pending), { status: 504, code: "upstream-timeout" });
  });

  it(
    "shares one deadline between the creation lookup and the submit (M84)",
    { timeout: 5_000 },
    async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      const explorer = fakeExplorer(json(CREATION.body), "hang");
      const handler = createVerifyHandler({
        apiKey: KEY,
        chains: [ARB_SEPOLIA],
        deployers: [DEPLOYER],
        timeoutMs: 5_000,
        fetch: async (input, init) => {
          const response = await explorer.fetch(input, init);
          // The creation lookup takes 4 of the 5 seconds.
          t.mock.timers.tick(4_000);
          return response;
        },
      });
      const pending = handler(post({ ...SUBMIT.fields, contractaddress: CHILD }));
      while (explorer.calls.length < 2) {
        await turn();
      }
      t.mock.timers.tick(1_000);
      assert.deepEqual(await code(await pending), { status: 504, code: "upstream-timeout" });
    },
  );

  it("accepts exactly 10,000 chains and refuses 10,001 deployers (M93, M103)", () => {
    assert.doesNotThrow(() =>
      createVerifyHandler({
        apiKey: KEY,
        chains: Array.from({ length: 10_000 }, (_, index) => index + 1),
      }),
    );
    assert.throws(() =>
      createVerifyHandler({
        apiKey: KEY,
        chains: [1],
        deployers: Array.from({ length: 10_001 }, () => DEPLOYER),
      }),
    );
  });
});
