// Tests added when the server handler joined mutation testing (#202; R-SRV-3, R-SRV-4, R-SEC-1,
// R-SEC-2, R-DX-5): each one fails on a code change in src/server/handler.ts that the other
// handler tests let pass. Every upstream request goes to a fake Etherscan; waits run on mock
// timers.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import { ExplorerVerifyError } from "../../src/errors.ts";
import { createVerifyHandler, SOURCE_MARKER } from "../../src/server/handler.ts";
import type { VerifyHandlerOptions } from "../../src/server/handler.ts";
import type { Logger } from "../../src/types.ts";
import { etherscanFixture, fakeExplorer, json } from "../helpers/fake-explorer.ts";
import type { ExplorerStep } from "../helpers/fake-explorer.ts";

// A made-up key. Never a real one (R-SEC-1).
const KEY = "dummy.key_abc~def-0001";
const HANDLER_URL = "https://dapp.example/api/verify";
const ARB_SEPOLIA = 421614;
const SUBMIT = etherscanFixture("2026-11-03-verifysourcecode-factory-child");
const STATUS = etherscanFixture("2026-11-03-checkverifystatus-factory-child-02-pass");
const CREATION = etherscanFixture("2026-11-03-getcontractcreation-factory-children");
const SIMILAR = etherscanFixture("2026-11-03-getsourcecode-similar-match");
const DEPLOYER = "0x9d087fc03ae39b088326b67fa3c788236645b717";
const OTHER = "0x00000000000000000000000000000000000000aa";
const PROXY = "0xed5b8413e605598ef86cd7617f12701f74ca255c";
const OK_GUID = {
  status: "1",
  message: "OK",
  result: "yatwfd5yijmxufgkexd8ygesyexubjazunjnbgkemvwbm7vhrw",
};
const BAD_GATEWAY = json({ status: "0", message: "NOTOK", result: "bad gateway" }, 502);

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

/** The status, code and sentence of a response. */
async function refusal(
  response: Response,
): Promise<{ status: number; code: unknown; result: unknown }> {
  const body: unknown = await response.json();
  return {
    status: response.status,
    code: Reflect.get(Object(body), "code"),
    result: Reflect.get(Object(body), "result"),
  };
}

async function turn(): Promise<void> {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Ticks the mock clock until the fake explorer has `count` calls, then gives the response. */
async function settle(
  t: TestContext,
  pending: Promise<Response>,
  explorer: ReturnType<typeof fakeExplorer>,
  count: number,
): Promise<Response> {
  while (explorer.calls.length < count) {
    await turn();
    t.mock.timers.tick(250);
  }
  return await pending;
}

/** A logger that records each line as `<level> <message> <fields>`. */
function recorder(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const line =
    (level: string) =>
    (message: string, fields?: unknown): void => {
      lines.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`);
    };
  return {
    logger: { debug: line("debug"), info: line("info"), warn: line("warn"), error: line("error") },
    lines,
  };
}

function thrown(run: () => unknown): ExplorerVerifyError {
  try {
    run();
  } catch (error: unknown) {
    assert.ok(error instanceof ExplorerVerifyError, String(error));
    return error;
  }
  throw new Error("did not throw");
}

describe("createVerifyHandler refuses with fixed sentences (R-SRV-3, R-SEC-1)", () => {
  it("gives each guard's sentence and code", async () => {
    const cases: [string, Request, Partial<VerifyHandlerOptions>, number, string, string][] = [
      ["GET", new Request(HANDLER_URL), {}, 405, "method-not-allowed", "Only POST is accepted."],
      [
        "rate limit",
        post(STATUS.fields),
        { rateLimit: () => false },
        429,
        "rate-limited",
        "Too many requests. Try again later.",
      ],
      [
        "text body",
        post(STATUS.fields, undefined, { "content-type": "text/plain" }),
        {},
        415,
        "unsupported-media-type",
        "The body must be application/x-www-form-urlencoded.",
      ],
      [
        "gzip",
        post(STATUS.fields, undefined, { "content-encoding": "gzip" }),
        {},
        415,
        "unsupported-media-type",
        "The body must not be encoded.",
      ],
      [
        "Content-Length",
        post(STATUS.fields, undefined, { "content-length": "11" }),
        { maxBodyBytes: 10 },
        413,
        "body-too-large",
        "The body is larger than 10 bytes.",
      ],
      [
        "key field",
        post({ ...STATUS.fields, apikey: KEY }),
        {},
        400,
        "forbidden-field",
        "The request must not name an API key, a route, an API URL, a backend, a URL or a host: the handler routes from its own configuration.",
      ],
      [
        "twice",
        post(STATUS.fields, `?chainid=${String(ARB_SEPOLIA)}&guid=x`),
        {},
        400,
        "bad-request",
        "A field appears more than once.",
      ],
      [
        "action",
        post({ module: "contract", action: "getabi", address: OTHER }),
        {},
        403,
        "action-not-allowed",
        "Only module contract with the verifysourcecode, checkverifystatus or getsourcecode action is forwarded.",
      ],
      [
        "no chainid",
        post(STATUS.fields, ""),
        {},
        400,
        "bad-request",
        "chainid must be a positive integer.",
      ],
      [
        "chain",
        post(STATUS.fields, "?chainid=1"),
        {},
        403,
        "chain-not-allowed",
        "This chain is not served here.",
      ],
      [
        "missing",
        post({ module: "contract", action: "verifysourcecode", contractaddress: OTHER }),
        {},
        400,
        "bad-request",
        "Missing fields: sourceCode, contractname, compilerversion, codeformat.",
      ],
      [
        "invalid",
        post({ ...STATUS.fields, guid: "a:b" }),
        {},
        400,
        "bad-request",
        "Invalid fields: guid.",
      ],
      [
        "hook throws",
        post(STATUS.fields),
        {
          rateLimit: () => {
            throw new Error("hook");
          },
        },
        500,
        "internal-error",
        "The handler failed.",
      ],
    ];
    for (const [name, request, options, status, code, result] of cases) {
      const { handler, explorer } = setup([], options);
      assert.deepEqual(await refusal(await handler(request)), { status, code, result }, name);
      assert.equal(explorer.calls.length, 0, name);
    }
  });

  it("gives the sentence of a body that cannot be read", async () => {
    const { handler } = setup();
    const response = await handler(
      streamed({
        pull(controller) {
          controller.error(new Error("broken"));
        },
      }),
    );
    assert.deepEqual(await refusal(response), {
      status: 400,
      code: "bad-request",
      result: "The body could not be read.",
    });
  });

  it("gives the sentence of a body that does not arrive in time", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const { handler } = setup([], { timeoutMs: 1_000 });
    const pending = handler(
      streamed({
        pull: async () => {
          await new Promise(() => {});
        },
      }),
    );
    await turn();
    t.mock.timers.tick(1_000);
    assert.deepEqual(await refusal(await pending), {
      status: 408,
      code: "request-timeout",
      result: "The body did not arrive in time.",
    });
  });

  it("gives the sentence of each upstream failure", async () => {
    const cases: [ExplorerStep, number, string, string][] = [
      [
        new Response("<html>", { status: 200 }),
        502,
        "upstream-error",
        "Etherscan sent an answer that is not a JSON object.",
      ],
      [
        new TypeError("fetch failed"),
        502,
        "upstream-error",
        "Etherscan could not be reached, redirected the request or sent an unusable answer.",
      ],
      [
        json({ status: "0", message: "NOTOK", result: "rate limit" }, 429, {
          "retry-after": "120",
        }),
        429,
        "upstream-rate-limited",
        "Etherscan is rate limiting this server. Try again later.",
      ],
    ];
    for (const [step, status, code, result] of cases) {
      // A submit is never retried after a network error, so each case is one request.
      const { handler } = setup([step]);
      assert.deepEqual(await refusal(await handler(post(SUBMIT.fields))), {
        status,
        code,
        result,
      });
    }
  });

  it("gives the sentence of an upstream timeout", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const { handler, explorer } = setup(["hang"], { timeoutMs: 5_000 });
    const pending = handler(post(STATUS.fields));
    await explorer.called;
    t.mock.timers.tick(5_000);
    assert.deepEqual(await refusal(await pending), {
      status: 504,
      code: "upstream-timeout",
      result: "Etherscan did not answer in time.",
    });
  });

  it("gives the sentences of the deployer check (R-SRV-4)", async () => {
    const submit = {
      ...SUBMIT.fields,
      contractaddress: "0x80798fEd44d6ec40d283bD44DDb08A6Eb2d30BE5",
    };
    const refused = setup([json(CREATION.body)], { deployers: [OTHER] });
    assert.deepEqual(await refusal(await refused.handler(post(submit))), {
      status: 403,
      code: "address-not-allowed",
      result: "The contract was not created by an allowed deployer or factory.",
    });
    const unknown = setup([json({ status: "1", message: "OK", result: [] })], {
      deployers: [DEPLOYER],
    });
    assert.deepEqual(await refusal(await unknown.handler(post(submit))), {
      status: 503,
      code: "address-not-indexed",
      result: "Etherscan has no creation record for this address yet. Try again later.",
    });
  });
});

describe("createVerifyHandler logs a refusal with its status and code (R-DX-5)", () => {
  it("passes the status and the code as fields of the info line", async () => {
    const { logger, lines } = recorder();
    const { handler } = setup([], { logger });
    await handler(new Request(HANDLER_URL));
    assert.deepEqual(lines, [
      'info explorer-verify/server: refused with method-not-allowed {"status":405,"code":"method-not-allowed"}',
    ]);
  });

  it("logs no upstream failure when the client went away, only the internal error", async () => {
    const { logger, lines } = recorder();
    const controller = new AbortController();
    const fetch: typeof globalThis.fetch = async () => {
      controller.abort(new Error("client gone"));
      return await Promise.reject(new Error("aborted"));
    };
    const handler = createVerifyHandler({ apiKey: KEY, chains: [ARB_SEPOLIA], fetch, logger });
    const response = await handler(
      new Request(`${HANDLER_URL}?chainid=${String(ARB_SEPOLIA)}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(STATUS.fields),
        signal: controller.signal,
      }),
    );
    assert.equal(response.status, 500);
    assert.deepEqual(
      lines.map((line) => line.split(" ")[0]).filter((level) => level !== "debug"),
      ["error", "info"],
      lines.join("\n"),
    );
  });
});

describe("createVerifyHandler retries a read once after a 502 (R-SRV-3, R-FLOW-6)", () => {
  it("retries a status poll, a lookup and both proxy-link actions", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const requests: [string, Record<string, string>][] = [
      ["checkverifystatus", STATUS.fields],
      ["getsourcecode", SIMILAR.fields],
      [
        "verifyproxycontract",
        { module: "contract", action: "verifyproxycontract", address: PROXY },
      ],
      [
        "checkproxyverification",
        { module: "contract", action: "checkproxyverification", guid: "abc" },
      ],
    ];
    for (const [action, fields] of requests) {
      const { handler, explorer } = setup([BAD_GATEWAY, json(OK_GUID)], { allowProxyLink: true });
      const response = await settle(t, handler(post(fields)), explorer, 2);
      assert.equal(response.status, 200, action);
      assert.equal(explorer.calls.length, 2, action);
    }
  });

  it("retries the creation lookup of the deployer check (R-SRV-4)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const submit = {
      ...SUBMIT.fields,
      contractaddress: "0x80798fEd44d6ec40d283bD44DDb08A6Eb2d30BE5",
    };
    const { handler, explorer } = setup([BAD_GATEWAY, json(CREATION.body), json(OK_GUID)], {
      deployers: [DEPLOYER],
    });
    const response = await settle(t, handler(post(submit)), explorer, 3);
    assert.equal(response.status, 200);
    assert.deepEqual(
      explorer.calls.map((call) => call.form.get("action")),
      ["getcontractcreation", "getcontractcreation", "verifysourcecode"],
    );
  });
});

describe("createVerifyHandler reads the request as sent (R-SRV-3)", () => {
  it("clears the deadline timer of every body read", async (t) => {
    const created: unknown[] = [];
    const cleared: unknown[] = [];
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    t.mock.method(globalThis, "setTimeout", (...args: Parameters<typeof setTimeout>) => {
      const timer = realSet(...args);
      created.push(timer);
      return timer;
    });
    t.mock.method(globalThis, "clearTimeout", (timer: Parameters<typeof clearTimeout>[0]) => {
      cleared.push(timer);
      realClear(timer);
    });
    // Refused after the body is read and before any upstream request, so only the body read
    // sets timers.
    const { handler } = setup();
    const response = await handler(post({ module: "contract", action: "getabi" }));
    assert.equal(response.status, 403);
    assert.ok(created.length > 0);
    assert.deepEqual(cleared, created);
  });

  it("accepts a form content type with a space before its parameters", async () => {
    const { handler } = setup([json(STATUS.body)]);
    const response = await handler(
      post(STATUS.fields, undefined, {
        "content-type": "application/x-www-form-urlencoded ; charset=utf-8",
      }),
    );
    assert.equal(response.status, 200);
  });

  it("drops only the first ? of the query", async () => {
    const { handler } = setup([json(STATUS.body)]);
    const response = await handler(post(STATUS.fields, `??chainid=${String(ARB_SEPOLIA)}`));
    assert.equal(response.status, 200);
  });

  it("refuses a Content-Length above the limit with surrounding white space, before reading", async () => {
    for (const declared of ["\v5000", "5000\f"]) {
      const { handler } = setup([json(STATUS.body)], { maxBodyBytes: 1_000 });
      const response = await handler(
        post(STATUS.fields, undefined, { "content-length": declared }),
      );
      assert.deepEqual(
        await refusal(response),
        { status: 413, code: "body-too-large", result: "The body is larger than 1000 bytes." },
        JSON.stringify(declared),
      );
    }
  });

  it("forwards a POST without a body whose fields are all in the query", async () => {
    const { handler, explorer } = setup([json(STATUS.body)]);
    const query = new URLSearchParams({ chainid: String(ARB_SEPOLIA), ...STATUS.fields });
    const response = await handler(
      new Request(`${HANDLER_URL}?${query.toString()}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(explorer.calls[0]?.form.get("guid"), STATUS.fields["guid"]);
  });

  it("decodes a character split across two chunks of the body", async () => {
    const { handler, explorer } = setup([json(OK_GUID)]);
    // The name as raw UTF-8, not percent-encoded, so a chunk can end inside the two bytes of ü.
    const raw = new TextEncoder().encode("contractname=Grüße");
    const rest = new URLSearchParams(SUBMIT.fields);
    rest.delete("contractname");
    const tail = new TextEncoder().encode(`&${rest.toString()}`);
    const cut = raw.indexOf(0xc3) + 1;
    assert.ok(cut > 0);
    const response = await handler(
      streamed({
        start(controller) {
          controller.enqueue(raw.slice(0, cut));
          controller.enqueue(raw.slice(cut));
          controller.enqueue(tail);
          controller.close();
        },
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(explorer.calls[0]?.form.get("contractname"), "Grüße");
  });

  it("waits for a chunk that arrives before the deadline", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const { handler, explorer } = setup([json(STATUS.body)], { timeoutMs: 5_000 });
    const body = new TextEncoder().encode(new URLSearchParams(STATUS.fields).toString());
    let sent = false;
    const pending = handler(
      streamed({
        pull: async (controller) => {
          if (sent) {
            controller.close();
            return;
          }
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 1_000);
          });
          sent = true;
          controller.enqueue(body);
        },
      }),
    );
    await turn();
    t.mock.timers.tick(1_000);
    assert.equal((await pending).status, 200);
    assert.equal(explorer.calls.length, 1);
  });

  it("ignores a Content-Length that is not a whole number, and reads the body", async () => {
    for (const declared of ["1e9", "9 9", "x99999999999"]) {
      const { handler } = setup([json(STATUS.body)], { maxBodyBytes: 1_000 });
      const response = await handler(
        post(STATUS.fields, undefined, { "content-length": declared }),
      );
      assert.equal(response.status, 200, declared);
    }
  });

  it("counts an empty query as no field, and a last field that starts a part (R-SRV-4)", async () => {
    const sixteen = Array.from({ length: 16 }, (_, index) => `f${String(index)}=1`);
    const { handler } = setup();
    // 16 fields pass the cap and reach the action check.
    const body = await refusal(await handler(post(sixteen.join("&"), "")));
    assert.deepEqual([body.status, body.code], [403, "action-not-allowed"]);

    const over = await refusal(await handler(post("f16=1", `?${sixteen.join("&")}`)));
    assert.deepEqual(over, {
      status: 400,
      code: "bad-request",
      result: "The request has more than 16 fields.",
    });
  });

  it("refuses a chainid with a leading zero, even when the number is served", async () => {
    for (const chainid of [`0${String(ARB_SEPOLIA)}`, "0x66eee", ` ${String(ARB_SEPOLIA)}`]) {
      const { handler, explorer } = setup([json(STATUS.body)]);
      const response = await handler(
        post(STATUS.fields, `?chainid=${encodeURIComponent(chainid)}`),
      );
      assert.equal(response.status, 400, chainid);
      assert.equal(explorer.calls.length, 0, chainid);
    }
  });
});

describe("createVerifyHandler checks the form of each submit field (R-SRV-3)", () => {
  const suffix = "a".repeat(96);
  it("accepts the compiler versions, code formats and licenses the client sends", async () => {
    const accepted: Record<string, string>[] = [
      { compilerversion: "0.8.24+commit.e11b9ed9" },
      { compilerversion: "v10.1.2" },
      { compilerversion: "v0.10.2" },
      { compilerversion: `v0.8.24${suffix}` },
      { licenseType: "14" },
    ];
    for (const fields of accepted) {
      const { handler } = setup([json(OK_GUID)]);
      const response = await handler(post({ ...SUBMIT.fields, ...fields }));
      assert.equal(response.status, 200, JSON.stringify(fields));
    }
  });

  it("names every field of the wrong form, in a list", async () => {
    const { handler } = setup();
    const fields = { ...SUBMIT.fields, compilerversion: "latest", codeformat: "JSON" };
    assert.deepEqual(await refusal(await handler(post(fields))), {
      status: 400,
      code: "bad-request",
      result: "Invalid fields: compilerversion, codeformat.",
    });
  });

  it("refuses text before or after a compiler version or a code format", async () => {
    const refused: [string, string][] = [
      ["compilerversion", "xv0.8.24"],
      ["compilerversion", "v0.8.24/x"],
      ["compilerversion", `v0.8.24${suffix}a`],
      ["codeformat", "1solidity-single-file"],
      ["codeformat", "solidity-single-file1"],
    ];
    for (const [name, value] of refused) {
      const { handler, explorer } = setup();
      const body = await refusal(await handler(post({ ...SUBMIT.fields, [name]: value })));
      assert.deepEqual(
        body,
        { status: 400, code: "bad-request", result: `Invalid fields: ${name}.` },
        value,
      );
      assert.equal(explorer.calls.length, 0);
    }
  });
});

describe("createVerifyHandler reduces a lookup answer (R-SRV-3, decision 0021)", () => {
  it("relays the source marker text", () => {
    assert.equal(SOURCE_MARKER, "[source not relayed by explorer-verify/server]");
  });

  it("gives an empty SourceCode for a SourceCode that is not text", async () => {
    for (const source of [5, null, ["x"]]) {
      const { handler } = setup([
        json({ status: "1", message: "OK", result: [{ SourceCode: source }] }),
      ]);
      const body: unknown = await (await handler(post(SIMILAR.fields))).json();
      assert.deepEqual(Reflect.get(Object(body), "result"), [{ SourceCode: "" }], String(source));
    }
  });
});

describe("createVerifyHandler deployer check (R-SRV-4)", () => {
  const child = "0x80798fEd44d6ec40d283bD44DDb08A6Eb2d30BE5";
  const submit = { ...SUBMIT.fields, contractaddress: child };

  it("skips a record whose contractAddress is not text", async () => {
    const { handler } = setup(
      [
        json({
          status: "1",
          message: "OK",
          result: [{ contractAddress: 5, contractCreator: DEPLOYER }],
        }),
      ],
      { deployers: [DEPLOYER] },
    );
    const body = await refusal(await handler(post(submit)));
    assert.equal(body.status, 403);
    assert.equal(body.code, "address-not-allowed");
  });

  it("does not trust a 4xx creation answer, even one shaped as a key error", async () => {
    const { handler, explorer } = setup(
      [json({ status: "0", message: "NOTOK", result: "Invalid API Key" }, 400)],
      { deployers: [DEPLOYER] },
    );
    const body = await refusal(await handler(post(submit)));
    assert.equal(body.status, 502);
    assert.equal(body.code, "upstream-error");
    assert.equal(explorer.calls.length, 1);
  });

  it("reads a missing record from the message too", async () => {
    const { handler } = setup([json({ status: "0", message: "No data found", result: "Error" })], {
      deployers: [DEPLOYER],
    });
    const body = await refusal(await handler(post(submit)));
    assert.deepEqual([body.status, body.code], [503, "address-not-indexed"]);
  });

  it("reads the message and a text result as one text, joined by a space", async () => {
    const { handler } = setup(
      [json({ status: "0", message: "Max rate", result: "limit reached" })],
      { deployers: [DEPLOYER] },
    );
    const body = await refusal(await handler(post(submit)));
    assert.deepEqual([body.status, body.code], [429, "upstream-rate-limited"]);
  });

  it("reads only a text result for a rate limit or a missing record", async () => {
    for (const result of [["Max rate limit reached"], ["No data found"]]) {
      const { handler } = setup([json({ status: "0", message: "NOTOK", result })], {
        deployers: [DEPLOYER],
      });
      const body = await refusal(await handler(post(submit)));
      assert.equal(body.status, 502, JSON.stringify(result));
      assert.equal(body.code, "upstream-error");
    }
  });
});

describe("createVerifyHandler checks its options (R-SRV-2, R-SEC-1)", () => {
  it("names each bad field in the message, with the handler hint", () => {
    const error = thrown(() => createVerifyHandler({ apiKey: "short", chains: [] }));
    assert.equal(error.message, "The handler options are invalid: apiKey, chains.");
    assert.equal(
      error.hint,
      "Pass apiKey as your Etherscan key and chains as the chain ids to serve, as the server handler docs show.",
    );
  });

  it("adds the key to the secrets of the options error", () => {
    // A key that is also a word of the hint: only the key's own redaction can hide it.
    const error = thrown(() => createVerifyHandler({ apiKey: "Etherscan", chains: [] }));
    assert.equal(
      error.hint,
      "Pass apiKey as your [redacted] key and chains as the chain ids to serve, as the server handler docs show.",
    );
  });

  it("refuses options that are a function, even one without a prototype", () => {
    const options = Object.assign(() => undefined, { apiKey: KEY, chains: [ARB_SEPOLIA] });
    Object.setPrototypeOf(options, null);
    const { details } = thrown(() => createVerifyHandler(options));
    assert.deepEqual(details, {
      code: "invalid-input",
      issues: [{ field: "options", message: "must be a plain object" }],
    });
  });

  it("accepts a logger that is a function with the four methods", () => {
    const logger = Object.assign(() => undefined, {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });
    assert.equal(typeof createVerifyHandler({ apiKey: KEY, chains: [1], logger }), "function");
  });

  it("names the options when an unknown option key cannot be named (#382)", () => {
    const options: VerifyHandlerOptions = { apiKey: KEY, chains: [1] };
    Reflect.set(options, "a b", 1);
    const { details } = thrown(() => createVerifyHandler(options));
    assert.deepEqual(details, {
      code: "invalid-input",
      issues: [{ field: "options", message: "is not a known option" }],
    });
  });

  it("says a logger must be an object", () => {
    const options: VerifyHandlerOptions = { apiKey: KEY, chains: [1] };
    Reflect.set(options, "logger", "console");
    const { details } = thrown(() => createVerifyHandler(options));
    assert.deepEqual(details, {
      code: "invalid-input",
      issues: [{ field: "logger", message: "must be an object" }],
    });
  });
});
