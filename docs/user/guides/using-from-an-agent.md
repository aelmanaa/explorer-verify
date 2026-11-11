# Using explorer-verify from an agent

<!-- docs-style: legacy -->

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: coding agents, and the people who run them, that call explorer-verify or the
`explorer-verify` command on someone's behalf.

One step is outward and permanent: the submit, which publishes the source on a public explorer.
Linking a proxy with `linkProxy()` is outward too: it changes the proxy's page on the explorer.
Every other step reads local files or asks an explorer a question. This page says which call and
which command does what, where API keys come from, how to read an outcome and when to stop and ask
the person.

Read the docs of the installed version first: `node_modules/explorer-verify/llms.txt` and the pages
under `docs/` next to it. The docs site, <https://aelmanaa.github.io/explorer-verify/>, describes the
version on npm `latest`, which may be newer. Append `.md` to a site page's URL for its Markdown
copy, for example the `docsUrl` of an error plus `.md`. A folder's page is `index.md`, such as
<https://aelmanaa.github.io/explorer-verify/reference/errors/index.md>.

The package also ships a skill,
[skills/explorer-verify/SKILL.md](../../../skills/explorer-verify/SKILL.md), with tested examples
of each step. For the command, start with `explorer-verify --help --json`: it lists the commands,
options, environment variables and exit codes as one envelope. The [CLI reference](../reference/cli.md)
describes every option.

## Submit is permanent

These calls and commands send a submission. The explorer publishes the source, and you cannot take
it back.

| Call or command          | What it sends                                                                                                                                                                                                                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify()`               | Looks the contract up, then submits the source when the explorer lacks it, and polls the job                                                                                                                                                                                                                                 |
| `verifyEach()`           | Runs `verify()` on each backend it lists, so it can submit to several explorers in one call                                                                                                                                                                                                                                  |
| `explorer-verify verify` | Runs `verify()`, or `verifyEach()` when `--backend` is given more than once. Without `--dry-run` it submits when the lookup finds no match                                                                                                                                                                                   |
| `createVerifyHandler()`  | Returns a handler you deploy on your server. It forwards a browser's Etherscan submits with your key, so whoever can reach it can submit under your key. See [Server handler](../reference/server-handler.md#who-may-verify)                                                                                                 |
| `linkProxy()`            | Asks Etherscan, a standalone Etherscan-compatible explorer or Blockscout to link a proxy to its implementation, which changes the proxy's page there. It submits no source. On Sourcify it only reads. With `resumeJobId` it sends no link request and only checks the pending link. See [Verify a proxy](verify-a-proxy.md) |

Submit only when the person asked you to verify that contract on that chain. Run a dry run first,
and ask before the real run when the dry run says it would submit.

A Sourcify submit can also publish the source on other explorers: Sourcify forwards it to
Etherscan, Blockscout and Routescan. See [Sourcify](../reference/sourcify.md#behaviour-to-know).

## Safe steps

These calls and commands never submit. Run them without asking.

| Step               | Call or command                                                                                                                                                                                                         | Effect                                                                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build              | `buildVerifyInput()`, `buildVerifyInputFromFoundry()`, `findFoundryBuild()`, `buildVerifyInputFromHardhat()`, `findHardhatBuild()`                                                                                      | Build the compiler input and contract name from build files. Read local files, send nothing                                                                                                       |
| Validate           | `validateInput()`, `linkLibraries()`                                                                                                                                                                                    | Check the input and list every problem; add library addresses to `settings.libraries`. Send nothing                                                                                               |
| Resolve            | `buildVerifyInputFromBytecode()`                                                                                                                                                                                        | Reads the bytecode from your RPC endpoint, and the metadata and sources from Sourcify or an IPFS gateway. Read-only requests                                                                      |
| Dry run and lookup | `dryRun()`, `explorer-verify verify --dry-run`                                                                                                                                                                          | Validates, resolves the explorer and looks the contract up once, which tells whether `verify()` would submit. Never submits                                                                       |
| Status             | `checkStatus()`, `explorer-verify status`                                                                                                                                                                               | Polls the job of a handle, for a submission the explorer already has. Never submits                                                                                                               |
| Handles and output | `parseHandle()`, `tryParseHandle()`, `isHandleString()`, `formatHandle()`, `toEnvelope()`, `exitCodeOf()`, `toBackendName()`, `routingTableDate()`, `routesFor()`                                                       | Read or write a handle, turn an outcome into the JSON envelope and the exit code, check a backend name, give the routing table's date, list a chain's backends and the table's pick. Send nothing |
| Clients            | `sourcify()`, `sourcifyProxyLink()`, `etherscanV2()`, `etherscanV2ProxyLink()`, `etherscanCompatible()`, `etherscanCompatibleProxyLink()`, `routescan()`, `blockscout()`, `blockscoutHosted()`, `blockscoutProxyLink()` | Create the explorer clients that the functions of `explorer-verify/core` take. Send nothing                                                                                                       |
| Help and version   | `explorer-verify help`, `explorer-verify --version --json`                                                                                                                                                              | Print the help or the versions and the routing table's date. Contact no explorer                                                                                                                  |

`buildVerifyInputFromFoundry()` and `findFoundryBuild()` come from `@explorer-verify/foundry`,
`buildVerifyInputFromHardhat()` and `findHardhatBuild()` from `@explorer-verify/hardhat`,
`buildVerifyInputFromBytecode()` from `explorer-verify/resolve` and `createVerifyHandler()` from
`explorer-verify/server`, `toEnvelope()` and `exitCodeOf()` from `explorer-verify/envelope`, and
the clients from `explorer-verify/clients/<name>`. `explorer-verify/core` has the same `verify()`, `dryRun()`, `checkStatus()`, `verifyEach()` and `linkProxy()`, which take the clients ([Core entry](../reference/core.md)). The rest come from `explorer-verify`.

### Dry run before you submit

A dry run needs no API key. Read its `lookup` field:

- `exact` or `partial`: the explorer already holds the contract. `verify` would submit nothing,
  unless the result has `storedContract`: then the match is another contract's source and `verify`
  would submit. Ask the person first.
- `none`: `verify` would submit. Ask the person before you run it without `--dry-run`.
- `skipped`: the backend needs an API key and none is set, so no request was sent. `verify` would
  exit 3 with `missing-api-key`. Ask the person to set the key.

In the library:

```ts
import { dryRun } from "explorer-verify";

const plan = await dryRun(input);
if (plan.lookup === "none") {
  console.log(`verify() would submit to ${plan.backend}: ask the person first`);
} else if (plan.lookup === "skipped") {
  console.log(`${plan.backend} needs an API key: ask the person to set it`);
} else {
  console.log(
    `${plan.backend} already holds the contract, ${plan.lookup} match: nothing to submit`,
  );
}
```

Here Sourcify does not hold the contract yet, so it prints:

```text
verify() would submit to sourcify: ask the person first
```

With the command, in a project whose `verify-input.json` holds the request as
[`--input-json`](../reference/cli.md#the-request-as-json) reads it, with
`"route": { "backend": "sourcify" }`:

```sh
# exit code 0
explorer-verify verify --input-json verify-input.json --dry-run --json
```

```text
{"schemaVersion":1,"ok":true,"result":{"status":"dry-run","backend":"sourcify","apiHost":"sourcify.dev","lookup":"exact","explorerUrl":"https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc","routedBy":"caller"}}
```

The `backend` field names the explorer the real run would use. The routing table picks the first
backend of the chain's row that works with the keys set: Etherscan v2 when the row has it and an
Etherscan key is set, Sourcify otherwise, and Blockscout or Routescan on a row that lists only
them. [Blockscout](../reference/blockscout.md) comes after Sourcify and Routescan comes last in a
row; reach either with `route: { backend: "blockscout" }` or `route: { backend: "routescan" }`, or
`--backend blockscout` or `--backend routescan`, on a chain whose row lists it, and with
`route.apiUrl` or `--api-url <url>` elsewhere. A chain with no row gives
`unsupported-chain`, exit code 2, unless a library call passes `allowSourcifyFallback: true` or
the CLI gets `--allow-sourcify-fallback`.
[Routing](../reference/routing.md) explains the table.

When the person names an explorer, pass its backend: `--backend etherscan-v2` for Etherscan, or
`route: { backend: "etherscan-v2" }` in a library call. With `--backend` and no key, the command
exits 3 with `missing-api-key` and submits nothing. `verify` without `--dry-run` needs a target:
without `--backend`, it exits 2 with `invalid-input` before any request, and the hint names the
backends the chain lists and what `--backend auto` would pick. Pass `--backend auto` only when the
person accepts the routing table's pick: on Sepolia with no Etherscan key set, that is Sourcify.
In a library call, `verify()` still submits to the routing table's pick when `route.backend` is
absent, so set it there too.

## API keys

Sourcify and Blockscout instances need no key. Etherscan v2 needs one; Routescan takes one
optionally. Blockscout's hosted API, `--backend blockscout-hosted`, needs `BLOCKSCOUT_API_KEY`.

- The command reads `ETHERSCAN_API_KEY`, `ROUTESCAN_API_KEY` and `BLOCKSCOUT_API_KEY` from the
  environment, or one key
  from `--api-key-file <path>` or `--api-key-stdin` with `--backend`. A variable is sent only to
  its routing-table host. With `--api-url` on another host, give the key with one of the two
  flags. `ETHERSCAN_API_KEY` also goes with `--api-url https://api.etherscan.io/v2/api`.
  [CLI: API keys and route options](../reference/cli.md#api-keys-and-route-options) has the rules.
- The library takes keys in `apiKeys`, by backend name, and a standalone explorer's key in
  `route.apiKey`. Each key goes only to its backend's host. [API keys](../reference/api-keys.md)
  lists the hosts.
- In a browser, do not ship an Etherscan key to the client; Etherscan's API terms forbid it. Use
  the [server handler](../reference/server-handler.md), which keeps the key on your server.

The person sets the key, in their own environment, a file or a secret store. Never ask them to
paste a key into the chat. Never write a key into a command line, code, a commit, a fixture or a
log. Do not print or read a key to check that it is set: no `echo`, `cat .env` or `printenv`. Run
a dry run instead: its `backend` and `lookup` show whether the key was used. No flag takes a key as
its value, and the command refuses the flags that look like one:

```sh
# exit code 2
explorer-verify verify --input-json verify-input.json --api-key --json
```

```text
{"schemaVersion":1,"ok":false,"error":{"code":"invalid-input","message":"The command line is invalid: --api-key is not accepted: a key on the command line shows in the process list and the shell history; set ETHERSCAN_API_KEY, ROUTESCAN_API_KEY or BLOCKSCOUT_API_KEY, or use --api-key-file <path> or --api-key-stdin.","hint":"Fix the arguments the message names, then run the command again. explorer-verify --help lists every command and option.","docsUrl":"https://aelmanaa.github.io/explorer-verify/reference/errors/invalid-input","retryable":false,"details":{"code":"invalid-input","issues":[{"field":"--api-key","message":"is not accepted: a key on the command line shows in the process list and the shell history; set ETHERSCAN_API_KEY, ROUTESCAN_API_KEY or BLOCKSCOUT_API_KEY, or use --api-key-file <path> or --api-key-stdin"}]}}}
```

Errors, events, log lines, results and the command's output replace keys with `[redacted]`; see
[API keys in errors](../reference/errors/index.md#api-keys-in-errors). When you print an envelope
from the library, pass every key the process holds: `toEnvelope(outcome, { secrets: [key] })`.

## Reading the outcome

Pass `--json` on every run. stdout then holds exactly one line, the
[JSON envelope](../reference/json-output.md#the-envelope), and logs go to stderr. `ok` is `true`
exactly when the exit code is 0. The envelope holds a `result` for `verified`, `already-verified`
and `failed`, an `error` with `code`, `hint`, `retryable` and sometimes `handle` otherwise, and,
for `--dry-run`, a `result` whose `status` is `dry-run`.

As soon as the explorer accepts a submission, stderr gets this line at the default level:

```text
Submitted to sourcify. Handle: ev1:sourcify:11155111:0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718
```

Store the handle at once: it is the only way back to the job after a timeout, a cancel or a crash.
With `--log-format json`, the same line is a JSON object whose `type` is `verify.submitted` and
whose `handle` field holds the handle. `--quiet` hides the line, so do not pass it to a run that
may submit. In the library, the handle comes in the `verify.submitted` event.

Act on the exit code:

| Exit code | Outcome                                                        | What to do                                                                                                                                                                                                                                                                   |
| --------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0         | `verified`, `already-verified`, or a dry run                   | Done. Delete the stored handle                                                                                                                                                                                                                                               |
| 1         | `failed`: the explorer rejected the source                     | Report `result.reason`. Do not change the sources or settings and submit again unless the person asks                                                                                                                                                                        |
| 2         | Usage or input error. Nothing was submitted for verification   | Fix what the message and the hint name, then run again                                                                                                                                                                                                                       |
| 3         | API key missing, rejected or out of quota                      | Stop. Ask the person to set a key, fix it or wait for the limit to reset                                                                                                                                                                                                     |
| 4         | `not-confirmed` (with a handle) or `verification-inconclusive` | If the envelope has `error.handle`, or you ran `status`, run `explorer-verify status <handle>` again later. Otherwise run `verify` again later, once                                                                                                                         |
| 5         | Network or explorer unavailable after retries                  | Later, at most once or twice: if the envelope has `error.handle`, or you ran `status`, run `explorer-verify status <handle>` again. Otherwise run `verify` again; it looks the contract up before it submits                                                                 |
| 6         | `unknown-state`, `job-not-found` or `internal-error`           | Stop. Do not retry automatically. Give the person the handle, the code and the hint                                                                                                                                                                                          |
| 130       | Cancelled                                                      | With a handle in `error.handle` or on the stderr line, run `explorer-verify status <handle>`. With `error.handles`, from a run on several backends, run `status` for each handle. With no handle, nothing was accepted. Run `verify` again only if the person still wants it |

A run with `--backend` repeated has one exit code for all its backends: the first of 6, 4, 3, 2, 5,
1 and 130 that any backend has. Act on each entry of `result.outcomes`, not on the exit code
alone.

Resume a pending or cancelled run with `explorer-verify status <handle>` and the same route options
as the submit, never with a new `verify`. If an error carries a handle, retry only with `status`
or `checkStatus()`, never with `verify`. It uses the same exit codes:

```sh
# exit code 0
explorer-verify status ev1:sourcify:11155111:0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718 --json
```

```text
{"schemaVersion":1,"ok":true,"result":{"status":"verified","backend":"sourcify","match":"exact","explorerUrl":"https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc"}}
```

Keep to the limits in the skill's [When to stop](../../../skills/explorer-verify/SKILL.md#when-to-stop):
at most 3 status checks for one handle. After `verification-inconclusive` or exit code 5, at most
one more `verify`. After `job-not-found`, ask the person first, then at most one `verify`. Then
report to the person. [Errors](../reference/errors/index.md#exit-codes) lists the error codes behind each exit
code, with one page per code.

## Etherscan plan rule

A public dapp, or any use by a business, protocol, foundation or DAO, needs an Etherscan Advanced
plan or higher and its own key. When it displays Etherscan data, it must show "Powered by
Etherscan.io APIs". Tell the person when their use falls under this rule.

Etherscan's Free, Lite and Standard plans cover personal and research use only, such as a developer
verifying their own testnet deployments. Commercial use includes anything offered to third parties,
free or paid, anything that earns revenue, and anything run by or for a company or other
organisation. This is a reading of the terms at <https://etherscan.io/apiterms> (last updated 1
October 2026, read again on 2026-11-04), not legal advice.
[Etherscan plans and attribution](../explanation/etherscan-plans-and-attribution.md) explains it.

This rule comes from Etherscan's API terms. Sourcify needs no key. This page does not cover the
terms of Blockscout, Routescan or Sourcify; check them before you rely on those APIs.
