# Browser and Remix compatibility validation

Issue #264; parent #263. Independent local consumer for the 0.1.0 candidate at
`df036c7245c1baefa869478c7a5a00ca5366d8a2`. No upstream contact or adoption is claimed.

From the repository root, install the pinned tooling in this directory, then run:

```sh
npm ci --prefix validation/browser-remix --ignore-scripts
node validation/browser-remix/run.mjs --tarballs <candidate-tarballs-directory>
```

Requires Node 24, npm, network access for the initial tooling installation, and installed
Google Chrome on macOS. Pass `--chrome <executable>` for another Chrome/Chromium installation.
Pass `--output <directory>` to retain `results.json` and `build-info.json` elsewhere; the default
is this project's ignored `output/` directory. Exit 0 means every scenario passed; exit 1 means
at least one failure. Browser launches have no public network access. The runner creates an
isolated npm consumer in a temporary directory, copies and installs the actual
`explorer-verify-0.1.0.tgz` with lifecycle scripts disabled, bundles its public main entry for the
browser, and deletes the temporary consumer on completion. It does not install the CLI or the
Node-only build helpers. Tarball SHA-256 and browser version appear in the results.

`evidence/` records the completed run and real compiler input/output. Rerunning overwrites only
the chosen output directory. These are local compatibility results, not live explorer results.

## What executes

`host.mjs` serves as a local Remix engine stand-in. `plugin.mjs` runs inside a real browser iframe
and uses the installed `@remixproject/plugin-webview` 0.3.38 `createClient` and `PluginClient`.
The actual connector exchanges `postMessage` handshake, subscription and
`solidity.compilationFinished` notification messages with the parent window. The host validates
the iframe source and origin; the plugin restricts allowed origins. This is actual plugin-client
transport execution against a small host stand-in, not a direct callback invocation and not an
actual Remix IDE session. The generated bundle includes a browser `events` polyfill required by
the Remix client; the SDK itself imports no Node-only helper. esbuild's browser platform rejects
unresolved Node built-ins.

The compilation event follows the pinned Remix API signature:
`(fileName, sources, languageVersion, output)`. The runner compiles our MIT-licensed `Counter.sol`
with pinned npm solc 0.8.24 (`0.8.24+commit.e11b9ed9`). It emits authentic Solidity Standard JSON
input, output and metadata. The build-info envelope is assembled locally from that exact compile;
it is not exported by Remix IDE. The transport fixture uses those real compiler outputs and the
Remix API's source map shape. No handwritten pretend bytecode or invented compiler output is used.

The plugin takes metadata from the selected compiled contract and supplies exact source contents
to public `buildVerifyInput()`. This avoids guessing compiler settings from a partial event.
`validateInput()` combines the result with a successful deployment-receipt fixture's address,
transaction hash and separately supplied chain id. A receipt cannot establish the chain id on its
own. No chain or wallet deployment is performed; the receipt and transaction hash are synthetic.
The runner recompiles the submitted reconstructed input and compares its creation bytecode with
the original compile, including metadata.

Separate loopback origins serve the page and the Sourcify v2 HTTP stand-in. Browser requests use
real fetch and CORS, without an injected SDK fetch or Playwright response interception. The
stand-in checks captured submissions for source, compiler version, contract and creation hash.
It returns accepted/exact, compiler rejection and pending responses. A submitted handle is saved
in localStorage; after reloading the iframe, public `checkStatus()` resumes it. Request counts
prove resume did not submit again. The host delivers `compilationFinished` once, as Remix does
for one compile, so the reloaded plugin does not run the scenarios again. The runner closes the
page before it counts submissions, so a late submission cannot pass unnoticed. Another response
omits CORS and the browser must reject it.

Incomplete metadata without source contents yields `incomplete-input` naming `sources`; restoring
the exact source recovers. Altered source yields `source-mismatch`. Output without input or
metadata yields `incomplete-input`. This tests source restoration, not address-only recovery.
The SDK has `buildVerifyInputFromBytecode`; this consumer does not exercise it. The existing CLI
has no address-only recovery command.

## Attribution and limits

- Remix plugin packages: `@remixproject/plugin-webview`, `plugin`, `plugin-api` and `plugin-utils`
  0.3.38, npm package `gitHead` `ca5c69be64ec4eaf7fe5d1d362726e75cb3b5726`.
  [Upstream repository](https://github.com/ethereum/remix-plugin), MIT. The installed package's
  `plugin-api/src/lib/compiler/api.d.ts` and `type/output.d.ts` define the event signature and
  compiler output shape. `plugin/src/lib/connector.js` and `plugin-webview/src/lib/connector.js`
  define the exercised transport. Their code is consumed as a dependency, not copied here.
- [Solidity solc-js](https://github.com/ethereum/solc-js), npm `solc` 0.8.24, compiler commit
  `e11b9ed9`, GPL-3.0. Compiler output is generated from this project's source.
- esbuild 0.28.2 and Playwright 1.64.1 are exact direct dependencies. `package-lock.json` pins
  transitive resolutions and integrity hashes. Existing `examples/dapp` and
  `scripts/browser-smoke.ts` informed the flow and local-browser test arrangement.

The local runner does not exercise a live Remix workspace, compiler plugin, deployment plugin,
wallet permission flow, RPC chain, public testnet or explorer. The optional smoke below separately
exercises the real Remix host and compiler. The local host implements only the handshake and the
compilation event used here. The receipt does not prove deployment success, source/address identity
or constructor argument extraction on a chain. Explorer acceptance is simulated, and no contract
submission leaves loopback. Etherscan, server-handler key custody, CDN loading and other bundlers
are outside this project. This supplies compatibility evidence for a future SDK-backed Remix
plugin; it does not establish plugin acceptance or upstream adoption. Before an upstream issue or
PR after release, test a real Remix workspace, selected-contract UI, network/receipt provenance,
permission handling, imports/libraries/constructor arguments, and funded testnet deployments under
separate authorization.

The shared `validation/packages.mjs` inspector selects the supplied core by its manifest. New
runs record its actual version and gitHead. The committed evidence identifies the original 0.1.0
run. Linux uses Playwright Chromium by default; macOS uses the installed Chrome path.

## Optional real Remix website smoke

This network-dependent follow-up is separate from the local runner and does not gate normal CI:

```sh
node validation/browser-remix/run-real-remix.mjs --tarballs <candidate-tarballs-directory>
```

The same tooling installation and Chrome prerequisite apply. `--chrome <executable>` and
`--output <directory>` are supported. The default output is the ignored `output/real-remix/`.
The runner installs the actual SDK tarball into a temporary consumer, bundles the separate
`real-remix-plugin.mjs`, and opens `https://remix.ethereum.org` in a fresh browser context.
It attempts the website's external-plugin UI flow, then requests only
`solidity.compileWithParameters` for our harmless Counter sample using compiler
`0.8.24+commit.e11b9ed9`. The plugin accepts host messages only from `remix.ethereum.org`
or Remix's advertised new home, `app.remix.live`. It never requests wallet access, deployment,
RPC calls or explorer verification. No RemixVM deployment is attempted.

The runner grants Chrome's `local-network-access` permission only to the two Remix origins in
its fresh context, so the real host can load our loopback iframe. It does not disable browser
security features. This permission is required with the recorded Chrome version; attempt 03
without it captured `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`. It disables the optional
Matomo performance-analytics toggle before saving preferences and records the observed state.
If a promotion appears, a locator handler inspects its DOM, saves `promotion-dom.html`, and clicks
its close/dismiss control. It never clicks Upgrade or Sign in. `promotionsDismissed` records the
number actually dismissed; zero does not claim a dismissal.

On success it retains the actual host compilation response, metadata, compiler input/output,
and SDK-built input. `build-info.json` is a locally assembled envelope around the **actual Remix
response's** input, output and full compiler version; it is not a Remix file-manager export.
The public SDK consumes both that envelope and the real metadata with exact source contents.
The plugin also subscribes to `solidity.compilationFinished` and records an event if the host emits
one for this API call; event capture is reported separately from the method response.
It writes `status: "blocked"`, `success: false` and exits 1 when navigation, UI, permission,
transport or compilation cannot complete. Website text and a screenshot are retained on failure.
It does not dump storage, keys, request bodies, headers or query parameters. All captured pages
come from a fresh, unauthenticated context. It remains separate from the default test and CI.

The 2026-11-08 attempts are recorded in `evidence-real-remix/`. **Attempts 04 and 05 passed against the
real Remix host and Solidity 0.8.24 compiler.** It loaded our external iframe, completed the actual
plugin handshake and compiler method call, and ran the packed public SDK in that iframe to rebuild
input from authentic metadata. Performance analytics was disabled. No promotion appeared during
attempt 04 (`promotionsDismissed: 0`). Attempt 05 inspected and dismissed one actual promotion
using `button.nudge-widget-close` (title `Dismiss`); its DOM is retained. It also captured the full
compiler input/output, metadata and both SDK builder paths. `compileWithParameters` returned an
authentic compilation response; no `compilationFinished` event was observed
(`compilationEventCaptured: false`). Attempts 01 and 02 preserve the original UI blockers; attempt
03 got past preferences and captured Chrome's local-network-access refusal. No wallet, receipt,
RemixVM or public deployment, or explorer verification is involved in the real-IDE smoke. It proves
host/compiler/SDK compatibility for this sample, not upstream acceptance or live verification.
The original 16 local scenario results remain unchanged.

The external-plugin flow follows the upstream
[Plugin Manager documentation](https://remix-ide.readthedocs.io/en/latest/plugin_manager.html)
(read 2026-11-08). `compileWithParameters` and its input shape come from the pinned Remix
plugin-api 0.3.38 `compiler/api.d.ts` and `compiler/type/input.d.ts`. UI selectors may need
maintenance as the live website changes; no hidden host API or replacement fake host is used.
