// The Next.js example over real HTTP: verify() in the "browser" sends each Etherscan request through
// handlerUrl, with the real global fetch, to the route's POST served by node:http on
// 127.0.0.1. Etherscan itself is replaced by recorded answers. The handler's answer comes from
// another origin than api.etherscan.io, as it does in a browser, and must be read as an answer, not
// as a redirect (decision 0035, issue #183). A redirect from the handler is still refused.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { buffer } from "node:stream/consumers";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import { ExplorerVerifyError, verify } from "explorer-verify";
import type { VerifyInput } from "explorer-verify";

import { POST } from "../server-nextjs/app/api/verify/route.ts";
import {
  answer,
  captureConsole,
  CHAIN,
  DEPLOYER,
  ETHERSCAN_API_URL,
  KEY,
  recorded,
} from "./network.ts";

const LOOKUP = recorded("2026-11-03-getsourcecode-factory-child-verified");
const CREATION = recorded("2026-11-03-getcontractcreation-factory-children");

// The route reads its settings from the server's environment when it handles its first request.
process.env.ETHERSCAN_API_KEY = KEY;
process.env.VERIFY_DEPLOYERS = DEPLOYER;

const INPUT: VerifyInput = {
  chainId: CHAIN,
  address: "0x80798fEd44d6ec40d283bD44DDb08A6Eb2d30BE5",
  compiler: {
    kind: "solc",
    version: "0.8.24+commit.e11b9ed9",
    input: {
      language: "Solidity",
      sources: { "src/ProbeDChild.sol": { content: "contract ProbeDChild {}" } },
      settings: {},
    },
  },
  contractName: "src/ProbeDChild.sol:ProbeDChild",
};

/** The request node:http received, as the platform passes it to the route. */
async function toRequest(origin: string, req: IncomingMessage): Promise<Request> {
  const body = await buffer(req);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      headers.set(name, value);
    }
  }
  const method = req.method ?? "GET";
  return new Request(`${origin}${req.url ?? "/"}`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? null : body,
  });
}

/** Serves `serve` on 127.0.0.1 and returns its origin; the server closes when the test ends. */
async function listen(
  t: TestContext,
  serve: (origin: string, req: IncomingMessage, res: ServerResponse) => Promise<void>,
): Promise<string> {
  let origin = "";
  const server: Server = createServer((req, res) => {
    serve(origin, req, res).catch((error: unknown) => {
      res.statusCode = 500;
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  origin = `http://127.0.0.1:${String(address.port)}`;
  return origin;
}

/**
 * Replaces Etherscan with `answers` for the route's upstream requests. Every other request goes to
 * the real global fetch, so the browser side reaches the route over HTTP.
 */
function etherscan(t: TestContext, answers: readonly Response[]): string[] {
  const real = globalThis.fetch;
  const upstream: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(ETHERSCAN_API_URL)) {
      return await real(input, init);
    }
    const body = init?.body;
    const form = new URLSearchParams(
      body instanceof URLSearchParams || typeof body === "string" ? body : "",
    );
    upstream.push(form.get("action") ?? "");
    const next = answers[upstream.length - 1];
    if (next === undefined) {
      throw new Error(`unexpected Etherscan request ${String(upstream.length)}`);
    }
    return next.clone();
  });
  return upstream;
}

describe("examples/server-nextjs over HTTP (decision 0035)", () => {
  it("verify() reads the route's answer through handlerUrl, as a browser does (#183)", async (t) => {
    captureConsole(t);
    const upstream = etherscan(t, [answer(CREATION.body), answer(LOOKUP.body)]);
    const origin = await listen(t, async (base, req, res) => {
      const response = await POST(await toRequest(base, req));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    });

    const result = await verify(INPUT, {
      handlerUrl: `${origin}/api/verify`,
    });

    assert.equal(result.status, "already-verified");
    assert.equal(result.backend, "etherscan-v2");
    assert.deepEqual(upstream, ["getcontractcreation", "getsourcecode"]);
  });

  it("a redirect from the route's address is refused and not followed (R-SEC-2)", async (t) => {
    captureConsole(t);
    etherscan(t, []);
    let elsewhere = 0;
    const other = await listen(t, async (_base, req, res) => {
      elsewhere += 1;
      req.resume();
      res.end("{}");
    });
    const origin = await listen(t, async (_base, req, res) => {
      req.resume();
      res.writeHead(307, { location: `${other}/api/verify` });
      res.end();
    });

    await assert.rejects(
      verify(INPUT, {
        handlerUrl: `${origin}/api/verify`,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ExplorerVerifyError);
        assert.equal(error.code, "unexpected-response");
        assert.match(error.message, /redirect, which is not followed/);
        return true;
      },
    );
    assert.equal(elsewhere, 0);
  });
});
