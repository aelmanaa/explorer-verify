# @explorer-verify/foundry

Finds a contract's build files in a Foundry project and builds the
[explorer-verify](https://github.com/aelmanaa/explorer-verify#readme) input from them. Node 22.18
or later.

Status: in design; nothing is published to npm yet.

Install it next to `explorer-verify`, which it takes as a peer dependency.

```ts
import { verifyInputFromFoundry } from "@explorer-verify/foundry";

// After forge build --build-info in the project root.
const built = await verifyInputFromFoundry({ root: ".", contract: "src/Greeter.sol:Greeter" });
// built.contractName: "src/Greeter.sol:Greeter"
```

The guide:
[Verify a contract from a Foundry project](https://github.com/aelmanaa/explorer-verify/blob/main/docs/user/guides/verify-from-a-foundry-project.md).
