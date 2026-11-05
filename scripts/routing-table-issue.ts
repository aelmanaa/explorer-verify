// Opens, updates or closes the one issue that lists the differences between the routing table and
// the public chain lists (#171, R-RT-1). The weekly workflow .github/workflows/routing-table.yml
// runs `node scripts/compare-routing-table.ts --json`, then passes the JSON to this script.
//
// - Differences and no open issue: it opens one, titled {@link TITLE}.
// - Differences and an open issue: it replaces the issue's body when the differences changed.
// - No difference and an open issue: it comments and closes the issue.
// - No difference and no open issue: it does nothing.
//
// The issue is found by {@link MARKER} in the body of an open issue opened by the workflow's
// token, so a changed title or label does not open a second one.
//
// Usage: node scripts/routing-table-issue.ts <report.json>
// It reads GH_TOKEN (the workflow's own token, never printed) and GITHUB_REPOSITORY, and
// GITHUB_API_URL when set. Exits 1 when the report or a GitHub call fails.
import { readFileSync } from "node:fs";
import process from "node:process";

import { gitHubApi as markedIssueApi, syncIssue } from "./github-issue.ts";
import type { GitHubOptions, IssueApi } from "./github-issue.ts";
import { errorMessage, isMainModule } from "./release-packages.ts";
import type { ChangedList, Difference } from "./routing-seed.ts";

/** The title of the issue. */
export const TITLE = "Routing table differs from the public chain lists";
/** The hidden line in the issue body that finds the issue again. */
export const MARKER = "<!-- routing-table-compare -->";
/** The labels of a new issue. */
export const LABELS: readonly string[] = ["type:chore", "area:routing", "status:needs-triage"];
export { BOT } from "./github-issue.ts";
export type { GitHubOptions, Issue, IssueApi } from "./github-issue.ts";

/** The JSON `compare-routing-table.ts --json` prints. */
export interface Report {
  readonly checked: string;
  readonly notes: readonly string[];
  readonly differences: readonly Difference[];
}

const LISTS: readonly ChangedList[] = [
  "Etherscan chainlist",
  "Sourcify chain list",
  "Routescan chain list",
  "Blockscout chain registry",
  "alloy-chains list",
];

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Reflect.get(value, key)
    : undefined;
}

function changedList(value: unknown): ChangedList | undefined {
  return LISTS.find((list) => list === value);
}

function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`report: ${name} is not an array`);
  }
  return value.map((item: unknown) => {
    if (typeof item !== "string") {
      throw new TypeError(`report: ${name} has an entry that is not a string`);
    }
    return item;
  });
}

/**
 * Reads the JSON `compare-routing-table.ts --json` printed.
 *
 * @param value - The parsed JSON.
 * @returns The report.
 * @throws TypeError when the value has another shape.
 */
export function parseReport(value: unknown): Report {
  const checked = field(value, "checked");
  if (typeof checked !== "string") {
    throw new TypeError("report: checked is not a string");
  }
  const found = field(value, "differences");
  if (!Array.isArray(found)) {
    throw new TypeError("report: differences is not an array");
  }
  const differences = found.map((item: unknown): Difference => {
    const chainId = field(item, "chainId");
    const list = changedList(field(item, "list"));
    const text = field(item, "text");
    if (typeof chainId !== "number" || !Number.isSafeInteger(chainId)) {
      throw new TypeError("report: a difference has no integer chainId");
    }
    if (list === undefined) {
      throw new TypeError(`report: chain ${String(chainId)} names an unknown list`);
    }
    if (typeof text !== "string") {
      throw new TypeError(`report: chain ${String(chainId)} has no text`);
    }
    return { chainId, list, text };
  });
  return { checked, notes: strings(field(value, "notes"), "notes"), differences };
}

const cell = (text: string): string => text.replaceAll("|", "\\|").replaceAll("\n", " ");

/**
 * The issue body: one table row per difference with its chain and the list it changed in, then
 * the notes.
 *
 * @param report - A report with at least one difference.
 * @returns The Markdown body, starting with {@link MARKER}.
 */
export function issueBody(report: Report): string {
  const count = report.differences.length;
  const lines = [
    MARKER,
    `The weekly comparison found ${String(count)} ${count === 1 ? "difference" : "differences"} between the routing table (checked ${report.checked}) and the public chain lists.`,
    "",
    "| Chain | Changed in | Difference |",
    "| ----: | ---------- | ---------- |",
    ...report.differences.map(
      (difference) =>
        `| ${String(difference.chainId)} | ${difference.list} | ${cell(difference.text)} |`,
    ),
    "",
    "Notes:",
    "",
    ...report.notes.map((note) => `- ${note}`),
    "",
    "Run `node scripts/compare-routing-table.ts` to see the differences. A pull request that updates `packages/explorer-verify/src/routing/table.json` and its research data fixes them. The weekly workflow updates this issue while differences remain and closes it when none remain.",
    "",
  ];
  return lines.join("\n");
}

/** The comment the script leaves when it closes the issue. */
export function closingComment(report: Report): string {
  return `The weekly comparison found no difference between the routing table (checked ${report.checked}) and the public chain lists. Closing.`;
}

/**
 * Opens, updates or closes the issue to match the report.
 *
 * @param report - The comparison's report.
 * @param api - The GitHub calls.
 * @returns One line that says what the script did.
 */
export async function sync(report: Report, api: IssueApi): Promise<string> {
  return await syncIssue(
    api,
    {
      title: TITLE,
      labels: LABELS,
      subject: "routing table",
      quiet: "no differences",
      same: "already lists these differences",
    },
    report.differences.length === 0 ? undefined : issueBody(report),
    closingComment(report),
  );
}

/**
 * The GitHub REST calls behind {@link IssueApi}, finding the issue by {@link MARKER}.
 *
 * @param options - The repository, token, API root and fetch.
 * @returns The calls.
 */
export function gitHubApi(options: GitHubOptions): IssueApi {
  return markedIssueApi(options, MARKER);
}

/** The environment variables the command reads. */
export interface Environment {
  readonly GH_TOKEN?: string | undefined;
  readonly GITHUB_REPOSITORY?: string | undefined;
  readonly GITHUB_API_URL?: string | undefined;
}

/**
 * The command: reads the report file and syncs the issue.
 *
 * @param args - The command-line arguments: the report file.
 * @param env - The environment.
 * @param fetch - The fetch for the GitHub calls.
 * @returns The line to print.
 */
export async function main(
  args: readonly string[],
  env: Environment,
  fetch: typeof globalThis.fetch,
): Promise<string> {
  const [file] = args;
  if (file === undefined || args.length !== 1) {
    throw new Error("usage: node scripts/routing-table-issue.ts <report.json>");
  }
  const token = env.GH_TOKEN ?? "";
  const repository = env.GITHUB_REPOSITORY ?? "";
  if (token === "" || repository === "") {
    throw new Error("GH_TOKEN and GITHUB_REPOSITORY must be set");
  }
  const report = parseReport(JSON.parse(readFileSync(file, "utf8")));
  return await sync(
    report,
    gitHubApi({
      repository,
      token,
      apiUrl: env.GITHUB_API_URL ?? "https://api.github.com",
      fetch,
    }),
  );
}

if (isMainModule(import.meta.url)) {
  try {
    process.stdout.write(`${await main(process.argv.slice(2), process.env, globalThis.fetch)}\n`);
  } catch (error: unknown) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
