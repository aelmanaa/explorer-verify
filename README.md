# explorer-verify

Verify the source of deployed smart contracts on Etherscan, Blockscout, Sourcify and Routescan with
one API, from a browser, a backend or a CLI.

> Status: in design; nothing is published to npm yet. The plan is in
> [docs/contributor/roadmap.md](docs/contributor/roadmap.md).

## What it will do

- Take a contract's address, chain id, compiler version and Standard JSON input, and verify it on
  the chain's explorer.
- Check first, then submit and poll, and return `verified` (exact or partial), `already-verified` or
  `failed`. An unknown explorer answer is an error, never a success.
- Route each chain to the right explorer from a built-in table, with per-call overrides.
- Run in browsers, Node, Deno, Bun and edge runtimes. Keyless explorers are called directly; Etherscan
  calls go through a small handler you host, so your API key stays on your server.

## Planned usage

This API is a draft and may change before 0.1.0:

```ts
import { verify } from "explorer-verify";

const result = await verify({
  chainId: 11155111,
  address: "0x<deployed address>",
  contractName: "src/Token.sol:Token",
  compiler: { kind: "solc", version: "0.8.24+commit.e11b9ed9", input: standardJsonInput },
});

if (result.status === "failed") throw new Error(result.reason);
console.log(result.explorerUrl);
```

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Agents start at [AGENTS.md](AGENTS.md).

## Licence

[MIT](LICENSE)
