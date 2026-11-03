# 2026-11-03: publish 0.1.0 or 1.0.0 first

Audience: whoever changes the release process or the changeset rules. Backs
[decision 0017](../decisions/0017-first-release-is-0-1-0.md).

## What SemVer says

- "Major version zero (0.y.z) is for initial development. Anything MAY change at any time." (item 4) and "Version 1.0.0 defines the public API." (item 5). Read on semver.org on 2026-11-03.
- The SemVer FAQ suggests starting at 0.1.0 and raising the minor for each release, and says that
  software used in production "should probably already be 1.0.0". Read on semver.org on
  2026-11-03.

## What npm's ranges do with 0.x

The node-semver README, read on 2026-11-03: a caret range "allows patch and minor updates for
versions `1.0.0` and above, patch updates for versions `0.X >=0.1.0`, and _no_ updates for versions
`0.0.X`". So `^0.2.3` is `>=0.2.3 <0.3.0-0`, while `^1.2.3` is `>=1.2.3 <2.0.0-0`. A project that
depends on `^0.1.0` does not get 0.2.0 until it changes its range.

## What changesets does

Observed with `@changesets/cli` 3.0.3 (`@changesets/config` 4.0.1) on 2026-11-03, in a scratch
workspace with two packages, `explorer-verify` and `@explorer-verify/cli`, in one `fixed` group:

- A `major` changeset for `explorer-verify` at 0.1.0 bumped both packages to 1.0.0. On 0.x a
  `major` changeset therefore means 1.0.0, not the next minor.
- With both packages `"private": true`, `changeset version` changed neither version and kept the
  changeset. `privatePackages.version` defaults to `false` in `@changesets/config` 4.0.1, so a
  private package is not versioned unless the config opts in.
- A `fixed` entry that matches no package, such as `@explorer-verify/*` before any scoped package
  exists, is reported as a config warning; `changeset status` still exits 0.

## A prior release of the same maintainer

`npm view hardhat-kms time`, run on 2026-11-03: 0.9.0 on 2026-10-07, 0.10.0 on 2026-10-08, 0.10.1
on 2026-10-10 and 1.0.0 on 2026-10-11. The project's releasing page says 1.0.0 followed an
acceptance test against 0.10.1 installed from the registry.

## npm trusted publishing and a new package

The `npm trust` page, read on 2026-11-03: "The package you're configuring must already exist on the
npm registry." A new package name therefore needs one publish by hand before a workflow can publish
it through a trusted publisher.

## Sources

- https://semver.org/ (SemVer 2.0.0, items 4 and 5, and the FAQ), read 2026-11-03.
- https://github.com/npm/node-semver#caret-ranges-123-025-004, read 2026-11-03.
- https://docs.npmjs.com/cli/v11/commands/npm-trust, read 2026-11-03.
- https://www.npmjs.com/package/hardhat-kms?activeTab=versions, with `npm view hardhat-kms time`
  (npm 11.19.0), 2026-11-03.
- https://github.com/aelmanaa/hardhat-kms/blob/main/docs/contributor/releasing.md, read
  2026-11-03.
- `changeset version` and `changeset status` with `@changesets/cli` 3.0.3 in a scratch workspace,
  2026-11-03.
