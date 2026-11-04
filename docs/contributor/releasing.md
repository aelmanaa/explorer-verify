# Releasing

Audience: the maintainer. Nothing is published yet; `packages/explorer-verify` is `"private": true`
until the pull request that prepares 0.1.0. [Decision 0017](decisions/0017-first-release-is-0-1-0.md)
sets the version rules.

The model in one sentence: every version is built from a maintainer-signed `vX.Y.Z` tag on `main`,
published to npm under the `beta` dist-tag with provenance, checked from the registry, and then
promoted by moving `latest` to that exact version. Nothing is rebuilt between `beta` and `latest`:
same tarballs, same provenance.

## The pieces

| Piece                                | What it does                                                                                                                                                                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/release-pr.yml`   | On each push to `main`, opens or updates the Version Packages pull request with `pnpm run version-packages`. Does nothing, and passes, while every package is private. Publishes nothing                                                |
| `.github/workflows/release.yml`      | On a `vX.Y.Z` tag: checks the tag, builds, checks and packs, then publishes to `beta` behind the `npm-publish` environment                                                                                                              |
| `.github/workflows/promote.yml`      | Dispatched from `main` with a version: checks it on npm, deploys its docs, then moves `latest` to it behind the `npm-latest` environment. Never publishes                                                                               |
| `.github/release-keys/`              | The trust root: the public key of each maintainer who may sign a release tag ([README](../../.github/release-keys/README.md))                                                                                                           |
| `.github/ruleset-protect-tags.json`  | The tag ruleset: only a repository admin creates, moves or deletes a `v*` tag                                                                                                                                                           |
| `scripts/release-packages.ts`        | Lists the published packages at a commit: every `packages/*/package.json` without `"private": true`, the core first. With `--any`, prints `true` or `false`                                                                             |
| `scripts/verify-release-tag.ts`      | Checks the tag signature, that the tag names the version of every published package, that it is a plain `X.Y.Z`, and that the commit is on main                                                                                         |
| `scripts/check-tarballs.ts`          | Checks each tarball's SHA-256, name, version and `gitHead` against the pack job's record, and that no dependency range starts with `workspace:` or `catalog:`                                                                           |
| `scripts/check-registry-release.ts`  | Before a promote: the version is on npm, on `beta`, from the tagged commit, not below `latest`, with a provenance statement that names this repository, `release.yml`, the tag and the commit                                           |
| `scripts/check-changesets.ts`        | Run by `pnpm run check`: refuses a `major` changeset during 0.x                                                                                                                                                                         |
| `scripts/check-release-workflows.ts` | Run by `pnpm run check`: fails when the job that moves `latest` does not need the docs job or runs outside `npm-latest`, when another job can deploy to Pages, or when the Version Packages job runs without the published-package gate |

The packages share one version through the changesets `fixed` group
`["explorer-verify", "@explorer-verify/*"]`. A scoped package joins the release when its manifest
drops `"private": true`; the workflows read the list from `scripts/release-packages.ts` only.

Every job runs only in `aelmanaa/explorer-verify`, never in a fork. Neither workflow runs on a pull
request. `release.yml` accepts only a tag whose commit is on `main`, and `promote.yml` runs only when
dispatched from `main`. Actions are pinned by commit SHA. No job reads an npm token: publishing and
the dist-tag move use npm trusted publishing over OIDC (R-SEC-4).

## One-time setup

The maintainer does each of these once, before the first release. Agents do none of them.

1. A token for the Version Packages pull request. See
   [Version Packages pull request token](#version-packages-pull-request-token).
2. Environment `npm-publish` (Settings, Environments): required reviewer `aelmanaa`, "Prevent
   self-review" off (the maintainer approves their own release), deployment branches and tags set
   to "Selected branches and tags" with the one tag rule `v*`. No secrets.
3. Environment `npm-latest`: required reviewer `aelmanaa`, "Prevent self-review" off, deployment
   branches set to the one branch rule `main`. No secrets.
4. Tag ruleset: import `.github/ruleset-protect-tags.json` (Settings, Rules, Rulesets, Import a
   ruleset, or
   `gh api -X POST repos/aelmanaa/explorer-verify/rulesets --input .github/ruleset-protect-tags.json`).
   It restricts creating, updating and deleting `refs/tags/v*` to the repository admin role.
5. Branch ruleset `main`: keep it as it is (pull request required, squash only, required checks).
   The release tag goes on a commit of `main`, so the tag is only as trustworthy as that branch.
6. npm, for each package name, after its first publish ([First publish](#first-publish)). Create
   the two environments of steps 2 and 3 first, with their reviewers: a trusted publisher names an
   environment, and GitHub creates an environment a job names but that does not exist yet, with no
   protection. Since 2026-09-03 npm enables neither publish nor dist-tag management on a new
   trusted publisher, so set each permission by hand:
   - trusted publisher for the release: GitHub Actions, owner `aelmanaa`, repository
     `explorer-verify`, workflow `release.yml`, environment `npm-publish`. Allow `npm publish`.
     Leave dist-tag management off. Stage publish stays allowed;
   - trusted publisher for the promote: workflow `promote.yml`, environment `npm-latest`. Allow
     dist-tag management (`npm dist-tag`) only. Leave publish off, so the promote workflow can never
     publish a tarball. Stage publish stays allowed. Keep the environment field set: the `docs`
     job of the same run also holds an OIDC token, for Pages, before any approval. With the
     environment named, npm accepts only the token of a job in `npm-latest`, which runs after the
     maintainer approves it;
   - set "Publishing access" to require two-factor authentication and disallow tokens.

A configuration that no run has used yet shows as "not yet validated" on npmjs.com. Check both
configurations, and their permissions, on the day of the tag.

### Version Packages pull request token

While every `packages/*/package.json` is private, `release-pr.yml` opens no pull request. Its
`packages` job runs `node scripts/release-packages.ts --any`, which prints `false`, so the
`version-pr` job is skipped and the run passes. `scripts/check-release-workflows.ts` fails when the
`version-pr` job loses that gate.

Once the pull request that prepares 0.1.0 removes `"private": true`, the `version-pr` job runs. It
must not open the pull request with the default `GITHUB_TOKEN`. GitHub starts no new workflow run
for an event that `GITHUB_TOKEN` causes, except `workflow_dispatch` and `repository_dispatch`, and
recommends a GitHub App installation token or a personal access token instead
([Triggering a workflow from a workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow),
read 2026-11-04). With `GITHUB_TOKEN`, the six required checks would never run on the pull request,
and it could not merge.

Before the first release, the maintainer:

1. Creates a GitHub App owned by `aelmanaa`, installed on `explorer-verify` only, with these
   repository permissions and no others: Contents read and write (pushes
   `changeset-release/main`), Pull requests read and write (opens and updates the pull request),
   and Metadata read-only (GitHub sets it on every App). No webhook, no account permissions.
   A fine-grained personal access token limited to `explorer-verify`, with the same three
   permissions and an expiry date, also works; an App token is short-lived and is not tied to a
   person.
2. Stores the App's client ID as the repository variable `RELEASE_APP_CLIENT_ID` and its private
   key as the repository secret `RELEASE_APP_PRIVATE_KEY` (or the fine-grained token as the secret
   `RELEASE_PR_TOKEN`).
3. In the pull request that prepares 0.1.0, adds a step to the `version-pr` job before
   changesets/action that creates the token (`actions/create-github-app-token`, pinned by commit
   SHA), and passes it to changesets/action as its `github-token` input. `GITHUB_TOKEN` in the
   step's `env` stays as it is: `@changesets/changelog-github` only reads with it.
4. Leaves "Allow GitHub Actions to create and approve pull requests" (Settings, Actions, General)
   off. That setting applies to `GITHUB_TOKEN` only
   ([Managing GitHub Actions settings for a repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository),
   read 2026-11-04), and the workflow no longer needs it.

### Who can change what a release runs

The release workflow reads `.github/release-keys/`, its own file and the release scripts from the
tagged commit. Whoever can change those files on `main` can change what the next release trusts.
Today one maintainer reviews every change (`.github/CODEOWNERS`). `.github/CODEOWNERS` names
`.github/`, the release scripts, `scripts/check-tarballs.ts` and `scripts/check-packed-files.ts`
explicitly. As soon as a second person has write access, turn on "Require review from Code Owners"
in the `main` ruleset, so a change to those paths cannot merge without the maintainer's review.

## First publish

Two conditions come before the first `v0.1.0` tag:

- The docs site has landed, and the promote deploys it before `latest` moves. Before the site,
  `docsUrl` pointed at `main` on GitHub, which always resolves, so nothing could catch a broken
  link later. `check-packed-files.ts --release` in the pack job fails while the built errors module
  contains `blob/main`.
- npm configures a trusted publisher only for a package that exists. For each new package name the
  maintainer publishes a placeholder once by hand, then configures the trusted publishers above:

  ```sh
  # In an empty folder with only a package.json ({"name": "explorer-verify", "version": "0.0.0"})
  # and a README that says the name is reserved.
  npm publish --access public
  npm deprecate explorer-verify@0.0.0 "Placeholder. Install 0.1.0 or later."
  ```

  The placeholder sits on `latest` until the first promote moves `latest` to 0.1.0. The registry
  check accepts it, because 0.0.0 is below the version. The scoped packages follow the same steps
  when their packages exist.

The pull request that prepares 0.1.0 removes `"private": true` from each package that ships, and
adds one `minor` changeset, so the version step moves 0.0.0 to 0.1.0. changesets does not version a
private package, so `private` has to go first.

## Cut a release

1. Changesets accumulate on `main`. `release-pr.yml` keeps the Version Packages pull request
   current: `pnpm run version-packages` bumps the versions, writes the changelogs, adds each new
   error code to `packages/explorer-verify/released-error-codes.json` with the new version
   (`scripts/record-released-codes.ts`), and sets the version line of every user page. A listed
   code keeps its page in `docs/user/reference/errors/` for good (R-AX-10, decision 0015).
2. Wait for the pull request's checks (they start because the App or fine-grained token opened it),
   review the versions and changelogs, and squash-merge it.
3. Wait for CI on `main` to pass on the merge commit. Then sign and push the tag on that commit:

   ```sh
   git fetch origin main
   git tag -s v0.1.0 -m v0.1.0 <merge commit>
   node scripts/verify-release-tag.ts v0.1.0
   git push origin v0.1.0
   ```

4. `release.yml` runs:
   - `verify-tag` checks the signature against `.github/release-keys/`, that the tag names the
     version of every published package, that the version is a plain `X.Y.Z`, that the commit is on
     `main`, and that the commit has a passing `ci.yml` run;
   - `pack` installs from the lockfile, runs `pnpm run pkg:check` (build, publint,
     are-the-types-wrong, the packed-files check, knip) and
     `node scripts/check-packed-files.ts --release`, then packs each published package with
     `pnpm pack` and `gitHead` set to the tagged commit, and runs publint and are-the-types-wrong
     again on each tarball, so the checked files are the published files;
   - `publish` waits for the approval of `npm-publish`.
5. Read the run summary (tarball sums, file lists, release notes), then approve `npm-publish`. The
   job checks the tarballs against the sums the pack job recorded, checks that every package exists
   on npm, and runs `npm publish <tarball> --tag beta --access public --provenance` for each. A
   version already on npm is skipped, so a re-run after a partial publish publishes the rest.
   `github-release` then creates a draft GitHub Release with the prerelease flag.

Rehearse with a dry run: dispatch `release.yml` with `tag` set to an existing tag, or `none` to pack
the dispatched branch without the tag checks. It runs `verify-tag` (without the CI check), `pack`
and `npm publish --dry-run`, and writes the commands a release would run to the summary. It uses no
environment, no OIDC token and no secret. Until the pull request that prepares 0.1.0, a dry run of
`main` stops in `pack`: no package is published yet, and `--release` fails before the version step
has run, as it should.

The packages are packed with `pnpm pack` and published as tarballs; `npm publish` never runs on a
workspace folder. The build helpers depend on the core through `"explorer-verify": "workspace:^"`.
`pnpm pack` rewrites `workspace:` and `catalog:` ranges to real versions, while `npm pack` and
`npm publish` on a folder keep them, and installing such a package fails with
`EUNSUPPORTEDPROTOCOL`. `scripts/check-tarballs.ts` fails on a packed manifest that still holds
one, in the pack job and again in the publish job.

## Promote to latest

1. Install the version from npm and try it (`npm install explorer-verify@beta`).
2. Dispatch `promote.yml` from `main` with the version:

   ```sh
   gh workflow run promote.yml --ref main -f version=0.1.0
   ```

3. `verify` runs `scripts/verify-release-tag.ts` on tag `v<version>` again, with the keys and the
   script on `main`, then `scripts/check-registry-release.ts`: every package of the tagged commit
   has the version on npm, `beta` points at it, its `gitHead` is the tagged commit, and `latest` is
   not above it. It also fetches each package's SLSA provenance statement and checks that it names
   the package and version, the repository `aelmanaa/explorer-verify`, the workflow
   `.github/workflows/release.yml`, the ref `refs/tags/v<version>` and the tagged commit. The npm
   registry checked the statement's Sigstore signature when it accepted the publish; the script does
   not check it again.
4. `docs` calls `docs.yml` with the version ([Docs deploy](#docs-deploy)). It builds the site from
   the tag, deploys it to GitHub Pages and checks every `docsUrl` over HTTPS (decision 0015).
   `latest` needs it: a failed build, deploy or smoke check ends the run before the approval, and
   `latest` does not move. `scripts/check-release-workflows.ts`, part of `pnpm run check`, fails
   when the `latest` job stops listing `docs` in `needs` (R-AX-10).
5. Approve `npm-latest`. The `latest` job runs the registry check again, then
   `npm dist-tag add <name>@<version> latest` for each package not on it yet, then publishes the
   GitHub Release and marks it latest. If npm refuses the move over OIDC, run the same
   `npm dist-tag add` by hand with 2FA and re-run the workflow; packages already on `latest` are
   skipped.

The order of a release is: signed tag, `beta` publish (approved), promote dispatch, docs deploy,
smoke check, `latest` (approved). The `beta` publish does not deploy the docs, so the site keeps
showing the version on `latest` until a promote of the next version reaches its docs job.

The docs deploy runs before the approval of `npm-latest`. If you decline that approval, or the
`latest` job fails for good, the site shows the docs of a version that is not on `latest`. Restore
them by dispatching the docs deploy with the version on `latest`:

```sh
gh workflow run docs.yml --ref main -f version=<version on latest>
```

For the first release, `latest` holds only the 0.0.0 placeholder, which has no tag and no docs to
restore. Leave the 0.1.0 docs in place and re-run the promote when ready; the site had nothing
before it.

`docs.yml` runs one deploy at a time (concurrency group `pages`), and GitHub keeps one pending run
per group. A manual dispatch of `docs.yml` while the promote's docs call waits replaces that call:
GitHub cancels it, the `docs` job fails, and `latest` is skipped. Wait for the manual deploy, then
re-run the promote.

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

## When something fails

- Before `publish`: nothing reached npm, so the tag can move. Fix through a pull request, delete
  the remote tag (`git push origin :refs/tags/vX.Y.Z`; the tag ruleset lets only an admin do it),
  sign a new tag on the new commit, verify, push.
- During `publish`: some packages are on npm and some are not. Re-run the failed job; it skips the
  versions already published. Never move or delete the tag once a package is on npm, and never
  republish a version: npm refuses a version that existed before.
- During `docs`: nothing moved on npm. A failed build or smoke check from a problem in the tagged
  docs needs a patch release, because the deploy always builds from the tag. A failure outside the
  docs, such as a Pages outage, needs a re-run of the promote. If the deploy job succeeded and the
  smoke check failed, the site now holds the new docs: re-deploy the version on `latest` by hand
  (see [Promote to latest](#promote-to-latest)) unless you re-run the promote at once.
- During `latest`: re-run the workflow; it moves only the packages not on `latest` yet.

## 0.x rules

From decision 0017:

- A breaking change is a `minor` changeset whose text starts with "Breaking:". A `patch` changeset
  adds or fixes without breaking.
- `major` changesets are not used during 0.x: changesets would turn one into 1.0.0.
  `scripts/check-changesets.ts`, part of `pnpm run check`, refuses one while the core version
  starts with `0.`.
- The envelope's and the events' `schemaVersion` rules (R-AX-5, R-DX-6) apply from 0.1.0, whatever
  the package version.

## Conditions for 1.0

[Decision 0017](decisions/0017-first-release-is-0-1-0.md) lists them: an outside tool shipped with
explorer-verify, at least one minor release after 0.1.0 without a breaking change, the CLI
contract tests and the agent evaluation passing against the package from npm, and the open live
questions answered or moved out of scope.

When they hold, the 1.0.0 release pull request adds `.changeset/release-1-0-0.md` with a `major`
bump for `explorer-verify`, the one file `check-changesets.ts` accepts a `major` in, and cites each
condition with its evidence. It changes no code.

## Later: staged publishing

npm can hold a publish as a stage that a maintainer approves on npmjs.com with a second 2FA step
before anyone can install it (`npm stage publish`). The sister project hardhat-kms publishes this
way. The release workflow could switch to it later: the publish job would run
`npm stage publish <tarball> --tag beta --provenance`, the trusted publisher for `release.yml`
would allow stage publish only, and each release would need one more approval, on npmjs.com.

## Rules

- Agents never tag, publish, approve environments, dispatch `promote.yml` or move dist-tags. A dry
  run of `release.yml` publishes nothing.
- Remove `"private": true` only in the pull request that prepares the first release of a package.
- The npm pin (`npm@12.2.0`) is in `release.yml` and `promote.yml`; raise it in both together.
