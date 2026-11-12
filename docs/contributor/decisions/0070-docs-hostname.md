# 0070: The docs site stays at aelmanaa.github.io/explorer-verify

Status: Accepted (2026-11-12). Amends the "Host" part and the "Owner and name" accepted risk of
[decision 0015](0015-docs-site-versioning-and-error-pages.md). Does not reverse it.

Research: [research/2026-11-12-docs-site-findability.md](../research/2026-11-12-docs-site-findability.md).

Issue: [#365](https://github.com/aelmanaa/explorer-verify/issues/365)

## Context

Decision 0015 put the docs site at `https://aelmanaa.github.io/explorer-verify/` with no custom
domain. It left one way out: the repository may be renamed or transferred once the docs move to a
custom domain. On 2026-11-12 the maintainer stated that there will be no GitHub organization and
no custom domain. That way out is gone, so the record has to say what holds instead.

The site's URL is embedded in these places, and each has its own cost to change:

| Place                                                                                                            | How it changes                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docsUrlOf()` in `packages/explorer-verify/src/errors.ts`, the `docsUrl` and default hint of every error         | It cannot change for a version already published. 0.1.0 and 0.2.0 on npm both carry the host in `dist/src/errors.js`. A new host fixes only the versions published after it |
| `SITE_URL` and `SITE_BASE` in `scripts/site-docs.ts`, and the site config that reads them                        | A config change and a docs deploy, which happens only with a promote (decision 0015)                                                                                        |
| `DOCS_URL` and `LLMS_URL` in `packages/cli/src/help.ts`                                                          | A CLI release; installed versions keep printing the old URL                                                                                                                 |
| The skill (`skills/explorer-verify/SKILL.md`), the site home page (`site/pages/index.md`) and the user pages     | A release; the skill and the docs ship in the package, so installed copies keep the old URL                                                                                 |
| The site's `llms.txt` and the `.md` copies                                                                       | A docs deploy; agents and answer engines that cached the old URLs keep citing them until they read the site again                                                           |
| Search-console properties and the sitemap (issue [#366](https://github.com/aelmanaa/explorer-verify/issues/366)) | New properties for the new host, which start with no history                                                                                                                |
| Later: `homepage` in the four `package.json` files and the repository About link                                 | A release of the four packages, and a settings edit                                                                                                                         |

After a rename, GitHub redirects "all existing information, with the exception of project site
URLs". After a transfer, "we don't redirect GitHub Pages associated with the repository". The
research note quotes both pages with the date read. A move to an organization is a transfer, so the
project site would be served under the organization's host and the old URL would stop serving.

hardhat-kms, by the same maintainer, recorded the same choice for its own site in its
[decision 0017](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/contributor/decisions/0017-docs-hostname.md).
This record follows its structure.

## Decision

- The docs host is `https://aelmanaa.github.io/explorer-verify/`. VitePress `base` is
  `/explorer-verify/`. There is no custom domain and no GitHub organization.
- The repository is not renamed and not transferred. This replaces the condition in decision 0015
  that allowed either "without first moving the docs to a custom domain".
- `docsUrlOf()`, `SITE_URL`, `SITE_BASE`, the CLI help, the skill, the site's `llms.txt` and the
  pages keep this host. The sitemap and the search-console properties (#366) use it. The `homepage`
  fields and the About link point at it when the follow-up of #365 lands.

## Alternatives considered

- **Custom domain.** It would let the repository be renamed or transferred later, and GitHub
  redirects a project site to a custom domain once one is set. Not taken: it needs a registration,
  DNS records, a `CNAME` file and a yearly renewal, and it fixes only the versions published after
  it. 0.1.0 and 0.2.0 already embed the current host.
- **GitHub organization.** It would put the site at `<org>.github.io/explorer-verify/`. Not taken:
  a transfer does not redirect the Pages site, so every `docsUrl` in the published versions would
  stop working, with no redirect to fall back on.

## Consequences

- The site needs no DNS, no renewal and no `CNAME` file. The deploy stays as decision 0015 and
  [releasing.md](../releasing.md#docs-deploy) describe it.
- Every absolute site URL carries the `/explorer-verify/` path. A link without it returns 404 on
  the live site.
- The search-console work in #366 and #367 binds more to this host. That is acceptable now that the
  host is settled.
- Renaming or transferring the repository would break every `docsUrl` in every published version.
  The rule above forbids both.
- A reason to revisit: the project moves to more than one owner, or a custom domain becomes worth a
  yearly renewal. Either is a new record that supersedes this one.
