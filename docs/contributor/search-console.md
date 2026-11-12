# Search console

Audience: the maintainer. This page lists the one-time and per-release steps that get the docs
site, <https://aelmanaa.github.io/explorer-verify/>, into Google and Bing search (R-AX-17). The
build side is in [Tooling](tooling.md#search-engines).

Everything on this page reaches the site with the next promoted release: the docs deploy builds
from the release tag only ([Releasing](releasing.md#docs-deploy)).

## Where the verification values go

The verification values are public by design: they are in the served HTML or file, so they are
committed.

| Value                                        | Where it goes                                                                        | What the site serves                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Google HTML tag (`google-site-verification`) | `google` in `site/verification.json`                                                 | `<meta name="google-site-verification">` on the home page   |
| Google HTML file (`google<token>.html`)      | the file in `site/static/`, and its name in `googleFile` in `site/verification.json` | the file at `/explorer-verify/google<token>.html`, as it is |
| Bing HTML tag (`msvalidate.01`)              | `bing` in `site/verification.json`                                                   | `<meta name="msvalidate.01">` on the home page              |

- Paste only the `content` value of a tag, not the whole tag. An empty value emits no tag.
- Keep the Google file byte for byte as Google gives it: one line,
  `google-site-verification: google<token>.html`. `scripts/site-copies.ts` copies every file in
  `site/static/` to the site root as it is: no layout, no link rewrite, no Markdown copy and no
  sitemap entry. The formatter skips that folder.
- `site:check` fails when the file named in `googleFile` is missing from the build or its content
  differs, and when a set tag is missing from the home page. The smoke check after a deploy
  fetches the file and the home page.
- Do not remove a verification value or file after the property is verified. Google says:
  "Removing this verification file from your site will cause you to lose verification for the
  site" ([verify site ownership](https://support.google.com/webmasters/answer/9008080)).

Bing's value stays empty while the property is imported from Search Console (below).

## One-time setup

Google Search Console:

1. Add a URL-prefix property for `https://aelmanaa.github.io/explorer-verify/`. A domain
   property needs DNS access to `github.io`, which the project does not have.
2. Put the value of the HTML tag or the HTML file method where the table above says, merge the
   pull request, and wait for a release that deploys the site. The repository holds both Google
   values for the property already.
3. Press Verify in the console.
4. Under Sitemaps, submit `sitemap.xml`. The console reads it relative to the property, so the
   full URL is `https://aelmanaa.github.io/explorer-verify/sitemap.xml`.

Bing Webmaster Tools:

1. Import the property from Search Console
   ([Bing, 2019-09](https://blogs.bing.com/webmaster/september-2019/Import-sites-from-Search-Console-to-Bing-Webmaster-Tools)).
   The import verifies the site, so `bing` can stay empty.
2. Submit `https://aelmanaa.github.io/explorer-verify/sitemap.xml`.

## After each promoted release

1. In Search Console, open URL Inspection and request indexing for the pages Google does not
   know yet, about ten a day. Start with the home page, the overview, the quickstarts, the errors
   index and the error code pages.
2. Do not resubmit the sitemap: it does not make Google crawl sooner.

On hardhat-kms, a `github.io` project site with the same setup, Google had indexed only the home
page a month after launch, and the console showed "Couldn't fetch" for a valid sitemap.
Requesting indexing by hand is what worked. Bing read the sitemap the day it was submitted
([hardhat-kms adoption metrics](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/contributor/adoption-metrics.md#pages-that-are-not-indexed)).

## Why there is no robots.txt

Crawlers read `robots.txt` only at the root of a host
([RFC 9309, section 2.3](https://www.rfc-editor.org/rfc/rfc9309#section-2.3)). The site is a
project site under `https://aelmanaa.github.io/explorer-verify/`, and
`https://aelmanaa.github.io/robots.txt` is outside this repository. A `robots.txt` in the build
would never be read, so `site:check` fails when one is built. Submitting the sitemap in each
console replaces its `Sitemap:` line.
