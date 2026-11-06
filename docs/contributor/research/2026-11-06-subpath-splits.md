# How viem, ethers and the AWS SDK split their entry points

Date: 2026-11-06. Issue: [#219](https://github.com/aelmanaa/explorer-verify/issues/219).

Question: do libraries in the same space keep small names on the main entry when they also offer
them from a subpath, and do they mark their packages free of side effects?

## viem 2.57.16

Read from the published package on 2026-11-06:
<https://unpkg.com/viem@2.57.16/package.json>, <https://unpkg.com/viem@2.57.16/index.ts> and
<https://unpkg.com/viem@2.57.16/utils/index.ts>.

- `package.json` sets `"sideEffects": false` and lists 27 keys under `exports`, among them
  `./utils`, `./accounts`, `./actions`, `./chains` and `./package.json`.
- `index.ts` exports utilities such as `isAddress`, `isAddressEqual`, `formatEther` and
  `parseEther`, and `BaseError` from `./errors/base.js`.
- `utils/index.ts` exports the same `isAddress` and `formatEther` from the same modules. A name is
  on the main entry and on its subpath at once.

## ethers 6.17.0

Read on 2026-11-06: <https://unpkg.com/ethers@6.17.0/package.json> and
<https://unpkg.com/ethers@6.17.0/lib.esm/ethers.js>.

- `package.json` sets `"sideEffects": false` and lists 12 keys under `exports`: `.`, `./abi`,
  `./address`, `./constants`, `./contract`, `./crypto`, `./hash`, `./providers`, `./transaction`,
  `./utils`, `./wallet` and `./wordlists`.
- `lib.esm/ethers.js` re-exports each of those areas, for example `getAddress` and `isAddress` from
  `./address/index.js`. As in viem, every subpath name is on the main entry too.

## AWS SDK for JavaScript v3, `@aws-sdk/client-s3` 3.1163.0

Read on 2026-11-06: <https://unpkg.com/@aws-sdk/client-s3@3.1163.0/package.json>.

- One package per service rather than subpaths of one package. The package has no `exports` map;
  it sets `main`, `module` and `types`, and `"sideEffects": false`.
- Its `browser` field swaps `./dist-es/runtimeConfig` for `./dist-es/runtimeConfig.browser`.

## What this means for explorer-verify

- Keeping `formatHandle`, `ExplorerVerifyError`, `ERROR_CODES` and `BACKEND_NAMES` on
  `explorer-verify` while also exporting them from small subpaths matches viem and ethers.
- All three set `"sideEffects": false`, as explorer-verify already does.
- None of the three was bundled here; the sizes in decision 0055 come from
  `scripts/check-names.ts` on explorer-verify alone.

## Sources

All read on 2026-11-06.

- <https://unpkg.com/viem@2.57.16/package.json>
- <https://unpkg.com/viem@2.57.16/index.ts>
- <https://unpkg.com/viem@2.57.16/utils/index.ts>
- <https://unpkg.com/ethers@6.17.0/package.json>
- <https://unpkg.com/ethers@6.17.0/lib.esm/ethers.js>
- <https://unpkg.com/@aws-sdk/client-s3@3.1163.0/package.json>
