// The dapp example's server: it serves the page and its build files, and forwards POST
// /api/verify through the server handler only when it has a key (R-SRV-1, R-SEC-1). The Node
// adapter is tested over loopback; the start script is run as a reader runs it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import { createDappServer, dappRoutes } from "../dapp/server.ts";
import { answer, KEY, recorded } from "./network.ts";

const ORIGIN = "https://dapp.example";
const STATUS_FIELDS = recorded("2026-11-04-getsourcecode-sepolia-greeter").fields;

async function get(
  routes: (request: Request) => Promise<Response>,
  path: string,
): Promise<Response> {
  return await routes(new Request(`${ORIGIN}${path}`));
}

/** Starts the Node server on a free loopback port and stops it after the test. */
async function listen(
  t: TestContext,
  server: ReturnType<typeof createDappServer>,
): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(typeof address === "object" && address !== null);
  return `http://127.0.0.1:${String((address satisfies AddressInfo).port)}`;
}

describe("examples/dapp/server.ts", () => {
  it("serves the page and the build files with their types", async () => {
    const routes = dappRoutes({ apiKey: "" });
    const page = await get(routes, "/");
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
    assert.match(await page.text(), /<script type="module" src="\/app\/main\.js">/);
    const contract = await get(routes, "/contracts/Greeter.verify.json");
    assert.equal(contract.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(
      Reflect.get(Object(await contract.json()), "contractName"),
      "src/Greeter.sol:Greeter",
    );
  });

  it("answers 404 for a missing file, a file type it does not serve, and a path out of public/", async () => {
    const routes = dappRoutes({ apiKey: "" });
    for (const path of ["/app/none.js", "/contracts/", "/../server.ts", "/%2e%2e/package.json"]) {
      assert.equal((await get(routes, path)).status, 404, path);
    }
  });

  it("answers 405 to a write on a static path", async () => {
    const routes = dappRoutes({ apiKey: "" });
    const response = await routes(new Request(`${ORIGIN}/`, { method: "POST", body: "x" }));
    assert.equal(response.status, 405);
  });

  it("answers 503 at /api/verify without a key, and sends nothing", async () => {
    let sent = 0;
    const routes = dappRoutes({
      apiKey: "",
      fetch: async () => {
        sent += 1;
        return answer({});
      },
    });
    const response = await routes(new Request(`${ORIGIN}/api/verify`, { method: "POST" }));
    assert.equal(response.status, 503);
    assert.match(await response.text(), /ETHERSCAN_API_KEY/);
    assert.equal(sent, 0);
  });

  it("R-SEC-1: forwards /api/verify over HTTP through the handler, which adds the key", async (t) => {
    const forwarded: string[] = [];
    const getsourcecode = recorded("2026-11-04-getsourcecode-sepolia-greeter");
    const origin = await listen(
      t,
      createDappServer({
        apiKey: KEY,
        fetch: async (_target, init) => {
          forwarded.push(await new Response(init?.body).text());
          return answer(getsourcecode.body);
        },
      }),
    );
    const response = await fetch(`${origin}/api/verify?chainid=11155111`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(STATUS_FIELDS),
    });
    assert.equal(response.status, 200);
    assert.equal(Reflect.get(Object(await response.json()), "status"), "1");
    assert.equal(forwarded.length, 1);
    assert.equal(new URLSearchParams(forwarded[0]).get("apikey"), KEY);
    // A browser marks a request from another site; the routes refuse it before the handler.
    const other = await fetch(`${origin}/api/verify?chainid=11155111`, {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
      body: new URLSearchParams(STATUS_FIELDS),
    });
    assert.equal(other.status, 403);
    assert.equal(forwarded.length, 1);
  });

  it("serves files over HTTP, and answers 400 to a request it cannot read", async (t) => {
    // A key and no `fetch`: the handler would send to Etherscan with the global fetch.
    const origin = await listen(t, createDappServer({ apiKey: KEY }));
    const page = await fetch(`${origin}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
    // A header sent twice reaches the routes; a path that is no URL gets 400.
    const send = async (path: string): Promise<number | undefined> =>
      await new Promise((resolve, reject) => {
        const url = new URL(origin);
        httpRequest(
          { host: url.hostname, port: url.port, path, headers: { "set-cookie": ["a=1", "b=2"] } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        )
          .on("error", reject)
          .end();
      });
    assert.equal(await send("/index.html"), 200);
    assert.equal(await send("//:99999/"), 400);
  });

  it("starts from scripts/serve.ts on the port in PORT", async (t) => {
    const child = spawn(process.execPath, ["dapp/scripts/serve.ts"], {
      cwd: new URL("../", import.meta.url),
      env: { ...process.env, PORT: "0", ETHERSCAN_API_KEY: "" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    t.after(() => child.kill());
    const line = await new Promise<string>((resolve) => {
      child.stdout.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")));
    });
    const match = /^Serving the dapp at (http:\/\/127\.0\.0\.1:\d+)\n$/.exec(line);
    assert.ok(match?.[1] !== undefined, line);
    const page = await fetch(`${match[1]}/`);
    assert.equal(page.status, 200);
    await page.text();
  });
});
