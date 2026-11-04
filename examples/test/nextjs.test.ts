// The Next.js example (examples/server-nextjs): the route's POST export called with the Request a
// browser sends through the client's injected fetch, against recorded Etherscan answers (R-SRV-1,
// R-SRV-2, R-SRV-4, R-SRV-5), and the key never in a response or a log line (R-SEC-1).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import { ExplorerVerifyError } from "explorer-verify";
import type { VerifyInput } from "explorer-verify";
import { SOURCE_MARKER } from "explorer-verify/server";

import { POST, runtime } from "../server-nextjs/app/api/verify/route.ts";
import { handlerFetch, verifyFromBrowser } from "../server-nextjs/lib/verify-client.ts";
import {
  answer,
  captureConsole,
  CHAIN,
  clientRequest,
  DEPLOYER,
  ETHERSCAN_API_URL,
  KEY,
  network,
  recorded,
} from "./network.ts";

const DAPP = "https://dapp.example";
const SUBMIT = recorded("2026-11-03-verifysourcecode-factory-child");
const STATUS = recorded("2026-11-03-checkverifystatus-factory-child-02-pass");
const LOOKUP = recorded("2026-11-03-getsourcecode-factory-child-verified");
const CREATION = recorded("2026-11-03-getcontractcreation-factory-children");

// The route reads its settings from the server's environment when it handles its first request.
process.env.ETHERSCAN_API_KEY = KEY;
// Spaces and an empty entry, as a hand-edited variable may hold them.
process.env.VERIFY_DEPLOYERS = ` ${DEPLOYER} , `;

/** The browser's fetch through the dapp's injected fetch, with a same-origin browser in front. */
function browser(
  t: TestContext,
  answers: readonly Response[],
  headers: Record<string, string> = { "sec-fetch-site": "same-origin" },
): { viaHandler: typeof fetch; net: ReturnType<typeof network>; lines: string[] } {
  const net = network(DAPP, POST, headers, answers);
  t.mock.method(globalThis, "fetch", net.fetch);
  return { viaHandler: handlerFetch(`${DAPP}/api/verify`), net, lines: captureConsole(t) };
}

describe("examples/server-nextjs", () => {
  it("runs on the Node.js runtime", () => {
    assert.equal(runtime, "nodejs");
  });

  it("forwards a submit for a contract of an allowed deployer, key in the body only", async (t) => {
    const { viaHandler, net } = browser(t, [
      answer(CREATION.body),
      answer(SUBMIT.body, SUBMIT.status),
    ]);
    const response = await viaHandler(...clientRequest(SUBMIT.fields));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), SUBMIT.body);
    assert.deepEqual(
      net.upstream.map((call) => call.form.get("action")),
      ["getcontractcreation", "verifysourcecode"],
    );
    for (const call of net.upstream) {
      assert.equal(call.url, `${ETHERSCAN_API_URL}?chainid=${String(CHAIN)}`);
      assert.equal(call.form.get("apikey"), KEY);
    }
    assert.equal(net.upstream[1]?.form.get("sourceCode"), SUBMIT.fields.sourceCode);
  });

  it("forwards a status poll without a deployer check", async (t) => {
    const { viaHandler, net } = browser(t, [answer(STATUS.body, STATUS.status)]);
    const response = await viaHandler(...clientRequest(STATUS.fields));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), STATUS.body);
    assert.equal(net.upstream.length, 1);
  });

  it("answers a lookup in the reduced shape the client reads", async (t) => {
    const { viaHandler } = browser(t, [answer(CREATION.body), answer(LOOKUP.body)]);
    const response = await viaHandler(...clientRequest(LOOKUP.fields));
    assert.equal(response.status, 200);
    const body: unknown = await response.json();
    const first: unknown = Reflect.get(Object(Reflect.get(Object(body), "result")), 0);
    assert.equal(Reflect.get(Object(body), "status"), "1");
    assert.equal(Reflect.get(Object(first), "SourceCode"), SOURCE_MARKER);
    assert.equal(Reflect.get(Object(first), "ContractName"), "ProbeDChild");
    assert.equal(Reflect.get(Object(first), "ABI"), undefined);
  });

  it("sends a request to another explorer directly, not to the route", async (t) => {
    const { viaHandler, net } = browser(t, []);
    const sourcify =
      "https://sourcify.dev/server/v2/contract/421614/0x80798fEd44d6ec40d283bD44DDb08A6Eb2d30BE5";
    await viaHandler(sourcify);
    await viaHandler(new Request(sourcify));
    assert.deepEqual(net.elsewhere, [sourcify, sourcify]);
    assert.equal(net.upstream.length, 0);
  });

  it("forwards a Request object's method, headers and body to the handler", async (t) => {
    const { viaHandler, net } = browser(t, [answer(STATUS.body, STATUS.status)]);
    const [url, init] = clientRequest(STATUS.fields);
    const response = await viaHandler(new Request(url, init));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), STATUS.body);
    assert.equal(net.upstream[0]?.form.get("guid"), STATUS.fields.guid);
    // A GET reaches the handler without a body and is refused there.
    const get = await viaHandler(new Request(url, { headers: { "x-test": "1" } }), {
      method: "GET",
    });
    assert.equal(get.status, 405);
    assert.equal(net.upstream.length, 1);
  });

  it("refuses a request a browser marks as cross-site", async (t) => {
    const { viaHandler, net } = browser(t, [], { "sec-fetch-site": "cross-site" });
    const response = await viaHandler(...clientRequest(STATUS.fields));
    assert.equal(response.status, 429);
    assert.equal(Reflect.get(Object(await response.json()), "code"), "rate-limited");
    assert.equal(net.upstream.length, 0);
  });

  it("refuses a chain outside its allowlist", async (t) => {
    const { viaHandler } = browser(t, []);
    const response = await viaHandler(...clientRequest(STATUS.fields, 10));
    assert.equal(response.status, 403);
    assert.equal(Reflect.get(Object(await response.json()), "code"), "chain-not-allowed");
  });

  it("never returns or logs the key, even when Etherscan echoes it", async (t) => {
    const echo = { status: "0", message: "NOTOK", result: `Invalid API Key ${KEY}` };
    const { viaHandler, lines } = browser(t, [
      answer(echo),
      // Not JSON: refused with 502 and logged at warn, with no retry and so no wait.
      new Response("<html>bad gateway</html>", { status: 200 }),
    ]);
    const shown: string[] = [];
    // An echoed key, an upstream failure (logged at warn) and two refusals (logged at info).
    const requests: [Record<string, string>, number][] = [
      [STATUS.fields, CHAIN],
      [STATUS.fields, CHAIN],
      [STATUS.fields, 10],
      [{ module: "account", action: "balance" }, CHAIN],
    ];
    for (const [fields, chain] of requests) {
      const response = await viaHandler(...clientRequest(fields, chain));
      shown.push(
        String(response.status),
        JSON.stringify([...response.headers]),
        await response.text(),
      );
    }
    assert.match(shown.join("\n"), /\[redacted\]/);
    assert.ok(lines.length > 0, "the refusals and the upstream failure are logged");
    assert.doesNotMatch(shown.join("\n"), new RegExp(KEY.replaceAll(".", "\\.")));
    for (const line of lines) {
      assert.ok(!line.includes(KEY), `a log line holds the key: ${line}`);
    }
  });

  it("verifyFromBrowser passes the injected fetch to verify()", async () => {
    // Chain id 0 fails validation before any request is sent.
    const input: VerifyInput = {
      chainId: 0,
      address: "0x80798fEd44d6ec40d283bD44DDb08A6Eb2d30BE5",
      compiler: {
        kind: "solc",
        version: "0.8.24+commit.e11b9ed9",
        input: { language: "Solidity", sources: {}, settings: {} },
      },
      contractName: "src/ProbeDChild.sol:ProbeDChild",
    };
    await assert.rejects(
      verifyFromBrowser(input),
      (error: unknown) => error instanceof ExplorerVerifyError && error.code === "invalid-input",
    );
  });
});
