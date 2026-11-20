// Tests of scripts/live-check.ts (R-QA-4, R-SEC-1). Every explorer and GitHub itself are a local
// fake: no test reaches the network. The fake echoes the key in its key errors, so a test can show
// that no key reaches the output, the issue or the summary.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { text as readText } from "node:stream/consumers";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parse } from "yaml";

import { codeCell } from "../github-issue.ts";
import {
  DEFAULT_TARGETS,
  ISSUE_AUTHOR,
  ISSUE_LABEL,
  ISSUE_TITLE,
  MAX_POLLS,
  MAX_RELEASE_PAGES,
  ORIGIN,
  POLL_INTERVAL_MS,
  checkVyperReleases,
  fileIssue,
  issueBody,
  main,
  parseArguments,
  readTargets,
  runChecks,
  secretsOf,
  table,
  UsageError,
} from "../live-check.ts";
import type { Environment, Report } from "../live-check.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(root, "scripts/live-check.ts");
const run = promisify(execFile);

// Dummy secrets, neither a real credential. The key is lower-case hex, so the library's pattern for
// a bare Etherscan key (34 upper-case letters and digits) does not match it: only the known-secret
// redaction removes it, and a test fails when the script's own redaction is gone.
const KEY = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const TOKEN = "ghs_dummyTokenForLiveCheckTests0001";
const KNOWN = "0x55863fd47cee89a0519985bb4ab3139de69853eb";
const NO_CODE = "0x000000000000000000000000000000000066e604";
// The Vyper target, whose resubmit starts a job that ends with already_verified.
const VYPER = "0xf3dc8196fd8dfdacc30040c47f383212c0581caa";
const VYPER_JOB = "32fb7b68-6554-4524-8d20-f43d0c3b5c75";
const REPO = "owner/repo";

/** What the fake does and what it saw. */
interface FakeState {
  /** Answer every Etherscan request with a key error that repeats the key. */
  echoKey: boolean;
  /** Send no CORS header. */
  noCors: boolean;
  /** Issues, by number. */
  issues: {
    number: number;
    title: string;
    body: string;
    labels: string[];
    author: string;
    comments: string[];
  }[];
  /** Extra open issues listed before the real ones, to fill pages. */
  filler: number;
  /** Origins the explorers saw. */
  origins: string[];
  /** Answer GitHub with this status. */
  githubStatus: number | undefined;
  /** Status requests of the Vyper job so far. */
  jobPolls: number;
  /** Keep the Vyper job pending on every poll. */
  jobNeverEnds: boolean;
}

const state: FakeState = {
  echoKey: false,
  noCors: false,
  issues: [],
  filler: 0,
  origins: [],
  githubStatus: undefined,
  jobPolls: 0,
  jobNeverEnds: false,
};

function reset(): void {
  state.echoKey = false;
  state.noCors = false;
  state.issues = [];
  state.filler = 0;
  state.origins = [];
  state.githubStatus = undefined;
  state.jobPolls = 0;
  state.jobNeverEnds = false;
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  return await readText(request);
}

/** A field of an object read from JSON or YAML, through any number of names. */
const get = (value: unknown, ...names: string[]): unknown =>
  names.reduce<unknown>(
    (current, name) =>
      typeof current === "object" && current !== null ? Reflect.get(current, name) : undefined,
    value,
  );

const keysOf = (value: unknown): string[] =>
  typeof value === "object" && value !== null ? Object.keys(value) : [];

function send(response: ServerResponse, status: number, body: unknown, cors = true): void {
  response.writeHead(status, {
    "content-type": "application/json",
    ...(cors && !state.noCors ? { "access-control-allow-origin": "*" } : {}),
  });
  response.end(JSON.stringify(body));
}

function etherscanAnswer(address: string | null): unknown {
  if (state.echoKey) {
    return {
      status: "0",
      message: "NOTOK",
      result: `Upstream error for ${KEY} at https://api.example.org/api?module=contract&apikey=${KEY}`,
    };
  }
  return {
    status: "1",
    message: "OK",
    result: [{ SourceCode: address === KNOWN ? "contract C {}" : "" }],
  };
}

async function github(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  if (request.headers.authorization !== `Bearer ${TOKEN}`) {
    send(response, 401, { message: "Bad credentials" }, false);
    return;
  }
  if (state.githubStatus !== undefined) {
    send(response, state.githubStatus, { message: `token ${TOKEN} refused for ${KEY}` }, false);
    return;
  }
  const base = `/github/repos/${REPO}/issues`;
  if (request.method === "GET" && url.pathname === base) {
    // As GitHub does: `labels` and `creator` filter on the server.
    const page = Number(url.searchParams.get("page"));
    const label = url.searchParams.get("labels");
    const creator = url.searchParams.get("creator");
    const filler = Array.from({ length: state.filler }, (_, index) => ({
      number: 1000 + index,
      title: `Other ${String(index)}`,
      labels: [ISSUE_LABEL],
      author: ISSUE_AUTHOR,
    }));
    const all = [
      { number: 999, title: ISSUE_TITLE, labels: [ISSUE_LABEL], author: ISSUE_AUTHOR, pr: true },
      ...filler,
      ...state.issues,
    ]
      .filter(
        (issue) =>
          (label === null || issue.labels.includes(label)) &&
          (creator === null || issue.author === creator),
      )
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        user: { login: issue.author },
        ...("pr" in issue ? { pull_request: { url: "x" } } : {}),
      }));
    send(response, 200, all.slice((page - 1) * 100, page * 100), false);
    return;
  }
  const parsed: unknown = JSON.parse(await bodyOf(request));
  const read = (name: string): unknown =>
    typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, name) : undefined;
  if (request.method === "POST" && url.pathname === base) {
    const number = state.issues.length + 1;
    const labels = read("labels");
    state.issues.push({
      number,
      title: String(read("title")),
      body: String(read("body")),
      labels: Array.isArray(labels) ? labels.map(String) : [],
      author: ISSUE_AUTHOR,
      comments: [],
    });
    send(
      response,
      201,
      { number, html_url: `https://github.test/issues/${String(number)}` },
      false,
    );
    return;
  }
  const comment = /^\/github\/repos\/owner\/repo\/issues\/(\d+)\/comments$/.exec(url.pathname);
  const issue = state.issues.find((one) => one.number === Number(comment?.[1]));
  if (request.method === "POST" && issue !== undefined) {
    issue.comments.push(String(read("body")));
    send(
      response,
      201,
      { html_url: `https://github.test/issues/${String(issue.number)}#c` },
      false,
    );
    return;
  }
  send(response, 404, { message: "Not Found" }, false);
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const origin = request.headers.origin;
  if (typeof origin === "string") {
    state.origins.push(origin);
  }
  const parts = url.pathname.split("/");
  if (parts[1] === "github") {
    await github(request, response, url);
    return;
  }
  if (parts[1] === "sourcify" && parts[3] === "contract") {
    const address = parts[5] ?? "";
    const known = address === KNOWN || address === VYPER;
    send(response, known ? 200 : 404, {
      match: known ? "exact_match" : null,
      chainId: parts[4],
      address,
    });
    return;
  }
  if (parts[1] === "sourcify" && parts[3] === "verify" && request.method === "POST") {
    await bodyOf(request);
    if (parts[5] === VYPER) {
      send(response, 202, { verificationId: VYPER_JOB });
      return;
    }
    send(response, 409, { customCode: "already_verified", message: "Already verified" });
    return;
  }
  if (parts[1] === "sourcify" && parts[3] === "verify" && parts[4] === VYPER_JOB) {
    state.jobPolls += 1;
    const done = !state.jobNeverEnds && state.jobPolls > 1;
    const contract = { match: null, chainId: "11155111", address: VYPER };
    send(response, 200, {
      isJobCompleted: done,
      verificationId: VYPER_JOB,
      contract,
      ...(done
        ? {
            error: {
              customCode: "already_verified",
              message: "The contract is already verified and the job didn't yield a better match.",
            },
          }
        : {}),
    });
    return;
  }
  if (parts[1] === "etherscan") {
    const form = new URLSearchParams(await bodyOf(request));
    if (form.get("apikey") !== KEY) {
      send(response, 200, { status: "0", message: "NOTOK", result: "Missing/Invalid API Key" });
      return;
    }
    send(response, 200, etherscanAnswer(form.get("address")));
    return;
  }
  if (parts[1] === "routescan") {
    send(response, 200, etherscanAnswer(url.searchParams.get("address")));
    return;
  }
  if (parts[1] === "blockscout") {
    const address = parts[5] ?? "";
    if (address === KNOWN) {
      send(response, 200, { is_verified: true, is_fully_verified: true });
    } else {
      send(response, 404, { message: "Not found" });
    }
    return;
  }
  send(response, 500, { message: "no route" });
}

let server: Server;
let base: string;
let directory: string;
let targetsFile: string;

function targetsText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    noCodeAddress: NO_CODE,
    minIntervalMs: { routescan: 600 },
    targets: [
      {
        label: "Src",
        backend: "sourcify",
        chainId: 11155111,
        address: KNOWN,
        match: "exact",
        apiUrl: `${base}/sourcify`,
        cors: true,
        submitInput: "input.json",
      },
      {
        label: "Eth",
        backend: "etherscan-v2",
        chainId: 11155111,
        address: KNOWN,
        match: "exact",
        apiUrl: `${base}/etherscan/api`,
        keyEnv: "LIVE_TEST_KEY",
      },
      {
        label: "Rs",
        backend: "routescan",
        chainId: 43113,
        address: KNOWN,
        match: "partial",
        apiUrl: `${base}/routescan/api`,
        cors: true,
      },
      {
        label: "Bs",
        backend: "blockscout",
        chainId: 11155111,
        address: KNOWN,
        match: "exact",
        apiUrl: `${base}/blockscout/api`,
        cors: true,
      },
    ],
    ...overrides,
  });
}

function environment(env: Record<string, string | undefined> = {}): Environment & {
  waits: number[];
} {
  const waits: number[] = [];
  return {
    env: {
      LIVE_TEST_KEY: KEY,
      GITHUB_TOKEN: TOKEN,
      GITHUB_REPOSITORY: REPO,
      GITHUB_API_URL: `${base}/github/`,
      ...env,
    },
    fetch: async (input, init) => await globalThis.fetch(input, init),
    now: () => 1_700_000_000_000,
    wait: async (ms) => {
      waits.push(ms);
      await Promise.resolve();
    },
    waits,
  };
}

before(async () => {
  server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  base = `http://127.0.0.1:${String(address.port)}`;
  directory = mkdtempSync(path.join(tmpdir(), "live-check-"));
  targetsFile = path.join(directory, "targets.json");
  writeFileSync(
    path.join(directory, "input.json"),
    readFileSync(path.join(root, "test/live/sourcify-sepolia-input.json"), "utf8"),
  );
  writeFileSync(
    path.join(directory, "vyper-input.json"),
    readFileSync(path.join(root, "test/live/sourcify-sepolia-vyper-input.json"), "utf8"),
  );
});

after(async () => {
  rmSync(directory, { recursive: true, force: true });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  reset();
  writeFileSync(targetsFile, targetsText());
});

describe("live-check: the checks (R-QA-4)", () => {
  it("passes every check against explorers that answer as recorded", async () => {
    const env = environment();
    const result = await main(["--targets", targetsFile, "--report"], env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    const report: unknown = JSON.parse(result.stdout);
    assert.equal(Reflect.get(Object(report), "ok"), true);
    assert.equal(Reflect.get(Object(report), "date"), "2023-11-14T22:13:20.000Z");
    assert.equal(state.issues.length, 0, "a passing run files no issue");
    const text = result.stdout;
    for (const check of ["lookup", "no-code", "cors", "submit"]) {
      assert.ok(text.includes(`"check": "${check}"`), check);
    }
    assert.ok(state.origins.every((origin) => origin === ORIGIN));
    assert.ok(state.origins.length >= 9);
    // Routescan's second request waited for the 600 ms spacing; the clock does not move.
    assert.deepEqual(env.waits, [600]);
  });

  it("fails a check whose recorded match differs, and the CORS check without the header", async () => {
    writeFileSync(
      targetsFile,
      targetsText({
        targets: [
          {
            label: "Src",
            backend: "sourcify",
            chainId: 11155111,
            address: KNOWN,
            match: "partial",
            apiUrl: `${base}/sourcify`,
            cors: true,
          },
        ],
      }),
    );
    state.noCors = true;
    const result = await main(["--targets", targetsFile], environment());
    assert.equal(result.code, 1);
    assert.match(result.stdout, /"expected": "partial",\s+"actual": "exact"/);
    assert.match(
      result.stdout,
      /"check": "cors",[^}]*"ok": false,\s+"expected": "\*",\s+"actual": "no header"/,
    );
    assert.equal(state.issues.length, 0, "without --report no issue is filed");
  });

  it("reports a CORS check with no GET answer, a missing key and a submit file that cannot be read", async () => {
    writeFileSync(
      targetsFile,
      targetsText({
        targets: [
          {
            label: "Eth",
            backend: "etherscan-v2",
            chainId: 11155111,
            address: KNOWN,
            match: "exact",
            apiUrl: `${base}/etherscan/api`,
            keyEnv: "LIVE_TEST_KEY",
            cors: true,
            submitInput: "missing.json",
          },
          {
            label: "Eth2",
            backend: "etherscan-v2",
            chainId: 421614,
            address: KNOWN,
            match: "exact",
            keyEnv: "LIVE_UNSET_KEY",
          },
        ],
      }),
    );
    const result = await main(["--targets", targetsFile], environment());
    assert.equal(result.code, 1);
    assert.match(result.stdout, /"actual": "no GET answer"/);
    assert.match(result.stdout, /"actual": "no key: LIVE_UNSET_KEY is not set"/);
    assert.match(result.stdout, /"check": "submit",[^}]*"actual": "threw",\s+"excerpt": "ENOENT/);
  });

  it("polls the job a Vyper resubmit starts, and passes when it ends with already_verified", async () => {
    const vyper = {
      label: "SrcVy",
      backend: "sourcify",
      chainId: 11155111,
      address: VYPER,
      match: "exact",
      apiUrl: `${base}/sourcify`,
      submitInput: "vyper-input.json",
    };
    writeFileSync(targetsFile, targetsText({ targets: [vyper] }));
    const env = environment();
    const result = await main(["--targets", targetsFile], env);
    assert.equal(result.code, 0, result.stdout);
    assert.match(
      result.stdout,
      /"check": "submit",[^}]*"ok": true,\s+"expected": "already-verified",\s+"actual": "already-verified"/,
    );
    assert.equal(state.jobPolls, 2);
    assert.deepEqual(env.waits, [POLL_INTERVAL_MS, POLL_INTERVAL_MS]);

    reset();
    state.jobNeverEnds = true;
    const pending = await main(["--targets", targetsFile], environment());
    assert.equal(pending.code, 1);
    assert.match(pending.stdout, /"check": "submit",[^}]*"ok": false,[^}]*"actual": "pending"/);
    assert.equal(state.jobPolls, MAX_POLLS);
  });

  it("checks only the backends --backends names, and fails a run that checked nothing", async () => {
    const one = await main(["--targets", targetsFile, "--backends", "blockscout"], environment());
    assert.equal(one.code, 0, one.stderr);
    const parsed: unknown = JSON.parse(one.stdout);
    assert.deepEqual(keysOf(get(parsed, "backends")), ["blockscout"]);
    const none = await main(
      ["--targets", targetsFile, "--backends", "etherscan-compatible"],
      environment(),
    );
    assert.equal(none.code, 1);
  });

  it("uses the routing table's API URL and passes the key in apiKeys when a target has no apiUrl", async () => {
    const seen: string[] = [];
    const env = environment();
    const report = await runChecks(
      readTargets(
        targetsFile,
        targetsText({
          targets: [
            {
              label: "E",
              backend: "etherscan-v2",
              chainId: 11155111,
              address: KNOWN,
              match: "exact",
              keyEnv: "LIVE_TEST_KEY",
            },
          ],
        }),
      ),
      undefined,
      {
        ...env,
        fetch: async (input, init) => {
          seen.push(
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          );
          const body = init?.body;
          assert.ok(
            (typeof body === "string" || body instanceof URLSearchParams) &&
              body.toString().includes(`apikey=${KEY}`),
          );
          return Response.json({ status: "1", message: "OK", result: [{ SourceCode: "" }] });
        },
      },
    );
    assert.ok(
      seen.every((url) => url.startsWith("https://api.etherscan.io/v2/api?chainid=11155111")),
    );
    assert.equal(report.ok, false, "the known contract answered not verified");
  });
});

describe("live-check: keys stay out of the output (R-SEC-1)", () => {
  it("prints no key or token from the command line, the issue or the summary, and redacts apikey=", async () => {
    state.echoKey = true;
    const summary = path.join(directory, "summary.md");
    const out = path.join(directory, "out.json");
    let stdout = "";
    let stderr = "";
    let code: number | undefined;
    try {
      const result = await run(
        process.execPath,
        [SCRIPT, "--targets", targetsFile, "--report", "--summary", summary, "--out", out],
        {
          env: {
            LIVE_TEST_KEY: KEY,
            GITHUB_TOKEN: TOKEN,
            GITHUB_REPOSITORY: REPO,
            GITHUB_API_URL: `${base}/github`,
            GITHUB_SERVER_URL: "https://github.test",
            GITHUB_RUN_ID: "42",
          },
        },
      );
      ({ stdout, stderr } = result);
      code = 0;
    } catch (error: unknown) {
      stdout = String(Reflect.get(Object(error), "stdout"));
      stderr = String(Reflect.get(Object(error), "stderr"));
      code = Number(Reflect.get(Object(error), "code"));
    }
    assert.equal(code, 1, stderr);
    assert.equal(state.issues.length, 1, "the failed run opened one issue");
    const [issue] = state.issues;
    assert.ok(issue !== undefined);
    assert.equal(issue.title, ISSUE_TITLE);
    assert.deepEqual(issue.labels, [ISSUE_LABEL]);
    assert.match(issue.body, /Run: https:\/\/github\.test\/owner\/repo\/actions\/runs\/42/);
    assert.match(issue.body, /\| etherscan-v2 \| 11155111 \| Eth \| lookup \| \*\*failed\*\*/);
    const outputs = [
      stdout,
      stderr,
      issue.body,
      readFileSync(summary, "utf8"),
      readFileSync(out, "utf8"),
    ];
    for (const output of outputs) {
      assert.ok(!output.includes(KEY), "the key must not appear in any output");
      assert.ok(!output.includes(TOKEN), "the token must not appear in any output");
    }
    assert.match(stdout, /apikey=\[redacted\]/);
    assert.match(stdout, /"issue": \{\s+"action": "opened",\s+"number": 1/);
  });

  it("comments on the open issue on a second failed run instead of opening another", async () => {
    state.echoKey = true;
    const first = await main(["--targets", targetsFile, "--report"], environment());
    assert.equal(first.code, 1);
    const second = await main(["--targets", targetsFile, "--report"], environment());
    assert.equal(second.code, 1);
    assert.equal(state.issues.length, 1);
    assert.equal(state.issues[0]?.comments.length, 1);
    assert.equal(state.issues[0]?.comments[0]?.includes(KEY), false);
    assert.match(second.stdout, /"action": "commented"/);
  });

  it("finds the open issue past the first page of 100", async () => {
    state.echoKey = true;
    await main(["--targets", targetsFile, "--report"], environment());
    state.filler = 150;
    const second = await main(["--targets", targetsFile, "--report"], environment());
    assert.match(second.stdout, /"action": "commented",\s+"number": 1,/);
  });

  it("fails without leaking the token when GitHub refuses or the variables are missing", async () => {
    state.echoKey = true;
    state.githubStatus = 403;
    const refused = await main(["--targets", targetsFile, "--report"], environment());
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /^Could not file the issue: GitHub answered GET .* with 403/);
    // The refusal repeats the token and the explorer key; neither reaches stderr.
    assert.ok(!refused.stderr.includes(TOKEN));
    assert.ok(!refused.stderr.includes(KEY));
    state.githubStatus = undefined;
    const missing = await main(
      ["--targets", targetsFile, "--report"],
      environment({ GITHUB_TOKEN: undefined, GITHUB_REPOSITORY: "" }),
    );
    assert.match(missing.stderr, /--report needs GITHUB_TOKEN and GITHUB_REPOSITORY/);
  });

  it("rejects a GitHub answer without an issue number", async () => {
    const report: Report = { schemaVersion: 1, date: "d", ok: false, backends: {} };
    const env = environment();
    const bot = { login: ISSUE_AUTHOR };
    const answers: unknown[] = [[{ number: "x", title: ISSUE_TITLE, user: bot }]];
    const fake: typeof fetch = async () =>
      await Promise.resolve(Response.json(answers.shift() ?? {}));
    await assert.rejects(
      fileIssue(report, { ...env, fetch: fake }, []),
      /listed the open issue without a number/,
    );
    answers.push([], { title: "no number" });
    await assert.rejects(
      fileIssue(report, { ...env, fetch: fake }, []),
      /without an issue number and URL/,
    );
    answers.push([{ number: 7, title: ISSUE_TITLE, user: bot }], {});
    assert.deepEqual(await fileIssue(report, { ...env, fetch: fake }, []), {
      action: "commented",
      number: 7,
      url: "",
    });
    answers.push({ not: "a list" }, { number: 8, html_url: "u" });
    assert.deepEqual(await fileIssue(report, { ...env, fetch: fake }, []), {
      action: "opened",
      number: 8,
      url: "u",
    });
  });

  it("never takes an issue someone else opened for the open report", async () => {
    state.echoKey = true;
    state.issues.push({
      number: 1,
      title: ISSUE_TITLE,
      body: "",
      labels: [ISSUE_LABEL],
      author: "someone",
      comments: [],
    });
    const result = await main(["--targets", targetsFile, "--report"], environment());
    assert.match(result.stdout, /"action": "opened",\s+"number": 2,/);
    assert.equal(state.issues[0]?.comments.length, 0);
  });

  it("removes a key that reaches the script outside the library's errors (R-SEC-1)", async () => {
    // A file name that holds the key stands in for any error the library does not build: the
    // ENOENT message repeats the path, and only the script's own redaction removes the key.
    writeFileSync(
      targetsFile,
      targetsText({
        targets: [
          {
            label: "Src",
            backend: "sourcify",
            chainId: 11155111,
            address: KNOWN,
            match: "exact",
            apiUrl: `${base}/sourcify`,
            submitInput: `missing-${KEY}.json`,
          },
          // Not run (--backends), but it names the key, so the key is a secret of the run.
          {
            label: "Eth",
            backend: "etherscan-v2",
            chainId: 11155111,
            address: KNOWN,
            match: "exact",
            keyEnv: "LIVE_TEST_KEY",
          },
        ],
      }),
    );
    const summary = path.join(directory, "plain-summary.md");
    const result = await main(
      ["--targets", targetsFile, "--backends", "sourcify", "--report", "--summary", summary],
      environment(),
    );
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stdout, /ENOENT[^"]*missing-\[redacted\]\.json/);
    const outputs = [result.stdout, result.stderr, readFileSync(summary, "utf8")];
    outputs.push(...state.issues.map((issue) => issue.body));
    assert.equal(state.issues.length, 1);
    for (const output of outputs) {
      assert.ok(!output.includes(KEY), "the key must not appear in any output");
    }
  });

  it("lists every key a target names and the token as secrets", () => {
    const targets = readTargets(targetsFile, targetsText());
    assert.deepEqual(secretsOf(targets, { LIVE_TEST_KEY: KEY, GITHUB_TOKEN: TOKEN }), [KEY, TOKEN]);
    assert.deepEqual(secretsOf(targets, { LIVE_TEST_KEY: "" }), []);
  });
});

describe("live-check: the command line and the targets file", () => {
  it("reads the flags", () => {
    assert.deepEqual(parseArguments([]), {
      targets: DEFAULT_TARGETS,
      backends: undefined,
      report: false,
      out: undefined,
      summary: undefined,
    });
    assert.deepEqual(
      parseArguments([
        "--report",
        "--backends",
        "sourcify, routescan",
        "--out",
        "o",
        "--summary",
        "s",
      ]),
      {
        targets: DEFAULT_TARGETS,
        backends: ["sourcify", "routescan"],
        report: true,
        out: "o",
        summary: "s",
      },
    );
    assert.throws(() => parseArguments(["--out"]), /--out needs a value/);
    assert.throws(() => parseArguments(["--out", "--report"]), /--out needs a value/);
    assert.throws(() => parseArguments(["--what", "x"]), /unknown flag --what/);
    assert.throws(() => parseArguments(["--backends", "nope"]), /--backends must name a backend/);
  });

  it("exits 2 for a wrong command line, a missing file or a wrong targets file", async () => {
    const env = environment();
    assert.equal((await main(["--nope", "x"], env)).code, 2);
    const missing = await main(["--targets", path.join(directory, "none.json")], env);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /^cannot read /);
    writeFileSync(targetsFile, "{");
    assert.match((await main(["--targets", targetsFile], env)).stderr, /not JSON/);
  });

  it("names the wrong field of a targets file", () => {
    const target = { label: "L", backend: "sourcify", chainId: 1, address: KNOWN, match: "exact" };
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ targets: [] }, /targets must be a non-empty array/],
      [{ minIntervalMs: [] }, /minIntervalMs must be an object/],
      [{ minIntervalMs: { sourcify: -1 } }, /minIntervalMs.sourcify must be a number of 0 or more/],
      [{ minIntervalMs: { nope: 1 } }, /minIntervalMs must name a backend/],
      [{ noCodeAddress: "0x12" }, /noCodeAddress must be a 0x address/],
      [
        { targets: [{ ...target, chainId: 0 }] },
        /targets\[0\]\.chainId must be a positive integer/,
      ],
      [
        { targets: [{ ...target, match: "full" }] },
        /targets\[0\]\.match must be "exact" or "partial"/,
      ],
      [{ targets: [{ ...target, cors: "yes" }] }, /targets\[0\]\.cors must be a boolean/],
      [{ targets: [{ ...target, label: "" }] }, /targets\[0\]\.label must be a non-empty string/],
      [{ targets: [{ ...target, apiUrl: 1 }] }, /targets\[0\]\.apiUrl must be a non-empty string/],
    ];
    for (const [overrides, message] of cases) {
      assert.throws(
        () => readTargets("t.json", targetsText(overrides)),
        (error: unknown) => {
          assert.ok(error instanceof UsageError);
          assert.match(error.message, message);
          return true;
        },
      );
    }
    const defaults = readTargets(
      "t.json",
      JSON.stringify({ noCodeAddress: NO_CODE, targets: [target] }),
    );
    assert.deepEqual(defaults.minIntervalMs, {});
    assert.equal(defaults.targets[0]?.cors, false);
  });

  it("checks the shipped targets file", () => {
    const targets = readTargets(DEFAULT_TARGETS, readFileSync(DEFAULT_TARGETS, "utf8"));
    const backends = new Set<string>(targets.targets.map((target) => target.backend));
    for (const backend of ["sourcify", "etherscan-v2", "routescan", "blockscout"]) {
      assert.ok(backends.has(backend), `${backend} has a target`);
    }
    // R-QA-4: one keyless submit on Sourcify, and a CORS check on each keyless backend.
    assert.deepEqual(
      targets.targets
        .filter((target) => target.submitInput !== undefined)
        .map((target) => target.backend),
      ["sourcify", "sourcify"],
    );
    assert.deepEqual(
      [
        ...new Set(targets.targets.filter((target) => target.cors).map((target) => target.backend)),
      ].toSorted(),
      ["blockscout", "routescan", "sourcify"],
    );
    for (const target of targets.targets) {
      assert.equal(target.keyEnv === undefined, target.backend !== "etherscan-v2", target.label);
    }
  });

  it("shows explorer text in code spans, so nothing in it renders or notifies", () => {
    const hostile = "@someone <img src=x> #1 <!-- `a` ``b``\rnext\r\nlast";
    const cell = codeCell(hostile);
    assert.equal(cell, "``` @someone <img src=x> #1 <!-- `a` ``b`` next last ```");
    assert.equal(codeCell("plain"), "` plain `");
    assert.equal(codeCell(" \r\n"), "");
    const report: Report = {
      schemaVersion: 1,
      date: "2026-11-05T00:00:00.000Z",
      ok: false,
      backends: {
        routescan: {
          ok: false,
          checks: [
            {
              backend: "routescan",
              chainId: 43113,
              label: "Rs",
              check: "cors",
              address: KNOWN,
              ok: false,
              expected: "*",
              actual: "@other",
              excerpt: hostile,
            },
          ],
        },
      },
    };
    const body = issueBody(report, "https://github.test/run");
    assert.ok(!body.includes("\r"));
    // Outside the code spans, no mention, HTML, comment or issue reference is left.
    const outside = body.replaceAll(/(`+) [^`]*?(?:`(?!\1)[^`]*?)* \1/g, "");
    assert.doesNotMatch(outside, /@|<|#\d/);
    assert.ok(body.includes(cell));
  });

  it("escapes table cells and names the failed backends in the issue", () => {
    const report: Report = {
      schemaVersion: 1,
      date: "2026-11-05T00:00:00.000Z",
      ok: false,
      backends: {
        sourcify: {
          ok: false,
          checks: [
            {
              backend: "sourcify",
              chainId: 1,
              label: "L",
              check: "lookup",
              address: KNOWN,
              ok: false,
              expected: "exact",
              actual: "threw network",
              excerpt: "a | b\nc",
            },
          ],
        },
        routescan: { ok: true, checks: [] },
      },
    };
    assert.match(table(report, true), /\| ` a \\\| b c ` \|$/);
    const body = issueBody(report, undefined);
    assert.match(body, /failed on `sourcify`\./);
    assert.ok(!body.includes("Run:"));
    assert.match(issueBody({ ...report, backends: {} }, undefined), /failed on no backend\./);
  });
});

describe("live-check: the workflow (R-QA-4)", () => {
  const workflow: unknown = parse(
    readFileSync(path.join(root, ".github/workflows/live.yml"), "utf8"),
  );
  it("starts only on a schedule or a dispatch, never on a pull request or a push", () => {
    assert.deepEqual(keysOf(get(workflow, "on")).toSorted(), ["schedule", "workflow_dispatch"]);
  });

  it("runs every job only in this repository, in the live environment, with read and issue permissions", () => {
    const jobs = keysOf(get(workflow, "jobs")).map((name) => get(workflow, "jobs", name));
    assert.ok(jobs.length > 0);
    assert.deepEqual(get(workflow, "permissions"), { contents: "read" });
    for (const job of jobs) {
      assert.equal(get(job, "if"), "github.repository == 'aelmanaa/explorer-verify'");
      assert.equal(get(job, "environment"), "live");
      assert.deepEqual(get(job, "permissions"), { contents: "read", issues: "write" });
      const steps = get(job, "steps");
      assert.ok(Array.isArray(steps));
      const runs = steps
        .map((step) => {
          const command = get(step, "run");
          return typeof command === "string" ? command : "";
        })
        .join("\n");
      assert.match(runs, /pnpm install --frozen-lockfile --ignore-scripts/);
      assert.match(runs, /node scripts\/live-check\.ts --report/);
      for (const step of steps) {
        const uses = get(step, "uses");
        if (typeof uses === "string") {
          assert.match(uses, /@[0-9a-f]{40}$/, `${uses} is pinned to a commit`);
        }
      }
      const setupNode: unknown = steps.find(
        (step) =>
          typeof get(step, "uses") === "string" &&
          String(get(step, "uses")).startsWith("actions/setup-node"),
      );
      assert.equal(get(setupNode, "with", "cache"), undefined, "no dependency cache");
      assert.equal(
        get(
          steps.find(
            (step) =>
              typeof get(step, "uses") === "string" &&
              String(get(step, "uses")).startsWith("actions/setup-node"),
          ),
          "with",
          "node-version",
        ),
        24,
      );
    }
  });
});

/** A Vyper release as the GitHub API lists it, with the three assets of each build. */
function release(tag: string, commit: string, extra: Record<string, unknown> = {}): unknown {
  const version = tag.slice(1);
  return {
    tag_name: tag,
    prerelease: false,
    draft: false,
    assets: ["darwin", "linux", "windows.exe"].map((os) => ({
      name: `vyper.${version}+commit.${commit}.${os}`,
    })),
    ...extra,
  };
}

/** The URL a fetch call asks for. */
function urlOf(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

describe("live-check: the Vyper release table (R-IN-7, decisions 0075 and 0076)", () => {
  const URL_BASE = "https://releases.test/repos/vyperlang/vyper/releases";

  const RELEASED = [
    release("v0.5.0b2", "e1557a51", { prerelease: true }),
    release("v0.4.3", "bff19ea2"),
    release("v0.4.2", "c216787f"),
    release("v0.4.1", "8a93dd27"),
    release("v0.4.0", "e9db8d9f"),
    release("v0.3.10", "91361694"),
    release("v0.3.9", "66b96705"),
  ];

  /** An environment whose fetch answers each releases page from `pages`, and records the requests. */
  function releasesEnvironment(
    pages: readonly (readonly unknown[] | Response)[],
    env: Record<string, string | undefined> = {},
  ): Environment & { requests: { url: string; authorization: string | null }[] } {
    const requests: { url: string; authorization: string | null }[] = [];
    return {
      ...environment(env),
      requests,
      fetch: async (input, init) => {
        const url = urlOf(input);
        if (!url.startsWith(URL_BASE)) {
          return await globalThis.fetch(input, init);
        }
        requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
        const page = Number(new URL(url).searchParams.get("page"));
        const answer = pages[page - 1] ?? [];
        return answer instanceof Response ? answer : Response.json(answer);
      },
    };
  }

  it("passes when each listed version names its release assets' commit", async () => {
    const env = releasesEnvironment([RELEASED]);
    const checks = await checkVyperReleases(URL_BASE, env, []);
    assert.deepEqual(
      checks.map((one) => [one.version, one.ok, one.actual]),
      [
        ["0.3.10", true, "91361694"],
        ["0.4.0", true, "e9db8d9f"],
        ["0.4.1", true, "8a93dd27"],
        ["0.4.2", true, "c216787f"],
        ["0.4.3", true, "bff19ea2"],
      ],
    );
    assert.deepEqual(env.requests, [
      { url: `${URL_BASE}?per_page=100&page=1`, authorization: `Bearer ${TOKEN}` },
    ]);
  });

  it("asks without a token when none is set, and reads the next page after a full one", async () => {
    const filler = Array.from({ length: 98 }, (_, index) =>
      release(`v0.2.${String(index)}`, "00000000"),
    );
    const first = [...filler, RELEASED[0], RELEASED[1]];
    const env = releasesEnvironment([first, RELEASED.slice(2)], { GITHUB_TOKEN: "" });
    const checks = await checkVyperReleases(URL_BASE, env, []);
    assert.ok(checks.every((one) => one.ok));
    assert.deepEqual(
      env.requests.map((one) => one.authorization),
      [null, null],
    );
    assert.equal(env.requests[1]?.url, `${URL_BASE}?per_page=100&page=2`);
    const unset = releasesEnvironment([RELEASED], { GITHUB_TOKEN: undefined });
    await checkVyperReleases(URL_BASE, unset, []);
    assert.equal(unset.requests[0]?.authorization, null);
  });

  it("fails a changed commit, a missing release, a release without assets and a release the table lacks", async () => {
    const pages = [
      [
        release("v0.4.4", "12345678"),
        release("v0.4.3", "0badc0de"),
        release("v0.4.2", "c216787f", { assets: [{ name: "vyper.0.4.20+commit.c216787f.linux" }] }),
        release("v0.4.1", "8a93dd27", { draft: true }),
        release("v0.4.0", "e9db8d9f"),
        release("v0.3.10", "91361694"),
        { tag_name: 7 },
        { tag_name: "latest" },
        release("v1.0.0", "abcdef01", { assets: "none" }),
      ],
    ];
    const checks = await checkVyperReleases(URL_BASE, releasesEnvironment(pages), []);
    assert.deepEqual(
      checks.filter((one) => !one.ok).map((one) => [one.version, one.expected, one.actual]),
      [
        ["0.4.1", "8a93dd27", "no release"],
        ["0.4.2", "c216787f", "no asset"],
        ["0.4.3", "bff19ea2", "0badc0de"],
        ["0.4.4", "listed", "not listed"],
        ["1.0.0", "listed", "not listed"],
      ],
    );
  });

  it("reports one failed check, keys removed, when GitHub refuses or answers no list", async () => {
    const refused = await checkVyperReleases(
      URL_BASE,
      releasesEnvironment([new Response(`rate limited for ${TOKEN}`, { status: 403 })]),
      [TOKEN],
    );
    assert.equal(refused.length, 1);
    assert.equal(refused[0]?.ok, false);
    assert.equal(refused[0]?.version, "all");
    assert.equal(refused[0]?.actual, "threw");
    assert.match(refused[0]?.excerpt ?? "", /GitHub answered 403/);
    assert.ok(!(refused[0]?.excerpt ?? "").includes(TOKEN));
    const notList = await checkVyperReleases(
      URL_BASE,
      releasesEnvironment([Response.json({ message: "x" })]),
      [],
    );
    assert.match(notList[0]?.excerpt ?? "", /without a list of releases/);
  });

  it("stops after the last page it may read", async () => {
    const full = Array.from({ length: 100 }, () => release("v0.2.0", "00000000"));
    const env = releasesEnvironment(Array.from({ length: MAX_RELEASE_PAGES + 2 }, () => full));
    await checkVyperReleases(URL_BASE, env, []);
    assert.equal(env.requests.length, MAX_RELEASE_PAGES);
  });

  it("runs only when the targets file names vyperReleases and --backends is absent, and fails the run", async () => {
    const env = releasesEnvironment([[release("v0.4.3", "0badc0de")]]);
    const targets = readTargets(
      targetsFile,
      targetsText({
        vyperReleases: URL_BASE,
        targets: [
          {
            label: "Bs",
            backend: "blockscout",
            chainId: 11155111,
            address: KNOWN,
            match: "exact",
            apiUrl: `${base}/blockscout/api`,
          },
        ],
      }),
    );
    assert.equal(targets.vyperReleases, URL_BASE);
    const all = await runChecks(targets, undefined, env);
    assert.equal(all.ok, false);
    assert.equal(all.backends.blockscout?.ok, true);
    assert.equal(all.vyperReleases?.ok, false);
    const rows = table(all, true);
    assert.ok(
      rows.includes(
        `| vyper | - | ${codeCell("0.4.3")} | release | **failed** | ${codeCell("bff19ea2")} | ${codeCell("0badc0de")} |  |`,
      ),
    );
    assert.ok(!rows.includes("| blockscout |"));
    assert.match(table(all, false), /\| blockscout \|/);
    assert.match(issueBody(all, undefined), /failed on the Vyper release table\./);
    const filtered = await runChecks(targets, ["blockscout"], env);
    assert.equal(filtered.vyperReleases, undefined);
    assert.equal(filtered.ok, true);
    assert.equal(env.requests.length, 1);
    const passing = await runChecks(targets, undefined, releasesEnvironment([RELEASED]));
    assert.equal(passing.ok, true);
    assert.ok(
      table(passing, false).includes(`| vyper | - | ${codeCell("0.3.10")} | release | ok |`),
    );
    assert.equal(table(passing, true).split("\n").length, 2);
  });

  it("names a vyperReleases that is not a non-empty string", () => {
    assert.throws(
      () => readTargets("t.json", targetsText({ vyperReleases: 1 })),
      /t\.json: vyperReleases must be a non-empty string/,
    );
  });

  it("reads the GitHub releases API of Vyper from the default targets file", () => {
    const targets = readTargets(DEFAULT_TARGETS, readFileSync(DEFAULT_TARGETS, "utf8"));
    assert.equal(targets.vyperReleases, "https://api.github.com/repos/vyperlang/vyper/releases");
  });
});
