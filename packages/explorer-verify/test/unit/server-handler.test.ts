// Integration tests of createVerifyHandler against a fake Etherscan (R-QA-3): each guard, each
// refused action, requests that try to use the handler as an open proxy or to make it leak the
// key, and the key never in a response (R-SRV-1 to R-SRV-5, R-SEC-1, R-SEC-2, decision 0016).
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { inspect } from "node:util";

import { ExplorerVerifyError } from "../../src/errors.ts";
import {
  createVerifyHandler,
  DEFAULT_HANDLER_TIMEOUT_MS,
  DEFAULT_MAX_BODY_BYTES,
} from "../../src/server/handler.ts";
import type { VerifyHandlerOptions } from "../../src/server/handler.ts";
import { etherscanFixture, fakeExplorer, json } from "../helpers/fake-explorer.ts";
import type { ExplorerStep } from "../helpers/fake-explorer.ts";

// A made-up key. Never a real one (R-SEC-1). It matches no redaction pattern, so only the
// known-key rule can hide it: a test that finds it hidden proves that rule ran.
const KEY = "dummy.key_abc~def-0001";
const ETHERSCAN_API_URL = "https://api.etherscan.io/v2/api";
const HANDLER_URL = "https://dapp.example/api/verify";
const ARB_SEPOLIA = 421614;
const SUBMIT = etherscanFixture("2026-11-03-verifysourcecode-factory-child");
const STATUS = etherscanFixture("2026-11-03-checkverifystatus-factory-child-02-pass");
const CREATION = etherscanFixture("2026-11-03-getcontractcreation-factory-children");
const DEPLOYER = "0x9d087fc03ae39b088326b67fa3c788236645b717";
const FACTORY = "0x6355ef85c81f3545ad9cb404f3defb7f219810ec";
const OTHER = "0x00000000000000000000000000000000000000aa";
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
    chains: [ARB_SEPOLIA, 11155111],
    fetch: explorer.fetch,
    ...options,
  });
  return { handler, explorer };
}

/** A form POST to the handler, as the Etherscan v2 client sends it through an injected fetch. */
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

/** A form POST whose body is a stream with no Content-Length. */
function streamed(stream: ReadableStream<Uint8Array>): Request {
  // `duplex` is required for a stream body, and the DOM types do not declare it yet.
  const init: RequestInit & { readonly duplex: "half" } = {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: stream,
    duplex: "half",
  };
  return new Request(HANDLER_URL, init);
}

/** Everything a response shows: status, headers and body. */
async function shown(response: Response): Promise<string> {
  return [
    String(response.status),
    ...[...response.headers].map(([name, value]) => `${name}: ${value}`),
    await response.text(),
  ].join("\n");
}

async function refusal(
  response: Response,
): Promise<{ status: number; code: unknown; result: unknown; text: string }> {
  const text = await response.text();
  const body: unknown = JSON.parse(text);
  assert.equal(Reflect.get(Object(body), "status"), "0");
  assert.equal(Reflect.get(Object(body), "message"), "NOTOK");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.ok(!text.includes(KEY));
  return {
    status: response.status,
    code: Reflect.get(Object(body), "code"),
    result: Reflect.get(Object(body), "result"),
    text,
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

function surfaces(error: ExplorerVerifyError): string {
  return [
    error.message,
    error.hint,
    JSON.stringify(error),
    JSON.stringify(error.details),
    String(error),
    error.stack ?? "",
    inspect(error, { depth: Infinity, showHidden: true }),
  ].join("\n");
}

function issuesOf(error: ExplorerVerifyError): string[] {
  assert.equal(error.details.code, "invalid-input");
  return error.details.code === "invalid-input"
    ? error.details.issues.map((issue) => `${issue.field}: ${issue.message}`)
    : [];
}

describe("createVerifyHandler forwards verify and status requests (R-SRV-1, R-SRV-2, R-SRV-5)", () => {
  it("forwards a recorded submit to Etherscan with the key in the form body, and returns the answer", async () => {
    const { handler, explorer } = setup([json(SUBMIT.body)]);
    const response = await handler(post(SUBMIT.fields, `?chainid=${SUBMIT.chainId}`));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), SUBMIT.body);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(explorer.calls.length, 1);
    const [call] = explorer.calls;
    assert.ok(call !== undefined);
    assert.equal(call.url, `${ETHERSCAN_API_URL}?chainid=${SUBMIT.chainId}`);
    assert.equal(call.method, "POST");
    assert.equal(call.redirect, "manual");
    assert.equal(call.headers.get("content-type"), "application/x-www-form-urlencoded");
    assert.equal(call.form.get("apikey"), KEY);
    assert.equal(call.form.getAll("apikey").length, 1);
    assert.ok(!call.url.includes(KEY), "the key never goes in the URL");
    for (const [field, value] of Object.entries(SUBMIT.fields)) {
      assert.equal(call.form.get(field), value, field);
    }
    assert.deepEqual(
      [...call.form.keys()].toSorted(),
      [...Object.keys(SUBMIT.fields), "apikey"].toSorted(),
    );
  });

  it("forwards a recorded status poll, with chainid in the body", async () => {
    const { handler, explorer } = setup([json(STATUS.body)]);
    const response = await handler(post({ ...STATUS.fields, chainid: STATUS.chainId }, ""));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), STATUS.body);
    const [call] = explorer.calls;
    assert.ok(call !== undefined);
    assert.equal(call.url, `${ETHERSCAN_API_URL}?chainid=${STATUS.chainId}`);
    assert.deepEqual([...call.form.keys()], ["module", "action", "guid", "apikey"]);
    assert.equal(call.form.get("action"), "checkverifystatus");
  });

  it("returns an upstream error answer with its status", async () => {
    const answer = { status: "0", message: "NOTOK", result: "Fail - Unable to verify" };
    const { handler } = setup([json(answer, 500)]);
    const response = await handler(post(SUBMIT.fields));
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), answer);
  });

  it("sends no header of the client's request upstream", async () => {
    const { handler, explorer } = setup([json(OK_GUID)]);
    await handler(
      post(SUBMIT.fields, undefined, {
        authorization: "Bearer client-token-123456",
        apikey: "CLIENTKEY123456789",
        "x-api-key": "CLIENTKEY123456789",
        cookie: "session=abc",
        "x-forwarded-host": "evil.example",
        origin: "https://evil.example",
      }),
    );
    const [call] = explorer.calls;
    assert.ok(call !== undefined);
    assert.deepEqual([...call.headers.keys()], ["content-type"]);
  });

  it("re-encodes the fields, so a value cannot add a parameter upstream", async () => {
    const { handler, explorer } = setup([json(OK_GUID)]);
    const smuggled = {
      ...SUBMIT.fields,
      contractname: "a.sol:A&action=getsourcecode&apikey=ATTACKERKEY123&chainid=1",
    };
    const response = await handler(post(smuggled));
    assert.equal(response.status, 200);
    const [call] = explorer.calls;
    assert.ok(call !== undefined);
    assert.deepEqual(call.form.getAll("action"), ["verifysourcecode"]);
    assert.deepEqual(call.form.getAll("apikey"), [KEY]);
    assert.equal(call.form.get("chainid"), null);
    assert.equal(call.form.get("contractname"), smuggled.contractname);
  });

  it("accepts a content type with a charset, and a body exactly at the limit", async () => {
    const body = new URLSearchParams(SUBMIT.fields).toString();
    const { handler } = setup([json(OK_GUID)], { maxBodyBytes: body.length });
    const response = await handler(
      post(body, undefined, { "content-type": "Application/X-WWW-Form-Urlencoded; charset=UTF-8" }),
    );
    assert.equal(response.status, 200);
  });

  it("accepts optional submit fields in the forms the client sends", async () => {
    const { handler, explorer } = setup([json(OK_GUID)]);
    const fields = {
      ...SUBMIT.fields,
      constructorArguements: "00ff",
      constructorArguments: "0x00ff",
      licenseType: "3",
    };
    assert.equal((await handler(post(fields))).status, 200);
    assert.equal(explorer.calls[0]?.form.get("licenseType"), "3");
  });
});

describe("createVerifyHandler guards (R-SRV-3, R-SRV-4)", () => {
  it("refuses every method but POST with 405 and Allow: POST", async () => {
    for (const method of ["GET", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"]) {
      const { handler, explorer } = setup();
      const response = await handler(new Request(`${HANDLER_URL}?chainid=1`, { method }));
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.get("allow"), "POST");
      if (method !== "HEAD") {
        assert.equal((await refusal(response)).code, "method-not-allowed");
      }
      assert.equal(explorer.calls.length, 0);
    }
  });

  it("refuses a body that is not form-encoded with 415", async () => {
    for (const type of ["application/json", "text/plain", "multipart/form-data; boundary=x", ""]) {
      const { handler, explorer } = setup();
      const response = await handler(
        new Request(HANDLER_URL, {
          method: "POST",
          headers: type === "" ? {} : { "content-type": type },
          body: JSON.stringify({ module: "contract", action: "verifysourcecode" }),
        }),
      );
      // A string body gets text/plain from the Request constructor when no type is set.
      const { status, code } = await refusal(response);
      assert.equal(status, 415, type);
      assert.equal(code, "unsupported-media-type");
      assert.equal(explorer.calls.length, 0);
    }
  });

  it("refuses a body above the limit by its Content-Length with 413, before reading it", async () => {
    const { handler, explorer } = setup([], { maxBodyBytes: 100 });
    const request = new Request(HANDLER_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "content-length": "101" },
      body: "module=contract",
    });
    const { status, code } = await refusal(await handler(request));
    assert.equal(status, 413);
    assert.equal(code, "body-too-large");
    assert.equal(request.bodyUsed, false);
    assert.equal(explorer.calls.length, 0);
  });

  it("refuses a streamed body that passes the limit with 413, and stops reading it", async () => {
    const { handler, explorer } = setup([], { maxBodyBytes: 1024 });
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode("a".repeat(512)));
      },
    });
    const request = streamed(stream);
    const { status, code } = await refusal(await handler(request));
    assert.equal(status, 413);
    assert.equal(code, "body-too-large");
    assert.ok(pulled <= 4, `read ${String(pulled)} chunks`);
    assert.equal(explorer.calls.length, 0);
  });

  it("refuses a body that cannot be read with 400", async () => {
    const { handler } = setup();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error(`broken ${KEY}`));
      },
    });
    const request = streamed(stream);
    const { status, code } = await refusal(await handler(request));
    assert.equal(status, 400);
    assert.equal(code, "bad-request");
  });

  it("reads a POST without a body as no fields, and refuses it", async () => {
    const { handler, explorer } = setup();
    const request = new Request(HANDLER_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const { status, code } = await refusal(await handler(request));
    assert.equal(status, 403);
    assert.equal(code, "action-not-allowed");
    assert.equal(explorer.calls.length, 0);
  });

  it("has an 8 MiB body limit and a 20 s time limit by default", () => {
    assert.equal(DEFAULT_MAX_BODY_BYTES, 8 * 1024 * 1024);
    assert.equal(DEFAULT_HANDLER_TIMEOUT_MS, 20_000);
  });

  it("calls the rate limit hook before reading the body, and refuses with 429 when it says no", async () => {
    const seen: Request[] = [];
    const { handler, explorer } = setup([], {
      rateLimit: (request) => {
        seen.push(request);
        assert.equal(request.bodyUsed, false);
        return false;
      },
    });
    const { status, code } = await refusal(await handler(post(SUBMIT.fields)));
    assert.equal(status, 429);
    assert.equal(code, "rate-limited");
    assert.equal(seen.length, 1);
    assert.equal(explorer.calls.length, 0);
  });

  it("goes on when the async rate limit hook says yes", async () => {
    const { handler } = setup([json(OK_GUID)], {
      rateLimit: async () => await Promise.resolve(true),
    });
    assert.equal((await handler(post(SUBMIT.fields))).status, 200);
  });

  it("answers 500 without the error when the rate limit hook throws", async () => {
    const { handler, explorer } = setup([], {
      rateLimit: () => {
        throw new Error(`hook failed for ${KEY}`);
      },
    });
    const { status, code, text } = await refusal(await handler(post(SUBMIT.fields)));
    assert.equal(status, 500);
    assert.equal(code, "internal-error");
    assert.ok(!text.includes("hook failed"));
    assert.equal(explorer.calls.length, 0);
  });

  it("forwards only verifysourcecode, checkverifystatus and getsourcecode of module contract (R-SRV-3)", async () => {
    const refused = [
      { module: "contract", action: "getabi", address: OTHER },
      { module: "contract", action: "getcontractcreation", contractaddresses: OTHER },
      { module: "contract", action: "verifyproxycontract", address: OTHER },
      { module: "contract", action: "checkproxyverification", guid: "abc" },
      { module: "contract", action: "VerifySourceCode" },
      { module: "contract", action: "verifysourcecode " },
      { module: "account", action: "balance", address: OTHER },
      { module: "account", action: "txlist", address: OTHER },
      { module: "proxy", action: "eth_call", to: OTHER, data: "0x" },
      { module: "Contract", action: "verifysourcecode" },
      { module: "contract" },
      { action: "verifysourcecode" },
      {},
    ];
    for (const fields of refused) {
      const { handler, explorer } = setup();
      const { status, code } = await refusal(await handler(post(fields)));
      assert.equal(status, 403, JSON.stringify(fields));
      assert.equal(code, "action-not-allowed");
      assert.equal(explorer.calls.length, 0);
    }
  });

  it("refuses a chain that is not in the allowlist with 403", async () => {
    const { handler, explorer } = setup();
    const { status, code } = await refusal(await handler(post(SUBMIT.fields, "?chainid=1")));
    assert.equal(status, 403);
    assert.equal(code, "chain-not-allowed");
    assert.equal(explorer.calls.length, 0);
  });

  it("refuses a chainid that is missing or not a plain positive integer with 400", async () => {
    for (const query of [
      "",
      "?chainid=",
      "?chainid=0",
      "?chainid=-1",
      "?chainid=0421614",
      "?chainid=421614.0",
      "?chainid=4e5",
      "?chainid=0x66eee",
      "?chainid=%20421614",
      "?chainid=99999999999999999",
    ]) {
      const { handler, explorer } = setup();
      const { status, code } = await refusal(await handler(post(SUBMIT.fields, query)));
      assert.equal(status, 400, query);
      assert.equal(code, "bad-request");
      assert.equal(explorer.calls.length, 0);
    }
  });

  it("refuses a field given twice, in the query and the body or in one of them", async () => {
    const cases: [Record<string, string> | string, string][] = [
      [SUBMIT.fields, `?chainid=${String(ARB_SEPOLIA)}&chainid=1`],
      [{ ...SUBMIT.fields, chainid: String(ARB_SEPOLIA) }, `?chainid=${String(ARB_SEPOLIA)}`],
      [`${new URLSearchParams(SUBMIT.fields).toString()}&action=getsourcecode`, "?chainid=421614"],
      [SUBMIT.fields, "?chainid=421614&action=getsourcecode"],
    ];
    for (const [fields, query] of cases) {
      const { handler, explorer } = setup();
      const { status, code } = await refusal(await handler(post(fields, query)));
      assert.equal(status, 400, query);
      assert.equal(code, "bad-request");
      assert.equal(explorer.calls.length, 0);
    }
  });

  it("refuses a field the action does not take, counted and never named", async () => {
    const { handler, explorer } = setup();
    const { status, code, text } = await refusal(
      await handler(post({ ...STATUS.fields, Module: "contract", secretname: "x" })),
    );
    assert.equal(status, 400);
    assert.equal(code, "bad-request");
    assert.ok(text.includes("2 fields"), text);
    assert.ok(!text.includes("secretname") && !text.includes("Module"), text);
    assert.equal(explorer.calls.length, 0);

    const one = await refusal(
      await setup().handler(post({ ...STATUS.fields, contractaddress: OTHER })),
    );
    assert.ok(one.text.includes("1 field that"), one.text);
  });

  it("refuses a missing or empty required field with 400, naming the field", async () => {
    const { contractaddress: _dropped, ...withoutAddress } = SUBMIT.fields;
    for (const fields of [
      withoutAddress,
      { ...SUBMIT.fields, sourceCode: "" },
      { ...STATUS.fields, guid: "" },
    ]) {
      const { handler, explorer } = setup();
      const { status, result } = await refusal(await handler(post(fields)));
      assert.equal(status, 400);
      assert.match(String(result), /^Missing fields: (contractaddress|sourceCode|guid)\.$/);
      assert.equal(explorer.calls.length, 0);
    }
  });

  it("refuses a value of the wrong form with 400, naming the field and not the value", async () => {
    const cases: [Record<string, string>, string][] = [
      [{ ...SUBMIT.fields, contractaddress: "0x1234" }, "contractaddress"],
      [{ ...SUBMIT.fields, contractaddress: "http://169.254.169.254/" }, "contractaddress"],
      [{ ...STATUS.fields, guid: "../../account?x=1" }, "guid"],
      [{ ...STATUS.fields, guid: "http:evil.example" }, "guid"],
      [{ ...SUBMIT.fields, compilerversion: "latest" }, "compilerversion"],
      [{ ...SUBMIT.fields, codeformat: "Solidity Standard JSON" }, "codeformat"],
      [{ ...SUBMIT.fields, constructorArguments: "zz" }, "constructorArguments"],
      [{ ...SUBMIT.fields, constructorArguements: "0xgg" }, "constructorArguements"],
      [{ ...SUBMIT.fields, licenseType: "MIT" }, "licenseType"],
      [{ ...SUBMIT.fields, contractname: "a".repeat(1025) }, "contractname"],
    ];
    for (const [fields, field] of cases) {
      const { handler, explorer } = setup();
      const { status, code, result, text } = await refusal(await handler(post(fields)));
      assert.equal(status, 400, field);
      assert.equal(code, "bad-request");
      assert.equal(result, `Invalid fields: ${field}.`);
      assert.ok(!text.includes("169.254") && !text.includes("evil.example"));
      assert.equal(explorer.calls.length, 0);
    }
  });

  describe("deployers: the address must come from an allowed deployer or factory (R-SRV-4)", () => {
    // D1, a factory child on Arbitrum Sepolia, created by FACTORY in a transaction from DEPLOYER.
    const child = "0x80798fEd44d6ec40d283bD44DDb08A6Eb2d30BE5";
    const submit = { ...SUBMIT.fields, contractaddress: child };

    it("forwards a submit whose creator is allowed, after a keyed getcontractcreation", async () => {
      const { handler, explorer } = setup([json(CREATION.body), json(OK_GUID)], {
        deployers: [DEPLOYER.toUpperCase().replace("0X", "0x")],
      });
      const response = await handler(post(submit));
      assert.equal(response.status, 200);
      assert.equal(explorer.calls.length, 2);
      const [lookup, forwarded] = explorer.calls;
      assert.ok(lookup !== undefined && forwarded !== undefined);
      assert.equal(lookup.url, `${ETHERSCAN_API_URL}?chainid=${String(ARB_SEPOLIA)}`);
      assert.equal(lookup.method, "POST");
      assert.equal(lookup.redirect, "manual");
      assert.deepEqual(Object.fromEntries(lookup.form), {
        module: "contract",
        action: "getcontractcreation",
        contractaddresses: child.toLowerCase(),
        apikey: KEY,
      });
      assert.equal(forwarded.form.get("action"), "verifysourcecode");
    });

    it("forwards a submit whose factory is allowed", async () => {
      const { handler } = setup([json(CREATION.body), json(OK_GUID)], { deployers: [FACTORY] });
      assert.equal((await handler(post(submit))).status, 200);
    });

    it("refuses a submit that no allowed address created, with one upstream request", async () => {
      const { handler, explorer } = setup([json(CREATION.body)], { deployers: [OTHER] });
      const { status, code } = await refusal(await handler(post(submit)));
      assert.equal(status, 403);
      assert.equal(code, "address-not-allowed");
      assert.equal(explorer.calls.length, 1);
    });

    it("refuses with 403 only when a record names no allowed address", async () => {
      const answers = [
        {
          status: "1",
          message: "OK",
          result: [null, 1, { contractAddress: OTHER, contractCreator: DEPLOYER }],
        },
        { status: "1", message: "OK", result: [{ contractAddress: child, contractCreator: 5 }] },
      ];
      for (const answer of answers) {
        const { handler } = setup([json(answer)], { deployers: [DEPLOYER] });
        const { status, code } = await refusal(await handler(post(submit)));
        assert.equal(status, 403, JSON.stringify(answer));
        assert.equal(code, "address-not-allowed");
      }
    });

    it("never turns a transient creation answer into a 403 (R-SRV-4)", async () => {
      const cases: [Response, number, string][] = [
        [json({ status: "0", message: "No data found", result: [] }), 503, "address-not-indexed"],
        [
          json({ status: "0", message: "NOTOK", result: "No data found" }),
          503,
          "address-not-indexed",
        ],
        [json({ status: "0", message: "NOTOK", result: [] }), 503, "address-not-indexed"],
        [json({ status: "1", message: "OK", result: [] }), 503, "address-not-indexed"],
        [
          json({
            status: "0",
            message: "NOTOK",
            result: "Max calls per sec rate limit reached (3/sec)",
          }),
          429,
          "upstream-rate-limited",
        ],
        [
          json({
            status: "0",
            message: "NOTOK",
            result: "Max daily rate limit reached. 100000 (100%) of 100000 day/limit",
          }),
          429,
          "upstream-rate-limited",
        ],
        [json({ status: "0", message: "NOTOK", result: "Something else" }), 502, "upstream-error"],
        [json({ status: "1", message: "OK", result: "not an array" }), 502, "upstream-error"],
        [json({ status: 1, message: "OK", result: [] }), 502, "upstream-error"],
        [json(CREATION.body, 404), 502, "upstream-error"],
        [json(CREATION.body, 500), 502, "upstream-error"],
      ];
      for (const [answer, wantStatus, wantCode] of cases) {
        const { handler, explorer } = setup([answer], { deployers: [DEPLOYER] });
        const response = await handler(post(submit));
        const retryAfter = response.headers.get("retry-after");
        const { status, code } = await refusal(response);
        assert.equal(status, wantStatus, wantCode);
        assert.equal(code, wantCode);
        assert.equal(retryAfter, wantCode === "address-not-indexed" ? "5" : null);
        assert.equal(explorer.calls.length, 1, "the submit is never sent");
      }
    });

    it("passes a key answer of the creation lookup through, redacted", async () => {
      for (const result of ["Missing/Invalid API Key", `Invalid API Key (#err2) ${KEY}`]) {
        const { handler, explorer } = setup([json({ status: "0", message: "NOTOK", result })], {
          deployers: [DEPLOYER],
        });
        const response = await handler(post(submit));
        const text = await response.text();
        assert.equal(response.status, 200);
        assert.ok(text.includes("API Key") && !text.includes(KEY), text);
        assert.equal(explorer.calls.length, 1);
      }
    });

    it("does not look up a status poll", async () => {
      const { handler, explorer } = setup([json(STATUS.body)], { deployers: [OTHER] });
      assert.equal((await handler(post(STATUS.fields))).status, 200);
      assert.equal(explorer.calls.length, 1);
    });
  });
});

describe("createVerifyHandler is not an open proxy (R-SRV-3, R-SEC-2)", () => {
  it("refuses a request that names a route, an API URL, a backend, a host or a key, in any case", async () => {
    const attempts: [Record<string, string>, string][] = [
      [
        { ...SUBMIT.fields, route: JSON.stringify({ apiUrl: "http://127.0.0.1:8545" }) },
        "?chainid=421614",
      ],
      [{ ...SUBMIT.fields, apiUrl: "http://169.254.169.254/latest/meta-data" }, "?chainid=421614"],
      [SUBMIT.fields, "?chainid=421614&apiUrl=http%3A%2F%2Flocalhost%3A6379"],
      [SUBMIT.fields, "?chainid=421614&APIURL=https%3A%2F%2Fevil.example"],
      [{ ...SUBMIT.fields, api_url: "https://evil.example" }, "?chainid=421614"],
      [{ ...SUBMIT.fields, backend: "etherscan-compatible" }, "?chainid=421614"],
      [{ ...SUBMIT.fields, url: "https://evil.example/v2/api" }, "?chainid=421614"],
      [{ ...SUBMIT.fields, host: "evil.example" }, "?chainid=421614"],
      [{ ...SUBMIT.fields, apikey: "CLIENTKEY123456789" }, "?chainid=421614"],
      [SUBMIT.fields, "?chainid=421614&ApiKey=CLIENTKEY123456789"],
      [{ ...SUBMIT.fields, "x-api-key": "CLIENTKEY123456789" }, "?chainid=421614"],
      [{ ...SUBMIT.fields, "API-KEY": "CLIENTKEY123456789" }, "?chainid=421614"],
      [{ ...STATUS.fields, route: "x" }, "?chainid=421614"],
      [{ module: "account", action: "balance", apiUrl: "https://evil.example" }, "?chainid=1"],
    ];
    for (const [fields, query] of attempts) {
      const { handler, explorer } = setup();
      const { status, code, text } = await refusal(await handler(post(fields, query)));
      assert.equal(status, 400, `${JSON.stringify(fields)} ${query}`);
      assert.equal(code, "forbidden-field");
      for (const value of ["169.254", "evil.example", "localhost", "127.0.0.1", "CLIENTKEY"]) {
        assert.ok(!text.includes(value), value);
      }
      assert.equal(explorer.calls.length, 0);
    }
  });

  it("always sends to api.etherscan.io, whatever the handler URL, path or Host header", async () => {
    const urls = [
      "https://dapp.example/api/verify",
      "http://127.0.0.1:8545/",
      "https://evil.example/v2/api",
      "https://dapp.example/api/verify/..%2F..%2Fevil.example",
      "https://dapp.example/proxy/https://evil.example/",
    ];
    for (const base of urls) {
      const { handler, explorer } = setup([json(OK_GUID)]);
      const request = new Request(`${base}?chainid=${String(ARB_SEPOLIA)}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", host: "evil.example" },
        body: new URLSearchParams(SUBMIT.fields),
      });
      assert.equal((await handler(request)).status, 200, base);
      assert.equal(explorer.calls[0]?.url, `${ETHERSCAN_API_URL}?chainid=${String(ARB_SEPOLIA)}`);
    }
  });

  it("never follows a redirect: sets redirect manual and refuses a 3xx with 502", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const { handler, explorer } = setup([
        new Response(null, { status, headers: { location: "https://evil.example/collect" } }),
      ]);
      const response = await handler(post(SUBMIT.fields));
      assert.equal(response.headers.get("location"), null);
      const refused = await refusal(response);
      assert.equal(refused.status, 502, String(status));
      assert.equal(refused.code, "upstream-error");
      assert.ok(!refused.text.includes("evil.example"));
      assert.equal(explorer.calls.length, 1, "the redirect target is never requested");
      assert.equal(explorer.calls[0]?.redirect, "manual");
    }
  });

  it("refuses a redirect during the deployer lookup too", async () => {
    const { handler, explorer } = setup(
      [new Response(null, { status: 302, headers: { location: "https://evil.example/" } })],
      { deployers: [DEPLOYER] },
    );
    const { status } = await refusal(await handler(post(SUBMIT.fields)));
    assert.equal(status, 502);
    assert.equal(explorer.calls.length, 1);
  });
});

describe("createVerifyHandler never shows the key (R-SEC-1)", () => {
  it("redacts the key from an upstream answer that echoes it", async () => {
    const echo = {
      status: "0",
      message: "NOTOK",
      result: `Invalid API Key (#err2) ${KEY} apikey=${KEY}`,
      apikey: KEY,
    };
    const { handler } = setup([json(echo)]);
    const response = await handler(post(SUBMIT.fields));
    const text = await shown(response);
    assert.ok(!text.includes(KEY), text);
    assert.ok(text.includes("[redacted]"));
    assert.equal(response.status, 200);
  });

  it("refuses an upstream answer that is not a JSON object with 502, without its text", async () => {
    for (const body of [`<html>${KEY}</html>`, "[1,2]", "null", ""]) {
      const { handler } = setup([new Response(body, { status: 200 })]);
      const { status, code, text } = await refusal(await handler(post(SUBMIT.fields)));
      assert.equal(status, 502, body);
      assert.equal(code, "upstream-error");
      assert.ok(!text.includes("html"));
    }
  });

  it("answers 502 when Etherscan cannot be reached, without the network error", async () => {
    const { handler } = setup([new TypeError(`fetch failed: ${KEY} https://api.etherscan.io`)]);
    const { status, code, text } = await refusal(await handler(post(SUBMIT.fields)));
    assert.equal(status, 502);
    assert.equal(code, "upstream-error");
    assert.ok(!text.includes("fetch failed"));
  });

  it("passes an upstream 429 on as 429 with its Retry-After, without retrying a long wait", async () => {
    const { handler, explorer } = setup([
      json({ status: "0", message: "NOTOK", result: "Max calls per sec rate limit reached" }, 429, {
        "retry-after": "120",
      }),
    ]);
    const response = await handler(post(STATUS.fields));
    assert.equal(response.headers.get("retry-after"), "120");
    const { status, code } = await refusal(response);
    assert.equal(status, 429);
    assert.equal(code, "upstream-rate-limited");
    assert.equal(explorer.calls.length, 1);
  });

  it("passes an upstream 429 on without Retry-After when the budget ends the retries", async (t) => {
    // A 1 ms budget leaves no time for a retry, and the answer has no Retry-After. The clock is
    // frozen, so the budget cannot run out before the first attempt.
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const { handler } = setup([json({ status: "0", message: "NOTOK", result: "busy" }, 429)], {
      timeoutMs: 1,
    });
    const response = await handler(post(STATUS.fields));
    assert.equal(response.headers.get("retry-after"), null);
    assert.equal(response.status, 429);
  });

  it("answers 504 when Etherscan does not answer within timeoutMs", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const { handler, explorer } = setup(["hang"], { timeoutMs: 5_000 });
    const pending = handler(post(STATUS.fields));
    await explorer.called;
    t.mock.timers.tick(5_000);
    const { status, code } = await refusal(await pending);
    assert.equal(status, 504);
    assert.equal(code, "upstream-timeout");
  });

  it("answers 500 when the client's request was aborted", async () => {
    const { handler, explorer } = setup();
    const request = new Request(`${HANDLER_URL}?chainid=${String(ARB_SEPOLIA)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(STATUS.fields),
      signal: AbortSignal.abort(new Error(`client gone ${KEY}`)),
    });
    const { status, code, text } = await refusal(await handler(request));
    assert.equal(status, 500);
    assert.equal(code, "internal-error");
    assert.ok(!text.includes("client gone"));
    assert.equal(explorer.calls.length, 0);
  });

  it("shows no key in any response to a run of abusive requests", async () => {
    const abusive: Request[] = [
      new Request(`${HANDLER_URL}?chainid=1&module=account&action=balance&apikey=${KEY}`),
      post({ module: "contract", action: "getsourcecode", address: OTHER }),
      post({ ...SUBMIT.fields, apikey: KEY }),
      post({ ...SUBMIT.fields, apiUrl: "https://evil.example" }),
      post(`${"x=1&".repeat(10)}module=contract`),
      post(SUBMIT.fields, "?chainid=1"),
      post({ ...STATUS.fields, guid: KEY.toLowerCase() }),
      post(STATUS.fields),
      post(SUBMIT.fields),
    ];
    const { handler, explorer } = setup([
      json({ status: "0", message: "NOTOK", result: `Invalid API Key ${KEY}` }),
      json({ status: "1", message: "OK", result: KEY }),
    ]);
    for (const request of abusive) {
      const text = await shown(await handler(request));
      assert.ok(!text.includes(KEY), text);
      assert.ok(!text.toLowerCase().includes(KEY.toLowerCase().slice(0, 20)), text);
    }
    for (const call of explorer.calls) {
      assert.ok(call.url.startsWith(`${ETHERSCAN_API_URL}?chainid=`));
      assert.ok(!call.url.includes(KEY));
    }
  });

  it("keeps the key out of an inspected handler and of option errors", () => {
    const { handler } = setup();
    assert.ok(!inspect(handler, { depth: Infinity, showHidden: true }).includes(KEY));
    const error = thrown(() =>
      createVerifyHandler({ apiKey: KEY, chains: [], fetch: fakeExplorer().fetch }),
    );
    assert.ok(!surfaces(error).includes(KEY));
  });
});

describe("createVerifyHandler checks its options", () => {
  const valid: VerifyHandlerOptions = { apiKey: KEY, chains: [1] };

  it("accepts the minimal options and defaults to globalThis.fetch", async () => {
    const spy = mock.method(globalThis, "fetch", async () => await Promise.resolve(json(OK_GUID)));
    try {
      const handler = createVerifyHandler({ ...valid, chains: [ARB_SEPOLIA] });
      assert.equal((await handler(post(STATUS.fields))).status, 200);
      assert.equal(spy.mock.callCount(), 1);
    } finally {
      spy.mock.restore();
    }
  });

  it("refuses a bad API key without repeating it", () => {
    const bad: unknown[] = [
      undefined,
      42,
      "short",
      "has&ampersand-123",
      "1234567890123",
      "a".repeat(1025),
    ];
    for (const apiKey of bad) {
      const options = { ...valid, apiKey };
      const error = thrown(() => Reflect.apply(createVerifyHandler, undefined, [options]));
      assert.ok(issuesOf(error)[0]?.startsWith("apiKey: "), String(apiKey));
      if (typeof apiKey === "string" && apiKey.length >= 8) {
        assert.ok(!surfaces(error).includes(apiKey));
      }
    }
  });

  it("names each bad field", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ chains: undefined }, "chains: must be an array"],
      [{ chains: [] }, "chains: must hold at least one chain id"],
      [{ chains: [0] }, "chains: must hold only positive safe integers"],
      [{ chains: ["1"] }, "chains: must hold only positive safe integers"],
      [
        { chains: Array.from({ length: 10_001 }, () => 1) },
        "chains: must hold at most 10000 items",
      ],
      [{ deployers: "0x00" }, "deployers: must be an array"],
      [{ deployers: ["0x1234"] }, "deployers: must hold only addresses: 0x and 40 hex digits"],
      [{ rateLimit: true }, "rateLimit: must be a function"],
      [{ fetch: "https://evil.example" }, "fetch: must be a function"],
      [{ maxBodyBytes: 0 }, "maxBodyBytes: must be a positive safe integer"],
      [{ maxBodyBytes: 1.5 }, "maxBodyBytes: must be a positive safe integer"],
      [{ timeoutMs: -1 }, "timeoutMs: must be a positive safe integer"],
      [{ timeoutMs: Infinity }, "timeoutMs: must be a positive safe integer"],
    ];
    for (const [patch, issue] of cases) {
      const options = { ...valid, ...patch };
      const error = thrown(() => Reflect.apply(createVerifyHandler, undefined, [options]));
      assert.deepEqual(issuesOf(error), [issue]);
      assert.ok(!surfaces(error).includes("evil.example"));
    }
  });

  it("refuses options that are not a plain object, or whose fields cannot be read", () => {
    class Options {
      apiKey = KEY;
      chains = [1];
    }
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error(KEY);
        },
      },
    );
    const getter = {
      chains: [1],
      get apiKey(): string {
        throw new Error(`getter ${KEY}`);
      },
    };
    for (const options of [null, "options", new Options(), hostile, getter]) {
      const error = thrown(() => Reflect.apply(createVerifyHandler, undefined, [options]));
      assert.deepEqual(issuesOf(error), ["options: must be a plain object"]);
      assert.ok(!surfaces(error).includes(KEY));
    }
  });

  it("reads only own properties, once, and ignores later changes", async () => {
    const explorer = fakeExplorer(json(OK_GUID));
    const chains = [ARB_SEPOLIA];
    const options: { apiKey: string; chains: number[]; fetch: typeof fetch } = {
      apiKey: KEY,
      chains,
      fetch: explorer.fetch,
    };
    Object.setPrototypeOf(options, null);
    const handler = createVerifyHandler(options);
    chains.push(1);
    options.fetch = async () => await Promise.reject(new Error("a later fetch was used"));
    assert.equal((await handler(post(STATUS.fields))).status, 200);
    const refused = await refusal(await handler(post(STATUS.fields, "?chainid=1")));
    assert.equal(refused.status, 403);
  });
});
