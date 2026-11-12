# 2026-11-12: Where the docs live and how agents find them

Audience: whoever changes the docs host, the site config or the Context7 listing. Assumes
[the docs site research](2026-11-03-docs-site-and-versioning.md) and
[decision 0015](../decisions/0015-docs-site-versioning-and-error-pages.md).

This note gathers the facts behind [decision 0070](../decisions/0070-docs-hostname.md), which keeps
the docs site at `https://aelmanaa.github.io/explorer-verify/`, and behind the `context7.json` file
at the repository root (issue [#368](https://github.com/aelmanaa/explorer-verify/issues/368)).

## The host

- On 2026-11-12 the maintainer stated that there will be no GitHub organization and no custom
  domain for this project (issue [#365](https://github.com/aelmanaa/explorer-verify/issues/365)).
- `docsUrlOf(code)` in `packages/explorer-verify/src/errors.ts` returns
  `https://aelmanaa.github.io/explorer-verify/reference/errors/<code>`.
- The published tarballs of `explorer-verify` 0.1.0 and 0.2.0, downloaded from
  `https://registry.npmjs.org/explorer-verify/-/explorer-verify-<version>.tgz` on 2026-11-12,
  both carry that URL in `dist/src/errors.js`.
- `scripts/site-docs.ts` sets `SITE_URL = "https://aelmanaa.github.io/explorer-verify/"` and
  `SITE_BASE = "/explorer-verify/"`. `packages/cli/src/help.ts` sets `DOCS_URL` and `LLMS_URL` on
  the same host.
- The four `package.json` files set `homepage` to a GitHub URL, not to the site.
- GitHub, [Renaming a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository),
  read 2026-11-12: "all existing information, with the exception of project site URLs, is
  automatically redirected to the new name".
- GitHub, [Transferring a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository),
  read 2026-11-12: "However, we don't redirect GitHub Pages associated with the repository."
- hardhat-kms
  [decision 0017](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/contributor/decisions/0017-docs-hostname.md),
  read 2026-11-12, keeps that project's site at `aelmanaa.github.io/hardhat-kms` for the same
  reasons. It lists each place that embeds the URL with the cost of changing it, and says that
  search-console properties and their history do not carry across a host change.

## Context7

- The search API had no explorer-verify entry: `curl -s
  "https://context7.com/api/v1/search?query=explorer-verify"` on 2026-11-12 returned other
  libraries only.
- [Adding libraries](https://context7.com/docs/adding-libraries), read 2026-11-12: a library is
  added at <https://context7.com/add-library> with the public GitHub repository URL. A
  `context7.json` file in the repository narrows what is indexed.
- [Library owners](https://context7.com/docs/library-owners), read 2026-11-12:
  - `context7.json` takes `$schema`, `projectTitle`, `description`, `branch`, `folders`,
    `excludeFolders`, `excludeFiles`, `includeExtensions`, `rules`, `previousVersions`,
    `disallow`, `redirect`, `url` and `public_key`.
  - "When `folders` is set, only the `README` files in the repository root are always included."
  - `excludeFolders` takes priority over `folders`. Setting `excludeFiles` or `excludeFolders`
    replaces its default list.
  - "If any rule is rejected, none of the rules are applied and the library's existing rules are
    removed."
  - Unknown fields and invalid entries are skipped and reported in the library's logs.
- The JSON schema at <https://context7.com/schema/context7.json>, fetched 2026-11-12, lists the
  same fields with `additionalProperties: false`. `description` is 10 to 500 characters, and each
  rule is at most 255 characters. `branch` defaults to the repository's default branch.
- [Library updates](https://context7.com/docs/library-updates), read 2026-11-12: a library is
  refreshed on its own only when it "has been requested recently" and its docs are older than a
  threshold, 45 days for libraries outside the top 5,000. "Logged-in users can manually trigger a
  refresh for most libraries" from the library page.
- hardhat-kms
  [adoption metrics, "Agent listings"](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/contributor/adoption-metrics.md#agent-listings),
  read 2026-11-12: its Context7 entry did not pick up later releases on its own, and that project
  refreshes it after each minor release.

## Open questions

- Context7 reads the default branch, `main`, not the release tag. Between releases the listing can
  describe unreleased docs. Whether to set `branch` or `previousVersions` is left until the listing
  exists.

## Sources

- https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository,
  read 2026-11-12.
- https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository,
  read 2026-11-12.
- https://github.com/aelmanaa/hardhat-kms/blob/main/docs/contributor/decisions/0017-docs-hostname.md,
  read 2026-11-12.
- https://github.com/aelmanaa/hardhat-kms/blob/main/docs/contributor/adoption-metrics.md#agent-listings,
  read 2026-11-12.
- https://context7.com/docs/adding-libraries, read 2026-11-12.
- https://context7.com/docs/library-owners, read 2026-11-12.
- https://context7.com/docs/library-updates, read 2026-11-12.
- https://context7.com/schema/context7.json, fetched 2026-11-12.
- https://context7.com/api/v1/search?query=explorer-verify, queried 2026-11-12 with curl.
- https://registry.npmjs.org/explorer-verify/-/explorer-verify-0.1.0.tgz and the 0.2.0 tarball,
  downloaded 2026-11-12 with curl.
- Issue [#365](https://github.com/aelmanaa/explorer-verify/issues/365): the maintainer's statement
  of 2026-11-12.
