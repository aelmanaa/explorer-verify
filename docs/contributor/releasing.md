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
4. A promote workflow moves `latest` to the same tarballs after a check. It first calls the docs
   deploy below and waits for it, so every `docsUrl` of the version on `latest` is live
   (decision 0015). Wiring the call is part of the gating issue (#87).

## Docs deploy

`.github/workflows/docs.yml` deploys the docs site, <https://aelmanaa.github.io/explorer-verify/>,
for one version (R-AX-17, decision 0015). Before 1.0 the site holds the version on npm `latest`
only.

- **Trigger.** The promote workflow calls it (`workflow_call`), or the maintainer dispatches it by
  hand (`workflow_dispatch`) to re-deploy the tagged docs of the version on `latest`, for example
  after a failed deploy. The deploy always builds from the tag, so a docs fix ships in a patch
  release. Both ways start from `main`. The first step fails the run, rather than skipping it,
  unless the event is a dispatch on `main`; a call from the promote run counts as one, because a
  called workflow sees the caller's event and ref. It never runs on a pull request, a push or a tag
  push.
- **Input.** `version`, without the `v`. The workflow checks out the tag `v<version>`, never a
  branch, and fails when the package version at that tag differs.
- **Jobs.** `build` runs the core build, `site:build` and `site:check` (test 3), then uploads the
  site. `deploy` is the only job with `pages: write` and `id-token: write`, and runs in the
  `github-pages` environment. `smoke` runs `scripts/smoke-site.ts` (test 4): each code page, its
  `.md` copy, `/llms.txt` and every page it lists must return 200 over HTTPS within 10 seconds,
  and `/llms.txt` must name the version at the tag. A failed job fails the
  workflow, so a promote that waits on it stops before it moves `latest`.
- **Environment.** The `github-pages` environment allows deployments from `main` only. A caller
  must grant `pages: write` and `id-token: write` to the job that calls the workflow.
- **Rules.** No secret is needed. The site holds `docs/user/` only. Agents never trigger, approve or
  re-run a deploy.

To set up Pages once, the maintainer:

1. Opens Settings, Pages, and under "Build and deployment" sets Source to "GitHub Actions".
2. Opens Settings, Environments, `github-pages` (GitHub creates it with the first step; create it
   if it is missing). Under "Deployment branches and tags", chooses "Selected branches and tags",
   removes any other rule, and adds the branch rule `main`.
3. Leaves "Enforce HTTPS" on (Settings, Pages). It is on by default for `github.io` addresses.

## First publish

npm needs a package to exist before a trusted publisher can be configured for it. For each new
package name, the maintainer publishes once by hand (a `0.0.0` placeholder or the first release),
then configures the trusted publisher on npmjs.com and removes any token.

Before that: create the npm organisation `explorer-verify` so the `@explorer-verify/*` scope is
held.

## Rules

- Agents never tag, publish, approve environments or move dist-tags.
- Remove `"private": true` only in the pull request that prepares the first release.
