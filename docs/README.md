# explorer-verify docs

Audience: everyone. This is the index for people; agents start at [AGENTS.md](../AGENTS.md).

## Users

User documentation is written as features land: [user/README.md](user/README.md). The docs site,
<https://aelmanaa.github.io/explorer-verify/>, publishes it for the version on npm `latest`. Agents start
with [Using explorer-verify from an agent](user/guides/using-from-an-agent.md) and the
[llms.txt](../llms.txt) index.

| Page                                                                                                | What it covers                                                                                |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [Deploy a contract from a dapp and verify it](user/tutorials/deploy-and-verify-from-a-dapp.md)      | Tutorial: deploy from a browser wallet, verify on Sourcify, resume                            |
| [Verify a contract shipped in an npm package](user/guides/verify-a-contract-from-an-npm-package.md) | Build the input from build-info, artifacts or metadata of unknown origin                      |
| [Verify contracts your package ships](user/guides/verify-contracts-your-package-ships.md)           | Ship the Standard JSON input and a manifest, verify after a deployment                        |
| [Verify a contract from a Foundry project](user/guides/verify-from-a-foundry-project.md)            | Find a contract's build files under `out/` and build the input                                |
| [Verify a contract from a Hardhat project](user/guides/verify-from-a-hardhat-project.md)            | Build the input from a Hardhat 2 or Hardhat 3 project's build files                           |
| [Verify from deployed bytecode](user/guides/verify-from-deployed-bytecode.md)                       | Build the input from the metadata hash in a deployed contract's bytecode                      |
| [Verify a proxy](user/guides/verify-a-proxy.md)                                                     | Verify the implementation and the proxy, then link them with `linkProxy()`                    |
| [Run the server handler](user/guides/run-the-server-handler.md)                                     | The handler in a Next.js route and a Cloudflare Worker, keys and CORS                         |
| [Verify from a browser](user/guides/verify-from-a-browser.md)                                       | Bundler or CDN, keyless explorers, the handle across a reload, size                           |
| [Verify from Node.js](user/guides/verify-from-node.md)                                              | Keys from the environment, logger, events, `checkStatus()` from a queue                       |
| [Verify from an edge function](user/guides/verify-from-an-edge-function.md)                         | Submit in one request, resume in later ones, keys from Worker secrets                         |
| [Verify from CI with the CLI](user/guides/verify-from-ci-with-the-cli.md)                           | Dry run, `--json` and `jq`, exit codes in a `case`, keys from CI secrets                      |
| [Wrap explorer-verify behind your tool's API](user/guides/wrap-explorer-verify-in-your-tool.md)     | Call it inside your tool's API, map every error code, replay tests                            |
| [verify()](user/reference/verify.md)                                                                | The steps, options, results and errors of `verify()`                                          |
| [checkStatus()](user/reference/check-status.md)                                                     | Resume a submitted verification from its handle                                               |
| [API keys](user/reference/api-keys.md)                                                              | `apiKeys` and `route.apiKey`, which host gets each key, Etherscan plans                       |
| [Routing](user/reference/routing.md)                                                                | How a chain resolves to a backend, the routing table and its options                          |
| [Core entry](user/reference/core.md)                                                                | `explorer-verify/core`, the clients and the table, for a bundle with only the clients you use |
| [Server handler](user/reference/server-handler.md)                                                  | `createVerifyHandler`: keep the Etherscan key on your server, its guards                      |
| [Errors](user/reference/errors/index.md)                                                            | Every error code, with its cause and fix                                                      |
| [JSON output and exit codes](user/reference/json-output.md)                                         | The JSON envelope, its schema and the exit code of every outcome                              |
| [Sourcify](user/reference/sourcify.md)                                                              | What is sent to Sourcify, and how each answer becomes a result                                |
| [Etherscan](user/reference/etherscan.md)                                                            | What is sent to Etherscan, and how each answer becomes a result                               |
| [Routescan](user/reference/routescan.md)                                                            | What is sent to Routescan, and how each answer becomes a result                               |
| [Blockscout](user/reference/blockscout.md)                                                          | What is sent to a Blockscout instance, and how each answer becomes a result                   |
| [Etherscan-compatible explorers](user/reference/etherscan-compatible.md)                            | What is sent to a standalone explorer with Etherscan's API, and its key                       |
| [Logging and events](user/reference/logging-and-events.md)                                          | The logger, the stage events, their schema and key redaction                                  |
| [CLI](user/reference/cli.md)                                                                        | help, version, stdout and stderr, `--json`, log levels and exit codes                         |
| [API reference](https://aelmanaa.github.io/explorer-verify/api/)                                    | Every export of each package, generated from TSDoc, on the docs site                          |
| [Match types](user/explanation/match-types.md)                                                      | What `exact` and `partial` mean, and matches made without a submit                            |
| [Etherscan plans and attribution](user/explanation/etherscan-plans-and-attribution.md)              | Which plan a use needs, the attribution text, keys off the client                             |
| [Agent skill](../skills/explorer-verify/SKILL.md)                                                   | The skill shipped in the package, with examples tested against the build                      |

## Contributors

| Page                                         | What it covers                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [Requirements](contributor/requirements.md)  | What the library must do, with IDs                                                                                       |
| [Architecture](contributor/architecture.md)  | Packages, modules, flow, extension points                                                                                |
| [Roadmap](contributor/roadmap.md)            | Milestones and the first issues                                                                                          |
| [Adoption](contributor/adoption.md)          | Adoption goal, kinds of users, what each needs, and when                                                                 |
| [Decisions](contributor/decisions/README.md) | Numbered decision records                                                                                                |
| [Prior art](contributor/prior-art.md)        | The two implementations to port from                                                                                     |
| [Research](contributor/research/README.md)   | Dated evidence: explorer APIs, Etherscan terms, landscape, agent readiness, CLI output and logging, live explorer probes |
| [Testing](contributor/testing.md)            | Test layers and rules                                                                                                    |
| [Agent eval](../test/agent-eval/README.md)   | The R-AX-13 agent task set, how to run it and where the dated results go                                                 |
| [Tooling](contributor/tooling.md)            | Toolchain and type-checking layout                                                                                       |
| [Releasing](contributor/releasing.md)        | Release plan and first publish                                                                                           |
| [Contributing](../CONTRIBUTING.md)           | Issues, labels, workflow, changesets                                                                                     |
| [Security](../SECURITY.md)                   | Reporting vulnerabilities                                                                                                |

The zksolc Blockscout mapping is recorded in [decision 0059](contributor/decisions/0059-zksolc-on-blockscout.md)
and its [protocol evidence](contributor/research/2026-11-07-blockscout-zksolc.md).
Event and envelope fields are recorded in [decision 0058](contributor/decisions/0058-settle-event-and-envelope-fields.md),
with [source research](contributor/research/2026-11-07-event-envelope-fields.md).
