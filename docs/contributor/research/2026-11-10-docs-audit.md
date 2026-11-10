# Docs site audit: UX review, persona walkthroughs and a benchmark

Date: 2026-11-10. Scope: epic [#303](https://github.com/aelmanaa/explorer-verify/issues/303). How
easy is the docs site of explorer-verify 0.1.0 to enter, how long does each kind of reader take to
reach a working dry run, and what do well-regarded SDK and CLI docs sites do that ours does not?

The note has three parts: a UX review of the published site (findings F1 to F20, which the child
issues of #303 cite), a walkthrough of each persona's first task, and a benchmark of twelve docs
sites with a proposed information architecture.

## Method

- **UX review.** The published site <https://aelmanaa.github.io/explorer-verify/>, built from
  0.1.0, opened in Playwright Chromium at 1440×900 (desktop) and 390×844 (mobile), in the light and
  dark themes, on 2026-11-10. A script measured page height, prose words, paragraph length, code
  blocks, horizontal scroll, contrast and console errors on 75 pages, and ran the site search. The
  sources read alongside: `docs/user/`, `site/.vitepress/config.ts`, `scripts/site-docs.ts` and
  `site/api-reference.ts` at commit `9d55a2a`.
- **Persona walkthroughs.** One run per persona on 2026-11-10, against the live site and the npm
  packages at 0.1.0, each in a fresh project. The target was a dry run against a Greeter contract
  on Sepolia, `0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc`, which Sourcify had already verified, so
  every dry run prints `lookup: exact`. Minutes are estimates for a human reader.
- **Benchmark.** Twelve docs sites fetched on 2026-11-10 with Playwright 1.64.1 (private headless
  Chromium, 1440×900, 3.5 s settle) and `curl -sL` for `llms.txt`, `llms-full.txt` and the `.md`
  copies. Details are under [Benchmark method](#benchmark-method).

## UX review

### Measurements

Desktop screens are page height divided by 900. "Screens to first call" is how far a reader
scrolls before the first `verify()` or CLI call.

| Page                | Screens (mobile) | Prose words | ¶ > 60 words | Longest ¶ | Longest prose run | Code blocks/lines | Callouts | Screens to first call |
| ------------------- | ---------------- | ----------- | ------------ | --------- | ----------------- | ----------------- | -------- | --------------------- |
| Landing             | 3.7 (6.4)        | 171         | 0            | 55        | 134               | 0                 | 0        | none                  |
| Tutorial            | 18.6 (26)        | 1875        | 9            | 95        | 265               | 17/323            | 0        | 8.4                   |
| Browser guide       | 10.5 (17)        | 1567        | 12           | 193       | 285               | 6/61              | 0        | 2.5                   |
| CLI reference       | 26.6 (46)        | 2755        | 15           | 170       | 945               | 13/21             | 0        | 0.7                   |
| verify()            | 19.6 (34)        | 2421        | 13           | 110       | 549               | 12/100            | 0        | n/a                   |
| Core entry          | 4.8 (7.6)        | 475         | 2            | 108       | 149               | 3/32              | 0        | n/a                   |
| source-mismatch     | 1.2 (1.8)        | 199         | 1            | 76        | 199               | 0                 | 0        | n/a                   |
| Wrapper guide       | 20.7 (30)        | 1203        | 7            | 84        | 185               | 8/350             | 0        | 1.5                   |
| Match types         | 4.8 (7.9)        | 556         | 4            | 123       | 197               | 0                 | 0        | n/a                   |
| Routing             | 13.3 (22)        | 1958        | 10           | 146       | 280               | 8/42              | 0        | n/a                   |
| API explorer-verify | 160              | –           | –            | –         | –                 | –                 | 0        | 70 outline entries    |

- Code blocks that scroll horizontally on desktop: tutorial 10 of 17, CLI 11 of 13, CI guide 8 of
  10, `verify()` 7 of 12, wrapper 5 of 8, browser 1 of 6, Node 3 of 6, core 1 of 3.
- Wide tables on mobile: routing 923px, core 609px, wrapper 567px, API keys 532px, `verify()`
  509px. They scroll inside their box; no page overflows.
- Contrast: body text 10.9:1 (light) and 12.8:1 (dark), inline code 7.1 and 8.5, outline links 5.6
  and 6.0, all passing. The code language label measured 2.87:1 and 3.37:1 at 12px, below the
  4.5:1 of WCAG 2.2 AA.
- Search: "quickstart" returns nothing; "getting started" returns noise; "etherscan key" ranks the
  API keys page fourth; "install" has no single page.
- Links: 1,599 internal links, none broken. Only the API reference's "Defined in" links into
  `node_modules` return 404.
- Console: no errors on 75 pages.

### Findings

- **F1 Critical, landing page** (`docs/user/README.md`). No pitch, no next step, no routing by
  reader. A 31-row table in writing order; on mobile the first screen shows 4 rows. Fix: a home
  page with a one-line pitch, a three-line CLI dry run, Quickstart and "Choose your setup"
  buttons, a grid of personas (browser dapp, Node, CLI and CI, Foundry, Hardhat, tool author,
  agent) and a package table, without the full index.
- **F2 Critical, no quickstart.** The only beginner page is 18.6 screens long, and its first
  `verify()` comes at screen 8.4. Fix: one quickstart per persona, each under one screen (you need,
  install, dry run, expected output, real run, next steps), in a "Get started" group listed first.
- **F3 Critical, the packages are never presented.** No page lists the four packages; `cli.md` has
  no install line; the API index lists 16 bare module paths. Fix: a packages page (package,
  purpose, runtime, install, when to use), shown on the landing page; module descriptions in
  `site/api-reference.ts`; an install block at the top of `cli.md`.
- **F4 High, the sidebar is sorted by file name**, and the 13 guides form one flat list, so "Run
  the server handler" comes first. Fix: an explicit order. Get started (overview, packages,
  quickstarts, tutorial); guides by setup (Node.js, browser, CLI in CI, Foundry, Hardhat, edge);
  guides by task (proxy, key on a server, from bytecode, npm-package contracts, contracts a package
  ships); advanced (wrapper, core entry and bundle size, routing, logging); reference (`verify()`,
  `checkStatus()`, CLI, JSON output, API keys, server handler, an Explorers group, an Errors
  group); concepts (match types, Etherscan plans). Short labels.
- **F5 High, the Verify section of `cli.md`**: 945 words in 13 bullets, each with 5 to 15 code
  spans; the page is 26.6 screens (46 on mobile). Fix: install, usage, five captioned examples, an
  options table, then details; consider separate pages for `verify`, `status` and the output.
- **F6 High, density.** 78 paragraphs over 60 words (the longest 193); counts in prose; one
  paragraph with 17 code spans. Fix: a style rule that the docs check enforces: at most about 60
  words or 3 sentences per paragraph, at most 4 code spans per sentence, 3 or more facts as a list
  or table, dates and research links in a closing Sources section. Start with the routing table,
  the browser guide's Setup and Bundle size, and the CLI's Verify section.
- **F7 High, a boilerplate header on 57 of 58 pages** (`Version:`, `Agents:`, `Audience:`). Fix:
  drop the version and agents lines on the HTML site only; put `llms.txt` in the nav or footer;
  turn the audience line into a `> [!NOTE]` "Who this is for / You need".
- **F8 High, guides lack prerequisites.** 4 of 13 guides have a Setup section; the tutorial's
  prerequisites sit in its fourth paragraph. Fix: a template with a goal line, "You need", a time
  estimate, numbered step headings and next steps.
- **F9 High, the tutorial is too long** (17 blocks, 323 lines, first `verify()` at screen 8.4)
  and ends with maintainer content. Fix: quickstarts first; split it into "verify from a browser"
  (prebuilt address and input) and "deploy, verify and use a server"; move "How the examples are
  tested" to the contributor testing doc.
- **F10 Medium, no callouts anywhere.** Fix: GitHub alerts `[!WARNING]`, `[!TIP]`, `[!NOTE]`.
- **F11 Medium, error pages bury the fix.** The cause runs 76 words before the fix; code is
  unformatted; there is no handling example. Fix: a summary; a facts table (exit code, retryable,
  sent to the explorer or not); "How to fix" first; then "Why"; then a five-line `error.code`
  check.
- **F12 Medium, the Errors group sits between Guides and Reference**, and `errors/index.md` has
  three H3 headings before its first H2. Fix: move Errors under or after Reference; add an H2
  "Handle an error".
- **F13 Medium, code blocks scroll.** 52 of 102 sampled blocks scroll on desktop; file names
  appear only in prose. Fix: one flag per line with `\`, TypeScript within 80 columns, titled
  blocks (` ```ts [path] `), and optionally wrapping on mobile through theme CSS.
- **F14 Medium, reference pages put details first.** `verify()` has 549 words before Options;
  routing opens with statistics; "Tested live" notes and research sit in user pages. Fix:
  signature, purpose, a minimal example, tables of options, results and errors, then details, then
  Sources.
- **F15 Medium, the API reference.** The `/api/explorer-verify` page is 144,742px tall with 70
  outline entries, opens with `ExplorerVerifyError`, and its "Defined in" links return 404. Fix:
  one page per member (typedoc-plugin-markdown `outputFileStrategy: "members"`), functions first
  (`groupOrder`), no source links for external or inherited members, module descriptions on the
  index.
- **F16 Medium, search ranking.** Fix: MiniSearch `searchOptions` that boost the title, a
  `boostDocument` that ranks guides and quickstarts up and `api/` down, and quickstart and install
  pages so that those queries find something.
- **F17 Low, the nav** has only "API reference" and a "Version 0.1.0" item that links home. Fix:
  Get started, Guides, Reference, API, and a version menu with the changelog and npm.
- **F18 Low, the code language label fails AA contrast.** Fix: theme CSS
  `--vp-code-lang-color: var(--vp-c-text-2)`.
- **F19 Low, contributor content at the bottom of the landing page**: the Diátaxis
  planned-first-page table and the jsDelivr and `.md` notes. Fix: move them to the contributor
  docs or an "About these docs" page.
- **F20 Low, the default 404 page.** Fix: links to the quickstarts and search.

Constraint: [decision 0015](../decisions/0015-docs-site-versioning-and-error-pages.md) keeps
frontmatter, Vue and `:::` containers out of `docs/user/`. Fixes therefore use GitHub-compatible
Markdown (`> [!NOTE]` alerts, ` ```ts [file] ` titles) or the site config and scripts. A
`layout: home` landing page needs a site-only page, which needs a decision that amends 0015.

### What works

No broken internal links, no console errors, no page wider than a phone screen, a copy button and
a language label on every code block, an outline and previous and next links on every page, good
body contrast. Search finds the right page for "cli", "verify proxy", "hardhat" and "foundry".

### What the screenshots showed

The review took 27 screenshots. In words:

- Landing page, desktop light and full height: the sidebar opens with a Tutorials group, then
  thirteen guides sorted by file name, a collapsed Errors group, then Reference. The page itself
  opens with "Version: explorer-verify 0.1.0", "Agents: llms.txt lists every page of these docs"
  and an audience line, then a long two-column table of pages. The bottom of the page holds
  maintainer notes.
- Tutorial, browser guide, CLI reference, `verify()`, core entry, wrapper guide, match types,
  routing and the errors index, top of page: each opens with the same version and agents lines,
  then a long paragraph before any heading or code.
- An error page (`source-mismatch`): the code as the title, the header lines, then a paragraph of
  cause before the fix.
- Landing page on mobile: the header lines and the audience line fill most of the first screen;
  four rows of the page table are visible.
- CLI reference, routing table, API keys table and Node guide on mobile: long pages; wide tables
  scroll sideways inside their box.
- The mobile sidebar, open: a long list of guide titles that wrap over two lines each.
- Node guide, `verify()` reference and the tutorial in the dark theme: readable body text; the
  small language label in the corner of each code block is faint.
- Search for "browser", "etherscan key" and "quickstart": "etherscan key" lists
  "Etherscan-compatible explorers > API key" first, Routescan's API key section second, the
  Etherscan page third and the API keys page fourth; "quickstart" shows no results.
- The API reference index and the `explorer-verify` module page: a bare list of module paths, and
  a very long page that opens with the error class.
- The bottom of the landing page: the maintainer table of planned first pages.
- The CLI reference's Verify section: a wall of long bullets, each dense with code spans in flags
  and values.
- The 404 page: VitePress's default, with "PAGE NOT FOUND", a quote and a single "Take me home"
  link.

## Persona walkthroughs

Every persona reached a dry run. Only the CLI in CI came near 5 minutes, after a workaround.

| Persona          | Minutes                 | Package named, and why? | Top blocker                                                                        |
| ---------------- | ----------------------- | ----------------------- | ---------------------------------------------------------------------------------- |
| Browser dapp     | ~15 (30+ via tutorial)  | yes                     | The browser guide has no `dryRun()`; the tutorial needs a wallet deploy first      |
| Node script      | ~12                     | yes                     | The first example is a ~100-line service with an undefined `input`, and no dry run |
| DevOps CLI in CI | ~6                      | yes                     | `explorer-verify: command not found` after a local install; no `npx` anywhere      |
| Foundry          | ~8                      | partly                  | The CLI section never says that the command is in `@explorer-verify/cli`           |
| Hardhat          | ~8                      | partly                  | The same; no answer to "plugin, or hardhat-verify?"                                |
| SDK author       | ~18                     | yes, after a long read  | Two candidate guides; the wrap guide's first ~260-line example submits as written  |
| AI agent         | ~4 (after ~6,000 words) | yes                     | The site's `llms.txt` does not list the skill; the npm package's `llms.txt` does   |

### Blockers across personas

1. The landing page routes no one: no "what it does", no install, no package list, no start per
   reader. The first screen shows `Version:`, `Agents: llms.txt` and an audience line, then a
   32-row table in writing order and maintainer text ("Pages land with the features they
   describe", a "Planned first page" column). On mobile the first screen shows only header lines.
2. The four packages are never introduced together. The landing page names none of `cli`,
   `foundry` and `hardhat`. The npm README of `explorer-verify` is a better entry.
3. `dryRun()` appears only on the agent page and in `reference/verify.md#dry-run`. The browser,
   Node, Foundry, Hardhat, wrap and package guides show only `verify()`, often commented out.
4. CLI commands omit `npx`: after a local install, `explorer-verify ...` fails with exit status 127. `npx -y @explorer-verify/cli` works and is not documented.
5. Examples use an undefined `input` (browser guide, Node guide, core reference).
6. Stale text in the browser guide: "Not tested: the package is not on npm yet, so no CDN serves
   it". esm.sh serves `explorer-verify@0.1.0` with status 200.
7. Jargon comes before its definition, and there is no glossary: backend, route, `routedBy`,
   routing table, handle (defined in check-status), envelope (in json-output), lookup.
8. Density: the CLI reference has 7,058 words, the `verify()` reference 4,895, the wrap guide
   4,006, the tutorial 3,890. Source citations with read dates sit inline in user prose.
9. Sidebar: Guides (13, sorted by file name), then Errors (27 links, expanded) between Guides and
   Reference.
10. Smaller: the Foundry and Hardhat guides use Anvil's `0x5FbD…0aa3`, so a Sepolia dry run reads
    `lookup: none` ("would submit"); the core entry with neither a table nor `route.backend` throws
    "The options are invalid: table." without saying what to pass; the Hardhat deploy-profile
    warning comes after the examples.

### Paths

- **Browser dapp:** landing page, tutorial (needs Foundry, a bundler, a wallet and Sepolia ETH;
  backtracked), browser guide (no dry run, undefined `input`), the `verify()` reference for
  `dryRun`, tutorial step 1 for `Greeter.verify.json`. Bundled with esbuild and run in Chromium:
  dry run on Sourcify, `exact`.
- **Node script:** landing page, Node guide (a queue and logger service first), the package guide
  for `buildVerifyInput`, the `verify()` reference for `dryRun`. `exact`.
- **DevOps CLI in CI:** landing page, CI guide, install, `forge build --build-info`, dry run,
  `command not found`, then `npx`. The output matched the documented envelope byte for byte. The
  best-structured guide.
- **Foundry:** landing page, Foundry guide. The install step is a sentence with no command block.
  The library example works without a dry run. The CLI section fails with `command not found`
  until the CLI package name turns up in the CI guide.
- **Hardhat:** the same with a Hardhat 3 project. The example prints
  `project/contracts/Greeter.sol:Greeter` as documented. The CLI dry run needed
  `@explorer-verify/cli`.
- **SDK author:** landing page, then both "Wrap…" and "Verify contracts your package ships" to
  choose between, the wrap guide (skipping the 260-line submitting block), "Ship only the clients
  your tool uses", the core reference. `dryRun` from `explorer-verify/core` worked with `sourcify()`
  plus `routingTable`, and with `route.backend`.
- **AI agent:** the site's `llms.txt` (about 60 links, the agent page third), the agent page (clear
  safe and outward rules, dry run first), the skill on GitHub, `buildVerifyInput` and
  `validateInput`, then `npx explorer-verify verify --input-json verify-input.json --dry-run
  --json`. The best-served persona, at a high context cost.

Not covered by the walkthroughs: screenshots and the dark theme.

## Benchmark: SDK and CLI documentation sites

### Benchmark method

- Each page was loaded in a private headless Chromium (Playwright 1.64.1, 1440×900, 3.5 s settle).
  A script counted `<pre>` blocks and their lines, the words and length of each `<p>`, the
  `role=tab` labels, the copy buttons, the callout elements and the AI-related buttons.
- `llms.txt`, `llms-full.txt` and the `.md` copies were fetched with `curl -sL`. The HTTP status is
  recorded below.
- Numbers are per page as rendered. "Prose words" counts `<p>` text only, not lists or tables.
  "Avg / max para" is words per paragraph. They are comparable across sites, not exact.
- wagmi.sh pages after the landing rendered client-side and did not settle in the headless run, so
  wagmi page anatomy comes from its `.md` copy (VitePress source).

### 1. Summary: the patterns to adopt

1. **The landing page answers "what is it" in one line, shows working code, then routes.** viem,
   AI SDK and Tailwind put a one-line value statement, an install command and a short code sample
   above the fold. Stripe, Supabase, Resend and Etherscan follow it with a grid of cards: one card
   per use case or framework, each linking a quickstart. Our landing page opens with
   `Version:`, `Agents:`, `Audience:` and a 33-row table. It has no code and no routing by
   situation.
2. **There is one quickstart per entry point, each short, with the same shape.** Resend lists 15
   per-language quickstarts on its introduction page. AI SDK, Supabase, Stripe and Tailwind do the
   same per framework. The best ones (Resend Node.js, Etherscan "Make your first call", Foundry
   getting started, viem getting started) use 2 to 5 steps, 2 to 6 code blocks and under 120
   prose words. Their paragraphs average 6 to 19 words.
3. **Each package is a section, not a page.** wagmi's top nav is `React | Core | Tempo | CLI`. Each
   package has the same sidebar: Introduction, Guides, Configuration, then the API (Hooks, Actions
   or Commands). Supabase adds a "which package to use" page to decide between `supabase-js`,
   `@supabase/ssr` and `@supabase/server`. Foundry's getting-started page opens with a table of its
   four tools, each with a purpose and a reference link.
4. **The sidebar is curated, not alphabetical.** It reads Getting started, then guides by task,
   then advanced material, then the reference. Hardhat: Getting started, Tutorial, Guides,
   Cookbook, Reference, Explanations. AI SDK: Foundations, Getting Started, then per-module
   sections, then Advanced, Reference, Migration Guides, Troubleshooting. Our sidebar sorts each
   folder by file name, so "Run the server handler" comes first under Guides.
5. **Pages are dense in code and sparse in prose.** Average paragraph length at the benchmarks:
   6 to 25 words. Ours: 35 to 49 words, with paragraphs up to 193 words. Every benchmark uses
   callouts (tip, note, warning). We use none.
6. **Code blocks have tabs and titles.** Package-manager tabs (npm, pnpm, yarn, bun) appear on
   viem, wagmi, AI SDK, Hardhat and Resend. File-name titles appear on wagmi (`[config.ts]`) and
   Hardhat ("Terminal window"). Line highlights appear on AI SDK (66 lines on one quickstart) and
   Tailwind. Every site has copy buttons.
7. **The docs are built for agents.** 11 of the 12 sites serve `llms.txt`; Tailwind's returns 404.
   Most serve a `.md` copy of each page. Seven show a "Copy page" or "Copy for LLM" button. Several
   publish a page for agents: Foundry "Foundry documentation for agents", Resend "AI onboarding",
   Hardhat "Build with AI", Etherscan "Build with AI", AI SDK "Coding Agents". Some quickstarts give
   a ready prompt: Resend "Use this pre-built prompt", Supabase "Agent Prompt". We already serve
   `llms.txt` and `.md` copies. We lack the copy button and an agent quickstart that is short
   enough to paste.
8. **The reference page anatomy repeats on every page.** viem actions: Usage, Returns, Parameters
   (each with its own example), Tips, JSON-RPC method. Supabase methods: Parameters, then up to 15
   named examples. AI SDK: Import, API signature, Parameters, Returns, Examples. Stripe and Resend
   generate the reference from OpenAPI and show a request example per language.

### 2. Per-site findings

#### viem: <https://viem.sh/> (fetched 2026-11-10, Vocs)

- **Landing.** "Build reliable apps & libraries with lightweight, composable, and type-safe modules
  that interface with Ethereum". Buttons "Get started" and "Why Viem?". An install line with
  npm/pnpm/bun tabs. Four feature tiles (Modular, Lightweight, Performant, Typed APIs). An 11-line
  "Overview" code sample with numbered comments (`// 1. Import modules.`, `// 2. Set up your
  client`, `// 3. Consume an action!`). The page does not route by persona. The top nav splits
  products: Docs, Tokens, Tempo, Extensions.
- **IA.** Sidebar groups: Introduction (Why Viem, Installation, Getting Started, Platform
  Compatibility, FAQ), Guides (migration, TypeScript, Error Handling, feature guides), then API
  groups by concept (Clients & Transports, Public Actions, Wallet Actions, Test Actions, Accounts,
  Chains, Contract, ENS, SIWE, ABI, Utilities), then Glossary. Getting started and guides sit
  together near the top. The reference forms most of the sidebar.
- **Quickstart** (`/docs/getting-started`). Sections: Overview, Installation, Quick Start (steps
  "1. Set up your Client & Transport" and "2. Consume Actions"), Live example. 5 code blocks,
  19 code lines, 115 prose words. Average paragraph 19 words, longest 34. Tabs npm/pnpm/bun.
  One production-RPC callout. Time to first success: one install plus about 10 lines.
- **Anatomy.** Short paragraphs, numbered step headings, a live example (StackBlitz embed).
- **API reference.** Hand-written, one page per action (`getBalance`): a one-line description,
  Usage with `example.ts` and `client.ts` file tabs, Returns, Parameters (each parameter has its
  own code example), Tips, JSON-RPC Method. 8 code blocks, average paragraph 8 words.
- **AI.** `llms.txt` 200 (64 KB index with one-line descriptions), `llms-full.txt` 200 (2.5 MB),
  `.md` copies 200. Buttons "Copy page for AI" and "Ask AI... ⌘ I".

#### wagmi: <https://wagmi.sh/> (fetched 2026-11-10, VitePress)

- **Landing.** "Reactivity for Ethereum apps. Type Safe, Extensible, and Modular by design." Buttons
  "Get Started", "Why Wagmi", "View on GitHub". Six feature cards, each ending in a link ("See all
  hooks", "See all connectors", "Learn about Wagmi Core", "Check out Viem"). A banner at the top
  links the 2.x docs.
- **IA.** The top nav is per package: React, Core, Tempo, CLI, Frameworks. `llms.txt` repeats the
  same sidebar skeleton for each package: Introduction, Guides, Configuration, then
  Hooks/Composables/Actions/Commands, then Miscellaneous. The React sidebar: Introduction (Why
  Wagmi, Installation, Getting Started, TypeScript, Comparisons), Guides (TanStack Query, Viem,
  Error Handling, SSR, Connect Wallet, Send Transaction, Read from Contract, Write to Contract, FAQ,
  migrations), Configuration (createConfig, Chains, Connectors, Transports), Hooks (one page each).
- **Quickstart** (`/react/getting-started.md`). Overview, Automatic Installation (`create wagmi` in
  a 4-tab `::: code-group`), Manual Installation (a 4-tab code group, a bullet list saying why each
  dependency is needed), then Create Config, Wrap App in Context Provider, Setup TanStack Query and
  Use Wagmi, each with a titled file block (` ```ts [config.ts] `).
- **Anatomy.** VitePress code groups and file titles throughout. Steps are H3 headings.
- **API reference.** Hand-written per hook: Import, Usage, Parameters, Return Type, Action link.
- **AI.** `llms.txt` 200 (40 KB, a table of contents per package), `llms-full.txt` 200 (3.6 MB),
  `.md` copies 200, a "Copy page" button. This is the closest analogue to our stack: VitePress,
  several packages, a CLI.

#### Stripe: <https://docs.stripe.com/> (fetched 2026-11-10)

- **Landing.** H1 "Documentation", then "Explore our guides and examples to integrate Stripe."
  Cards: "Get started with Stripe", "Explore all products". Groups by job: Payments (accept online,
  invoices, in person), Revenue, Developers ("Set up your development environment", "Build on
  Stripe with AI", "Integration quickstarts"). A "Try it out" block of runnable API calls, test
  card `4242 4242 4242 4242`.
- **IA.** Top nav by product area (Payments, Revenue, Risk, Data, Money management, …) plus
  "Developer resources" and "APIs & SDKs". `/get-started` holds START BUILDING (Create an account,
  Quickstarts, Start developing, Build with agents, Use Stripe without code, Migrate) and COMMON USE
  CASES (persona cards: "Accept simple payments as a startup", "Sell subscriptions as a SaaS
  startup").
- **Quickstart** (`/payments/quickstart`). Language selectors at the top: "Frontend: HTML React"
  and "Backend: Ruby Node.js PHP Python Go .NET Java". The chosen pair drives the whole page. The
  page has a split layout: numbered steps on the left, a code panel on the right that follows the
  step, and a "Download example" button. It is long: 25 H3 steps, 1,086 prose words, average
  paragraph 23 words. A text-only version is offered ("View the text-based guide"). It ends with
  "Congratulations!" and next steps.
- **Anatomy.** Typed callouts ("Protect your Session-creation endpoint", "Note").
- **API reference.** Generated from OpenAPI. Each resource page has a description, Attributes,
  Parameters ("More parameters, Expand all"), Returns, and request and response examples per
  language. Its own sidebar: Introduction, Authentication, Errors, Pagination, Versioning, then
  resources.
- **AI.** `llms.txt` 200 (99 KB; it opens with instructions to agents), `llms-full.txt` 404, `.md`
  copies 200. Buttons "Ask AI", "Copy for LLM", "View as Markdown", "Read llms.txt", "Set up
  agent". A "Build with agents" page sits in Get started.

#### Vercel AI SDK: <https://ai-sdk.dev/> (fetched 2026-11-10)

- **Landing.** "Universal AI layer for building frameworks and agents". A "For humans / For agents"
  toggle above `npm install ai`. A titled code sample (`generate-text.ts`) with tabs AI Gateway,
  Provider, Custom, and its output. Usage stats, then a framework strip (Next.js, React, Svelte, …).
- **IA.** Sidebar: AI SDK by Vercel (intro), Foundations, Getting Started, Agents, AI SDK Core, AI
  SDK Harnesses, AI SDK UI, AI SDK RSC, Advanced, Reference, Migration Guides, Troubleshooting.
  Getting started, the per-module guides, Advanced and Reference are all separate.
- **Quickstart.** `/docs/getting-started` is a router page (53 words) that links one quickstart per
  framework (Next.js App Router, SvelteKit, Nuxt, Node.js, Expo, Angular, TanStack Start, Coding
  Agents) and backend examples. The Next.js quickstart has a "what you'll learn" line ("you'll build
  a simple agent … you'll learn key concepts"), Prerequisites, Create Your Application, Route
  Handler, UI, Running, two enhancement sections and "Where to Next?". It is long: 23 code blocks,
  443 code lines, 1,443 prose words, average paragraph 25 words. It has package-manager tabs and
  Gateway/Provider/Custom tabs, and 66 highlighted lines showing what changed in each step.
- **API reference.** Hand-written: Import, API Signature (Parameters, Returns as nested property
  tables), Types, Examples.
- **AI.** `llms.txt` 200 (5.3 MB; the full text), `.md` copies 200. Buttons "Copy page", "Copy for
  LLM", "View Markdown", "Ask AI about this page". A "Coding Agents" quickstart.

#### Foundry book: <https://getfoundry.sh/> (fetched 2026-11-10, Vocs; book.getfoundry.sh serves the same llms.txt)

- **Landing.** "Blazing fast smart contract development toolkit", one paragraph, one install line,
  four tool tiles (Forge, Cast, Anvil, Chisel) with one line each.
- **IA** (from `llms.txt`). Introduction (Installation, Verifying Releases, Getting Started,
  Prompting, "Foundry documentation for agents"), Project Setup, then one section per tool (Forge,
  Cast, Anvil, Chisel) with task guides, then the generated CLI reference (`/reference/forge/…`).
  Concept pages sit beside the task pages ("How scripting works" next to "Scripting").
- **Quickstart** (`/introduction/getting-started`). A table of the four tools (Tool, Purpose,
  Reference). Tip and note callouts. "Create and test a smart contract in under 30 seconds" as a
  `:::steps` block: Create a new project, Build contracts, Run tests. Then one short section per
  tool, then Next steps. 14 code blocks, 32 code lines, 107 prose words, average paragraph 8 words.
  The shortest time to first success in the set.
- **Anatomy.** Tabs for alternatives (Keystore, Hardware wallet, Browser wallet, Raw key). Callouts
  for gotchas ("--chain only sets the EVM block.chainid…"). Commands start with `$`.
- **API reference.** Generated CLI reference, one page per command.
- **AI.** `llms.txt` 200 (95 KB, a description per page), `llms-full.txt` 200 (3.6 MB), `.md`
  copies 200. Each `.md` copy starts with a note pointing to a docs MCP server (`search_docs`,
  `submit_feedback` at `/api/mcp`). Buttons "Copy page for AI" and "Ask AI".

#### Hardhat: <https://hardhat.org/docs> (fetched 2026-11-10)

- **Landing.** The marketing home (`hardhat.org`): "Ethereum development environment for
  professionals", "Get started", a release note, then feature blocks, each ending in a "Learn
  more" link. `/docs` redirects straight to "Getting started with Hardhat 3".
- **IA.** Sidebar: Getting started, What's new in Hardhat 3, Migrate to Hardhat 3, Tutorial, Guides
  (named by task: Writing, Testing, Deploying, Verifying contracts; Managing config values and
  secrets; Forking; Using the console), Build with AI, Getting help, Cookbook, Reference,
  Explanations, Plugins. This is Diátaxis with explicit names plus a Cookbook. `llms.txt` repeats
  Tutorial/Guides/Reference/Explanations for each product (Hardhat 3, Ignition, plugin
  development).
- **Quickstart.** Prerequisites, Installation, Project structure, Non-interactive initialization,
  Learn more. 16 code blocks (npm/pnpm/Yarn tabs on each), 17 code lines, 383 prose words, average
  paragraph 17 words. Code blocks are titled "Terminal window".
- **AI.** `llms.txt` 200 (52 KB), `llms-full.txt` 404, `.md` copies 200, a "Markdown version"
  link on each page, a "Build with AI" guide.

#### Tailwind CSS: <https://tailwindcss.com/docs> (fetched 2026-11-10)

- **Landing.** A marketing home: "Rapidly build modern websites without ever leaving your HTML."
  and "Get started". `/docs` redirects to `/docs/installation/using-vite`.
- **IA.** Sidebar by domain: Getting started, Core concepts, Base styles, then utility groups
  (Layout, Flexbox & Grid, Spacing, Sizing, Typography, …). Installation is one page per setup
  (Using Vite, Using PostCSS, Tailwind CLI, Framework guides, Play CDN), shown as tabs across the
  top of the installation pages, each with its own URL.
- **Quickstart.** A numbered list of steps, each a sentence and a titled code block. 6 code blocks,
  25 code lines, 159 prose words, average paragraph 16 words, with highlighted lines showing what to
  add.
- **Reference.** Hand-written per utility (`padding`): a one-line description, a class table, then
  Examples (Basic example, Adding padding to one side, …), each with a live preview and code. 22
  highlighted lines on one page.
- **AI.** `llms.txt` 404, `.md` copy 404. No copy-for-LLM button found.

#### TanStack Query: <https://tanstack.com/query/latest> (fetched 2026-11-10)

- **Landing.** "The server-state standard for modern frontend apps." Then one paragraph and a
  tabbed tour (Deadly defaults, Query keys, State Management, Devtools).
- **IA.** Top tabs: Get Started, Guides, API, Examples. A framework selector (React, Vue, Solid,
  …) and a version selector (v5). Getting Started: Overview, Installation, Quick Start, Devtools,
  Comparison, TypeScript, GraphQL, React Native.
- **Quickstart.** One 61-line code block that shows the three core concepts, a sentence before it,
  a StackBlitz link after it. 72 prose words.
- **API reference.** Now generated from TSDoc: "Defined in: packages/react-query/src/useQuery.ts:49",
  one Call Signature per overload with Type Parameters, Parameters, Returns, See and Example.
- **AI.** `.md` copies 200. An inline line on each page for agents: "AI/LLM: This documentation page
  is available in plain markdown format at …md". "Copy page" with more options, "Ask AI", "Open in
  StackBlitz". `tanstack.com/llms.txt` 200 covers all libraries.

#### Supabase JS: <https://supabase.com/docs/reference/javascript/introduction> (fetched 2026-11-10)

- **Landing** (`/docs`). "Learn how to get up and running with Supabase through tutorials, APIs and
  platform resources." Tabs "Agent Prompt" and "CLI": the first holds a prompt to paste into an
  agent ("Help me get set up with Supabase. Do the following: …"). Sections: Connect a framework,
  Build your backend, Extend your database, Use a client library, Migrate to Supabase, Self-host.
- **IA.** Guides by product, one quickstart per framework, and a reference per client library.
  The JS reference intro sends server users to "which package to use" (`supabase-js`,
  `@supabase/ssr`, `@supabase/server`).
- **Quickstart** (React). Numbered H2 steps: 1. Create a project, 2. Set up your database, 3. Create
  a React app, 4. Set up AI tooling (optional), 5. Install the client, 6. Environment variables, 7. Create the client, 8. Query data, 9. Start the app. Then Production requirements and Next
  steps. 8 code blocks, 122 code lines, 600 prose words, average paragraph 18 words.
- **API reference.** Hand-written method pages from a spec: one line, Parameters, then many named
  examples ("Getting your data", "Handling errors", "Selecting specific columns", …). 26 prose words
  and 78 code lines on `select`.
- **AI.** `llms.txt` 200 (an index), per-SDK `llms/js.txt` 200 (173 KB), `.md` copies 200.
  Buttons "Copy as Markdown", "Ask ChatGPT", "Ask Claude". The quickstart has an Agent Skills and
  MCP step.

#### Resend: <https://resend.com/docs/introduction> (fetched 2026-11-10, Mintlify)

- **Landing.** "Resend is the email API for developers." Then a Quickstart grid of 15 cards, one
  per language or framework, including a CLI quickstart. Then Explore (Emails, Domains, Webhooks).
- **IA.** Sidebar: Get started (Introduction, Create API key, Add domain, Email types, AI
  onboarding, Sending examples), Learn (by feature), Resources (SDKs, CLI, MCP Server,
  Integrations, Examples), and a separate API Reference tab with HTTP-verb badges (POST, GET,
  PATCH, DEL) on each item.
- **Quickstart** (Node.js). Prerequisites, Guide (Install, Set your API key, Send email), Examples
  (cards to full apps). 6 code blocks, 23 code lines, 33 prose words, average paragraph 6 words.
  Tabs npm/yarn/pnpm/bun and `.env`. "Use this pre-built prompt to get started faster" offers a
  prompt with guardrails for agents.
- **API reference.** Generated from OpenAPI: body parameters with collapsible properties, callouts
  on edge cases, examples in 10 languages including cURL and the CLI, and a response example.
- **AI.** `llms.txt` 200, `llms-full.txt` 200 (2.5 MB), `.md` copies 200. Each `.md` starts with a
  "Documentation Index" note pointing to `llms.txt`. Buttons "Copy page", "Open in Cursor".

#### Sourcify: <https://docs.sourcify.dev/> (fetched 2026-11-10, Docusaurus)

- **Landing.** `/` redirects to "Intro & Why Sourcify?": the mission and values, then "Why
  Sourcify?" problems, then "How the docs are structured". No code. Average paragraph 22 words.
- **IA.** Sidebar: Intro, API, Supported Chains, Requesting Chain Support, Contract dataset (…),
  **Verify on Sourcify** (What is source code verification?, Verify via UI, via Remix, via Hardhat,
  via Foundry, via Sourcify API), Sourcify in depth, Npm libraries, Run your instance. Verification
  guides are split by tool, the same split our persona quickstarts need.
- **API reference.** A Swagger file. `llms.txt` tells agents how to read it.
- **AI.** `llms.txt` 200 (4.5 KB). It opens with "Bulk access and fair use (read this first)" and
  gives rules for API clients. `.md` copies 404.

#### Etherscan API: <https://docs.etherscan.io/> (fetched 2026-11-10, Mintlify)

- **Landing.** "Welcome to the Etherscan API", one line, then Get Started cards (Set Up Your API
  Key, Build with AI, Supported Chains, Rate Limits, Endpoint Showcase), then Use Cases cards
  (Wallet and Portfolio, Tax and Accounting, Security and Compliance, Onchain Analytics). Each card
  has one line.
- **IA.** Get Started, API Basics (Set Up Your API Key, Make Your First Call, Rate Limits, Common
  Error Messages, API Status), Guides (Contract Verification: Verify with the API, Get Verified
  Source Code, Verify with Foundry, Verify with Hardhat, Verify with Remix, Common Verification
  Errors), Endpoint Showcase, Common Use Cases, Best Practices, Resources, then the API Endpoints
  tab by module.
- **Quickstart** ("Make Your First Call"). Two bold steps: "1. Call the API" (one curl line, then a
  bullet per parameter) and "2. Read the response". A TIP and a WARNING alert. 2 code blocks,
  21 prose words. Time to first success: one command once the key exists.
- **API reference.** Generated from OpenAPI, with an API playground and an example response.
- **AI.** `llms.txt` 200. It opens with an "Instructions" section, "To work with the Etherscan
  API, start with these pages", and links a keyless MCP server and a docs MCP server.
  `llms-full.txt` 200, `.md` copies 200, "Copy page". "Build with AI" and "Etherscan Skills"
  sections. In the `.md` copies, callouts are GitHub alerts (`> [!TIP]`, `> [!WARNING]`).

#### Comparison table

| Site      | First quickstart              | Steps | Code blocks / lines | Prose words | Avg para | Tabs on quickstart             | Callouts | `llms.txt` | `.md` | Copy-for-AI |
| --------- | ----------------------------- | ----: | ------------------: | ----------: | -------: | ------------------------------ | -------- | ---------- | ----- | ----------- |
| viem      | Getting Started               |     2 |              5 / 19 |         115 |       19 | npm, pnpm, bun                 | yes      | 200        | 200   | yes         |
| wagmi     | Getting Started               |     4 |        12+ (groups) |         n/a |      n/a | pnpm, npm, yarn, bun           | yes      | 200        | 200   | yes         |
| Stripe    | Checkout quickstart           |    25 |    split code panel |       1,086 |       23 | frontend × backend language    | yes      | 200        | 200   | yes         |
| AI SDK    | Next.js App Router            |    ~8 |            23 / 443 |       1,443 |       25 | pnpm, npm, yarn, bun; provider | yes      | 200        | 200   | yes         |
| Foundry   | Getting Started               |     3 |             14 / 32 |         107 |        8 | none                           | yes      | 200        | 200   | yes         |
| Hardhat   | Getting started               |     4 |             16 / 17 |         383 |       17 | npm, pnpm, Yarn                | no       | 200        | 200   | link        |
| Tailwind  | Using Vite                    |     6 |              6 / 25 |         159 |       16 | setup method (one page each)   | no       | 404        | 404   | no          |
| TanStack  | Quick Start                   |     1 |              1 / 61 |          72 |       14 | none                           | no       | 200        | 200   | yes         |
| Supabase  | React                         |     9 |             8 / 122 |         600 |       18 | none                           | yes      | 200        | 200   | yes         |
| Resend    | Node.js                       |     3 |              6 / 23 |          33 |        6 | npm, yarn, pnpm, bun, `.env`   | yes      | 200        | 200   | yes         |
| Sourcify  | Verify via API                |   n/a |                 n/a |         n/a |       22 | n/a                            | n/a      | 200        | 404   | no          |
| Etherscan | Make Your First Call          |     2 |               2 / 7 |          21 |        7 | none                           | yes      | 200        | 200   | yes         |
| **ours**  | Verify from Node.js (closest) |   n/a |             6 / 113 |         696 |   **37** | none                           | **none** | 200        | 200   | no          |

Our other pages: "Verify from CI with the CLI" averages 35 words a paragraph (longest 103),
"Verify from a browser" 49 (longest 193), `verify()` 43 (longest 110, 2,421 prose words), the
dapp tutorial 40 (longest 95). Every page opens with three meta lines (`Version:`, `Agents:`,
`Audience:`) before any content. The site root is `docs/user/README.md`: no code, no headings and
a 33-row table.

### 3. Constraints that shape the proposal

- Decision 0015 keeps pages in `docs/user/` as plain Markdown, with no Vue components, VitePress
  containers or frontmatter, because GitHub and the npm package render the same files. Anything
  below that needs VitePress-only syntax either sits in a site-only file or is added at build time
  by the existing `explorer-verify:site-links` transform in `site/.vitepress/config.ts`.
- VitePress 1.6.4 is pinned. It renders GitHub alerts (`> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`,
  `> [!WARNING]`, `> [!CAUTION]`) as callouts, and GitHub renders the same syntax. Callouts are
  therefore available today without a decision change.
- A code-block title in VitePress is ` ```ts [verify.ts] `. GitHub reads the first word of the
  info string as the language and ignores the rest, so titles are also safe. To verify: confirm
  that the npm package's Markdown renderers do the same.
- The sidebar comes from `scripts/site-docs.ts` (`GROUPS`, sorted by file name within each
  folder). Grouping and ordering are a script change, not a page change.
- Error pages are linked from `docsUrl` in published errors (decision 0015). Their URLs must not
  move. Other moved pages need a redirect stub, because GitHub Pages has no server redirects. The
  cheapest path: keep existing file paths and build the new IA in the sidebar and the landing page,
  adding new files only.

### 4. Proposed information architecture

#### 4.1 Landing page (`docs/user/README.md`, the site root)

Plain Markdown, so it also works on GitHub and in the package. In order:

1. H1 `explorer-verify`. One sentence: "Verify the source of a deployed contract on Etherscan,
   Blockscout, Sourcify and Routescan, from a browser, a backend, a CI job or an agent."
2. An 8 to 10 line code sample that runs a dry run against a contract already verified on Sepolia.
   It needs no key and submits nothing, and it prints `status: "dry-run"` with `lookup: "exact"`.
   One sentence on what it shows.
3. **"Start here"**: a table with columns "You are building…", "Install" and "Quickstart". One
   row per persona (section 4.3). This is the router that the acceptance criteria require.
4. **"The packages"**: four rows (name, one line, "use it when") and a link to "Which package do I
   need".
5. **"Find your way"**: four one-line links: Guides (by task), Advanced, Reference, Concepts.
6. One `> [!NOTE]` on stability ("The APIs are experimental before 1.0.") and the version line.
   Move `Agents:` to a single line at the bottom with `llms.txt`. The current 33-row table moves to
   an "All pages" page, or goes away because the sidebar replaces it.

Option, as a new decision record: a site-only `site/index.md` with VitePress `layout: home` (hero,
install snippet, persona feature cards), leaving `README.md` as the in-package index. The
benchmarks with the best routing (Stripe, Etherscan, Resend, Supabase) use card grids. The plain
table above gives the same routing at no cost to decision 0015.

#### 4.2 "Which package do I need" (`start/which-package.md`)

A decision table first, details after:

| You want to…                                                         | Install                    | Import from                                      |
| -------------------------------------------------------------------- | -------------------------- | ------------------------------------------------ |
| Verify from code: a browser dapp, a Node service, an edge function   | `explorer-verify`          | `explorer-verify`                                |
| Verify from a terminal, a CI job or an agent shell                   | `@explorer-verify/cli`     | the `explorer-verify` command                    |
| Build the input from a Foundry project's `out/` in code              | `@explorer-verify/foundry` | `@explorer-verify/foundry` + `explorer-verify`   |
| Build the input from a Hardhat 2 or 3 project's build files in code  | `@explorer-verify/hardhat` | `@explorer-verify/hardhat` + `explorer-verify`   |
| Ship one bundle with only the explorer clients you use (SDK, Worker) | `explorer-verify`          | `explorer-verify/core` + `/clients/*` + `/table` |
| Keep an Etherscan key on your server for a browser app               | `explorer-verify`          | `explorer-verify/server`                         |

Then three short sections:

- **Main entry or core entry.** The main entry loads the clients and the routing table with a
  dynamic `import()` when a call needs them. The core entry takes them from your options and holds
  no dynamic `import()`. Pick the core entry when you bundle to one file and want only the clients
  you use. Same results and errors either way. Link `reference/core.md`.
- **The small entries.** `/errors`, `/handle`, `/backends`, `/envelope`, `/resolve` and the three
  JSON schemas: one line each, saying when a page or a tool needs only that entry.
- **The CLI reads Foundry and Hardhat projects itself.** With the CLI you do not install the
  Foundry or Hardhat package.

Foundry's tool table (Tool, Purpose, Reference) and Supabase's "which package to use" are the
models.

#### 4.3 Persona quickstarts (`start/quickstart-*.md`)

One page each, with the same template and a hard budget: at most 5 numbered steps, 6 code blocks
and about 150 prose words, and a first success in under 5 minutes. The first success is a **dry
run** (no key, nothing submitted) against a contract already verified on Sepolia, so nobody needs
to deploy or sign up first. The last step does the real verify, or links it.

| Page                        | Persona                              | First success                                                                           | Then link                                               |
| --------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `quickstart-browser.md`     | Browser dapp                         | `dryRun` on Sourcify from a Vite page (or the CDN build)                                | Tutorial: deploy and verify from a dapp; server handler |
| `quickstart-node.md`        | Node service or script               | `node verify.ts` dry run, then a real Sourcify verify                                   | Verify from Node.js; keys; resume from a queue          |
| `quickstart-cli.md`         | CLI and CI                           | `npx @explorer-verify/cli verify … --dry-run --json`                                    | Verify from CI; JSON output and exit codes              |
| `quickstart-foundry.md`     | Foundry project                      | `forge build`, then a CLI dry run with `--foundry .`, or the code path                  | Verify from a Foundry project                           |
| `quickstart-hardhat.md`     | Hardhat project                      | `npx hardhat build`, then a CLI dry run with `--hardhat .`, or code                     | Verify from a Hardhat project                           |
| `quickstart-sdk-wrapper.md` | A tool or SDK that wraps the library | `explorer-verify/core` with one client, dry run, map one error code                     | Wrap explorer-verify in your tool; core entry           |
| `quickstart-agent.md`       | An AI agent or its operator          | A copyable prompt block plus the safe call sequence: dry run, then confirm, then verify | Using explorer-verify from an agent; exit codes         |

The CLI takes `--foundry <dir>` or `--hardhat <dir>` (`docs/user/reference/cli.md`). Before
writing these, confirm that a dry run works with no
project, from deployed bytecode (`explorer-verify/resolve`). That would give the Node, browser and
CLI quickstarts a zero-project path.

Template for every quickstart (from Resend, Etherscan, Foundry and viem):

```md
# Quickstart: <persona>

<One sentence: what you will have at the end.>

**You need:** Node 22.18+, <one or two more items>.

## 1. Install

<code group: npm | pnpm | yarn | bun>

## 2. <Write the call>

<one sentence> `ts [verify.ts]` (≤ 15 lines)

## 3. Run a dry run

<command> then the expected output, as a second titled block

## 4. Verify for real (optional step)

## Next steps

- 3 links, each one line
```

The router page `start/README.md` (or `start/index.md`) copies AI SDK's getting-started page: one
sentence and one link per quickstart.

#### 4.4 Sidebar and sections

The order follows Hardhat and AI SDK. Group names are task phrases, not Diátaxis jargon. The
mapping to Diátaxis stays in the contributor docs.

```text
Get started
  Overview                      (landing)
  Which package do I need
  Quickstarts ▸ Browser dapp · Node · CLI and CI · Foundry · Hardhat · SDK wrapper · AI agent
  Tutorial: deploy and verify from a dapp

Guides
  Build the verification input
    From a Foundry project · From a Hardhat project · From an npm package's files
    · From deployed bytecode · Ship the input with your package
  Run it where your code runs
    Node.js · Browser · Edge function · CI with the CLI · Server handler (Etherscan key on your server)
  Verify special contracts
    Proxies (linkProxy)
  Integrate
    Wrap explorer-verify in your tool · Use it from an agent

Advanced
  Ship only the clients you use (core entry, bundle size)
  Routing: custom table and choosing explorers
  Several explorers in one call (verifyEach)
  Resume, abort and job queues (checkStatus, handles)
  Logging and stage events
  Standalone Etherscan-compatible explorers
  Replay tests for your wrapper

Reference
  verify() · dryRun() · checkStatus() · linkProxy()   (one page per function, viem anatomy)
  CLI commands and flags · JSON output and exit codes
  API keys · Routing table
  Explorers ▸ Sourcify · Etherscan · Routescan · Blockscout · Etherscan-compatible
  Errors ▸ one page per code (unchanged URLs)
  API (generated from TSDoc)

Concepts
  Match types · Etherscan plans and attribution · How a verification runs (the steps, safe vs outward calls)
```

The Advanced pages are mostly sections cut out of today's long pages: `verify()` reference (Several
backends, Abort and resume, Events), "Verify from a browser" (Bundle size), "Verify from Node.js"
(Resume from a job queue). Cutting them out is what brings the guides under the density rule.

The reference adopts viem's per-function anatomy: a one-line description, Usage (titled code),
Returns, Parameters (each with a short example), Errors (links to error pages), and Related.
Hand-written pages stay the entry point. The TypeDoc API stays as the exhaustive layer, as
TanStack and AI SDK do.

#### 4.5 Page-density style rule (for `docs/contributor/` and the writer checklist)

1. **Top of every page, in this order.** The H1. One sentence on what the page lets you do. A
   "**You need:**" line (prerequisites). For a guide or quickstart, a "**For:**" line (audience).
   Move `Version:` and `Agents:` into one footer line, or into a single `> [!NOTE]` under the
   intro. Today three meta lines come before the first useful sentence.
2. **Paragraphs:** at most 3 sentences and about 50 words. Target an average of 20 words or less,
   in line with viem (19), Hardhat (17) and Tailwind (16).
3. **One idea per H2.** If a section needs an H3, consider a new page. Guides stay under about
   800 prose words. A longer page splits, and the advanced part moves to Advanced.
4. **Code follows the sentence that introduces it.** That sentence ends with a colon. No more than
   two paragraphs between code blocks in a guide.
5. **Show the output.** After a command or call, add a titled block with what it prints.
6. **Callouts:** at most two per screen, GitHub alert syntax only. TIP for shortcuts. NOTE for
   context. IMPORTANT for keys and outward or irreversible calls ("the explorer publishes the
   source"). WARNING for data loss or exposed keys. Never a callout for normal flow.
7. **Lists over prose** for options, flags, steps and per-explorer differences. A table when there
   are two or more attributes.
8. **End every guide and quickstart with "Next steps"**: 2 or 3 links, each a one-line reason.
9. **Measure it.** Add a check to the docs script that fails on a paragraph over 80 words and
   reports the page's average, the same way the `{{` check runs today.

#### 4.6 VitePress features to use

| Feature                                 | Use for                                                         | How, under decision 0015                                                                                                                                                                                                   |
| --------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Curated sidebar groups (`collapsed`)    | The section 4.4 order; Errors and Explorers collapsed           | Replace the folder-sorted `GROUPS` in `scripts/site-docs.ts` with an explicit ordered list. Pages are unchanged.                                                                                                           |
| GitHub alerts as callouts               | Notes, tips, key safety, outward calls                          | Native in VitePress 1.6 and on GitHub. Allowed today.                                                                                                                                                                      |
| Code-block titles ` ```ts [verify.ts] ` | Every quickstart and guide block that is a file                 | Plain Markdown. GitHub ignores the title.                                                                                                                                                                                  |
| Code groups (tabs)                      | npm/pnpm/yarn/bun; main entry vs core entry; Foundry vs Hardhat | Not plain Markdown. Have the build transform turn consecutive titled blocks between `<!-- code-group -->` and `<!-- /code-group -->` comments into `::: code-group`. GitHub shows them in sequence and hides the comments. |
| Line highlighting                       | The changed lines in quickstart steps                           | `// [!code highlight]` and `// [!code ++]` comments stay readable on GitHub. Avoid `ts{4}`, which breaks GitHub highlighting.                                                                                              |
| Copy button                             | Built in on every code block                                    | Already on.                                                                                                                                                                                                                |
| "Copy page" / "View as Markdown" button | Agents, the pattern at 7 of the 12 sites                        | A small theme slot (`doc-before`) in `site/.vitepress/theme` linking the existing `.md` copy and copying it. Site-only, no page change.                                                                                    |
| Nav bar                                 | Get started · Guides · Reference · API · version                | Config only. Add "Get started" and "Guides" next to "API reference".                                                                                                                                                       |
| `outline: [2, 3]`, local search         | Keep                                                            | Already on.                                                                                                                                                                                                                |
| Badges (`<Badge>`)                      | Skip in pages (Vue component)                                   | If needed, add text markers in sidebar labels from config, such as "CLI" or "core".                                                                                                                                        |
| Home layout (`layout: home`)            | Optional hero and feature cards                                 | Site-only `site/index.md`. Needs a decision record (section 4.1).                                                                                                                                                          |

#### 4.7 For agents

- Keep `llms.txt` and the `.md` copies. Add an "Instructions" header to `llms.txt` with the six
  pages to read first, as Etherscan and Stripe do.
- Make `quickstart-agent.md` short enough to paste. Lead with a copyable prompt block, as Resend
  and Supabase do, and state the safe sequence: dry run, ask, verify.
- Add a one-line note at the top of each `.md` copy that points to `llms.txt`, as Resend and
  Etherscan do. Generate it in the copy script, not in the source page.

## Sources

- The UX review and the persona walkthroughs read the published site on 2026-11-10:
  <https://aelmanaa.github.io/explorer-verify/>, its `llms.txt`, and the npm packages at 0.1.0,
  <https://www.npmjs.com/package/explorer-verify>.
- esm.sh, <https://esm.sh/explorer-verify@0.1.0>, read 2026-11-10 (status 200).
- WCAG 2.2, contrast minimum, <https://www.w3.org/TR/WCAG22/#contrast-minimum>, read 2026-11-10.

The benchmark sources, all fetched 2026-11-10:

- viem: <https://viem.sh/>, <https://viem.sh/docs/getting-started>,
  <https://viem.sh/docs/actions/public/getBalance>, <https://viem.sh/docs/introduction>,
  <https://viem.sh/llms.txt>, <https://viem.sh/llms-full.txt>
- wagmi: <https://wagmi.sh/>, <https://wagmi.sh/react/getting-started> (and `.md`),
  <https://wagmi.sh/llms.txt>, <https://wagmi.sh/llms-full.txt>
- Stripe: <https://docs.stripe.com/>, <https://docs.stripe.com/get-started>,
  <https://docs.stripe.com/payments/quickstart>, <https://docs.stripe.com/api/customers/create>,
  <https://docs.stripe.com/llms.txt>
- Vercel AI SDK: <https://ai-sdk.dev/>, <https://ai-sdk.dev/docs/introduction>,
  <https://ai-sdk.dev/docs/getting-started>, <https://ai-sdk.dev/docs/getting-started/nextjs-app-router>,
  <https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text>, <https://ai-sdk.dev/llms.txt>
- Foundry: <https://getfoundry.sh/>, <https://getfoundry.sh/introduction/getting-started> (and `.md`),
  <https://getfoundry.sh/forge/scripting>, <https://getfoundry.sh/llms.txt>,
  <https://book.getfoundry.sh/llms.txt>
- Hardhat: <https://hardhat.org/>, <https://hardhat.org/docs/getting-started> (and `.md`),
  <https://hardhat.org/llms.txt>
- Tailwind CSS: <https://tailwindcss.com/>, <https://tailwindcss.com/docs/installation/using-vite>,
  <https://tailwindcss.com/docs/padding>, <https://tailwindcss.com/llms.txt> (404)
- TanStack Query: <https://tanstack.com/query/latest>,
  <https://tanstack.com/query/latest/docs/framework/react/overview>,
  <https://tanstack.com/query/latest/docs/framework/react/quick-start>,
  <https://tanstack.com/query/latest/docs/framework/react/reference/functions/useQuery>,
  <https://tanstack.com/llms.txt>
- Supabase: <https://supabase.com/docs>, <https://supabase.com/docs/reference/javascript/introduction>,
  <https://supabase.com/docs/reference/javascript/select>,
  <https://supabase.com/docs/guides/getting-started/quickstarts/reactjs>,
  <https://supabase.com/llms.txt>, <https://supabase.com/llms/js.txt>
- Resend: <https://resend.com/docs/introduction>, <https://resend.com/docs/send-with-nodejs> (and `.md`),
  <https://resend.com/docs/api-reference/emails/send-email>, <https://resend.com/docs/llms.txt>,
  <https://resend.com/docs/llms-full.txt>
- Sourcify: <https://docs.sourcify.dev/docs/intro/>, <https://docs.sourcify.dev/llms.txt>
- Etherscan: <https://docs.etherscan.io/introduction>, <https://docs.etherscan.io/make-your-first-call> (and `.md`),
  <https://docs.etherscan.io/contract-verification/verify-with-api>,
  <https://docs.etherscan.io/api-reference/endpoint/getsourcecode>, <https://docs.etherscan.io/llms.txt>
- explorer-verify (baseline): <https://aelmanaa.github.io/explorer-verify/>, `/guides/verify-from-node`,
  `/guides/verify-from-ci-with-the-cli`, `/guides/verify-from-a-browser`, `/reference/verify`,
  `/tutorials/deploy-and-verify-from-a-dapp`
- VitePress features: VitePress 1.6.4 (pinned in `pnpm-workspace.yaml`): GitHub-flavored alerts,
  code groups, code titles and `[!code]` notations, confirmed in the v1.6.4 source of
  <https://vitepress.dev/guide/markdown> (`docs/en/guide/markdown.md` at tag v1.6.4, fetched
  2026-11-10): sections "GitHub-flavored Alerts", "Line Highlighting" (`// [!code highlight]`) and "Code Groups" (`[config.js]` titles).
