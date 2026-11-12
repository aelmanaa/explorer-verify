# @explorer-verify/hardhat

Build verification input from a Hardhat project's compiler files. Runs on Node.js 22.12 or later.
Supported Node.js versions follow Node's LTS schedule ([decision 0060](https://github.com/aelmanaa/explorer-verify/blob/main/docs/contributor/decisions/0060-supported-node-versions-follow-lts.md)).

Status: experimental. The API may change before 1.0.

Run `npx hardhat compile` on Hardhat 2 or `npx hardhat build` on Hardhat 3 first. The helper reads files and does not compile.

After compiling the project, install `explorer-verify` next to `@explorer-verify/hardhat`.
Pass the build with the deployed address and chain. `verify()` validates the input before requests.

```ts
import { buildVerifyInputFromHardhat } from "@explorer-verify/hardhat";
import { verify } from "explorer-verify";

const built = await buildVerifyInputFromHardhat({
  root: ".",
  contract: "contracts/Greeter.sol:Greeter",
});
const result = await verify(
  {
    chainId: 11155111,
    address: "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc",
    ...built,
  },
  { route: { backend: "sourcify" } },
);
console.log(result.status);
```

```text
already-verified
```

See the [Hardhat guide](https://github.com/aelmanaa/explorer-verify/blob/main/docs/user/guides/verify-from-a-hardhat-project.md).
