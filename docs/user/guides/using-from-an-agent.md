# Using explorer-verify from an agent

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: coding agents, and the people who run them, calling explorer-verify on someone's behalf.
Nothing is released yet. Of the steps below, validation and the input build exist, as
`validateInput()` and `buildVerifyInput()`, and [`verify()`](../reference/verify.md) runs the
lookup and the submit. This page
states the rules the library and the CLI will follow. It grows with each feature.

The package also ships a skill, [skills/explorer-verify/SKILL.md](../../../skills/explorer-verify/SKILL.md),
with tested examples of each step: build the input, verify, resume from the handle, read the
outcome, and when to stop.

## Submit is permanent

Submit sends the source to the explorer, which publishes it. The step is outward and permanent: you
cannot take it back. `verify()` submits, unless its lookup finds the contract already verified. Submit only when the
person asked for verification of that contract on that chain. A dry run is planned but not
available yet: until then, run the build and validation steps first.

A Sourcify submit can also publish the source on other explorers: Sourcify forwards it to
Etherscan, Blockscout and Routescan. See [Sourcify](../reference/sourcify.md#behaviour-to-know).

## Safe steps

These steps never submit. You can run them without asking.

| Step     | Effect                                                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Build    | `buildVerifyInput(documents)` builds the compiler input and contract name from parsed build files. Sends nothing                   |
| Validate | `validateInput(input)` checks the input locally and lists every problem. Sends nothing                                             |
| Dry run  | Not available yet. Planned: validates, resolves the explorer, builds the request and asks whether the contract is already verified |
| Lookup   | Not available yet as its own call. `verify()` runs it before it submits                                                            |
| Status   | [`checkStatus(handle)`](../reference/check-status.md) asks the explorer about a submission it already has. Never submits           |

Once it exists, a dry run will need no API key. When the explorer needs a key and none is set, the
dry run will skip the lookup and say so.

## API keys

- Read keys from an environment variable or a key file. Never pass a key as a command-line flag
  value: flags end up in shell history, process lists and CI logs.
- Never print, log or commit a key. explorer-verify errors replace keys with `[redacted]`; see
  [API keys in errors](../reference/errors/index.md#api-keys-in-errors). Results are redacted the
  same way.
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
