# Using explorer-verify from an agent

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: coding agents, and the people who run them, calling explorer-verify on someone's behalf.
Nothing is released yet, and none of the steps below exist. This page states the rules the library
and the CLI will follow. It grows with each feature.

## Submit is permanent

Submit sends the source to the explorer, which publishes it. The step is outward and permanent: you
cannot take it back. Run a dry run first, and submit only when the person asked for verification of
that contract on that chain.

## Safe steps

These steps never submit. You can run them without asking.

| Step     | Effect                                                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Validate | Checks the input locally. Sends nothing                                                                                            |
| Dry run  | Validates, resolves the explorer, builds the request and asks the explorer whether the contract is already verified. Never submits |
| Lookup   | Asks the explorer whether the contract is verified                                                                                 |
| Status   | Asks the explorer about a submission it already has                                                                                |

A dry run needs no API key. When the explorer needs a key and none is set, the dry run skips the
lookup and says so.

## API keys

- Read keys from an environment variable or a key file. Never pass a key as a command-line flag
  value: flags end up in shell history, process lists and CI logs.
- Never print, log or commit a key. explorer-verify will redact keys from its errors and results
  (R-SEC-1).
- In a browser, do not ship an Etherscan key to the client; Etherscan's API terms forbid it. Use
  the server handler, planned for a later release, which keeps the key on your server.

## Etherscan plan rule

A public dapp, or any use by a business, protocol, foundation or DAO, needs an Etherscan Advanced
plan or higher and its own key. When it displays Etherscan data, it must show "Powered by
Etherscan.io APIs". Tell the person when their use falls under this rule.

Etherscan's Free, Lite and Standard plans cover personal and research use only, such as a developer
verifying their own testnet deployments. Commercial use includes anything offered to third parties,
free or paid, anything that earns revenue, and anything run by or for a company or other
organisation. This is a reading of the terms at <https://etherscan.io/apiterms> (1 October 2026),
not legal advice.

This rule comes from Etherscan's API terms. Sourcify needs no key. This page does not cover the
terms of Blockscout, Routescan or Sourcify; check them before you rely on those APIs.
