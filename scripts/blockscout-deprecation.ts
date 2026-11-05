// The weekly Blockscout deprecation watch (#198). Blockscout's docs say its per-instance API is
// deprecated in favour of the hosted multichain API, which needs a key (#96). This script looks
// for the signs that the per-instance API is going away, and keeps one issue open while it sees
// any:
//
// - header: an instance answer carries a `Deprecation` (RFC 9745) or `Sunset` (RFC 8594) header,
//   a `Link` with one of those relations, or a `Warning` header;
// - answer: an instance answer's body or `Location` names the hosted API or deprecation words;
// - docs: a watched section of Blockscout's docs no longer matches the hash recorded in
//   {@link DOCS_FILE}, or its page or heading is gone;
// - down: {@link DOWN_THRESHOLD} or more sampled instances do not answer in the same run.
//
// It asks the instances the routing table lists on `*.blockscout.com`, the hosts Blockscout runs
// itself: only those can be switched off by Blockscout's decision, and they would show a
// deprecation first. Each gets one keyless GET, one host at a time, {@link MIN_INTERVAL_MS} apart,
// no redirect followed. Then each watched docs page gets one GET.
//
// With `--report`, it opens the issue, updates its body, or comments and closes it when no signal
// remains, by the shared pattern in scripts/github-issue.ts. It reads GH_TOKEN (the workflow's own
// token, never printed) and GITHUB_REPOSITORY, and GITHUB_API_URL, GITHUB_SERVER_URL and
// GITHUB_RUN_ID when set.
//
// Usage: node scripts/blockscout-deprecation.ts [--report] [--out <file>] [--summary <file>]
// Prints the result as JSON. Exits 0 when the watch ran and, without `--report`, saw no signal;
// 1 when it saw a signal without `--report`, or a GitHub call failed; 2 for a wrong command line
// or data file.
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { codeCell, gitHubApi, syncIssue } from "./github-issue.ts";
import type { IssueApi } from "./github-issue.ts";
import { errorMessage, isMainModule } from "./release-packages.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The routing table, relative to the repository root. */
export const TABLE_FILE = "packages/explorer-verify/src/routing/table.json";
/** The watched docs sections with their recorded hashes, relative to the repository root. */
export const DOCS_FILE =
  "docs/contributor/research/data/2026-11-05-blockscout-deprecation-docs.json";
/** The title of the issue. */
export const TITLE = "Blockscout per-instance API: deprecation signal";
/** The hidden line in the issue body that finds the issue again. */
export const MARKER = "<!-- blockscout-deprecation-watch -->";
/** The labels of a new issue. */
export const LABELS: readonly string[] = ["type:chore", "area:backend", "status:needs-triage"];
/** The issue about the hosted API, which the watch's issue links. */
export const HOSTED_API_ISSUE = 96;
/** The hosts Blockscout runs itself end with this; the watch asks only those. */
export const HOSTED_SUFFIX = ".blockscout.com";
/** The request each instance gets: the per-instance RPC API, with a small answer. */
export const PROBE_PATH = "/api?module=block&action=eth_block_number";
/** The shortest time between two instance requests, in milliseconds. */
export const MIN_INTERVAL_MS = 500;
/** The time limit of one request, in milliseconds. */
export const TIMEOUT_MS = 20_000;
/** The number of sampled instances that must fail in one run before the watch reports it. */
export const DOWN_THRESHOLD = 5;
/** The most signal rows an issue lists. */
export const MAX_ROWS = 40;
/** The most characters the rows of an issue's signal table take. */
export const TABLE_LIMIT = 50_000;
/** The longest excerpt of an instance answer a signal shows. */
export const EXCERPT_LENGTH = 300;
/** The longest excerpt of a docs section a signal shows. */
export const DOCS_EXCERPT_LENGTH = 1500;
/** The most bytes of an answer body the watch reads. */
export const BODY_LIMIT = 4096;
/** The user agent of every request: the project, so an operator can see who asks. */
export const USER_AGENT =
  "explorer-verify-deprecation-watch (+https://github.com/aelmanaa/explorer-verify)";

/** Words that, in an instance answer, point at the hosted API or the end of the per-instance one. */
export const DEPRECATION_TEXT: RegExp =
  /api\.blockscout\.com|dev\.blockscout\.com|deprecat|sunset|end[ -]of[ -]life|discontinu|(?:will be|is being) (?:removed|disabled|shut down|turned off)/i;

/** The response headers the watch records. */
export const WATCHED_HEADERS: readonly string[] = ["deprecation", "sunset", "link", "warning"];

/** One sampled instance. */
export interface Instance {
  readonly chainId: number;
  readonly host: string;
}

/** One watched section of Blockscout's docs, as recorded in {@link DOCS_FILE}. */
export interface WatchedSection {
  /** The page, in its Markdown form. */
  readonly url: string;
  /** The heading line that starts the section, such as `## Blockscout API Usage`. */
  readonly heading: string;
  /** The date the section was read, `YYYY-MM-DD`. */
  readonly read: string;
  /** The SHA-256 of {@link WatchedSection.text}, in hex. */
  readonly sha256: string;
  /** The section's text, normalised by {@link normalise}. */
  readonly text: string;
}

/** The kinds of signal. */
export type SignalKind = "header" | "answer" | "docs" | "down";

/** One signal: what fired, where, and what was seen. */
export interface Signal {
  readonly kind: SignalKind;
  readonly where: string;
  readonly detail: string;
}

/** What one instance answered. */
export interface InstanceResult {
  readonly chainId: number;
  readonly host: string;
  /** The HTTP status, or `error:` and the reason when the request failed. */
  readonly status: string;
  readonly answered: boolean;
  /** The watched headers the answer carried. */
  readonly headers: Readonly<Record<string, string>>;
}

/** What one watched docs section read. */
export interface DocsResult {
  readonly url: string;
  readonly heading: string;
  readonly status: string;
  /** The SHA-256 of the section now, when the section was found. */
  readonly sha256?: string;
  readonly changed: boolean;
}

/** What the script prints. */
export interface Report {
  readonly schemaVersion: 1;
  /** When the run started, as an ISO 8601 time. */
  readonly date: string;
  readonly sampled: number;
  readonly notAnswering: number;
  readonly instances: readonly InstanceResult[];
  readonly docs: readonly DocsResult[];
  readonly signals: readonly Signal[];
  issue?: string;
}

/** What the script takes from the outside, so the tests can replace each part. */
export interface Environment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly wait: (ms: number) => Promise<void>;
  /** The repository root the data files are read from; the script's own by default. */
  readonly root?: string;
}

/** The command line, read. */
export interface Arguments {
  readonly report: boolean;
  readonly out: string | undefined;
  readonly summary: string | undefined;
}

/** A wrong command line or data file: exit code 2. */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Reflect.get(value, key)
    : undefined;
}

/**
 * The instances to ask: every `blockscout` entry of the routing table on a host under
 * {@link HOSTED_SUFFIX}.
 *
 * @param table - The parsed {@link TABLE_FILE}.
 * @returns The instances, in ascending chain id order.
 * @throws UsageError when the table has another shape.
 */
export function sampleInstances(table: unknown): Instance[] {
  const chains = field(table, "chains");
  if (!Array.isArray(chains)) {
    throw new UsageError(`${TABLE_FILE}: chains must be a list`);
  }
  const found: Instance[] = [];
  for (const chain of chains) {
    const chainId = field(chain, "chainId");
    const backends = field(chain, "backends");
    if (typeof chainId !== "number" || !Array.isArray(backends)) {
      throw new UsageError(`${TABLE_FILE}: each chain needs a chainId and a backends list`);
    }
    for (const entry of backends) {
      const host = field(entry, "instance");
      if (
        field(entry, "backend") === "blockscout" &&
        typeof host === "string" &&
        host.endsWith(HOSTED_SUFFIX)
      ) {
        found.push({ chainId, host });
      }
    }
  }
  return found.toSorted((a, b) => a.chainId - b.chainId);
}

/**
 * The text the hash covers: every run of white space made one space, and the ends trimmed, so a
 * change of line breaks or indentation alone is not a change.
 *
 * @param text - Any text.
 * @returns The normalised text.
 */
export function normalise(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

/**
 * The SHA-256 of a text, in hex.
 *
 * @param text - The text.
 * @returns 64 hex digits.
 */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The section of a Markdown page under one heading: the lines after the heading up to the next
 * heading of any level, outside code fences, normalised.
 *
 * @param markdown - The page.
 * @param heading - The heading line, such as `## Blockscout API Usage`.
 * @returns The section's normalised text, or `undefined` when the page has no such heading.
 */
export function sectionOf(markdown: string, heading: string): string | undefined {
  const lines = markdown.split(/\r\n|\r|\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) {
    return undefined;
  }
  const kept: string[] = [];
  let fenced = false;
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
    } else if (!fenced && /^#{1,6}\s/.test(line)) {
      break;
    }
    kept.push(line);
  }
  return normalise(kept.join("\n"));
}

function textAt(value: unknown, key: string, where: string): string {
  const text = field(value, key);
  if (typeof text !== "string" || text === "") {
    throw new UsageError(`${where}: ${key} must be a non-empty string`);
  }
  return text;
}

/**
 * Reads the watched docs sections.
 *
 * @param value - The parsed {@link DOCS_FILE}.
 * @returns The sections.
 * @throws UsageError when the data has another shape, or a hash does not match its text.
 */
export function parseDocsFile(value: unknown): WatchedSection[] {
  const sections = field(value, "sections");
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new UsageError(`${DOCS_FILE}: sections must be a non-empty list`);
  }
  return sections.map((item: unknown, index): WatchedSection => {
    const where = `${DOCS_FILE}: sections[${String(index)}]`;
    const section: WatchedSection = {
      url: textAt(item, "url", where),
      heading: textAt(item, "heading", where),
      read: textAt(item, "read", where),
      sha256: textAt(item, "sha256", where),
      text: textAt(item, "text", where),
    };
    if (sha256(section.text) !== section.sha256) {
      throw new UsageError(`${where}: sha256 does not match its text`);
    }
    return section;
  });
}

/** The start of a text, at most `length` characters, around the first match of `pattern`. */
function around(text: string, pattern: RegExp, length: number): string {
  const at = Math.max(0, (pattern.exec(text)?.index ?? 0) - Math.floor(length / 2));
  return text.slice(at, at + length);
}

/** Reads at most {@link BODY_LIMIT} characters of an answer. */
async function bodyOf(response: Response): Promise<string> {
  return (await response.text()).slice(0, BODY_LIMIT);
}

/** Whether an answer is the per-instance RPC API's answer to {@link PROBE_PATH}. */
function isBlockNumber(status: number, body: string): boolean {
  if (status !== 200) {
    return false;
  }
  try {
    const result = field(JSON.parse(body), "result");
    return typeof result === "string" && /^0x[0-9a-f]+$/i.test(result);
  } catch {
    return false;
  }
}

/** Whether a header is a signal: `Link` only with a `deprecation` or `sunset` relation. */
function isSignalHeader(name: string, value: string): boolean {
  return name !== "link" || /rel\s*=\s*"?[^"]*\b(?:deprecation|sunset)\b/i.test(value);
}

/**
 * Asks one instance and reads its answer.
 *
 * @param instance - The instance.
 * @param fetchFn - The fetch.
 * @returns What it answered and the signals in the answer.
 */
export async function checkInstance(
  instance: Instance,
  fetchFn: typeof fetch,
): Promise<{ result: InstanceResult; signals: Signal[] }> {
  const where = `${instance.host} (chain ${String(instance.chainId)})`;
  let response: Response;
  try {
    response = await fetchFn(`https://${instance.host}${PROBE_PATH}`, {
      redirect: "manual",
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error: unknown) {
    return {
      result: {
        ...instance,
        status: `error: ${errorMessage(error)}`.slice(0, EXCERPT_LENGTH),
        answered: false,
        headers: {},
      },
      signals: [],
    };
  }
  const headers: Record<string, string> = {};
  const signals: Signal[] = [];
  for (const name of WATCHED_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null && isSignalHeader(name, value)) {
      headers[name] = value;
      signals.push({
        kind: "header",
        where,
        detail: `${name}: ${value}`.slice(0, EXCERPT_LENGTH),
      });
    }
  }
  const body = await bodyOf(response);
  const location = response.headers.get("location") ?? "";
  const parts: [string, string][] = [
    ["Location", location],
    ["body", body],
  ];
  for (const [part, text] of parts) {
    if (DEPRECATION_TEXT.test(text)) {
      signals.push({
        kind: "answer",
        where,
        detail: `HTTP ${String(response.status)} ${part}: ${around(text, DEPRECATION_TEXT, EXCERPT_LENGTH)}`,
      });
    }
  }
  return {
    result: {
      ...instance,
      status: String(response.status),
      answered: isBlockNumber(response.status, body),
      headers,
    },
    signals,
  };
}

/**
 * Reads one watched docs section and compares it with the recorded hash.
 *
 * @param section - The recorded section.
 * @param fetchFn - The fetch.
 * @returns What it read, and a signal when the section changed or could not be read.
 */
export async function checkDocs(
  section: WatchedSection,
  fetchFn: typeof fetch,
): Promise<{ result: DocsResult; signal?: Signal }> {
  const where = `${section.url} ${section.heading}`;
  const recorded = `Recorded on ${section.read} with sha256 ${section.sha256}.`;
  let response: Response;
  try {
    response = await fetchFn(section.url, {
      redirect: "manual",
      headers: { accept: "text/markdown", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error: unknown) {
    return {
      result: { url: section.url, heading: section.heading, status: "error", changed: true },
      signal: {
        kind: "docs",
        where,
        detail: `${recorded} The page could not be read: ${errorMessage(error)}`.slice(
          0,
          EXCERPT_LENGTH,
        ),
      },
    };
  }
  const status = String(response.status);
  const base = { url: section.url, heading: section.heading, status };
  const text =
    response.status === 200 ? sectionOf(await response.text(), section.heading) : undefined;
  if (text === undefined) {
    const why =
      response.status === 200
        ? "The page no longer has this heading."
        : `The page answered HTTP ${status}${response.headers.has("location") ? ` to ${response.headers.get("location") ?? ""}` : ""}.`;
    return {
      result: { ...base, changed: true },
      signal: { kind: "docs", where, detail: `${recorded} ${why}`.slice(0, EXCERPT_LENGTH) },
    };
  }
  const hash = sha256(text);
  if (hash === section.sha256) {
    return { result: { ...base, sha256: hash, changed: false } };
  }
  return {
    result: { ...base, sha256: hash, changed: true },
    signal: {
      kind: "docs",
      where,
      detail: `${recorded} Now sha256 ${hash}. The section reads: ${text}`.slice(
        0,
        DOCS_EXCERPT_LENGTH,
      ),
    },
  };
}

/**
 * Runs the watch: each instance one after the other, {@link MIN_INTERVAL_MS} apart, then each
 * docs section.
 *
 * @param instances - The instances to ask.
 * @param sections - The watched docs sections.
 * @param environment - Fetch, clock and wait.
 * @returns The report, without the issue.
 */
export async function runWatch(
  instances: readonly Instance[],
  sections: readonly WatchedSection[],
  environment: Environment,
): Promise<Report> {
  const date = new Date(environment.now()).toISOString();
  const results: InstanceResult[] = [];
  const signals: Signal[] = [];
  let last: number | undefined;
  for (const instance of instances) {
    if (last !== undefined) {
      const gap = last + MIN_INTERVAL_MS - environment.now();
      if (gap > 0) {
        await environment.wait(gap);
      }
    }
    last = environment.now();
    const checked = await checkInstance(instance, environment.fetch);
    results.push(checked.result);
    signals.push(...checked.signals);
  }
  const down = results.filter((result) => !result.answered);
  if (down.length >= DOWN_THRESHOLD) {
    signals.push({
      kind: "down",
      where: `${String(down.length)} of ${String(results.length)} sampled instances`,
      detail: down
        .map((result) => `${result.host} ${result.status}`)
        .join(", ")
        .slice(0, DOCS_EXCERPT_LENGTH),
    });
  }
  const docs: DocsResult[] = [];
  for (const section of sections) {
    const checked = await checkDocs(section, environment.fetch);
    docs.push(checked.result);
    if (checked.signal !== undefined) {
      signals.push(checked.signal);
    }
  }
  return {
    schemaVersion: 1,
    date,
    sampled: results.length,
    notAnswering: down.length,
    instances: results,
    docs,
    signals,
  };
}

/**
 * The signals as a Markdown table, each outside text in a code span.
 *
 * @param signals - The signals.
 * @returns The table, at most {@link MAX_ROWS} rows and {@link TABLE_LIMIT} characters of rows,
 *   with a line for the rest.
 */
export function signalTable(signals: readonly Signal[]): string {
  const rows: string[] = [];
  let size = 0;
  for (const signal of signals) {
    const row = `| ${signal.kind} | ${codeCell(signal.where)} | ${codeCell(signal.detail)} |`;
    if (rows.length === MAX_ROWS || size + row.length > TABLE_LIMIT) {
      break;
    }
    rows.push(row);
    size += row.length + 1;
  }
  const rest = signals.length - rows.length;
  return [
    "| Signal | Where | Detail |",
    "| ------ | ----- | ------ |",
    ...rows,
    ...(rest > 0 ? ["", `And ${String(rest)} more; the run's JSON lists every one.`] : []),
  ].join("\n");
}

/**
 * The issue body. Its size is bounded: the table holds at most {@link MAX_ROWS} rows and
 * {@link TABLE_LIMIT} characters, well below GitHub's limit of 65,536 for an issue body.
 *
 * @param report - A report with at least one signal.
 * @param runUrl - The workflow run, when known.
 * @returns The Markdown body, starting with {@link MARKER}.
 */
export function issueBody(report: Report, runUrl: string | undefined): string {
  const kinds = [...new Set(report.signals.map((signal) => signal.kind))].join(", ");
  return [
    MARKER,
    `The Blockscout deprecation watch of ${report.date} saw these signals: ${kinds}.`,
    ...(runUrl === undefined ? [] : [`Run: ${runUrl}`]),
    "",
    signalTable(report.signals),
    "",
    `${String(report.notAnswering)} of ${String(report.sampled)} sampled instances did not answer.`,
    "",
    `When Blockscout removes the per-instance API, the hosted API of #${String(HOSTED_API_ISSUE)} becomes the only Blockscout route for many chains. A \`docs\` signal stays until a pull request records the new section in \`${DOCS_FILE}\`. See docs/contributor/testing.md#blockscout-deprecation-watch for each signal. The weekly workflow updates this issue while a signal remains and closes it when none remains.`,
    "",
  ].join("\n");
}

/** The comment the script leaves when it closes the issue. */
export function closingComment(report: Report): string {
  return `The Blockscout deprecation watch of ${report.date} saw no signal: ${String(report.sampled - report.notAnswering)} of ${String(report.sampled)} sampled instances answered, and the watched docs sections are unchanged. Closing.`;
}

/**
 * Opens, updates or closes the issue to match the report.
 *
 * @param report - The watch's report.
 * @param api - The GitHub calls.
 * @param runUrl - The workflow run, when known.
 * @returns One line that says what it did.
 */
export async function sync(
  report: Report,
  api: IssueApi,
  runUrl: string | undefined,
): Promise<string> {
  return await syncIssue(
    api,
    {
      title: TITLE,
      labels: LABELS,
      subject: "blockscout deprecation",
      quiet: "no signal",
      same: "already lists these signals",
    },
    report.signals.length === 0 ? undefined : issueBody(report, runUrl),
    closingComment(report),
  );
}

/**
 * Reads the command line.
 *
 * @param argv - The arguments after the script's path.
 * @returns The options.
 * @throws UsageError for an unknown flag or a flag without its value.
 */
export function parseArguments(argv: readonly string[]): Arguments {
  let report = false;
  let out: string | undefined;
  let summary: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--report") {
      report = true;
      continue;
    }
    const value = argv[index + 1];
    if (flag !== "--out" && flag !== "--summary") {
      throw new UsageError(`unknown flag ${String(flag)}`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${flag} needs a value`);
    }
    index += 1;
    if (flag === "--out") {
      out = value;
    } else {
      summary = value;
    }
  }
  return { report, out, summary };
}

function readJson(base: string, file: string): unknown {
  try {
    return JSON.parse(readFileSync(path.join(base, file), "utf8"));
  } catch (error: unknown) {
    throw new UsageError(`cannot read ${file}: ${errorMessage(error)}`);
  }
}

/** The run summary: the counts, then the signals or a line that says there are none. */
function summaryOf(report: Report): string {
  return [
    `## Blockscout deprecation watch, ${report.date}`,
    "",
    `${String(report.sampled - report.notAnswering)} of ${String(report.sampled)} sampled instances answered. ${String(report.docs.filter((one) => !one.changed).length)} of ${String(report.docs.length)} watched docs sections are unchanged.`,
    "",
    report.signals.length === 0 ? "No signal." : signalTable(report.signals),
    "",
  ].join("\n");
}

/**
 * Runs the script.
 *
 * @param argv - The arguments after the script's path.
 * @param environment - Fetch, clock, wait and environment variables.
 * @returns The exit code and the text for stdout and stderr, the GitHub token removed.
 */
export async function main(
  argv: readonly string[],
  environment: Environment,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const token = environment.env["GH_TOKEN"] ?? "";
  const clean = (value: string): string =>
    token === "" ? value : value.replaceAll(token, "[redacted]");
  try {
    const args = parseArguments(argv);
    const repository = environment.env["GITHUB_REPOSITORY"] ?? "";
    if (args.report && (token === "" || repository === "")) {
      throw new UsageError("--report needs GH_TOKEN and GITHUB_REPOSITORY");
    }
    const base = environment.root ?? root;
    const instances = sampleInstances(readJson(base, TABLE_FILE));
    const sections = parseDocsFile(readJson(base, DOCS_FILE));
    const report = await runWatch(instances, sections, environment);
    let code = report.signals.length > 0 && !args.report ? 1 : 0;
    let stderr = "";
    if (args.report) {
      const server = environment.env["GITHUB_SERVER_URL"];
      const runId = environment.env["GITHUB_RUN_ID"];
      const runUrl =
        server === undefined || runId === undefined
          ? undefined
          : `${server}/${repository}/actions/runs/${runId}`;
      try {
        report.issue = await sync(
          report,
          gitHubApi(
            {
              repository,
              token,
              apiUrl: environment.env["GITHUB_API_URL"] ?? "https://api.github.com",
              fetch: environment.fetch,
            },
            MARKER,
          ),
          runUrl,
        );
      } catch (error: unknown) {
        stderr = `Could not sync the issue: ${errorMessage(error)}\n`;
        code = 1;
      }
    }
    const json = clean(`${JSON.stringify(report, null, 2)}\n`);
    if (args.out !== undefined) {
      writeFileSync(args.out, json);
    }
    if (args.summary !== undefined) {
      appendFileSync(args.summary, clean(summaryOf(report)));
    }
    return { code, stdout: json, stderr: clean(stderr) };
  } catch (error: unknown) {
    return {
      code: error instanceof UsageError ? 2 : 1,
      stdout: "",
      stderr: clean(`${errorMessage(error)}\n`),
    };
  }
}

/**
 * The environment of a real run: Node's fetch, clock and timers, and `process.env`.
 *
 * @returns The environment.
 */
export function nodeEnvironment(): Environment {
  return {
    env: process.env,
    fetch: async (input, init) => await globalThis.fetch(input, init),
    now: () => Date.now(),
    wait: async (ms) => await new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

if (isMainModule(import.meta.url)) {
  const result = await main(process.argv.slice(2), nodeEnvironment());
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
