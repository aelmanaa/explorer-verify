# 0060: Supported Node.js versions follow Node's LTS schedule

Status: Accepted (2026-11-10).

Research: none (maintainer choice).

## Context

Issue [#291](https://github.com/aelmanaa/explorer-verify/issues/291). Every package declares
`engines.node` `>=22.18.0`, CI tests Node 22.18.0, 24.0.0 and 26.0.0, and R-RUN-1 names Node 22.18
and later. No page said how that range changes over time. Tool authors who depend on
explorer-verify need to know when a Node line stops being supported, to plan their own range.

Node's release schedule gives these dates
([nodejs/Release `schedule.json`](https://github.com/nodejs/Release/blob/main/schedule.json), read
2026-11-10):

| Line    | Active LTS from | Maintenance from | End of life |
| ------- | --------------- | ---------------- | ----------- |
| Node 20 | 2023-10-24      | 2024-10-22       | 2026-04-30  |
| Node 22 | 2024-10-29      | 2025-10-21       | 2027-04-30  |
| Node 24 | 2025-10-28      | 2026-10-20       | 2028-04-30  |
| Node 26 | 2026-10-28      | 2027-10-20       | 2029-04-30  |

## Decision

1. The supported Node.js lines are Node's active LTS and maintenance LTS lines.
2. A line is dropped when it reaches end of life. While the version is 0.x, the drop ships in a
   minor release, with a changeset that starts with "Breaking:"
   ([0.x rules](../releasing.md#0x-rules)). The same pull request raises `engines.node` in every
   package and the first CI test leg.
3. A line that reached end of life before 0.1.0 is not added. Node 20 is not supported.
4. The floor is the lowest version CI tests, and `engines.node` names it. Today that is 22.18.0:
   the repository's scripts and tests run TypeScript natively, which needs that release.
5. A new LTS line is added to the CI matrix when it enters active LTS.

## Consequences

- The next scheduled change: Node 22 reaches end of life on 2027-04-30. The first minor release
  after that date drops it, and the floor moves to a Node 24 release.
  [Releasing](../releasing.md#supported-node-versions) tracks this.
- The README, the package READMEs and the Setup sections of the user guides link this record
  where they state the Node version.
- R-RUN-1 and the comment on the CI test matrix link this record.
