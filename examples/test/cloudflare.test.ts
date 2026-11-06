// The Cloudflare Workers example (examples/server-cloudflare): the Worker's `fetch` called with the
// Request a browser on the dapp's origin sends through handlerUrl, against
// recorded Etherscan answers (R-SRV-1, R-SRV-2, R-SRV-4, R-SRV-5), its CORS answers, and the key
// never in a response or a log line (R-SEC-1).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import { SOURCE_MARKER } from "explorer-verify/server";

import { verifyFromBrowser, WORKER_URL } from "../server-cloudflare/client/verify-client.ts";
import worker from "../server-cloudflare/src/index.ts";
import type { Env } from "../server-cloudflare/src/index.ts";
import {
  answer,
  captureConsole,
  CHAIN,
  clientRequest,
  DEPLOYER,
  ETHERSCAN_API_URL,
  KEY,
  network,
  greeterInput,
  inPage,
  recorded,
  toHandler,
} from "./network.ts";

const DAPP = "https://your-dapp.example";
const WORKER = new URL(WORKER_URL).origin;
const SUBMIT = recorded("2026-11-03-verifysourcecode-factory-child");
const STATUS = recorded("2026-11-03-checkverifystatus-factory-child-02-pass");
const LOOKUP = recorded("2026-11-03-getsourcecode-factory-child-verified");
const CREATION = recorded("2026-11-03-getcontractcreation-factory-children");

/** The bindings as the runtime passes them: the secret, the var and, optionally, the deployers. */
function bindings(deployers?: string): Env {
  return deployers === undefined
    ? { ETHERSCAN_API_KEY: KEY, ALLOWED_ORIGIN: DAPP }
    : { ETHERSCAN_API_KEY: KEY, ALLOWED_ORIGIN: DAPP, VERIFY_DEPLOYERS: deployers };
}

/** A browser on `origin` that calls the Worker through handlerUrl. */
function browser(
  t: TestContext,
  env: Env,
  answers: readonly Response[],
  origin: string = DAPP,
): {
  viaHandler: ReturnType<typeof toHandler>;
  net: ReturnType<typeof network>;
  lines: string[];
} {
  const serve = async (request: Request): Promise<Response> => await worker.fetch(request, env);
  const net = network(WORKER, serve, { origin, "sec-fetch-site": "cross-site" }, answers);
  t.mock.method(globalThis, "fetch", net.fetch);
  return { viaHandler: toHandler(WORKER_URL), net, lines: captureConsole(t) };
}

/** A CORS preflight for a POST from `origin`. */
function preflight(origin: string): Request {
  return new Request(WORKER_URL, {
    method: "OPTIONS",
    headers: { origin, "access-control-request-method": "POST" },
  });
}

/** The `code` of a refusal body. */
async function codeOf(response: Response): Promise<unknown> {
  return Reflect.get(Object(await response.json()), "code");
}

describe("examples/server-cloudflare", () => {
  it("forwards a submit for a contract of an allowed deployer, with CORS for the dapp", async (t) => {
    const { viaHandler, net } = browser(t, bindings(`${DEPLOYER},`), [
      answer(CREATION.body),
      answer(SUBMIT.body, SUBMIT.status),
    ]);
    const response = await viaHandler(...clientRequest(SUBMIT.fields));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), DAPP);
    assert.equal(response.headers.get("access-control-expose-headers"), "retry-after");
    assert.equal(response.headers.get("vary"), "Origin");
    assert.deepEqual(await response.json(), SUBMIT.body);
    assert.deepEqual(
      net.upstream.map((call) => call.form.get("action")),
      ["getcontractcreation", "verifysourcecode"],
    );
    for (const call of net.upstream) {
      assert.equal(call.url, `${ETHERSCAN_API_URL}?chainid=${String(CHAIN)}`);
      assert.equal(call.form.get("apikey"), KEY);
    }
  });

  it("forwards a status poll and reuses one handler per env", async (t) => {
    const env = bindings();
    const { viaHandler, net } = browser(t, env, [
      answer(STATUS.body, STATUS.status),
      answer(STATUS.body, STATUS.status),
    ]);
    for (let poll = 0; poll < 2; poll += 1) {
      const response = await viaHandler(...clientRequest(STATUS.fields));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), STATUS.body);
    }
    assert.equal(net.upstream.length, 2);
  });

  it("answers a lookup in the reduced shape the client reads", async (t) => {
    const { viaHandler, net } = browser(t, bindings(), [answer(LOOKUP.body)]);
    const response = await viaHandler(...clientRequest(LOOKUP.fields));
    assert.equal(response.status, 200);
    const body: unknown = await response.json();
    const first: unknown = Reflect.get(Object(Reflect.get(Object(body), "result")), 0);
    assert.equal(Reflect.get(Object(first), "SourceCode"), SOURCE_MARKER);
    assert.equal(Reflect.get(Object(first), "ContractName"), "ProbeDChild");
    assert.equal(Reflect.get(Object(first), "ABI"), undefined);
    assert.equal(net.upstream.length, 1, "no deployer check without VERIFY_DEPLOYERS");
  });

  it("refuses a GET, which carries no body", async (t) => {
    const { viaHandler, net } = browser(t, bindings(), []);
    const [url] = clientRequest(STATUS.fields);
    const get = await viaHandler(url, { method: "GET", headers: { "x-test": "1" } });
    assert.equal(get.status, 405);
    assert.equal(net.upstream.length, 0);
  });

  it("answers the preflight for the dapp's origin only", async () => {
    const allowed = await worker.fetch(preflight(DAPP), bindings());
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get("access-control-allow-origin"), DAPP);
    assert.equal(allowed.headers.get("access-control-allow-methods"), "POST");
    const other = await worker.fetch(preflight("https://other.example"), bindings());
    assert.equal(other.headers.get("access-control-allow-origin"), null);
  });

  it("refuses a POST from another origin, without CORS headers", async (t) => {
    const { viaHandler, net } = browser(t, bindings(), [], "https://other.example");
    const response = await viaHandler(...clientRequest(STATUS.fields));
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.equal(response.headers.get("access-control-expose-headers"), null);
    assert.equal(await codeOf(response), "rate-limited");
    assert.equal(net.upstream.length, 0);
  });

  it("refuses a request without Origin that a browser marks cross-site", async (t) => {
    const lines = captureConsole(t);
    const [url, init] = clientRequest(STATUS.fields);
    const request = new Request(`${WORKER_URL}${new URL(url).search}`, {
      ...init,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "cross-site",
      },
    });
    const response = await worker.fetch(request, bindings());
    assert.equal(response.status, 429);
    assert.equal(lines.length, 1, "the refusal is logged at info");
  });

  it("answers 404 off its route and refuses a chain outside its allowlist", async (t) => {
    assert.equal((await worker.fetch(new Request(`${WORKER}/other`), bindings())).status, 404);
    const { viaHandler } = browser(t, bindings(), []);
    const response = await viaHandler(...clientRequest(STATUS.fields, 10));
    assert.equal(response.status, 403);
    assert.equal(await codeOf(response), "chain-not-allowed");
  });

  it("never returns or logs the key, even when Etherscan echoes it", async (t) => {
    const echo = { status: "0", message: "NOTOK", result: `Invalid API Key ${KEY}` };
    const { viaHandler, lines } = browser(t, bindings(), [
      answer(echo),
      // Not JSON: refused with 502 and logged at warn, with no retry and so no wait.
      new Response("<html>bad gateway</html>", { status: 200 }),
    ]);
    // An echoed key, an upstream failure (logged at warn) and two refusals (logged at info).
    const requests: [Record<string, string>, number][] = [
      [STATUS.fields, CHAIN],
      [STATUS.fields, CHAIN],
      [STATUS.fields, 10],
      [{ module: "account", action: "balance" }, CHAIN],
    ];
    const shown: string[] = [];
    for (const [fields, chain] of requests) {
      const response = await viaHandler(...clientRequest(fields, chain));
      shown.push(
        String(response.status),
        JSON.stringify([...response.headers]),
        await response.text(),
      );
    }
    assert.match(shown.join("\n"), /\[redacted\]/);
    assert.ok(!shown.join("\n").includes(KEY), "a response holds the key");
    assert.ok(lines.length > 0, "the refusals and the upstream failure are logged");
    for (const line of lines) {
      assert.ok(!line.includes(KEY), `a log line holds the key: ${line}`);
    }
  });

  it("verifyFromBrowser sends each Etherscan request to the Worker, with no key", async (t) => {
    const { result, sent } = await inPage(
      t,
      `${DAPP}/app/`,
      async () => await verifyFromBrowser(greeterInput()),
    );
    assert.equal(result.status, "already-verified");
    assert.equal(result.backend, "etherscan-v2");
    assert.equal(sent.length, 1);
    const [first = ""] = sent;
    assert.ok(first.startsWith(`${WORKER_URL}?chainid=11155111 `), first);
    assert.ok(!first.includes("apikey"), first);
  });
});
