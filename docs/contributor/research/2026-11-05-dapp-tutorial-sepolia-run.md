# The dapp tutorial on Sepolia, 2026-11-05

Audience: contributors and reviewers of the tutorial
[Deploy a contract from a dapp and verify it](../../user/tutorials/deploy-and-verify-from-a-dapp.md)
and its example, `examples/dapp/`.

Question: does the tutorial's code reach a verified contract on a public testnet?

## How the run was made

- Date: 2026-11-05, 09:04:48 UTC. Node.js 24.21.0, viem 2.57.8, the example's build files
  (Foundry 1.8.1, solc `0.8.24+commit.e11b9ed9`, optimizer off).
- Script: `examples/dapp/scripts/sepolia-run.ts`. It imports the example's modules and calls them
  in the page's order: `deployGreeter`, `loadVerifyInput`, `verifyOnSourcify`,
  `resumeVerification` and `verifyOnEtherscan`. It starts the example's server on loopback with an
  Etherscan key, and the page's `fetch` sends `/contracts/...` and `/api/verify` to it.
- Wallet: not a browser extension. `window.ethereum` was an EIP-1193 provider that the script
  builds: it signs the creation with a funded testnet key held in the process environment and
  sends every other request to a Sepolia JSON-RPC node. It refuses any chain but 11155111 and any
  transaction that is not a contract creation. The steps that need a person (the wallet's
  confirmation dialog, the button, a real page reload) were not exercised.
- Reload: after `verifyOnSourcify` returned, the script put the handle back under
  `greeter-verification` in the page's storage and called `resumeVerification`, as a page does
  after a reload while the job runs. The job had ended, so `checkStatus()` read its final state.

## Results

| Step                                    | Outcome                                                                                                                                                                                                                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deploy (step 2)                         | `Greeter` at `0x5cf404b9b913096c053753ced94fe8b44a87afe0`, transaction `0x2530402e044e2db5a680cb4bd45625218a171c71ef914f82a9b7fbc37df5ffb4`, from `0x9d087fC03ae39b088326b67fA3C788236645b717`, in block 12068469. Gas used 1,418,303; cost 0.000000001443832454 ETH |
| Load the input (step 3)                 | `src/Greeter.sol:Greeter`, compiled with `0.8.24+commit.e11b9ed9`                                                                                                                                                                                                    |
| Sourcify (step 4)                       | Submitted, handle `ev1:sourcify:11155111:0x5cf404b9b913096c053753ced94fe8b44a87afe0:fedf6a78-8ef0-4f17-aebf-a2facecfac68`, then `verified (exact)` with the link to the Sourcify repository                                                                          |
| Resume with `checkStatus()` (step 5)    | `verified`, with no second submission                                                                                                                                                                                                                                |
| Etherscan, page path over HTTP (step 7) | Failed: `POST https://api.etherscan.io/v2/api?... answered with a redirect, which is not followed (status 200)`. See [The page path to Etherscan](#the-page-path-to-etherscan)                                                                                       |
| Etherscan, server routes in the process | `verified (etherscan-v2)`: the same handler, created by the example's server code with the same options, called in the process as the first block of step 7 does                                                                                                     |

An independent check right after the run, with Node.js 24.21.0 on 2026-11-05: Sourcify's
`GET /v2/contract/11155111/0x5cf4…afe0` answered `match`, `creationMatch` and `runtimeMatch` as
`exact_match`, and Etherscan's `getsourcecode` for the address answered `ContractName` `Greeter`
and `CompilerVersion` `v0.8.24+commit.e11b9ed9` with the source.

A first run, at 09:03:17 UTC the same day, deployed `0xd2f8522cbbfa9145222273eba5eb991babbf30ba`
(cost 0.000000001445250757 ETH) and gave the same Sourcify, resume and page-path results; the
script then had no in-process Etherscan step. The same independent check found that address
verified on Etherscan too, although this project sent Etherscan no submit for it. One possible
cause is Sourcify's own forwarding: Sourcify's job answers list `externalVerifications`, with an
`etherscan` entry (`packages/explorer-verify/test/fixtures/sourcify/2026-11-02-job-exact-match.json`).
This is not confirmed.

The two runs spent 0.000000002889083211 ETH of Sepolia ETH in all.

## The page path to Etherscan

The tutorial's `viaHandler` (step 7, second block) and the guide's `handlerFetch` send each
Etherscan request to `/api/verify` on the dapp's origin. With a real `fetch`, in a browser or in
Node, the response's `url` is the dapp's URL. The library's redirect check,
`isRedirect` in `packages/explorer-verify/src/http/fetch.ts` (line 738 on `main` at `9e12c51`,
unchanged since the run's base `56c5cf4`), treats a
response whose `url` has another origin than the request it sent as a redirect, and ends the call
with that error before it reads the body. The handler's answer was a 200 with Etherscan's JSON.

The tests did not see this: their fake `fetch` returns a `new Response(...)`, whose `url` is
empty, and the check skips an empty `url`. `examples/test/dapp-verify-http.test.ts` holds a test
that runs the page path over loopback HTTP. It failed with this error until the fix below.

## Links

- Contract on Etherscan: https://sepolia.etherscan.io/address/0x5cf404b9b913096c053753ced94fe8b44a87afe0#code
- Creation transaction: https://sepolia.etherscan.io/tx/0x2530402e044e2db5a680cb4bd45625218a171c71ef914f82a9b7fbc37df5ffb4
- Block 12068469, read from the receipt (`eth_getTransactionReceipt`) on 2026-11-05:
  https://sepolia.etherscan.io/block/12068469
- Contract on Sourcify: https://repo.sourcify.dev/11155111/0x5cf404b9b913096c053753ced94fe8b44a87afe0

## Sources

- Sourcify v2 lookup, read 2026-11-05:
  https://sourcify.dev/server/v2/contract/11155111/0x5cf404b9b913096c053753ced94fe8b44a87afe0
- Etherscan v2 `getsourcecode`, read 2026-11-05 with a key: https://docs.etherscan.io/api-reference/endpoint/getsourcecode
- EIP-1193, the provider interface the script implements, read 2026-11-05:
  https://eips.ethereum.org/EIPS/eip-1193
- The Fetch standard's `response.url`, read 2026-11-05: https://fetch.spec.whatwg.org/#dom-response-url

## Corrections

- 2026-11-05: the fix for the page path to Etherscan,
  [issue #183](https://github.com/aelmanaa/explorer-verify/issues/183), merged on `main` as
  `c3da921` (decision 0035; evidence in
  [2026-11-05-fetch-redirect-signals.md](2026-11-05-fetch-redirect-signals.md)). With it, the
  loopback test, now in `examples/test/dapp-verify-http.test.ts`, passes and is no longer marked
  `todo`. The fix is not yet in a published release. The Sepolia run above predates it and was not repeated.
