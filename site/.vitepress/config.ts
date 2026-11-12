// The VitePress config of the docs site (R-AX-17, decisions 0015 and 0062). It builds the pages in
// `docs/user/` as they are: the pages hold no frontmatter, Vue components or containers, and this
// config lives outside them, so GitHub and the npm package never see it. It also builds the API
// reference that site/api-reference.ts generates into `site/api/` (R-AX-2), and the site-only
// pages in `site/pages/`, such as the home page and the 404 page, which may use frontmatter and
// Vue (decision 0062). VitePress reads all three from the repository root, and `srcExclude` hides
// every other Markdown file. The link rules, the sidebar, the nav and the Markdown copies are in
// scripts/site-docs.ts; the theme in site/.vitepress/theme/ only adds CSS. What the site tells
// search engines, the sitemap, canonical links, descriptions, social tags, JSON-LD and the search
// console tags, is in scripts/site-seo.ts and scripts/site-descriptions.ts.
//
// Build: pnpm run site:build. Preview: pnpm run site:preview.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitepress";
import type { DefaultTheme, UserConfig } from "vitepress";

import { githubSlug, packageVersion, USER_DOCS } from "../../scripts/agent-docs.ts";
import { API_DESCRIPTIONS, API_OUT, apiPages, apiTitles } from "../../scripts/site-api.ts";
import { readPageDescriptions } from "../../scripts/site-descriptions.ts";
import {
  codeTitleOf,
  dropHeaderLines,
  hasSiteHome,
  inCodeGroup,
  rewriteForSite,
  SITE_BASE,
  SITE_PAGES,
  SITE_URL,
  siteDescription,
  siteNav,
  siteRewrites,
  siteSidebar,
  siteSourceExcludes,
  withCodeTitle,
} from "../../scripts/site-docs.ts";
import { boostDocument, processTerm } from "../../scripts/site-search.ts";
import {
  gitLastModified,
  iconHead,
  packageFacts,
  readVerification,
  searchHead,
} from "../../scripts/site-seo.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const version = packageVersion(root);
const home = hasSiteHome(root);
const sidebar = siteSidebar(root);
const rewrites = siteRewrites(root);
const facts = packageFacts(root);
const verification = readVerification(root);
const pageDescriptions = readPageDescriptions(root);
// The API reference is generated before VitePress runs (`site:api`): the titles of the members
// that two entry points export, and each page's description from its TSDoc summary.
const apiTitleOf = apiTitles(apiPages(path.join(root, API_OUT)));
const apiDescriptionOf = readDescriptions(path.join(root, API_OUT, API_DESCRIPTIONS));

/** The descriptions file the API generator writes, or none before it has run. */
function readDescriptions(file: string): Map<string, string> {
  const parsed: unknown = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const descriptions = new Map<string, string>();
  if (typeof parsed === "object" && parsed !== null) {
    for (const [page, description] of Object.entries(parsed)) {
      if (typeof description === "string") {
        descriptions.set(page, description);
      }
    }
  }
  return descriptions;
}

const config: UserConfig<DefaultTheme.Config> = defineConfig({
  title: "explorer-verify",
  description: siteDescription(version),
  lang: "en",
  // The icons are files of site/static/, served under the base (#373). Linking them also stops
  // the browser asking for /favicon.ico, which is outside the base and answers 404.
  head: iconHead(),
  base: SITE_BASE,
  srcDir: path.relative(path.join(root, "site"), root),
  srcExclude: siteSourceExcludes(root),
  outDir: "dist",
  cacheDir: path.join(root, "node_modules/.cache/vitepress"),
  cleanUrls: true,
  rewrites,
  // The sitemap lists every page by its absolute URL, without `.html` (cleanUrls). A page's
  // `lastmod` is the date of the last commit that changed its source other than its `Version:`
  // line, which every release rewrites; an API page, generated from many sources, has none, and
  // neither has any page when the checkout is shallow (scripts/site-seo.ts).
  sitemap: {
    hostname: SITE_URL,
    transformItems(items) {
      const sources = new Map(Object.entries(rewrites).map(([source, page]) => [page, source]));
      const dates = gitLastModified(root, [USER_DOCS, SITE_PAGES]);
      return items.map((item) => {
        const page =
          item.url === "" || item.url.endsWith("/") ? `${item.url}index.md` : `${item.url}.md`;
        const lastmod = dates?.get(sources.get(page) ?? "");
        return lastmod === undefined ? item : { ...item, lastmod };
      });
    },
  },
  // A user page's description comes from site/descriptions.json, since the pages hold no
  // frontmatter; an API page's from its TSDoc summary, and a member that two entry points export
  // gets its entry point in its title. Site-only pages set both in their frontmatter.
  transformPageData(pageData) {
    const source = pageData.filePath;
    if (source.startsWith(`${USER_DOCS}/`)) {
      const description = pageDescriptions.get(path.posix.relative(USER_DOCS, source));
      return description === undefined ? undefined : { description };
    }
    if (source.startsWith(`${API_OUT}/`)) {
      const page = path.posix.relative(API_OUT, source);
      return {
        title: apiTitleOf.get(page) ?? pageData.title,
        description: apiDescriptionOf.get(page) ?? pageData.description,
      };
    }
    return undefined;
  },
  // The canonical link, Open Graph and Twitter tags of each page, and on the home page the
  // JSON-LD block and the search console tags (scripts/site-seo.ts). The 404 page gets none.
  transformHead({ page, title, description }) {
    return searchHead({ page, title, description, facts, verification });
  },
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
    // The mark and the two-colour wordmark of the logo and the social image (#373): "explorer" in
    // the text colour and "-verify" in the brand colour (theme/style.css).
    logo: { src: "/logo.svg", alt: "" },
    siteTitle: 'explorer<span class="ev-title-accent">-verify</span>',
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
