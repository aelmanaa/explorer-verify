// A small repository tree that passes every agent-docs rule. Each test copies it into a fresh
// temporary folder and breaks one rule.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { CORE_ENTRY, RAW_MAIN } from "../agent-docs.ts";
import { SITE_URL } from "../site-docs.ts";
import { BRAND_FILES, BRAND_SIZES, SOCIAL_IMAGE } from "../site-seo.ts";

/** The user index page of the fixture. */
export const README = "docs/user/README.md";
/** The agent page of the fixture. */
export const AGENT = "docs/user/guides/using-from-an-agent.md";
/** An image the index page links. */
export const IMAGE = "docs/user/img/logo.png";
/** The skill of the fixture, at the repository root. */
export const SKILL = "skills/explorer-verify/SKILL.md";

const LLMS_TXT = `# explorer-verify

> Verifies contract source on block explorers.

## User docs

- [Index](${RAW_MAIN}${README}): the index
- [Agents](${RAW_MAIN}${AGENT}): the agent page
- [Skill](${RAW_MAIN}${SKILL}): the skill

## Contributor docs

- [AGENTS](${RAW_MAIN}AGENTS.md): start here
- [Elsewhere](https://example.com/page.md): not in this repository
`;

/** The files of the fixture, by path. */
export const VALID: Readonly<Record<string, string>> = {
  "packages/explorer-verify/package.json": JSON.stringify({
    name: "fixture-package",
    version: "1.2.3",
    type: "module",
    files: ["docs/", "skills/", "llms.txt"],
  }),
  // The built entry point, which check-packed-files.ts reads the error codes from.
  [CORE_ENTRY]: "export const ERROR_CODES = [];\n",
  "llms.txt": LLMS_TXT,
  [README]: `# User docs

Version: explorer-verify 1.2.3

Agents: [llms.txt](../../llms.txt).

See [the agent page](guides/using-from-an-agent.md#notes), [guides](guides/) and [AGENTS](../../AGENTS.md).

![logo](img/logo.png)
`,
  [IMAGE]: "PNG",
  [SKILL]: `---
name: explorer-verify
---

Read [llms.txt](../../llms.txt), [the agent page](../../docs/user/guides/using-from-an-agent.md#notes), [stop](#stop) and [AGENTS](../../AGENTS.md).

## Stop
`,
  [AGENT]: `# Using explorer-verify from an agent

Version: explorer-verify 1.2.3

Agents: [llms.txt](../../../llms.txt).
For: agents.
You need: a shell.

## Submit is permanent
## Safe steps
## API keys

## Etherscan plan rule

## Notes

Back to the [index](../README.md#user-docs), [this section](#notes), the [top](#) and [a host](//example.com/x.md).

## Next steps
`,
  "docs/contributor/notes.md": "# Notes\n\n[Requirements](requirements.md)\n",
  "docs/contributor/requirements.md": "# Requirements\n",
  "AGENTS.md": "# AGENTS\n",
};

/** Creates a fresh copy of the fixture and returns its root. */
export function makeFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "agent-docs-"));
  writeFiles(root, VALID);
  return root;
}

/** Removes a fixture. */
export function removeFixture(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/** Writes files into a fixture, creating folders. */
export function writeFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
}

/** Replaces the first `from` in a fixture file with `to`, and fails when `from` is absent. */
export function edit(root: string, file: string, from: string, to: string): void {
  const text = readFileSync(path.join(root, file), "utf8");
  assert.ok(text.includes(from), `${file} has no ${from}`);
  writeFileSync(path.join(root, file), text.replace(from, to));
}

/** Reads a fixture file. */
export function read(root: string, file: string): string {
  return readFileSync(path.join(root, file), "utf8");
}

/** What `builtPage` writes into the head of a page, each part replaceable. */
export interface BuiltPageParts {
  /** The page gets the JSON-LD block of the home page, naming `version`. */
  home?: boolean;
  version?: string;
  title?: string;
  description?: string;
  canonical?: string;
  /** The `og:url`, by default the canonical URL. */
  ogUrl?: string;
  /** Raw HTML added at the end of the head, or in place of the JSON-LD block when set. */
  extra?: string;
}

/**
 * The HTML of a built page at `page`, its URL path on the docs site (`""` for the home page), with
 * the head VitePress and the site config write: a title, a description, a canonical link, the
 * Open Graph tags and the social image tags, each unique to the page unless `parts` replaces it.
 */
export function builtPage(page: string, parts: BuiltPageParts = {}): string {
  const url = parts.canonical ?? `${SITE_URL}${page}`;
  const name = page === "" ? "home" : page;
  const title = parts.title ?? `The page ${name} | explorer-verify`;
  const description =
    parts.description ?? `The fixture page ${name}, with a description of its own.`;
  const jsonLd =
    parts.home === true
      ? `<script type="application/ld+json">${JSON.stringify({
          "@type": "SoftwareSourceCode",
          version: parts.version ?? "1.2.3",
        })}</script>`
      : "";
  return [
    "<!DOCTYPE html><html><head>",
    `<title>${title}</title>`,
    `<meta name="description" content="${description}">`,
    `<link rel="canonical" href="${url}">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta property="og:url" content="${parts.ogUrl ?? url}">`,
    `<meta property="og:image" content="${SOCIAL_IMAGE}">`,
    `<meta property="og:image:width" content="1280">`,
    `<meta property="og:image:height" content="640">`,
    `<meta property="og:image:alt" content="The social image">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:image" content="${SOCIAL_IMAGE}">`,
    parts.extra ?? jsonLd,
    "</head><body></body></html>",
  ].join("\n");
}

/** The first 24 bytes of a PNG file of `width` by `height`: its signature and IHDR size. */
export function pngHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(header);
  header.write("IHDR", 12, "latin1");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

/** Writes the icons and the social image into a built site `outDir`, each PNG at its size. */
export function writeBrandFiles(outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  for (const file of BRAND_FILES) {
    const size = BRAND_SIZES.get(file);
    writeFileSync(
      path.join(outDir, file),
      size === undefined ? '<svg xmlns="http://www.w3.org/2000/svg"/>' : pngHeader(...size),
    );
  }
}

/** A sitemap that lists `pages`, URL paths on the docs site, as VitePress writes it. */
export function sitemapOf(pages: readonly string[]): string {
  const urls = pages.map((page) => `<url><loc>${SITE_URL}${page}</loc></url>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
}
