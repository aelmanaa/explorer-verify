// Tests the monthly adoption check (scripts/adoption-check.ts): the parsing and problem rules on
// answers shaped like the ones npm, GitHub, Search Console, Bing Webmaster Tools and Context7 gave on
// 2026-11-12, and whole runs against a fake of every service. No test reaches the network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  analyticsRows,
  bingCrawlStats,
  bingDay,
  bingLastCrawled,
  bingMonthTraffic,
  bingQueries,
  bingSitemaps,
  context7Entry,
  CONTEXT7_LIBRARY,
  daysBetween,
  downloadStats,
  findProblems,
  formatPositions,
  formatReferrers,
  googleSitemaps,
  keyPages,
  latestRelease,
  main,
  mergeTraffic,
  monthlyRow,
  monthRange,
  monthTraffic,
  nodeIo,
  PACKAGES,
  parseTrafficLog,
  publishDays,
  redact,
  REPOSITORY,
  searchPositions,
  shortName,
  SITE,
  sitemapUrls,
  tally,
  trafficDays,
  trafficSnapshot,
} from "../adoption-check.ts";
import type { Facts, Io } from "../adoption-check.ts";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "adoption-check.ts");

// Dummy secrets, none a real credential: lowercase hex, so they look like nothing else in the output.
const BING_KEY = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const CONTEXT7_KEY = "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b";
const ACCOUNT = "reader@project.iam.gserviceaccount.com";

/** A Bing date for a UTC day. */
function bingDate(day: string): string {
  return `/Date(${Date.parse(`${day}T00:00:00Z`)})/`;
}

describe("monthRange", () => {
  it("gives the first and last day, leap years included", () => {
    assert.deepEqual(monthRange("2026-11"), { start: "2026-11-01", end: "2026-11-30" });
    assert.deepEqual(monthRange("2028-02"), { start: "2028-02-01", end: "2028-02-29" });
  });

  it("refuses anything but YYYY-MM", () => {
    for (const month of ["2026-13", "2026-1", "november", "2026-11-01"]) {
      assert.throws(() => monthRange(month), { message: /--month must be YYYY-MM/ });
    }
  });
});

describe("sitemapUrls and keyPages", () => {
  it("lists each loc in order, and keeps the pages outside the API reference", () => {
    const xml =
      `<?xml version="1.0"?><urlset><url><loc>${SITE}</loc><lastmod>2026-11-12</lastmod></url>` +
      `<url><loc>\n  ${SITE}api/verify\n</loc></url><url><loc>${SITE}overview</loc></url></urlset>`;
    const urls = sitemapUrls(xml);
    assert.deepEqual(urls, [SITE, `${SITE}api/verify`, `${SITE}overview`]);
    assert.deepEqual(keyPages(urls), [SITE, `${SITE}overview`]);
    assert.deepEqual(sitemapUrls("<urlset></urlset>"), []);
  });
});

describe("redact", () => {
  it("hides the apikey parameter wherever it sits", () => {
    assert.equal(
      redact(`https://ssl.bing.com/x?siteUrl=s&apikey=${BING_KEY}&y=1`),
      "https://ssl.bing.com/x?siteUrl=s&apikey=<redacted>&y=1",
    );
    assert.equal(redact("https://h/x?APIKEY=abc"), "https://h/x?APIKEY=<redacted>");
    assert.equal(redact("https://h/x?siteUrl=s"), "https://h/x?siteUrl=s");
    assert.equal(
      redact(`GET https://h/x?apikey=${BING_KEY} answered 400: bad`),
      "GET https://h/x?apikey=<redacted> answered 400: bad",
    );
  });

  it("hides each known secret, as it is and URL-encoded", () => {
    const secret = "a/b+c";
    assert.equal(
      redact(`Bearer ${TOKEN}, ${secret} and ${encodeURIComponent(secret)}`, [TOKEN, secret, ""]),
      "Bearer <redacted>, <redacted> and <redacted>",
    );
  });
});

describe("Bing answers", () => {
  it("reads Bing's date with and without an offset", () => {
    assert.equal(bingDay("/Date(1791676800000)/"), "2026-10-11");
    assert.equal(bingDay("/Date(1791676800000-0700)/"), "2026-10-11");
    assert.equal(bingDay("2026-10-11"), undefined);
    // The year 1: no date, such as a page never crawled.
    assert.equal(bingDay("/Date(-62135596800000)/"), undefined);
    assert.equal(bingDay(undefined), undefined);
  });

  it("reads a crawled page's day, and nothing for a page never crawled", () => {
    assert.equal(bingLastCrawled({ d: { LastCrawledDate: bingDate("2026-11-12") } }), "2026-11-12");
    assert.equal(bingLastCrawled({ d: { LastCrawledDate: "/Date(-62135596800000)/" } }), undefined);
    assert.equal(bingLastCrawled({}), undefined);
  });

  it("sums the traffic of the days inside the month only", () => {
    const response = {
      d: [
        { Date: bingDate("2026-10-31"), Clicks: 9, Impressions: 90 },
        { Date: bingDate("2026-11-01"), Clicks: 1, Impressions: 10 },
        { Date: bingDate("2026-11-30"), Clicks: 2, Impressions: 20 },
        { Date: bingDate("2026-12-01"), Clicks: 9, Impressions: 90 },
        { Date: "not a date", Clicks: 9, Impressions: 90 },
      ],
    };
    assert.deepEqual(bingMonthTraffic(response, monthRange("2026-11")), {
      clicks: 3,
      impressions: 30,
      days: 2,
    });
    assert.deepEqual(bingMonthTraffic({}, monthRange("2026-11")), {
      clicks: 0,
      impressions: 0,
      days: 0,
    });
  });

  it("takes the latest day of the crawl stats up to the end of the month", () => {
    const response = {
      d: [
        { Date: bingDate("2026-11-10"), InIndex: 0, CrawledPages: 3 },
        { Date: bingDate("2026-11-12"), InIndex: 1, CrawledPages: 20 },
        { Date: bingDate("2026-11-11"), InIndex: 1, CrawledPages: 9 },
        { Date: bingDate("2026-12-03"), InIndex: 50 },
      ],
    };
    assert.deepEqual(bingCrawlStats(response, "2026-11-30"), {
      day: "2026-11-12",
      inIndex: 1,
      crawled: 20,
    });
    assert.deepEqual(bingCrawlStats(response, "2026-12-31"), {
      day: "2026-12-03",
      inIndex: 50,
      crawled: 0,
    });
    assert.equal(bingCrawlStats(response, "2026-10-31"), undefined);
  });

  it("reads the submitted sitemaps", () => {
    assert.deepEqual(
      bingSitemaps({
        d: [
          {
            Url: `${SITE}sitemap.xml`,
            Status: "Success",
            UrlCount: 214,
            LastCrawled: bingDate("2026-11-12"),
          },
          { Url: "s2", LastCrawled: "/Date(-62135596800000)/" },
        ],
      }),
      [
        { url: `${SITE}sitemap.xml`, status: "Success", urlCount: 214, lastRead: "2026-11-12" },
        { url: "s2", status: "no status", urlCount: 0 },
      ],
    );
  });

  it("reads the top queries by impressions", () => {
    const bing = {
      d: [
        { Query: "explorer verify", Clicks: 1, Impressions: 4, AvgImpressionPosition: 3.2 },
        { Query: "etherscan verify", Clicks: 0, Impressions: 9, AvgImpressionPosition: 30 },
      ],
    };
    assert.deepEqual(bingQueries(bing), [
      { key: "etherscan verify", clicks: 0, impressions: 9, position: 30 },
      { key: "explorer verify", clicks: 1, impressions: 4, position: 3.2 },
    ]);
    assert.deepEqual(bingQueries({ d: [] }), []);
  });
});

describe("Google answers", () => {
  it("reads Search Analytics rows by impressions, including the totals row with no keys", () => {
    assert.deepEqual(
      analyticsRows({
        rows: [
          { keys: ["explorer-verify"], clicks: 1, impressions: 3, position: 8.5 },
          { keys: ["site:github.io"], clicks: 0, impressions: 9, position: 276 },
        ],
      }),
      [
        { key: "site:github.io", clicks: 0, impressions: 9, position: 276 },
        { key: "explorer-verify", clicks: 1, impressions: 3, position: 8.5 },
      ],
    );
    assert.deepEqual(analyticsRows({}), []);
    assert.deepEqual(analyticsRows({ rows: [{ clicks: 2, impressions: 12, position: 25.6 }] }), [
      { key: "", clicks: 2, impressions: 12, position: 25.6 },
    ]);
  });

  it("reads a pending sitemap, a read one and one with errors", () => {
    // Search Console writes int64 fields as strings.
    assert.deepEqual(
      googleSitemaps({
        sitemap: [
          { path: `${SITE}sitemap.xml`, isPending: true, errors: "0", contents: [] },
          {
            path: "s2",
            isPending: false,
            lastDownloaded: "2026-11-20T08:00:00.000Z",
            errors: "0",
            contents: [
              { type: "web", submitted: "200" },
              { type: "image", submitted: 14 },
            ],
          },
          { path: "s3", lastDownloaded: "2026-11-21T08:00:00Z", errors: "2" },
        ],
      }),
      [
        { url: `${SITE}sitemap.xml`, status: "Pending", urlCount: 0 },
        { url: "s2", status: "Success", urlCount: 214, lastRead: "2026-11-20" },
        { url: "s3", status: "2 errors", urlCount: 0, lastRead: "2026-11-21" },
      ],
    );
    assert.deepEqual(googleSitemaps({}), []);
  });

  it("counts inspection states, the most common first", () => {
    assert.deepEqual(
      tally([
        "URL is unknown to Google",
        "Submitted and indexed",
        "URL is unknown to Google",
        "Crawled - currently not indexed",
      ]),
      [
        ["URL is unknown to Google", 2],
        ["Crawled - currently not indexed", 1],
        ["Submitted and indexed", 1],
      ],
    );
  });
});

describe("npm answers", () => {
  it("reads a month of downloads: total, median day and busiest day", () => {
    assert.deepEqual(
      downloadStats({
        downloads: [
          { day: "2026-11-07", downloads: 2 },
          { day: "2026-11-08", downloads: 533 },
          { day: "2026-11-09", downloads: 5 },
          { day: "2026-11-10", downloads: 1 },
        ],
      }),
      { total: 541, median: 3.5, busiest: { day: "2026-11-08", downloads: 533 } },
    );
    assert.deepEqual(downloadStats({ downloads: [{ day: "2026-11-01", downloads: 7 }] }), {
      total: 7,
      median: 7,
      busiest: { day: "2026-11-01", downloads: 7 },
    });
    assert.deepEqual(downloadStats({}), { total: 0, median: 0, busiest: undefined });
  });

  it("finds the publish days in a month and the release on latest", () => {
    const registry = {
      "dist-tags": { latest: "0.2.1", next: "0.2.1" },
      time: {
        created: "2026-11-08T10:00:00.000Z",
        modified: "2026-11-12T21:30:00.000Z",
        "0.1.0": "2026-10-30T09:00:00.000Z",
        "0.2.0": "2026-11-08T10:42:19.358Z",
        "0.2.1": "2026-11-12T21:23:14.418Z",
        "0.2.1-next.0": "2026-11-12T08:00:00.000Z",
      },
    };
    assert.deepEqual(publishDays(registry, monthRange("2026-11")), ["2026-11-08", "2026-11-12"]);
    assert.deepEqual(publishDays(registry, monthRange("2026-10")), ["2026-10-30"]);
    assert.deepEqual(publishDays({}, monthRange("2026-11")), []);
    assert.deepEqual(latestRelease(registry), {
      version: "0.2.1",
      published: "2026-11-12T21:23:14.418Z",
    });
    assert.equal(latestRelease({ "dist-tags": { latest: "9.9.9" }, time: {} }), undefined);
    assert.equal(latestRelease({}), undefined);
  });

  it("gives each package's position in a search", () => {
    const positions = searchPositions({
      objects: [
        { package: { name: "@explorer-verify/foundry" } },
        { package: { name: "hardhat" } },
        { package: { name: "explorer-verify" } },
      ],
    });
    assert.equal(positions.get("explorer-verify"), 3);
    assert.equal(
      formatPositions("explorer verify", positions),
      '"explorer verify": foundry 1, core 3',
    );
    assert.equal(
      formatPositions("verify", searchPositions({ objects: [] })),
      '"verify": none in the first 20',
    );
    assert.deepEqual(PACKAGES.map(shortName), ["core", "cli", "foundry", "hardhat"]);
  });
});

describe("Context7 answers", () => {
  it("finds the library among the search results", () => {
    const answer = {
      results: [
        { id: "/other/library", state: "finalized" },
        {
          id: CONTEXT7_LIBRARY,
          state: "finalized",
          lastUpdateDate: "2026-11-12T10:00:00.000Z",
          totalSnippets: 812,
        },
      ],
    };
    assert.deepEqual(context7Entry(answer), {
      state: "finalized",
      lastUpdate: "2026-11-12T10:00:00.000Z",
      snippets: 812,
    });
    assert.deepEqual(context7Entry({ results: [{ id: CONTEXT7_LIBRARY }] }), {
      state: "no state",
      snippets: 0,
    });
    assert.equal(context7Entry({ results: [] }), undefined);
  });
});

describe("the GitHub traffic log", () => {
  const views = {
    count: 3,
    uniques: 2,
    views: [
      { timestamp: "2026-10-30T00:00:00Z", count: 1, uniques: 1 },
      { timestamp: "2026-11-01T00:00:00Z", count: 2, uniques: 1 },
    ],
  };
  const clones = { clones: [{ timestamp: "2026-11-01T00:00:00Z", count: 40, uniques: 9 }] };

  it("reads the days and a snapshot of referrers and paths", () => {
    assert.deepEqual(trafficDays(views, clones), {
      "2026-10-30": { views: 1, viewUniques: 1, clones: 0, cloneUniques: 0 },
      "2026-11-01": { views: 2, viewUniques: 1, clones: 40, cloneUniques: 9 },
    });
    const snapshot = trafficSnapshot(
      "2026-11-12",
      [
        { referrer: "github.com", count: 4, uniques: 3 },
        { referrer: "Google", count: 3, uniques: 2 },
      ],
      [{ path: `/${REPOSITORY}`, title: "x", count: 10, uniques: 4 }],
    );
    assert.equal(
      formatReferrers(snapshot),
      "github.com 4 (3 unique), Google 3 (2 unique), the 14 days to 2026-11-12",
    );
    assert.deepEqual(snapshot.paths, [{ name: `/${REPOSITORY}`, count: 10, uniques: 4 }]);
    assert.equal(
      formatReferrers({ date: "2026-11-12", referrers: [], paths: [] }),
      "none, the 14 days to 2026-11-12",
    );
  });

  it("merges a run into the log, newer days and same-day snapshots replacing older ones", () => {
    const first = mergeTraffic(
      { days: {}, snapshots: [trafficSnapshot("2026-11-02", [], [])] },
      trafficDays(views, clones),
      trafficSnapshot("2026-11-01", [], []),
    );
    const later = mergeTraffic(
      first,
      { "2026-11-01": { views: 5, viewUniques: 3, clones: 41, cloneUniques: 9 } },
      trafficSnapshot("2026-11-01", [{ referrer: "Google", count: 1, uniques: 1 }], []),
    );
    assert.deepEqual(Object.keys(later.days), ["2026-10-30", "2026-11-01"]);
    assert.equal(later.days["2026-11-01"]?.views, 5);
    assert.deepEqual(
      later.snapshots.map((snapshot) => snapshot.date),
      ["2026-11-01", "2026-11-02"],
    );
    assert.equal(later.snapshots[0]?.referrers[0]?.name, "Google");

    const round = parseTrafficLog(JSON.stringify(later));
    assert.deepEqual(round, later);
    assert.deepEqual(monthTraffic(round, monthRange("2026-11")), {
      views: 5,
      clones: 41,
      covered: 1,
      daysInMonth: 30,
    });
  });

  it("refuses a file that is not a traffic log", () => {
    assert.throws(() => parseTrafficLog("[]"), {
      message: "the traffic log is not an object with days and snapshots",
    });
    assert.throws(() => parseTrafficLog('{"days":null,"snapshots":[]}'), {
      message: "the traffic log is not an object with days and snapshots",
    });
    assert.throws(() => parseTrafficLog('{"days":{"Nov 1":{}},"snapshots":[]}'), {
      message: 'the traffic log has a day "Nov 1" that is not YYYY-MM-DD',
    });
    assert.throws(() => parseTrafficLog('{"days":{},"snapshots":[{"date":"x"}]}'), {
      message: 'the traffic log has a snapshot dated "x", not YYYY-MM-DD',
    });
  });

  it("counts days between two days", () => {
    assert.equal(daysBetween("2026-10-29", "2026-11-12"), 14);
    assert.equal(daysBetween("2026-11-12", "2026-11-11"), -1);
  });
});

describe("findProblems", () => {
  const sitemap = { url: `${SITE}sitemap.xml`, status: "Success", urlCount: 214 };
  const healthy: Facts = {
    month: monthRange("2026-11"),
    sitemapUrls: 214,
    keyPages: 76,
    brokenUrls: [],
    skipped: [],
    google: {
      sitemaps: [{ ...sitemap, lastRead: "2026-11-28" }],
      inspected: { indexed: 76, unknown: 0, crawledNotIndexed: [] },
    },
    bing: {
      sitemaps: [{ ...sitemap, lastRead: "2026-11-25" }],
      inIndex: 200,
      inIndexDay: "2026-11-24",
      crawledKeyPages: 76,
    },
    context7: {
      entry: { state: "finalized", lastUpdate: "2026-11-20T00:00:00Z", snippets: 900 },
      refreshed: false,
    },
    latest: { version: "0.2.1", published: "2026-11-12T21:23:14.418Z" },
    downloads: [{ name: "explorer-verify", total: 10 }],
    traffic: { logged: true, previousSnapshot: "2026-11-24", covered: 30, daysInMonth: 30 },
  };

  it("finds nothing in a healthy month", () => {
    assert.deepEqual(findProblems(healthy, "2026-12-01"), []);
  });

  it("names what 2026-11-12 looked like", () => {
    const problems = findProblems(
      {
        ...healthy,
        brokenUrls: [`${SITE}gone (404)`],
        skipped: ["GitHub was not read: gh could not read the repository"],
        google: {
          sitemaps: [{ ...sitemap, status: "Pending", urlCount: 0 }],
          inspected: { indexed: 3, unknown: 72, crawledNotIndexed: [`${SITE}overview`] },
        },
        bing: {
          sitemaps: [{ ...sitemap, lastRead: "2026-11-12" }],
          crawledKeyPages: 2,
          inIndex: 1,
          inIndexDay: "2026-11-05",
        },
        context7: { refreshed: false },
        downloads: [
          { name: "explorer-verify", total: 10 },
          { name: "@explorer-verify/hardhat", total: 0 },
        ],
        traffic: { logged: false },
      },
      "2026-11-12",
    );
    assert.deepEqual(problems, [
      "GitHub was not read: gh could not read the repository",
      `1 sitemap URLs do not answer 200: ${SITE}gone (404)`,
      `Google has not read ${SITE}sitemap.xml yet (Pending).`,
      "72 of the 76 key pages are unknown to Google; request indexing by hand in URL Inspection, about ten a day.",
      `Google crawled but did not index ${SITE}overview; another request does not help, a link from an indexed page or more content may.`,
      "Google indexes 3 of the 76 key pages.",
      "Bing has crawled 2 of the 76 key pages.",
      "Bing indexes 1 of the 214 sitemap URLs as of 2026-11-05, under half; its daily stats run about a week behind.",
      `Context7 does not list ${CONTEXT7_LIBRARY}.`,
      "@explorer-verify/hardhat had no downloads in 2026-11.",
      "GitHub traffic is not logged; GitHub keeps 14 days, so run with --traffic-log every week.",
    ]);
  });

  it("names missing and stale sitemaps, an old Context7 index and gaps in the traffic log", () => {
    const problems = findProblems(
      {
        ...healthy,
        google: { sitemaps: [] },
        bing: {
          sitemaps: [
            { ...sitemap, url: "s1", lastRead: "2026-11-01", status: "Warnings" },
            { ...sitemap, url: "s2", lastRead: "2026-11-30" },
          ],
          inIndex: 1,
        },
        context7: { entry: { state: "finalized", snippets: 1 }, refreshed: false },
        traffic: { logged: true, previousSnapshot: "2026-11-01", covered: 20, daysInMonth: 30 },
      },
      "2026-12-01",
    );
    assert.deepEqual(problems, [
      "No sitemap is submitted to Google.",
      "Bing last read s1 on 2026-11-01.",
      "Bing reports s1 as Warnings.",
      "Bing indexes 1 of the 214 sitemap URLs, under half; its daily stats run about a week behind.",
      "Context7 was last updated on no day, before 0.2.1 (2026-11-12); run with --refresh-context7.",
      "The traffic log's previous run was on 2026-11-01, more than 14 days ago; the days in between are lost.",
      "The traffic log holds 20 of the 30 days of 2026-11.",
    ]);
  });

  it("leaves out what a run did not read or has just refreshed", () => {
    const old = { state: "finalized", lastUpdate: "2026-11-01T00:00:00Z", snippets: 1 };
    const { google: _google, bing: _bing, traffic: _traffic, latest: _latest, ...bare } = healthy;
    assert.deepEqual(
      findProblems({ ...bare, context7: { entry: old, refreshed: false } }, "2026-12-01"),
      [],
    );
    assert.deepEqual(
      findProblems({ ...healthy, context7: { entry: old, refreshed: true } }, "2026-12-01"),
      [],
    );
    assert.deepEqual(
      findProblems(
        {
          ...healthy,
          google: { sitemaps: [{ ...sitemap, lastRead: "2026-11-01" }] },
          bing: { sitemaps: [] },
          context7: { entry: old, refreshed: false },
          // A month that has not ended yet is not a gap.
          traffic: { logged: true, covered: 5, daysInMonth: 30 },
        },
        "2026-11-20",
      ),
      [
        `Google last read ${SITE}sitemap.xml on 2026-11-01.`,
        "No sitemap is submitted to Bing.",
        "Context7 was last updated on 2026-11-01, before 0.2.1 (2026-11-12); run with --refresh-context7.",
      ],
    );
  });
});

describe("monthlyRow", () => {
  it("joins the cells in the table's order with an empty Notes cell", () => {
    assert.equal(
      monthlyRow({
        month: "2026-11",
        downloads: [1, 2, 3, 4],
        stars: "0",
        referrers: "none, the 14 days to 2026-11-12",
        npmPositions: '"explorer verify": core 1',
        indexed: "Google 3 / 76 key pages, Bing n/a, read on 2026-11-12",
        impressions: "Google 0, 0; Bing 0, 0",
        context7: "n/a",
      }),
      '| 2026-11 | 1, 2, 3, 4 | 0 | none, the 14 days to 2026-11-12 | "explorer verify": core 1 | Google 3 / 76 key pages, Bing n/a, read on 2026-11-12 | Google 0, 0; Bing 0, 0 | n/a |  |',
    );
  });
});

// A fake of every service the check reads, on answers shaped like the ones of 2026-11-12.

/** What a fake run does differently from a healthy one. */
interface Options {
  env?: Record<string, string>;
  platform?: string;
  /** The Keychain answer: a key, or undefined to fail as `security` does for a missing item. */
  keychain?: string;
  sitemapStatus?: number;
  /** Answers `gh api` for the repository; false makes gh fail. */
  gh?: boolean;
  gcloud?: boolean;
  /** How many 429 answers npm gives the first downloads request, and its Retry-After. */
  npmRateLimit?: { times: number; retryAfter?: string };
  /** What Bing's GetUrlInfo answers: crawled, throttled once, always throttled, or an error. */
  bingUrlInfo?: "crawled" | "throttle-once" | "throttle" | "error";
  /** Make Bing answer GetRankAndTrafficStats with an error that repeats the key and the URL. */
  bingEchoKey?: boolean;
  /** Make Search Console answer with an error that repeats the token. */
  googleEchoToken?: boolean;
  /** False makes Bing list no submitted sitemap. */
  bingFeeds?: boolean;
  context7Listed?: boolean;
  context7Refresh?: boolean;
}

const SITEMAP_URLS = [SITE, `${SITE}overview`, `${SITE}gone`, `${SITE}api/verify`];

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/** The parsed JSON body of a request; the check sends its bodies as strings. */
function requestBody(init: RequestInit | undefined): unknown {
  return typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers });
}

function fakeWorld(options: Options = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const sleeps: number[] = [];
  const headPauses: number[] = [];
  const commands: string[][] = [];
  const requests: { url: string; method: string; auth: string }[] = [];
  let npmLimited = 0;
  let throttled = 0;
  let flaked = false;

  const fetchFake = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    requests.push({ url, method, auth });
    if (method === "HEAD") {
      if (url.endsWith("/gone")) {
        return new Response(null, { status: 404 });
      }
      if (url.includes("/api/")) {
        throw new Error("connection reset");
      }
      // The overview answers 503 once, as GitHub Pages does under load, then 200.
      if (url.endsWith("/overview") && !flaked) {
        flaked = true;
        return new Response(null, { status: 503 });
      }
      return new Response(null, { status: 200 });
    }
    if (url === `${SITE}sitemap.xml`) {
      return new Response(
        `<urlset>${SITEMAP_URLS.map((loc) => `<url><loc>${loc}</loc></url>`).join("")}</urlset>`,
        { status: options.sitemapStatus ?? 200 },
      );
    }
    if (url.startsWith("https://api.npmjs.org/downloads/range/")) {
      const limit = options.npmRateLimit;
      if (limit !== undefined && npmLimited < limit.times) {
        npmLimited += 1;
        return json(
          { error: "rate limited" },
          429,
          limit.retryAfter === undefined ? {} : { "retry-after": limit.retryAfter },
        );
      }
      const hardhat = url.endsWith("/@explorer-verify/hardhat");
      return json({
        downloads: [
          { day: "2026-11-08", downloads: hardhat ? 0 : 533 },
          { day: "2026-11-09", downloads: 0 },
        ],
      });
    }
    if (url.startsWith("https://registry.npmjs.org/-/v1/search")) {
      return json({ objects: [{ package: { name: "@explorer-verify/foundry" } }] });
    }
    if (url.startsWith("https://registry.npmjs.org/")) {
      return json({
        "dist-tags": { latest: "0.2.1" },
        time: { "0.2.0": "2026-11-08T10:00:00Z", "0.2.1": "2026-11-12T10:00:00Z" },
      });
    }
    if (url.startsWith("https://searchconsole.googleapis.com/")) {
      if (options.googleEchoToken === true) {
        return json({ error: { message: `token ${auth} is not allowed` } }, 403);
      }
      if (url.endsWith("/searchAnalytics/query")) {
        const dimensions = field(requestBody(init), "dimensions");
        return Array.isArray(dimensions)
          ? json({ rows: [{ keys: ["explorer-verify"], clicks: 1, impressions: 4, position: 2 }] })
          : json({ rows: [{ clicks: 1, impressions: 4, position: 2 }] });
      }
      if (url.endsWith("/sitemaps")) {
        return json({ sitemap: [{ path: `${SITE}sitemap.xml`, isPending: true, errors: "0" }] });
      }
      const page = field(requestBody(init), "inspectionUrl");
      const state =
        page === SITE
          ? "Submitted and indexed"
          : page === `${SITE}overview`
            ? "Crawled - currently not indexed"
            : "URL is unknown to Google";
      return json({ inspectionResult: { indexStatusResult: { coverageState: state } } });
    }
    if (url.startsWith("https://ssl.bing.com/")) {
      const bingMethod = new URL(url).pathname.split("/").at(-1);
      if (bingMethod === "GetRankAndTrafficStats") {
        if (options.bingEchoKey === true) {
          return new Response(`{"Message":"bad request ${url} with key ${BING_KEY}"}`, {
            status: 400,
          });
        }
        return json({ d: [{ Date: bingDate("2026-11-12"), Clicks: 0, Impressions: 2 }] });
      }
      if (bingMethod === "GetQueryStats") {
        return json({ d: [] });
      }
      if (bingMethod === "GetCrawlStats") {
        return json({ d: [{ Date: bingDate("2026-11-11"), InIndex: 1, CrawledPages: 3 }] });
      }
      if (bingMethod === "GetFeeds") {
        if (options.bingFeeds === false) {
          return json({ d: [] });
        }
        return json({
          d: [
            {
              Url: `${SITE}sitemap.xml`,
              Status: "Success",
              UrlCount: 214,
              LastCrawled: bingDate("2026-11-12"),
            },
          ],
        });
      }
      const mode = options.bingUrlInfo ?? "crawled";
      if (mode === "throttle" || (mode === "throttle-once" && throttled === 0)) {
        throttled += 1;
        return new Response('{"ErrorCode":"ThrottleHost"}', { status: 400 });
      }
      if (mode === "error") {
        return new Response('{"ErrorCode":"InvalidUrl"}', { status: 400 });
      }
      return json({
        d: {
          LastCrawledDate: url.includes(encodeURIComponent(`${SITE}overview`))
            ? "/Date(-62135596800000)/"
            : bingDate("2026-11-12"),
        },
      });
    }
    if (url.startsWith("https://context7.com/api/v1/search")) {
      return json({
        results:
          options.context7Listed === false
            ? []
            : [
                {
                  id: CONTEXT7_LIBRARY,
                  state: "finalized",
                  lastUpdateDate: "2026-11-01T00:00:00Z",
                  totalSnippets: 812,
                },
              ],
      });
    }
    if (url === "https://context7.com/api/v1/refresh") {
      return options.context7Refresh === false
        ? new Response("", { status: 200 })
        : json({ message: "Refresh started" });
    }
    throw new Error(`unexpected request ${method} ${url}`);
  };

  const run = (command: string, args: readonly string[]): string => {
    commands.push([command, ...args]);
    if (command === "security") {
      if (options.keychain === undefined) {
        throw new Error("security: item not found");
      }
      return `${options.keychain}\n`;
    }
    if (command === "gcloud") {
      if (options.gcloud === false) {
        throw new Error("gcloud failed");
      }
      return `${TOKEN}\n`;
    }
    if (options.gh === false) {
      throw new Error("gh: not logged in");
    }
    const endpoint = args[1] ?? "";
    const answers: Record<string, unknown> = {
      [`repos/${REPOSITORY}`]: { stargazers_count: 2, forks_count: 1, subscribers_count: 1 },
      [`repos/${REPOSITORY}/traffic/views`]: {
        count: 23,
        uniques: 6,
        views: [{ timestamp: "2026-11-11T00:00:00Z", count: 23, uniques: 6 }],
      },
      [`repos/${REPOSITORY}/traffic/clones`]: {
        count: 8,
        uniques: 2,
        clones: [{ timestamp: "2026-11-11T00:00:00Z", count: 8, uniques: 2 }],
      },
      [`repos/${REPOSITORY}/traffic/popular/referrers`]: [
        { referrer: "github.com", count: 4, uniques: 3 },
      ],
      [`repos/${REPOSITORY}/traffic/popular/paths`]: [
        { path: `/${REPOSITORY}`, title: "x", count: 10, uniques: 4 },
      ],
    };
    return JSON.stringify(answers[endpoint]);
  };

  const io: Io = {
    fetch: fetchFake,
    run,
    env: options.env ?? {},
    platform: options.platform ?? "linux",
    today: "2026-11-12",
    sleep: async (ms) => {
      // The pause before a sitemap URL is asked again goes apart from the API pauses.
      (ms === 1000 ? headPauses : sleeps).push(ms);
      await Promise.resolve();
    },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  };
  return {
    io,
    sleeps,
    headPauses,
    commands,
    requests,
    stdout: (): string => out.join(""),
    stderr: (): string => err.join(""),
  };
}

const FULL_ENV = {
  ADOPTION_GSC_SERVICE_ACCOUNT: ACCOUNT,
  BING_WEBMASTER_API_KEY: BING_KEY,
  CONTEXT7_API_KEY: CONTEXT7_KEY,
};

/** Asserts no secret reaches the output. */
function assertNoSecret(text: string): void {
  for (const secret of [BING_KEY, TOKEN, CONTEXT7_KEY]) {
    assert.ok(!text.includes(secret), `the output holds a secret: ${text}`);
  }
}

describe("main", () => {
  it("runs with no credentials, skips Google and Bing, and names them under Problems", async () => {
    const world = fakeWorld();
    assert.equal(await main(["--month", "2026-11"], world.io), 0);
    const out = world.stdout();
    assert.match(out, /sitemap\.xml lists 4 pages today, 3 of them key pages; 2 answer 200/);
    // The overview's 503 and the two broken URLs are each asked again once; the overview passes.
    assert.deepEqual(world.headPauses, [1000, 1000, 1000]);
    assert.doesNotMatch(out, /overview \(503\)/);
    assert.match(
      out,
      /explorer-verify: 533 downloads, median day 266\.5, busiest 2026-11-08 \(533\), published on 2026-11-08, 2026-11-12/,
    );
    assert.match(
      out,
      /search today: "explorer verify": foundry 1; "verify contract etherscan": foundry 1/,
    );
    assert.match(out, /latest: 0\.2\.1, published 2026-11-12/);
    assert.match(out, /2 stars, 1 forks, 1 watchers/);
    assert.match(out, /popular paths:\n {4}\/aelmanaa\/explorer-verify 10 \(4 unique\)/);
    assert.match(
      out,
      /== Google Search Console\n {2}skipped: ADOPTION_GSC_SERVICE_ACCOUNT is not set/,
    );
    assert.match(out, /skipped: no BING_WEBMASTER_API_KEY and no bing-webmaster-api Keychain item/);
    assert.match(
      out,
      /\/aelmanaa\/explorer-verify: finalized, last updated 2026-11-01T00:00:00Z, 812 snippets/,
    );
    assert.match(
      out,
      /- Google Search Console was not read: ADOPTION_GSC_SERVICE_ACCOUNT is not set/,
    );
    assert.match(out, /- Bing Webmaster Tools was not read: no BING_WEBMASTER_API_KEY/);
    assert.match(
      out,
      new RegExp(
        `- 2 sitemap URLs do not answer 200: ${SITE}gone \\(404\\), ${SITE}api/verify \\(connection reset\\)`,
      ),
    );
    assert.match(out, /- Context7 was last updated on 2026-11-01, before 0\.2\.1 \(2026-11-12\)/);
    assert.match(out, /- @explorer-verify\/hardhat had no downloads in 2026-11\./);
    assert.match(out, /- GitHub traffic is not logged/);
    assert.ok(
      out.endsWith(
        '| 2026-11 | 533, 533, 533, 0 | 2 | github.com 4 (3 unique), the 14 days to 2026-11-12 | "explorer verify": foundry 1; "verify contract etherscan": foundry 1 | Google n/a, Bing n/a, read on 2026-11-12 | Google n/a; Bing n/a | finalized, 2026-11-01, 812 snippets |  |\n',
      ),
      out,
    );
    // Linux has no Keychain, and Google is never asked for a token without an account.
    assert.deepEqual(
      world.commands.map((command) => command[0]),
      ["gh", "gh", "gh", "gh", "gh"],
    );
    assert.equal(world.stderr(), "");
  });

  it("reads every source with credentials, logs the traffic and prints the row", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "adoption-check-"));
    try {
      const log = path.join(dir, "traffic.json");
      writeFileSync(
        log,
        JSON.stringify({ days: {}, snapshots: [{ date: "2026-10-20", referrers: [], paths: [] }] }),
      );
      const world = fakeWorld({ env: FULL_ENV });
      assert.equal(
        await main(["--month", "2026-11", "--traffic-log", log, "--refresh-context7"], world.io),
        0,
      );
      const out = world.stdout();
      assertNoSecret(out);
      assert.match(
        out,
        /traffic log: 1 days, 2 snapshots; 2026-11: 23 views, 8 clones over 1 of 30 days/,
      );
      assert.match(
        out,
        /2026-11-01 to 2026-11-30: 4 impressions, 1 clicks\n {2}top queries:\n {4}explorer-verify: 4 impressions, 1 clicks, position 2\.0/,
      );
      assert.match(
        out,
        new RegExp(`sitemap ${SITE}sitemap\\.xml: Pending, 0 URLs, last read never`),
      );
      assert.match(
        out,
        /indexed: 1 \/ 3 key pages \(read today\)\n {4}1 Crawled - currently not indexed\n {4}1 Submitted and indexed\n {4}1 URL is unknown to Google/,
      );
      assert.match(out, new RegExp(`unknown to Google, to request by hand:\n {4}${SITE}gone`));
      assert.match(out, /2026-11-01 to 2026-11-30: 2 impressions, 0 clicks \(1 days reported\)/);
      assert.match(out, /top queries \(recent weeks\):\n {4}none/);
      assert.match(out, /crawl stats on 2026-11-11: 3 pages crawled, 1 in the index/);
      assert.match(
        out,
        new RegExp(`sitemap ${SITE}sitemap\\.xml: Success, 214 URLs, last read 2026-11-12`),
      );
      assert.match(out, /crawled: 2 \/ 3 key pages \(read today\)/);
      assert.match(out, /refresh: Refresh started/);
      assert.match(out, /- The traffic log's previous run was on 2026-10-20/);
      assert.match(
        out,
        new RegExp(`- Google has not read ${SITE}sitemap\\.xml yet \\(Pending\\)\\.`),
      );
      assert.match(out, /- 1 of the 3 key pages are unknown to Google/);
      assert.match(out, /- Bing has crawled 2 of the 3 key pages\./);
      assert.doesNotMatch(out, /Context7 was last updated/);
      assert.match(
        out,
        /\| Google 1 \/ 3 key pages, Bing 1 \/ 4, read on 2026-11-12 \| Google 4, 1; Bing 2, 0 \| finalized, 2026-11-01, 812 snippets \| {2}\|\n$/,
      );
      const saved = parseTrafficLog(readFileSync(log, "utf8"));
      assert.deepEqual(Object.keys(saved.days), ["2026-11-11"]);
      assert.deepEqual(
        saved.snapshots.map((snapshot) => snapshot.date),
        ["2026-10-20", "2026-11-12"],
      );

      // The token goes to Search Console only, the Context7 key to Context7 only.
      const google = world.requests.filter((request) => request.url.includes("googleapis"));
      assert.ok(google.length > 0);
      assert.ok(google.every((request) => request.auth === `Bearer ${TOKEN}`));
      const refresh = world.requests.filter((request) => request.url.endsWith("/refresh"));
      assert.deepEqual(
        refresh.map((request) => request.auth),
        [`Bearer ${CONTEXT7_KEY}`],
      );
      assert.deepEqual(
        world.commands.find((command) => command[0] === "gcloud"),
        [
          "gcloud",
          "auth",
          "print-access-token",
          `--impersonate-service-account=${ACCOUNT}`,
          "--scopes=https://www.googleapis.com/auth/webmasters.readonly",
        ],
      );
      // Bing's per-URL reads wait between calls.
      assert.deepEqual(world.sleeps, [2000, 2000, 2000]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts a traffic log that does not exist yet", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "adoption-check-"));
    try {
      const log = path.join(dir, "new.json");
      const world = fakeWorld();
      assert.equal(await main(["--month", "2026-11", "--traffic-log", log], world.io), 0);
      assert.equal(parseTrafficLog(readFileSync(log, "utf8")).snapshots.length, 1);
      assert.doesNotMatch(world.stdout(), /previous run/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips the inspections with --skip-inspection", async () => {
    const world = fakeWorld({ env: FULL_ENV });
    assert.equal(await main(["--month", "2026-11", "--skip-inspection"], world.io), 0);
    const out = world.stdout();
    assert.doesNotMatch(out, /key pages \(read today\)/);
    assert.ok(!world.requests.some((request) => request.url.includes("urlInspection")));
    assert.ok(!world.requests.some((request) => request.url.includes("GetUrlInfo")));
    assert.match(out, /\| Google n\/a, Bing 1 \/ 4, read on 2026-11-12 \|/);
  });

  it("reads the Bing key from the macOS Keychain, with and without USER", async () => {
    for (const env of [{ USER: "maintainer" }, {}]) {
      const world = fakeWorld({
        env,
        platform: "darwin",
        keychain: BING_KEY,
        context7Listed: false,
      });
      assert.equal(await main(["--month", "2026-11", "--skip-inspection"], world.io), 0);
      const security = world.commands.find((command) => command[0] === "security");
      assert.deepEqual(security, [
        "security",
        "find-generic-password",
        ...("USER" in env ? ["-a", "maintainer"] : []),
        "-s",
        "bing-webmaster-api",
        "-w",
      ]);
      assert.match(world.stdout(), /crawl stats on 2026-11-11/);
      assert.match(world.stdout(), /\/aelmanaa\/explorer-verify is not listed/);
      assert.match(world.stdout(), /- Context7 does not list \/aelmanaa\/explorer-verify\./);
      assert.match(world.stdout(), /\| n\/a \| {2}\|\n$/);
    }
  });

  it("treats an empty variable or Keychain answer as no credential", async () => {
    const world = fakeWorld({
      env: { ADOPTION_GSC_SERVICE_ACCOUNT: "", BING_WEBMASTER_API_KEY: "" },
      platform: "darwin",
      keychain: "",
    });
    assert.equal(await main(["--month", "2026-11"], world.io), 0);
    assert.match(world.stdout(), /ADOPTION_GSC_SERVICE_ACCOUNT is not set/);
    assert.match(world.stdout(), /no BING_WEBMASTER_API_KEY/);

    const missing = fakeWorld({ platform: "darwin" });
    assert.equal(await main(["--month", "2026-11"], missing.io), 0);
    assert.ok(missing.commands.some((command) => command[0] === "security"));
    assert.match(missing.stdout(), /no BING_WEBMASTER_API_KEY/);
  });

  it("names a console with no sitemap submitted", async () => {
    const world = fakeWorld({ env: FULL_ENV, bingFeeds: false });
    assert.equal(await main(["--month", "2026-11", "--skip-inspection"], world.io), 0);
    assert.match(world.stdout(), /== Bing Webmaster Tools\n[^=]*no sitemap submitted\n/);
    assert.match(world.stdout(), /- No sitemap is submitted to Bing\./);
  });

  it("skips a source whose tool fails, and says why", async () => {
    const world = fakeWorld({ env: FULL_ENV, gh: false, gcloud: false });
    assert.equal(await main(["--month", "2026-11", "--skip-inspection"], world.io), 0);
    const out = world.stdout();
    assert.match(
      out,
      /- GitHub was not read: gh could not read repos\/aelmanaa\/explorer-verify; run `gh auth login`/,
    );
    assert.match(
      out,
      /- Google Search Console was not read: gcloud could not get a token for ADOPTION_GSC_SERVICE_ACCOUNT/,
    );
    assert.doesNotMatch(out, /GitHub traffic is not logged/);
    assert.match(out, /\| 2026-11 \| 533, 533, 533, 0 \| n\/a \| n\/a \|/);
  });

  it("never prints the Bing key, even in a URL or an answer that repeats it", async () => {
    const world = fakeWorld({ env: FULL_ENV, bingEchoKey: true });
    assert.equal(await main(["--month", "2026-11", "--skip-inspection"], world.io), 0);
    const out = world.stdout();
    assertNoSecret(out);
    assert.match(
      out,
      /- Bing Webmaster Tools was not read: GET https:\/\/ssl\.bing\.com\/webmaster\/api\.svc\/json\/GetRankAndTrafficStats\?siteUrl=[^&]+&apikey=<redacted> answered 400: \{"Message":"bad request https:\/\/ssl\.bing\.com\/\S+apikey=<redacted> with key <redacted>"\}/,
    );
  });

  it("never prints the Google token, even in an answer that repeats it", async () => {
    const world = fakeWorld({ env: FULL_ENV, googleEchoToken: true });
    assert.equal(await main(["--month", "2026-11", "--skip-inspection"], world.io), 0);
    assertNoSecret(world.stdout());
    assert.match(
      world.stdout(),
      /Google Search Console was not read: POST \S+ answered 403: .*token Bearer <redacted> is not allowed/,
    );
  });

  it("retries a 429, after Retry-After or a growing pause", async () => {
    const after = fakeWorld({ npmRateLimit: { times: 1, retryAfter: "3" } });
    assert.equal(await main(["--month", "2026-11", "--skip-inspection"], after.io), 0);
    assert.deepEqual(after.sleeps, [3000]);

    const growing = fakeWorld({ npmRateLimit: { times: 2 } });
    assert.equal(await main(["--month", "2026-11", "--skip-inspection"], growing.io), 0);
    assert.deepEqual(growing.sleeps, [10_000, 20_000]);

    const capped = fakeWorld({ npmRateLimit: { times: 1, retryAfter: "600" } });
    assert.equal(await main(["--month", "2026-11", "--skip-inspection"], capped.io), 0);
    assert.deepEqual(capped.sleeps, [120_000]);

    const exhausted = fakeWorld({ npmRateLimit: { times: 4 } });
    assert.equal(await main(["--month", "2026-11", "--skip-inspection"], exhausted.io), 0);
    assert.match(
      exhausted.stdout(),
      /- npm was not read: GET https:\/\/api\.npmjs\.org\/\S+ answered 429/,
    );
    assert.match(exhausted.stdout(), /\| 2026-11 \|  \| 2 \|/);
  });

  it("waits out Bing's ThrottleHost on the per-URL reads, and gives up after six tries", async () => {
    const once = fakeWorld({ env: FULL_ENV, bingUrlInfo: "throttle-once" });
    assert.equal(await main(["--month", "2026-11"], once.io), 0);
    assert.deepEqual(once.sleeps, [5000, 2000, 2000, 2000]);
    assert.match(once.stdout(), /crawled: 2 \/ 3 key pages/);

    const always = fakeWorld({ env: FULL_ENV, bingUrlInfo: "throttle" });
    assert.equal(await main(["--month", "2026-11"], always.io), 0);
    assert.deepEqual(always.sleeps, [5000, 10_000, 15_000, 20_000, 25_000]);
    assert.match(always.stdout(), /crawled key pages: not read, Bing throttled the per-URL calls/);
    assert.doesNotMatch(always.stdout(), /Bing has crawled/);

    const error = fakeWorld({ env: FULL_ENV, bingUrlInfo: "error" });
    assert.equal(await main(["--month", "2026-11"], error.io), 0);
    assert.deepEqual(error.sleeps, []);
  });

  it("refuses a refresh without a Context7 key, and accepts an empty answer to one", async () => {
    const missing = fakeWorld();
    assert.equal(await main(["--month", "2026-11", "--refresh-context7"], missing.io), 0);
    assert.match(
      missing.stdout(),
      /- Context7 was not read: --refresh-context7 needs CONTEXT7_API_KEY or a context7-api Keychain item/,
    );
    const empty = fakeWorld({ env: { CONTEXT7_API_KEY: CONTEXT7_KEY }, context7Refresh: false });
    assert.equal(await main(["--month", "2026-11", "--refresh-context7"], empty.io), 0);
    assert.match(empty.stdout(), /refresh: started/);
  });

  it("fails on bad arguments and on a sitemap that does not answer", async () => {
    for (const argv of [[], ["--month", "2026-13"], ["--month", "2026-11", "--unknown"]]) {
      const world = fakeWorld();
      assert.equal(await main(argv, world.io), 1);
      assert.notEqual(world.stderr(), "");
      assert.equal(world.requests.length, 0);
    }
    const down = fakeWorld({ sitemapStatus: 503 });
    assert.equal(await main(["--month", "2026-11"], down.io), 1);
    assert.equal(down.stderr(), `${SITE}sitemap.xml answered 503\n`);
  });
});

describe("the command", () => {
  it("prints the usage and exits 1 without reaching any service", () => {
    // Only the coverage directory passes to the child, so no credential can.
    const coverage = process.env["NODE_V8_COVERAGE"];
    const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", SCRIPT], {
      encoding: "utf8",
      env: coverage === undefined ? {} : { NODE_V8_COVERAGE: coverage },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^--month is required\nusage: node scripts\/adoption-check\.ts/);
    assert.equal(result.stdout, "");
  });

  it("runs a real run's tools: fetch, child processes, sleep and the streams", async () => {
    const io = nodeIo();
    assert.equal(await (await io.fetch("data:,hello")).text(), "hello");
    assert.equal(io.run(process.execPath, ["-e", "process.stdout.write('ok')"]), "ok");
    await io.sleep(1);
    io.out("");
    io.err("");
    assert.equal(io.platform, process.platform);
    assert.match(io.today, /^\d{4}-\d{2}-\d{2}$/);
  });
});
