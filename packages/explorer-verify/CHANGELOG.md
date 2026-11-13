# explorer-verify

## 0.3.0

### Minor Changes

- [#402](https://github.com/aelmanaa/explorer-verify/pull/402) [`88fe71c`](https://github.com/aelmanaa/explorer-verify/commit/88fe71c4ced5f49c2476cc596a25e57942c74d42) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `route.explorerUrl` sets the explorer's page base for a route. The result's `explorerUrl` is built from it, so a route given by `route.apiUrl` now has a contract page link. It is checked as `route.apiUrl` is, and must not hold a query string.
  
  Breaking: a `failed` result now carries `reasonCode`: `bytecode-mismatch`, `missing-source`, `compiler`, `contract-name`, `constructor-args`, `libraries` or `unknown`. Each client reads it from the explorer's answer, and `reason` keeps the explorer's text. A tool that sends a reduced compiler input first can retry with the full input on `missing-source`. Code that builds a `failed` result, such as a test double, adds the field.
  
  Breaking for an exhaustive `switch` on events: `verify()` emits a `verify.stored` event, with `backend`, `name` and `compilerVersion`, when the lookup finds another contract's source, before it submits. An exhaustive `switch` on the event type adds the new case. The CLI prints it at the debug level.
  
  Messages, log lines and hints name the explorer by its label, such as `Etherscan` or `Sourcify`, instead of the backend id. `details.backend` and the `backend` log field keep the id. `BACKEND_LABELS`, from `explorer-verify/backends` and `explorer-verify`, maps each backend to its label.

### Patch Changes

- [#395](https://github.com/aelmanaa/explorer-verify/pull/395) [`3801a0d`](https://github.com/aelmanaa/explorer-verify/commit/3801a0d0f80d0ec3fbc29f53e1a58c34a534b166) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Docs: "Verify from Node.js" lists what explorer-verify sends on each request and adds a `fetch` that sets a `User-Agent` and sends requests through undici's `ProxyAgent`. The Etherscan reference says that a `Fail - Unable to verify` status costs one more lookup. Error pages give the fix under "How to fix" without a repeated "Fix:" label. CLI examples state the exit code in the line after the command, so the copy button copies only the command.

- [#395](https://github.com/aelmanaa/explorer-verify/pull/395) [`3801a0d`](https://github.com/aelmanaa/explorer-verify/commit/3801a0d0f80d0ec3fbc29f53e1a58c34a534b166) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The packages now declare Node.js 22.12.0 or later in `engines.node`, down from 22.18.0. CI installs the packed packages on Node.js 22.12.0 and runs every entry, the build helpers and the `explorer-verify` command there. Before 22.12.0, Node.js prints an experimental warning for the JSON imports the packages use.

## 0.2.1

### Patch Changes

- [#374](https://github.com/aelmanaa/explorer-verify/pull/374) [`8c72179`](https://github.com/aelmanaa/explorer-verify/commit/8c72179b3e304c3c47c3b5083efd427b17dfe52c) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The docs site has a sitemap, page descriptions, social tags, an icon and a social preview image.

## 0.2.0

### Minor Changes

- [#327](https://github.com/aelmanaa/explorer-verify/pull/327) [`72de386`](https://github.com/aelmanaa/explorer-verify/commit/72de38635010c26a34014f3fe2256585e1eab09e) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `hintFor(error, "user")` returns a hint for the people who use your tool, such as an IDE, a dapp or a verification service. It names no function, option, field or command. It reads the error's details: it gives the wait the explorer asked for, says when an explorer with an Etherscan-style API has not indexed the contract yet, and tells a cancelled run with a handle to check the explorer before submitting again. `hintFor(error, "developer")` returns `error.hint`. Import it from `explorer-verify/errors` or `explorer-verify`. Each error page shows the end-user hint on a "For end users" line.
  
  The default hints, and the specific hints of `buildVerifyInput`, `buildVerifyInputFromBytecode` and `validateInput`, now name each value in words, with the field path only in parentheses. For example, the `rate-limited` hint reads "Wait as long as the explorer asked (details.retryAfterMs), or a few seconds, then call again." The hints read correctly in a tool whose error has no `details` field. The `cancelled` hint says to resume each handle with `checkStatus` instead of naming the CLI's `status` command. Hint text is not part of the API: switch on `error.code`, not on the hint.
  
  [#286](https://github.com/aelmanaa/explorer-verify/issues/286), [#298](https://github.com/aelmanaa/explorer-verify/issues/298)

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

- [#359](https://github.com/aelmanaa/explorer-verify/pull/359) [`ec55dde`](https://github.com/aelmanaa/explorer-verify/commit/ec55ddede0e935d3ce77f6566cae89c57cfbdea6) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Breaking: through a server handler (`handlerUrl`), the handler's 503 `address-not-indexed` now throws `not-indexed` instead of `unexpected-response`. The handler sends it when its `deployers` option is set and Etherscan has no creation record for the address yet. The client still retries as `Retry-After` asks. The error then has the same code, exit code 4 and end-user hint as a direct call. `details.submits` counts HTTP attempts, unlike a direct call, which counts answers: the attempts of the refused request when it was the submit, `0` when it was the lookup or another request. `details.elapsedMs` runs from the first attempt of the refused request to its last answer. `linkProxy()` through the handler can throw it too. Its hint says to call again in a minute, since `indexWaitMs` has no effect there. Code that matched `unexpected-response` for this refusal must match `not-indexed`. The handler's answer does not change.
  
  [#354](https://github.com/aelmanaa/explorer-verify/issues/354)

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

- [#331](https://github.com/aelmanaa/explorer-verify/pull/331) [`acd9ffd`](https://github.com/aelmanaa/explorer-verify/commit/acd9ffd171e26af0802b6a68ba0d221988e752cf) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The package ships `docs/start/quickstart-agent.md`, a quickstart for people who let a coding agent verify a contract. It holds a prompt to paste into the agent: a dry run of the docs' sample, a dry run of the contract, then a stop until the person approves the submit. The packaged `llms.txt` now opens with an Instructions section that lists the pages an agent reads first.

- [#342](https://github.com/aelmanaa/explorer-verify/pull/342) [`a64a7aa`](https://github.com/aelmanaa/explorer-verify/commit/a64a7aa80a25f786d71bc5010c6ba8987f1cf8f1) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Each entry point's declaration file opens with a `@packageDocumentation` comment whose first line
  says what the entry point is for. The API reference on the docs site shows that line next to each
  entry point, and gives each exported function, class, type and constant a page of its own.

- [#339](https://github.com/aelmanaa/explorer-verify/pull/339) [`c1ef895`](https://github.com/aelmanaa/explorer-verify/commit/c1ef895ef2865b5b56c05ab7c16659ac1b69a8d6) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The CLI reference in `docs/reference/cli.md` now starts with the install command and four tested examples, each run with `npx @explorer-verify/cli`. The output contract moves to a new page, `docs/reference/cli-output.md`: stdout, stderr, log levels, the global options, the exit codes, help and cancelling. The CI guide states who it is for and what you need, and runs every command with npx; `docs/reference/json-output.md` is split into shorter sections and tables.

- [#359](https://github.com/aelmanaa/explorer-verify/pull/359) [`ec55dde`](https://github.com/aelmanaa/explorer-verify/commit/ec55ddede0e935d3ce77f6566cae89c57cfbdea6) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Right after a deployment, Blockscout can answer a submit with no job id, and the client submits again. When the time budget runs out during that loop, including the lookup or the new submit after an empty answer, the `timeout` error now holds `details.reason` `empty-submit`. `hintFor(error, "user")` then tells the end user that the explorer did not start the verification, and to check the contract's page and try again in a minute. It gives the same hint for the error's JSON form. Any other `timeout` has no `reason` and keeps its hint.
  
  [#349](https://github.com/aelmanaa/explorer-verify/issues/349)

- [#345](https://github.com/aelmanaa/explorer-verify/pull/345) [`1ef1660`](https://github.com/aelmanaa/explorer-verify/commit/1ef16609b9ea50793970ef4565460d4916496672) Thanks [@aelmanaa](https://github.com/aelmanaa)! - When Blockscout, on an instance or through `blockscout-hosted`, answers each submit without a job id, the hint no longer names `verify()`. It reads "If the contract was deployed moments ago, try again later." The `unexpected-response` error that ends this loop now holds the number of submits sent in `details.attempts`. For this error, `hintFor(error, "user")` says that the explorer did not start the verification, and asks the user to check the contract's page on the explorer, then to try again in a minute. Before, it gave the general hint for an answer that could not be read. A job status or proxy-link answer of the same shape still gets the general hint.
  
  [#326](https://github.com/aelmanaa/explorer-verify/issues/326)

- [#304](https://github.com/aelmanaa/explorer-verify/pull/304) [`015930d`](https://github.com/aelmanaa/explorer-verify/commit/015930dc9993cd6cfb050374322076d702624225) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `timeoutMs: Infinity` now gives the longest time budget instead of throwing `invalid-input`: it is lowered to 2147483647 ms, about 24.8 days, as any larger finite value is. `verify()`, `dryRun()`, `checkStatus()`, `linkProxy()`, `verifyEach()` and `buildVerifyInputFromBytecode()` all take it. Error messages and `timeout` details show the lowered budget.
  
  `pollIntervalMs` still refuses `Infinity`. `NaN`, `0`, negative numbers and `-Infinity` still throw `invalid-input`. The `invalid-input` issue for `timeoutMs` now reads "must be a positive number of milliseconds".
  
  [#289](https://github.com/aelmanaa/explorer-verify/issues/289)

- [#305](https://github.com/aelmanaa/explorer-verify/pull/305) [`c3e5ed8`](https://github.com/aelmanaa/explorer-verify/commit/c3e5ed8f5bceac042246390f42a80c4cb051ebaa) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The match types page now lists the `match` each explorer gives a build compiled with `bytecodeHash: "none"`, as recorded on Ethereum Sepolia on 2026-11-10: `exact` on Etherscan v2, `partial` on Sourcify and Blockscout. Routescan states no grade, and explorer-verify now reports every Routescan match as `partial`. The page no longer says that such a build reaches only `partial` everywhere. Issue: https://github.com/aelmanaa/explorer-verify/issues/287

- [#301](https://github.com/aelmanaa/explorer-verify/pull/301) [`9bb2f0f`](https://github.com/aelmanaa/explorer-verify/commit/9bb2f0f0e534365a078d7459e14dd58a4bd35684) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The READMEs and the Setup sections of the user guides now say how the supported Node.js range
  changes: it follows Node's active and maintenance LTS lines, and a line is dropped when it reaches
  end of life, in a minor release while the version is 0.x. Node 22 reaches end of life on
  2027-04-30. Node 20 is not supported. `engines.node` stays `>=22.18.0`.
  
  Issue: https://github.com/aelmanaa/explorer-verify/issues/291

- [#299](https://github.com/aelmanaa/explorer-verify/pull/299) [`6ad0688`](https://github.com/aelmanaa/explorer-verify/commit/6ad0688bd6e50a3356718fe5aaaa4c524554ded8) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The guide "Verify contracts your package ships" now describes the routing table as it is: a
  call goes to the first backend in the chain's row that works with the keys passed, so a key in
  `apiKeys["etherscan-v2"]` sends a Sepolia call to Etherscan. The guide no longer says the table
  has no Etherscan rows. Its new backend example runs in the docs tests against a recorded
  Etherscan answer.
  
  Issue: https://github.com/aelmanaa/explorer-verify/issues/285

- [#332](https://github.com/aelmanaa/explorer-verify/pull/332) [`899e945`](https://github.com/aelmanaa/explorer-verify/commit/899e9454200f67106881efe6eefa5e767875e7a8) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The package ships three quickstarts under `docs/start/`: the CLI, a Foundry project and a
  Hardhat project. Each one dry runs the sample request with `npx @explorer-verify/cli`, then the
  reader's own project, then verifies, in at most five steps. The Hardhat quickstart says the CLI
  is not a Hardhat plugin.

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

- [#359](https://github.com/aelmanaa/explorer-verify/pull/359) [`ec55dde`](https://github.com/aelmanaa/explorer-verify/commit/ec55ddede0e935d3ce77f6566cae89c57cfbdea6) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The `duplicate-submission` reason of `verify.retry` and `proxy.retry` is now marked reserved in the type, in `event.schema.json` and in the logging reference. No client emits it: Sourcify's answer to a duplicate request ends the call with `in-progress`, not a retry. The value stays, so code that switches on it still compiles.
  
  [#353](https://github.com/aelmanaa/explorer-verify/issues/353)

- [#344](https://github.com/aelmanaa/explorer-verify/pull/344) [`1a2c786`](https://github.com/aelmanaa/explorer-verify/commit/1a2c786f76dedeef3286f3bbdc8926bdea03a155) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `linkProxy()` can resume a pending proxy link without sending a new link request. The `proxy-link-pending` error now carries `details.jobId`, the job id the explorer gave for the link request, with API keys removed. Pass it back as `resumeJobId` with the same target and route: the call sends only `checkproxyverification`, checks at once and then every `pollIntervalMs`. This also works through `explorer-verify/core` and through the server handler with `allowProxyLink: true`.
  
  A `resumeJobId` that is not of the form the backend gives for the proxy throws `invalid-input` before any request, and so does any `resumeJobId` on Sourcify, which starts no link job. A job id the explorer no longer knows throws `proxy-link-unknown-state`. The default hint of `proxy-link-pending` names the new option.
  
  [#296](https://github.com/aelmanaa/explorer-verify/issues/296)

- [#328](https://github.com/aelmanaa/explorer-verify/pull/328) [`2c317c0`](https://github.com/aelmanaa/explorer-verify/commit/2c317c0a37872c3b92292f48af56610d4d522e54) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The package ships `docs/start/greeter-sepolia.json`, a verify request for the docs' Greeter on Sepolia. A dry run of it with `--input-json` needs no key, no deploy and no project. Without an Etherscan key, it routes to Sourcify and reports an exact match.

- [#359](https://github.com/aelmanaa/explorer-verify/pull/359) [`ec55dde`](https://github.com/aelmanaa/explorer-verify/commit/ec55ddede0e935d3ce77f6566cae89c57cfbdea6) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Through the platform's `fetch`, the Sourcify lookup now goes with `cache: "no-store"`, so a browser's HTTP cache no longer adds up to an hour on top of Sourcify's own cache. An injected `fetch` gets no `cache` field: it handles caching itself. A runtime whose `Request` refuses or drops the field, such as Cloudflare Workers before compatibility date 2024-11-11, sends the lookup without it. Sourcify's shared cache still serves a lookup for up to an hour, and no request field reaches it. The Sourcify reference page, the `dryRun()` docs and `DryRunResult.lookup` now say that a lookup grade can be up to an hour old, and that a job's answer wins over it. After a 409 that follows a lookup naming another contract, `verify()` logs at `warn` that the kept `storedContract` may be out of date.
  
  [#356](https://github.com/aelmanaa/explorer-verify/issues/356)

- [#300](https://github.com/aelmanaa/explorer-verify/pull/300) [`7ee0497`](https://github.com/aelmanaa/explorer-verify/commit/7ee049753c0162a44b2f6e61b9c9b5cd263c4b0d) Thanks [@aelmanaa](https://github.com/aelmanaa)! - TypeScript projects that set `"moduleResolution": "node"` now find the types of every subpath, such as `explorer-verify/core` and `explorer-verify/clients/sourcify`, and of the JSON schema files. Before, these imports failed with TS2307. `bundler`, `node16` and `nodenext` resolve the same files as before. [#295](https://github.com/aelmanaa/explorer-verify/issues/295)

## 0.1.0

### Minor Changes

- [#232](https://github.com/aelmanaa/explorer-verify/pull/232) [`74201ae`](https://github.com/aelmanaa/explorer-verify/commit/74201ae23f03a401758692e3df3088494ad09317) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Breaking: the input builders share one name family, and the two build helpers share option and result names. Each builder returns `BuiltVerifyInput`; add `chainId` and `address` to get a `VerifyInput`.
  
  - `verifyInputFromFoundry` is now `buildVerifyInputFromFoundry`, `verifyInputFromHardhat` is now `buildVerifyInputFromHardhat`, and `resolveInputFromBytecode` is now `buildVerifyInputFromBytecode`, with its options type `BuildFromBytecodeOptions` (was `ResolveInputOptions`).
  - The resolver option `sourcify` is now `allowSourcifyLookup`. The resolver takes `onEvent`, which receives a `verify.retry` event before each retry of a Sourcify request.
  - `findFoundryBuild` and `findHardhatBuild` take `FindBuildOptions` (`root`, `contract`, `outDir`, `artifact`; Foundry also `buildInfoDir`) and return `ProjectBuild` (`contract`, `documents`, `sources`, `files`). Foundry's `out` option is now `outDir`, and its `files` is now a list of paths: the artifact, then the build-info, or else the source files. Hardhat's `artifacts` option is now `outDir`; Hardhat adds `artifact`, and its result adds `contract` and an empty `sources`.
  - `buildVerifyInputFromFoundry` and `buildVerifyInputFromHardhat` take `BuildFromProjectOptions`: the find options plus `compilerVersion` and `sources`, which they pass to `buildVerifyInput`.
  - `linkLibraries` takes a `VerifyInput`, so `linkLibraries(42)` no longer compiles. For untyped data, call `validateInput` first.
  
  [#223](https://github.com/aelmanaa/explorer-verify/issues/223)

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

- [#255](https://github.com/aelmanaa/explorer-verify/pull/255) [`1e0f804`](https://github.com/aelmanaa/explorer-verify/commit/1e0f804365982790bd6c1f00051a4df7ac1595ba) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Breaking: `verify.lookup` events use `lookup` instead of `match`. Every event from `verifyEach()` carries `entry`, its zero-based index in `backends`, including one validation event per entry. Successful `verify.result` events carry `explorerUrl` when known. Proxy linking emits `proxy.routed`, `proxy.poll`, `proxy.retry` and `proxy.result`.
  
  `toEnvelope()` and `exitCodeOf()` accept proxy results. A linked proxy exits 0; a mismatch or refusal exits 1. `Envelope<Result>` preserves the result type. `BackendOutcome` makes `result` and `error` mutually exclusive, and `ok: true` narrows every outcome in a multi-backend envelope to a success.
  
  What should I do? Read `event.lookup` for a lookup event, use `event.entry` to group concurrent events, and handle the `proxy.*` event types in exhaustive switches. Check `outcome.error !== undefined` to distinguish an error from a result. Failed verification results keep their existing envelope shape.
  
  Issue: https://github.com/aelmanaa/explorer-verify/issues/224

- [#246](https://github.com/aelmanaa/explorer-verify/pull/246) [`8953d09`](https://github.com/aelmanaa/explorer-verify/commit/8953d09532860df5ca445aa8ce3c82507dae27a0) Thanks [@aelmanaa](https://github.com/aelmanaa)! - New entry `explorer-verify/core`: `verify()`, `dryRun()`, `checkStatus()`, `verifyEach()` and `linkProxy()` that take the explorer clients and the routing table from the caller, with no dynamic `import()` behind them. Create the clients with the factories of `explorer-verify/clients/<name>` (`sourcify`, `etherscan-v2`, `etherscan-compatible`, `routescan`, `blockscout`), import the table from `explorer-verify/table`, then call `verify(input, { clients: [sourcify()], table: routingTable })`. A bundle that does not split code, such as esbuild without `splitting`, Wrangler or a wrapper SDK that bundles its dependencies, then holds only those: `verify` with the Sourcify client and no table measures 65,572 bytes minified as one file, against 112,520 for `verify` from `explorer-verify`. Leave `table` out when every call sets `route.apiUrl`, or names `sourcify`, `etherscan-v2` or `blockscout-hosted` in `route.backend`. A missing client, a missing table and `handlerUrl` without `etherscanV2()` each throw before any request. `explorer-verify` keeps its lazy loaders, and its error for `clients` or `table` points to `explorer-verify/core`. The new [Core entry](https://github.com/aelmanaa/explorer-verify/blob/main/docs/user/reference/core.md) page lists the clients and the errors.
  
  [#220](https://github.com/aelmanaa/explorer-verify/issues/220)

- Prepare the first public release of the core, CLI and build helpers. Release and promotion remain separate maintainer actions.
  
  Issue: https://github.com/aelmanaa/explorer-verify/issues/257

- [#240](https://github.com/aelmanaa/explorer-verify/pull/240) [`784792b`](https://github.com/aelmanaa/explorer-verify/commit/784792b609264dff46316ebf6da380fd9d0af8e3) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Breaking: `formatHandle` now returns `HandleString`, the template literal type of the one-line form `ev1:<backend>:<chainId>:<address>:<jobId>`, and the `verify.submitted` event's `handle`, `ErrorJson.handle` and each `ErrorJson.handles[].handle` use the same type. The one-line form is now the one documented form to store: every example stores `formatHandle(handle)` instead of `JSON.stringify(handle)`, which `parseHandle` and `checkStatus` do not read. For a value in neither form, the error message names the handle object and the one-line form, and the hint of every handle error names both. The new `tryParseHandle` reads the same two forms and returns `undefined` instead of throwing, and the new `isHandleString` tells whether a value is a valid one-line handle and narrows it to `HandleString`. Neither loads the error code: `tryParseHandle` alone is about 2.2 KB minified. Issue: https://github.com/aelmanaa/explorer-verify/issues/218
  
  What should I do? Store `formatHandle(handle)` and pass the stored text to `checkStatus`. A value typed `string` no longer fits `HandleString`: check it with `isHandleString`, or keep the variable typed `string`. Use `tryParseHandle` to check a stored value without catching an error.

- [#238](https://github.com/aelmanaa/explorer-verify/pull/238) [`0a07946`](https://github.com/aelmanaa/explorer-verify/commit/0a07946f30dfd2f6b76e0bfc55a73b84702cbca4) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Breaking: with `handlerUrl` set, a refusal of your server handler now throws an error code for its `code` and status instead of `unexpected-response`. `chain-not-allowed`, `address-not-allowed`, `action-not-allowed`, `forbidden-field`, `body-too-large`, `bad-request`, `method-not-allowed` and `unsupported-media-type` throw the new `handler-refused`: not retryable, exit code 2, with the handler's code in `details.handlerCode`. Its hint names the `createVerifyHandler` option to change for `chains`, `deployers`, `allowProxyLink` and `maxBodyBytes`. `request-timeout`, `upstream-timeout` and `upstream-error` throw a retryable `network`. `address-not-indexed` and `internal-error` stay `unexpected-response`, and so does an answer with no `code`, an unknown code or a code with another status; its message no longer repeats such a code. A 4xx answer of the handler other than 408 and 429 is no longer retryable, with or without a `code`. An `unexpected-response` thrown after retries now has `details.attempts`. Issue: https://github.com/aelmanaa/explorer-verify/issues/215
  
  What should I do? If you check `error.code === "unexpected-response"` to detect a refusal of your server handler, check `handler-refused` and read `details.handlerCode` instead. Code that retries on `retryable` needs no change. Code that maps exit codes treats exit code 2 from a call through the handler as a refusal to fix, not to retry.

- [#237](https://github.com/aelmanaa/explorer-verify/pull/237) [`1a4510c`](https://github.com/aelmanaa/explorer-verify/commit/1a4510ce032629cbb8cb8083152825cabe6a0e7e) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Breaking: an injected `fetch` no longer turns off the missing-key check. A call routed to `etherscan-v2` with no key now throws `missing-api-key` before any request, whether `fetch` is set or not, and `dryRun()` returns `lookup: "skipped"` there instead of looking the contract up. A route whose `apiUrl` points at a proxy, with an injected `fetch` and no key, throws `missing-api-key` too. The new `handlerUrl` option says that your server handler adds the key: each Etherscan request goes to that URL with no key, other requests go to their explorer directly, and the routing table chooses as it does with an Etherscan key. Log lines, events, a dry run's `apiHost` and errors name the handler URL for those requests, so keep secrets out of it. A refusal of the handler names its code, such as `chain-not-allowed`; a 4xx refusal is not retryable and its hint points at the `createVerifyHandler` options. `ExplorerVerifyErrorOptions` gains `retryable`. A path such as `/api/verify` works in a browser page; elsewhere pass an absolute URL. The `handlerUrl` code loads on demand, so a bad value rejects the call when it starts, and a caller who never sets it does not download it. An Etherscan key next to `handlerUrl`, in `apiKeys` or as `route.apiKey` on Etherscan's API, throws `invalid-input` in every function. A result reached through the handler now carries the Etherscan page as `explorerUrl`. `apiKeys` now accepts only the backends that take a key there, `etherscan-v2`, `routescan` and `blockscout-hosted`, exported as the `ApiKeys` and `KeyedBackendName` types, so `apiKeys: { sourcify: "..." }` no longer compiles. Issue: https://github.com/aelmanaa/explorer-verify/issues/217
  
  What should I do? In a browser, replace the URL-rewriting `fetch` and `route: { backend: "etherscan-v2" }` with `verify(input, { handlerUrl: "/api/verify" })`; keep `route.backend` if you want Etherscan on chains whose row lists Sourcify first. Keep `fetch` for logging, retries or tests; pass it next to `handlerUrl` if you need both. If you pointed `route.apiUrl` at your own proxy, use `handlerUrl` with Etherscan's default URL instead. Remove `sourcify`, `blockscout` and `etherscan-compatible` entries from `apiKeys`; a standalone explorer's key goes in `route.apiKey`.

- [#253](https://github.com/aelmanaa/explorer-verify/pull/253) [`c21dcc8`](https://github.com/aelmanaa/explorer-verify/commit/c21dcc866c2d8a9d59c6a9c144c56fbd3ce9a6a4) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Breaking: `toEnvelope`, `exitCodeOf`, `ERROR_EXIT_CODES` and the types `Envelope`, `EnvelopeOptions`, `ExitCode` and `VerifyOutcome` moved from `explorer-verify` to the new entry `explorer-verify/envelope`. Change `import { toEnvelope } from "explorer-verify"` to `import { toEnvelope } from "explorer-verify/envelope"`. An application that only verifies does not need them.
  
  ```ts
  // Before
  import { ERROR_EXIT_CODES, exitCodeOf, toEnvelope } from "explorer-verify";
  import type { Envelope, EnvelopeOptions, ExitCode, VerifyOutcome } from "explorer-verify";
  
  // After
  import { ERROR_EXIT_CODES, exitCodeOf, toEnvelope } from "explorer-verify/envelope";
  import type { Envelope, EnvelopeOptions, ExitCode, VerifyOutcome } from "explorer-verify/envelope";
  ```
  
  Every other name of `explorer-verify` keeps its import.
  
  Three new entries hold names that a page or a wrapper SDK often imports alone: `explorer-verify/handle` (`formatHandle`, `parseHandle`, `tryParseHandle`, `isHandleString`, `Handle`, `HandleString`), `explorer-verify/errors` (`ExplorerVerifyError`, `ERROR_CODES`, `ERROR_HINTS` and the error types) and `explorer-verify/backends` (`BACKEND_NAMES`, `toBackendName`, `BackendName`, `KeyedBackendName`). None of them reaches the verification code, so every bundler emits one file for a name from them. Under esbuild with `splitting: true`, `formatHandle` from `explorer-verify` loads 13,884 bytes minified and the build emits 21 files; from `explorer-verify/handle` it is one file of 114 bytes. The same names stay on `explorer-verify`.
  
  [#219](https://github.com/aelmanaa/explorer-verify/issues/219)

- [#197](https://github.com/aelmanaa/explorer-verify/pull/197) [`946aac4`](https://github.com/aelmanaa/explorer-verify/commit/946aac4f4fa141925365d7877624d6226733bc96) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Breaking: `routingTableDate()` returns a `Promise<string>`. The routing table's rows are now a module of their own, which a call loads with a dynamic `import()` only when its route needs them. A call without a route loads them once and keeps them. So does a call with `route.apiUrl` that may be a URL the table lists: `etherscan-v2` at `https://api.etherscan.io/v2/api`, `blockscout` at any `https` URL whose path is `/api`, or `etherscan-compatible` at any `https` URL, a proxy included. The table gives such a call the row's explorer page and, for a standalone explorer, whether it needs a key. A call with any other `route.apiUrl`, such as Sourcify, Routescan, a local server or an Etherscan proxy, never loads them. Vite, Rollup and webpack put the rows in a chunk of their own, and esbuild does the same with `--splitting`. Measured with esbuild, `verify` is 14,861 bytes gzipped and the rows 3,042, so a page that verifies on Sourcify with `route.apiUrl` ships 17,728 bytes instead of 21,292. The load counts against `timeoutMs` and stops when the signal aborts. A table that fails to load rejects the call with the loader's error; in `verifyEach()` with a list of backends, it is the outcome of each entry that needs the table. The `missing-api-key` message for a route with `route.apiUrl` names the backend's API host, such as `api.etherscan.io`, also on a chain the table does not list. Issue: https://github.com/aelmanaa/explorer-verify/issues/192
  
  What should I do? Replace `routingTableDate()` with `await routingTableDate()`. The CLI's `--version --json` output does not change.

- [#235](https://github.com/aelmanaa/explorer-verify/pull/235) [`919359e`](https://github.com/aelmanaa/explorer-verify/commit/919359ea02e2195b5422c4302a5e0c824c96e690) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Breaking: an options key that a function does not read now throws `invalid-input` before any request, where it was ignored before. The issue names the key and, when one matches it ignoring case or by prefix, the option it may mean: `verify(input, { timeout: 5 })` gives `timeout: is not a known option; did you mean timeoutMs?`. The error never repeats the key's value. The rule covers the options of `verify()`, `dryRun()`, `checkStatus()`, `linkProxy()`, `verifyEach()`, `buildVerifyInput()`, `buildVerifyInputFromBytecode()`, `toEnvelope()`, `createVerifyHandler()`, `routesFor()`, `findHardhatBuild()`, `findFoundryBuild()`, `buildVerifyInputFromHardhat()` and `buildVerifyInputFromFoundry()`, and the keys of `route` and of each `backends` entry.
  
  Each flow function has its own options type: `VerifyOptions`, `DryRunOptions`, `CheckStatusOptions` and `LinkProxyOptions`, all built on the new `CallOptions`. In an object literal, TypeScript now refuses `pollIntervalMs` for `dryRun()` and `rpcUrl` for `checkStatus()` and `linkProxy()`. At run time those four functions still accept every key of `VerifyOptions`, so one options object built for `verify()` works with each of them. Every optional input field now accepts `undefined`, which counts as absent, so code built with `exactOptionalPropertyTypes` can pass `rpcUrl: process.env.RPC_URL` without a conditional spread.
  
  [#216](https://github.com/aelmanaa/explorer-verify/issues/216)

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

- [#254](https://github.com/aelmanaa/explorer-verify/pull/254) [`e0b8d40`](https://github.com/aelmanaa/explorer-verify/commit/e0b8d40ab4bade8e654e3d465afb8ecfaca948b7) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Breaking: `VerifyInput.compiler` accepts `SolcCompiler` or `ZksolcCompiler`. The zksolc member names `version`, `solcVersion` and optional `solcFork`. Validation checks each field. Solc input refuses the zksolc-only fields.
  
  The routing check records compiler support by backend and chain. Calls refuse unsupported pairs with `unsupported-compiler` before any request. Constructor arguments are never derived for EraVM input. The CLI's JSON input accepts the new compiler fields.
  
  What should I do? Switch on `compiler.kind` before reading compiler-specific fields. For solc input, leave out `solcVersion` and `solcFork`.
  
  Issue: https://github.com/aelmanaa/explorer-verify/issues/206

### Patch Changes

- [#30](https://github.com/aelmanaa/explorer-verify/pull/30) [`a32473b`](https://github.com/aelmanaa/explorer-verify/commit/a32473bb291ef2753b8c4c5873e275d57cef7e0c) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The package now ships its user docs in `docs/` and an `llms.txt` index of them. An agent working in `node_modules` reads the docs of the installed version. Issue: https://github.com/aelmanaa/explorer-verify/issues/4

- [#205](https://github.com/aelmanaa/explorer-verify/pull/205) [`d82957d`](https://github.com/aelmanaa/explorer-verify/commit/d82957d8a0155f67f88d65dc18f8cb6a0919c8b2) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The agent guide and the skill now say to pass `--backend`, or `route.backend` in the library, when the person names an explorer. Without it, the routing table picks the explorer and `verify` submits there: on Sepolia with no Etherscan key set, a request to verify on Etherscan would publish the source on Sourcify. Issue: https://github.com/aelmanaa/explorer-verify/issues/7

- [#79](https://github.com/aelmanaa/explorer-verify/pull/79) [`0aa6b15`](https://github.com/aelmanaa/explorer-verify/commit/0aa6b154f775d6541565f9432d1f56aa69081d38) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The package now ships an agent skill at `skills/explorer-verify/SKILL.md`. It shows how to build the input from build files or from Solidity metadata and sources, call `verify()`, store the handle, resume with `checkStatus()` instead of submitting again, and read the result, the error codes, the JSON envelope and the exit codes. It sets limits on retries, says when to stop and ask the person, and states the key and redirect rules. The tests run every example in the skill against the built package. Issue: https://github.com/aelmanaa/explorer-verify/issues/6

- [#90](https://github.com/aelmanaa/explorer-verify/pull/90) [`34ea774`](https://github.com/aelmanaa/explorer-verify/commit/34ea77463b4304a0cae724c9349adca601367c5a) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `VerifyOptions` takes `apiKeys`, API keys by backend name, and `RouteOverride` takes `apiKey`. A key in `apiKeys` is sent only to its backend's host, `api.etherscan.io` for `etherscan-v2` and `api.routescan.io` for `routescan`, and only when the call's route resolves to that backend. A `route.apiUrl` on another host gets no key from `apiKeys`. A standalone explorer's key goes in `route.apiKey`, next to `route.apiUrl`, and is bound to that route's host; `apiKeys["etherscan-compatible"]` throws `invalid-input`. Etherscan keys go in the form body of a POST and Routescan keys in the `apikey` header, never in a URL.
  
  Each key must be 8 to 1024 characters, each a letter, a digit, `.`, `_`, `~` or `-`, and not all digits. A key found in the contract address or the handle is refused too. A bad value throws `invalid-input` naming `apiKeys.<backend>` or `route.apiKey`, never the value. Every key, valid or not, is removed from log lines, events, errors and results.
  
  Three error codes, each with exit code 3 and not retryable: `missing-api-key`, `api-key-rejected` and `quota-exceeded`. In this release every chain still goes to Sourcify, so the keys and these codes take effect with the Etherscan v2, Routescan and standalone clients.
  
  [#58](https://github.com/aelmanaa/explorer-verify/issues/58)

- [#138](https://github.com/aelmanaa/explorer-verify/pull/138) [`ff437c9`](https://github.com/aelmanaa/explorer-verify/commit/ff437c9e233d6b084d70a50d06c5550d07596ca7) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The docs site has an API reference at https://aelmanaa.github.io/explorer-verify/api/, generated from the TSDoc of `explorer-verify`, `explorer-verify/server`, `explorer-verify/resolve`, `@explorer-verify/foundry` and `@explorer-verify/hardhat`. It is not in the package; the `.d.ts` files carry the same comments. Every member of `VerifyResult`, `VerifyEvent`, `Envelope` and `SolidityStandardJsonInput.sources` now has TSDoc. `Envelope` now names its result forms with `Extract<VerifyResult, Record<"status", …>>`; the type is unchanged. Issue: https://github.com/aelmanaa/explorer-verify/issues/85

- [#145](https://github.com/aelmanaa/explorer-verify/pull/145) [`ff83bab`](https://github.com/aelmanaa/explorer-verify/commit/ff83baba4b739a97303a6667b342cb07382a86c3) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Add the Blockscout client for single-chain instances. `verify()` and `checkStatus()` use it for `route.backend` `blockscout`. It sends no API key: a key in `route.apiKey` or `apiKeys.blockscout` still throws `invalid-input`.
  
  The routing table has no Blockscout rows yet. Name the instance's API, which must end in `/api`:
  
  ```ts
  await verify(input, {
    route: { backend: "blockscout", apiUrl: "https://eth-sepolia.blockscout.com/api" },
  });
  ```
  
  The lookup reads the instance's REST API, `GET /api/v2/smart-contracts/{address}`: `is_fully_verified` gives `exact` and `is_partially_verified` gives `partial`. The submit and the status request are form-encoded POSTs to `/api`, with `verifysourcecode` and `checkverifystatus`.
  
  - A build without a metadata hash gives `verified` with `partial`, never `failed`.
  - `Unknown UID` throws `job-not-found` after the flow's lookup, although Blockscout sends it with `status` `"1"`.
  - An empty answer to a submit, which can come right after a deployment, is followed by a lookup and a new submit: at most 4 submits, within 30 seconds of the first. Each wait emits `verify.retry` with the new `reason` `empty-submit`.
  - `Address is not a smart-contract` throws `invalid-input` naming `address`.
  - A text the client does not know throws. It never reads as success, as "not verified" or as `failed`.
  
  `event.schema.json` adds `empty-submit` to the `verify.retry` reasons. A routing-table entry for `blockscout` holds the instance's host as `instance`. The new reference page `docs/user/reference/blockscout.md` lists the requests and how each answer is read.
  
  [#92](https://github.com/aelmanaa/explorer-verify/issues/92)

- [#229](https://github.com/aelmanaa/explorer-verify/pull/229) [`1d0279c`](https://github.com/aelmanaa/explorer-verify/commit/1d0279cf04fa90d4e9e28d63bd3d6eab8137808b) Thanks [@aelmanaa](https://github.com/aelmanaa)! - A new backend, `blockscout-hosted`, verifies through Blockscout's hosted API, `https://api.blockscout.com/<chainId>/api`, for any chain. Name it with `route: { backend: "blockscout-hosted" }` and pass the key as `apiKeys["blockscout-hosted"]`; the key goes only to `api.blockscout.com`, in the `authorization` header as `Bearer <key>`. The routing table never picks it, and `verifyEach()` with `backends: "all"` leaves it out. Its handles start with `ev1:blockscout-hosted:`, so `checkStatus()` resumes on the hosted API. The hosted API's HTTP 401 and 402 answers map to `missing-api-key` or `api-key-rejected`, and its `Network not supported` answer to `unsupported-chain`; the `blockscout` instance client is unchanged. The CLI reads `BLOCKSCOUT_API_KEY` for `--backend blockscout-hosted`. Issue: https://github.com/aelmanaa/explorer-verify/issues/96

- [#193](https://github.com/aelmanaa/explorer-verify/pull/193) [`d233f17`](https://github.com/aelmanaa/explorer-verify/commit/d233f170b43311b804dc1f653a0e69966cbf04c3) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The routing table now lists a Blockscout instance for 111 chains, each one that answered the API without a key or a redirect on 2026-11-05. On those chains, `route: { backend: "blockscout" }` and the CLI's `--backend blockscout` reach the instance without `route.apiUrl` or `--api-url`, and the result's `explorerUrl` is `https://<instance>/address/<address>?tab=contract`. They include Ethereum Mainnet (1), OP Mainnet (10), Gnosis (100), ZKsync Era (324), Celo (42220), Base Sepolia (84532), Scroll (534352) and Ethereum Sepolia (11155111).
  
  In a row, Blockscout comes after Sourcify and a free-tier Etherscan v2, and before a paid-plan Etherscan v2 and Routescan, so a call that names no backend goes where it went before on every chain whose row has Sourcify or Etherscan v2. `verifyEach()` with `backends: "all"` now also verifies on Blockscout on these chains, since it takes every backend the row lists.
  
  Behaviour change: the table has 325 rows, 11 more. On those 11 chains Blockscout is the only backend, and a call goes there by default; before, it threw `unsupported-chain`. They are 484, 901, 957, 1076, 10901, 261131, 529375, 89346162, 245022926, 1666700000 and 3735928814. On Numine (8021), whose row lists Blockscout and then Routescan, a call that names no backend now goes to Blockscout instead of Routescan.
  
  The Blockscout instances of Polygon PoS (137), Base (8453), Arbitrum One (42161), Arbitrum Sepolia (421614) and four others sent a bot-check page and have no entry; reach them with `route.apiUrl`.
  
  [#169](https://github.com/aelmanaa/explorer-verify/issues/169)

- [#67](https://github.com/aelmanaa/explorer-verify/pull/67) [`decb62b`](https://github.com/aelmanaa/explorer-verify/commit/decb62bf3765e104a9cd5428259ec7310477eb8b) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Add `buildVerifyInput`, which builds the `compiler` part of `VerifyInput` and the fully qualified contract name from parsed build files of unknown origin. It accepts build-info from Hardhat 2, Hardhat 3 (with its output file) and Foundry, a bare Standard JSON input, and Hardhat or Foundry artifacts. It detects each file by its shape, in any order. The compiler input it returns holds only `language`, `sources` and `settings`, so Foundry's `basePath` and other local paths are not published. Each source keeps only `content` and `keccak256`. A local path in a source path, a remapping, or a `libraries` or `outputSelection` key is rejected. Files from different builds or compiler versions are rejected. A Hardhat 3 contract is named by its input source name, such as `project/contracts/Greeter.sol:Greeter`. Three new error codes say what is missing: `incomplete-input`, `insufficient-artifact` and `unsupported-compiler`. Each exits with code 2.
  
  [#20](https://github.com/aelmanaa/explorer-verify/issues/20)

- [#141](https://github.com/aelmanaa/explorer-verify/pull/141) [`5b03fda`](https://github.com/aelmanaa/explorer-verify/commit/5b03fda602aff8c20b976345a6fe21b23a8131a3) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Add `buildVerifyInputFromBytecode`, exported from the new entry point `explorer-verify/resolve`. It builds the verification input from a deployed contract's bytecode alone. It reads the metadata hash solc appends to the bytecode, passed as `bytecode` (at most 65536 bytes) or read with `eth_getCode` from your `rpcUrl`. It then looks for a verified copy on Sourcify at the same address on any chain, and next, when you pass `ipfsGateway`, fetches the metadata and sources from your IPFS gateway. There is no default gateway, and `allowSourcifyLookup: false` needs one. Metadata is used only when its IPFS hash, computed as solc computes it, equals the one in the bytecode, and each source is checked against its keccak-256 hash. A Sourcify source that fails that check is not used, so the gateway or your `sources` can supply it.
  
  Two error codes are added. `no-metadata-hash` (exit code 2) means the bytecode holds no hash: no code at the address, no CBOR block, or only the compiler version. `metadata-unavailable` (exit code 5, retryable) means the JSON-RPC endpoint gave no bytecode, no source returned matching metadata, or the time budget ran out; `details.attempts` lists each source tried and its outcome. The `MetadataAttempt` type is exported from `explorer-verify`.
  
  [#34](https://github.com/aelmanaa/explorer-verify/issues/34)

- [#78](https://github.com/aelmanaa/explorer-verify/pull/78) [`1f57b85`](https://github.com/aelmanaa/explorer-verify/commit/1f57b857f8ade904c82882c0b4bc04ab5d47ad40) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Add `checkStatus(handle, options)`, which continues polling a verification that `verify()` submitted, and never submits. It takes the handle object or its one-line form `ev1:<backend>:<chainId>:<address>:<jobId>`. It resolves the API from the handle's chain id and the `route` option, never from the handle, and throws `invalid-input` before any request when the handle's backend is not the route's. It polls at once, then every `pollIntervalMs`, and maps the end as `verify()` does: `not-confirmed` again carries the same handle, and `verification-inconclusive` means calling `verify()` again. When the explorer no longer knows the job, it looks the contract up: a match returns `verified`, otherwise it throws `job-not-found` with a hint to call `verify()` again. It emits `verify.routed`, `verify.poll`, `verify.retry` and `verify.result`.
  
  Export `formatHandle`, which writes the one-line form. `parseHandle` now also reads the one-line form, which must split on `:` into exactly five parts.
  
  [#18](https://github.com/aelmanaa/explorer-verify/issues/18)

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

- [#161](https://github.com/aelmanaa/explorer-verify/pull/161) [`86c2c9c`](https://github.com/aelmanaa/explorer-verify/commit/86c2c9cf1ca0f7e10aa03676fd86d15bef8876a0) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `explorer-verify verify` takes a JSON-RPC endpoint, so it can derive missing constructor arguments from the `--creation-tx` transaction (`VerifyOptions.rpcUrl`). Providers often put a key in the URL, so the CLI treats it like a key. `--rpc-url-file <path>` reads it from a regular file and `--rpc-url-stdin` reads it from stdin, with one trailing newline removed. `--rpc-url <url>` takes only a URL with no path segment, query name or value, user name, password or fragment of 8 or more characters, and exits 2 for any other, such as `https://rpc.ankr.com/eth_sepolia`. Each option can be given once. No environment variable and no `--input-json` field holds the URL; the three options may accompany `--input-json`. `--rpc-url-stdin` exits 2 with `--api-key-stdin` or `--input-json -`, and when stdin is a terminal.
  
  Those parts of the URL, as typed and as parsed, are removed from stdout and stderr in any letter case, at every log level and format, and no error repeats the URL or its file's path. A JSON envelope or JSON log line is scrubbed in its string values and property names, but the envelope's own property names and values that are the CLI's own words, such as backend names and statuses, stay as they are, so the envelope keeps its shape. With `--dry-run`, the URL is checked and gets no request. `input.schema.json` now says that the request has no field for an RPC URL.
  
  [#146](https://github.com/aelmanaa/explorer-verify/issues/146)

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

- [#124](https://github.com/aelmanaa/explorer-verify/pull/124) [`147262f`](https://github.com/aelmanaa/explorer-verify/commit/147262f637dddbf960d4d06a5d371971d964cc95) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Every TypeScript example in the packaged docs now compiles and runs in the tests, and each example that prints shows its output. Fixed examples: the errors page and the abort example in `verify()` now import `verify`; the npm package guide names the Hardhat 3 build-info file with its full id; the Hardhat guide no longer calls `verify()` at the end of its first example, as in the other guides; the server handler's first example says that `deployerAddress` stands for your own address, prints the answer, and shows what `logger: console` prints; the linked-libraries examples in `verify()` and the Hardhat guide now run on their own and show their output. Issue: https://github.com/aelmanaa/explorer-verify/issues/83

- [#112](https://github.com/aelmanaa/explorer-verify/pull/112) [`e603436`](https://github.com/aelmanaa/explorer-verify/commit/e6034361ecd24217508c79ede5b81bcbbdac908c) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `error.docsUrl` now points at the code's page on the docs site, `https://aelmanaa.github.io/explorer-verify/reference/errors/<code>`, instead of the page file on GitHub. Append `.md` to the URL for the page as Markdown. The site serves the docs of the version on npm `latest`, with an `llms.txt` that lists the Markdown copy of every page. Issue: https://github.com/aelmanaa/explorer-verify/issues/84

- [#147](https://github.com/aelmanaa/explorer-verify/pull/147) [`76fa17b`](https://github.com/aelmanaa/explorer-verify/commit/76fa17b4e98f66a27f7035f1a44201aafc46a50c) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The dry run's log line for a contract the explorer already holds reads "already holds the contract (exact match)" instead of "already holds a exact match".

- [#43](https://github.com/aelmanaa/explorer-verify/pull/43) [`369cf19`](https://github.com/aelmanaa/explorer-verify/commit/369cf19d9f93fb52f2c46f9c953f15ba8e12ea94) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Add nine error codes: `unsupported-chain`, `network`, `rate-limited`, `timeout`, `unexpected-response`, `in-progress`, `unknown-state`, `job-not-found` and `cancelled`. Each has a hint, a retry flag, typed `details` and an entry in the error reference. The library never throws `cancelled`; the CLI creates it for exit code 130.
  
  Add `ERROR_EXIT_CODES`, which maps each error code to its CLI exit code, and the `ExitCode` type. `in-progress` maps to 5, `job-not-found` to 6 and `cancelled` to 130.
  
  `ExplorerVerifyError` now removes API keys from its message, hint, details and cause, and shows `[redacted]` in their place. The options now require `secrets`, the key values of the call; pass `[]` when there is none. The error also redacts the value of an `apikey`, `key` or `token` parameter in a URL or form body, URL user info, bearer tokens and bare 34-character Etherscan-style keys. Redaction takes linear time, so a 1 MB explorer answer cannot stall it.
  
  `details` is rebuilt from the fields of its code, so an extra field never reaches the error. `cause` holds a redacted copy of the underlying error, so `console.log(error)` does not print a key.
  
  An empty or blank `hint` option keeps the code's default hint.
  
  `toJSON()` now includes the handle for `unknown-state`, `job-not-found` and `cancelled` errors too, when the error has one.
  
  A handle with one unknown field now reports "has 1 field that is not a handle field".
  
  [#12](https://github.com/aelmanaa/explorer-verify/issues/12)

- [#89](https://github.com/aelmanaa/explorer-verify/pull/89) [`755a5fa`](https://github.com/aelmanaa/explorer-verify/commit/755a5fa3a2a6763547a09c0f112a53e3405ec5d7) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Each error code now has its own docs page, `docs/reference/errors/<code>.md`, with the cause, the fix, the default hint, whether to retry and the exit code. `error.docsUrl` points at that page, with no fragment, so fetching it returns one code. `docs/reference/errors/index.md` keeps the shared sections: error fields, key redaction, exit codes and retries. `llms.txt` lists every code page.

- [#250](https://github.com/aelmanaa/explorer-verify/pull/250) [`49ce96c`](https://github.com/aelmanaa/explorer-verify/commit/49ce96c75baa159742b3388529486e74ced5a20b) Thanks [@aelmanaa](https://github.com/aelmanaa)! - A `route.apiUrl` on Etherscan's own API now takes `apiKeys["etherscan-v2"]`. Before, `route: { backend: "etherscan-v2", apiUrl: "https://api.etherscan.io/v2/api" }` threw `missing-api-key` with a message that named `api.etherscan.io` as the only host for the key. The origin is compared after the host is lower-cased and a trailing dot and `:443` are removed, so the key still goes only to `api.etherscan.io`. For an `apiUrl` on any other host, the message now says that `apiKeys.etherscan-v2` goes only to Etherscan's own API and asks for `route.apiKey`. In the CLI, `ETHERSCAN_API_KEY` now goes with `--api-url https://api.etherscan.io/v2/api`. Issue: https://github.com/aelmanaa/explorer-verify/issues/244

- [#129](https://github.com/aelmanaa/explorer-verify/pull/129) [`5faa6a6`](https://github.com/aelmanaa/explorer-verify/commit/5faa6a69d2243d32249dd7406a9c508c0e3a4918) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Add the Etherscan API v2 client. `verify()` and `checkStatus()` use it for `route.backend` `etherscan-v2`. Every request is a form-encoded POST to `https://api.etherscan.io/v2/api?chainid=<id>`, with the key in the body and never in the URL.
  
  The routing table lists Etherscan for the chains of the Etherscan chainlist, so a key in `apiKeys` reaches Etherscan on those chains. From a browser, pass `route: { backend: "etherscan-v2" }` and a `fetch` that sends the requests to your `createVerifyHandler`, which adds the key.
  
  Etherscan answers almost everything with HTTP 200 and puts the meaning in its `result` text. The client maps each known text to an outcome or a typed error. A text it does not know throws: it never reads as success, as "not verified" or as `failed`.
  
  - `Max calls per sec rate limit reached` is retried with backoff, as a 429 is, and emits `verify.retry` with `reason` `rate-limited`. A daily limit throws `quota-exceeded` at once.
  - `Contract source code already verified` and `Already Verified` give `already-verified`.
  - `Unable to locate ContractCode at …` sends the submit again every `pollIntervalMs`, at most 10 times, with a `verify.retry` event whose `reason` is the new value `not-indexed`. The error at the end says to check the chain id and the address.
  - `Fail - Unable to verify` is checked with one lookup before the call reports `failed`.
  - A lookup with a non-empty `SimilarMatch` gives `partial`.
  
  `event.schema.json` adds `not-indexed` to the `verify.retry` reasons. The not-confirmed message now says whether the last lookup failed or found no match. The new reference page `docs/user/reference/etherscan.md` lists the requests and how each answer is read.
  
  [#61](https://github.com/aelmanaa/explorer-verify/issues/61)

- [#151](https://github.com/aelmanaa/explorer-verify/pull/151) [`f26cd8d`](https://github.com/aelmanaa/explorer-verify/commit/f26cd8dc004c7f3b36dccddaf525888fdb3f517b) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Add the client for standalone Etherscan-compatible explorers: an explorer that serves Etherscan's API on its own host for one chain. `verify()` and `checkStatus()` use it for `route.backend` `etherscan-compatible`. The routing table lists no such explorer, so name its API with `route.apiUrl`, and its key, if it needs one, with `route.apiKey`:
  
  ```ts
  await verify(input, {
    route: {
      backend: "etherscan-compatible",
      apiUrl: "https://explorer.example.org/api",
      apiKey: explorerKey,
    },
  });
  ```
  
  The client reads every answer as the Etherscan v2 client does. It differs in three ways:
  
  - Every request is a form-encoded POST to `route.apiUrl`, with no `chainid` parameter.
  - The key goes only in the `apikey` field of the form body, and only to the host of `route.apiUrl`. `apiKeys["etherscan-compatible"]` still throws `invalid-input`, and a key in `apiKeys` for another backend is never sent.
  - No `missing-api-key` check runs before the call: an explorer that needs a key answers `Missing/Invalid API Key`, which throws `missing-api-key`.
  
  A result has no `explorerUrl`. `route.backend` `etherscan-compatible` without `route.apiUrl` now throws `unsupported-chain` instead of `invalid-input`.
  
  Etherscan's retired per-chain hosts, such as `api-sepolia.basescan.org/api`, answer `You are using a deprecated V1 endpoint` with HTTP 200. For every Etherscan-style client this still throws `unexpected-response`, now with the hint `Use the etherscan-v2 backend without route.apiUrl.`
  
  The client loads only when a call is routed to it, so a bundler that splits code puts it in a chunk of its own, about 3.3 KB gzipped.
  
  The new reference page `docs/user/reference/etherscan-compatible.md` lists the requests and the key rules.
  
  [#63](https://github.com/aelmanaa/explorer-verify/issues/63)

- [#159](https://github.com/aelmanaa/explorer-verify/pull/159) [`4adfd26`](https://github.com/aelmanaa/explorer-verify/commit/4adfd26acbf7a246db2d6316aef15be0875c6a07) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Etherscan's answer `Free API access is not supported for this chain` now throws `api-key-rejected` instead of `unexpected-response`. Etherscan gives it when a free-plan key asks about a chain that needs a paid plan. The hint says to use a key on a paid Etherscan plan, or to verify on Sourcify with `route: { backend: "sourcify" }`. Issue: https://github.com/aelmanaa/explorer-verify/issues/135

- [#142](https://github.com/aelmanaa/explorer-verify/pull/142) [`3ba6cf3`](https://github.com/aelmanaa/explorer-verify/commit/3ba6cf3b2352ed191f58c383cef938fbc0de8940) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The routing table lists Etherscan v2 for the 57 chains of the Etherscan chainlist, checked on 2026-11-04. Each entry names the chain's explorer host, so an Etherscan result has an `explorerUrl`, such as `https://sepolia.etherscan.io/address/<address>#code`.
  
  Behaviour change: on the 46 free-tier chains, a call with `apiKeys["etherscan-v2"]` now goes to `api.etherscan.io`, with the key in the POST body. Before, it went to Sourcify. A call without the key still goes to Sourcify and sends no key. On the 11 chains that need a paid Etherscan plan, Sourcify stays first; set `route: { backend: "etherscan-v2" }` to use Etherscan there.
  
  `routingTableDate()` returns `2026-11-04`.
  
  [#122](https://github.com/aelmanaa/explorer-verify/issues/122)

- [#52](https://github.com/aelmanaa/explorer-verify/pull/52) [`2945a05`](https://github.com/aelmanaa/explorer-verify/commit/2945a05034b84ed2dc4f6fa8e1165303ac891c6e) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Add the HTTP layer that every backend uses. Each request goes through the `fetch` you pass, or `globalThis.fetch`. A lookup or a poll is tried at most 5 times after a network error, a request that took longer than 30 seconds, or HTTP 429, 502, 503 or 504. A submit is retried only after HTTP 429 or 503. A submit that got no answer is not sent again, because the explorer may have received it. The wait between tries starts at 1 second, doubles each time and follows `Retry-After` when the explorer sends it. A `Retry-After` above 30 seconds stops the retries. An abort stops every request and wait at once, and the call rejects with `signal.reason`.
  
  The library never follows a redirect. A redirect, a response body above 16 MiB, or a body that fails after the headers arrived ends the call with `unexpected-response`. Log lines never show the query string of a request URL.
  
  The `rate-limited` error has a new optional field, `details.attempts`, with the number of requests tried. The `unexpected-response` error has a new optional field, `details.retryAfterMs`, set when the explorer's last answer had a `Retry-After` header.
  
  Errors and logs now also redact the API key in the form the URL parser writes it in a query string or a path.
  
  [#14](https://github.com/aelmanaa/explorer-verify/issues/14)

- [#76](https://github.com/aelmanaa/explorer-verify/pull/76) [`df6ed4d`](https://github.com/aelmanaa/explorer-verify/commit/df6ed4da0b35d1acac3585a426c0241fb087aa7d) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The HTTP layer no longer reads `signal`, `requestTimeoutMs`, `maxResponseBytes`, the request `body` or any other field of its context and request from the prototype chain. It reads each field once, as an own property. A getter or Proxy trap that throws while these fields are read gives `invalid-input`, and the error does not repeat the thrown text. An aborted signal still rejects with its reason first. The `RequestInit` passed to `fetch` has no prototype, so an injected `fetch` cannot read a `body` or `headers` added to `Object.prototype`. The platform's own `fetch` may still read inherited `RequestInit` members: Node's does.
  
  [#72](https://github.com/aelmanaa/explorer-verify/issues/72)

- [#160](https://github.com/aelmanaa/explorer-verify/pull/160) [`2c9ad23`](https://github.com/aelmanaa/explorer-verify/commit/2c9ad231fe5dbf7446fa503b0a96aa5a17053bd4) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The logger now gets the request and retry lines for requests to `rpcUrl` (in `verify()` and `buildVerifyInputFromBytecode`) and to `ipfsGateway` (in `buildVerifyInputFromBytecode`). These lines carry a `label` field, `rpc` or `ipfs`, in place of `backend`, because these endpoints are not backends. A logged URL shows its origin and path, with the whole query string as `?REDACTED`, and each path segment of 8 or more characters removed as a possible key. Retries of these requests emit no `verify.retry` event, which names the backend a request goes to; the event schema does not change.
  
  [#134](https://github.com/aelmanaa/explorer-verify/issues/134)

- [#184](https://github.com/aelmanaa/explorer-verify/pull/184) [`c3da921`](https://github.com/aelmanaa/explorer-verify/commit/c3da9218b85844940c7253f28cf6aa4fb2487b38) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `verify()` reads the answer of a `fetch` you pass even when it comes from another URL than the explorer's, such as the server handler at `/api/verify` on the page's own origin. Before, every answer through the server handler ended with `unexpected-response`: "answered with a redirect, which is not followed". A 3xx, an opaque redirect or an answer marked `redirected` still ends the call with `unexpected-response`, from any `fetch`. With the default `fetch`, an answer from another origin than the request is still refused. Issue: https://github.com/aelmanaa/explorer-verify/issues/183

- [#148](https://github.com/aelmanaa/explorer-verify/pull/148) [`afac930`](https://github.com/aelmanaa/explorer-verify/commit/afac930f5579c1e0768590a1c2d545a8a851493b) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `verify()`, `checkStatus()` and `dryRun()` load each explorer client with a dynamic `import()`, only when a call is routed to it. Vite, Rollup and webpack put each client in a chunk of its own, and esbuild does the same with `--splitting`. A new client therefore no longer grows the code a page loads before its first call. Measured on `verify` with Vite 5.4.21, the entry is 17,056 bytes gzipped and a call routed to Sourcify adds 3,635, against 21,106 for one file with every client. With esbuild the page is about 1 KB larger than before, with or without `--splitting`. The load counts against `timeoutMs` and stops when the signal aborts. A client that fails to load rejects the call with the loader's error. The API and the results do not change. Issue: https://github.com/aelmanaa/explorer-verify/issues/136

- [#249](https://github.com/aelmanaa/explorer-verify/pull/249) [`d88f582`](https://github.com/aelmanaa/explorer-verify/commit/d88f5828a292b84e685602391eac1f8665867cfb) Thanks [@aelmanaa](https://github.com/aelmanaa)! - A module that fails to load, such as a client chunk the page cannot fetch, now rejects `verify()`, `dryRun()`, `checkStatus()`, `verifyEach()` and `linkProxy()` with an `ExplorerVerifyError` `network`: retryable, with the loader's error as `cause` and a hint to check the network and the files the site serves. This covers the explorer clients, the routing table, the constructor argument code, the proxy-link code and the `handlerUrl` code. Before, the call rejected with the runtime's own error, such as `TypeError: Failed to fetch dynamically imported module`. No request is sent. `explorer-verify/core` loads no module and does not change. Issue: https://github.com/aelmanaa/explorer-verify/issues/236

- [#119](https://github.com/aelmanaa/explorer-verify/pull/119) [`6f42c8d`](https://github.com/aelmanaa/explorer-verify/commit/6f42c8ddcc03bd208275cf1bf63acfbab3b177f0) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Add `libraries` to `VerifyInput`: library link addresses keyed by `path:Name`, for a contract that calls an external library. `validateInput` checks each key and address, rejects a local path or a path that is not a source, and rejects any other value that `settings.libraries` already holds for the same library under its path. Issues name `libraries.<position>`, never the key. `verify()` sends the compiler input unchanged, because adding the addresses changes the metadata hash of a contract linked after compiling, and in a live test on 2026-11-03 Sourcify then gave only a partial match. Add `linkLibraries`, which merges the addresses into `settings.libraries` for an explorer that needs them there. It also checks a value under the empty path, which solc applies to every file.
  
  [#65](https://github.com/aelmanaa/explorer-verify/issues/65)

- [#179](https://github.com/aelmanaa/explorer-verify/pull/179) [`60f089c`](https://github.com/aelmanaa/explorer-verify/commit/60f089ce4d27f8a38f9b3ae961dab95369caf590) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Add `linkProxy(target, options?)`, which links a verified proxy to its implementation so the explorer shows the implementation's functions on the proxy's page. `target` holds `chainId`, `address` and an optional `expectedImplementation`; `options` are those of `verify()`. Run it after you verify the implementation and the proxy: it verifies nothing itself.
  
  It returns `linked`, with the implementation the explorer reports and `implementationVerified`; `mismatch`, with the implementation the explorer holds and `expectedImplementation`, when they differ; or `not-linked`, with the explorer's reason, when the explorer refuses because the proxy is not verified there or no implementation is detected. On Etherscan v2 and standalone Etherscan-compatible explorers it sends `verifyproxycontract` and checks `checkproxyverification`; on Blockscout it does the same, then looks the implementation up, and after Blockscout's `Only one attempt in <n>ms` it waits once, or reads the implementation Blockscout holds; on Sourcify it reads `proxyResolution` and sends no request that changes anything. Routescan throws `invalid-input`.
  
  Each explorer's proxy-link code loads only when `linkProxy()` is routed to it, so `import { verify }` does not bundle it. Two error codes are added, neither with a handle: `proxy-link-unknown-state` (exit code 6, not retryable) for a link state the library cannot classify, including an implementation that is not exactly one address; and `proxy-link-pending` (exit code 4, retryable) for a link still pending at the time budget. The CLI's help lists both under their exit codes.
  
  The server handler forwards `verifyproxycontract` and `checkproxyverification` only with the new option `allowProxyLink: true`; it is off by default. With `deployers` set, the deployer check runs on the proxy. Its reduced `getsourcecode` answer now also keeps `Implementation` when it is an address, which `linkProxy()` reads after a mismatch.
  
  [#94](https://github.com/aelmanaa/explorer-verify/issues/94)

- [#70](https://github.com/aelmanaa/explorer-verify/pull/70) [`9c3bad5`](https://github.com/aelmanaa/explorer-verify/commit/9c3bad5636286bd1596400ae2c89416c8464abed) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `Logger` methods now take `(message, fields?)`. `fields` is a flat object whose values are strings, numbers, booleans or `null`. `console` still fits the type, and a logger that reads only the message keeps working. The library removes API keys from the message and from every field name and value. A field named like a key, such as `apikey` or `token`, has its string value replaced whole. A logger method that throws, or returns a promise that rejects, is ignored and does not change the outcome. The library never logs at `error` a failure it throws.
  
  Add `VerifyOptions.onEvent`, typed `(event: VerifyEvent) => void | Promise<void>`. It receives the stage events: `verify.validated`, `verify.routed`, `verify.lookup`, `verify.submitted` with the handle, `verify.poll`, `verify.retry` and `verify.result`. Each event is a new, frozen, flat object with API keys removed. In the handle, only the job id is redacted, as in the envelope. When `onEvent` throws or its promise rejects, the first failure in a call is logged at `warn` and the call goes on. A returned promise is not awaited. Without `logger` and `onEvent` the library writes nothing.
  
  Add the `LogValue`, `LogFields` and `VerifyEvent` types. The package ships a JSON Schema for the events as `explorer-verify/event.schema.json`, with `state` and `reason` as enums.
  
  The HTTP layer and the Sourcify client log through one observer per call. Log lines carry the backend, method, URL and attempt as fields, and the HTTP layer emits `verify.retry` before each retry wait. Redaction now also covers a known key that was URL-encoded twice. The new reference page "Logging and events" describes both outputs.
  
  [#53](https://github.com/aelmanaa/explorer-verify/issues/53)

- [#54](https://github.com/aelmanaa/explorer-verify/pull/54) [`e2f7a18`](https://github.com/aelmanaa/explorer-verify/commit/e2f7a18649865dc1d3640ebc0a9d5ccab892f10b) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Add `exitCodeOf(outcome)`, which gives the CLI exit code of a `VerifyResult` or an `ExplorerVerifyError`: 0 for `verified` and `already-verified`, 1 for `failed`, and the `ERROR_EXIT_CODES` entry for an error.
  
  Add `toEnvelope(outcome, options?)`, which turns a result or an error into the versioned JSON envelope that the CLI prints with `--json`: `{ schemaVersion: 1, ok, result }` or `{ schemaVersion: 1, ok: false, error }`. `ok` is `true` exactly when the exit code is 0. Keys are always in the same order, and every string is redacted. Pass the call's API key in `secrets` to remove it wherever it appears.
  
  Both functions check the outcome the same way and throw `invalid-input` for a value that is neither a result nor an error, or for options other than `{ secrets?: string[] }`. They accept an error from a second copy of the package, which `instanceof` misses, when its `name` is `ExplorerVerifyError` and its `toJSON()` returns a valid error object.
  
  Add the `Envelope`, `EnvelopeOptions` and `VerifyOutcome` types.
  
  The package ships a JSON Schema for the envelope as `explorer-verify/envelope.schema.json`. It compiles in strict mode and accepts error codes and backends that a later release may add. The new reference page "JSON output and exit codes" lists the exit code of every outcome.
  
  The job id of a handle is no longer redacted for having the shape of a bare Etherscan key, so a 34-character job id still resumes. A job id that equals a known secret or holds a key-like parameter is still redacted.
  
  [#5](https://github.com/aelmanaa/explorer-verify/issues/5)

- [#73](https://github.com/aelmanaa/explorer-verify/pull/73) [`3545aad`](https://github.com/aelmanaa/explorer-verify/commit/3545aade082511be19e44805fb649250b8ceb09b) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `buildVerifyInput` now rebuilds the Standard JSON input from Solidity metadata and the source files, so a package that ships a Foundry artifact or a metadata string without build-info can be verified. It accepts metadata as an object, as a JSON string, or in an artifact's `rawMetadata` or `metadata`. Pass the sources the metadata does not embed in the new `sources` option, keyed by path. The version comes from `compiler.version` and the contract from `settings.compilationTarget`. The settings are copied from the metadata, with `libraries` converted to the Standard JSON form.
  
  Before it returns, the builder hashes each source with keccak-256 and compares the hash with the metadata. A missing source fails with `incomplete-input` on `sources`, listing the missing paths (at most 1,000; the message gives the count). A source that differs fails with the new error code `source-mismatch`, which names the file and both hashes and exits with code 2.
  
  Metadata from solc 0.5.0 to 0.8.24 is tested. The builder adjusts three settings that solc records but rejects in an input: it drops `bytecodeHash` when `appendCBOR` is `false`, moves `optimizer.details.inliner` to `optimizer.enabled` for solc 0.8.2 to 0.8.4, and sets `useLiteralContent` when the metadata embeds the sources without it. A library keyed by bare name, as solc 0.7.4 and earlier write it, goes under the empty path. In a rebuild, `options.contract` must name the metadata's own contract.
  
  `validateInput` now also rejects a source path with a Unicode format character, such as a bidirectional override.
  
  [#21](https://github.com/aelmanaa/explorer-verify/issues/21)

- [#40](https://github.com/aelmanaa/explorer-verify/pull/40) [`feba0d6`](https://github.com/aelmanaa/explorer-verify/commit/feba0d6a06ebff3df6453539363ef95bd8679d0b) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Add routing for `VerifyOptions.route`. Calls go to Sourcify at `https://sourcify.dev/server`, and `route.apiUrl` can point at another Sourcify server, such as a self-hosted one or a local test server. `verify()` uses this routing when it lands.
  
  `route` must be a plain object. `route.apiUrl` must be a string of at most 8192 characters that uses `https:`, or `http:` on `localhost`, `127.0.0.1` or `[::1]`. A URL with a user name, a password or a fragment is rejected. A query string is sent with every request and redacted in logs. Only the query is redacted, so never put a key in the host or path. A bad route throws `invalid-input`, and the error never repeats the value. In this version `route.backend` accepts only `sourcify`.
  
  `explorerUrl` in a `verified` or `already-verified` result is now optional. It is absent when the route points at a server other than the public Sourcify API, because the public Sourcify repository does not show contracts verified elsewhere.
  
  [#15](https://github.com/aelmanaa/explorer-verify/issues/15)

- [#33](https://github.com/aelmanaa/explorer-verify/pull/33) [`28d9682`](https://github.com/aelmanaa/explorer-verify/commit/28d9682eee4a8b892d4f3ef64cdc3fb5918b9601) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Add the `VerifyOptions`, `Logger`, `RouteOverride` and `Handle` types. Every option is optional.
  
  Add `ExplorerVerifyError`, the one error class the library throws. It has a stable `code`, a `hint`, a `docsUrl`, a `retryable` flag and `details`. Checking `details.code` narrows `details`. `JSON.stringify(error)` prints no cause and no stack.
  
  Add `parseHandle`, which reads a stored handle and rejects any field it does not know, such as a URL.
  
  [#11](https://github.com/aelmanaa/explorer-verify/issues/11)

- [#245](https://github.com/aelmanaa/explorer-verify/pull/245) [`f7c12bf`](https://github.com/aelmanaa/explorer-verify/commit/f7c12bf549560b9f2f52b2782fd0bee8043f2548) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Polling now stops at the time budget's deadline when the last wait ends there. Before, a timer that fired on time could read the clock 1 ms early, and `verify()` sent one more status poll. Issue: https://github.com/aelmanaa/explorer-verify/issues/243

- [#258](https://github.com/aelmanaa/explorer-verify/pull/258) [`0454017`](https://github.com/aelmanaa/explorer-verify/commit/0454017813533a87e4ff816c11ebd8f9e9945be6) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Add tested CLI and SDK quickstarts to the package READMEs. Remove contributor tracking IDs from editor documentation and omit internal dependency injection declarations from builds. Package checks reject internal IDs in generated declarations.
  
  Issue: https://github.com/aelmanaa/explorer-verify/issues/226

- [#77](https://github.com/aelmanaa/explorer-verify/pull/77) [`29a08aa`](https://github.com/aelmanaa/explorer-verify/commit/29a08aa66688870aa703a89235f0b46742f70bc2) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Redaction now removes a known key that an explorer echoes in a JSON body: JSON-escaped, where a `"` or a `\` in the key is escaped; escaped twice, as in a JSON text inside another; and with each character other than a letter or digit written as `\uXXXX`. A JSON `"apikey"` member is now redacted whole when its value holds up to 1024 escape sequences; before, the part after the first `\` stayed in the text.
  
  [#50](https://github.com/aelmanaa/explorer-verify/issues/50)

- [#228](https://github.com/aelmanaa/explorer-verify/pull/228) [`3a69911`](https://github.com/aelmanaa/explorer-verify/commit/3a69911cf2aa9a89f21567f9ed4bc48db869f6da) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `buildVerifyInput` now refuses build files from zksolc, the compiler for ZKsync Era's EraVM, with `unsupported-compiler`. Before, it read a foundry-zksync or hardhat-zksync build as solc and returned an input that no explorer could match. `details.field` names the field that showed zksolc, such as `input.zksolc_version`, `output.zk_version` or `_format`, and the hint says that a contract compiled with plain solc still verifies. The CLI exits with code 2 before any request.
  
  [#227](https://github.com/aelmanaa/explorer-verify/issues/NN)

- [#177](https://github.com/aelmanaa/explorer-verify/pull/177) [`99ee2a4`](https://github.com/aelmanaa/explorer-verify/commit/99ee2a49a31a6cde894f7ca1555f5f9fa16e0ae2) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The Routescan client reads the status answer `Error: Compilation successful, but bytecode does not match with deployed bytecode for address …` as `failed`, with that text as the reason. `verify()` and `checkStatus()` used to throw `unknown-state` for it. The match uses the text before the address. Etherscan has not been recorded giving this text, so the Etherscan client still throws `unknown-state` for it. Issue: https://github.com/aelmanaa/explorer-verify/issues/164

- [#139](https://github.com/aelmanaa/explorer-verify/pull/139) [`ec98e86`](https://github.com/aelmanaa/explorer-verify/commit/ec98e86f355bb7308d979da3d9a56e9f1ecbf1bd) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Add the Routescan client. `verify()` and `checkStatus()` use it for `route.backend` `routescan`. Each chain has its own API URL, with the network and the chain id in the path, so no request sends `chainid`. The free tier needs no key; a key, when set, goes in the `apikey` request header and never in the URL or the body.
  
  On a chain the routing table lists Routescan for, name it with `route: { backend: "routescan" }`. Elsewhere, add the chain's URL: `route: { backend: "routescan", apiUrl: "https://api.routescan.io/v2/network/testnet/evm/43113/etherscan/api" }`, with `apiKey` if you have one; `route.apiKey` goes to the host of `route.apiUrl`. A key in `apiKeys.routescan` is sent only on a route the table lists.
  
  - The submit is a form-encoded POST. A lookup and a status request are GETs with a `nocache` query parameter of random characters, new on every attempt and retry, because Routescan's CDN serves a repeated URL from its cache.
  - `chain not supported` throws `unsupported-chain`, never `failed`. It also comes back when the URL names the wrong network.
  - `Verification not found` throws `job-not-found` from the client. `verify()` and `checkStatus()` then look the contract up once and return `verified` when it is verified: Routescan has forgotten a job 51 minutes after its submit.
  - `Missing guid` throws `unexpected-response`; `verify()` and `checkStatus()` count it as a failed poll.
  - A lookup never gives `partial`: Routescan's lookup has no `SimilarMatch` field.
  
  The new reference page `docs/user/reference/routescan.md` lists the requests and how each answer is read.
  
  [#62](https://github.com/aelmanaa/explorer-verify/issues/62)

- [#204](https://github.com/aelmanaa/explorer-verify/pull/204) [`dc7b98d`](https://github.com/aelmanaa/explorer-verify/commit/dc7b98dc342d282b8b6925f5b51177d363adbc94) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The Routescan client reads the wait in Routescan's `x-ratelimit-rpm-retry-after` header when a 429 has no `Retry-After` header. Routescan sends that header when a key passes its per-minute limit, with a wait of up to 60 seconds. A wait above 30 seconds now throws `rate-limited` at once, with `details.retryAfterMs` set. Before, the client sent four more requests within the same minute, and each one got the 429 again. A keyless 429 has no wait header and is still retried with backoff. Issue: https://github.com/aelmanaa/explorer-verify/issues/133

- [#191](https://github.com/aelmanaa/explorer-verify/pull/191) [`c2142eb`](https://github.com/aelmanaa/explorer-verify/commit/c2142eb9fbd565002f62f66d4f16870dafa8d4d3) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The routing table now lists Routescan for the 38 chains whose Routescan API answered a keyless probe on 2026-11-05, and has 314 rows. 26 of these chains had no row and now have Routescan alone, among them Henesys (68414), Beam (4337), Chiliz (88888), Dexalot (432204) and DFK (53935). The other 12 keep their backends and add Routescan last, among them Ethereum (1), Sepolia (11155111), Avalanche C-Chain (43114) and Fuji (43113), Mantle (5000), Metis (1088) and Hemi (43111).
  
  - `route: { backend: "routescan" }` now works without `route.apiUrl` on these chains, and a key in `apiKeys.routescan` is sent to `api.routescan.io` on that route.
  - With no option, a call on a Routescan-only row, such as 68414, goes to Routescan. Before, it threw `unsupported-chain`.
  - On the 12 chains that already had a row, a call goes where it went before: Routescan comes after Sourcify and Etherscan v2.
  - `verifyEach()` with `backends: "all"` now also verifies on Routescan on these 38 chains, since Routescan needs no key. On Sepolia without a key, that is Sourcify and Routescan.
  - A result from Routescan still has no `explorerUrl`.
  
  [#168](https://github.com/aelmanaa/explorer-verify/issues/168)

- [#118](https://github.com/aelmanaa/explorer-verify/pull/118) [`0559bba`](https://github.com/aelmanaa/explorer-verify/commit/0559bbae45487faeb57f8c1c8786295aee39ba2c) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The routing table now lists 94 chains, each with Sourcify: every chain of the Etherscan chainlist and every chain of the verifier table this library started from that Sourcify supports, checked on 2026-11-03. Chains such as Ethereum Mainnet, Ethereum Sepolia, Avalanche Fuji and C-Chain, Polygon Amoy, Base Sepolia and Arbitrum Sepolia now resolve without `allowSourcifyFallback`. A chain without a row still needs that option or `route.apiUrl`.
  
  The table format is now schema 2: a row holds the chain id and its backends, and the library derives each backend's API URL and contract page. The Routing reference page shows the format and the URL rules.
  
  [#60](https://github.com/aelmanaa/explorer-verify/issues/60)

- [#110](https://github.com/aelmanaa/explorer-verify/pull/110) [`e89d615`](https://github.com/aelmanaa/explorer-verify/commit/e89d6158586191eef1d72754b58c1ff1a40d55d1) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Calls now resolve their route from a routing table shipped with the package. Each row lists a chain's backends in order of preference, with the API URL and the explorer page of each. A call goes to the first backend in the row that works with the keys you passed: one that needs a key is skipped when `apiKeys` has none for it. `route.backend` picks another backend that the row lists.
  
  Behaviour change: a chain the table does not list now throws `unsupported-chain` before any request. Set the new option `allowSourcifyFallback: true` to send such a chain to the public Sourcify API, as earlier releases did for every chain, or set `route.apiUrl`. In this release the table lists chains 1, 43113, 84532, 421614 and 11155111, each with Sourcify only. More chains and backends come in later releases.
  
  `route.backend` now accepts every backend name that this version has a client for; any other throws `invalid-input`. A key from `apiKeys` now goes only to the host the table lists for the backend and chain, and never to a `route.apiUrl` you set, even on the same host; use `route.apiKey` there. Etherscan v2 requests get `chainid` from the route; a `chainid` in the query of `route.apiUrl`, in any letter case, is dropped, so a request never goes to another chain. See the new Routing reference page.
  
  [#59](https://github.com/aelmanaa/explorer-verify/issues/59)

- [#149](https://github.com/aelmanaa/explorer-verify/pull/149) [`6a18410`](https://github.com/aelmanaa/explorer-verify/commit/6a184103013ac6f3b382ceaecd265b03e034264d) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The packaged docs add four how-to guides, one per runtime: verify from a browser (with a bundler or a CDN import map), from Node.js (keys from the environment, a logger, events, and `checkStatus()` from a job queue, with notes for Deno and Bun), from an edge function (submit in one request, resume in later ones), and from CI with the CLI (dry run, `--json` and `jq`, exit codes in a shell `case`, keys from CI secrets). Issue: https://github.com/aelmanaa/explorer-verify/issues/105

- [#116](https://github.com/aelmanaa/explorer-verify/pull/116) [`64c1d58`](https://github.com/aelmanaa/explorer-verify/commit/64c1d585787a9e1d9c6da9bf20674c0ebd19155e) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The package has a second entry point, `explorer-verify/server`, with `createVerifyHandler`. It returns a function from `Request` to `Response` that holds your Etherscan key on your own server and forwards three actions to Etherscan's v2 API, with the key in the form body: `verifysourcecode`, `checkverifystatus`, and the lookup `getsourcecode`, whose answer it reduces so that no source code or ABI is relayed. It refuses other methods, other content types, encoded bodies, bodies above `maxBodyBytes` before parsing them, bodies that do not arrive within `timeoutMs` (20 s by default), requests with more than 16 fields, chains outside `chains`, any field that names a key, a route, an API URL or a host, and, with `deployers` set, a contract none of them created. An optional `rateLimit` hook runs before the body is read, and an optional `logger` gets each refusal and failure. Every upstream request sets `redirect: "manual"`, a redirect is refused, and each upstream request is retried at most once. No response holds the key. Issue: https://github.com/aelmanaa/explorer-verify/issues/42

- [#69](https://github.com/aelmanaa/explorer-verify/pull/69) [`21e7360`](https://github.com/aelmanaa/explorer-verify/commit/21e7360f2eb9223f74713934c911793e2594d023) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Add the Sourcify API v2 client, the first backend. It looks a contract up, submits the source and polls the job. Each Sourcify answer becomes a match, a result or a typed error; an answer the client does not recognise throws and is never read as "not verified" or as success. A submit that got no clear answer is not sent again blindly: the client looks the contract up first. A `failed` reason is redacted with the call's keys and cut to 300 characters. `verify()` and `checkStatus()` will call the client; they are not in this release.
  
  Add the error code `verification-inconclusive`: the explorer finished the job without a verdict, for example with an internal error or before it saw a new contract. Call `verify()` again; it looks the contract up first. The error is retryable, exits with code 4 and carries no handle.
  
  The new reference page `docs/reference/sourcify.md` lists the requests, how each answer is read, and Sourcify behaviour to know: lookups cached for an hour, and submits forwarded to other explorers.
  
  [#16](https://github.com/aelmanaa/explorer-verify/issues/16)

- [#186](https://github.com/aelmanaa/explorer-verify/pull/186) [`5c7a1ac`](https://github.com/aelmanaa/explorer-verify/commit/5c7a1ac0f3d2723dfc38d5902731f64c0cf006ae) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The routing table now lists 288 chains: every chain that Sourcify's chain list marks as supported, read on 2026-11-05. Before, a chain also had to be in the Etherscan chainlist or in the verifier table this library started from, and the table listed 94. The 194 new rows have Sourcify only. They include Cronos (25), Rootstock (30), ZKsync Era (324), Metis (1088), Ronin (2020), Kaia (8217), Mode (34443), Scroll (534352), Zora (7777777) and Tron (728126428).
  
  Behaviour change: on these chains, `verify()`, `checkStatus()` and the CLI go to Sourcify without `allowSourcifyFallback: true` or `--api-url`, and the result's `explorerUrl` is `https://repo.sourcify.dev/<chain id>/<address>`. Before, they threw `unsupported-chain`. `allowSourcifyFallback` now matters only for a chain Sourcify does not list.
  
  The 55 Etherscan v2 entries and their order do not change. `routingTableDate()` still returns `2026-11-05`.
  
  [#166](https://github.com/aelmanaa/explorer-verify/issues/166)

- [#176](https://github.com/aelmanaa/explorer-verify/pull/176) [`5f5fd62`](https://github.com/aelmanaa/explorer-verify/commit/5f5fd62d3056106a0f47731be7d0f990110bbf33) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The routing table no longer lists Etherscan v2 for chains 11124 (Abstract Sepolia) and 43113 (Avalanche Fuji). The Etherscan chainlist read on 2026-11-05 does not list them. Both chains keep Sourcify. The table now lists Etherscan v2 for 55 chains: 45 free-tier and 10 that need a paid plan.
  
  Behaviour change: on 11124, a call with `apiKeys["etherscan-v2"]` now goes to Sourcify and sends no key. Before, it went to `api.etherscan.io`. On 11124 and 43113, `route: { backend: "etherscan-v2" }` without `route.apiUrl` now throws `unsupported-chain`.
  
  `routingTableDate()` returns `2026-11-05`.
  
  [#165](https://github.com/aelmanaa/explorer-verify/issues/165)

- [#196](https://github.com/aelmanaa/explorer-verify/pull/196) [`0ee4ea4`](https://github.com/aelmanaa/explorer-verify/commit/0ee4ea44c2ec4e98bf16f98d322eba1acf42e19f) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The routing table can now list a standalone Etherscan-compatible explorer for a chain, and lists one: Bitlayer (200901), at `https://api.btrscan.com/scan/api`. A call on 200901 goes there with no route option, and a verified result's `explorerUrl` is `https://www.btrscan.com/address/<address>#code`. Before, it threw `unsupported-chain`. The table has 326 rows and `schemaVersion` 3; schema 3 adds the `etherscan-compatible` entry, with `api` (the API's host and path), an optional `explorer` host and an optional `needsKey`.
  
  `route.apiKey` with `route.backend` `etherscan-compatible` may now be set without `route.apiUrl` on a chain whose row lists a standalone explorer with `needsKey`. The key goes only to that explorer's host, in the form body. For an entry that takes no key, such as Bitlayer's, the call throws `invalid-input` naming `route.apiKey`, and on a chain whose row lists none it throws `unsupported-chain`, both before any request. `apiKeys["etherscan-compatible"]` still throws `invalid-input`. From the CLI, `--backend etherscan-compatible` with `--api-key-file` or `--api-key-stdin` and no `--api-url` follows the same rules.
  
  `verifyEach()` with `backends: "all"` leaves out an entry with `needsKey` when no key is bound and the row lists another backend. `linkProxy()` throws `invalid-input` on `route.backend` for a standalone explorer from the table, before any request; with `route.apiUrl` it works as before.
  
  A table entry with `needsKey: true` is skipped by a call without a key, and a call that reaches it without `route.apiKey` throws `missing-api-key` before any request, unless `fetch` is set. No entry in this release needs a key: Core (1116) and Kaia (8217) refused a keyless request and have no entry yet.
  
  Behaviour change: the `etherscan-compatible` client sends a lookup or a status request without a key as a GET with its fields in the query, because Bitlayer refuses a lookup sent as a POST. With a key, it stays a form POST, so the key is never in a URL. A lookup answered with `"status":"1"` and an empty `result` list now means "not verified" for this client.
  
  [#170](https://github.com/aelmanaa/explorer-verify/issues/170)

- [#178](https://github.com/aelmanaa/explorer-verify/pull/178) [`9e12c51`](https://github.com/aelmanaa/explorer-verify/commit/9e12c51c022a657877ff45d30260bdeb7de2849c) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `toBackendName()` takes a value of any type and returns `undefined` for a value that is not a string, so a caller no longer checks the type first.

- [#41](https://github.com/aelmanaa/explorer-verify/pull/41) [`46ae3ee`](https://github.com/aelmanaa/explorer-verify/commit/46ae3ee7fb728bf4a6f31b3c27aa57fd7bcccebd) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Add `validateInput`, which checks a verification input before any request is sent. It checks the chain id, the address format, the compiler kind and full version, the Standard JSON shape, that the contract name's path is one of the sources, and the optional constructor arguments and creation transaction hash. It throws one `invalid-input` error that lists every problem by field, and never repeats a value. It returns a deep copy of the input, with the version's leading `v` removed and the address, constructor arguments and creation transaction hash in lower case. Settings, sources and other Standard JSON fields must be JSON data: a cycle, a BigInt, a function, a symbol, NaN or an infinity, a Map, a Set, a class instance or nesting deeper than 64 levels is rejected, never silently changed. Compiler versions accept nightly builds and official pre-releases such as `0.8.31-pre.1+commit.b59566f6`.
  
  [#13](https://github.com/aelmanaa/explorer-verify/issues/13)

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

- [#74](https://github.com/aelmanaa/explorer-verify/pull/74) [`dbbfaf8`](https://github.com/aelmanaa/explorer-verify/commit/dbbfaf8e2eca8192bbcbb733dc1593c5bdae302a) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Add `verify(input, options)`, which verifies a contract's source on Sourcify. It validates the input, looks the contract up and returns `already-verified` without a submit when Sourcify already has an exact or partial match. Otherwise it submits, polls every `pollIntervalMs` and returns `verified` with the match and the contract's public page, or `failed` with Sourcify's reason. Any other end throws a typed `ExplorerVerifyError`. A status poll that fails with `network`, `rate-limited` or `unexpected-response` is logged and polling goes on. When `timeoutMs` runs out while the job is pending, or after 3 failed polls in a row, it looks the contract up once more and throws `not-confirmed` with the handle if that finds no match. The call ends within `timeoutMs` plus `min(pollIntervalMs, 30000)`. `pollIntervalMs` is raised to at least 1000 ms. A `signal`, `fetch`, `logger` or `onEvent` of the wrong kind throws `invalid-input`. An abort rejects with `signal.reason`. The handle is emitted in a `verify.submitted` event and logged at `info` as soon as Sourcify accepts the submission. Values of 8 or more characters in `route.apiUrl`'s query string are removed from errors, logs, events and results, except values of digits only and values found in the handle.
  
  [#17](https://github.com/aelmanaa/explorer-verify/issues/17)

- [#88](https://github.com/aelmanaa/explorer-verify/pull/88) [`64dd510`](https://github.com/aelmanaa/explorer-verify/commit/64dd5103e851580c0d7e1d116fb6861d50457986) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `verify()` now handles a job the explorer no longer knows as `checkStatus()` does. When a status poll answers `job-not-found`, it looks the contract up once, within the same extra window as the last lookup. A match returns `verified`. Otherwise it throws `job-not-found` with the handle: its hint says to call `verify()` again when the lookup finds the contract not verified, and its `cause` is the lookup's error when the lookup fails. Before, `verify()` threw `job-not-found` at once, so a contract that Routescan verified and then forgot the job of was reported as an error. The call still ends within `timeoutMs` plus `min(pollIntervalMs, 30000)`.
  
  Once the signal aborts, `verify()` and `checkStatus()` now always reject with `signal.reason`, unchanged, including during the forgotten-job lookup. Before, a lookup that threw another error after the abort could make either function reject with that error: `verify()` during any of its lookups, and `checkStatus()` during the forgotten-job lookup. A result reached before the abort is still returned.
  
  [#75](https://github.com/aelmanaa/explorer-verify/issues/75)

- [#256](https://github.com/aelmanaa/explorer-verify/pull/256) [`1fdd7ad`](https://github.com/aelmanaa/explorer-verify/commit/1fdd7adeb21fe8f02b7d983ac3eab1c022487d93) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Verify zksolc input through the Blockscout instances on ZKsync Era (324) and ZKsync Sepolia (300). Submit both the upstream solc version and the zksolc version. Preserve supplied constructor arguments; refuse unsupported backend and chain pairs before requests. Recorded lookup answers cover both instances. Build helpers still require solc documents.
  
  Issue: https://github.com/aelmanaa/explorer-verify/issues/207
