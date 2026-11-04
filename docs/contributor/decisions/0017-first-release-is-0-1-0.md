# 0017: The first release is 0.1.0; 1.0 follows on stated conditions

Status: Accepted (2026-11-03).

Research: [research/2026-11-03-versioning-0x-or-1-0.md](../research/2026-11-03-versioning-0x-or-1-0.md).

## Context

Nothing is published yet. M4 ends with the first publish of four packages: `explorer-verify`,
`@explorer-verify/cli`, `@explorer-verify/foundry` and `@explorer-verify/hardhat` (decision 0008).
`releasing.md` already says the first release pull request sets 0.1.0, but no record says why, or
when 1.0 comes.

The choice changes more than a number:

- SemVer 2.0.0 treats 0.y.z as initial development, where "Anything MAY change at any time", and
  says 1.0.0 "defines the public API".
- npm's caret range treats 0.x differently: `^0.2.3` accepts only `0.2.x`, while `^1.2.3` accepts
  every `1.x` (node-semver README). A tool that depends on `^0.1.0` does not get 0.2.0 without a
  change on its side.
- Decision 0015 keys the docs on 1.0: before it, one site for the latest release and an
  unversioned `docsUrl`; from it, one build per major and a `docsUrl` with `/v<major>/`.
- The public types are marked experimental until 1.0 (`types.ts`), and R-AX-13 is written against
  0.1.0.

The maintainer's other library, hardhat-kms, published 0.9.0 first, fixed what the first registry
installs found in 0.10.0 and 0.10.1, and published 1.0.0 four days after 0.9.0, when an acceptance
test passed against the published package.

## Decision

The first publish is 0.1.0, at the end of M4. The packages stay on 0.x until every condition below
holds. Then a release pull request publishes 1.0.0 with no code change from the last 0.x version
that met them.

Conditions for 1.0:

1. At least one outside tool has integrated explorer-verify and shipped it to its users. Two is the
   target.
2. At least one minor release, two as the target, has shipped after 0.1.0 without a breaking change
   to a public export, the CLI contract, the envelope, the events or the handle format.
3. The CLI contract harness and the recorded agent evaluation (R-AX-13, #7) pass against the
   published package installed from npm, not the checkout.
4. The open live questions in requirements.md that touch behaviour are answered: Blockscout's hosted
   API terms, Sourcify's limits for high volume, Routescan's rate-limit answer and the lifetime of
   its job ids, and Etherscan on zkSync Era. A question that stays open may instead be moved out of
   1.0's scope in requirements.md, with the reason.

Rules during 0.x:

- A breaking change is a `minor` changeset, and its changelog entry starts with "Breaking:". A
  `patch` changeset adds or fixes without breaking.
- `major` changesets are not used during 0.x: changesets turns a `major` on 0.x into 1.0.0. The
  1.0.0 release pull request is the only place one appears.
- The four packages share one version through a changesets `fixed` group, as hardhat-kms does, so
  the CLI and the build helpers always name the core version they were tested with.
- The envelope's and the events' `schemaVersion` rules (R-AX-5, R-DX-6) apply from 0.1.0. A change
  that breaks a reader of the JSON output raises `schemaVersion`, whatever the package version.
- Docs follow decision 0015's "before 1.0" rules: the site shows `latest` only, `docsUrl` has no
  version segment, and the stub rule keeps every released code's page.

## Alternatives considered

### Publish 1.0.0 first

The M4 surface would be declared stable on the first day: callers get minor updates through `^1`,
and SemVer's FAQ says software used in production "should probably already be 1.0.0".

Rejected: the first outside integrations, the first live runs on Blockscout and the first agent
evaluation against a published package have not happened. Any of them can show a needed change to an
export, the envelope or the handle. Under 1.x each such change would be a new major, with a
`/v2/` docs build, a second `docsUrl` scheme to keep alive (decision 0015), and a separate branch
for majors. The maintainer prefers to find those changes during 0.x.

What 1.0.0-first would have changed, for the record:

- releasing.md: the first release pull request would set 1.0.0; a section for majors (a `next`
  branch in changesets pre mode) would be needed from the start.
- Changesets: `major` for every breaking change from the first publish.
- Docs (decision 0015): the `/v1/` build and the per-major `docsUrl` from the first publish; the
  "before 1.0" rows would never apply and would be amended away.
- `types.ts` would drop "experimental until 1.0", and R-AX-13 would say "before 1.0.0".

## Consequences

- releasing.md has a "0.x rules" section (the changeset rules above), a "Conditions for 1.0"
  section that links this record, and the step for the 1.0.0 release pull request.
- `.changeset/config.json` has the `fixed` group `["explorer-verify", "@explorer-verify/*"]`. The
  glob takes in each scoped package when it lands. Until the first one exists, changesets prints a
  config warning that the glob matches nothing.
- `pnpm run check` runs `scripts/check-changesets.ts`, which refuses a `major` changeset while the
  core version is 0.x. The 1.0.0 release pull request puts its `major` in
  `.changeset/release-1-0-0.md`, the one file the check accepts.
- changesets does not version a private package, so the pull request that prepares 0.1.0 removes
  `"private": true` before the version step runs.
- The 0.1.0 release issue links this record. #7 and R-AX-13 keep "before 0.1.0".
- Decision 0015 is unchanged: its "before 1.0" rules govern the 0.x period, and its "from 1.0"
  rules start at 1.0.0. The root keeps serving every code page released in 0.x after 1.0 (the stub
  rule), so a 0.x `docsUrl` keeps working.
- Callers of 0.x pin with `^0.<minor>` and move between minors by hand. The README and the install
  page say so.
- When the conditions hold, the 1.0.0 pull request cites each one with its evidence (the outside
  tools, the minor releases, the harness and evaluation run, the answered questions).
