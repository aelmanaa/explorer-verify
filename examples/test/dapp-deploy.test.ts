// The dapp example's deploy module (step 2 of the tutorial), run with a fake EIP-1193 wallet: it
// sends the creation from the user's account, keeps the hash in localStorage until the receipt
// arrives, and returns the deployment. A page reload resumes a pending deployment.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import { concatHex, encodeAbiParameters, isHex, parseAbiParameters } from "viem";

import { dappRoutes } from "../dapp/server.ts";
import { deployGreeter, resumeDeployment } from "../dapp/src/deploy.ts";
import {
  ACCOUNT,
  ADDRESS,
  browserNetwork,
  fakeWallet,
  MemoryStorage,
  setGlobal,
  settle,
  TX_HASH,
} from "./dapp-browser.ts";
import type { WalletOptions } from "./dapp-browser.ts";

const CREATION_TX_KEY = "greeter-creation-tx";
const deployFile: unknown = JSON.parse(
  readFileSync(new URL("../dapp/public/contracts/Greeter.deploy.json", import.meta.url), "utf8"),
);
const bytecode: unknown = Reflect.get(Object(deployFile), "bytecode");

/** Sets up the page: wallet, storage and network, with mock timers for viem's polling. */
function page(
  t: TestContext,
  wallet: WalletOptions | "none" = {},
  fetchOverride?: typeof fetch,
): { storage: MemoryStorage; calls: ReturnType<typeof fakeWallet>["calls"] } {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const storage = new MemoryStorage();
  setGlobal(t, "localStorage", storage);
  setGlobal(t, "fetch", fetchOverride ?? browserNetwork(dappRoutes({ apiKey: "" })).fetch);
  const fake = fakeWallet(wallet === "none" ? {} : wallet);
  setGlobal(t, "window", wallet === "none" ? {} : { ethereum: fake.provider });
  return { storage, calls: fake.calls };
}

describe("examples/dapp/src/deploy.ts", () => {
  it("deploys Greeter owned by the user and keeps the hash until the receipt arrives", async (t) => {
    let storedAtReceipt: string | null = null;
    const { storage, calls } = page(t, {
      onReceipt: () => {
        storedAtReceipt = storage.getItem(CREATION_TX_KEY);
      },
    });

    const deployment = await settle(t, deployGreeter("Hello, Sepolia"));

    assert.deepEqual(deployment, { chainId: 11155111, address: ADDRESS, creationTxHash: TX_HASH });
    assert.equal(storedAtReceipt, TX_HASH);
    assert.equal(storage.getItem(CREATION_TX_KEY), null);
    const methods = calls.map((call) => call.method);
    assert.equal(methods[0], "eth_requestAccounts");
    assert.ok(methods.includes("wallet_switchEthereumChain"));
    // The creation code, then the constructor's arguments: the user owns the contract.
    const sent = calls.find((call) => call.method === "eth_sendTransaction");
    const transaction: unknown = Reflect.get(Object(sent?.params), 0);
    assert.equal(Reflect.get(Object(transaction), "from"), ACCOUNT);
    assert.ok(isHex(bytecode));
    assert.equal(
      Reflect.get(Object(transaction), "data"),
      concatHex([
        bytecode,
        encodeAbiParameters(parseAbiParameters("address, string"), [ACCOUNT, "Hello, Sepolia"]),
      ]),
    );
  });

  it("resumes the pending deployment after a reload", async (t) => {
    const { storage, calls } = page(t);
    storage.setItem(CREATION_TX_KEY, TX_HASH);

    const deployment = await settle(t, resumeDeployment());

    assert.deepEqual(deployment, { chainId: 11155111, address: ADDRESS, creationTxHash: TX_HASH });
    assert.equal(storage.getItem(CREATION_TX_KEY), null);
    assert.ok(!calls.some((call) => call.method === "eth_sendTransaction"));
  });

  it("resumes nothing when no deployment is pending", async (t) => {
    const { calls } = page(t);
    assert.equal(await resumeDeployment(), undefined);
    assert.deepEqual(calls, []);
  });

  it("throws when the creation reverts, and forgets the hash", async (t) => {
    const { storage } = page(t, { status: "0x0" });
    await assert.rejects(settle(t, deployGreeter("Hello")), {
      message: `The deployment failed in transaction ${TX_HASH}.`,
    });
    assert.equal(storage.getItem(CREATION_TX_KEY), null);
  });

  it("asks for a wallet when the browser has none", async (t) => {
    page(t, "none");
    await assert.rejects(deployGreeter("Hello"), {
      message: "Install a browser wallet to deploy.",
    });
  });

  it("throws when the wallet shares no account", async (t) => {
    page(t, { accounts: [] });
    await assert.rejects(settle(t, deployGreeter("Hello")), {
      message: "The wallet shared no account.",
    });
  });

  it("throws when the deploy file cannot be loaded", async (t) => {
    page(t, {}, async () => new Response("Not found", { status: 404 }));
    await assert.rejects(settle(t, deployGreeter("Hello")), {
      message: "Could not load the contract: HTTP 404",
    });
  });

  it("throws when the deploy file holds no ABI and bytecode", async (t) => {
    for (const body of [null, {}, { abi: {} }, { abi: [] }, { abi: [], bytecode: "nothex" }]) {
      await t.test(JSON.stringify(body), async (st) => {
        page(st, {}, async () => Response.json(body));
        await assert.rejects(settle(st, deployGreeter("Hello")), {
          message: "Greeter.deploy.json holds no ABI and bytecode.",
        });
      });
    }
  });
});
