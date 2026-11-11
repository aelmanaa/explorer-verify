# Which package to install

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

For: anyone choosing what to install before a first verification.

You need: npm or another package manager. Find your task, then read its section below.

| You want to                         | Install                                          | Import or run              |
| ----------------------------------- | ------------------------------------------------ | -------------------------- |
| Verify from app code                | `npm i explorer-verify`                          | `explorer-verify`          |
| Verify from a terminal or CI        | `npm i -D @explorer-verify/cli`                  | `npx @explorer-verify/cli` |
| Read a Foundry project in code      | `npm i explorer-verify @explorer-verify/foundry` | `@explorer-verify/foundry` |
| Read a Hardhat project in code      | `npm i explorer-verify @explorer-verify/hardhat` | `@explorer-verify/hardhat` |
| Bundle only the clients you use     | `npm i explorer-verify`                          | `explorer-verify/core`     |
| Keep an Etherscan key on a server   | `npm i explorer-verify`                          | `explorer-verify/server`   |
| Read a handle or an error code only | `npm i explorer-verify`                          | `explorer-verify/handle`   |

## The four packages

| Package                    | Purpose                                                                      | Runs on                                         | Use it when                              |
| -------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------- |
| `explorer-verify`          | Verify, dry run, resume and link a proxy; build the input                    | Browsers, Node.js 22.18 or later, edge runtimes | Your code calls the explorers            |
| `@explorer-verify/cli`     | The `explorer-verify` command, with a JSON envelope and exit codes           | Node.js 22.18 or later                          | A terminal, a CI job or an agent runs it |
| `@explorer-verify/foundry` | Finds a contract's build files under `out/` and builds the input             | Node.js 22.18 or later                          | Node.js code works in a Foundry project  |
| `@explorer-verify/hardhat` | Finds a contract's build files in a Hardhat 2 or 3 project, builds the input | Node.js 22.18 or later                          | Node.js code works in a Hardhat project  |

The Foundry and Hardhat packages read files, so they run only on Node.js. They return the input;
`explorer-verify` then verifies it, so install both.

## Main entry or core entry

The main entry, `explorer-verify`, loads the explorer clients and the
[routing table](../explanation/glossary.md#routing-table) with a dynamic `import()` when a call
needs them. Start there.

The core entry, `explorer-verify/core`, takes the clients from `explorer-verify/clients/<name>` and
the table from `explorer-verify/table` in your options. It holds no dynamic `import()`. Pick it when you
bundle to one file and want only the clients you use. Both entries give the same results and errors. See [Core entry](../reference/core.md).

## The server entry

`explorer-verify/server` exports `createVerifyHandler`. It answers verify requests from your
browser app and adds the Etherscan key on your server, so the key never reaches the client. It
runs where `Request` and `Response` exist, such as a Next.js route or a Cloudflare Worker. See
[Run the server handler](../guides/run-the-server-handler.md).

## The small entries

These entries load none of the verification flow, so a page or a tool that needs only one of them
stays small:

| Entry                                  | What it holds                                                  | Use it when                                                               |
| -------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `explorer-verify/handle`               | `formatHandle`, `parseHandle`, `tryParseHandle`                | A page stores a handle and reads it after a reload                        |
| `explorer-verify/errors`               | `ExplorerVerifyError`, `ERROR_CODES`, `ERROR_HINTS`, `hintFor` | Your tool maps error codes to its own messages, or shows errors to people |
| `explorer-verify/backends`             | `BACKEND_NAMES`, `toBackendName`                               | A form or a flag lists or checks backend names                            |
| `explorer-verify/envelope`             | `toEnvelope`, `exitCodeOf`                                     | Your tool prints the CLI's JSON or its exit codes                         |
| `explorer-verify/resolve`              | `buildVerifyInputFromBytecode`                                 | You have only the deployed bytecode                                       |
| `explorer-verify/input.schema.json`    | The JSON Schema of a verify request                            | Another language writes the request                                       |
| `explorer-verify/envelope.schema.json` | The JSON Schema of the CLI's JSON output                       | Another language reads the CLI's output                                   |
| `explorer-verify/event.schema.json`    | The JSON Schema of the stage events                            | You store or forward the events                                           |

Show errors to the people who use your app with `hintFor(error, "user")`: it names no function,
option or field. `error.hint` and `ERROR_HINTS` are for developers, and can name options such as
`timeoutMs`. [Show errors to your users](../guides/wrap-explorer-verify-in-your-tool.md#show-errors-to-your-users)
shows both.

## The CLI reads Foundry and Hardhat projects

With the CLI you do not install the Foundry or Hardhat package: `--foundry .` and `--hardhat .`
read the project. Without a local install, `npx` downloads the CLI on the first run.

The CLI also reads a whole request from a JSON file. Save
[greeter-sepolia.json](greeter-sepolia.json), a request for a contract on Sepolia that Sourcify
already holds. Then run a dry run, which needs no key and submits nothing:

```sh
# exit code 0
npx @explorer-verify/cli verify --input-json greeter-sepolia.json \
  --dry-run --json
```

```text
{"schemaVersion":1,"ok":true,"result":{"status":"dry-run","backend":"sourcify","apiHost":"sourcify.dev","lookup":"exact","explorerUrl":"https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc","routedBy":"table"}}
```

`lookup: "exact"` says Sourcify already holds an exact match, so a real run would submit nothing.
See [Verify from CI with the CLI](../guides/verify-from-ci-with-the-cli.md) for a real run.

## Next steps

- [Verify from a browser](../guides/verify-from-a-browser.md)
- [Verify from Node.js](../guides/verify-from-node.md)
- [Verify from CI with the CLI](../guides/verify-from-ci-with-the-cli.md)
- [Verify a contract from a Foundry project](../guides/verify-from-a-foundry-project.md)
- [Verify a contract from a Hardhat project](../guides/verify-from-a-hardhat-project.md)
- [Wrap explorer-verify behind your tool's API](../guides/wrap-explorer-verify-in-your-tool.md)
- [Glossary](../explanation/glossary.md): the terms these pages use
