# @explorer-verify/cli

## 0.2.1

### Patch Changes

- Updated dependencies [[`8c72179`](https://github.com/aelmanaa/explorer-verify/commit/8c72179b3e304c3c47c3b5083efd427b17dfe52c)]:
  - explorer-verify@0.2.1
  - @explorer-verify/foundry@0.2.1
  - @explorer-verify/hardhat@0.2.1

## 0.2.0

### Minor Changes

- [#338](https://github.com/aelmanaa/explorer-verify/pull/338) [`1162d86`](https://github.com/aelmanaa/explorer-verify/commit/1162d86dbc4adde5dad787c262965488f21ffcaa) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Breaking: `verify()` now submits when the explorer's match comes from another contract's source,
  and Routescan matches are `partial`. Sourcify, Blockscout and Routescan can hold a match for a new
  contract within two minutes of its deployment, made from another project's source. Before,
  `verify()` returned `already-verified` for it and never sent your source.
  
  The breaking changes:
  
  - `already-verified` can now follow a submit. The lookup reads the contract name and the compiler
    version the explorer stores; when either differs from the input, `verify()` submits. A match of
    your own source still ends the call with no submit.
  - A new field, `storedContract: { name?, compilerVersion? }`, on `already-verified` and on
    `dryRun()`, names the other contract when the explorer refuses your source as already verified.
    Its `match` is then `partial`. `storedContract` present means your source is not on the
    explorer, while the exit code stays 0 and `ok` stays `true`: check
    `result.storedContract === undefined` to require your own source.
  - Every Routescan match is `partial`, from a lookup or from `Pass - Verified`, where it was
    `exact`: Routescan states no grade. After `Fail - Unable to verify`, a Routescan lookup that
    finds the source now gives `already-verified` with `partial`, where it gave `verified` with
    `exact`.
  - The CLI summary and its JSON output show `storedContract`, and the envelope schema lists it.
  
  Also:
  
  - The Sourcify lookup asks for `fields=compilation`.
  - The stored name and version are cut to 300 characters, their control characters are replaced
    and your keys are removed from them. The CLI's text log lines show control characters as
    escapes.
  
  [#293](https://github.com/aelmanaa/explorer-verify/issues/293)

- [#348](https://github.com/aelmanaa/explorer-verify/pull/348) [`fba3a2a`](https://github.com/aelmanaa/explorer-verify/commit/fba3a2a74b8ccfeabb812b42d033009cf473326d) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Add `submitOverPartial` to `verify()` and `verifyEach()`, and `--submit-over-partial` to the
  `verify` command. By default, a partial match of your own source ends the call as
  `already-verified` without a submit. With the option, explorer-verify submits your source so the
  explorer can replace the partial match with an exact one. An exact match never submits.
  
  - The result follows the explorer: `verified` with the job's match, or `already-verified` with the
    match a lookup reads when the explorer answers that the contract is already verified.
  - When the explorer rejects the source, the partial match stays and the result is
    `already-verified` with `partial`, not `failed`. A `warn` line gives the explorer's reason. On
    Etherscan, Routescan and the Etherscan-compatible explorers, a lookup after the rejection that
    finds no match gives `failed`.
  - After the submit, a lookup that finds only the partial match does not confirm the job.
  - The handle of such a job ends with `:over-partial`, and its object has `overPartial: true`.
    `checkStatus()` and `explorer-verify status` end the job by the same rules. Every other handle
    reads and resumes as before.
  - Every Routescan match is `partial`, so on Routescan the option submits over every match, and
    Routescan replaces the source it holds.
  - `dryRun()` takes the option and says whether `verify()` would submit over a partial match; the
    CLI's dry-run summary follows `--submit-over-partial`.
  - A value that is not a boolean throws `invalid-input`. The CLI refuses `submitOverPartial` in an
    `--input-json` request and names the flag.
  
  On Ethereum Sepolia on 2026-11-11, Sourcify and Blockscout upgraded a partial match to exact after
  a submit of the exact source, and Routescan replaced the source it held.

- [#345](https://github.com/aelmanaa/explorer-verify/pull/345) [`1ef1660`](https://github.com/aelmanaa/explorer-verify/commit/1ef16609b9ea50793970ef4565460d4916496672) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Breaking: when Etherscan, Routescan or an Etherscan-compatible explorer still finds no contract code
  at the address, `verify()` now throws the new `not-indexed` error instead of `timeout` or
  `unexpected-response`. The CLI and the JSON envelope exit 4 for this case, where they exited 5.
  `not-indexed` is retryable, carries no handle, and has `details.backend`, `details.submits` and
  `details.elapsedMs`. Its hint says to check the chain ID and the address, then try again in a
  minute.
  
  `verify()` and `verifyEach()` also take `indexWaitMs`: how long to send the submit again while the
  explorer finds no contract code, as it does right after a deployment. The wait counts from the
  first submit, never cuts a wait short and stays within `timeoutMs`. Without it, `verify()` sends at
  most 10 submits, as before.
  
  ```ts
  await verify(input, { indexWaitMs: 120_000, timeoutMs: 300_000 });
  ```
  
  What should I do? Where you matched `timeout` or `unexpected-response` for this case, match
  `not-indexed`. In a script that reads exit codes, treat exit 4 with no handle as "run verify again
  later". Right after a deployment, pass `indexWaitMs` to wait longer.
  
  [#297](https://github.com/aelmanaa/explorer-verify/issues/297)

### Patch Changes

- [#345](https://github.com/aelmanaa/explorer-verify/pull/345) [`1ef1660`](https://github.com/aelmanaa/explorer-verify/commit/1ef16609b9ea50793970ef4565460d4916496672) Thanks [@aelmanaa](https://github.com/aelmanaa)! - When Blockscout answers each submit without a job id, the CLI now prints "If the contract was deployed moments ago, try again later." Before, it printed the general `unexpected-response` hint. A `timeout` always gets the CLI's own hint, which names `--timeout`.
  
  [#326](https://github.com/aelmanaa/explorer-verify/issues/326)

- [#360](https://github.com/aelmanaa/explorer-verify/pull/360) [`93488b4`](https://github.com/aelmanaa/explorer-verify/commit/93488b4db2ca5b04d5fca6381986a6a877e7ee15) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `verify` takes `--index-wait <seconds>`: how long to keep sending the submit while the explorer
  finds no contract code at the address, as right after a deployment. It sets the library's
  `indexWaitMs`.
  
  - It applies to `etherscan-v2`, `routescan` and `etherscan-compatible` only. When every backend
    named on the command line is another one, the run logs one warning.
  - `--timeout` caps it. It takes whole seconds from 1 to 2147483, and it may go with
    `--input-json`. A request that holds `indexWaitMs` exits 2 and names `--index-wait`. Any other value exits 2 with `invalid-input` naming `--index-wait`.
  - Without it, the CLI sends the submit at most 10 times, as before: about 27 seconds at the
    default `--poll-interval`. A value under about 30 waits less than that.
  
  ```sh
  explorer-verify verify 0x… --chain sepolia --foundry . --contract src/Greeter.sol:Greeter \
    --backend etherscan-v2 --index-wait 120 --timeout 300
  ```
  
  The `not-indexed` hint no longer names `--address`, which the CLI does not accept. It names
  `--chain` and the address argument, and says to raise `--index-wait` and `--timeout`. Each new
  submit now prints one warning line on stderr instead of two.
  
  [#352](https://github.com/aelmanaa/explorer-verify/issues/352)

- [#360](https://github.com/aelmanaa/explorer-verify/pull/360) [`93488b4`](https://github.com/aelmanaa/explorer-verify/commit/93488b4db2ca5b04d5fca6381986a6a877e7ee15) Thanks [@aelmanaa](https://github.com/aelmanaa)! - A project folder that does not exist, is a file or cannot be read is now reported on `root`:
  "The input is invalid: root is not a folder: it does not exist." The message never repeats the
  path, since a path typed by mistake can hold a key. Both helpers use the same wording.
  
  The Hardhat helper checks `root` first, before the artifacts folder, even when `outDir` or
  `artifact` is an absolute path. It no longer reports a missing `outDir` that the caller did not
  pass.
  
  The Foundry helper's `invalid-input` messages now carry the issue text, as the Hardhat helper's
  do: "The input is invalid: root is not a folder: …" instead of "The input is invalid: root." An
  output directory that this process cannot read is now `outDir could not be read`, not
  `outDir is not a directory`.
  
  The CLI names `--foundry` or `--hardhat` in the message and the issue, and its hint says to check
  the folder instead of to compile the project:
  
  ```text
  $ explorer-verify verify 0x… --chain 11155111 --hardhat no/such/project --contract contracts/A.sol:A --dry-run
  error: The input is invalid: --hardhat is not a folder: it does not exist. (invalid-input)
    hint: Check the folder that --hardhat names: it must exist and should hold the Hardhat config. Pass . for the current folder.
  ```
  
  Without `--out-dir`, a project folder with no output folder, or one the CLI cannot read, now
  names the project flag in the message too, for both Foundry and Hardhat: "The input is invalid:
  --hardhat has no artifacts folder: build the project, or pass --out-dir." The message used to
  name `--out-dir`, which the caller had not passed. The hint is unchanged.
  
  [#350](https://github.com/aelmanaa/explorer-verify/issues/350)

- [#301](https://github.com/aelmanaa/explorer-verify/pull/301) [`9bb2f0f`](https://github.com/aelmanaa/explorer-verify/commit/9bb2f0f0e534365a078d7459e14dd58a4bd35684) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The READMEs and the Setup sections of the user guides now say how the supported Node.js range
  changes: it follows Node's active and maintenance LTS lines, and a line is dropped when it reaches
  end of life, in a minor release while the version is 0.x. Node 22 reaches end of life on
  2027-04-30. Node 20 is not supported. `engines.node` stays `>=22.18.0`.
  
  Issue: https://github.com/aelmanaa/explorer-verify/issues/291

- [#360](https://github.com/aelmanaa/explorer-verify/pull/360) [`93488b4`](https://github.com/aelmanaa/explorer-verify/commit/93488b4db2ca5b04d5fca6381986a6a877e7ee15) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `explorer-verify verify` takes `--require-own-source`. When the explorer holds another contract's
  source at the address, `verify` returns `already-verified` with `result.storedContract`, and the
  run exits 0. With the flag, that run exits 1 instead, and the JSON envelope keeps the result with
  `ok: false`. Without the flag, nothing changes.
  
  ```sh
  explorer-verify verify 0x… --chain sepolia --foundry . --contract src/Greeter.sol:Greeter \
    --backend sourcify --require-own-source --json
  ```
  
  With a repeated `--backend`, each outcome with another contract's source gets `ok: false` and
  counts as exit code 1. `status` does not take the flag: a resumed handle never carries
  `storedContract`.
  
  `envelope.schema.json` accepts the two new forms: `ok: false` with an `already-verified` result
  that has `storedContract`, at the top level and in an outcome. Its description now says that,
  within `schemaVersion` 1, a release may add forms that only an opt-in CLI flag produces. A run
  without the flag never prints them, so this is a patch. `toEnvelope()` and `exitCodeOf()` are
  unchanged.
  
  [#351](https://github.com/aelmanaa/explorer-verify/issues/351)

- [#300](https://github.com/aelmanaa/explorer-verify/pull/300) [`7ee0497`](https://github.com/aelmanaa/explorer-verify/commit/7ee049753c0162a44b2f6e61b9c9b5cd263c4b0d) Thanks [@aelmanaa](https://github.com/aelmanaa)! - TypeScript projects that set `"moduleResolution": "node"` now find the types of every subpath, such as `explorer-verify/core` and `explorer-verify/clients/sourcify`, and of the JSON schema files. Before, these imports failed with TS2307. `bundler`, `node16` and `nodenext` resolve the same files as before. [#295](https://github.com/aelmanaa/explorer-verify/issues/295)
- Updated dependencies [[`acd9ffd`](https://github.com/aelmanaa/explorer-verify/commit/acd9ffd171e26af0802b6a68ba0d221988e752cf), [`a64a7aa`](https://github.com/aelmanaa/explorer-verify/commit/a64a7aa80a25f786d71bc5010c6ba8987f1cf8f1), [`c1ef895`](https://github.com/aelmanaa/explorer-verify/commit/c1ef895ef2865b5b56c05ab7c16659ac1b69a8d6), [`ec55dde`](https://github.com/aelmanaa/explorer-verify/commit/ec55ddede0e935d3ce77f6566cae89c57cfbdea6), [`72de386`](https://github.com/aelmanaa/explorer-verify/commit/72de38635010c26a34014f3fe2256585e1eab09e), [`1162d86`](https://github.com/aelmanaa/explorer-verify/commit/1162d86dbc4adde5dad787c262965488f21ffcaa), [`ec55dde`](https://github.com/aelmanaa/explorer-verify/commit/ec55ddede0e935d3ce77f6566cae89c57cfbdea6), [`1ef1660`](https://github.com/aelmanaa/explorer-verify/commit/1ef16609b9ea50793970ef4565460d4916496672), [`1ef1660`](https://github.com/aelmanaa/explorer-verify/commit/1ef16609b9ea50793970ef4565460d4916496672), [`015930d`](https://github.com/aelmanaa/explorer-verify/commit/015930dc9993cd6cfb050374322076d702624225), [`93488b4`](https://github.com/aelmanaa/explorer-verify/commit/93488b4db2ca5b04d5fca6381986a6a877e7ee15), [`c3e5ed8`](https://github.com/aelmanaa/explorer-verify/commit/c3e5ed8f5bceac042246390f42a80c4cb051ebaa), [`9bb2f0f`](https://github.com/aelmanaa/explorer-verify/commit/9bb2f0f0e534365a078d7459e14dd58a4bd35684), [`6ad0688`](https://github.com/aelmanaa/explorer-verify/commit/6ad0688bd6e50a3356718fe5aaaa4c524554ded8), [`899e945`](https://github.com/aelmanaa/explorer-verify/commit/899e9454200f67106881efe6eefa5e767875e7a8), [`93488b4`](https://github.com/aelmanaa/explorer-verify/commit/93488b4db2ca5b04d5fca6381986a6a877e7ee15), [`ec55dde`](https://github.com/aelmanaa/explorer-verify/commit/ec55ddede0e935d3ce77f6566cae89c57cfbdea6), [`1a2c786`](https://github.com/aelmanaa/explorer-verify/commit/1a2c786f76dedeef3286f3bbdc8926bdea03a155), [`2c317c0`](https://github.com/aelmanaa/explorer-verify/commit/2c317c0a37872c3b92292f48af56610d4d522e54), [`ec55dde`](https://github.com/aelmanaa/explorer-verify/commit/ec55ddede0e935d3ce77f6566cae89c57cfbdea6), [`fba3a2a`](https://github.com/aelmanaa/explorer-verify/commit/fba3a2a74b8ccfeabb812b42d033009cf473326d), [`7ee0497`](https://github.com/aelmanaa/explorer-verify/commit/7ee049753c0162a44b2f6e61b9c9b5cd263c4b0d), [`1ef1660`](https://github.com/aelmanaa/explorer-verify/commit/1ef16609b9ea50793970ef4565460d4916496672)]:
  - explorer-verify@0.2.0
  - @explorer-verify/foundry@0.2.0
  - @explorer-verify/hardhat@0.2.0

## 0.1.0

### Minor Changes

- [#252](https://github.com/aelmanaa/explorer-verify/pull/252) [`a8f5f1b`](https://github.com/aelmanaa/explorer-verify/commit/a8f5f1baee639046687506c1f6fa5b4779f54f87) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Breaking: an option that takes one value, such as `--chain`, `--contract` or `--compiler-version`, now exits 2 when it is given twice, instead of keeping the last value. `-c` with `--chain` counts as a repeat. `status` with `--api-url` and no `--backend` now exits 2, as `verify` does. A bare `explorer-verify`, `explorer-verify verify` or `explorer-verify status` now prints a short help on stderr, with the usage and two examples, and exits 2. The text of `explorer-verify help <command>` no longer repeats the global options, the environment variables and the exit codes; it points to `explorer-verify --help`, and the `--json` help still holds them. `-V` now means `--version`.
  
  New in the CLI:
  
  - `--chain` takes a chain name, such as `sepolia` or `op-sepolia`, as well as a chain ID. The CLI reference lists the names. An unknown name exits 2, and the hint names the closest name that keeps the chain or the network of the typed one.
  - Short flags: `-c` (`--chain`), `-i` (`--input`), `-n` (`--dry-run`) and `-V` (`--version`).
  - `--backend all` verifies with `verifyEach()` on every backend of the chain's routing-table row that can run, and prints the same envelope as `--backend` repeated for each of them. A backend skipped because its key is not set gets a warning line on stderr that names it and the variable. With `--dry-run` it exits 2, and the hint lists the chain's backends to dry run one at a time.
  - `--poll-interval <seconds>` sets the wait between two status polls for `verify` and `status`, at least 1 second. It may go with `--input-json`.
  - In a run on several backends, each backend's error also goes to stderr, with its hint.
  - A command's usage lines name the options it needs, such as `--chain` and `--input`.
  - At the default level, each fact prints one line on stderr. The library's `info` lines that repeat `verify.submitted`, `verify.result` or a dry run's lookup show only at `--verbose`. `--log-format json` keeps them.
  - An unknown command is the only problem reported. An unknown option close to one of the CLI's names, such as `--colour`, is named as typed, and the argument after it counts as its value. Any other unknown argument is still named by its position.
  - The spinner shows the stage of the run, such as `Waiting for sourcify: pending, poll 3`, and the seconds since the start.
  - The help no longer mentions a pager: the CLI has none.
  
  Issue: https://github.com/aelmanaa/explorer-verify/issues/225

- [#251](https://github.com/aelmanaa/explorer-verify/pull/251) [`f3fda61`](https://github.com/aelmanaa/explorer-verify/commit/f3fda619c3f4e82d20949c02b3876f79bc18e583) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Breaking: `error.toJSON()`, `JSON.stringify(error)` and the JSON envelope now hold the error's
  `details`, redacted, after `handle` and `handles`. A handle in them is in its one-line form. Read
  `error.details.issues` of `invalid-input` or `error.details.candidates` of `incomplete-input`
  instead of parsing the message. `ErrorJson` is now a union keyed by `code`, so checking
  `json.code` narrows `json.details`. New types: `ErrorDetailsJson`, `DetailsJsonOf` and
  `ErrorJsonFields`. The envelope schema requires `details` and lists each code's fields.
  
  The breaking changes:
  
  - Code that compares the error object key for key sees `details`. An `ErrorJson` built by hand in
    TypeScript needs `details` with its code.
  - `toEnvelope()` and `exitCodeOf()` refuse, with `invalid-input`, an error object without
    `details`, a `VerifyEachResult<ErrorJson>` whose error objects lack them, and a
    `not-confirmed`, `job-not-found` or `unknown-state` error object without `handle`. Error JSON
    stored by an earlier version and fed back in is refused.
  - `toEnvelope()` rebuilds the details of every error: a required number that is not finite
    refuses it, an optional one is left out, and a metadata hash of another shape becomes empty.
    For an error object it did not build, it also cuts long strings and lists and rebuilds
    `docsUrl` from the code. This copy's own errors keep their full details, so `toJSON()` equals
    the envelope.
  - `error.details` is frozen, and a non-finite optional number in it is left out. Its arrays,
    `issues`, `candidates`, `attempts` and `handles`, are `readonly` in `ErrorDetails` and
    `ErrorDetailsJson`.
  - The `invalid-input` message of `validateInput()` states the first issue, such as "The input is
    invalid: address must be 0x followed by 40 hex digits."
  - Messages give a time budget in seconds from 1 s, such as "the 4 s budget ran out".
  - The dry-run log line no longer names `verify()`.
  
  The CLI prints a hint of its own for every error code, with its flags and environment variables:
  `missing-api-key` names `ETHERSCAN_API_KEY` or `ROUTESCAN_API_KEY` and `--api-key-file`, and
  `incomplete-input` names `--contract` with the candidate contracts. With `--json`, an error that
  `explorer-verify status` resumes as it is, such as `not-confirmed`, carries `nextCommand`; it
  never submits. Without `--json`, stderr lists the issues and candidates under the error line, the
  next command on a `next:` line, and shows control characters as `\uXXXX`. The JSON log line of an
  error gains a `nextCommand` field. The usage hint reads "lists every command and option", and the
  dry-run summary says "a run without --dry-run would submit". The errors of `--foundry` and
  `--hardhat` keep the helper's message and carry their issues, renamed to the CLI's flags, in
  `details`. Each error page has a "From the CLI" line.
  
  Issue: https://github.com/aelmanaa/explorer-verify/issues/214

- Prepare the first public release of the core, CLI and build helpers. Release and promotion remain separate maintainer actions.
  
  Issue: https://github.com/aelmanaa/explorer-verify/issues/257

### Patch Changes

- [#229](https://github.com/aelmanaa/explorer-verify/pull/229) [`1d0279c`](https://github.com/aelmanaa/explorer-verify/commit/1d0279cf04fa90d4e9e28d63bd3d6eab8137808b) Thanks [@aelmanaa](https://github.com/aelmanaa)! - A new backend, `blockscout-hosted`, verifies through Blockscout's hosted API, `https://api.blockscout.com/<chainId>/api`, for any chain. Name it with `route: { backend: "blockscout-hosted" }` and pass the key as `apiKeys["blockscout-hosted"]`; the key goes only to `api.blockscout.com`, in the `authorization` header as `Bearer <key>`. The routing table never picks it, and `verifyEach()` with `backends: "all"` leaves it out. Its handles start with `ev1:blockscout-hosted:`, so `checkStatus()` resumes on the hosted API. The hosted API's HTTP 401 and 402 answers map to `missing-api-key` or `api-key-rejected`, and its `Network not supported` answer to `unsupported-chain`; the `blockscout` instance client is unchanged. The CLI reads `BLOCKSCOUT_API_KEY` for `--backend blockscout-hosted`. Issue: https://github.com/aelmanaa/explorer-verify/issues/96

- [#128](https://github.com/aelmanaa/explorer-verify/pull/128) [`e0c51de`](https://github.com/aelmanaa/explorer-verify/commit/e0c51de28f562a209b2128ca62be03e3ff5b5cd5) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The CLI reads API keys from `ETHERSCAN_API_KEY` and `ROUTESCAN_API_KEY`, from `--api-key-file <path>` or from `--api-key-stdin`, and never from a flag value. `--api-key`, `--apikey`, `--api_key`, `--key`, `--etherscan-api-key`, `--etherscan-key` and `--routescan-api-key` exit 2 with a hint that names the variables and the two key flags, and the value after them is never echoed. A key from a file or stdin needs `--backend etherscan-v2` or `--backend routescan`, whose `apiKeys` entry it fills, or `--api-url` with `--backend` naming one of those or `etherscan-compatible`, which makes it `route.apiKey` for that host. `--api-key-file` reads only a regular file, so a FIFO or a device exits 2 instead of blocking. `--api-key-stdin` exits 2 at once when stdin is a terminal or with `--input-json -`.
  
  `--backend <name>` and `--api-url <url>` set the route. An error about a key names the variable or the flag, never the key, and an error about a key file does not name its path. Every key the CLI read is removed from stdout and stderr in any letter case, at every log level and format.
  
  [#102](https://github.com/aelmanaa/explorer-verify/issues/102)

- [#126](https://github.com/aelmanaa/explorer-verify/pull/126) [`0a6f2fe`](https://github.com/aelmanaa/explorer-verify/commit/0a6f2fe95dcb810eafe12dfdb615f7e48bbdd8e1) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The CLI gains help and a version. `explorer-verify --help`, `-h`, `help` and `help <command>`
  print examples first, then the usage, the options, the environment variables, the exit codes and
  links to the docs and `llms.txt`, and exit 0. `explorer-verify --version` prints the CLI and core
  versions; with `--json` it also prints `routingTableDate`, the date of the routing table. With
  `--json`, help and the version print one envelope, and the package ships their JSON Schemas as
  `@explorer-verify/cli/help.schema.json` and `@explorer-verify/cli/version.schema.json`.
  
  A mistyped command or option exits 2 with `invalid-input`, and the hint names the closest command
  or option, such as `Did you mean --color?`. The usage hint now also points to `--help`.
  
  The CLI reference is generated from the CLI's help, and `pnpm run check` fails when it is stale.
  
  The core package exports `routingTableDate()`, which returns the date of its routing table.
  
  [#103](https://github.com/aelmanaa/explorer-verify/issues/103)

- [#247](https://github.com/aelmanaa/explorer-verify/pull/247) [`9df3fe1`](https://github.com/aelmanaa/explorer-verify/commit/9df3fe122abecc3d2a85a6432485a1c696281527) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `explorer-verify verify --library` now says what is wrong with a value. A library that is not in a source file of the build, or an address that is not `0x` followed by 40 hex digits, gave only "The input is invalid: libraries.1.". With `--input`, `--foundry` or `--hardhat`, the CLI now names `--library[n]`, says why the value is invalid and what to pass, and exits 2. In the library, `validateInput` gives each `libraries` issue a hint that says what to pass. Issue: https://github.com/aelmanaa/explorer-verify/issues/241

- [#115](https://github.com/aelmanaa/explorer-verify/pull/115) [`33b513b`](https://github.com/aelmanaa/explorer-verify/commit/33b513bab47d9cb12fe2811c3a34cbb4037c9a3c) Thanks [@aelmanaa](https://github.com/aelmanaa)! - New package `@explorer-verify/cli` with the `explorer-verify` bin and its output contract. With
  `--json`, stdout holds one JSON envelope for every exit code, usage errors and cancellation
  included. Logs and stage events go to stderr, as text or with `--log-format json` as one JSON
  object per line. `--quiet`, `--verbose` and `EXPLORER_VERIFY_LOG` set the level. `--color` and
  `NO_COLOR` set colour per stream. SIGINT and SIGTERM exit 130 with a `cancelled` error that
  carries the handle when the explorer accepted the submission.
  
  The core catalogue gains `internal-error`: exit code 6, not retryable, no handle, with its own
  error page. The CLI uses it when an unexpected exception reaches its top level; the library never
  throws it.
  
  [#98](https://github.com/aelmanaa/explorer-verify/issues/98)

- [#242](https://github.com/aelmanaa/explorer-verify/pull/242) [`450b8b4`](https://github.com/aelmanaa/explorer-verify/commit/450b8b4b3d0b9f50dce6670051af9b0b30ec2d59) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `explorer-verify verify` reads a Foundry or Hardhat project: `--foundry <dir>` or
  `--hardhat <dir>` with `--contract path:Name` finds the contract's artifact and the build-info
  file that lists it, whatever its hash name. `--contract` also takes a bare `Name` when one
  contract has that name. `.` is the current folder, not the Git root. For example, in a Foundry
  project after `forge build --build-info`:
  
  ```sh
  explorer-verify verify 0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc --chain 11155111 \
    --foundry . --contract src/Greeter.sol:Greeter --backend sourcify --dry-run
  ```
  
  - `--out-dir <dir>` names the build's output folder when the config moves it, and
    `--artifact <file>` names the artifact when Foundry wrote one for each compiler version or
    profile. Both are relative to the project folder, or absolute. `--compiler-version` is passed
    on.
  - A project option with `--input` or `--input-json`, `--foundry` with `--hardhat`, a project
    without `--contract`, and `--out-dir` or `--artifact` without a project exit 2 before any
    request.
  - Errors name these flags in place of the helpers' option names, list the matching contracts when
    a name is ambiguous, and name `--foundry` or `--hardhat` when the default output folder is
    missing.
  - `--input` with a folder exits 2 and names `--foundry` and `--hardhat`. An extra argument after
    `--input`, as a shell glob such as `--input out/build-info/*.json` gives, exits 2 with
    `--input takes one file; repeat --input for each`; after `--artifact`, with
    `--artifact takes one file`. The generic issue now reads `verify takes at most 1 argument`.
  - An `invalid-input` error whose hint pointed at `details.issues`, which the envelope does not
    carry, now has the CLI's usage hint.
  - The CI guide's `scripts/verify.sh` adds the error message to its `::error::` line.
  
  The CLI now depends on `@explorer-verify/foundry` and `@explorer-verify/hardhat`, and loads each
  only when its option is given. The help examples, the CLI reference and the CI guide use project
  mode.
  
  In `findFoundryBuild` and `findHardhatBuild`, an error names a file outside the project root by
  its absolute path instead of a path that starts with `..`. `files` in the result is unchanged.
  
  [#221](https://github.com/aelmanaa/explorer-verify/issues/221)

- [#188](https://github.com/aelmanaa/explorer-verify/pull/188) [`acfc373`](https://github.com/aelmanaa/explorer-verify/commit/acfc3732086e7233a671f9ab61b643a20134dc41) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The CLI exposes `verify` and `status`. Help and the CLI reference list public commands only.
  
  [#137](https://github.com/aelmanaa/explorer-verify/issues/137)

- [#161](https://github.com/aelmanaa/explorer-verify/pull/161) [`86c2c9c`](https://github.com/aelmanaa/explorer-verify/commit/86c2c9cf1ca0f7e10aa03676fd86d15bef8876a0) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `explorer-verify verify` takes a JSON-RPC endpoint, so it can derive missing constructor arguments from the `--creation-tx` transaction (`VerifyOptions.rpcUrl`). Providers often put a key in the URL, so the CLI treats it like a key. `--rpc-url-file <path>` reads it from a regular file and `--rpc-url-stdin` reads it from stdin, with one trailing newline removed. `--rpc-url <url>` takes only a URL with no path segment, query name or value, user name, password or fragment of 8 or more characters, and exits 2 for any other, such as `https://rpc.ankr.com/eth_sepolia`. Each option can be given once. No environment variable and no `--input-json` field holds the URL; the three options may accompany `--input-json`. `--rpc-url-stdin` exits 2 with `--api-key-stdin` or `--input-json -`, and when stdin is a terminal.
  
  Those parts of the URL, as typed and as parsed, are removed from stdout and stderr in any letter case, at every log level and format, and no error repeats the URL or its file's path. A JSON envelope or JSON log line is scrubbed in its string values and property names, but the envelope's own property names and values that are the CLI's own words, such as backend names and statuses, stay as they are, so the envelope keeps its shape. With `--dry-run`, the URL is checked and gets no request. `input.schema.json` now says that the request has no field for an RPC URL.
  
  [#146](https://github.com/aelmanaa/explorer-verify/issues/146)

- [#187](https://github.com/aelmanaa/explorer-verify/pull/187) [`b53f688`](https://github.com/aelmanaa/explorer-verify/commit/b53f688fa7d61a72196c18592b82def16ed183d7) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `verify` and `status` take `--allow-sourcify-fallback`, which sets `allowSourcifyFallback: true`.
  A chain with no row in the routing table then goes to the public Sourcify API, and the result links
  the Sourcify contract page. Without the flag such a chain exits 2 with `unsupported-chain`, and the
  hint now names the flag. The flag works with `--dry-run`, `--input-json` and `--backend sourcify`.
  It exits 2 with `--api-url`, with a `route.apiUrl` in the request, with a `--backend` other than
  `sourcify` and with a repeated `--backend`, because it would change nothing there.
  
  [#167](https://github.com/aelmanaa/explorer-verify/issues/167)

- [#143](https://github.com/aelmanaa/explorer-verify/pull/143) [`297a5b2`](https://github.com/aelmanaa/explorer-verify/commit/297a5b2a748944e3a57205abacb02036d23b117b) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The CLI gains `verify` and `status`. `explorer-verify verify <address> --chain <id> --input <file>`
  reads build files, builds the input with `buildVerifyInput()` and calls `verify()`; the address may
  come first, without the word `verify`. `--input` repeats, and `--contract`, `--compiler-version`,
  `--constructor-args`, `--creation-tx`, `--library` and `--timeout` fill the rest of the request.
  `explorer-verify status <handle>` resumes a submission with `checkStatus()` and never submits. A run
  that ends pending exits 4 with the handle.
  
  `--dry-run` validates the input, resolves the route and looks the contract up, then stops before
  the submit. It needs no API key: when the backend needs one and none is set, it sends no request
  and says `lookup: "skipped"`. It exits 0 and prints the envelope of the dry-run result, which the
  envelope schema now lists.
  
  `--input-json <file>` reads the whole request as JSON, and `--input-json -` reads it from stdin. The
  core package ships its schema as `explorer-verify/input.schema.json`. Only the output, log,
  `--dry-run`, `--timeout` and key options may go with it. Unknown properties exit 2 with one issue
  that counts them and never names them.
  
  `--backend` and `--input-json` given twice now exit 2: a run uses one backend and one request.
  
  The core package exports `dryRun()` and the `DryRunResult` type. `toEnvelope()` and `exitCodeOf()`
  accept a `DryRunResult`: `ok: true`, exit code 0, its fields in a fixed order and redacted.
  
  [#101](https://github.com/aelmanaa/explorer-verify/issues/101)

- [#154](https://github.com/aelmanaa/explorer-verify/pull/154) [`deba6de`](https://github.com/aelmanaa/explorer-verify/commit/deba6de80209f5f41165c7e11ed64c3548c7a413) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `verify()` derives missing constructor arguments from the creation code. It does so when `constructorArgs` is absent, the route's backend sends arguments (Etherscan v2, Routescan, Etherscan-compatible, Blockscout) and the input has the new optional `creationBytecode`, the compiler's `evm.bytecode.object`. The creation code comes from the new `rpcUrl` option with `creationTxHash`, for a contract deployed directly, or from Etherscan's `getcontractcreation` when an Etherscan key is bound to the route. The arguments are what follows `creationBytecode` in the creation code; library placeholders are not compared. Arguments you pass always win, and nothing is derived. A call to the CREATE2 deployer is read too: its init code follows a 32-byte salt.
  
  When no arguments are derived, `verify()` logs the reason and submits without them, as before: at `info` when no source is configured, at `warn` when a source gave no usable answer or a factory created the contract.
  
  `buildVerifyInput` fills `creationBytecode` when the documents hold it, and `validateInput` checks it and rejects an empty value. `rpcUrl` follows the `route.apiUrl` rules, and its path segments and query values are removed from logs, events and errors.
  
  A new error code, `constructor-args-unavailable` (exit code 2, not retryable), is thrown before the submit on Etherscan v2, Routescan and Etherscan-compatible explorers when the creation code shows that `creationBytecode` is not the deployed build. `details.reason` is `prefix-mismatch` or `bad-length`. On Blockscout, which reports partial matches, the call goes on without arguments. The CLI's `--input-json` takes `creationBytecode`.
  
  [#64](https://github.com/aelmanaa/explorer-verify/issues/64)

- [#250](https://github.com/aelmanaa/explorer-verify/pull/250) [`49ce96c`](https://github.com/aelmanaa/explorer-verify/commit/49ce96c75baa159742b3388529486e74ced5a20b) Thanks [@aelmanaa](https://github.com/aelmanaa)! - A `route.apiUrl` on Etherscan's own API now takes `apiKeys["etherscan-v2"]`. Before, `route: { backend: "etherscan-v2", apiUrl: "https://api.etherscan.io/v2/api" }` threw `missing-api-key` with a message that named `api.etherscan.io` as the only host for the key. The origin is compared after the host is lower-cased and a trailing dot and `:443` are removed, so the key still goes only to `api.etherscan.io`. For an `apiUrl` on any other host, the message now says that `apiKeys.etherscan-v2` goes only to Etherscan's own API and asks for `route.apiKey`. In the CLI, `ETHERSCAN_API_KEY` now goes with `--api-url https://api.etherscan.io/v2/api`. Issue: https://github.com/aelmanaa/explorer-verify/issues/244

- [#255](https://github.com/aelmanaa/explorer-verify/pull/255) [`1e0f804`](https://github.com/aelmanaa/explorer-verify/commit/1e0f804365982790bd6c1f00051a4df7ac1595ba) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Breaking: `verify.lookup` events use `lookup` instead of `match`. Every event from `verifyEach()` carries `entry`, its zero-based index in `backends`, including one validation event per entry. Successful `verify.result` events carry `explorerUrl` when known. Proxy linking emits `proxy.routed`, `proxy.poll`, `proxy.retry` and `proxy.result`.
  
  `toEnvelope()` and `exitCodeOf()` accept proxy results. A linked proxy exits 0; a mismatch or refusal exits 1. `Envelope<Result>` preserves the result type. `BackendOutcome` makes `result` and `error` mutually exclusive, and `ok: true` narrows every outcome in a multi-backend envelope to a success.
  
  What should I do? Read `event.lookup` for a lookup event, use `event.entry` to group concurrent events, and handle the `proxy.*` event types in exhaustive switches. Check `outcome.error !== undefined` to distinguish an error from a result. Failed verification results keep their existing envelope shape.
  
  Issue: https://github.com/aelmanaa/explorer-verify/issues/224

- [#179](https://github.com/aelmanaa/explorer-verify/pull/179) [`60f089c`](https://github.com/aelmanaa/explorer-verify/commit/60f089ce4d27f8a38f9b3ae961dab95369caf590) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Add `linkProxy(target, options?)`, which links a verified proxy to its implementation so the explorer shows the implementation's functions on the proxy's page. `target` holds `chainId`, `address` and an optional `expectedImplementation`; `options` are those of `verify()`. Run it after you verify the implementation and the proxy: it verifies nothing itself.
  
  It returns `linked`, with the implementation the explorer reports and `implementationVerified`; `mismatch`, with the implementation the explorer holds and `expectedImplementation`, when they differ; or `not-linked`, with the explorer's reason, when the explorer refuses because the proxy is not verified there or no implementation is detected. On Etherscan v2 and standalone Etherscan-compatible explorers it sends `verifyproxycontract` and checks `checkproxyverification`; on Blockscout it does the same, then looks the implementation up, and after Blockscout's `Only one attempt in <n>ms` it waits once, or reads the implementation Blockscout holds; on Sourcify it reads `proxyResolution` and sends no request that changes anything. Routescan throws `invalid-input`.
  
  Each explorer's proxy-link code loads only when `linkProxy()` is routed to it, so `import { verify }` does not bundle it. Two error codes are added, neither with a handle: `proxy-link-unknown-state` (exit code 6, not retryable) for a link state the library cannot classify, including an implementation that is not exactly one address; and `proxy-link-pending` (exit code 4, retryable) for a link still pending at the time budget. The CLI's help lists both under their exit codes.
  
  The server handler forwards `verifyproxycontract` and `checkproxyverification` only with the new option `allowProxyLink: true`; it is off by default. With `deployers` set, the deployer check runs on the proxy. Its reduced `getsourcecode` answer now also keeps `Implementation` when it is an address, which `linkProxy()` reads after a mismatch.
  
  [#94](https://github.com/aelmanaa/explorer-verify/issues/94)

- [#258](https://github.com/aelmanaa/explorer-verify/pull/258) [`0454017`](https://github.com/aelmanaa/explorer-verify/commit/0454017813533a87e4ff816c11ebd8f9e9945be6) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Add tested CLI and SDK quickstarts to the package READMEs. Remove contributor tracking IDs from editor documentation and omit internal dependency injection declarations from builds. Package checks reject internal IDs in generated declarations.
  
  Issue: https://github.com/aelmanaa/explorer-verify/issues/226

- [#197](https://github.com/aelmanaa/explorer-verify/pull/197) [`946aac4`](https://github.com/aelmanaa/explorer-verify/commit/946aac4f4fa141925365d7877624d6226733bc96) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Breaking: `routingTableDate()` returns a `Promise<string>`. The routing table's rows are now a module of their own, which a call loads with a dynamic `import()` only when its route needs them. A call without a route loads them once and keeps them. So does a call with `route.apiUrl` that may be a URL the table lists: `etherscan-v2` at `https://api.etherscan.io/v2/api`, `blockscout` at any `https` URL whose path is `/api`, or `etherscan-compatible` at any `https` URL, a proxy included. The table gives such a call the row's explorer page and, for a standalone explorer, whether it needs a key. A call with any other `route.apiUrl`, such as Sourcify, Routescan, a local server or an Etherscan proxy, never loads them. Vite, Rollup and webpack put the rows in a chunk of their own, and esbuild does the same with `--splitting`. Measured with esbuild, `verify` is 14,861 bytes gzipped and the rows 3,042, so a page that verifies on Sourcify with `route.apiUrl` ships 17,728 bytes instead of 21,292. The load counts against `timeoutMs` and stops when the signal aborts. A table that fails to load rejects the call with the loader's error; in `verifyEach()` with a list of backends, it is the outcome of each entry that needs the table. The `missing-api-key` message for a route with `route.apiUrl` names the backend's API host, such as `api.etherscan.io`, also on a chain the table does not list. Issue: https://github.com/aelmanaa/explorer-verify/issues/192
  
  What should I do? Replace `routingTableDate()` with `await routingTableDate()`. The CLI's `--version --json` output does not change.

- [#196](https://github.com/aelmanaa/explorer-verify/pull/196) [`0ee4ea4`](https://github.com/aelmanaa/explorer-verify/commit/0ee4ea44c2ec4e98bf16f98d322eba1acf42e19f) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The routing table can now list a standalone Etherscan-compatible explorer for a chain, and lists one: Bitlayer (200901), at `https://api.btrscan.com/scan/api`. A call on 200901 goes there with no route option, and a verified result's `explorerUrl` is `https://www.btrscan.com/address/<address>#code`. Before, it threw `unsupported-chain`. The table has 326 rows and `schemaVersion` 3; schema 3 adds the `etherscan-compatible` entry, with `api` (the API's host and path), an optional `explorer` host and an optional `needsKey`.
  
  `route.apiKey` with `route.backend` `etherscan-compatible` may now be set without `route.apiUrl` on a chain whose row lists a standalone explorer with `needsKey`. The key goes only to that explorer's host, in the form body. For an entry that takes no key, such as Bitlayer's, the call throws `invalid-input` naming `route.apiKey`, and on a chain whose row lists none it throws `unsupported-chain`, both before any request. `apiKeys["etherscan-compatible"]` still throws `invalid-input`. From the CLI, `--backend etherscan-compatible` with `--api-key-file` or `--api-key-stdin` and no `--api-url` follows the same rules.
  
  `verifyEach()` with `backends: "all"` leaves out an entry with `needsKey` when no key is bound and the row lists another backend. `linkProxy()` throws `invalid-input` on `route.backend` for a standalone explorer from the table, before any request; with `route.apiUrl` it works as before.
  
  A table entry with `needsKey: true` is skipped by a call without a key, and a call that reaches it without `route.apiKey` throws `missing-api-key` before any request, unless `fetch` is set. No entry in this release needs a key: Core (1116) and Kaia (8217) refused a keyless request and have no entry yet.
  
  Behaviour change: the `etherscan-compatible` client sends a lookup or a status request without a key as a GET with its fields in the query, because Bitlayer refuses a lookup sent as a POST. With a key, it stays a form POST, so the key is never in a URL. A lookup answered with `"status":"1"` and an empty `result` list now means "not verified" for this client.
  
  [#170](https://github.com/aelmanaa/explorer-verify/issues/170)

- [#233](https://github.com/aelmanaa/explorer-verify/pull/233) [`f4e5523`](https://github.com/aelmanaa/explorer-verify/commit/f4e55232a49ea8300c50c1ced7e21626313f2ef5) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Breaking: `ExplorerVerifyError` is generic over its code, and checking `error.code` narrows
  `error.details`. `ExplorerVerifyError.is(error, "not-confirmed")` checks the error and its code in
  one call. It and `instanceof` also recognise an error built by another installed copy of
  explorer-verify. New exports: `ERROR_HINTS`, the default hint of each code, and the types
  `DetailsOf`, `DetailsByCode` and `AnyExplorerVerifyError`.
  
  The breaking changes:
  
  - An error built with `new ExplorerVerifyError(...)` and no `hint` now has a hint that points to
    its docs page. Pass `hint: ERROR_HINTS[code]` for the code's default hint. Errors the library
    throws keep their hints.
  - `details.field` of `incomplete-input` and `insufficient-artifact` has a literal type, and the `source-mismatch` hashes are `Hex`.
  - `VerifyOutcome`, `BackendOutcome` and `VerifyEachResult` hold `AnyExplorerVerifyError`, so an
    outcome's error narrows by code. A value typed as the plain `ExplorerVerifyError` no longer fits
    a `VerifyOutcome`; `toEnvelope` and `exitCodeOf` still take it.
  - `details.backend` no longer reads `"unknown"`; a name outside `BACKEND_NAMES`, which only code
    that bypasses the types can pass, reads `etherscan-compatible`, as in a handle.
  
  Importing only `ExplorerVerifyError` costs about 2.8 KB less minified, because the hint text moved
  out of the class. The CLI, Hardhat and Foundry helpers pass the default hints themselves.
  
  Issue: https://github.com/aelmanaa/explorer-verify/issues/213

- [#175](https://github.com/aelmanaa/explorer-verify/pull/175) [`38365f3`](https://github.com/aelmanaa/explorer-verify/commit/38365f3b145c2c03694c6dc3b87254472560cc93) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The core package exports `verifyEach()`, which verifies a contract on several backends in one call
  and returns one outcome per backend, with the `BackendEntry`, `BackendOutcome`,
  `VerifyEachOptions` and `VerifyEachResult` types. `backends` lists backend names or route
  overrides, or is `"all"` for every backend the routing table lists for the chain that can run with
  the keys given. The backends run in parallel with one time budget and the caller's signal, and
  each gets only its own key. One backend's error, a client module that fails to load included, is
  that backend's outcome and holds the `ExplorerVerifyError`; it never discards the others. A
  `not-confirmed` outcome keeps the handle that resumes that backend with `checkStatus()`.
  
  `toEnvelope()` and `exitCodeOf()` accept the result. The envelope schema adds its form. The exit
  code is 0 only when every backend verified, and otherwise the first of 6, 4, 3, 2, 5, 1 and 130
  that any outcome has; read `result.outcomes` for every backend.
  
  The CLI's `verify` now takes `--backend` more than once and then runs `verifyEach()`, printing one
  envelope with an outcome per backend. `--api-url`, `--api-key-file`, `--api-key-stdin` and
  `--dry-run` exit 2 with a repeated `--backend`. `status` still takes one `--backend`. A cancelled
  run on several backends lists every job still running in `error.handles`, so none is lost.
  
  [#95](https://github.com/aelmanaa/explorer-verify/issues/95)

- [#231](https://github.com/aelmanaa/explorer-verify/pull/231) [`1ddf9eb`](https://github.com/aelmanaa/explorer-verify/commit/1ddf9eb8d58c5dd916d24741c612581b12a025e3) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `verify` now submits only where the command line says: `--backend <name>`, or `--backend auto`
  for the routing table's pick. With `--input-json`, `route.backend` does the same, `"auto"`
  included. Without a target, `verify` exits 2 with `invalid-input` before any request, and the hint
  lists the backends the chain lists, says what `auto` would pick and why, and suggests `--dry-run`.
  Add `--backend auto` to a script to keep the old behaviour.
  
  - `--api-url` needs `--backend` naming the backend that serves that API, in a dry run too.
  - `--allow-sourcify-fallback` alone is not a target. `auto` with another `--backend`, or with
    `--api-key-file` or `--api-key-stdin`, exits 2.
  - With `--backend auto`, and in a dry run without `--backend`, the `verify.routed` line shows at
    the default level with how the backend was chosen and which backends were skipped.
  - `--dry-run` and `status` need no target. The dry-run summary says how the backend was chosen.
  
  In the library, `verify()` behaves as before. The `verify.routed` event gains `routedBy` (`caller`,
  `table`, `fallback` or `api-url`) and `skipped`, and `DryRunResult` gains `routedBy`. The event
  and envelope schemas describe both.
  
  [#212](https://github.com/aelmanaa/explorer-verify/issues/212)

- [#254](https://github.com/aelmanaa/explorer-verify/pull/254) [`e0b8d40`](https://github.com/aelmanaa/explorer-verify/commit/e0b8d40ab4bade8e654e3d465afb8ecfaca948b7) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Breaking: `VerifyInput.compiler` accepts `SolcCompiler` or `ZksolcCompiler`. The zksolc member names `version`, `solcVersion` and optional `solcFork`. Validation checks each field. Solc input refuses the zksolc-only fields.
  
  The routing check records compiler support by backend and chain. Calls refuse unsupported pairs with `unsupported-compiler` before any request. Constructor arguments are never derived for EraVM input. The CLI's JSON input accepts the new compiler fields.
  
  What should I do? Switch on `compiler.kind` before reading compiler-specific fields. For solc input, leave out `solcVersion` and `solcFork`.
  
  Issue: https://github.com/aelmanaa/explorer-verify/issues/206
- Updated dependencies [[`a32473b`](https://github.com/aelmanaa/explorer-verify/commit/a32473bb291ef2753b8c4c5873e275d57cef7e0c), [`d82957d`](https://github.com/aelmanaa/explorer-verify/commit/d82957d8a0155f67f88d65dc18f8cb6a0919c8b2), [`0aa6b15`](https://github.com/aelmanaa/explorer-verify/commit/0aa6b154f775d6541565f9432d1f56aa69081d38), [`34ea774`](https://github.com/aelmanaa/explorer-verify/commit/34ea77463b4304a0cae724c9349adca601367c5a), [`ff437c9`](https://github.com/aelmanaa/explorer-verify/commit/ff437c9e233d6b084d70a50d06c5550d07596ca7), [`ff83bab`](https://github.com/aelmanaa/explorer-verify/commit/ff83baba4b739a97303a6667b342cb07382a86c3), [`1d0279c`](https://github.com/aelmanaa/explorer-verify/commit/1d0279cf04fa90d4e9e28d63bd3d6eab8137808b), [`d233f17`](https://github.com/aelmanaa/explorer-verify/commit/d233f170b43311b804dc1f653a0e69966cbf04c3), [`decb62b`](https://github.com/aelmanaa/explorer-verify/commit/decb62bf3765e104a9cd5428259ec7310477eb8b), [`74201ae`](https://github.com/aelmanaa/explorer-verify/commit/74201ae23f03a401758692e3df3088494ad09317), [`5b03fda`](https://github.com/aelmanaa/explorer-verify/commit/5b03fda602aff8c20b976345a6fe21b23a8131a3), [`1f57b85`](https://github.com/aelmanaa/explorer-verify/commit/1f57b857f8ade904c82882c0b4bc04ab5d47ad40), [`0a6f2fe`](https://github.com/aelmanaa/explorer-verify/commit/0a6f2fe95dcb810eafe12dfdb615f7e48bbdd8e1), [`9df3fe1`](https://github.com/aelmanaa/explorer-verify/commit/9df3fe122abecc3d2a85a6432485a1c696281527), [`33b513b`](https://github.com/aelmanaa/explorer-verify/commit/33b513bab47d9cb12fe2811c3a34cbb4037c9a3c), [`450b8b4`](https://github.com/aelmanaa/explorer-verify/commit/450b8b4b3d0b9f50dce6670051af9b0b30ec2d59), [`86c2c9c`](https://github.com/aelmanaa/explorer-verify/commit/86c2c9cf1ca0f7e10aa03676fd86d15bef8876a0), [`297a5b2`](https://github.com/aelmanaa/explorer-verify/commit/297a5b2a748944e3a57205abacb02036d23b117b), [`deba6de`](https://github.com/aelmanaa/explorer-verify/commit/deba6de80209f5f41165c7e11ed64c3548c7a413), [`147262f`](https://github.com/aelmanaa/explorer-verify/commit/147262f637dddbf960d4d06a5d371971d964cc95), [`e603436`](https://github.com/aelmanaa/explorer-verify/commit/e6034361ecd24217508c79ede5b81bcbbdac908c), [`76fa17b`](https://github.com/aelmanaa/explorer-verify/commit/76fa17b4e98f66a27f7035f1a44201aafc46a50c), [`369cf19`](https://github.com/aelmanaa/explorer-verify/commit/369cf19d9f93fb52f2c46f9c953f15ba8e12ea94), [`f3fda61`](https://github.com/aelmanaa/explorer-verify/commit/f3fda619c3f4e82d20949c02b3876f79bc18e583), [`755a5fa`](https://github.com/aelmanaa/explorer-verify/commit/755a5fa3a2a6763547a09c0f112a53e3405ec5d7), [`49ce96c`](https://github.com/aelmanaa/explorer-verify/commit/49ce96c75baa159742b3388529486e74ced5a20b), [`5faa6a6`](https://github.com/aelmanaa/explorer-verify/commit/5faa6a69d2243d32249dd7406a9c508c0e3a4918), [`f26cd8d`](https://github.com/aelmanaa/explorer-verify/commit/f26cd8dc004c7f3b36dccddaf525888fdb3f517b), [`4adfd26`](https://github.com/aelmanaa/explorer-verify/commit/4adfd26acbf7a246db2d6316aef15be0875c6a07), [`3ba6cf3`](https://github.com/aelmanaa/explorer-verify/commit/3ba6cf3b2352ed191f58c383cef938fbc0de8940), [`1e0f804`](https://github.com/aelmanaa/explorer-verify/commit/1e0f804365982790bd6c1f00051a4df7ac1595ba), [`8953d09`](https://github.com/aelmanaa/explorer-verify/commit/8953d09532860df5ca445aa8ce3c82507dae27a0), `7e80097`, [`ae1da35`](https://github.com/aelmanaa/explorer-verify/commit/ae1da35cc431fe0ea6d03dcea26a6151f1a6cd48), [`784792b`](https://github.com/aelmanaa/explorer-verify/commit/784792b609264dff46316ebf6da380fd9d0af8e3), [`0a07946`](https://github.com/aelmanaa/explorer-verify/commit/0a07946f30dfd2f6b76e0bfc55a73b84702cbca4), [`1a4510c`](https://github.com/aelmanaa/explorer-verify/commit/1a4510ce032629cbb8cb8083152825cabe6a0e7e), [`c9a656e`](https://github.com/aelmanaa/explorer-verify/commit/c9a656eab05541689f9562784a7ee54fc5d9fcaa), [`2945a05`](https://github.com/aelmanaa/explorer-verify/commit/2945a05034b84ed2dc4f6fa8e1165303ac891c6e), [`df6ed4d`](https://github.com/aelmanaa/explorer-verify/commit/df6ed4da0b35d1acac3585a426c0241fb087aa7d), [`2c9ad23`](https://github.com/aelmanaa/explorer-verify/commit/2c9ad231fe5dbf7446fa503b0a96aa5a17053bd4), [`c3da921`](https://github.com/aelmanaa/explorer-verify/commit/c3da9218b85844940c7253f28cf6aa4fb2487b38), [`afac930`](https://github.com/aelmanaa/explorer-verify/commit/afac930f5579c1e0768590a1c2d545a8a851493b), [`d88f582`](https://github.com/aelmanaa/explorer-verify/commit/d88f5828a292b84e685602391eac1f8665867cfb), [`6f42c8d`](https://github.com/aelmanaa/explorer-verify/commit/6f42c8ddcc03bd208275cf1bf63acfbab3b177f0), [`c21dcc8`](https://github.com/aelmanaa/explorer-verify/commit/c21dcc866c2d8a9d59c6a9c144c56fbd3ce9a6a4), [`60f089c`](https://github.com/aelmanaa/explorer-verify/commit/60f089ce4d27f8a38f9b3ae961dab95369caf590), [`9c3bad5`](https://github.com/aelmanaa/explorer-verify/commit/9c3bad5636286bd1596400ae2c89416c8464abed), [`e2f7a18`](https://github.com/aelmanaa/explorer-verify/commit/e2f7a18649865dc1d3640ebc0a9d5ccab892f10b), [`3545aad`](https://github.com/aelmanaa/explorer-verify/commit/3545aade082511be19e44805fb649250b8ceb09b), [`feba0d6`](https://github.com/aelmanaa/explorer-verify/commit/feba0d6a06ebff3df6453539363ef95bd8679d0b), [`28d9682`](https://github.com/aelmanaa/explorer-verify/commit/28d9682eee4a8b892d4f3ef64cdc3fb5918b9601), [`f7c12bf`](https://github.com/aelmanaa/explorer-verify/commit/f7c12bf549560b9f2f52b2782fd0bee8043f2548), [`0454017`](https://github.com/aelmanaa/explorer-verify/commit/0454017813533a87e4ff816c11ebd8f9e9945be6), [`29a08aa`](https://github.com/aelmanaa/explorer-verify/commit/29a08aa66688870aa703a89235f0b46742f70bc2), [`3a69911`](https://github.com/aelmanaa/explorer-verify/commit/3a69911cf2aa9a89f21567f9ed4bc48db869f6da), [`99ee2a4`](https://github.com/aelmanaa/explorer-verify/commit/99ee2a49a31a6cde894f7ca1555f5f9fa16e0ae2), [`ec98e86`](https://github.com/aelmanaa/explorer-verify/commit/ec98e86f355bb7308d979da3d9a56e9f1ecbf1bd), [`dc7b98d`](https://github.com/aelmanaa/explorer-verify/commit/dc7b98dc342d282b8b6925f5b51177d363adbc94), [`c2142eb`](https://github.com/aelmanaa/explorer-verify/commit/c2142eb9fbd565002f62f66d4f16870dafa8d4d3), [`0559bba`](https://github.com/aelmanaa/explorer-verify/commit/0559bbae45487faeb57f8c1c8786295aee39ba2c), [`946aac4`](https://github.com/aelmanaa/explorer-verify/commit/946aac4f4fa141925365d7877624d6226733bc96), [`e89d615`](https://github.com/aelmanaa/explorer-verify/commit/e89d6158586191eef1d72754b58c1ff1a40d55d1), [`6a18410`](https://github.com/aelmanaa/explorer-verify/commit/6a184103013ac6f3b382ceaecd265b03e034264d), [`64c1d58`](https://github.com/aelmanaa/explorer-verify/commit/64c1d585787a9e1d9c6da9bf20674c0ebd19155e), [`21e7360`](https://github.com/aelmanaa/explorer-verify/commit/21e7360f2eb9223f74713934c911793e2594d023), [`5c7a1ac`](https://github.com/aelmanaa/explorer-verify/commit/5c7a1ac0f3d2723dfc38d5902731f64c0cf006ae), [`5f5fd62`](https://github.com/aelmanaa/explorer-verify/commit/5f5fd62d3056106a0f47731be7d0f990110bbf33), [`0ee4ea4`](https://github.com/aelmanaa/explorer-verify/commit/0ee4ea44c2ec4e98bf16f98d322eba1acf42e19f), [`919359e`](https://github.com/aelmanaa/explorer-verify/commit/919359ea02e2195b5422c4302a5e0c824c96e690), [`9e12c51`](https://github.com/aelmanaa/explorer-verify/commit/9e12c51c022a657877ff45d30260bdeb7de2849c), [`f4e5523`](https://github.com/aelmanaa/explorer-verify/commit/f4e55232a49ea8300c50c1ced7e21626313f2ef5), [`46ae3ee`](https://github.com/aelmanaa/explorer-verify/commit/46ae3ee7fb728bf4a6f31b3c27aa57fd7bcccebd), [`38365f3`](https://github.com/aelmanaa/explorer-verify/commit/38365f3b145c2c03694c6dc3b87254472560cc93), [`1ddf9eb`](https://github.com/aelmanaa/explorer-verify/commit/1ddf9eb8d58c5dd916d24741c612581b12a025e3), [`dbbfaf8`](https://github.com/aelmanaa/explorer-verify/commit/dbbfaf8e2eca8192bbcbb733dc1593c5bdae302a), [`64dd510`](https://github.com/aelmanaa/explorer-verify/commit/64dd5103e851580c0d7e1d116fb6861d50457986), [`1fdd7ad`](https://github.com/aelmanaa/explorer-verify/commit/1fdd7adeb21fe8f02b7d983ac3eab1c022487d93), [`e0b8d40`](https://github.com/aelmanaa/explorer-verify/commit/e0b8d40ab4bade8e654e3d465afb8ecfaca948b7)]:
  - explorer-verify@0.1.0
  - @explorer-verify/foundry@0.1.0
  - @explorer-verify/hardhat@0.1.0
