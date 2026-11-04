# User documentation

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../llms.txt) lists every page of these docs.

Audience: developers using explorer-verify. Nothing is released yet, so most of this section is
still to come.

| Page                                                                                           | What it covers                                                           |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [Using explorer-verify from an agent](guides/using-from-an-agent.md)                           | Safe steps and the permanent submit, API keys, the Etherscan plan rule   |
| [Verify a contract shipped in an npm package](guides/verify-a-contract-from-an-npm-package.md) | Build the input from build-info, artifacts or metadata of unknown origin |
| [Verify a contract from a Foundry project](guides/verify-from-a-foundry-project.md)            | Find a contract's build files under `out/` and build the input           |
| [Verify a contract from a Hardhat project](guides/verify-from-a-hardhat-project.md)            | Build the input from a Hardhat 2 or Hardhat 3 project's build files      |
| [Run the server handler](guides/run-the-server-handler.md)                                     | The handler in a Next.js route and a Cloudflare Worker, keys and CORS    |
| [verify()](reference/verify.md)                                                                | The steps, options, results and errors of `verify()`                     |
| [checkStatus()](reference/check-status.md)                                                     | Resume a submitted verification from its handle                          |
| [API keys](reference/api-keys.md)                                                              | `apiKeys` and `route.apiKey`, which host gets each key, Etherscan plans  |
| [Routing](reference/routing.md)                                                                | How a chain resolves to a backend, the routing table and its options     |
| [Server handler](reference/server-handler.md)                                                  | `createVerifyHandler`: keep the Etherscan key on your server, its guards |
| [Errors](reference/errors/index.md)                                                            | Every error code, with its cause and fix                                 |
| [JSON output and exit codes](reference/json-output.md)                                         | The JSON envelope, its schema and the exit code of every outcome         |
| [Sourcify](reference/sourcify.md)                                                              | What is sent to Sourcify, and how each answer becomes a result           |
| [Etherscan](reference/etherscan.md)                                                            | What is sent to Etherscan, and how each answer becomes a result          |
| [Logging and events](reference/logging-and-events.md)                                          | The logger, the stage events, their schema and key redaction             |
| [CLI](reference/cli.md)                                                                        | help, version, stdout and stderr, `--json`, log levels and exit codes    |
| [Match types](explanation/match-types.md)                                                      | What `exact` and `partial` mean, and matches made without a submit       |
| [Etherscan plans and attribution](explanation/etherscan-plans-and-attribution.md)              | Which plan a use needs, the attribution text, keys off the client        |

Pages land with the features they describe, in four kinds (the Diátaxis layout used by [hardhat-kms](https://github.com/aelmanaa/hardhat-kms)):

| Folder         | Kind              | Planned first page                                                         |
| -------------- | ----------------- | -------------------------------------------------------------------------- |
| `tutorials/`   | Learning by doing | Deploy a contract from a dapp, then verify it                              |
| `guides/`      | Task how-tos      | Verify from a browser; verify from CI with the CLI                         |
| `reference/`   | Exact facts       | API reference generated from TSDoc; errors; supported chains and explorers |
| `explanation/` | Background        | In place: match types; Etherscan plans and attribution                     |

Each user page states the version it describes in a `Version:` line and links
[llms.txt](../../llms.txt) near the top. Once published, the npm package will ship these pages
under `docs/` with its own `llms.txt`, so an agent working in `node_modules` reads the docs of the
installed version.

The docs site, <https://aelmanaa.github.io/explorer-verify/>, shows the docs of the version on npm
`latest` only, the version in the `Version:` line above. For the docs of another version, read the
npm package, or jsDelivr for any published version:
`https://cdn.jsdelivr.net/npm/explorer-verify@<version>/llms.txt`. On the site, append `.md` to a
page's URL for its Markdown copy; <https://aelmanaa.github.io/explorer-verify/llms.txt> lists
every copy.
