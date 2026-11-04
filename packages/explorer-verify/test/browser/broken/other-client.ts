// Loads a second client: a dry run routed to Etherscan v2 on Ethereum mainnet. With no key set
// it sends no request, but it loads the Etherscan client's chunk, which the smoke test must
// catch (decision 0031).
import { dryRun } from "explorer-verify";
import type { VerifyInput } from "explorer-verify";

import { start } from "../scenario.ts";

const input: VerifyInput = {
  chainId: 1,
  address: "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc",
  compiler: {
    kind: "solc",
    version: "0.8.24+commit.e11b9ed9",
    input: {
      language: "Solidity",
      sources: { "contracts/Greeter.sol": { content: "contract Greeter {}" } },
      settings: {},
    },
  },
  contractName: "contracts/Greeter.sol:Greeter",
};

await dryRun(input, { route: { backend: "etherscan-v2" } });
start();
