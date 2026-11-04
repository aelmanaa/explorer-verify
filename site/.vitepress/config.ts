// The VitePress config of the docs site (R-AX-17, decision 0015). It builds the pages in
// `docs/user/` as they are: the pages hold no frontmatter, Vue components or containers, and this
// config lives outside them, so GitHub and the npm package never see it. It also builds the API
// reference that site/api-reference.ts generates into `site/api/` (R-AX-2). VitePress reads both
// from the repository root, and `srcExclude` hides every other Markdown file. The link rules, the
// sidebar and the Markdown copies are in scripts/site-docs.ts.
//
// Build: pnpm run site:build. Preview: pnpm run site:preview.
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitepress";
import type { DefaultTheme, UserConfig } from "vitepress";

import { githubSlug, packageVersion, USER_DOCS } from "../../scripts/agent-docs.ts";
import {
  rewriteForSite,
  SITE_BASE,
  siteRewrites,
  siteSidebar,
  siteSourceExcludes,
} from "../../scripts/site-docs.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const version = packageVersion(root);

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
    },
  },
  themeConfig: {
    search: { provider: "local" },
    sidebar: siteSidebar(root),
    outline: [2, 3],
    nav: [
      { text: "API reference", link: "/api/" },
      { text: `Version ${version}`, link: "/" },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/aelmanaa/explorer-verify" }],
  },
  vite: {
    // Vite's root is `srcDir`, the repository root, and Vite reads `.env` files from its root by
    // default. The site's folder holds none, so no local secret reaches the build (decision 0028).
    envDir: path.join(root, "site"),
    plugins: [
      {
        // Rewrites the links of each page before VitePress reads it (scripts/site-docs.ts).
        name: "explorer-verify:site-links",
        enforce: "pre",
        transform(code: string, id: string): string | undefined {
          const file = path.relative(root, id).split(path.sep).join("/");
          return file.startsWith(`${USER_DOCS}/`) && file.endsWith(".md")
            ? rewriteForSite(file, code, version)
            : undefined;
        },
      },
    ],
  },
});

export default config;
