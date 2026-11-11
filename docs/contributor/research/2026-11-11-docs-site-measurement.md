# Docs site measurement after the restructure

Date: 2026-11-11. Scope: [#325](https://github.com/aelmanaa/explorer-verify/issues/325), part of
[#303](https://github.com/aelmanaa/explorer-verify/issues/303). Does the restructured docs site
meet the acceptance criteria of #303 and #325? The method repeats the
[2026-11-10 audit](2026-11-10-docs-audit.md), which defines findings F1 to F20 and the seven
personas.

## Method

- **Build.** `pnpm run site:build` at commit `8f9c9ba` ("before") and at the head of this change
  ("after"), served with `vitepress preview site`. The site was not deployed; the live site still
  shows 0.1.0 as the audit saw it.
- **Browser.** Playwright MCP 0.0.75 driving Chromium 156.0.8078.80. Viewports 1280×800 (desktop)
  and 390×844 (mobile), each in the light and dark themes through `prefers-color-scheme`.
- **Pages.** All 215 HTML pages: 77 written pages, including the home page and the 404 page, and
  138 generated API pages. Each page was loaded four times, once per viewport and theme.
- **Per page.** Page-level horizontal overflow (`scrollWidth` minus `clientWidth` of the root),
  any element wider than the viewport outside code blocks, tables and the sidebar, console errors,
  page errors and responses of 400 or above.
- **Contrast.** The computed colour of each code language label, code block title and body text,
  blended over its computed background, then the WCAG 2.2 contrast ratio.
- **Links.** A script read every `href` in `site/dist`, resolved internal links to a file and their
  fragment to an `id`. `node scripts/check-site.ts` ran too. Repository links were checked against
  the files of the tree and of tag `v0.1.0`.
- **Search.** The seven queries typed into the local search box; the first result recorded. A
  script also loaded the built MiniSearch index with the site's options (VitePress 1.6.4,
  MiniSearch 7.2.0), which gave the same order as the browser.
- **Prose.** `node scripts/check-agent-docs.ts` prints each page's block count, average and longest
  words per paragraph, list item or quote. The site-only home page was measured with the same
  function.
- **Personas.** One run per persona from the home page, Node.js 24.21.0, the npm packages at
  0.1.0, each in a fresh folder. Minutes are estimates: prose at 200 words a minute, 4 seconds per
  code line, plus measured command time.

## Results per criterion

| Criterion                                                      | Before                                    | After                                |
| -------------------------------------------------------------- | ----------------------------------------- | ------------------------------------ |
| Each persona reaches a dry run in under 5 minutes              | Pass: 2 to 4 minutes                      | Pass: 2 to 4 minutes                 |
| "quickstart" lists a quickstart first                          | Pass: Quickstarts                         | Pass: Quickstarts                    |
| "install" lists Which package or a quickstart first            | Fail: Verify a proxy, Install             | Pass: Node.js quickstart, 1. Install |
| "etherscan key" lists API keys first                           | Fail: Etherscan reference                 | Pass: API keys, Get an Etherscan key |
| No paragraph over 80 words                                     | Pass: longest 73                          | Pass: longest 73                     |
| Average words per block at most 30 on every page               | Pass, not enforced: highest 29            | Pass, enforced: highest 29           |
| Guides and quickstarts start with "For:" and "You need:"       | Pass                                      | Pass                                 |
| Guides and quickstarts end with "Next steps"                   | Pass                                      | Pass                                 |
| No code label below 4.5:1                                      | Pass: 5.21 light, 6.31 dark               | Pass: 5.21 light, 6.31 dark          |
| No page overflows on mobile                                    | Pass: 0 of 215                            | Pass: 0 of 215                       |
| Link checks pass                                               | Pass: 25,735 internal links, none broken  | Pass                                 |
| No console errors                                              | Fail: `/favicon.ico` 404 on a fresh load  | Pass                                 |
| The docs check fails the legacy marker                         | Fail: the marker exempted a page          | Pass                                 |
| Landing page names the four packages and links each quickstart | Pass                                      | Pass                                 |
| Every page shows where the reader is and where to go next      | Pass: sidebar, outline, previous and next | Pass                                 |

Other measurements:

- Body text contrast: 10.94:1 light, 12.81:1 dark. Code block titles: 10.13:1 and 13.48:1. The site
  has no code groups.
- Every code block has a copy button. The copied text of a CLI block includes its `# exit code 0`
  comment, which a shell ignores.
- Prose: 75 user pages, mean of the page averages 17.7 words. The densest pages are
  `reference/etherscan.md` (29), `explanation/glossary.md` (27) and
  `guides/verify-from-a-browser.md` (25). The home page averages 15, longest 37.
- Code blocks that scroll sideways on the 75 written pages: 111 of 307 on desktop, 189 of 307 on
  mobile. The audit counted 52 of 102 sampled blocks on desktop. Most are TypeScript lines over
  70 columns in the wrap guide, the deploy tutorial and the Foundry and Hardhat guides.

## Persona walkthroughs

Each persona clicked one card on the home page and read one quickstart: 1 click, 2 pages. Every
dry run printed `lookup: exact` on Sourcify.

| Persona      | Minutes | Before (audit) | Quickstart               | Measured action                                                |
| ------------ | ------- | -------------- | ------------------------ | -------------------------------------------------------------- |
| Browser dapp | ~4      | ~15            | 172 words, 21 code lines | Vite scaffold and install, then `dry-run sourcify exact`       |
| Node script  | ~3      | ~12            | 140 words, 26 code lines | `npm install` and `node verify.ts`                             |
| CLI and CI   | ~2.5    | ~6             | 169 words, 16 code lines | `curl` 0.3 s, `npx` dry run 2.8 s                              |
| Foundry      | ~2.5    | ~8             | 181 words, 16 code lines | Sample dry run 2.8 s; project dry run 2.8 s                    |
| Hardhat      | ~2.5    | ~8             | 196 words, 16 code lines | Sample dry run, the same command as the CLI                    |
| SDK wrapper  | ~4      | ~18            | 152 words, 36 code lines | `node my-tool.ts` with `explorer-verify/core`                  |
| AI agent     | ~3      | ~4             | 106 words, 20 code lines | Paste the prompt; the agent's first command is the CLI dry run |

Each figure adds about 20 seconds to scan the home page. The first dry run sits 0.6 to 1.3
desktop screens down each quickstart, and each quickstart is 2.8 to 3.7 screens long.

## Search results

First result of each query, in the browser:

| Query           | Before                                        | After                                       |
| --------------- | --------------------------------------------- | ------------------------------------------- |
| `quickstart`    | Quickstarts                                   | Quickstarts                                 |
| `install`       | Verify a proxy, Install                       | Quickstart: Node.js script, 1. Install      |
| `etherscan key` | Etherscan                                     | API keys, Get an Etherscan key              |
| `dry run`       | JSON output and exit codes, Dry run           | Quickstart: SDK wrapper, 4. Run the dry run |
| `foundry`       | Quickstart: a Foundry project                 | Quickstart: a Foundry project               |
| `hardhat`       | Verify from a Hardhat project, Contract names | Quickstart: a Hardhat project               |
| `handle`        | API reference, `explorer-verify/handle`       | Glossary, Handle                            |

## Changes made

- The docs check fails a page that holds `<!-- docs-style: legacy -->`, and a page whose blocks
  average over 30 words. No page held the marker.
- Search counts a section's own heading as well as its page title, and doubles pages under
  `start/`.
- The API keys page gains "Get an Etherscan key", and the package page is now "Which package to
  install".
- The sample download line is split over two lines on the home page, the overview and the CLI,
  Foundry and Hardhat quickstarts.
- The site declares an empty icon, so browsers no longer request `/favicon.ico`.

## Audit findings

| Finding                     | Status                                                                      |
| --------------------------- | --------------------------------------------------------------------------- |
| F1 landing page             | Fixed: hero, sample dry run, seven persona cards, the package table         |
| F2 no quickstart            | Fixed: seven quickstarts, 2.8 to 3.7 screens each                           |
| F3 packages never presented | Fixed: the package page, the home table, install lines in the CLI reference |
| F4 sidebar order            | Fixed: Get started, Guides by setup, by task, Advanced, Reference, Concepts |
| F5 CLI Verify section       | Fixed: the check passes the CLI reference                                   |
| F6 density                  | Fixed and enforced: 80 words per block, 30 words per page average           |
| F7 boilerplate header       | Fixed on the site: the version and agents lines are dropped                 |
| F8 prerequisites            | Fixed and enforced                                                          |
| F9 long tutorial            | Fixed: two tutorials after the quickstarts                                  |
| F10 no callouts             | Fixed                                                                       |
| F11 error pages             | Fixed: "How to fix" first, then facts, then "Why"                           |
| F12 errors placement        | Fixed: under Reference; the index opens with "Handle an error"              |
| F13 scrolling code          | Open: 111 of 307 blocks scroll on desktop                                   |
| F14 reference order         | Mostly fixed; open items below                                              |
| F15 API reference           | Fixed: one page per member; see the source links below                      |
| F16 search ranking          | Fixed by this change                                                        |
| F17 nav                     | Fixed: Get started, Guides, Reference, API, version menu                    |
| F18 code label contrast     | Fixed                                                                       |
| F19 contributor content     | Fixed                                                                       |
| F20 404 page                | Fixed: search button and the Get started links                              |

## Open items

These need a decision, code in `packages/`, or a change to pages that other open branches edit.

1. **F13, scrolling code.** Rewrapping 111 blocks touches pages that other branches edit
   (`verify.md`, `cli.md`, `json-output.md`, `sourcify.md`). A docs check rule for code width,
   such as 80 columns outside `text` blocks, would hold it once those land. Needs a decision on
   the limit.
2. **API source links.** The API reference links each export to its source at tag `v<version>`.
   A build of unreleased code links 5 files that tag `v0.1.0` does not have, such as
   `src/user-hints.ts`. A release build links its own tag, so the site, built only at a release,
   is not affected. A preview build would need a commit-based link.
3. **The agent prompt** downloads the sample from the deployed site. The live site returns 404
   for it until the next docs deploy.
4. **The example runner** in `packages/explorer-verify/test/helpers/user-docs.ts` still accepts
   `input` and `built` without a definition on a page with the legacy marker. The docs check now
   fails such a page, so the path is dead. Removing it is a test-only change in `packages/`.
5. **Error pages** start the fix with "Fix:" under a "How to fix" heading and repeat the label
   "Cause:" under "Why". Other branches edit the error page template.
6. **Copied CLI blocks** carry the `# exit code 0` comment that the page tests read. A shell
   ignores it; moving the marker out of the block needs a change to the example tests.

## Sources

- The audit: [2026-11-10-docs-audit.md](2026-11-10-docs-audit.md).
- Creating an Etherscan key: [Set up your API key](https://docs.etherscan.io/set-up-your-api-key),
  read 2026-11-11.
- VitePress 1.6.4 local search options: `VPLocalSearchBox.vue` in the installed package.
