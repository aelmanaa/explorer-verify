# Releasing

Audience: the maintainer. Nothing is published yet; `packages/explorer-verify` is `"private": true`
until the first release (roadmap M4).

## Plan

Copy the [hardhat-kms](https://github.com/aelmanaa/hardhat-kms) release pipeline when M4 starts:

1. Changesets accumulate on `main`. `pnpm run version-packages` (in a release pull request) bumps
   versions, writes changelogs and sets the version line of every user page. Changesets before
   0.1.0 are patch; the first release pull request sets the version to 0.1.0.
   The version step also adds each code in `ERROR_CODES` that is not listed yet to
   `packages/explorer-verify/released-error-codes.json`, with the new version
   (`scripts/record-released-codes.ts`). A listed code keeps its page in
   `docs/user/reference/errors/` for good, and a unit test fails when one has no page (R-AX-10,
   decision 0015).
2. The maintainer pushes a GPG-signed `vX.Y.Z` tag.
3. A release workflow packs the tarballs, checks them, and publishes with
   `npm publish --provenance` through npm trusted publishing (OIDC, no token), behind an approval
   environment, first to the `beta` dist-tag. The workflow runs `pnpm run pkg:check`, which builds
   the package, before `npm publish`: the package has no `prepack` script, so the build copies the
   user docs and `llms.txt` into it. It also runs `node scripts/check-packed-files.ts --release`,
   which fails when a code of the built package is missing from the released-codes list, or when
   `docsUrl` still points at `blob/main` on GitHub instead of the docs site. Pull request CI does
   not pass `--release`: a new code is normal there until the version step records it. Adding the
   step to the workflow is part of the release workflow issue (#86).
4. A promote workflow moves `latest` to the same tarballs after a check.

## First publish

npm needs a package to exist before a trusted publisher can be configured for it. For each new
package name, the maintainer publishes once by hand (a `0.0.0` placeholder or the first release),
then configures the trusted publisher on npmjs.com and removes any token.

Before that: create the npm organisation `explorer-verify` so the `@explorer-verify/*` scope is
held.

## Rules

- Agents never tag, publish, approve environments or move dist-tags.
- Remove `"private": true` only in the pull request that prepares the first release.
