# Releasing

Audience: the maintainer. Nothing is published yet; `packages/explorer-verify` is `"private": true`
until the first release (roadmap M4).

## Plan

Copy the [hardhat-kms](https://github.com/aelmanaa/hardhat-kms) release pipeline when M4 starts:

1. Changesets accumulate on `main`. `pnpm run version-packages` (in a release pull request) bumps
   versions, writes changelogs and sets the version line of every user page. Changesets before
   0.1.0 are patch; the first release pull request sets the version to 0.1.0.
2. The maintainer pushes a GPG-signed `vX.Y.Z` tag.
3. A release workflow packs the tarballs, checks them, and publishes with
   `npm publish --provenance` through npm trusted publishing (OIDC, no token), behind an approval
   environment, first to the `beta` dist-tag. The workflow runs `pnpm run pkg:check`, which builds
   the package, before `npm publish`: the package has no `prepack` script, so the build copies the
   user docs and `llms.txt` into it.
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
