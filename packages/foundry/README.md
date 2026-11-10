# @explorer-verify/foundry

Build verification input from a Foundry project's compiler files. Runs on Node.js 22.18 or later.
Supported Node.js versions follow Node's LTS schedule ([decision 0060](https://github.com/aelmanaa/explorer-verify/blob/main/docs/contributor/decisions/0060-supported-node-versions-follow-lts.md)).

Status: experimental. The API may change before 1.0.

Run `forge build --build-info` first. The helper reads files and does not compile.

After compiling the project, install `explorer-verify` next to `@explorer-verify/foundry`.
Pass the build with the deployed address and chain. `verify()` validates the input before requests.

```ts
import { buildVerifyInputFromFoundry } from "@explorer-verify/foundry";
import { verify } from "explorer-verify";

const built = await buildVerifyInputFromFoundry({
  root: ".",
  contract: "src/Greeter.sol:Greeter",
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

See the [Foundry guide](https://github.com/aelmanaa/explorer-verify/blob/main/docs/user/guides/verify-from-a-foundry-project.md).
