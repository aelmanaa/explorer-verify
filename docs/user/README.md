# User documentation

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../llms.txt) lists every page of these docs.

Audience: developers using explorer-verify. The APIs are experimental before 1.0.

| Page                                                                                           | What it covers                                                                                |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [Deploy a contract from a dapp and verify it](tutorials/deploy-and-verify-from-a-dapp.md)      | Tutorial: deploy from a browser wallet, verify on Sourcify, resume                            |
| [Using explorer-verify from an agent](guides/using-from-an-agent.md)                           | Safe and outward calls, dry run, API keys, exit codes, Etherscan plans                        |
| [Verify a contract shipped in an npm package](guides/verify-a-contract-from-an-npm-package.md) | Build the input from build-info, artifacts or metadata of unknown origin                      |
| [Verify contracts your package ships](guides/verify-contracts-your-package-ships.md)           | Ship the Standard JSON input and a manifest, verify after a deployment                        |
| [Verify a contract from a Foundry project](guides/verify-from-a-foundry-project.md)            | Find a contract's build files under `out/` and build the input                                |
| [Verify a contract from a Hardhat project](guides/verify-from-a-hardhat-project.md)            | Build the input from a Hardhat 2 or Hardhat 3 project's build files                           |
| [Verify from deployed bytecode](guides/verify-from-deployed-bytecode.md)                       | Build the input from the metadata hash in a deployed contract's bytecode                      |
| [Verify a proxy](guides/verify-a-proxy.md)                                                     | Verify the implementation and the proxy, then link them with `linkProxy()`                    |
| [Run the server handler](guides/run-the-server-handler.md)                                     | The handler in a Next.js route and a Cloudflare Worker, keys and CORS                         |
| [Verify from a browser](guides/verify-from-a-browser.md)                                       | Bundler or CDN, keyless explorers, the handle across a reload, size                           |
| [Verify from Node.js](guides/verify-from-node.md)                                              | Keys from the environment, logger, events, `checkStatus()` from a queue                       |
| [Verify from an edge function](guides/verify-from-an-edge-function.md)                         | Submit in one request, resume in later ones, keys from Worker secrets                         |
| [Verify from CI with the CLI](guides/verify-from-ci-with-the-cli.md)                           | Dry run, `--json` and `jq`, exit codes in a `case`, keys from CI secrets                      |
| [Wrap explorer-verify behind your tool's API](guides/wrap-explorer-verify-in-your-tool.md)     | Call it inside your tool's API, map every error code, replay tests                            |
| [verify()](reference/verify.md)                                                                | The steps, options, results and errors of `verify()`                                          |
| [checkStatus()](reference/check-status.md)                                                     | Resume a submitted verification from its handle                                               |
| [API keys](reference/api-keys.md)                                                              | `apiKeys` and `route.apiKey`, which host gets each key, Etherscan plans                       |
| [Routing](reference/routing.md)                                                                | How a chain resolves to a backend, the routing table and its options                          |
| [Core entry](reference/core.md)                                                                | `explorer-verify/core`, the clients and the table, for a bundle with only the clients you use |
| [Server handler](reference/server-handler.md)                                                  | `createVerifyHandler`: keep the Etherscan key on your server, its guards                      |
| [Errors](reference/errors/index.md)                                                            | Every error code, with its cause and fix                                                      |
| [JSON output and exit codes](reference/json-output.md)                                         | The JSON envelope, its schema and the exit code of every outcome                              |
| [Sourcify](reference/sourcify.md)                                                              | What is sent to Sourcify, and how each answer becomes a result                                |
| [Etherscan](reference/etherscan.md)                                                            | What is sent to Etherscan, and how each answer becomes a result                               |
| [Routescan](reference/routescan.md)                                                            | What is sent to Routescan, and how each answer becomes a result                               |
| [Blockscout](reference/blockscout.md)                                                          | What is sent to Blockscout, and how each answer becomes a result                              |
| [Etherscan-compatible explorers](reference/etherscan-compatible.md)                            | What is sent to a standalone explorer with Etherscan's API, and its key                       |
| [Logging and events](reference/logging-and-events.md)                                          | The logger, the stage events, their schema and key redaction                                  |
| [CLI](reference/cli.md)                                                                        | help, version, stdout and stderr, `--json`, log levels and exit codes                         |
| [API reference](https://aelmanaa.github.io/explorer-verify/api/)                               | Every export of each package, generated from TSDoc, on the docs site                          |
| [Match types](explanation/match-types.md)                                                      | What `exact` and `partial` mean, and matches made without a submit                            |
| [Etherscan plans and attribution](explanation/etherscan-plans-and-attribution.md)              | Which plan a use needs, the attribution text, keys off the client                             |

Pages land with the features they describe, in four kinds (the Diátaxis layout used by [hardhat-kms](https://github.com/aelmanaa/hardhat-kms)):

| Folder         | Kind              | Planned first page                                      |
| -------------- | ----------------- | ------------------------------------------------------- |
| `tutorials/`   | Learning by doing | In place: deploy a contract from a dapp, then verify it |
| `guides/`      | Task how-tos      | In place: one per runtime, and the CLI in CI            |
| `reference/`   | Exact facts       | Supported chains and explorers                          |
| `explanation/` | Background        | In place: match types; Etherscan plans and attribution  |

`start/` holds files the quickstarts use. [start/greeter-sepolia.json](start/greeter-sepolia.json)
is a verify request for the docs' Greeter at `0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc` on
Sepolia, which Sourcify already holds as an exact match. It sets no backend, so the routing table
picks one. A dry run needs no key, no deploy and no project, and submits nothing:

```sh
npx @explorer-verify/cli verify --input-json greeter-sepolia.json --dry-run --json
```

With no Etherscan key set, the envelope has `status: "dry-run"`, `backend: "sourcify"` and
`lookup: "exact"`. With `ETHERSCAN_API_KEY` set, the routing table picks Etherscan instead.

Each user page states the version it describes in a `Version:` line and links
[llms.txt](../../llms.txt) near the top. The npm package ships these pages
under `docs/` with its own `llms.txt`, so an agent working in `node_modules` reads the docs of the
installed version.

The docs site, <https://aelmanaa.github.io/explorer-verify/>, shows the docs of the version on npm
`latest` only, the version in the `Version:` line above. For the docs of another version, read the
npm package, or jsDelivr for any published version:
`https://cdn.jsdelivr.net/npm/explorer-verify@<version>/llms.txt`. On the site, append `.md` to a
page's URL for its Markdown copy; <https://aelmanaa.github.io/explorer-verify/llms.txt> lists
every copy.

The [API reference](https://aelmanaa.github.io/explorer-verify/api/) on the site lists every
export of each package, generated from TSDoc. It is not in `docs/user/` and not in the package:
the `.d.ts` files of an installed package carry the same comments.
