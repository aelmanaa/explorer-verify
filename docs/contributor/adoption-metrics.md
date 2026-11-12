# Adoption metrics

Audience: the maintainer, recording once a month how people and search engines find
explorer-verify. Assumes push access to the repository for the traffic numbers, and access to the
docs site's properties in Google Search Console and Bing Webmaster Tools.

Each source moves on its own clock: npm counts downloads per day, GitHub keeps traffic for 14
days, and search engines index pages over weeks. Read each one the same way every month and write
the result under [Monthly entries](#monthly-entries), so a drop or a new channel shows up against
the month before. There are no targets and no analytics on the docs site. This page records only
what the services already report.

## When to run it

- In the first week of each month, run the [adoption check](#the-adoption-check) for the month
  before and add its row under [Monthly entries](#monthly-entries), with notes.
- Fix or open an issue for each line under Problems.
- Every week, run it again with the same `--traffic-log`, so no day of GitHub traffic is lost.
- After each minor release, run it with `--refresh-context7`.

## The adoption check

`scripts/adoption-check.ts` reads npm, GitHub, Google Search Console, Bing Webmaster Tools and
Context7 for one month, lists what looks wrong, and prints the month's row:

```sh
ADOPTION_GSC_SERVICE_ACCOUNT=<service account email> node scripts/adoption-check.ts --month 2026-11 \
  --traffic-log <file outside the repository>
```

It prints, in order:

- The pages in the sitemap today, how many are key pages, and how many answer 200. The key pages
  are every sitemap URL outside the generated API reference under `api/`.
- npm: each package's downloads in the month, the median day, the busiest day and the days it
  published a version; the position of each package in the registry search for
  "explorer verify" and "verify contract etherscan" today; the version on `latest`.
- GitHub: stars, forks and watchers, the last 14 days' views, clones, referrers and popular paths,
  and the month's views and clones from the traffic log.
- Google: the month's impressions and clicks, the top queries and pages, the state of each
  submitted sitemap, and the index state of every key page, read today with the URL Inspection
  API, with the pages Google does not know.
- Bing: the month's impressions and clicks, the top queries of recent weeks, the crawled and
  indexed counts on the last day of the month that Bing's daily stats reach, the state of each
  submitted sitemap, and how many key pages Bing has crawled, read per URL today.
- Context7: the index state, last update and snippet count.
- Problems, such as:
  - a sitemap URL that does not answer 200;
  - a sitemap a console has not read, or has not read again for a week (Google) or two (Bing);
  - key pages unknown to Google, or crawled and not indexed;
  - Bing crawling fewer than all the key pages, or indexing under half the sitemap;
  - Context7 not listing the library, or older than the release on `latest`;
  - a package with no downloads;
  - a gap of more than 14 days in the traffic log;
  - a source the check skipped, and why.
- The row for [Monthly entries](#monthly-entries), with the Notes cell empty.

Options:

- `--traffic-log <file>` merges GitHub's daily views and clones into a JSON file and keeps a dated
  copy of the 14-day referrers and paths. Keep the file outside the repository. It holds no
  secret.
- `--skip-inspection` leaves out the Google URL Inspection and Bing's per-URL reads. The check
  reads one URL from Bing every two seconds and waits longer when Bing answers `ThrottleHost`. On
  2026-11-12 the full run over 76 key pages took more than ten minutes, most of it on Bing.
- `--refresh-context7` asks Context7 to index the docs again; see [Context7](#context7).

The check writes nothing to npm, GitHub or the search consoles. The traffic log and the Context7
refresh are the only writes, and each needs its option. A source without credentials is skipped
and named under Problems. The check exits 0 when it ran, with problems or not, and 1 when it could
not run: a bad option, or a sitemap that does not answer.

No token or key reaches the output. Bing takes its key in the query string, so every line the
check prints, errors included, has the value of any `apikey` parameter and every secret it read
replaced with `<redacted>`.

## One-time setup

npm and Context7's state need no credentials.

GitHub: `gh auth login` with an account that has push access to the repository. The traffic
endpoints need push access.

Google: a service account with no key, which the maintainer impersonates. In a Google Cloud project
of the maintainer's:

```sh
gcloud services enable searchconsole.googleapis.com iamcredentials.googleapis.com --project <project>
gcloud iam service-accounts create adoption-reader --project <project>
gcloud iam service-accounts add-iam-policy-binding <service account email> \
  --project <project> --member "user:<maintainer's Google account>" \
  --role roles/iam.serviceAccountTokenCreator
```

Then, in Search Console, under Settings, Users and permissions, add the service account to the
`https://aelmanaa.github.io/explorer-verify/` property with the Restricted permission. The check
gets a short-lived token with:

```sh
gcloud auth print-access-token --impersonate-service-account=<service account email> \
  --scopes=https://www.googleapis.com/auth/webmasters.readonly
```

Without `--scopes`, the token carries the default cloud scope, and Search Console lists no site
for it. Set `ADOPTION_GSC_SERVICE_ACCOUNT` to the account's email when you run the check.

Bing: in Bing Webmaster Tools, under Settings, API access, generate an API key. Keep it in
`BING_WEBMASTER_API_KEY`, or on macOS in the login Keychain, where the check reads it without a
prompt:

```sh
security add-generic-password -a "$USER" -s bing-webmaster-api -w
```

The command asks for the key, so it stays out of the shell history.

Context7: for `--refresh-context7` only, an API key from <https://context7.com/dashboard> in
`CONTEXT7_API_KEY`, or in the login Keychain item `context7-api`
(`security add-generic-password -a "$USER" -s context7-api -w`).

## Downloads

The npm downloads API counts registry downloads per package, one count per day, from
`https://api.npmjs.org/downloads/range/<start>:<end>/<package>`. The check reads one package at a
time, because the bulk form does not accept scoped packages. The API does not tell installs from
CI runs or mirrors, and this repository's own release checks install from npm on release days, so
the busiest day is usually a release day. Read the median day for the trend.

## Search consoles

The docs site's setup in both consoles, and the steps after each release, are in
[Search console](search-console.md). On 2026-11-12, the day after the sitemap was submitted:

- Google listed the sitemap as pending: never read, with no URL counted.
- Bing had read it: status Success, 214 URLs.

When the check lists key pages as unknown to Google, request indexing for them by hand in Search
Console, URL Inspection, about ten a day. Resubmitting the sitemap does not help.

## Context7

Context7 indexes the user docs from `context7.json` at the repository root. Its id for the library
is `/aelmanaa/explorer-verify`. The check reads the state from
`https://context7.com/api/v1/search?query=explorer-verify`.

On hardhat-kms, Context7 did not pick up later releases on its own, and a refresh took about ten
minutes
([hardhat-kms adoption metrics](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/contributor/adoption-metrics.md#agent-listings)).
When the check reports Context7 older than `latest`, run it with `--refresh-context7`.

## Monthly entries

One row per month, newest at the bottom. Write the month the numbers cover, not the day they were
read, and "n/a" for a source with no data.

| Month   | Downloads (core, cli, foundry, hardhat) | Stars | Top referrers                                      | npm position                                                                                | Indexed (Google key pages, Bing sitemap)              | Impressions, clicks (Google; Bing) | Context7                             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------- | --------------------------------------- | ----- | -------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11 | 595, 565, 606, 547                      | 0     | github.com 4 (3 unique), the 14 days to 2026-11-12 | "explorer verify": foundry 1, hardhat 2, cli 3, core 4; "verify contract etherscan": cli 20 | Google 3 / 76 key pages, Bing n/a, read on 2026-11-12 | Google 0, 0; Bing 0, 0             | finalized, 2026-11-12, 1321 snippets | Partial: read on 2026-11-12, twelve days into the month. Each package's busiest day was 2026-11-08, a publish day, and its median day was 0, so the downloads are mostly release traffic. Google had not read the sitemap (pending); 72 of the 76 key pages were unknown to it and `start/` was crawled but not indexed. Bing had read the sitemap (Success, 214 URLs) but had no crawl stats yet and had crawled none of the key pages. One API reference page answered 503 once, then 200. The traffic log starts on 2026-11-12. |
