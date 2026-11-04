// End-to-end tests of createVerifyHandler over real HTTP on 127.0.0.1, with the real fetch and
// real timers (R-QA-3, R-SRV-1, R-SRV-5, R-SEC-2). A Node HTTP server serves the handler; a second
// one plays Etherscan; a third one stands for a host a redirect points at. They live apart from
// the mock-timer tests: the real fetch keeps sockets whose timers must never be created while a
// test mocks setTimeout.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { createVerifyHandler } from "../../src/server/handler.ts";
import type { VerifyHandler } from "../../src/server/handler.ts";
import { etherscanFixture } from "../helpers/fake-explorer.ts";

// A made-up key. Never a real one (R-SEC-1).
const KEY = "dummy.key_abc~def-0001";
const ETHERSCAN_API_URL = "https://api.etherscan.io/v2/api";
const SUBMIT = etherscanFixture("2026-11-03-verifysourcecode-factory-child");

interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

async function bodyOf(req: IncomingMessage): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    const value: unknown = chunk;
    assert.ok(value instanceof Uint8Array);
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const { port } = address satisfies AddressInfo;
  return { server, origin: `http://127.0.0.1:${String(port)}` };
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

/** A fake Etherscan that records each request and answers with `answer`. */
async function fakeEtherscan(
  answer: (res: ServerResponse) => void,
): Promise<{ server: Server; origin: string; received: Received[] }> {
  const received: Received[] = [];
  const { server, origin } = await listen((req, res) => {
    void (async () => {
      const body = await bodyOf(req);
      received.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      answer(res);
    })();
  });
  return { server, origin, received };
}

/**
 * The handler's upstream fetch: the real fetch, with `https://api.etherscan.io` replaced by the
 * fake's origin and every `init` field kept, `redirect` included. The answer is copied into a new
 * Response, which has no URL, as an answer from api.etherscan.io would have its own.
 */
function towards(origin: string): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    assert.ok(url.startsWith(ETHERSCAN_API_URL), url);
    const answer = await fetch(`${origin}${url.slice("https://api.etherscan.io".length)}`, init);
    return new Response(answer.status === 204 ? null : await answer.arrayBuffer(), {
      status: answer.status,
      headers: answer.headers,
    });
  };
}

/** Serves `handler` over HTTP, as a thin Node adapter would. */
async function serve(handler: VerifyHandler): Promise<{ server: Server; origin: string }> {
  return await listen((req, res) => {
    void (async () => {
      const body = await bodyOf(req);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string") {
          headers.set(name, value);
        }
      }
      const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
        method: req.method ?? "GET",
        headers,
        ...(req.method === "GET" || req.method === "HEAD" ? {} : { body }),
      });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    })();
  });
}

/**
 * The `fetch` a dapp passes to `verify()` (R-SRV-5): it sends each Etherscan request to the
 * handler instead, with the same query, method and body.
 */
function viaHandler(handlerUrl: string): typeof fetch {
  return async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.origin !== "https://api.etherscan.io") {
      return await fetch(input, init);
    }
    return await fetch(`${handlerUrl}${url.search}`, init);
  };
}

describe("createVerifyHandler over HTTP (R-QA-3, R-SRV-1, R-SRV-5)", () => {
  it("forwards a submit from a client fetch to Etherscan with the key, and returns the guid", async () => {
    const guid = {
      status: "1",
      message: "OK",
      result: "yatwfd5yijmxufgkexd8ygesyexubjazunjnbgkemvwbm7vhrw",
    };
    const etherscan = await fakeEtherscan((res) => {
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "upstream=1" });
      res.end(JSON.stringify(guid));
    });
    const app = await serve(
      createVerifyHandler({ apiKey: KEY, chains: [421614], fetch: towards(etherscan.origin) }),
    );
    try {
      // The request the Etherscan v2 client builds, without a key, sent through the injected fetch.
      const clientFetch = viaHandler(`${app.origin}/api/verify`);
      const response = await clientFetch(`${ETHERSCAN_API_URL}?chainid=${SUBMIT.chainId}`, {
        method: "POST",
        body: new URLSearchParams(SUBMIT.fields),
      });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      assert.deepEqual(JSON.parse(text), guid);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.ok(!text.includes(KEY));

      assert.equal(etherscan.received.length, 1);
      const [sent] = etherscan.received;
      assert.ok(sent !== undefined);
      assert.equal(sent.method, "POST");
      assert.equal(sent.url, `/v2/api?chainid=${SUBMIT.chainId}`);
      assert.equal(sent.headers["content-type"], "application/x-www-form-urlencoded");
      const form = new URLSearchParams(sent.body);
      assert.equal(form.get("apikey"), KEY);
      assert.equal(form.get("action"), "verifysourcecode");
      assert.equal(form.get("sourceCode"), SUBMIT.fields["sourceCode"]);
    } finally {
      await close(app.server);
      await close(etherscan.server);
    }
  });

  it("leaves a client request to any other origin unchanged (R-SRV-5)", async () => {
    let handlerHits = 0;
    const app = await listen((req, res) => {
      handlerHits += 1;
      req.resume();
      res.end("{}");
    });
    const sourcify = await fakeEtherscan((res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    try {
      const response = await viaHandler(`${app.origin}/api/verify`)(
        `${sourcify.origin}/v2/contract/1/0x00?fields=all`,
      );
      assert.deepEqual(await response.json(), { ok: true });
      assert.equal(sourcify.received[0]?.url, "/v2/contract/1/0x00?fields=all");
      assert.equal(handlerHits, 0);
    } finally {
      await close(app.server);
      await close(sourcify.server);
    }
  });

  it("does not follow a real 302 from upstream to another host (R-SEC-2)", async () => {
    let elsewhere = 0;
    const other = await listen((req, res) => {
      elsewhere += 1;
      req.resume();
      res.end("{}");
    });
    const etherscan = await fakeEtherscan((res) => {
      res.writeHead(302, { location: `${other.origin}/collect` });
      res.end();
    });
    const app = await serve(
      createVerifyHandler({ apiKey: KEY, chains: [421614], fetch: towards(etherscan.origin) }),
    );
    try {
      const response = await viaHandler(`${app.origin}/api/verify`)(
        `${ETHERSCAN_API_URL}?chainid=${SUBMIT.chainId}`,
        { method: "POST", body: new URLSearchParams(SUBMIT.fields) },
      );
      const text = await response.text();
      assert.equal(response.status, 502, text);
      assert.equal(response.headers.get("location"), null);
      assert.ok(!text.includes(other.origin) && !text.includes(KEY));
      assert.equal(etherscan.received.length, 1);
      assert.equal(elsewhere, 0, "the redirect target got a request");
    } finally {
      await close(app.server);
      await close(etherscan.server);
      await close(other.server);
    }
  });
});
