// The scheduled live check (R-QA-4). It asks real explorers about contracts the live matrix
// deployed and verified, and fails when an answer changed: an API, a status string, a host or a
// CORS header. For each target in test/live/targets.json it:
//
// - looks the contract up and expects the recorded match;
// - looks up an address with no code and expects "not verified";
// - with `cors`, checks that the lookup's GET answered `access-control-allow-origin: *`;
// - with `submitInput`, submits that recorded source and expects `already-verified`.
//
// It runs the built core package (`pnpm --filter explorer-verify run build` first), as the live
// matrix does. The lookups go through the public `dryRun()`; only the Sourcify submit uses
// internals (see submitRecorded). So every request goes through the library's
// HTTP layer, and every error the library raises has its keys removed (R-SEC-1). Keys come only
// from the environment variable a target names in `keyEnv`. The script removes every key and the
// GitHub token from all its output once more, the issue text included.
//
// With `--report`, a run with a failed check opens an issue labelled `status:needs-triage`, or
// comments on the open one that github-actions[bot] opened with that label and title. It reads
// GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_API_URL, as GitHub Actions sets them.
//
// Usage: node scripts/live-check.ts [--targets <file>] [--backends <a,b>] [--report]
//                                   [--out <file>] [--summary <file>]
// Prints the result as JSON. Exits 0 when every check passed, 1 when one failed or the report could
// not be filed, and 2 for a wrong command line or targets file.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { DEFAULT_DEPENDENCIES } from "../packages/explorer-verify/dist/src/flow/defaults.js";
import {
  openCall,
  routeOf,
  settingsOf,
  startBudget,
  withClient,
} from "../packages/explorer-verify/dist/src/flow/verify.js";
import {
  ExplorerVerifyError,
  dryRun,
  toBackendName,
  validateInput,
} from "../packages/explorer-verify/dist/src/index.js";
import type {
  BackendName,
  Hex,
  VerifyInput,
  VerifyOptions,
} from "../packages/explorer-verify/dist/src/index.js";
import { redact } from "../packages/explorer-verify/dist/src/redact.js";
import { codeCell } from "./github-issue.ts";
import { errorMessage, isMainModule } from "./release-packages.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The targets file the workflow reads. */
export const DEFAULT_TARGETS: string = path.join(root, "test/live/targets.json");
/** The title of the issue a failed run opens or comments on. */
export const ISSUE_TITLE = "Live check failed";
/** The label of that issue. */
export const ISSUE_LABEL = "status:needs-triage";
/** The account that opens the issue: the workflow's own token. */
export const ISSUE_AUTHOR = "github-actions[bot]";
/** The `Origin` header each request carries, so an explorer answers with its CORS headers. */
export const ORIGIN = "https://example.com";
/** The time budget of one lookup or submit, retries included, in milliseconds. */
export const CALL_TIMEOUT_MS = 60_000;
/** The most pages of open issues read when looking for the open report. */
export const MAX_ISSUE_PAGES = 10;
/** The longest excerpt of an error a check reports. */
export const EXCERPT_LENGTH = 500;

/** One contract the check asks about. */
export interface LiveTarget {
  /** The live matrix's label of the deployment, such as `SrcSep1`. */
  readonly label: string;
  readonly backend: BackendName;
  readonly chainId: number;
  readonly address: Hex;
  /** The match the explorer recorded. */
  readonly match: "exact" | "partial";
  /** `route.apiUrl`, for a backend the routing table does not list for the chain. */
  readonly apiUrl?: string;
  /** The environment variable that holds the backend's key. */
  readonly keyEnv?: string;
  /** Whether to check the CORS header of the lookup's GET. */
  readonly cors: boolean;
  /** The file, next to the targets file, with the recorded `VerifyInput` to submit. */
  readonly submitInput?: string;
}

/** The targets file, read and checked. */
export interface Targets {
  /** An address with no code on every target chain. */
  readonly noCodeAddress: Hex;
  /** The shortest time between two requests to one backend, in milliseconds. */
  readonly minIntervalMs: Readonly<Partial<Record<BackendName, number>>>;
  readonly targets: readonly LiveTarget[];
  /** The directory `submitInput` paths are relative to. */
  readonly directory: string;
}

/** The kinds of check. */
export type CheckKind = "lookup" | "no-code" | "cors" | "submit";

/** The result of one check. */
export interface CheckResult {
  readonly backend: BackendName;
  readonly chainId: number;
  readonly label: string;
  readonly check: CheckKind;
  readonly address: string;
  readonly ok: boolean;
  readonly expected: string;
  readonly actual: string;
  /** The error message or the start of the explorer's answer, keys removed. */
  readonly excerpt?: string;
}

/** The result per backend. */
export interface BackendResult {
  readonly ok: boolean;
  readonly checks: CheckResult[];
}

/** What the script prints. */
export interface Report {
  readonly schemaVersion: 1;
  /** When the run started, as an ISO 8601 time. */
  readonly date: string;
  readonly ok: boolean;
  readonly backends: Partial<Record<BackendName, BackendResult>>;
  issue?: IssueAction;
}

/** What the report step did on GitHub. */
export interface IssueAction {
  readonly action: "opened" | "commented";
  readonly number: number;
  readonly url: string;
}

/** What the script takes from the outside, so the tests can replace each part. */
export interface Environment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly wait: (ms: number) => Promise<void>;
}

/** The command line, read. */
export interface Arguments {
  readonly targets: string;
  readonly backends: readonly BackendName[] | undefined;
  readonly report: boolean;
  readonly out: string | undefined;
  readonly summary: string | undefined;
}

/** A wrong command line or targets file: exit code 2. */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function address(value: unknown, where: string): Hex {
  if (typeof value !== "string" || !HEX_ADDRESS.test(value)) {
    throw new UsageError(`${where} must be a 0x address of 40 hex digits`);
  }
  return `0x${value.slice(2)}`;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || value === "") {
    throw new UsageError(`${where} must be a non-empty string`);
  }
  return value;
}

function optionalText(value: unknown, where: string): string | undefined {
  return value === undefined ? undefined : text(value, where);
}

function backendName(value: unknown, where: string): BackendName {
  const name = toBackendName(text(value, where));
  if (name === undefined) {
    throw new UsageError(`${where} must name a backend`);
  }
  return name;
}

function readTarget(value: unknown, index: number): LiveTarget {
  const where = `targets[${String(index)}]`;
  const chainId = field(value, "chainId");
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new UsageError(`${where}.chainId must be a positive integer`);
  }
  const match = field(value, "match");
  if (match !== "exact" && match !== "partial") {
    throw new UsageError(`${where}.match must be "exact" or "partial"`);
  }
  const cors = field(value, "cors");
  if (cors !== undefined && typeof cors !== "boolean") {
    throw new UsageError(`${where}.cors must be a boolean`);
  }
  const apiUrl = optionalText(field(value, "apiUrl"), `${where}.apiUrl`);
  const keyEnv = optionalText(field(value, "keyEnv"), `${where}.keyEnv`);
  const submitInput = optionalText(field(value, "submitInput"), `${where}.submitInput`);
  return {
    label: text(field(value, "label"), `${where}.label`),
    backend: backendName(field(value, "backend"), `${where}.backend`),
    chainId,
    address: address(field(value, "address"), `${where}.address`),
    match,
    cors: cors === true,
    ...(apiUrl === undefined ? {} : { apiUrl }),
    ...(keyEnv === undefined ? {} : { keyEnv }),
    ...(submitInput === undefined ? {} : { submitInput }),
  };
}

/**
 * Reads and checks a targets file.
 * @param file The file's path.
 * @param source The file's text.
 * @returns The targets.
 * @throws UsageError when the text is not JSON or a field is wrong.
 */
export function readTargets(file: string, source: string): Targets {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error: unknown) {
    throw new UsageError(`${file}: not JSON: ${errorMessage(error)}`);
  }
  const list = field(parsed, "targets");
  if (!Array.isArray(list) || list.length === 0) {
    throw new UsageError(`${file}: targets must be a non-empty array`);
  }
  const intervals = field(parsed, "minIntervalMs") ?? {};
  if (typeof intervals !== "object" || intervals === null || Array.isArray(intervals)) {
    throw new UsageError(`${file}: minIntervalMs must be an object`);
  }
  const minIntervalMs: Partial<Record<BackendName, number>> = {};
  for (const [name, ms] of Object.entries(intervals)) {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
      throw new UsageError(`${file}: minIntervalMs.${name} must be a number of 0 or more`);
    }
    minIntervalMs[backendName(name, `${file}: minIntervalMs`)] = ms;
  }
  return {
    noCodeAddress: address(field(parsed, "noCodeAddress"), `${file}: noCodeAddress`),
    minIntervalMs,
    targets: list.map((value, index) => readTarget(value, index)),
    directory: path.dirname(file),
  };
}

/**
 * Reads the command line.
 * @param argv The arguments after the script's path.
 * @returns The options.
 * @throws UsageError for an unknown flag or a flag without its value.
 */
export function parseArguments(argv: readonly string[]): Arguments {
  let targets = DEFAULT_TARGETS;
  let backends: BackendName[] | undefined;
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
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${String(flag)} needs a value`);
    }
    index += 1;
    if (flag === "--targets") {
      targets = path.resolve(value);
    } else if (flag === "--backends") {
      backends = value.split(",").map((name) => backendName(name.trim(), "--backends"));
    } else if (flag === "--out") {
      out = value;
    } else if (flag === "--summary") {
      summary = value;
    } else {
      throw new UsageError(`unknown flag ${String(flag)}`);
    }
  }
  return { targets, backends, report, out, summary };
}

/** One response the check saw: the request method and the CORS header of the answer. */
interface Seen {
  readonly method: string;
  readonly allowOrigin: string | null;
}

/**
 * The `fetch` one backend's calls go through. It adds the `Origin` header, keeps at least
 * `minIntervalMs` between two requests, and records each answer's CORS header in `seen`.
 */
function backendFetch(environment: Environment, minIntervalMs: number, seen: Seen[]): typeof fetch {
  let last: number | undefined;
  return async (input, init) => {
    if (last !== undefined) {
      const gap = last + minIntervalMs - environment.now();
      if (gap > 0) {
        await environment.wait(gap);
      }
    }
    last = environment.now();
    const headers = new Headers(init?.headers);
    headers.set("origin", ORIGIN);
    const response = await environment.fetch(input, { ...init, headers });
    seen.push({
      method: init?.method ?? "GET",
      allowOrigin: response.headers.get("access-control-allow-origin"),
    });
    return response;
  };
}

/** The options of one call: the target's route, and its key bound to that route. */
function optionsFor(
  target: LiveTarget,
  key: string | undefined,
  fetchFn: typeof fetch,
): VerifyOptions {
  return {
    fetch: fetchFn,
    timeoutMs: CALL_TIMEOUT_MS,
    route: {
      backend: target.backend,
      ...(target.apiUrl === undefined ? {} : { apiUrl: target.apiUrl }),
      ...(target.apiUrl !== undefined && key !== undefined ? { apiKey: key } : {}),
    },
    ...(target.apiUrl === undefined && key !== undefined
      ? { apiKeys: { [target.backend]: key } }
      : {}),
  };
}

/**
 * Looks a contract up with the public `dryRun()`. It takes a whole `VerifyInput`, but its lookup
 * sends only the chain id and the address: this placeholder source passes `validateInput` and
 * never reaches an explorer.
 */
async function lookup(
  target: LiveTarget,
  contract: Hex,
  key: string | undefined,
  fetchFn: typeof fetch,
): Promise<string> {
  const input: VerifyInput = {
    chainId: target.chainId,
    address: contract,
    compiler: {
      kind: "solc",
      version: "0.8.24+commit.e11b9ed9",
      input: {
        language: "Solidity",
        sources: { "Lookup.sol": { content: "contract Lookup {}" } },
        settings: {},
      },
    },
    contractName: "Lookup.sol:Lookup",
  };
  const result = await dryRun(input, optionsFor(target, key, fetchFn));
  return result.lookup === "none" ? "not verified" : result.lookup;
}

/**
 * Submits a recorded source and returns the submit's state. The public API has no submit without
 * the lookup before it: `verify()` would find the contract verified and never send the submit
 * that R-QA-4 asks for. So this one check opens a call the way `verify()` does and calls the
 * client's `submit` directly. Every request still goes through the library's HTTP layer.
 */
async function submitRecorded(
  target: LiveTarget,
  source: unknown,
  key: string | undefined,
  fetchFn: typeof fetch,
): Promise<string> {
  const input = validateInput(source);
  const settings = settingsOf(optionsFor(target, key, fetchFn));
  const budget = startBudget(settings);
  const route = await routeOf(input.chainId, settings, DEFAULT_DEPENDENCIES, budget);
  const dependencies = await withClient(route, DEFAULT_DEPENDENCIES, settings, budget);
  const contract = { chainId: input.chainId, address: input.address };
  const call = openCall(settings, route, contract, dependencies, true, budget);
  return (await call.backend.submit(input, call.ctx)).state;
}

/** What a failed call reports: the error code and its message, with the explorer's excerpt. */
function failure(error: unknown, secrets: readonly string[]): { actual: string; excerpt: string } {
  if (error instanceof ExplorerVerifyError) {
    const excerpt = field(error.details, "excerpt");
    const detail = typeof excerpt === "string" && excerpt !== "" ? ` Answer: ${excerpt}` : "";
    return {
      actual: `threw ${error.details.code}`,
      excerpt: redact(`${error.message}${detail}`, secrets).slice(0, EXCERPT_LENGTH),
    };
  }
  return {
    actual: "threw",
    excerpt: redact(errorMessage(error), secrets).slice(0, EXCERPT_LENGTH),
  };
}

/** Runs one check and turns whatever it throws into a failed result. */
async function check(
  base: Omit<CheckResult, "ok" | "actual" | "excerpt">,
  secrets: readonly string[],
  run: () => Promise<string>,
): Promise<CheckResult> {
  // Every result lists its fields in one order: ok, expected, actual, excerpt.
  const { expected, ...where } = base;
  try {
    const actual = await run();
    return { ...where, ok: actual === expected, expected, actual };
  } catch (error: unknown) {
    return { ...where, ok: false, expected, ...failure(error, secrets) };
  }
}

/** Runs every check of one target, one request at a time. */
async function checkTarget(
  target: LiveTarget,
  targets: Targets,
  environment: Environment,
  fetchFn: typeof fetch,
  seen: Seen[],
  secrets: readonly string[],
): Promise<CheckResult[]> {
  const { backend, chainId, label } = target;
  const key = target.keyEnv === undefined ? undefined : environment.env[target.keyEnv];
  const base = { backend, chainId, label };
  if (target.keyEnv !== undefined && (key === undefined || key === "")) {
    return [
      {
        ...base,
        check: "lookup",
        address: target.address,
        ok: false,
        expected: target.match,
        actual: `no key: ${target.keyEnv} is not set`,
      },
    ];
  }
  const results: CheckResult[] = [];
  const start = seen.length;
  results.push(
    await check(
      { ...base, check: "lookup", address: target.address, expected: target.match },
      secrets,
      async () => await lookup(target, target.address, key, fetchFn),
    ),
  );
  if (target.cors) {
    const get = seen.slice(start).find((response) => response.method === "GET");
    const actual = get === undefined ? "no GET answer" : (get.allowOrigin ?? "no header");
    results.push({
      ...base,
      check: "cors",
      address: target.address,
      ok: actual === "*",
      expected: "*",
      actual,
    });
  }
  results.push(
    await check(
      { ...base, check: "no-code", address: targets.noCodeAddress, expected: "not verified" },
      secrets,
      async () => await lookup(target, targets.noCodeAddress, key, fetchFn),
    ),
  );
  if (target.submitInput !== undefined) {
    const file = path.resolve(targets.directory, target.submitInput);
    results.push(
      await check(
        { ...base, check: "submit", address: target.address, expected: "already-verified" },
        secrets,
        async () =>
          await submitRecorded(target, JSON.parse(readFileSync(file, "utf8")), key, fetchFn),
      ),
    );
  }
  return results;
}

/**
 * Every value the run must never print: each key a target names, and the GitHub token.
 * @param targets The targets.
 * @param env The environment.
 * @returns The values that are set.
 */
export function secretsOf(targets: Targets, env: Environment["env"]): string[] {
  const names = new Set(targets.targets.flatMap((target) => target.keyEnv ?? []));
  names.add("GITHUB_TOKEN");
  return [...names].flatMap((name) => {
    const value = env[name];
    return value === undefined || value === "" ? [] : [value];
  });
}

/**
 * Runs the checks.
 * @param targets The targets.
 * @param backends The backends to check, or undefined for all.
 * @param environment Fetch, clock, wait and environment variables.
 * @returns The report, without the issue.
 */
export async function runChecks(
  targets: Targets,
  backends: readonly BackendName[] | undefined,
  environment: Environment,
): Promise<Report> {
  const date = new Date(environment.now()).toISOString();
  const secrets = secretsOf(targets, environment.env);
  const fetches = new Map<BackendName, { fetch: typeof fetch; seen: Seen[] }>();
  const result: Partial<Record<BackendName, BackendResult>> = {};
  for (const target of targets.targets) {
    if (backends !== undefined && !backends.includes(target.backend)) {
      continue;
    }
    let shared = fetches.get(target.backend);
    if (shared === undefined) {
      const seen: Seen[] = [];
      shared = {
        seen,
        fetch: backendFetch(environment, targets.minIntervalMs[target.backend] ?? 0, seen),
      };
      fetches.set(target.backend, shared);
    }
    const checks = await checkTarget(
      target,
      targets,
      environment,
      shared.fetch,
      shared.seen,
      secrets,
    );
    const entry = result[target.backend] ?? { ok: true, checks: [] };
    entry.checks.push(...checks);
    result[target.backend] = { ok: entry.checks.every((one) => one.ok), checks: entry.checks };
  }
  const values = Object.values(result);
  return {
    schemaVersion: 1,
    date,
    ok: values.length > 0 && values.every((one) => one.ok),
    backends: result,
  };
}

/**
 * The checks as a Markdown table.
 * @param report The report.
 * @param onlyFailed Whether to list the failed checks only.
 * @returns The table.
 */
export function table(report: Report, onlyFailed: boolean): string {
  const rows = Object.values(report.backends)
    .flatMap((backend) => backend.checks)
    .filter((one) => !onlyFailed || !one.ok)
    .map(
      (one) =>
        `| ${one.backend} | ${String(one.chainId)} | ${one.label} | ${one.check} | ${one.ok ? "ok" : "**failed**"} | ${codeCell(one.expected)} | ${codeCell(one.actual)} | ${codeCell(one.excerpt ?? "")} |`,
    );
  return [
    "| Backend | Chain | Target | Check | Result | Expected | Actual | Excerpt |",
    "| ------- | ----- | ------ | ----- | ------ | -------- | ------ | ------- |",
    ...rows,
  ].join("\n");
}

/**
 * The text of the issue or comment for a failed run.
 * @param report The report.
 * @param runUrl The workflow run, when known.
 * @returns Markdown.
 */
export function issueBody(report: Report, runUrl: string | undefined): string {
  const failed = Object.entries(report.backends)
    .filter(([, backend]) => !backend.ok)
    .map(([name]) => `\`${name}\``)
    .join(", ");
  return [
    `The live check of ${report.date} failed on ${failed === "" ? "no backend" : failed}.`,
    ...(runUrl === undefined ? [] : [`Run: ${runUrl}`]),
    "",
    table(report, true),
    "",
    "See docs/contributor/testing.md#live-check for what each check expects.",
    "",
  ].join("\n");
}

/** A GitHub REST request with the token. Throws with the status and the answer, token removed. */
async function github(
  environment: Environment,
  token: string,
  secrets: readonly string[],
  url: string,
  init: { method: string; body?: unknown },
): Promise<unknown> {
  const response = await environment.fetch(url, {
    method: init.method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "explorer-verify-live-check",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      redact(
        `GitHub answered ${init.method} ${url} with ${String(response.status)}: ${body.slice(0, EXCERPT_LENGTH)}`,
        [token, ...secrets],
      ),
    );
  }
  return JSON.parse(body);
}

function issueOf(value: unknown, action: IssueAction["action"]): IssueAction {
  const number = field(value, "number");
  const url = field(value, "html_url");
  if (typeof number !== "number" || typeof url !== "string") {
    throw new TypeError("GitHub answered without an issue number and URL");
  }
  return { action, number, url };
}

/**
 * Opens the issue of a failed run, or comments on the open issue that {@link ISSUE_AUTHOR}
 * opened with {@link ISSUE_LABEL} and {@link ISSUE_TITLE}. An issue anyone else opened, or one
 * without the label, is never taken for it.
 * @param report The failed report.
 * @param environment Fetch and the environment variables GitHub Actions sets.
 * @param secrets Values removed from the text before it is posted.
 * @returns What it did.
 * @throws When a variable is missing or GitHub refuses a request.
 */
export async function fileIssue(
  report: Report,
  environment: Environment,
  secrets: readonly string[],
): Promise<IssueAction> {
  const { env } = environment;
  const token = env["GITHUB_TOKEN"];
  const repository = env["GITHUB_REPOSITORY"];
  if (token === undefined || token === "" || repository === undefined || repository === "") {
    throw new UsageError("--report needs GITHUB_TOKEN and GITHUB_REPOSITORY");
  }
  const api = (env["GITHUB_API_URL"] ?? "https://api.github.com").replace(/\/+$/, "");
  const server = env["GITHUB_SERVER_URL"];
  const runId = env["GITHUB_RUN_ID"];
  const runUrl =
    server === undefined || runId === undefined
      ? undefined
      : `${server}/${repository}/actions/runs/${runId}`;
  const body = redact(issueBody(report, runUrl), [token, ...secrets]);
  const base = `${api}/repos/${repository}`;
  const query = new URLSearchParams({ state: "open", labels: ISSUE_LABEL, creator: ISSUE_AUTHOR });
  for (let page = 1; page <= MAX_ISSUE_PAGES; page += 1) {
    const list = await github(
      environment,
      token,
      secrets,
      `${base}/issues?${query.toString()}&per_page=100&page=${String(page)}`,
      { method: "GET" },
    );
    const items: unknown[] = Array.isArray(list) ? list : [];
    const existing = items.find(
      (item) =>
        field(item, "title") === ISSUE_TITLE &&
        field(field(item, "user"), "login") === ISSUE_AUTHOR &&
        field(item, "pull_request") === undefined,
    );
    if (existing !== undefined) {
      const number = field(existing, "number");
      if (typeof number !== "number") {
        throw new TypeError("GitHub listed the open issue without a number");
      }
      const comment = await github(
        environment,
        token,
        secrets,
        `${base}/issues/${String(number)}/comments`,
        {
          method: "POST",
          body: { body },
        },
      );
      const url = field(comment, "html_url");
      return { action: "commented", number, url: typeof url === "string" ? url : "" };
    }
    if (items.length < 100) {
      break;
    }
  }
  const created = await github(environment, token, secrets, `${base}/issues`, {
    method: "POST",
    body: { title: ISSUE_TITLE, body, labels: [ISSUE_LABEL] },
  });
  return issueOf(created, "opened");
}

/**
 * Runs the script.
 * @param argv The arguments after the script's path.
 * @param environment Fetch, clock, wait and environment variables.
 * @returns The exit code and the text for stdout and stderr, every secret removed.
 */
export async function main(
  argv: readonly string[],
  environment: Environment,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let secrets: string[] = [];
  const clean = (value: string): string => redact(value, secrets);
  try {
    const args = parseArguments(argv);
    let source: string;
    try {
      source = readFileSync(args.targets, "utf8");
    } catch (error: unknown) {
      throw new UsageError(`cannot read ${args.targets}: ${errorMessage(error)}`);
    }
    const targets = readTargets(args.targets, source);
    secrets = secretsOf(targets, environment.env);
    const report = await runChecks(targets, args.backends, environment);
    let stderr = "";
    let code = report.ok ? 0 : 1;
    if (!report.ok && args.report) {
      try {
        report.issue = await fileIssue(report, environment, secrets);
      } catch (error: unknown) {
        stderr = `Could not file the issue: ${errorMessage(error)}\n`;
        code = 1;
      }
    }
    const json = clean(`${JSON.stringify(report, null, 2)}\n`);
    if (args.out !== undefined) {
      writeFileSync(args.out, json);
    }
    if (args.summary !== undefined) {
      appendFileSync(
        args.summary,
        clean(`## Live check, ${report.date}\n\n${table(report, false)}\n`),
      );
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

if (isMainModule(import.meta.url)) {
  const result = await main(process.argv.slice(2), {
    env: process.env,
    fetch: async (input, init) => await globalThis.fetch(input, init),
    now: () => Date.now(),
    wait: async (ms) => await new Promise((resolve) => setTimeout(resolve, ms)),
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
