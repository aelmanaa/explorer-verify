// The dapp example's Etherscan step (step 7 of the tutorial) over real HTTP: Node's own fetch
// reaches the dapp's server on loopback, which adds the key (R-SEC-1).
//
// This test has a file of its own, so it runs in a process of its own. Node's fetch keeps the
// connection open after the test, and it calls the global clearTimeout when the socket closes.
// In a file whose other tests fake the timers, that call could land in a later test and clear
// one of its mock timers, and that test would then wait forever.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { validateInput } from "explorer-verify";

import { createDappServer } from "../dapp/server.ts";
import { verifyOnEtherscan } from "../dapp/src/verify-etherscan.ts";
import { ADDRESS, setGlobal, TX_HASH } from "./dapp-browser.ts";
import { answer, KEY, recorded } from "./network.ts";

const DEPLOYMENT = { chainId: 11155111, address: ADDRESS, creationTxHash: TX_HASH };
/** Node's own fetch, taken before the test replaces the global. */
const NODE_FETCH = globalThis.fetch;
const VERIFY_FILE = new URL("../dapp/public/contracts/Greeter.verify.json", import.meta.url);

function urlOf(target: RequestInfo | URL): string {
  return target instanceof Request ? target.url : target.toString();
}

describe("examples/dapp/src/verify-etherscan.ts", () => {
  it(
    // A real fetch gives the handler's answer the dapp's URL; verify() reads it since #183.
    "verifies through the dapp's server over HTTP, as a browser does (#183)",
    async (t) => {
      const getsourcecode = recorded("2026-11-04-getsourcecode-sepolia-greeter");
      const server = createDappServer({
        apiKey: KEY,
        fetch: async () => answer(getsourcecode.body),
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      t.after(() => server.close());
      const address = server.address();
      const origin =
        typeof address === "object" && address !== null
          ? `http://127.0.0.1:${String(address.port)}`
          : "";
      // The page the dapp runs in: its handlerUrl path resolves against it (decision 0046).
      setGlobal(t, "location", { href: `${origin}/` });
      setGlobal(t, "fetch", async (target: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(target);
        return await NODE_FETCH(url.startsWith("/") ? `${origin}${url}` : url, init);
      });
      const loaded = validateInput({
        ...Object(JSON.parse(readFileSync(VERIFY_FILE, "utf8"))),
        ...DEPLOYMENT,
      });
      // Real timers: the requests go over loopback, and a mock clock would race them.
      const result = await verifyOnEtherscan(loaded);
      assert.equal(result.status, "already-verified");
    },
  );
});
