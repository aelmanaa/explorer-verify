# Using explorer-verify from an agent

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: coding agents, and the people who run them, calling explorer-verify on someone's behalf.
Nothing is released yet. This page states the rules the library and the CLI are built to; it grows
with each feature.

## Safe steps and the permanent step

| Step       | Effect                                               | Safe to run without asking |
| ---------- | ---------------------------------------------------- | -------------------------- |
| Validate   | Checks the input locally. Sends nothing              | Yes                        |
| Dry run    | Validates, resolves the explorer, builds the request | Yes                        |
| Lookup     | Asks the explorer whether the contract is verified   | Yes                        |
| Status     | Asks the explorer about a submission it already has  | Yes                        |
| **Submit** | Sends the source to the explorer, which publishes it | **No**                     |

Submit is outward and permanent. The explorer publishes the source, and you cannot take it back.
Run a dry run first, and submit only when the person asked for verification of that contract on
that chain.

A dry run needs no API key. When the explorer needs a key and none is set, the dry run skips the
lookup and says so.

## API keys

- Read keys from an environment variable or a key file. Never pass a key as a command-line flag
  value: flags end up in shell history, process lists and CI logs.
- Never print, log or commit a key. explorer-verify redacts keys from its errors and results.
- In a browser, do not ship an Etherscan key to the client. Use the server handler, which keeps the
  key on your server.

## Etherscan plan rule

A public dapp, or any use by a business, protocol, foundation or DAO, needs an Etherscan Advanced
plan or higher and its own key. When it displays Etherscan data, it must show "Powered by
Etherscan.io APIs". Tell the person when their use falls under this rule. The rule covers
Etherscan only; Sourcify needs no key.
