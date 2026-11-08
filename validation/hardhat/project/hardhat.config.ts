import { fileURLToPath } from "node:url";

import { defineConfig, task } from "hardhat/config";

export default defineConfig({
  solidity: {
    profiles: {
      default: {
        version: "0.8.24",
        path: fileURLToPath(new URL("./node_modules/solc/soljson.js", import.meta.url)),
        settings: { optimizer: { enabled: false, runs: 200 } },
      },
      production: {
        version: "0.8.24",
        path: fileURLToPath(new URL("./node_modules/solc/soljson.js", import.meta.url)),
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
    },
  },
  paths: { artifacts: "build/artifacts", cache: "build/cache" },
  tasks: [
    task("explorer-verify", "Verify the exact existing Hardhat build through explorer-verify")
      .addOption({
        name: "apiUrl",
        description: "Explicit explorer API base",
        defaultValue: "http://127.0.0.1:1",
      })
      .addOption({
        name: "address",
        description: "Deployed address",
        defaultValue: "0x0000000000000000000000000000000000000001",
      })
      .addOption({
        name: "contract",
        description: "Contract name",
        defaultValue: "contracts/Counter.sol:Counter",
      })
      .addOption({
        name: "resume",
        description: "Previously saved handle",
        defaultValue: "",
      })
      .setAction(() => import("./verify-task.ts"))
      .build(),
  ],
});
