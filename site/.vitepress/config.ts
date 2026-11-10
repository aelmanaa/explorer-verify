// The VitePress config of the docs site (R-AX-17, decisions 0015 and 0062). It builds the pages in
// `docs/user/` as they are: the pages hold no frontmatter, Vue components or containers, and this
// config lives outside them, so GitHub and the npm package never see it. It also builds the API
// reference that site/api-reference.ts generates into `site/api/` (R-AX-2), and the site-only
// pages in `site/pages/`, such as the home page and the 404 page, which may use frontmatter and
// Vue (decision 0062). VitePress reads all three from the repository root, and `srcExclude` hides
// every other Markdown file. The link rules, the sidebar, the nav and the Markdown copies are in
// scripts/site-docs.ts; the theme in site/.vitepress/theme/ only adds CSS.
//
// Build: pnpm run site:build. Preview: pnpm run site:preview.
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitepress";
import type { DefaultTheme, UserConfig } from "vitepress";

import { githubSlug, packageVersion, USER_DOCS } from "../../scripts/agent-docs.ts";
import {
  codeTitleOf,
  dropHeaderLines,
  hasSiteHome,
  inCodeGroup,
  rewriteForSite,
  SITE_BASE,
  siteNav,
  siteRewrites,
  siteSidebar,
  siteSourceExcludes,
  withCodeTitle,
} from "../../scripts/site-docs.ts";
import { boostDocument, processTerm } from "../../scripts/site-search.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const version = packageVersion(root);
const home = hasSiteHome(root);
const sidebar = siteSidebar(root);

const config: UserConfig<DefaultTheme.Config> = defineConfig({
  title: "explorer-verify",
  description: `Verify deployed contract source on block explorers. Docs of explorer-verify ${version}.`,
  lang: "en",
  base: SITE_BASE,
  srcDir: path.relative(path.join(root, "site"), root),
  srcExclude: siteSourceExcludes(root),
  outDir: "dist",
  cacheDir: path.join(root, "node_modules/.cache/vitepress"),
  cleanUrls: true,
  rewrites: siteRewrites(root),
  markdown: {
    // The same anchors as GitHub, which the repository's link check uses (scripts/agent-docs.ts).
    anchor: { slugify: githubSlug },
    // VitePress marks code blocks `v-pre`, but not inline code, so Vue would evaluate `{{ }}` in a
    // code span. Marking each span `v-pre` leaves only prose, which the docs check guards.
    config(md) {
      const render = md.renderer.rules.code_inline;
      md.renderer.rules.code_inline = (tokens, index, options, env, self) => {
        tokens[index]?.attrSet("v-pre", "");
        return render === undefined
          ? self.renderToken(tokens, index, options)
          : render(tokens, index, options, env, self);
      };
      // VitePress 1.6.4 shows the `[title]` of a code block only inside a code group. A block
      // outside one gets a title bar here (#307, #308). VitePress's own fence rule, which this one
      // wraps, removes the brackets from the info string, so the title is read first.
      const fence = md.renderer.rules.fence;
      md.renderer.rules.fence = (tokens, index, options, env, self) => {
        const title = codeTitleOf(tokens[index]?.info ?? "");
        const html =
          fence === undefined
            ? self.renderToken(tokens, index, options)
            : fence(tokens, index, options, env, self);
        return title === undefined ||
          inCodeGroup(
            tokens.map((token) => token.type),
            index,
          )
          ? html
          : withCodeTitle(html, title);
      };
    },
  },
  themeConfig: {
    search: {
      provider: "local",
      options: {
        // VitePress sends these functions to the browser as their source text, so each must use
        // nothing outside its own body (scripts/site-search.ts).
        miniSearch: {
          options: { processTerm },
          searchOptions: {
            // VitePress's defaults are title 4, text 2 and titles 1. A section whose own heading
            // holds the word counts more.
            boost: { title: 8, text: 1, titles: 2 },
            boostDocument,
          },
        },
      },
    },
    sidebar,
    nav: siteNav(sidebar, version),
    outline: [2, 3],
    socialLinks: [{ icon: "github", link: "https://github.com/aelmanaa/explorer-verify" }],
  },
  vite: {
    // Vite's root is `srcDir`, the repository root, and Vite reads `.env` files from its root by
    // default. The site's folder holds none, so no local secret reaches the build (decision 0028).
    envDir: path.join(root, "site"),
    plugins: [
      {
        // Rewrites the links of each user page before VitePress reads it, and drops the `Version:`
        // and `Agents:` header lines, which the nav replaces (scripts/site-docs.ts).
        name: "explorer-verify:site-links",
        enforce: "pre",
        transform(code: string, id: string): string | undefined {
          const file = path.relative(root, id).split(path.sep).join("/");
          return file.startsWith(`${USER_DOCS}/`) && file.endsWith(".md")
            ? dropHeaderLines(rewriteForSite(file, code, version, home))
            : undefined;
        },
      },
    ],
  },
});

export default config;
