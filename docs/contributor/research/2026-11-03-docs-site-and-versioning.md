# 2026-11-03: Docs site, generator, hosting and versioning

Audience: the maintainer, who decides where the public docs live and how they are versioned.
Sources read and commands run on 2026-11-03. Commands ran on macOS with curl 8.7.1, npm 11.19.0
and gh 2.92.0. Each claim names its source; links are listed under [Sources](#sources). Lines
marked "Inference" are conclusions drawn from the sources, not facts stated by them.

Question: where should explorer-verify publish its public technical docs, with which generator,
and how should the docs be versioned before and after 1.0, given that the library is used by people
and by coding agents, that the npm package already ships its docs, and that error objects carry a
`docsUrl`?

## Answer summary

- Most of the sites checked serve agents directly. On 2026-11-03, 11 of the 15 sites in the table
  served `/llms.txt`, and 10 of 13 checked served a Markdown copy of a page at `<page>.md` or for
  `Accept: text/markdown`. Four sites (Stripe, Astro, viem, Foundry) also publish an MCP docs
  server.
- Versioning splits into three models. Per-major sites (Tailwind, Astro, React, Hardhat, viem,
  wagmi, ethers, Next.js) keep each old major at its own subdomain or path. Per-release sites
  (docs.rs, the Rust standard library, Node.js) keep every release. Latest-only sites (Starlight,
  the Stripe guides) keep one version. No site checked versions per minor.
- Old versions are kept out of search in two ways: a `noindex` tag (Next.js, docs.rs), or a
  canonical link to the current page (Node.js, React 18). Google recommends canonical links over
  `noindex` for duplicates within one site.
- Links baked into code follow two patterns. React and Next.js bake an unversioned URL. Angular
  bakes a per-major host (`v20.angular.dev/errors/...`), chosen from the package version.
- explorer-verify's TypeScript is 7.0.2. TypeScript 7.0 ships no compiler API, and TypeDoc 0.28.20
  and API Extractor 7.60.1 both need the TypeScript 6 API. API reference generation therefore needs
  the `@typescript/typescript6` compatibility package next to TypeScript 7.
- Recommendation: VitePress on GitHub Pages under a custom domain. Before 1.0, the site shows the
  latest release only, and the npm package (also reachable on jsDelivr per exact version) is the
  versioned copy. After 1.0, keep one site build per major. `docsUrl` points at a stable,
  unversioned errors URL on the site, with a rule that a released error code is never removed from
  the page. The alternative is Starlight on the same host.

## 1. Documentation sites checked

Probes ran with curl on 2026-11-03. "llms" is the HTTP status of `/llms.txt`; "full" is
`/llms-full.txt`; ".md" is a Markdown copy at `<page>.md` (or `/index.md`); "Accept" is a page
requested with `Accept: text/markdown`. "Built with" comes from the `generator` meta tag, the
repository's `package.json` or the site's own statement.

| Site                | Built with                                                              | llms                   | full          | .md | Accept     | Copy page in HTML        |
| ------------------- | ----------------------------------------------------------------------- | ---------------------- | ------------- | --- | ---------- | ------------------------ |
| Stripe              | Markdoc ("Stripe created Markdoc to power our public docs")             | 200                    | 404           | 200 | Markdown   | "View as Markdown"       |
| Cloudflare          | Nimbus on Astro 7.4.1, hosted on Workers                                | 200 (per product)      | 200 (69.9 MB) | 200 | Markdown   | yes (Page options)       |
| Vercel              | Next.js (`_next/static`)                                                | 200                    | 200 (11.8 MB) | 200 | Markdown   | "Copy page"              |
| Next.js             | Next.js; docs source in the `vercel/next.js` repository                 | 200 (`/docs/llms.txt`) | 200 (4.5 MB)  | 200 | Markdown   | "Copy page"              |
| Astro               | Starlight 0.42.7 on Astro 7.4.2                                         | 404                    | 404           | 404 | HTML       | none found               |
| Tailwind CSS        | Next.js 16.2.6, `@docsearch/react`                                      | 404                    | n/a           | 404 | HTML       | none found               |
| React               | Next.js 15.1.12, Sandpack, `@docsearch/react`                           | 200                    | 404           | 200 | text/plain | "Copy page"              |
| Node.js API         | doc-kit (Markdown source to HTML, JSON, llms.txt, man page)             | 200                    | 404           | 200 | HTML       | n/a                      |
| docs.rs, Rust books | rustdoc; mdBook                                                         | 400; 404               | n/a           | n/a | HTML       | none                     |
| viem                | Vocs 2.8.1 with Twoslash                                                | 200                    | 200 (2.5 MB)  | 200 | Markdown   | "Copy page", MCP prelude |
| wagmi               | VitePress 1.6.3, `vitepress-plugin-llms`, Twoslash, local search        | 200                    | 200 (3.6 MB)  | 200 | not probed | "Copy page"              |
| Foundry             | Vocs (`getfoundry.sh`; `book.getfoundry.sh` redirects there)            | 200                    | 200 (3.6 MB)  | 200 | not probed | "Copy page", MCP prelude |
| Hardhat             | Starlight 0.36.0 on Astro 5.14.4, Pagefind, `starlight-links-validator` | 200                    | 404           | 200 | Markdown   | `llms.txt` link          |
| ethers              | Flatworm (`docs.wrm` source in the ethers.js repository), on S3         | 404                    | n/a           | n/a | HTML       | none found               |
| Sourcify            | Docusaurus 3.7.0, Algolia DocSearch markup                              | 200                    | 404           | 404 | not probed | none found               |

The Next.js `llms.txt` states the version it covers: "Reference and guides for Next.js 16.4.4"
and `@doc-version: 16.4.4`. Stripe's `llms.txt` opens with an instruction to check the npm registry
for the current package version. Sourcify's `llms.txt` opens with fair-use rules for its API.

Per site, beyond the table:

- **Stripe.** API versions are dated, with a named major release twice a year and monthly releases
  without breaking changes; the current version on 2026-11-03 was `2026-10-28.endive`. The API
  reference page explains per-SDK version pinning. There is an API changelog and an upgrades page.
  Stripe lists an MCP server at `https://mcp.stripe.com` and appending `.md` to any docs URL. An
  OpenAPI specification is public in `stripe/openapi`. Inference: the API reference is generated
  from that specification; the docs do not say so.
- **Cloudflare.** Content types: how-to, tutorial, get started, concept, reference, overview, FAQ,
  troubleshooting, changelog and others. The content-type page does not mention Diátaxis, but
  Cloudflare is quoted as a Diátaxis adopter on diataxis.fr. Search is Cloudflare AI Search (Algolia
  earlier). Agent features: a root `llms.txt` with one per product, `llms-full.txt`,
  `/index.md` per page, `Accept: text/markdown` (converted at the network layer), and a copy-page
  button. A public changelog exists.
- **Next.js.** Old majors stay at `/docs/13`, `/docs/14` and `/docs/15`. These pages carry
  `<meta name="robots" content="noindex">`, and current pages carry a canonical link. There are
  upgrade guides per major.
- **Astro.** The current site covers v7; old majors live at `v5.docs.astro.build` and
  `v4.docs.astro.build`, and upgrade guides exist for each major. The v5 site's canonical points to
  itself. Astro publishes an MCP server at `https://mcp.docs.astro.build/mcp` and did not serve
  `llms.txt` on 2026-11-03.
- **Tailwind CSS.** Old majors live at `v3.tailwindcss.com` and `v2.tailwindcss.com`; an upgrade
  guide exists.
- **React.** Old docs live at `18.react.dev` and `legacy.reactjs.org`, and `react.dev/versions`
  lists them. `18.react.dev` pages set their canonical to the matching `react.dev` page. Examples
  are Sandpack sandboxes that run in the browser. The React 19 upgrade guide is a blog post.
- **Node.js.** Every release and every major line is kept: `/docs/v20.0.0/api/` and
  `/docs/latest-v22.x/api/`. Old pages set their canonical to `nodejs.org/api/...`. doc-kit
  generates HTML, JSON, `llms.txt`, a man page and an Orama search index from the Markdown source.
  Changelogs are kept per major in the repository.
- **Rust.** docs.rs builds docs for every published crate version. `docs.rs/serde` redirects (302)
  to `/serde/latest/serde/`, which is served with `cache-control: max-age=0`. A pinned old version
  is served with `x-robots-tag: noindex`. docs.rs also resolves semver ranges such as `~2.9`. The
  standard library is kept per release (`/1.80.0/`) and per channel (`/stable/`, `/beta/`).
  rustdoc compiles and runs code in doc comments as tests (`cargo test --doc`), and `mdbook test`
  does the same for Rust code in a book.
- **viem.** Old docs live at `v1.viem.sh`, with a migration guide. Code blocks are type-checked by
  Twoslash: under Vocs, a compiler error in a sample "will set the process exit code to 1 failing
  any builds". Each Markdown page names the MCP server at `https://viem.sh/api/mcp`.
- **wagmi.** Old docs live at `1.x.wagmi.sh`, with migration guides from v1 to v2 and from v2 to v3.
  The site uses VitePress local search.
- **Hardhat.** Hardhat 2 docs live at `v2.hardhat.org`, with a page on migrating from Hardhat 2.
- **ethers.** Majors live under one host, at `/v5/` and `/v6/`, and `docs.ethers.org/` redirects to
  `/v6/`. A migration page exists.
- **Sourcify.** One version. The API page exists; no old-version site was found.

## 2. Practices

### Diátaxis

Diátaxis "identifies four distinct needs, and four corresponding forms of documentation":
tutorials, how-to guides, reference and explanation. The site quotes Vonage, Gatsby and Cloudflare
as adopters. Cloudflare's own content-type list is finer-grained than the four forms. explorer-verify
already uses the layout in `docs/user/`.

### Docs as code

Write the Docs defines docs as code as "writing documentation with the same tools as code":
version control, plain-text markup, code review and automated tests. The repository already works
this way.

### Testing docs

- **Doctests.** rustdoc runs code in doc comments as tests and supports `ignore`, `no_run`,
  `should_panic` and `compile_fail`. `mdbook test` runs Rust code in a book.
- **Type-checking samples.** Twoslash runs the TypeScript compiler on each code block, and an
  unexpected error fails the build. viem (Vocs) and wagmi (`@shikijs/vitepress-twoslash`) use it.
- **Extracting and running examples.** explorer-verify already extracts the skill's code blocks,
  type-checks them and runs them against the build with recorded explorer answers.
- **Link checking.** lychee 0.24.2 (Apache-2.0, released 2026-05-01) checks Markdown and HTML.
  `--include-fragments` checks `#anchor` targets, and a GitHub Action exists.
  `starlight-links-validator` checks internal links in Starlight. TypeDoc's
  `validation.invalidLink` warns on unresolved `{@link}`, and `treatWarningsAsErrors` makes warnings
  fatal.
- **Prose linting.** Vale v3.26.0 (MIT, released 2026-10-31) has packages for the Google and
  Microsoft style guides, plus `Diataxis`, `A11y` and `MDX` packages.

### Style guides

- Google developer documentation style guide: "guidelines, not rules". Its highlights include
  second person, active voice, sentence-case headings, descriptive link text, conditions before
  instructions, and code font for code.
- Microsoft Writing Style Guide: "warm and relaxed, crisp and clear, and ready to lend a hand",
  with a top-10 tips page.

### Accessibility

WCAG 2.2 is a W3C Recommendation; the current edition is dated 12 December 2024. Google's style
guide asks for alt text on every image, no skipped heading levels, meaningful link text, header
cells in the first row and column only, no meaning carried by colour alone, a 4.5:1 text contrast
ratio, and no images of code or terminal output.

### Search

| Option            | Runs where      | Used by (checked)                    | Terms                                                                           |
| ----------------- | --------------- | ------------------------------------ | ------------------------------------------------------------------------------- |
| Pagefind 1.6.0    | Browser, static | Starlight default, Hardhat, Nextra   | MIT. "a 10,000 page site with a total network payload under 300kB"              |
| MiniSearch        | Browser, static | VitePress `provider: 'local'`, wagmi | Part of VitePress                                                               |
| lunr              | Browser, static | Material for MkDocs built-in search  | Part of the theme                                                               |
| Algolia DocSearch | Hosted          | React, Tailwind, Astro, Sourcify     | Free for "public technical documentation"; declined when "not production ready" |

### Agent-readable docs

- **Specification.** `llms.txt` was proposed on 2024-09-03 by Jeremy Howard. Only an H1 is
  required. Pages should have Markdown copies at `page.html.md` or `page.md`. The page does not
  define `llms-full.txt`; that name is a convention used by Cloudflare, Next.js, Vercel, viem,
  wagmi, Foundry, `vitepress-plugin-llms`, Vocs, Mintlify and Fumadocs.
- **Adoption, dated.** Common Crawl (published 2026-08-31) found 584,107 non-empty `llms.txt` files
  in its July 2026 crawl. 49.90% had the full structure (H1, blockquote, H2 link lists), 68.27% were
  templated, and Wix alone produced 41.34%. Ahrefs (published 2026-06-15) found that 28% of 137,210
  domains with traffic in May 2026 publish the file. It calls that figure an upper bound, because its
  sample skews toward technical sites. It also found that 97% of the files received no request in
  May 2026, and that Claude-Code was among the top requesters. Secondary reports put adoption among
  top-ranked domains at 6% to 10%; their methods were not checked.
- **Effect on agents.** The repository's agent-readiness note (2026-11-02) records a vendor-run
  benchmark: failed requests per task fell from 2.23 (HTML) to 0.11 (Markdown with an `llms.txt`
  link). It also records a crawler study in which search and training crawlers rarely fetched
  `llms.txt`.
- **Markdown per page and content negotiation.** Observed above on Stripe, Cloudflare, Vercel,
  Next.js, React, viem, wagmi, Foundry and Hardhat. Cloudflare's "Markdown for Agents" converts
  HTML to Markdown for `Accept: text/markdown` on Pro, Business and Enterprise plans; the Free plan
  is not listed. Fumadocs implements negotiation in app code with `isMarkdownPreferred` and
  `Vary: Accept`, which needs a server.
- **MCP docs servers.** Stripe (`mcp.stripe.com`), Astro (`mcp.docs.astro.build`), viem and Foundry
  (`/api/mcp`, built into Vocs) and Mintlify (all plans) publish one. Vocs states that the MCP server
  needs a server runtime and does not run in its `full-static` mode for GitHub Pages.

## 3. Versioning models

| Model                            | Examples                                                                                                                                 | URL pattern                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Per major                        | Tailwind (`v3.`), Astro (`v5.docs.`), React (`18.react.dev`), Hardhat (`v2.`), viem (`v1.`), wagmi (`1.x.`), Angular (`v20.angular.dev`) | Subdomain per old major                                        |
| Per major, same host             | Next.js (`/docs/14`), ethers (`/v5/`, `/v6/`)                                                                                            | Path                                                           |
| Per release                      | docs.rs (every crate version), Rust std (`/1.80.0/`), Node.js (`/docs/v20.0.0/`)                                                         | Path per version, plus `latest` and channel aliases            |
| Generator-managed                | Docusaurus `docs:version`, mike for MkDocs, Mintlify `versions`, Fumadocs root folders                                                   | Copies per version in the source tree or the `gh-pages` branch |
| Latest only, versions in package | Starlight (0.42.x, `CHANGELOG.md` only); explorer-verify's packaged `docs/`                                                              | One site; each published tarball holds its own docs            |

Details:

- **Number of versions.** Docusaurus advises keeping "the number of your versions below 10" and
  says most projects do not need versioning because it "will just increase your build time", and
  that versioning patch releases "will only just create unnecessary duplicated files". Its
  `current` docs are served as "Next", `lastVersion` chooses what `/docs` shows, and banners mark versions
  `unreleased` or `unmaintained`.
- **`/latest/`.** docs.rs redirects the bare crate URL to `/latest/`, served with `max-age=0`.
  Read the Docs has `latest` (the default branch) and `stable` (the highest stable semver release).
  mike uses aliases such as `latest` and writes a root redirect "to the version associated with the
  alias". Node.js uses `latest-v22.x` per line.
- **Version switchers.** Docusaurus has `docsVersionDropdown`. With mike, the switch keeps the
  reader on the equivalent page, but "the redirect happens via JavaScript". Mintlify versions sit in
  a navigation dropdown. Read the Docs uses a flyout menu.
- **Old-version banners.** Read the Docs warns readers that they "may be reading an outdated version
  of the documentation". Material's example banner says "You're not viewing the latest version."
  docs.rs pages on old versions link to the latest version.
- **SEO.** Google: permanent redirects are the strongest canonical signal, `rel="canonical"` (HTML
  or HTTP header) is next, sitemaps are weak, and "We don't recommend using noindex to prevent
  selection of a canonical page within a single site." In practice, Node.js and React 18 use a
  canonical link to the current page, while Next.js and docs.rs use `noindex`. The Astro v5 site
  points its canonical at itself.
- **What 0.x projects do.** SemVer: "Major version zero (0.y.z) is for initial development.
  Anything MAY change". Starlight, at 0.42.8 with 41 releases in the past 12 months, shows no
  version switcher; its site links a `CHANGELOG.md`. docs.rs keeps every 0.x release, for example
  `serde/0.9.0`. Inference: during 0.x, projects keep one site and leave old versions to the
  changelog or to per-release archives they get for free.
- **Free per-release archive for npm packages.** jsDelivr serves any file of any published version:
  `cdn.jsdelivr.net/npm/<pkg>@<exact>/<file>` comes back as `text/markdown` with
  `max-age=31536000, immutable`, and semver ranges (`@1`) are served with a shorter cache. unpkg
  serves exact versions the same way. Inference: because explorer-verify ships `docs/` and a
  relative `llms.txt`, every release's docs will be readable at
  `cdn.jsdelivr.net/npm/explorer-verify@<version>/llms.txt` without a hosted archive.
- **Links baked into published code.**
  - React builds `'https://react.dev/errors/' + code` (unversioned).
  - Next.js prints `https://nextjs.org/docs/messages/<name>` (unversioned).
  - Angular builds `https://v${major}.angular.dev/errors` from `VERSION`, or `next.angular.dev` for
    pre-releases. `v19`, `v20` and `next` all resolved on 2026-11-03.
  - A URL fragment is "dereferenced solely by the user agent" (RFC 3986, section 3.5). Inference: an
    agent that fetches `.../errors.md#code` receives the whole page, not the section.
- **explorer-verify today.** `docsUrl` is
  `https://github.com/aelmanaa/explorer-verify/blob/main/docs/user/reference/errors.md#<code>`.
  The unit tests check that each code has a section with `Cause:` and `Fix:` lines in `errors.md`.
  Inference: a released version will point at `main`, which may later rename or remove a code.

## 4. Generators and hosting

### Generators

npm and PyPI data read on 2026-11-03. "Releases/12 mo" counts stable releases since 2025-11-03.

| Generator                    | Latest stable (date)                                                               | Releases/12 mo | Licence           | Built-in versioning                                                       | Markdown input                                                                                              | `llms.txt` / `.md`                                                                                              | Search                                    | Static for GitHub Pages                      | TypeScript API reference                      |
| ---------------------------- | ---------------------------------------------------------------------------------- | -------------- | ----------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------- | --------------------------------------------- |
| Starlight                    | 0.42.8 (2026-10-30)                                                                | 41             | MIT               | No; community `starlight-versions` 0.10.2 is "still in early development" | Markdown, MDX, Markdoc; "You must provide a title for every page" in frontmatter; examples link by URL path | Community `starlight-llms-txt` 0.12.0 (`llms.txt`, `-full`, `-small`); `.md` copies via other community plugins | Pagefind built in; DocSearch plugin       | Yes (Astro static)                           | Community `starlight-typedoc` 0.23.2          |
| VitePress                    | 1.6.4 (2025-08-05); `next` 2.0.0-alpha.21 (2026-10-25), 21 alphas since 2025-01-22 | 0              | MIT               | No                                                                        | Markdown with Vue; no frontmatter needed (title from first `<h1>`); `.md` and `.html` links both work       | Community `vitepress-plugin-llms` 1.14.0: `llms.txt`, `llms-full.txt`, a `.md` per page, copy buttons           | MiniSearch local built in; Algolia        | Yes                                          | `typedoc-vitepress-theme` 1.1.4               |
| Docusaurus                   | 3.10.2 (2026-07-10); 4.0.0 canaries                                                | 3              | MIT               | Yes (`docs:version`, dropdown, banners)                                   | Markdown and MDX                                                                                            | Community `docusaurus-plugin-llms` 0.6.1                                                                        | Not built in: Algolia, or community local | Yes; GitHub Actions example in its docs      | `docusaurus-plugin-typedoc`                   |
| Material for MkDocs          | 9.8.0 (2026-10-24)                                                                 | 9              | MIT               | Through mike 2.2.0                                                        | Markdown (Python toolchain)                                                                                 | Community `mkdocs-llmstxt` 0.5.1                                                                                | lunr built in                             | Yes                                          | None for TypeScript                           |
| Nextra                       | 4.6.1 (2025-12-04)                                                                 | 1              | MIT               | No built-in feature found                                                 | MDX; Nextra 4 needs the Next.js App Router                                                                  | None found                                                                                                      | Pagefind, run as a post-build step        | Yes (`output: 'export'`, images unoptimized) | None found                                    |
| Fumadocs                     | fumadocs-core 16.17.10 (2026-11-02)                                                | 144            | MIT               | Yes (root folders, or one deployment per version)                         | MDX; Next.js, React Router, TanStack Start or Waku                                                          | Built in: `llms()`; `.md` routes and `Accept` negotiation are app code                                          | Orama-based default; Algolia and others   | Optional; "server-first" by default          | "Auto Type Table" from TypeScript definitions |
| Mintlify                     | CLI 4.2.1190 (2026-11-03)                                                          | 994 (CLI)      | Elastic-2.0 (CLI) | Yes (`versions` in navigation)                                            | MDX                                                                                                         | Automatic `llms.txt`, `llms-full.txt` and `.md` links; MCP on all plans                                         | Hosted                                    | No: hosted; static export is Enterprise-only | Not checked                                   |
| Vocs (used by viem, Foundry) | 2.12.0 (2026-10-26)                                                                | 70             | MIT               | No built-in feature found                                                 | Markdown and MDX                                                                                            | Built in: `llms.txt`, `llms-full.txt`, `.md`; MCP needs a server                                                | Built in                                  | Yes in `full-static` mode, without MCP       | Not checked                                   |

More facts:

- Material for MkDocs entered maintenance mode on 2025-11-11: "we'll continue to fix critical
  bugs and security issues for 12 month at least, no new features …". Its team's successor,
  Zensical, was at 0.0.74 (MIT) on PyPI on 2026-10-30. MkDocs itself has 2.0 development releases;
  1.6.1 is the latest stable.
- Mintlify pricing on 2026-11-03: Starter $0 per month with a custom domain and MCP; Pro $450 per
  month billed annually. Non-commercial open-source projects can apply for free Pro, with
  conditions on funding and ownership.
- Every generator in the table supports i18n (pages exist in each one's docs). explorer-verify does
  not need i18n.
- Repository activity on 2026-11-03: Starlight, VitePress, Docusaurus, Material for MkDocs and
  Fumadocs were pushed in the past week; Nextra was last pushed on 2026-07-31.

### API reference from TSDoc

- TypeDoc 0.28.20 (Apache-2.0, released 2026-07-05) produces HTML and JSON. Markdown output needs
  `typedoc-plugin-markdown` 4.14.1 (CommonMark, GFM, MDX). It supports `@example`, `@remarks`,
  `@throws`, `@deprecated`, `@see`, `@since`, `@defaultValue` and `{@link}`. `sourceLinkTemplate`
  with `{gitRevision}` points source links at a commit or tag. It reads entry points from the
  package's `exports`.
- API Extractor 7.60.1 (MIT, released 2026-10-30) produces an API report, a `.d.ts` rollup and a
  doc model (`.api.json`). api-documenter turns the doc model into Markdown or DocFX.
- **Constraint.** TypeDoc's peer dependency is `typescript` 5.0.x to 6.0.x, and API Extractor
  depends on `typescript` 6.0.3. The repository uses TypeScript 7.0.2. The TypeScript 7.0
  announcement says "it does not ship with an API", that 7.1 is expected "to ship with a new (and
  different) API", and that `@typescript/typescript6` "re-exports the TypeScript 6.0 API",
  installed with npm aliases.

### Hosting

| Fact                 | GitHub Pages                                                                                                                                                         | Cloudflare Pages / Workers static assets                                                  | Netlify                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Cost, eligibility    | Free; on GitHub Free the repository must be public                                                                                                                   | Pages Free: 500 builds a month; static-asset requests on Workers are "free and unlimited" | Free: 300 credits; bandwidth 20 credits per GB; Pro $20/month |
| Size                 | Site at most 1 GB; source repository at most 1 GB, recommended                                                                                                       | Pages Free: 20,000 files, 25 MiB per file                                                 | Not stated on the pricing page                                |
| Bandwidth            | Soft limit of 100 GB a month                                                                                                                                         | Not limited on the Pages limits page                                                      | Credit-based                                                  |
| Deploy               | From a branch, or from an Actions artifact (`upload-pages-artifact`, `deploy-pages`); 10-minute timeout; the 10 builds per hour soft limit does not apply to Actions | Git integration or Wrangler                                                               | Git integration or CLI                                        |
| Custom domain, HTTPS | Yes; HTTPS can be enforced                                                                                                                                           | Yes; 100 custom domains per Pages project on Free                                         | Yes, with SSL                                                 |
| Headers, redirects   | Content types from mime-db, which maps `.md` to `text/markdown` and `.txt` to `text/plain`; no custom headers per a GitHub community reply                           | `_headers` (100 rules) and `_redirects` (2,100)                                           | Configurable                                                  |
| Use limits           | Not for a commercial business or SaaS                                                                                                                                | n/a                                                                                       | n/a                                                           |

Renaming or transferring a repository does not redirect its project site. After a rename, GitHub
redirects "all existing information, with the exception of project site URLs", and recommends a
custom domain for a repository with a GitHub Pages site ("This ensures that the site's URL isn't
impacted by renaming the repository"). After a transfer: "we don't redirect GitHub Pages
associated with the repository." Both pages were read on 2026-11-03.

Inference: GitHub Pages cannot negotiate on `Accept`, so the Markdown copies must be served at
their own URLs. A deployment from an Actions artifact replaces the whole site, so a multi-version
site must rebuild or reassemble every version it keeps on each deploy. GitHub environments can
limit which branches and tags deploy ("Selected branches and tags") and can require reviewers.

## 5. Recommendation for explorer-verify

### Primary: VitePress on GitHub Pages, under a custom domain

- **Host.** GitHub Pages, deployed from an Actions artifact, with a custom domain owned by the
  maintainer. Reason: the repository is public, so the host is free; the site is far below the size
  and bandwidth limits; and the host should serve `.md` as `text/markdown` (mime-db; not tested).
  A custom domain keeps baked-in `docsUrl` values working if the host changes later. A `github.io` project URL is tied to the
  owner and repository name, and GitHub does not redirect it after a rename or a transfer (see
  Hosting above).
- **Generator.** VitePress 1.6.x, with `srcDir` set to `docs/user`. Reason: the same Markdown files
  are rendered on GitHub, shipped raw in the npm package and linked raw from `llms.txt`. VitePress
  needs no frontmatter (it takes the title from the first H1) and resolves relative `.md` links, so
  the pages need no change. Built-in MiniSearch search needs no third-party service. wagmi shows the
  same setup working in this ecosystem.
- **`llms.txt` and `.md` copies.** Generate the site's `llms.txt` from the same source as the root
  and packaged ones, with the existing docs script and a third link target (site URLs). Copy each
  source page next to its HTML as `<page>.md`. This needs no plugin, and the checks that already
  hold for the root `llms.txt` still hold. `vitepress-plugin-llms` is the fallback if a copy button
  and `llms-full.txt` are wanted. Accept-based negotiation is not possible on this host; it is not
  needed, because agents probe for `.md` and `llms.txt`.
- **API reference.** TypeDoc with `typedoc-plugin-markdown` (or `typedoc-vitepress-theme`) runs
  against the TypeScript 6 API through an npm alias to `@typescript/typescript6`. TypeScript 7
  remains the type checker. Turn on `validation.invalidLink`, `notExported` and `notDocumented`,
  plus `treatWarningsAsErrors`. Set `gitRevision` to the release tag. Write the output into the
  site build only, not into `docs/user`, so the npm package size does not change. Revisit when
  TypeScript 7.1 ships its new API.
- **Tested examples.** Extend the existing skill-example test to every `ts` block in `docs/user`:
  type-check against `dist`, then run with recorded explorer answers. Mark blocks that must not run
  with an info string (the rustdoc `no_run` and `ignore` model). Twoslash is optional. It adds hover
  types but costs build time, and the example test already does the type check.
- **Link checks.** Run lychee with `--offline --include-fragments` on the built site in pull request
  CI. Run it online on a weekly schedule.
- **Versioning before 1.0.**
  - The site shows only the latest release, built from the release tag, never from `main`.
  - Each page keeps its `Version:` line. The npm package is the exact-version copy, and jsDelivr
    serves it per version. The site states this and gives the jsDelivr `llms.txt` pattern.
  - Optional: a `/next/` build from `main`, marked "unreleased", with `noindex`.
- **Versioning after 1.0.**
  - One build per major, at `/v1/`, `/v2/`, and so on. The root serves the latest major.
  - Old majors get a banner and a canonical link to the same page in the latest major, where one
    exists (Google's preference over `noindex`).
  - No per-minor sites: semver keeps minors additive, and exact versions stay on jsDelivr and in
    git tags.
  - The deploy workflow rebuilds each kept major from its latest tag. Inference: with fewer than 10
    majors this stays inside the 10-minute deploy limit; this is not measured.
- **`docsUrl` scheme.**
  - Before 1.0: `https://<domain>/reference/errors#<code>`, unversioned, as React and Next.js do.
    Rule: an error code that was ever released keeps its section. A removed code stays as a stub
    that says "Removed in X.Y.Z" and gives the replacement.
  - After 1.0: `https://<domain>/v<major>/reference/errors#<code>`, computed from the package
    version at build time, as Angular does. A 1.x error then keeps resolving after 2.0 ships.
- **How tests prove each `docsUrl` resolves.**
  1. Existing unit test: each code has a section in `errors.md` with `Cause:` and `Fix:` lines.
  2. New unit test: a committed list of every released code (appended in the version pull request)
     must be a subset of the codes with sections. This enforces the stub rule.
  3. New site-build test in pull request CI: for each code, the built errors page contains
     `id="<code>"`, and `docsUrl` with the domain removed maps to a file in the build output.
     lychee `--include-fragments` covers internal links.
  4. Post-deploy smoke step in the Pages workflow: fetch the errors page and its `.md` copy over
     HTTPS, and check status 200 and every `id`. A failure fails the docs workflow and blocks the
     next publish job.
- **Release workflow without agents publishing.**
  - Agents change docs only through pull requests. Pull request CI builds the site and runs the
    checks above, and never deploys (the Docusaurus `test-deploy.yml` pattern).
  - The maintainer's signed `v*` tag triggers the docs deploy job. The `github-pages` environment
    allows only `main` and `v*` tags, optionally with the maintainer as required reviewer.
  - The npm publish job, behind its own approval environment, `needs` the docs job. A version's
    error URLs are then live before its tarball is.
  - A `workflow_dispatch` re-deploy covers docs-only fixes. It builds from the latest tag plus
    cherry-picked docs commits, or from `main` while `main` still matches the latest release.

### Alternative: Starlight on the same host

Starlight is under active development (41 releases in 12 months) and ships Pagefind search. Hardhat
and Astro use it. Its costs for this project:

- Every page needs a `title` in frontmatter.
- Its examples link pages by URL path. Relative `.md` links need a rehype plugin such as
  `astro-rehype-relative-markdown-links` 0.19.2.
- Versioning (`starlight-versions`, "still in early development"), `llms.txt`, `.md` copies and
  TypeDoc each depend on a community plugin.

Choose it if build-time link validation and active upstream development outweigh changing the
source pages.

Not recommended for this project, with the reason:

- Docusaurus: built-in versioning would matter only after 1.0; it has no built-in local search and
  brings a React/MDX toolchain.
- Material for MkDocs: maintenance mode and a Python toolchain.
- Nextra: no stable release since 2025-12-04, and it needs Next.js.
- Fumadocs: server-first by default, and its negotiation and `.md` routes are app code.
- Mintlify: hosted, and a static export needs the Enterprise plan.

A smaller option needs no site at all: keep GitHub as the docs view and pin `docsUrl` to the tag,
`.../blob/v<version>/docs/user/reference/errors.md#<code>`. This is exact and immutable, but it
cannot be tested before the maintainer pushes the tag, and it gives no search or HTML site.

### Trade-offs

- VitePress stable has had no release since 2025-08-05, and 2.0 has been in alpha since
  2025-01-22. vitepress.dev itself runs 2.0.0-alpha.21. A move to 2.0 is likely during this
  project's life (inference).
- Latest-only before 1.0 means the site can describe a newer version than a user has installed.
  The packaged docs and the `Version:` line cover this, as decision 0007 intends.
- An unversioned `docsUrl` before 1.0 requires the stub rule for removed codes. A per-major
  `docsUrl` after 1.0 requires keeping old majors deployed.
- TypeDoc depends on the TypeScript 6 compatibility package until TypeScript 7.1 and a TypeDoc
  release that supports it.
- GitHub Pages has no `Accept` negotiation, no custom headers and no server redirects. Inference:
  redirects must be HTML pages that use a meta refresh.
- An MCP docs server is not possible on a static host. This matches decision 0007, which defers MCP.

### Open questions for the maintainer

1. Buy a custom domain before 0.1.0? Every `docsUrl` baked into 0.1.0 depends on it.
2. Per-code pages (`/reference/errors/<code>`) instead of anchors? An agent that fetches a
   `docsUrl` gets only the section it needs, because fragments are not sent to the server; the
   cost is a split step at build time.
3. Should the release be blocked when the docs deploy fails, or should the docs workflow only
   report?
4. Publish a `/next/` build from `main`, or keep unreleased docs on GitHub only?
5. Generate the API reference at 0.1.0, or wait for TypeScript 7.1 and avoid the compatibility
   package?
6. Bundle `llms-full.txt`? The packaged docs are small; the earlier agent-readiness note judged the
   index enough.
7. Apply to Algolia DocSearch after 1.0, or keep local search?

## Not verified

- Search providers for Stripe, Next.js, Vercel and ethers. Algolia markup on Stripe pages is a
  hint, not proof.
- Whether Stripe's and Cloudflare's API references are generated from their public OpenAPI files.
- Whether Flatworm runs ethers code examples.
- How GitHub Pages serves a `.md` file uploaded from an Actions artifact. The `text/markdown` type is
  inferred from mime-db and an archived GitHub Enterprise page; no live GitHub Pages `.md` URL was
  tested.
- Cloudflare's "Markdown for Agents" size limit: its page says 6 MiB of decompressed HTML; a
  secondary write-up says 2 MB. This note uses the Cloudflare page.
- Whether the React docs test their Sandpack examples in CI.
- Secondary `llms.txt` adoption figures (Rankability, Thunderbit, SE Ranking): methods not checked.

## Sources

Read on 2026-11-03 unless noted. Command results: curl 8.7.1, npm 11.19.0 and gh 2.92.0, run on
2026-11-03.

Exemplary sites:

- [Stripe: Agents and AI](https://docs.stripe.com/building-with-llms), [API versioning](https://docs.stripe.com/api/versioning), [changelog](https://docs.stripe.com/changelog), [upgrades](https://docs.stripe.com/upgrades), [stripe/openapi](https://github.com/stripe/openapi), [Markdoc](https://markdoc.dev/)
- [Cloudflare: AI consumability](https://developers.cloudflare.com/style-guide/how-we-docs/ai-consumability/), [Our site](https://developers.cloudflare.com/style-guide/how-we-docs/our-site/), [content types](https://developers.cloudflare.com/style-guide/documentation-content-strategy/content-types/), [changelog](https://developers.cloudflare.com/changelog/)
- [Next.js `llms.txt`](https://nextjs.org/docs/llms.txt), [upgrading](https://nextjs.org/docs/app/guides/upgrading), [Next.js `is-error.ts`](https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/is-error.ts)
- [Astro: Build with AI](https://docs.astro.build/en/guides/build-with-ai/), [withastro/docs](https://github.com/withastro/docs), [v5 docs](https://v5.docs.astro.build/en/getting-started/)
- [Tailwind upgrade guide](https://tailwindcss.com/docs/upgrade-guide), [tailwindcss.com repository](https://github.com/tailwindlabs/tailwindcss.com)
- [React versions](https://react.dev/versions), [react.dev repository](https://github.com/reactjs/react.dev), [React `formatProdErrorMessage.js`](https://github.com/facebook/react/blob/main/packages/shared/formatProdErrorMessage.js), [React 19 upgrade guide](https://react.dev/blog/2024/04/25/react-19-upgrade-guide)
- [Node.js doc-kit](https://github.com/nodejs/doc-kit), [Node.js changelogs](https://github.com/nodejs/node/tree/main/doc/changelogs)
- [docs.rs redirections](https://docs.rs/about/redirections), [rustdoc documentation tests](https://doc.rust-lang.org/rustdoc/write-documentation/documentation-tests.html), [mdbook test](https://rust-lang.github.io/mdBook/cli/test.html), [Rust releases](https://doc.rust-lang.org/releases.html)
- [viem migration guide](https://viem.sh/docs/migration-guide), [Vocs `llms.txt`](https://vocs.dev/llms.txt), [Vocs agent support](https://vocs.dev/features/agent-support.md), [Vocs MCP server](https://vocs.dev/features/mcp-server.md), [Vocs render strategies](https://vocs.dev/features/render-strategies.md), [Vocs Twoslash](https://vocs.dev/docs/guides/twoslash), [viem site `package.json`](https://github.com/wevm/viem/blob/main/site/package.json)
- [wagmi site `package.json`](https://github.com/wevm/wagmi/blob/main/site/package.json), [wagmi VitePress config](https://github.com/wevm/wagmi/blob/main/site/.vitepress/config.ts), [migrate from v2 to v3](https://wagmi.sh/react/guides/migrate-from-v2-to-v3)
- [Hardhat getting started](https://hardhat.org/docs/getting-started), [hardhat-website `package.json`](https://github.com/NomicFoundation/hardhat-website), [migrate from Hardhat 2](https://hardhat.org/docs/migrate-from-hardhat2)
- [ethers `docs.wrm`](https://github.com/ethers-io/ethers.js/tree/main/docs.wrm), [ethers v6 migrating](https://docs.ethers.org/v6/migrating/)
- [Sourcify `llms.txt`](https://docs.sourcify.dev/llms.txt), [sourcifyeth/docs](https://github.com/sourcifyeth/docs)
- [Angular `error_details_base_url.ts`](https://github.com/angular/angular/blob/main/packages/core/src/error_details_base_url.ts)

Practices:

- [Diátaxis](https://diataxis.fr/), [Write the Docs: Docs as Code](https://www.writethedocs.org/guide/docs-as-code/)
- [Google developer documentation style guide](https://developers.google.com/style), [highlights](https://developers.google.com/style/highlights), [accessibility](https://developers.google.com/style/accessibility), [Microsoft Writing Style Guide](https://learn.microsoft.com/en-us/style-guide/welcome/)
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- [lychee](https://lychee.cli.rs/), [lychee repository](https://github.com/lycheeverse/lychee), [Vale](https://github.com/vale-cli/vale), [Vale packages](https://github.com/errata-ai/packages)
- [llmstxt.org](https://llmstxt.org/), [Common Crawl `llms.txt` analysis (2026-08-31)](https://commoncrawl.org/blog/a-content-analysis-of-llms-txt-files-from-the-july-2026-crawl-archive), [Ahrefs `llms.txt` study (2026-06-15)](https://ahrefs.com/blog/llmstxt-study/), [Rankability report](https://www.rankability.com/llms-report/) (secondary, method not checked)
- [Cloudflare Markdown for Agents](https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/), [Fumadocs AI and LLMs](https://www.fumadocs.dev/docs/integrations/llms)
- [Pagefind](https://pagefind.app/), [Algolia DocSearch eligibility](https://docsearch.algolia.com/docs/who-can-apply/)

Versioning:

- [Docusaurus versioning](https://docusaurus.io/docs/versioning), [Read the Docs versions](https://docs.readthedocs.com/platform/stable/versions.html), [Read the Docs canonical URLs](https://docs.readthedocs.com/platform/stable/canonical-urls.html), [Material for MkDocs versioning](https://squidfunk.github.io/mkdocs-material/setup/setting-up-versioning/)
- [Google: consolidate duplicate URLs](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls), [SemVer](https://semver.org/), [RFC 3986 section 3.5](https://www.rfc-editor.org/rfc/rfc3986#section-3.5)
- curl, 2026-11-03: `v19.angular.dev`, `v20.angular.dev` and `next.angular.dev`
- curl, 2026-11-03: canonical and robots tags on Next.js, Node.js, React 18, Astro v5 and wagmi 1.x pages; `x-robots-tag` and `cache-control` on docs.rs; jsDelivr and unpkg headers for `vitepress@1.6.4/README.md`

Generators and API reference:

- [Starlight site search](https://starlight.astro.build/guides/site-search/), [plugins](https://starlight.astro.build/resources/plugins/), [frontmatter](https://starlight.astro.build/reference/frontmatter/), [authoring content](https://starlight.astro.build/guides/authoring-content/), [starlight-versions](https://starlight-versions.vercel.app/getting-started/), [starlight-llms-txt](https://delucis.github.io/starlight-llms-txt/)
- [VitePress: what is VitePress](https://vitepress.dev/guide/what-is-vitepress), [search](https://vitepress.dev/reference/default-theme-search), [routing](https://vitepress.dev/guide/routing), [site config](https://vitepress.dev/reference/site-config), [vitepress-plugin-llms](https://github.com/okineadev/vitepress-plugin-llms)
- [Docusaurus search](https://docusaurus.io/docs/search), [deployment](https://docusaurus.io/docs/deployment)
- [Material for MkDocs blog](https://squidfunk.github.io/mkdocs-material/blog/), [site search](https://squidfunk.github.io/mkdocs-material/setup/setting-up-site-search/), [Zensical](https://zensical.org/)
- [Nextra](https://nextra.site/docs), [Nextra search](https://nextra.site/docs/guide/search), [Nextra static exports](https://nextra.site/docs/guide/static-exports)
- [Fumadocs navigation and versioning](https://www.fumadocs.dev/docs/navigation), [Fumadocs static build](https://www.fumadocs.dev/docs/deploying/static)
- [Mintlify `llms.txt`](https://www.mintlify.com/docs/ai/llmstxt), [pricing](https://www.mintlify.com/pricing), [navigation](https://www.mintlify.com/docs/navigation), [Mintlify docs index](https://www.mintlify.com/docs/llms.txt) (static export note)
- [TypeDoc output options](https://typedoc.org/documents/Options.Output.html), [input options](https://typedoc.org/documents/Options.Input.html), [validation options](https://typedoc.org/documents/Options.Validation.html), [doc comments](https://typedoc.org/documents/Doc_Comments.html), [tags](https://typedoc.org/documents/Tags.html)
- [API Extractor](https://api-extractor.com/pages/overview/intro/), [api-documenter on npm](https://www.npmjs.com/package/@microsoft/api-documenter)
- [Announcing TypeScript 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
- npm registry, 2026-11-03: `npm view` versions, `time`, licences, dist-tags and peer dependencies for `@astrojs/starlight`, `vitepress`, `@docusaurus/core`, `nextra`, `fumadocs-core`, `mintlify`, `typedoc`, `@microsoft/api-extractor`, `@microsoft/api-documenter`, `starlight-typedoc`, `typedoc-plugin-markdown`, `typedoc-vitepress-theme`, `starlight-llms-txt`, `vitepress-plugin-llms`, `docusaurus-plugin-llms`, `starlight-versions`, `vocs`, `pagefind`, `astro-rehype-relative-markdown-links`. PyPI JSON API for `mkdocs-material`, `mkdocs`, `mike`, `mkdocs-llmstxt`, `zensical`. GitHub API for repository licence and last push.

Hosting:

- [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits), [publishing source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site), [about GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/about-github-pages), [creating a site](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site), [HTTPS](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https), [MIME types (Enterprise Server 2.14, archived)](https://docs.github.com/en/enterprise/2.14/user/articles/mime-types-on-github-pages), [community reply on content types](https://github.com/orgs/community/discussions/22863), [mime-db](https://github.com/jshttp/mime-db)
- [Renaming a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository), [transferring a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository)
- [GitHub deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [Cloudflare Pages limits](https://developers.cloudflare.com/pages/platform/limits/), [Workers static assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)
- [Netlify pricing](https://www.netlify.com/pricing/)
