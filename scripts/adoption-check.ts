// The monthly adoption check (docs/contributor/adoption-metrics.md, issue #376). For one month it
// reads npm, GitHub, Google Search Console, Bing Webmaster Tools and Context7 through their APIs,
// lists what looks wrong, and prints the month's row for the page. It only reads: the exceptions are
// the traffic log that --traffic-log writes to a local file, and the Context7 refresh that
// --refresh-context7 asks for.
//
//   node scripts/adoption-check.ts --month 2026-11 [--traffic-log <file>] [--skip-inspection]
//     [--refresh-context7]
//
// GitHub keeps traffic for 14 days. --traffic-log merges each day's views and clones into a JSON
// file and keeps a dated copy of the 14-day referrers and popular paths, so a run every week loses
// nothing.
//
// Credentials. npm and Context7's state need none. GitHub: the gh CLI, signed in with push access to
// the repository. Google: a read-only service account that the maintainer impersonates with gcloud,
// named by ADOPTION_GSC_SERVICE_ACCOUNT, so no key file exists. Bing and the Context7 refresh: an
// API key from BING_WEBMASTER_API_KEY and CONTEXT7_API_KEY, or on macOS from the login Keychain
// items bing-webmaster-api and context7-api. A source without credentials is skipped and named
// under Problems. No token or key is printed: every line of output goes through `redact`, which
// removes each secret the run read and the value of any `apikey` query parameter.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";

import { errorMessage, isMainModule } from "./release-packages.ts";

/** The repository, for the GitHub API. */
export const REPOSITORY = "aelmanaa/explorer-verify";

/** The published packages, in the order of the row's downloads column. */
export const PACKAGES = [
  "explorer-verify",
  "@explorer-verify/cli",
  "@explorer-verify/foundry",
  "@explorer-verify/hardhat",
] as const;

/** The npm searches whose positions the row records. */
export const NPM_SEARCHES = ["explorer verify", "verify contract etherscan"] as const;

/** How many npm search results the check reads. */
export const SEARCH_SIZE = 20;

/** The docs site, a URL-prefix property in both consoles. */
export const SITE = "https://aelmanaa.github.io/explorer-verify/";

/** The library's id on Context7. */
export const CONTEXT7_LIBRARY = "/aelmanaa/explorer-verify";

/** The days GitHub keeps traffic for. */
export const TRAFFIC_DAYS = 14;

const NPM_DOWNLOADS = "https://api.npmjs.org/downloads";
const NPM_REGISTRY = "https://registry.npmjs.org";
const GSC = "https://searchconsole.googleapis.com";
const BING = "https://ssl.bing.com/webmaster/api.svc/json";
const CONTEXT7 = "https://context7.com/api/v1";

/** Days after which a sitemap that a console has not read again is a problem. */
const SITEMAP_STALE_DAYS = { google: 7, bing: 14 } as const;

/** Sitemap URLs checked at once for a 200. */
const URL_CHECK_CONCURRENCY = 8;

/** The pause before a sitemap URL that did not answer 200 is asked again. */
const HEAD_RETRY_PAUSE_MS = 1000;

/** URL Inspection calls in flight at once; the quota is 600 a minute. */
const INSPECTION_CONCURRENCY = 6;

/** How many queries and pages to print. */
const TOP = 10;

/** Tries of a request that answers 429, and the pause before the next when it gives no Retry-After. */
const RATE_LIMIT_TRIES = 4;
const RATE_LIMIT_PAUSE_MS = 10_000;

/** The pause between Bing's per-URL calls, and after a throttled one, which Bing answers with ThrottleHost. */
const BING_URL_PAUSE_MS = 2000;
const BING_THROTTLE_PAUSE_MS = 5000;
const BING_URL_TRIES = 6;

/** The coverage state Google gives an indexed page. */
export const INDEXED = "Submitted and indexed";

/** The coverage state of a page Google fetched and chose not to index yet. */
export const CRAWLED_NOT_INDEXED = "Crawled - currently not indexed";

/** The coverage state of a page Google has not discovered. */
export const UNKNOWN = "URL is unknown to Google";

/** What the check reads from and writes to, so the tests can run it on recorded answers. */
export interface Io {
  readonly fetch: typeof fetch;
  /** Runs a command and returns its standard output; throws when it fails. */
  readonly run: (command: string, args: readonly string[]) => string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: string;
  /** The day of the run, as `YYYY-MM-DD`. */
  readonly today: string;
  readonly sleep: (ms: number) => Promise<void>;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** The first and last day of a month, as `YYYY-MM-DD`. */
export interface MonthRange {
  start: string;
  end: string;
}

/**
 * The first and last day of a month.
 * @param month The month as `YYYY-MM`.
 * @returns Its first and last day.
 */
export function monthRange(month: string): MonthRange {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (match === null) {
    throw new Error(`--month must be YYYY-MM, such as 2026-11; got "${month}"`);
  }
  const last = new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, "0")}` };
}

/**
 * The URLs a sitemap lists.
 * @param xml The sitemap.
 * @returns Each `<loc>`, in order.
 */
export function sitemapUrls(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((match) => match[1] ?? "");
}

/**
 * The key pages: every sitemap URL outside the generated API reference under `api/`. The URL
 * Inspection and Bing's per-URL reads cover these.
 * @param urls The sitemap URLs.
 * @returns The key pages, in sitemap order.
 */
export function keyPages(urls: readonly string[]): string[] {
  return urls.filter((url) => !url.startsWith(`${SITE}api/`));
}

/**
 * Removes secrets from a text: the value of any `apikey` query parameter, and each known secret as
 * it is and URL-encoded.
 * @param text A line of output or an error message.
 * @param secrets The tokens and keys the run read.
 * @returns The text with each secret replaced by `<redacted>`.
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  let clean = text.replace(/([?&]apikey=)[^&\s"]*/gi, "$1<redacted>");
  for (const secret of secrets) {
    if (secret !== "") {
      clean = clean
        .replaceAll(secret, "<redacted>")
        .replaceAll(encodeURIComponent(secret), "<redacted>");
    }
  }
  return clean;
}

/** One property of a parsed JSON value, or undefined. */
function get(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/** An array of a parsed JSON value, or an empty one. */
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value.map((item: unknown) => item) : [];
}

/** A number of a parsed JSON value, or 0. */
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** A number of a parsed JSON value that the API may write as a string, such as an int64, or 0. */
function int(value: unknown): number {
  return num(typeof value === "string" ? Number(value) : value);
}

/** A string of a parsed JSON value, or the fallback. */
function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * The days from one day to another.
 * @param from The earlier day, as `YYYY-MM-DD`.
 * @param to The later day, as `YYYY-MM-DD`.
 * @returns Whole days, negative when `to` comes first.
 */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * The day of a Bing date, which the JSON API writes as `/Date(<ms>)/` or `/Date(<ms>-0700)/`. Bing
 * writes the year 1, a negative number, for a date it does not have, such as a page never crawled.
 * @param value The date as Bing wrote it.
 * @returns The UTC day as `YYYY-MM-DD`, or undefined for no date or anything else.
 */
export function bingDay(value: unknown): string | undefined {
  const match = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(str(value));
  const ms = match === null ? -1 : Number(match[1]);
  return ms >= 0 ? new Date(ms).toISOString().slice(0, 10) : undefined;
}

/** Clicks and impressions. */
export interface Traffic {
  clicks: number;
  impressions: number;
}

/**
 * Sums Bing's daily traffic rows over a month.
 * @param response The parsed answer of `GetRankAndTrafficStats`.
 * @param range The month.
 * @returns The month's clicks and impressions, and how many days Bing reported.
 */
export function bingMonthTraffic(response: unknown, range: MonthRange): Traffic & { days: number } {
  const total = { clicks: 0, impressions: 0, days: 0 };
  for (const row of list(get(response, "d"))) {
    const day = bingDay(get(row, "Date"));
    if (day !== undefined && day >= range.start && day <= range.end) {
      total.clicks += num(get(row, "Clicks"));
      total.impressions += num(get(row, "Impressions"));
      total.days += 1;
    }
  }
  return total;
}

/** One day of Bing's crawl stats. */
export interface BingCrawlDay {
  day: string;
  inIndex: number;
  crawled: number;
}

/**
 * The latest day of Bing's crawl stats up to the end of a month.
 * @param response The parsed answer of `GetCrawlStats`.
 * @param end The last day to consider, as `YYYY-MM-DD`.
 * @returns The day, its `InIndex` and `CrawledPages`, or undefined when Bing reported no day.
 */
export function bingCrawlStats(response: unknown, end: string): BingCrawlDay | undefined {
  let latest: BingCrawlDay | undefined;
  for (const row of list(get(response, "d"))) {
    const day = bingDay(get(row, "Date"));
    if (day !== undefined && day <= end && (latest === undefined || day > latest.day)) {
      latest = { day, inIndex: num(get(row, "InIndex")), crawled: num(get(row, "CrawledPages")) };
    }
  }
  return latest;
}

/** A sitemap as a console reports it. */
export interface SitemapState {
  url: string;
  /** The console's status, such as "Success" or "Pending". */
  status: string;
  /** The URLs the console counted in it. */
  urlCount: number;
  /** The day the console last read it, undefined for never. */
  lastRead?: string;
}

/**
 * Bing's submitted sitemaps.
 * @param response The parsed answer of `GetFeeds`.
 * @returns Each sitemap's URL, status, URL count and last read.
 */
export function bingSitemaps(response: unknown): SitemapState[] {
  return list(get(response, "d")).map((feed) => {
    const lastRead = bingDay(get(feed, "LastCrawled"));
    return {
      url: str(get(feed, "Url")),
      status: str(get(feed, "Status"), "no status"),
      urlCount: num(get(feed, "UrlCount")),
      ...(lastRead === undefined ? {} : { lastRead }),
    };
  });
}

/**
 * Google's submitted sitemaps. Google marks a sitemap it has not processed yet with `isPending`,
 * and gives no `lastDownloaded` for one it never read.
 * @param response The parsed answer of `sitemaps.list`.
 * @returns Each sitemap's path, status, submitted URL count and last read.
 */
export function googleSitemaps(response: unknown): SitemapState[] {
  return list(get(response, "sitemap")).map((sitemap) => {
    const lastRead = str(get(sitemap, "lastDownloaded")).slice(0, 10);
    const errors = int(get(sitemap, "errors"));
    const status =
      get(sitemap, "isPending") === true ? "Pending" : errors > 0 ? `${errors} errors` : "Success";
    const urlCount = list(get(sitemap, "contents")).reduce<number>(
      (sum, content) => sum + int(get(content, "submitted")),
      0,
    );
    return {
      url: str(get(sitemap, "path")),
      status,
      urlCount,
      ...(lastRead === "" ? {} : { lastRead }),
    };
  });
}

/**
 * When Bing last crawled a URL.
 * @param response The parsed answer of `GetUrlInfo`.
 * @returns The day, or undefined when Bing has not crawled it.
 */
export function bingLastCrawled(response: unknown): string | undefined {
  return bingDay(get(get(response, "d"), "LastCrawledDate"));
}

/** A query or page with its traffic. */
export interface Row extends Traffic {
  key: string;
  position: number;
}

/**
 * The rows of a Search Analytics answer, by impressions.
 * @param response The parsed answer of `searchAnalytics/query`.
 * @returns Each row's first key, clicks, impressions and average position.
 */
export function analyticsRows(response: unknown): Row[] {
  return list(get(response, "rows"))
    .map((row) => ({
      key: str(list(get(row, "keys"))[0]),
      clicks: num(get(row, "clicks")),
      impressions: num(get(row, "impressions")),
      position: num(get(row, "position")),
    }))
    .toSorted((a, b) => b.impressions - a.impressions);
}

/**
 * Bing's top queries, by impressions. `GetQueryStats` covers recent weeks, not a chosen month.
 * @param response The parsed answer of `GetQueryStats`.
 * @returns Each query's clicks, impressions and average impression position.
 */
export function bingQueries(response: unknown): Row[] {
  return list(get(response, "d"))
    .map((row) => ({
      key: str(get(row, "Query")),
      clicks: num(get(row, "Clicks")),
      impressions: num(get(row, "Impressions")),
      position: num(get(row, "AvgImpressionPosition")),
    }))
    .toSorted((a, b) => b.impressions - a.impressions);
}

/**
 * Counts URL Inspection results by coverage state.
 * @param states The coverage state of each URL.
 * @returns Each state and its count, the most common first.
 */
export function tally(states: readonly string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const state of states) {
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return [...counts].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * The short name of a package in the row.
 * @param name The package name.
 * @returns `core` for explorer-verify, the name after the scope otherwise.
 */
export function shortName(name: string): string {
  return name === "explorer-verify" ? "core" : name.replace(/^@explorer-verify\//, "");
}

/** One month of a package's downloads. */
export interface DownloadStats {
  total: number;
  /** The median day, which release days do not move. */
  median: number;
  busiest: { day: string; downloads: number } | undefined;
}

/**
 * Reads a month of daily downloads.
 * @param response The parsed answer of `downloads/range/<start>:<end>/<package>`.
 * @returns The total, the median day and the busiest day.
 */
export function downloadStats(response: unknown): DownloadStats {
  const days = list(get(response, "downloads")).map((row) => ({
    day: str(get(row, "day")),
    downloads: num(get(row, "downloads")),
  }));
  const counts = days.map((day) => day.downloads).toSorted((a, b) => a - b);
  const middle = Math.floor(counts.length / 2);
  const median =
    counts.length === 0
      ? 0
      : counts.length % 2 === 1
        ? (counts[middle] ?? 0)
        : ((counts[middle - 1] ?? 0) + (counts[middle] ?? 0)) / 2;
  const busiest = days.reduce<DownloadStats["busiest"]>(
    (best, day) => (best === undefined || day.downloads > best.downloads ? day : best),
    undefined,
  );
  return { total: counts.reduce((sum, count) => sum + count, 0), median, busiest };
}

/**
 * The days in a month on which a package published a version.
 * @param registry The parsed registry document of the package.
 * @param range The month.
 * @returns Each day once, in order.
 */
export function publishDays(registry: unknown, range: MonthRange): string[] {
  const time = get(registry, "time");
  const days = Object.entries(typeof time === "object" && time !== null ? time : {})
    .filter(([version]) => version !== "created" && version !== "modified")
    .map(([, when]) => str(when).slice(0, 10))
    .filter((day) => day >= range.start && day <= range.end);
  return [...new Set(days)].toSorted();
}

/** A version and when it was published. */
export interface Release {
  version: string;
  published: string;
}

/**
 * The version on `latest` and when it was published.
 * @param registry The parsed registry document of the package.
 * @returns The version and its publish time, or undefined when the document has neither.
 */
export function latestRelease(registry: unknown): Release | undefined {
  const version = str(get(get(registry, "dist-tags"), "latest"));
  const published = str(get(get(registry, "time"), version));
  return version === "" || published === "" ? undefined : { version, published };
}

/**
 * The 1-based position of each package in an npm search.
 * @param response The parsed answer of `/-/v1/search`.
 * @returns Each listed package's position.
 */
export function searchPositions(response: unknown): Map<string, number> {
  const names = list(get(response, "objects")).map((item) =>
    str(get(get(item, "package"), "name")),
  );
  return new Map(names.map((name, index) => [name, index + 1]));
}

/**
 * The row's text for one npm search.
 * @param query The search.
 * @param positions The positions the search returned.
 * @returns Such as `"explorer verify": core 1, cli 2`.
 */
export function formatPositions(query: string, positions: ReadonlyMap<string, number>): string {
  const ours = PACKAGES.flatMap((name) => {
    const position = positions.get(name);
    return position === undefined ? [] : [{ name: shortName(name), position }];
  }).toSorted((a, b) => a.position - b.position);
  return ours.length === 0
    ? `"${query}": none in the first ${SEARCH_SIZE}`
    : `"${query}": ${ours.map((item) => `${item.name} ${item.position}`).join(", ")}`;
}

/** Context7's entry for the library. */
export interface Context7Entry {
  state: string;
  lastUpdate?: string;
  snippets: number;
}

/**
 * The library's entry in a Context7 search.
 * @param response The parsed answer of `/search`.
 * @returns Its state, last update and snippet count, or undefined when Context7 does not list it.
 */
export function context7Entry(response: unknown): Context7Entry | undefined {
  const library = list(get(response, "results")).find(
    (result) => get(result, "id") === CONTEXT7_LIBRARY,
  );
  if (library === undefined) {
    return undefined;
  }
  const lastUpdate = str(get(library, "lastUpdateDate"));
  return {
    state: str(get(library, "state"), "no state"),
    snippets: num(get(library, "totalSnippets")),
    ...(lastUpdate === "" ? {} : { lastUpdate }),
  };
}

/** One day of GitHub traffic. */
export interface TrafficDay {
  views: number;
  viewUniques: number;
  clones: number;
  cloneUniques: number;
}

/** A referrer or a path with its 14-day counts. */
export interface Popular {
  name: string;
  count: number;
  uniques: number;
}

/** The 14-day referrers and popular paths as read on one day. */
export interface TrafficSnapshot {
  date: string;
  referrers: Popular[];
  paths: Popular[];
}

/** What --traffic-log keeps. */
export interface TrafficLog {
  days: Record<string, TrafficDay>;
  snapshots: TrafficSnapshot[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function popularList(value: unknown, key: string): Popular[] {
  return list(value).map((item) => ({
    name: str(get(item, key)),
    count: num(get(item, "count")),
    uniques: num(get(item, "uniques")),
  }));
}

/**
 * Reads a traffic log.
 * @param json The file's text.
 * @returns The log.
 */
export function parseTrafficLog(json: string): TrafficLog {
  const parsed: unknown = JSON.parse(json);
  const rawDays = get(parsed, "days");
  const rawSnapshots = get(parsed, "snapshots");
  if (typeof rawDays !== "object" || rawDays === null || !Array.isArray(rawSnapshots)) {
    throw new Error("the traffic log is not an object with days and snapshots");
  }
  const days: Record<string, TrafficDay> = {};
  for (const [day, value] of Object.entries(rawDays)) {
    if (!DAY.test(day)) {
      throw new Error(`the traffic log has a day "${day}" that is not YYYY-MM-DD`);
    }
    days[day] = {
      views: num(get(value, "views")),
      viewUniques: num(get(value, "viewUniques")),
      clones: num(get(value, "clones")),
      cloneUniques: num(get(value, "cloneUniques")),
    };
  }
  const snapshots = list(rawSnapshots).map((snapshot) => {
    const date = str(get(snapshot, "date"));
    if (!DAY.test(date)) {
      throw new Error(`the traffic log has a snapshot dated "${date}", not YYYY-MM-DD`);
    }
    return {
      date,
      referrers: popularList(get(snapshot, "referrers"), "name"),
      paths: popularList(get(snapshot, "paths"), "name"),
    };
  });
  return { days, snapshots };
}

/**
 * Reads GitHub's daily views and clones.
 * @param views The parsed answer of `traffic/views`.
 * @param clones The parsed answer of `traffic/clones`.
 * @returns Each day GitHub reported.
 */
export function trafficDays(views: unknown, clones: unknown): Record<string, TrafficDay> {
  const days: Record<string, TrafficDay> = {};
  const day = (key: string): TrafficDay => {
    days[key] ??= { views: 0, viewUniques: 0, clones: 0, cloneUniques: 0 };
    return days[key];
  };
  for (const row of list(get(views, "views"))) {
    const entry = day(str(get(row, "timestamp")).slice(0, 10));
    entry.views = num(get(row, "count"));
    entry.viewUniques = num(get(row, "uniques"));
  }
  for (const row of list(get(clones, "clones"))) {
    const entry = day(str(get(row, "timestamp")).slice(0, 10));
    entry.clones = num(get(row, "count"));
    entry.cloneUniques = num(get(row, "uniques"));
  }
  return days;
}

/**
 * Reads GitHub's 14-day referrers and popular paths.
 * @param date The day they were read.
 * @param referrers The parsed answer of `traffic/popular/referrers`.
 * @param paths The parsed answer of `traffic/popular/paths`.
 * @returns The snapshot.
 */
export function trafficSnapshot(date: string, referrers: unknown, paths: unknown): TrafficSnapshot {
  return {
    date,
    referrers: popularList(referrers, "referrer"),
    paths: popularList(paths, "path"),
  };
}

/**
 * Merges what GitHub reports today into the log. GitHub's numbers for a day replace the logged
 * ones, since a day read while it was still running is counted again later; a snapshot replaces the
 * one of the same date.
 * @param log The log so far.
 * @param days The days GitHub reports today.
 * @param snapshot Today's referrers and paths.
 * @returns The new log, its days and snapshots in order.
 */
export function mergeTraffic(
  log: TrafficLog,
  days: Record<string, TrafficDay>,
  snapshot: TrafficSnapshot,
): TrafficLog {
  const merged = { ...log.days, ...days };
  return {
    days: Object.fromEntries(Object.entries(merged).toSorted(([a], [b]) => a.localeCompare(b))),
    snapshots: [...log.snapshots.filter((old) => old.date !== snapshot.date), snapshot].toSorted(
      (a, b) => a.date.localeCompare(b.date),
    ),
  };
}

/**
 * A month's views and clones from the log.
 * @param log The log.
 * @param range The month.
 * @returns The sums and how many of the month's days the log holds.
 */
export function monthTraffic(
  log: TrafficLog,
  range: MonthRange,
): { views: number; clones: number; covered: number; daysInMonth: number } {
  const total = {
    views: 0,
    clones: 0,
    covered: 0,
    daysInMonth: daysBetween(range.start, range.end) + 1,
  };
  for (const [day, value] of Object.entries(log.days)) {
    if (day >= range.start && day <= range.end) {
      total.views += value.views;
      total.clones += value.clones;
      total.covered += 1;
    }
  }
  return total;
}

/**
 * The row's text for referrers: the top three with their counts and the window they cover.
 * @param snapshot The snapshot to show.
 * @returns Such as `github.com 4 (2 unique), Google 3 (2 unique), the 14 days to 2026-11-11`.
 */
export function formatReferrers(snapshot: TrafficSnapshot): string {
  const top = snapshot.referrers
    .slice(0, 3)
    .map((item) => `${item.name} ${item.count} (${item.uniques} unique)`);
  return `${top.length === 0 ? "none" : top.join(", ")}, the ${TRAFFIC_DAYS} days to ${snapshot.date}`;
}

/** What the sources reported, for {@link findProblems}. */
export interface Facts {
  month: MonthRange;
  sitemapUrls: number;
  keyPages: number;
  /** Sitemap URLs that did not answer 200, with what they answered. */
  brokenUrls: readonly string[];
  /** One sentence per source the run could not read, and why. */
  skipped: readonly string[];
  google?: {
    sitemaps: readonly SitemapState[];
    /** Key pages by coverage state, undefined when not inspected. */
    inspected?: { indexed: number; unknown: number; crawledNotIndexed: readonly string[] };
  };
  bing?: {
    sitemaps: readonly SitemapState[];
    inIndex?: number;
    /** The day of `inIndex`: Bing's daily stats run about a week behind. */
    inIndexDay?: string;
    /** How many key pages Bing has crawled, from its per-URL information, which is current. */
    crawledKeyPages?: number;
  };
  /**
   * Context7's entry, undefined when Context7 does not list the library; `refreshed` when this run
   * asked Context7 to index again, so an old date is not a problem.
   */
  context7?: { entry?: Context7Entry; refreshed: boolean };
  latest?: Release;
  downloads: readonly { name: string; total: number }[];
  traffic?: {
    logged: boolean;
    /** The log's latest snapshot before this run. */
    previousSnapshot?: string;
    covered?: number;
    daysInMonth?: number;
  };
}

function sitemapProblems(
  console: string,
  sitemaps: readonly SitemapState[],
  staleDays: number,
  today: string,
): string[] {
  if (sitemaps.length === 0) {
    return [`No sitemap is submitted to ${console}.`];
  }
  return sitemaps.flatMap((sitemap) => {
    if (sitemap.lastRead === undefined) {
      return [`${console} has not read ${sitemap.url} yet (${sitemap.status}).`];
    }
    const problems: string[] = [];
    if (daysBetween(sitemap.lastRead, today) > staleDays) {
      problems.push(`${console} last read ${sitemap.url} on ${sitemap.lastRead}.`);
    }
    if (sitemap.status !== "Success") {
      problems.push(`${console} reports ${sitemap.url} as ${sitemap.status}.`);
    }
    return problems;
  });
}

/**
 * Lists what looks wrong.
 * @param facts What the sources reported.
 * @param today The day of the run, as `YYYY-MM-DD`.
 * @returns One sentence per problem, empty when none.
 */
export function findProblems(facts: Facts, today: string): string[] {
  const problems: string[] = [...facts.skipped];
  if (facts.brokenUrls.length > 0) {
    problems.push(
      `${facts.brokenUrls.length} sitemap URLs do not answer 200: ${facts.brokenUrls.join(", ")}`,
    );
  }
  const { google: googleFacts, bing: bingFacts } = facts;
  if (googleFacts !== undefined) {
    problems.push(
      ...sitemapProblems("Google", googleFacts.sitemaps, SITEMAP_STALE_DAYS.google, today),
    );
    const inspected = googleFacts.inspected;
    if (inspected !== undefined) {
      if (inspected.unknown > 0) {
        problems.push(
          `${inspected.unknown} of the ${facts.keyPages} key pages are unknown to Google; request indexing by hand in URL Inspection, about ten a day.`,
        );
      }
      if (inspected.crawledNotIndexed.length > 0) {
        problems.push(
          `Google crawled but did not index ${inspected.crawledNotIndexed.join(", ")}; another request does not help, a link from an indexed page or more content may.`,
        );
      }
      if (inspected.indexed < facts.keyPages) {
        problems.push(`Google indexes ${inspected.indexed} of the ${facts.keyPages} key pages.`);
      }
    }
  }
  if (bingFacts !== undefined) {
    const { sitemaps, crawledKeyPages, inIndex, inIndexDay } = bingFacts;
    problems.push(...sitemapProblems("Bing", sitemaps, SITEMAP_STALE_DAYS.bing, today));
    if (crawledKeyPages !== undefined && crawledKeyPages < facts.keyPages) {
      problems.push(`Bing has crawled ${crawledKeyPages} of the ${facts.keyPages} key pages.`);
    }
    if (inIndex !== undefined && inIndex * 2 < facts.sitemapUrls) {
      const asOf = inIndexDay === undefined ? "" : ` as of ${inIndexDay}`;
      problems.push(
        `Bing indexes ${inIndex} of the ${facts.sitemapUrls} sitemap URLs${asOf}, under half; its daily stats run about a week behind.`,
      );
    }
  }
  const { context7: c7, latest } = facts;
  if (c7 !== undefined && c7.entry === undefined) {
    problems.push(`Context7 does not list ${CONTEXT7_LIBRARY}.`);
  } else if (
    c7?.entry !== undefined &&
    !c7.refreshed &&
    latest !== undefined &&
    (c7.entry.lastUpdate ?? "") < latest.published
  ) {
    problems.push(
      `Context7 was last updated on ${c7.entry.lastUpdate?.slice(0, 10) ?? "no day"}, before ${latest.version} (${latest.published.slice(0, 10)}); run with --refresh-context7.`,
    );
  }
  for (const { name, total } of facts.downloads) {
    if (total === 0) {
      problems.push(`${name} had no downloads in ${facts.month.start.slice(0, 7)}.`);
    }
  }
  const { traffic } = facts;
  if (traffic === undefined) {
    return problems;
  }
  if (!traffic.logged) {
    problems.push(
      `GitHub traffic is not logged; GitHub keeps ${TRAFFIC_DAYS} days, so run with --traffic-log every week.`,
    );
    return problems;
  }
  if (
    traffic.previousSnapshot !== undefined &&
    daysBetween(traffic.previousSnapshot, today) > TRAFFIC_DAYS
  ) {
    problems.push(
      `The traffic log's previous run was on ${traffic.previousSnapshot}, more than ${TRAFFIC_DAYS} days ago; the days in between are lost.`,
    );
  }
  if (
    traffic.covered !== undefined &&
    traffic.daysInMonth !== undefined &&
    facts.month.end < today &&
    traffic.covered < traffic.daysInMonth
  ) {
    problems.push(
      `The traffic log holds ${traffic.covered} of the ${traffic.daysInMonth} days of ${facts.month.start.slice(0, 7)}.`,
    );
  }
  return problems;
}

/** The cells of the monthly row, in the table's order. */
export interface RowCells {
  month: string;
  downloads: readonly number[];
  stars: string;
  referrers: string;
  npmPositions: string;
  indexed: string;
  impressions: string;
  context7: string;
}

/**
 * The month's row for the table on the adoption page, with an empty Notes cell.
 * @param cells The cells.
 * @returns The Markdown row.
 */
export function monthlyRow(cells: RowCells): string {
  return `| ${[
    cells.month,
    cells.downloads.join(", "),
    cells.stars,
    cells.referrers,
    cells.npmPositions,
    cells.indexed,
    cells.impressions,
    cells.context7,
    "",
  ].join(" | ")} |`;
}

function formatRows(rows: readonly Row[]): string {
  if (rows.length === 0) {
    return "    none\n";
  }
  return rows
    .slice(0, TOP)
    .map(
      (row) =>
        `    ${row.key}: ${row.impressions} impressions, ${row.clicks} clicks, position ${row.position.toFixed(1)}\n`,
    )
    .join("");
}

async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  // The workers share one iterator, so each item is taken once.
  const queue = items.entries();
  const worker = async (): Promise<void> => {
    for (const [index, item] of queue) {
      results[index] = await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** The state of one run: the I/O and the secrets read so far, which every output line hides. */
class Run {
  readonly secrets: string[] = [];

  readonly io: Io;

  constructor(io: Io) {
    this.io = io;
  }

  write(text: string): void {
    this.io.out(redact(text, this.secrets));
  }

  /** An environment variable, or undefined when it is unset or empty. */
  env(variable: string): string | undefined {
    const value = this.io.env[variable];
    return value === "" ? undefined : value;
  }

  /** A secret from the environment, or on macOS from the login Keychain. */
  secret(variable: string, keychainItem: string): string | undefined {
    let value = this.env(variable);
    if (value === undefined && this.io.platform === "darwin") {
      const user = this.env("USER");
      try {
        value = this.io
          .run("security", [
            "find-generic-password",
            ...(user === undefined ? [] : ["-a", user]),
            "-s",
            keychainItem,
            "-w",
          ])
          .trim();
      } catch {
        value = undefined;
      }
    }
    if (value === undefined || value === "") {
      return undefined;
    }
    this.secrets.push(value);
    return value;
  }

  async fetchJson(url: string, init?: RequestInit): Promise<unknown> {
    let response = await this.io.fetch(url, init);
    for (let attempt = 1; response.status === 429 && attempt < RATE_LIMIT_TRIES; attempt += 1) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await response.body?.cancel();
      await this.io.sleep(
        retryAfter > 0 ? Math.min(retryAfter, 120) * 1000 : RATE_LIMIT_PAUSE_MS * attempt,
      );
      response = await this.io.fetch(url, init);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        redact(
          `${init?.method ?? "GET"} ${url} answered ${response.status}: ${text.slice(0, 300)}`,
          this.secrets,
        ),
      );
    }
    return text === "" ? undefined : JSON.parse(text);
  }
}

/** The URLs that do not answer 200 to a HEAD, with what they answered. */
async function brokenUrls(run: Run, urls: readonly string[]): Promise<string[]> {
  const head = async (url: string): Promise<string | undefined> => {
    try {
      const response = await run.io.fetch(url, { method: "HEAD", redirect: "manual" });
      return response.status === 200 ? undefined : `${url} (${response.status})`;
    } catch (error: unknown) {
      return `${url} (${errorMessage(error)})`;
    }
  };
  const answers = await mapLimited(urls, URL_CHECK_CONCURRENCY, async (url) => {
    // GitHub Pages answers an odd request with 503 under load: on 2026-11-12 one of 214 did, and
    // the same URL answered 200 a minute later. So a URL counts as broken only when it fails twice.
    if ((await head(url)) === undefined) {
      return undefined;
    }
    await run.io.sleep(HEAD_RETRY_PAUSE_MS);
    return await head(url);
  });
  return answers.filter((answer) => answer !== undefined);
}

interface NpmResult {
  downloads: { name: string; total: number }[];
  positions: string;
  latest: Release | undefined;
}

async function npm(run: Run, range: MonthRange): Promise<NpmResult> {
  const downloads: { name: string; total: number }[] = [];
  let latest: Release | undefined;
  for (const name of PACKAGES) {
    const stats = downloadStats(
      await run.fetchJson(`${NPM_DOWNLOADS}/range/${range.start}:${range.end}/${name}`),
    );
    const registry = await run.fetchJson(`${NPM_REGISTRY}/${name.replace("/", "%2f")}`);
    if (name === "explorer-verify") {
      latest = latestRelease(registry);
    }
    const published = publishDays(registry, range);
    run.write(
      `  ${name}: ${stats.total} downloads, median day ${stats.median}, busiest ${stats.busiest?.day ?? "none"} (${stats.busiest?.downloads ?? 0}), published on ${published.length === 0 ? "no day" : published.join(", ")}\n`,
    );
    downloads.push({ name, total: stats.total });
  }
  const positions: string[] = [];
  for (const query of NPM_SEARCHES) {
    const answer = await run.fetchJson(
      `${NPM_REGISTRY}/-/v1/search?text=${encodeURIComponent(query)}&size=${SEARCH_SIZE}`,
    );
    positions.push(formatPositions(query, searchPositions(answer)));
  }
  run.write(`  search today: ${positions.join("; ")}\n`);
  if (latest !== undefined) {
    run.write(`  latest: ${latest.version}, published ${latest.published.slice(0, 10)}\n`);
  }
  return { downloads, positions: positions.join("; "), latest };
}

interface GitHubResult {
  stars: string;
  referrers: string;
  logged: boolean;
  previousSnapshot?: string;
  covered?: number;
  daysInMonth?: number;
}

function github(run: Run, range: MonthRange, logFile: string | undefined): GitHubResult {
  const api = (endpoint: string): unknown => {
    let answer: string;
    try {
      answer = run.io.run("gh", ["api", `repos/${REPOSITORY}${endpoint}`]);
    } catch {
      throw new Error(
        `gh could not read repos/${REPOSITORY}${endpoint}; run \`gh auth login\` with an account that has push access`,
      );
    }
    return JSON.parse(answer);
  };
  const repo = api("");
  const stars = num(get(repo, "stargazers_count"));
  run.write(
    `  ${stars} stars, ${num(get(repo, "forks_count"))} forks, ${num(get(repo, "subscribers_count"))} watchers\n`,
  );
  const views = api("/traffic/views");
  const clones = api("/traffic/clones");
  const snapshot = trafficSnapshot(
    run.io.today,
    api("/traffic/popular/referrers"),
    api("/traffic/popular/paths"),
  );
  run.write(
    `  last ${TRAFFIC_DAYS} days: ${num(get(views, "count"))} views (${num(get(views, "uniques"))} unique), ${num(get(clones, "count"))} clones (${num(get(clones, "uniques"))} unique)\n`,
  );
  run.write(`  referrers: ${formatReferrers(snapshot)}\n`);
  run.write("  popular paths:\n");
  for (const item of snapshot.paths.slice(0, 5)) {
    run.write(`    ${item.name} ${item.count} (${item.uniques} unique)\n`);
  }
  const result: GitHubResult = {
    stars: String(stars),
    referrers: formatReferrers(snapshot),
    logged: logFile !== undefined,
  };
  if (logFile === undefined) {
    return result;
  }
  const log = existsSync(logFile)
    ? parseTrafficLog(readFileSync(logFile, "utf8"))
    : { days: {}, snapshots: [] };
  const previousSnapshot = log.snapshots.at(-1)?.date;
  const merged = mergeTraffic(log, trafficDays(views, clones), snapshot);
  writeFileSync(logFile, `${JSON.stringify(merged, null, 2)}\n`);
  const month = monthTraffic(merged, range);
  run.write(
    `  traffic log: ${Object.keys(merged.days).length} days, ${merged.snapshots.length} snapshots; ${range.start.slice(0, 7)}: ${month.views} views, ${month.clones} clones over ${month.covered} of ${month.daysInMonth} days\n`,
  );
  return {
    ...result,
    ...(previousSnapshot === undefined ? {} : { previousSnapshot }),
    covered: month.covered,
    daysInMonth: month.daysInMonth,
  };
}

interface GoogleResult {
  impressions: number;
  clicks: number;
  sitemaps: SitemapState[];
  inspected?: { indexed: number; unknown: number; crawledNotIndexed: string[] };
}

function writeSitemaps(run: Run, sitemaps: readonly SitemapState[]): void {
  for (const sitemap of sitemaps) {
    run.write(
      `  sitemap ${sitemap.url}: ${sitemap.status}, ${sitemap.urlCount} URLs, last read ${sitemap.lastRead ?? "never"}\n`,
    );
  }
  if (sitemaps.length === 0) {
    run.write("  no sitemap submitted\n");
  }
}

async function google(
  run: Run,
  range: MonthRange,
  pages: readonly string[],
  inspect: boolean,
  account: string,
): Promise<GoogleResult> {
  let token: string;
  try {
    token = run.io
      .run("gcloud", [
        "auth",
        "print-access-token",
        `--impersonate-service-account=${account}`,
        "--scopes=https://www.googleapis.com/auth/webmasters.readonly",
      ])
      .trim();
  } catch {
    throw new Error(
      "gcloud could not get a token for ADOPTION_GSC_SERVICE_ACCOUNT; run `gcloud auth login` and check the Token Creator role",
    );
  }
  run.secrets.push(token);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const site = encodeURIComponent(SITE);
  const query = async (body: object): Promise<Row[]> =>
    analyticsRows(
      await run.fetchJson(`${GSC}/webmasters/v3/sites/${site}/searchAnalytics/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ startDate: range.start, endDate: range.end, ...body }),
      }),
    );

  const [total] = await query({});
  const result: GoogleResult = {
    impressions: total?.impressions ?? 0,
    clicks: total?.clicks ?? 0,
    sitemaps: googleSitemaps(
      await run.fetchJson(`${GSC}/webmasters/v3/sites/${site}/sitemaps`, { headers }),
    ),
  };
  run.write(
    `  ${range.start} to ${range.end}: ${result.impressions} impressions, ${result.clicks} clicks\n`,
  );
  run.write("  top queries:\n");
  run.write(formatRows(await query({ dimensions: ["query"], rowLimit: TOP })));
  run.write("  top pages:\n");
  run.write(formatRows(await query({ dimensions: ["page"], rowLimit: TOP })));
  writeSitemaps(run, result.sitemaps);
  if (!inspect) {
    return result;
  }
  const states = await mapLimited(pages, INSPECTION_CONCURRENCY, async (url) => {
    const answer = await run.fetchJson(`${GSC}/v1/urlInspection/index:inspect`, {
      method: "POST",
      headers,
      body: JSON.stringify({ inspectionUrl: url, siteUrl: SITE }),
    });
    return str(
      get(get(get(answer, "inspectionResult"), "indexStatusResult"), "coverageState"),
      "no answer",
    );
  });
  const unknown = pages.filter((_, index) => states[index] === UNKNOWN);
  result.inspected = {
    indexed: states.filter((state) => state === INDEXED).length,
    unknown: unknown.length,
    crawledNotIndexed: pages.filter((_, index) => states[index] === CRAWLED_NOT_INDEXED),
  };
  run.write(`  indexed: ${result.inspected.indexed} / ${pages.length} key pages (read today)\n`);
  for (const [state, count] of tally(states)) {
    run.write(`    ${count} ${state}\n`);
  }
  if (unknown.length > 0) {
    run.write("  unknown to Google, to request by hand:\n");
    for (const url of unknown) {
      run.write(`    ${url}\n`);
    }
  }
  return result;
}

interface BingResult {
  impressions: number;
  clicks: number;
  sitemaps: SitemapState[];
  inIndex?: number;
  inIndexDay?: string;
  crawledKeyPages?: number;
}

/** When Bing last crawled each URL, one call at a time; undefined when Bing kept throttling. */
async function bingCrawlDays(
  run: Run,
  pages: readonly string[],
  key: string,
): Promise<(string | undefined)[] | undefined> {
  const days: (string | undefined)[] = [];
  for (const url of pages) {
    const request = `${BING}/GetUrlInfo?siteUrl=${encodeURIComponent(SITE)}&url=${encodeURIComponent(url)}&apikey=${encodeURIComponent(key)}`;
    let answer: unknown;
    for (let attempt = 1; answer === undefined; attempt += 1) {
      try {
        answer = await run.fetchJson(request);
      } catch (error: unknown) {
        if (!errorMessage(error).includes("ThrottleHost") || attempt === BING_URL_TRIES) {
          return undefined;
        }
        await run.io.sleep(BING_THROTTLE_PAUSE_MS * attempt);
      }
    }
    days.push(bingLastCrawled(answer));
    await run.io.sleep(BING_URL_PAUSE_MS);
  }
  return days;
}

async function bing(
  run: Run,
  range: MonthRange,
  pages: readonly string[],
  inspect: boolean,
  key: string,
): Promise<BingResult> {
  const call = async (method: string): Promise<unknown> =>
    await run.fetchJson(
      `${BING}/${method}?siteUrl=${encodeURIComponent(SITE)}&apikey=${encodeURIComponent(key)}`,
    );
  const traffic = bingMonthTraffic(await call("GetRankAndTrafficStats"), range);
  run.write(
    `  ${range.start} to ${range.end}: ${traffic.impressions} impressions, ${traffic.clicks} clicks (${traffic.days} days reported)\n`,
  );
  run.write("  top queries (recent weeks):\n");
  run.write(formatRows(bingQueries(await call("GetQueryStats"))));
  const stats = bingCrawlStats(await call("GetCrawlStats"), range.end);
  run.write(
    stats === undefined
      ? "  crawl stats: none up to the end of the month\n"
      : `  crawl stats on ${stats.day}: ${stats.crawled} pages crawled, ${stats.inIndex} in the index (the daily stats run about a week behind)\n`,
  );
  const sitemaps = bingSitemaps(await call("GetFeeds"));
  writeSitemaps(run, sitemaps);
  const result: BingResult = {
    impressions: traffic.impressions,
    clicks: traffic.clicks,
    sitemaps,
    ...(stats === undefined ? {} : { inIndex: stats.inIndex, inIndexDay: stats.day }),
  };
  if (!inspect) {
    return result;
  }
  const crawledDays = await bingCrawlDays(run, pages, key);
  if (crawledDays === undefined) {
    run.write("  crawled key pages: not read, Bing throttled the per-URL calls\n");
    return result;
  }
  result.crawledKeyPages = crawledDays.filter((day) => day !== undefined).length;
  run.write(`  crawled: ${result.crawledKeyPages} / ${pages.length} key pages (read today)\n`);
  return result;
}

async function context7(
  run: Run,
  refresh: boolean,
): Promise<{ entry?: Context7Entry; refreshed: boolean }> {
  const entry = context7Entry(await run.fetchJson(`${CONTEXT7}/search?query=explorer-verify`));
  run.write(
    entry === undefined
      ? `  ${CONTEXT7_LIBRARY} is not listed\n`
      : `  ${CONTEXT7_LIBRARY}: ${entry.state}, last updated ${entry.lastUpdate ?? "never"}, ${entry.snippets} snippets\n`,
  );
  const listed = entry === undefined ? {} : { entry };
  if (!refresh) {
    return { ...listed, refreshed: false };
  }
  const key = run.secret("CONTEXT7_API_KEY", "context7-api");
  if (key === undefined) {
    throw new Error("--refresh-context7 needs CONTEXT7_API_KEY or a context7-api Keychain item");
  }
  const answer = await run.fetchJson(`${CONTEXT7}/refresh`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ libraryName: CONTEXT7_LIBRARY }),
  });
  run.write(`  refresh: ${str(get(answer, "message"), "started")}\n`);
  return { ...listed, refreshed: true };
}

/**
 * Reads one source. A source that throws is skipped: its error goes to the output and to Problems.
 * @returns The source's result, or undefined when it was skipped.
 */
async function source<T>(
  run: Run,
  title: string,
  skipped: string[],
  read: () => Promise<T> | T,
): Promise<T | undefined> {
  run.write(`\n== ${title}\n`);
  try {
    return await read();
  } catch (error: unknown) {
    const message = redact(errorMessage(error), run.secrets);
    run.write(`  skipped: ${message}\n`);
    skipped.push(`${title} was not read: ${message}`);
    return undefined;
  }
}

/** The usage line. */
export const USAGE =
  "usage: node scripts/adoption-check.ts --month <YYYY-MM> [--traffic-log <file>] [--skip-inspection] [--refresh-context7]";

/**
 * Runs the check.
 * @param argv The arguments after the script's path.
 * @param io What the check reads from and writes to.
 * @returns The exit code: 0 when it ran, problems or not; 1 when it could not run.
 */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  const run = new Run(io);
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        month: { type: "string" },
        "traffic-log": { type: "string" },
        "refresh-context7": { type: "boolean" },
        "skip-inspection": { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.month === undefined) {
      throw new Error(`--month is required\n${USAGE}`);
    }
    const range = monthRange(values.month);
    const inspect = values["skip-inspection"] !== true;
    const sitemap = await io.fetch(`${SITE}sitemap.xml`);
    if (!sitemap.ok) {
      throw new Error(`${SITE}sitemap.xml answered ${sitemap.status}`);
    }
    const urls = sitemapUrls(await sitemap.text());
    const pages = keyPages(urls);
    const broken = await brokenUrls(run, urls);
    run.write(
      `${SITE}sitemap.xml lists ${urls.length} pages today, ${pages.length} of them key pages; ${urls.length - broken.length} answer 200\n`,
    );

    const skipped: string[] = [];
    const npmResult = await source(run, "npm", skipped, async () => await npm(run, range));
    const githubResult = await source(run, "GitHub", skipped, () =>
      github(run, range, values["traffic-log"]),
    );
    const account = run.env("ADOPTION_GSC_SERVICE_ACCOUNT");
    const googleResult = await source(run, "Google Search Console", skipped, async () => {
      if (account === undefined) {
        throw new Error("ADOPTION_GSC_SERVICE_ACCOUNT is not set");
      }
      return await google(run, range, pages, inspect, account);
    });
    const bingResult = await source(run, "Bing Webmaster Tools", skipped, async () => {
      const key = run.secret("BING_WEBMASTER_API_KEY", "bing-webmaster-api");
      if (key === undefined) {
        throw new Error("no BING_WEBMASTER_API_KEY and no bing-webmaster-api Keychain item");
      }
      return await bing(run, range, pages, inspect, key);
    });
    const context7Result = await source(
      run,
      "Context7",
      skipped,
      async () => await context7(run, values["refresh-context7"] === true),
    );

    const problems = findProblems(
      {
        month: range,
        sitemapUrls: urls.length,
        keyPages: pages.length,
        brokenUrls: broken,
        skipped,
        ...(googleResult === undefined ? {} : { google: googleResult }),
        ...(bingResult === undefined ? {} : { bing: bingResult }),
        ...(context7Result === undefined ? {} : { context7: context7Result }),
        ...(npmResult?.latest === undefined ? {} : { latest: npmResult.latest }),
        downloads: npmResult?.downloads ?? [],
        ...(githubResult === undefined ? {} : { traffic: githubResult }),
      },
      io.today,
    );
    run.write("\n== Problems\n");
    run.write(
      problems.length === 0 ? "  none\n" : problems.map((problem) => `  - ${problem}\n`).join(""),
    );

    const c7 = context7Result?.entry;
    run.write("\n== Row (add the notes)\n");
    run.write(
      `${monthlyRow({
        month: values.month,
        downloads: npmResult?.downloads.map((item) => item.total) ?? [],
        stars: githubResult?.stars ?? "n/a",
        referrers: githubResult?.referrers ?? "n/a",
        npmPositions: npmResult?.positions ?? "n/a",
        indexed: `Google ${googleResult?.inspected === undefined ? "n/a" : `${googleResult.inspected.indexed} / ${pages.length} key pages`}, Bing ${bingResult?.inIndex === undefined ? "n/a" : `${bingResult.inIndex} / ${urls.length}`}, read on ${io.today}`,
        impressions: `Google ${googleResult === undefined ? "n/a" : `${googleResult.impressions}, ${googleResult.clicks}`}; Bing ${bingResult === undefined ? "n/a" : `${bingResult.impressions}, ${bingResult.clicks}`}`,
        context7:
          c7 === undefined
            ? "n/a"
            : `${c7.state}, ${c7.lastUpdate?.slice(0, 10) ?? "never"}, ${c7.snippets} snippets`,
      })}\n`,
    );
    return 0;
  } catch (error: unknown) {
    io.err(`${redact(errorMessage(error), run.secrets)}\n`);
    return 1;
  }
}

/**
 * The I/O of a real run: Node's fetch, child processes, environment, clock and standard streams. A
 * child's standard error is dropped, so a tool's diagnostics never reach the output.
 * @returns The I/O.
 */
export function nodeIo(): Io {
  return {
    fetch: async (input, init) => await globalThis.fetch(input, init),
    run: (command, args) =>
      execFileSync(command, [...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 16 * 1024 * 1024,
      }),
    env: process.env,
    platform: process.platform,
    today: new Date().toISOString().slice(0, 10),
    sleep: async (ms) => await new Promise((resolve) => setTimeout(resolve, ms)),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  };
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), nodeIo());
}
