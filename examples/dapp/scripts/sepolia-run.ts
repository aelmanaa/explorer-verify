// Runs the dapp's code path once on Sepolia from Node, for the maintainer's dated run of the
// tutorial. A browser wallet cannot be driven from a script, so this script stands in for one: it
// sets `window.ethereum` to an EIP-1193 provider that signs with a key from the environment and
// sends everything else to a Sepolia RPC. It then calls the page's modules in the order the page
// does: deploy, load the input, verify on Sourcify, resume with checkStatus() as after a reload,
// and verify on Etherscan through the dapp's server, started here with the key. It tries the
// Etherscan step twice: as the page does, over HTTP, then with the server's routes called in the
// process, as the first block of step 7 of the tutorial does, and prints the outcome of each.
//
// Environment, read inside this process only, never printed:
//   SEPOLIA_PRIVATE_KEY  a funded testnet key, 0x and 64 hex digits
//   SEPOLIA_RPC_URL      a Sepolia JSON-RPC endpoint
//   ETHERSCAN_API_KEY    optional; without it the Etherscan step is skipped
//
// Testnet only: it stops unless the RPC answers chain id 11155111, and before sending it stops
// when the deployment could cost more than 0.01 ETH.
import type { AddressInfo } from "node:net";

import { verify } from "explorer-verify";
import { createWalletClient, custom, formatEther, isHex, parseEther, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import { createDappServer, dappRoutes } from "../server.ts";
import { deployGreeter } from "../src/deploy.ts";
import { loadVerifyInput } from "../src/load-input.ts";
import { resumeVerification } from "../src/resume.ts";
import { verifyOnEtherscan } from "../src/verify-etherscan.ts";
import { PENDING_KEY, verifyOnSourcify } from "../src/verify.ts";

const BUDGET = parseEther("0.01");
const privateKey = process.env.SEPOLIA_PRIVATE_KEY ?? "";
const rpcUrl = process.env.SEPOLIA_RPC_URL ?? "";
const etherscanKey = process.env.ETHERSCAN_API_KEY ?? "";
const secrets = [privateKey, rpcUrl, etherscanKey].filter((value) => value.length > 8);

/** Removes the key, the RPC URL and the Etherscan key from a line before it is printed. */
function redact(line: string): string {
  return secrets.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), line);
}

function log(line: string): void {
  process.stdout.write(`${redact(line)}\n`);
}

if (!isHex(privateKey) || privateKey.length !== 66 || !rpcUrl.startsWith("https://")) {
  throw new Error("Set SEPOLIA_PRIVATE_KEY and SEPOLIA_RPC_URL (https).");
}
const account = privateKeyToAccount(privateKey);
const nodeFetch = globalThis.fetch;
let rpcId = 0;

/** Sends one JSON-RPC request to the Sepolia node. */
async function rpc(method: string, params: unknown): Promise<unknown> {
  rpcId += 1;
  const response = await nodeFetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params: params ?? [] }),
  });
  const reply: unknown = await response.json();
  const error: unknown = Reflect.get(Object(reply), "error");
  if (error !== undefined) {
    throw new Error(`${method}: ${String(Reflect.get(Object(error), "message"))}`);
  }
  return Reflect.get(Object(reply), "result");
}

// Signs locally, with the RPC for nonce, fees and gas.
const signer = createWalletClient({
  account,
  chain: sepolia,
  transport: custom({
    request: async ({ method, params }: { method: string; params?: unknown }) =>
      await rpc(method, params),
  }),
}).extend(publicActions);

/** The EIP-1193 provider the page sees as `window.ethereum`. */
const provider = {
  request: async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return [account.address];
      case "wallet_switchEthereumChain": {
        const chainId: unknown = Reflect.get(Object(Reflect.get(Object(params), 0)), "chainId");
        if (chainId !== "0xaa36a7") {
          throw new Error("This script runs on Sepolia only.");
        }
        return null;
      }
      case "eth_sendTransaction": {
        const transaction: unknown = Reflect.get(Object(params), 0);
        const data: unknown = Reflect.get(Object(transaction), "data");
        const to: unknown = Reflect.get(Object(transaction), "to");
        if (!isHex(data) || (to !== undefined && to !== null)) {
          throw new Error("This script sends contract creations only.");
        }
        // The gas limit and fee caps the check uses are the ones sent, so the node cannot charge
        // more than `worst`.
        const gas = ((await signer.estimateGas({ data })) * 12n) / 10n;
        const maxFeePerGas = 2n * (await signer.getGasPrice());
        const tip = await signer.estimateMaxPriorityFeePerGas();
        const maxPriorityFeePerGas = tip < maxFeePerGas ? tip : maxFeePerGas;
        const worst = gas * maxFeePerGas;
        log(`Gas limit ${gas.toString()}, at most ${formatEther(worst)} ETH`);
        if (worst > BUDGET) {
          throw new Error(`The deployment could cost more than ${formatEther(BUDGET)} ETH.`);
        }
        return await signer.sendTransaction({ data, gas, maxFeePerGas, maxPriorityFeePerGas });
      }
      default:
        return await rpc(method, params);
    }
  },
};

/** The page's storage, in memory, kept across the simulated reload. */
const items = new Map<string, string>();
const storage = {
  getItem: (key: string): string | null => items.get(key) ?? null,
  setItem: (key: string, value: string): void => void items.set(key, value),
  removeItem: (key: string): void => void items.delete(key),
};

const server = createDappServer({ apiKey: etherscanKey });
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address: AddressInfo | string | null = server.address();
const origin = `http://127.0.0.1:${typeof address === "object" ? String(address?.port) : ""}`;

// The page's globals: the wallet, the storage, and a fetch that sends the page's own paths to the
// dapp's server, as a browser does.
Reflect.defineProperty(globalThis, "window", { value: { ethereum: provider }, configurable: true });
Reflect.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
Reflect.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async (target: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    typeof target === "string" && target.startsWith("/")
      ? await nodeFetch(`${origin}${target}`, init)
      : await nodeFetch(target, init),
});

try {
  if ((await rpc("eth_chainId", [])) !== "0xaa36a7") {
    throw new Error("The RPC is not Sepolia.");
  }
  const before = await signer.getBalance({ address: account.address });
  log(`Run on ${new Date().toISOString()} from ${account.address}`);
  log(`Balance before: ${formatEther(before)} ETH`);

  const deployment = await deployGreeter("Hello, Sepolia");
  log(`Deployed at ${deployment.address} in transaction ${deployment.creationTxHash}`);
  const receipt = await signer.getTransactionReceipt({ hash: deployment.creationTxHash });
  const spent = receipt.gasUsed * receipt.effectiveGasPrice;
  log(`Deployment cost: ${formatEther(spent)} ETH (gas ${receipt.gasUsed.toString()})`);

  const input = await loadVerifyInput(deployment);
  log(`Loaded ${input.contractName}, compiled with ${input.compiler.version}`);

  let handle: string | undefined;
  await verifyOnSourcify(input, (line) => {
    handle ??= /^Submitted\. Handle: (\S+)$/.exec(line)?.[1];
    log(`Sourcify: ${line}`);
  });

  // As after a reload while the job was running: the handle is back in storage, and the page
  // polls the same job with checkStatus(), which never submits.
  if (handle === undefined) {
    log("Resume: nothing to resume, Sourcify had the contract before the submit.");
  } else {
    storage.setItem(PENDING_KEY, handle);
    await resumeVerification((line) => log(`Resume: ${line}`));
  }

  if (etherscanKey === "") {
    log("Etherscan: skipped, no ETHERSCAN_API_KEY.");
  } else {
    // The page's path: verify() posts to /api/verify on the dapp's server over HTTP.
    try {
      const result = await verifyOnEtherscan(input);
      log(`Etherscan, page path: ${result.status} (${result.backend})`);
    } catch (error) {
      log(`Etherscan, page path: ${error instanceof Error ? error.message : String(error)}`);
    }
    // The tutorial's first block of step 7: the same routes, called in the process.
    const routes = dappRoutes({ apiKey: etherscanKey });
    const result = await verify(input, {
      route: { backend: "etherscan-v2", apiUrl: "https://api.etherscan.io/v2/api" },
      fetch: async (target, init) => {
        const url = new URL(target instanceof Request ? target.url : target.toString());
        return await routes(new Request(`${origin}/api/verify${url.search}`, init));
      },
    });
    log(`Etherscan, handler in process: ${result.status} (${result.backend})`);
  }
} catch (error) {
  log(`Stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  server.close();
}
