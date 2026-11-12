# 0015: Docs site, docs versioning and one page per error code

Status: Accepted (2026-11-03); `srcDir` amended by
[decision 0028](0028-site-reads-from-the-repository-root.md); site-only pages added by
[decision 0062](0062-site-only-pages.md); host and the rename or transfer condition amended by
[decision 0070](0070-docs-hostname.md). Amends the `docsUrl` part of
[decision 0009](0009-options-handle-and-errors.md) and the site `llms.txt` part of
[decision 0007](0007-agent-readiness-is-a-requirement-on-every-feature.md).

Research: [research/2026-11-03-docs-site-and-versioning.md](../research/2026-11-03-docs-site-and-versioning.md).

## Context

The user docs live in `docs/user/`, render on GitHub, and ship in the npm package as `docs/` with a
relative `llms.txt` (R-AX-2, decision 0007). There is no public site. Decision 0007 said the
root `llms.txt` links GitHub "until a docs site exists".

Every `ExplorerVerifyError` carries a `docsUrl` (R-AX-10). Today it is
`https://github.com/aelmanaa/explorer-verify/blob/main/docs/user/reference/errors.md#<code>`. That
URL has two problems:

- It points at `main`, so a released version links to text that may later rename or drop the code.
- The code sits in a fragment. A fragment is "dereferenced solely by the user agent" (RFC 3986,
  section 3.5), so an agent that fetches the URL gets the whole errors page, not the one entry.

No version is published yet. A `docsUrl` baked into 0.1.0 has to keep working for as long as 0.1.0
is installed, so the scheme has to be settled before the first publish.

The research note compares 21 docs sites, eight generators and three hosts, and recommends
VitePress on GitHub Pages under a custom domain. The maintainer took that recommendation with
three changes: no custom domain, one page per error code instead of anchors, and a docs deploy
that gates the promote to `latest`.

## Decision

### Host: GitHub Pages at the default address

The site is `https://aelmanaa.github.io/explorer-verify/`, deployed from a GitHub Actions artifact.
There is no custom domain.

Reasons from the research: the repository is public, so GitHub Pages is free; the site is far below
the 1 GB size limit and the 100 GB monthly bandwidth soft limit; and deploying from an Actions
artifact fits the release workflow.

The maintainer chose this address knowing that GitHub does not redirect a project site after a
rename or a transfer (see "Accepted risks"). The repository must not be renamed or transferred
unless the docs first move to a custom domain and the maintainer accepts that every `docsUrl` in
the versions already published stops working.

### Generator: VitePress with `srcDir` set to `docs/user`

The site builds the same Markdown files that GitHub renders and the npm package ships. VitePress
takes the page title from the first H1, so pages need no frontmatter, and it resolves relative `.md`
links. Local search (MiniSearch) is built in and needs no third-party service. The site config lives
outside `docs/user/`, so neither GitHub nor the npm package sees generator files.

To keep a later move to VitePress 2.0 or to Starlight cheap:

- Source pages stay plain Markdown: no Vue components, no VitePress containers, no frontmatter.
  VitePress compiles each page as a Vue single-file component, and `{{ }}` in prose is evaluated
  ([Using Vue in Markdown](https://vitepress.dev/guide/using-vue), read 2026-11-03). A check in
  pull request CI rejects `{{` in prose outside code, so such text never ships.
- `llms.txt` and the `.md` copies come from the repository's own docs script, not a generator
  plugin.
- The tests check the built output (one file per URL), not generator internals.
- Inference: a move to Starlight then costs a `title` in each page's frontmatter (scriptable from
  the H1) and a plugin for relative `.md` links, as the research lists.

### Error docs: one page per code

Each error code has its own page at `docs/user/reference/errors/<code>.md`. The current
`docs/user/reference/errors.md` becomes `docs/user/reference/errors/index.md`: the shared fields,
key redaction, exit codes, retries, and a list that links each code. A code page has the code as
its H1, the version line, the `llms.txt` link, then `Cause:`, `Fix:`, `Default hint:`,
`Retryable:` and `Exit code:`.

`docsUrl` is the code's page on the site:

| Period     | `docsUrl`                                                                     | Rule                                                               |
| ---------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Before 1.0 | `https://aelmanaa.github.io/explorer-verify/reference/errors/<code>`          | Unversioned. A released code keeps its page forever                |
| From 1.0   | `https://aelmanaa.github.io/explorer-verify/v<major>/reference/errors/<code>` | Per major, from the package version at build time, as Angular does |

Until the site exists, the base is the user docs folder on GitHub,
`https://github.com/aelmanaa/explorer-verify/blob/main/docs/user/`, and the URL keeps the `.md`
extension of the source file. The site switches the base and drops the extension. No version is
published with this base: the site issue (#84) lands before the first npm publish, and the release
workflow fails when the built errors module contains `blob/main`.

The URL path matches the source path, so the same relative link works on the site, on GitHub and
in the packaged docs, and a test can map each `docsUrl` to a source file without a rewrite table.
VitePress serves clean URLs on GitHub Pages without extra configuration ("Netlify and GitHub Pages
support this by default", [VitePress routing](https://vitepress.dev/guide/routing), read
2026-11-03).

Stub rule: a code that was ever released keeps its page. When a release removes the code, the page
stays, says "Removed in X.Y.Z" and names the replacement. A committed list of released codes, which
the version pull request appends to, enforces the rule.

### Versioning

- Before 1.0, the site shows the version on npm `latest` only, built from that version's tag,
  never from `main`. Each page keeps its `Version:` line. The site says that exact-version docs are
  in the npm package and on jsDelivr (`cdn.jsdelivr.net/npm/explorer-verify@<version>/llms.txt`)
  and unpkg.
- From 1.0, one build per major, at `/v1/`, `/v2/` and so on. The root serves the latest major. Old
  majors carry a banner and a canonical link to the same page in the latest major, where one
  exists. Google prefers a canonical link over `noindex` for duplicates within one site.
- No per-minor or per-patch builds. SemVer keeps minors additive, and exact versions stay in the
  package, on jsDelivr and in git tags.
- After 1.0 the root serves the latest major, so a 0.x `docsUrl` keeps resolving only if the latest
  major's build keeps a page for every code released in 0.x. The stub rule covers this.

### Agent-readable copies

The site serves `/llms.txt`, generated from the same source as the root and packaged ones with
site URLs as a third link target, and a `.md` copy of each page next to its HTML. GitHub Pages
cannot negotiate on `Accept`, so the copies need their own URLs. The repository-root `llms.txt`
keeps linking raw files on `main`: it describes the repository, which includes unreleased work and
the contributor docs. This replaces the "until a docs site exists" line of decision 0007.

### API reference

TypeDoc with `typedoc-plugin-markdown` generates the API reference from TSDoc into the site build
only. It is not written to `docs/user/` and does not ship in the npm package, whose `.d.ts` files
carry the same TSDoc. R-AX-2 says so.
TypeDoc 0.28.20 needs the TypeScript 6 API (peer range `5.0.x` to `6.0.x`, `npm view`
2026-11-03), and TypeScript 7.0 ships no compiler API. The repository therefore adds
`@typescript/typescript6` 6.0.2, which installs `typescript` 6.0.3, through an npm alias for
TypeDoc only. TypeScript 7 stays the
type checker. `validation.invalidLink`, `notExported`, `notDocumented` and `treatWarningsAsErrors`
are on, and `gitRevision` is the release tag.

### Tested examples and links

- Every `ts` block in `docs/user/` is type-checked against the build and run with recorded explorer
  answers, using the test that runs the skill's examples (R-AX-4). A block that must not run says
  so in its info string.
- lychee checks links: offline with `--include-fragments` on the built site in pull request CI,
  online on a weekly schedule.

### Four tests prove every `docsUrl` resolves

1. Unit test: every code has a page with `Cause:`, `Fix:`, `Default hint:`, `Retryable:` and
   `Exit code:` lines, and every page under `reference/errors/` other than the index is a code or
   a released code.
2. Unit test: the committed list of released codes is a subset of the codes with pages.
3. Site-build test in pull request CI: for each code, `docsUrl` with the site base removed maps to a
   file in the build output, and so does its `.md` copy.
4. Post-deploy smoke step: fetch each code page and its `.md` copy over HTTPS and expect status 200.
   A failure fails the docs job and stops the promote.

### Release gating and deploy permissions

- A release is first published to npm `beta` from the maintainer's signed `v*` tag. The docs are
  not deployed then.
- The promote workflow, dispatched by the maintainer from `main`, deploys the docs built from the
  version's tag and runs the smoke step. Only then can its promote job move `latest` to that
  version. A failed deploy or smoke step blocks the promote, so every `docsUrl` of the version on
  `latest` is live.
- The `github-pages` environment allows `main` only ("Only branches and tags that match your
  specified name patterns can deploy to the environment", GitHub deployments and environments
  docs, read 2026-11-03). The promote run and the manual re-deploy both start from `main`.
- Pull request CI builds the site and runs tests 1 to 3. It never deploys. Agents never deploy,
  trigger a deploy, promote or approve an environment.
- A manual re-deploy from `main` covers docs-only fixes between releases. It builds from the tag
  of the version on `latest`.
  - Note (2026-11-03, #84): because the re-deploy builds from the tag, it can only re-deploy the
    tagged docs, for example after a failed deploy. A docs fix ships in a patch release.

## Alternatives considered

### Host

- GitHub Pages under a custom domain (the research's recommendation). A custom domain keeps every
  `docsUrl` working if the repository is renamed or transferred, or the host changes. Not taken:
  maintainer choice (2026-11-03). The risk this leaves is under "Accepted risks".
- Cloudflare Pages or Workers static assets. Supports `_headers` and `_redirects`. Not taken: a
  second account and deploy credential for a static site that GitHub Pages serves.
- No site: pin `docsUrl` to the tag on GitHub
  (`.../blob/v<version>/docs/user/reference/errors.md#<code>`). Exact and immutable, but it cannot
  be tested before the tag exists, and it gives no search and no HTML site.

### Generator

- Starlight, the research's alternative. Active upstream (41 releases in 12 months) with Pagefind
  search and build-time link validation. Not taken now: every page needs a `title` in frontmatter,
  relative `.md` links need a plugin, and versioning, `llms.txt`, `.md` copies and TypeDoc each need
  a community plugin. Kept as the fallback.
- Docusaurus: versioning is built in but matters only from 1.0, and local search needs a community
  plugin.
- Material for MkDocs: in maintenance mode since 2025-11-11, and it needs a Python toolchain.
- Nextra, Fumadocs, Mintlify and Vocs were also compared. The research note gives the reasons for
  each.

### Error docs

- Anchors on one errors page (the current scheme). Not taken: the fragment never reaches the
  server, so an agent that fetches the URL gets every code.
- `docsUrl` pointing at the `.md` copy. Not taken: a person who opens the link wants HTML. The
  agent page and the skill will say that appending `.md` gives the Markdown copy, as part of the
  site issue (#84).
- A short path `/errors/<code>` through a VitePress rewrite. Not taken: the site path would then
  differ from the source path, and relative links "should be based on the rewritten paths"
  ([VitePress routing](https://vitepress.dev/guide/routing)), which breaks them on GitHub and in the
  package.

### Versioning

- Per-release builds, as docs.rs and Node.js keep. Not needed: jsDelivr and unpkg already serve
  every published version's docs.
- Versioned `docsUrl` before 1.0. Not taken: during 0.x every minor may break, so a per-minor path
  would multiply the builds the deploy has to reassemble. The stub rule gives the same guarantee for
  the URL.
- A `/next/` build from `main`. Left open: it helps reviewers, and it risks agents reading
  unreleased docs.

### API reference

- API Extractor with api-documenter. Also needs the TypeScript 6 API, and adds an API report
  step this project does not need.
- Wait for TypeScript 7.1, which is expected to ship a new API. Left open as a timing question.

### Release gating

- Deploy on the signed tag and gate the `beta` publish on it. Not taken: the site would then show
  a version that `npm install` does not give until the promote, which can be days later.
- Deploy after the promote, or let the docs workflow only report. Not taken: a `docsUrl` of the
  version on `latest` could then return 404 until someone notices.

## Consequences

- `docsUrl` changes for every code. Nothing is published, so no user is affected. The error tests,
  the envelope schema description, the JSON output example and every link to an errors anchor
  change in the same pull request.
- R-AX-10 states the URL scheme and the stub rule. R-AX-17 states what the site serves, and R-AX-2
  says the API reference goes into the site build only. The R-AX-10 row of the testing page lists
  the four tests.
- Each new code is one new file. Parallel pull requests that add codes no longer edit the same
  page.
- `llms.txt` grows by one line per code.
- A released code's page cannot be deleted. Renaming a code means a new page plus a stub.
- The promote workflow gains a docs job, and the promote depends on it. `releasing.md` describes
  the order: signed tag, `beta` publish, promote dispatch, docs deploy, smoke step, `latest`.
- A `beta` version can carry a `docsUrl` for a new code whose page is not deployed yet. That URL
  returns 404 until the promote. Codes released before keep their pages under the stub rule.
- Between the deploy and the approval of the promote job, the site describes a version that is not
  yet `latest`. If the promote is declined, a manual re-deploy restores the docs of the version on
  `latest`.
- Each deploy from an Actions artifact replaces the whole site. From 1.0, the deploy rebuilds every
  kept major from its latest tag.

### Accepted risks

- **Owner and name.** Every published `docsUrl` depends on the repository keeping its owner and
  name. After a rename, GitHub redirects "all existing information, with the exception of project
  site URLs"
  ([renaming a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository)).
  After a transfer, "we don't redirect GitHub Pages associated with the repository"
  ([transferring a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository)).
  Both pages were read on 2026-11-03. Renaming or transferring the repository therefore breaks
  every `docsUrl` in every published version. The repository must not be renamed or transferred
  without first moving the docs to a custom domain and accepting that breakage. A custom domain
  added later fixes only the versions published after it.
- **VitePress release pace.** VitePress 1.6.4 (2025-08-05) is the latest stable release, and 2.0
  has been in alpha since 2025-01-22, at `2.0.0-alpha.21` on 2026-10-25 (`npm view vitepress`,
  2026-11-03). A move to 2.0 is likely during this project's life (inference). The plain-Markdown
  rule above keeps that move, or a move to Starlight, inside the site config.
- **TypeScript 6 compatibility package.** The API reference depends on `@typescript/typescript6`
  until TypeScript 7.1 ships its new API and TypeDoc supports it.
- **Latest only before 1.0.** The site can describe a newer version than the one a user installed.
  The `Version:` line, the packaged docs and jsDelivr cover this, as decision 0007 intends.
- **Markdown content type.** The research could not confirm how GitHub Pages serves an uploaded
  `.md` file. The smoke step checks the status, not the type.
