// Tests of the weekly Blockscout deprecation watch (#198). A fake fetch stands in for every
// Blockscout instance, the docs site and GitHub: no test reaches the network. The token is a
// dummy, and the clock and the wait between requests are fakes, so no test waits.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DOCS_FILE,
  DOWN_THRESHOLD,
  HOSTED_SUFFIX,
  LABELS,
  MARKER,
  MAX_ROWS,
  MIN_INTERVAL_MS,
  PROBE_PATH,
  TABLE_FILE,
  TITLE,
  UsageError,
  checkDocs,
  checkInstance,
  closingComment,
  issueBody,
  main,
  nodeEnvironment,
  normalise,
  parseArguments,
  parseDocsFile,
  runWatch,
  sampleInstances,
  sectionOf,
  sha256,
  signalTable,
} from "../blockscout-deprecation.ts";
import type { Environment, Report, Signal, WatchedSection } from "../blockscout-deprecation.ts";
import { BOT } from "../github-issue.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(root, "scripts/blockscout-deprecation.ts");
const TOKEN = "ghs_dummyTokenForDeprecationWatch0001";
const REPO = "owner/repo";
const readJson = (file: string): unknown => JSON.parse(readFileSync(path.join(root, file), "utf8"));
const SECTIONS = parseDocsFile(readJson(DOCS_FILE));
const INSTANCES = sampleInstances(readJson(TABLE_FILE));

/** A Markdown page that holds `section` among other text. */
function page(section: WatchedSection, extra = "", text = section.text): string {
  return [
    "# Blockscout APIs",
    "",
    `> Overview ${extra}`,
    "",
    section.heading,
    "",
    text,
    "",
    "## Another heading",
    "",
    `Other text ${extra}`,
  ].join("\n");
}

/** What the fake answers: per instance host, and per docs URL. */
interface Fake {
  instance: (host: string) => Response;
  docs: (section: WatchedSection) => Response;
  issues: { number: number; body: string; state: string; title: string; labels: unknown }[];
  requests: string[];
}

const blockNumber = (): Response => Response.json({ jsonrpc: "2.0", result: "0x1921231", id: 1 });

function fake(overrides: Partial<Pick<Fake, "instance" | "docs">> = {}): Fake {
  return {
    instance: overrides.instance ?? blockNumber,
    docs:
      overrides.docs ??
      ((section) => new Response(page(section), { headers: { "content-type": "text/markdown" } })),
    issues: [],
    requests: [],
  };
}

/** A fetch that routes each request to the fake instance, docs page or GitHub. */
function fetchOf(state: Fake): typeof fetch {
  return async (input, init) => {
    const url = new URL(urlOf(input));
    const method = init?.method ?? "GET";
    state.requests.push(`${method} ${url.href}`);
    assert.equal(init?.redirect ?? "manual", "manual");
    if (url.host === "api.github.com") {
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const read = (key: string): unknown =>
        typeof body === "object" && body !== null ? Reflect.get(body, key) : undefined;
      const match = /\/issues\/(\d+)/.exec(url.pathname);
      if (method === "GET") {
        return Response.json(
          state.issues
            .filter((issue) => issue.state === "open")
            .map(({ number, body: text }) => ({ number, body: text, user: { login: BOT } })),
        );
      }
      if (method === "POST" && match === null) {
        const number = state.issues.length + 1;
        state.issues.push({
          number,
          body: String(read("body")),
          state: "open",
          title: String(read("title")),
          labels: read("labels"),
        });
        return Response.json({ number }, { status: 201 });
      }
      const issue = state.issues.find((one) => one.number === Number(match?.[1]));
      assert.ok(issue !== undefined);
      if (method === "PATCH") {
        const text = read("body");
        if (typeof text === "string") {
          issue.body = text;
        }
        const next = read("state");
        if (typeof next === "string") {
          issue.state = next;
        }
      }
      return Response.json({ number: issue.number });
    }
    const section = SECTIONS.find((one) => one.url === url.href);
    if (section !== undefined) {
      return state.docs(section);
    }
    assert.equal(`${url.pathname}${url.search}`, PROBE_PATH);
    return state.instance(url.host);
  };
}

function environment(state: Fake, env: Record<string, string> = {}): Environment {
  let now = Date.parse("2026-11-09T06:41:00Z");
  return {
    env,
    fetch: fetchOf(state),
    now: () => now,
    wait: (ms) => {
      now += ms;
      return Promise.resolve();
    },
  };
}

const REPORT_ENV = { GH_TOKEN: TOKEN, GITHUB_REPOSITORY: REPO };

/** The URL of a fetch input. */
function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

/** The `issue` line of the JSON the script printed. */
function issueLine(stdout: string): unknown {
  const parsed: unknown = JSON.parse(stdout);
  return typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "issue") : undefined;
}

/** Makes eth.blockscout.com answer with a `Sunset` header of `value`, and every other instance plainly. */
function sunsetOnEth(state: Fake, value: string): void {
  state.instance = (host) =>
    host === "eth.blockscout.com"
      ? Response.json({ result: "0x1" }, { headers: { sunset: value } })
      : blockNumber();
}

describe("blockscout deprecation: the sample (#198)", () => {
  it("asks every routing-table instance on a host Blockscout runs, in chain id order", () => {
    assert.ok(INSTANCES.length >= 40);
    assert.ok(INSTANCES.every((instance) => instance.host.endsWith(HOSTED_SUFFIX)));
    assert.deepEqual(
      INSTANCES.map((instance) => instance.chainId),
      INSTANCES.map((instance) => instance.chainId).toSorted((a, b) => a - b),
    );
    assert.deepEqual(INSTANCES[0], { chainId: 1, host: "eth.blockscout.com" });
  });

  it("skips other backends and self-hosted instances, and refuses a table of another shape", () => {
    const table = {
      chains: [
        {
          chainId: 7,
          backends: [
            { backend: "blockscout", instance: "explorer.example.org" },
            { backend: "sourcify" },
            { backend: "blockscout", instance: "b.blockscout.com" },
          ],
        },
        { chainId: 2, backends: [{ backend: "blockscout", instance: "a.blockscout.com" }] },
      ],
    };
    assert.deepEqual(sampleInstances(table), [
      { chainId: 2, host: "a.blockscout.com" },
      { chainId: 7, host: "b.blockscout.com" },
    ]);
    assert.throws(() => sampleInstances({}), UsageError);
    assert.throws(() => sampleInstances({ chains: [{ chainId: 1 }] }), /chainId and a backends/);
  });
});

describe("blockscout deprecation: the docs section (#198)", () => {
  it("normalises white space and hashes with SHA-256", () => {
    assert.equal(normalise("  a\n\n b\t c "), "a b c");
    assert.equal(sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("takes the lines after the heading up to the next heading, outside code fences", () => {
    const markdown = [
      "# Title",
      "## Watched",
      "first",
      "```",
      "# not a heading",
      "```",
      "last",
      "### Next",
      "after",
    ].join("\r\n");
    assert.equal(sectionOf(markdown, "## Watched"), "first ``` # not a heading ``` last");
    assert.equal(sectionOf(markdown, "## Missing"), undefined);
  });

  it("reads the recorded sections and refuses a hash that does not match its text", () => {
    assert.ok(SECTIONS.length >= 1);
    for (const section of SECTIONS) {
      assert.match(section.url, /^https:\/\/docs\.blockscout\.com\/.+\.md$/);
      assert.match(section.text, /per-instance API/i);
    }
    const [first] = SECTIONS;
    assert.ok(first !== undefined);
    assert.throws(
      () => parseDocsFile({ sections: [{ ...first, sha256: "0".repeat(64) }] }),
      /sha256 does not match its text/,
    );
    assert.throws(() => parseDocsFile({ sections: [] }), /non-empty list/);
    assert.throws(() => parseDocsFile({ sections: [{ ...first, url: "" }] }), /url must be/);
  });

  it("stays quiet when only other parts of the page change", async () => {
    for (const section of SECTIONS) {
      const result = await checkDocs(section, () =>
        Promise.resolve(new Response(page(section, "changed elsewhere, 2027-01-01"))),
      );
      assert.equal(result.signal, undefined);
      assert.deepEqual(result.result, {
        url: section.url,
        heading: section.heading,
        status: "200",
        sha256: section.sha256,
        changed: false,
      });
    }
  });

  it("stays quiet when only the line breaks of the section change", async () => {
    const [section] = SECTIONS;
    assert.ok(section !== undefined);
    const result = await checkDocs(section, () =>
      Promise.resolve(new Response(page(section, "", section.text.replaceAll(" ", "\n")))),
    );
    assert.equal(result.signal, undefined);
  });

  it("reports a change in the watched text, with the new text", async () => {
    const [section] = SECTIONS;
    assert.ok(section !== undefined);
    const text = `${section.text} Per-instance routes stop on 2027-03-01.`;
    const result = await checkDocs(section, () =>
      Promise.resolve(new Response(page(section, "", text))),
    );
    assert.equal(result.result.changed, true);
    assert.equal(result.result.sha256, sha256(text));
    assert.equal(result.signal?.kind, "docs");
    assert.equal(result.signal.where, `${section.url} ${section.heading}`);
    assert.match(result.signal.detail, new RegExp(`Recorded on ${section.read} with sha256`));
    assert.match(result.signal.detail, /Now sha256 [0-9a-f]{64}\. The section reads: /);
    assert.ok(result.signal.detail.length <= 1500);
  });

  it("reports a missing heading, a redirect, an error status and a failed request", async () => {
    const [section] = SECTIONS;
    assert.ok(section !== undefined);
    const gone = await checkDocs(section, () => Promise.resolve(new Response("# Other page")));
    assert.match(gone.signal?.detail ?? "", /no longer has this heading/);
    assert.equal(gone.result.sha256, undefined);
    const moved = await checkDocs(section, () =>
      Promise.resolve(
        new Response(null, { status: 301, headers: { location: "https://docs.example/new" } }),
      ),
    );
    assert.match(
      moved.signal?.detail ?? "",
      /answered HTTP 301 to https:\/\/docs\.example\/new\.$/,
    );
    const missing = await checkDocs(section, () =>
      Promise.resolve(new Response("x", { status: 404 })),
    );
    assert.match(missing.signal?.detail ?? "", /answered HTTP 404\.$/);
    const failed = await checkDocs(section, () => Promise.reject(new Error("socket hang up")));
    assert.equal(failed.result.status, "error");
    assert.match(failed.signal?.detail ?? "", /could not be read: socket hang up/);
  });
});

describe("blockscout deprecation: an instance answer (#198)", () => {
  const instance = { chainId: 1, host: "eth.blockscout.com" };

  it("sees no signal in a plain answer, and sends no key, a JSON accept and no redirect", async () => {
    let seen: RequestInit | undefined;
    const checked = await checkInstance(instance, (input, init) => {
      assert.equal(urlOf(input), `https://eth.blockscout.com${PROBE_PATH}`);
      seen = init;
      return Promise.resolve(blockNumber());
    });
    assert.deepEqual(checked, {
      result: { ...instance, status: "200", answered: true, headers: {} },
      signals: [],
    });
    assert.equal(seen?.redirect, "manual");
    const headers = new Headers(seen?.headers);
    assert.equal(headers.get("accept"), "application/json");
    assert.match(headers.get("user-agent") ?? "", /^explorer-verify-deprecation-watch/);
    assert.equal(seen?.body, undefined);
  });

  it("reports a Sunset, a Deprecation, a Warning and a Link with a deprecation relation", async () => {
    const checked = await checkInstance(instance, () =>
      Promise.resolve(
        Response.json(
          { jsonrpc: "2.0", result: "0x1", id: 1 },
          {
            headers: {
              sunset: "Sat, 01 May 2027 00:00:00 GMT",
              deprecation: "@1793491200",
              warning: '299 - "Deprecated API"',
              link: '<https://docs.blockscout.com/devs/pro-api>; rel="deprecation"',
            },
          },
        ),
      ),
    );
    assert.equal(checked.result.answered, true);
    assert.deepEqual(Object.keys(checked.result.headers).toSorted(), [
      "deprecation",
      "link",
      "sunset",
      "warning",
    ]);
    assert.deepEqual(
      checked.signals.map((signal) => signal.detail),
      [
        "deprecation: @1793491200",
        "sunset: Sat, 01 May 2027 00:00:00 GMT",
        'link: <https://docs.blockscout.com/devs/pro-api>; rel="deprecation"',
        'warning: 299 - "Deprecated API"',
      ],
    );
    assert.ok(checked.signals.every((signal) => signal.kind === "header"));
    assert.equal(checked.signals[0]?.where, "eth.blockscout.com (chain 1)");
  });

  it("ignores a Link with another relation", async () => {
    const checked = await checkInstance(instance, () =>
      Promise.resolve(Response.json({ result: "0x1" }, { headers: { link: '</x>; rel="next"' } })),
    );
    assert.deepEqual(checked.signals, []);
  });

  it("reports an answer that names the hosted API, and a redirect to it", async () => {
    const body = await checkInstance(instance, () =>
      Promise.resolve(
        Response.json(
          {
            status: "0",
            message: "This API was removed. Use https://api.blockscout.com with a key",
          },
          { status: 410 },
        ),
      ),
    );
    assert.equal(body.result.answered, false);
    assert.equal(body.result.status, "410");
    assert.equal(body.signals.length, 1);
    assert.equal(body.signals[0]?.kind, "answer");
    assert.match(body.signals[0]?.detail ?? "", /^HTTP 410 body: .*api\.blockscout\.com/);
    const moved = await checkInstance(instance, () =>
      Promise.resolve(
        new Response(null, {
          status: 308,
          headers: { location: "https://api.blockscout.com/v2/api?chain_id=1" },
        }),
      ),
    );
    assert.match(moved.signals[0]?.detail ?? "", /^HTTP 308 Location: https:\/\/api\.blockscout/);
  });

  it("cuts a long answer to an excerpt around the match", async () => {
    const checked = await checkInstance(instance, () =>
      Promise.resolve(new Response(`${"x".repeat(2000)} deprecated ${"y".repeat(2000)}`)),
    );
    const detail = checked.signals[0]?.detail ?? "";
    assert.match(detail, /deprecated/);
    assert.ok(detail.length <= 320);
  });

  it("counts a non-JSON answer, another result and a failed request as not answering", async () => {
    for (const response of [
      new Response("<html>Just a moment...</html>", { status: 403 }),
      new Response("not json"),
      Response.json({ result: "not hex" }),
    ]) {
      const checked = await checkInstance(instance, () => Promise.resolve(response));
      assert.equal(checked.result.answered, false);
      assert.deepEqual(checked.signals, []);
    }
    const failed = await checkInstance(instance, () => Promise.reject(new Error("timeout")));
    assert.deepEqual(failed, {
      result: { ...instance, status: "error: timeout", answered: false, headers: {} },
      signals: [],
    });
  });
});

describe("blockscout deprecation: the run (#198)", () => {
  const few = INSTANCES.slice(0, DOWN_THRESHOLD);

  it("asks one instance at a time, spaced, then each docs page, and reports no signal", async () => {
    const state = fake();
    const waits: number[] = [];
    const env = environment(state);
    const report = await runWatch(few, SECTIONS, {
      ...env,
      wait: async (ms) => {
        waits.push(ms);
        await env.wait(ms);
      },
    });
    assert.equal(report.date, "2026-11-09T06:41:00.000Z");
    assert.equal(report.sampled, few.length);
    assert.equal(report.notAnswering, 0);
    assert.deepEqual(report.signals, []);
    assert.deepEqual(
      waits,
      few.slice(1).map(() => MIN_INTERVAL_MS),
    );
    assert.equal(state.requests.length, few.length + SECTIONS.length);
    assert.ok(report.docs.every((one) => !one.changed));
  });

  it("adds a signal for a changed docs section", async () => {
    const state = fake({ docs: (section) => new Response(page(section, "", "new text")) });
    const report = await runWatch(few, SECTIONS, environment(state));
    assert.deepEqual(
      report.signals.map((one) => one.kind),
      SECTIONS.map(() => "docs"),
    );
    assert.ok(report.docs.every((one) => one.changed));
  });

  it("does not wait when a request took longer than the interval", async () => {
    let now = 0;
    const waits: number[] = [];
    await runWatch(few, [], {
      env: {},
      fetch: () => {
        now += MIN_INTERVAL_MS;
        return Promise.resolve(blockNumber());
      },
      now: () => now,
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    assert.deepEqual(waits, []);
  });

  it("reports instances that stop answering only from the threshold up", async () => {
    const below = fake({
      instance: (host) =>
        host === few[0]?.host ? blockNumber() : new Response("down", { status: 502 }),
    });
    const quiet = await runWatch(few, [], environment(below));
    assert.equal(quiet.notAnswering, DOWN_THRESHOLD - 1);
    assert.deepEqual(quiet.signals, []);
    const all = fake({ instance: () => new Response("down", { status: 502 }) });
    const loud = await runWatch(few, [], environment(all));
    assert.equal(loud.notAnswering, DOWN_THRESHOLD);
    assert.deepEqual(
      loud.signals.map((signal) => [signal.kind, signal.where]),
      [["down", `${String(DOWN_THRESHOLD)} of ${String(DOWN_THRESHOLD)} sampled instances`]],
    );
    assert.match(loud.signals[0]?.detail ?? "", /^eth\.blockscout\.com 502, /);
  });
});

const signal = (detail: string): Signal => ({ kind: "answer", where: "h (chain 1)", detail });

function reportWith(signals: Signal[]): Report {
  return {
    schemaVersion: 1,
    date: "2026-11-09T06:41:00.000Z",
    sampled: 42,
    notAnswering: 1,
    instances: [],
    docs: [],
    signals,
  };
}

describe("blockscout deprecation: the issue body (#198)", () => {
  it("says which signal fired, where, links #96 and the run", () => {
    const body = issueBody(
      reportWith([
        {
          kind: "header",
          where: "eth.blockscout.com (chain 1)",
          detail: "sunset: Sat, 01 May 2027",
        },
      ]),
      "https://github.com/owner/repo/actions/runs/5",
    );
    assert.ok(body.startsWith(`${MARKER}\n`));
    assert.match(body, /saw these signals: header\./);
    assert.match(body, /^Run: https:\/\/github\.com\/owner\/repo\/actions\/runs\/5$/m);
    assert.match(
      body,
      /^\| header \| ` eth\.blockscout\.com \(chain 1\) ` \| ` sunset: Sat, 01 May 2027 ` \|$/m,
    );
    assert.match(body, /hosted API of #96/);
    assert.match(body, /^1 of 42 sampled instances did not answer\.$/m);
    assert.ok(!issueBody(reportWith([signal("x")]), undefined).includes("Run:"));
  });

  it("puts explorer and docs text in code spans, so no mention, HTML or comment renders", () => {
    const hostile = "@maintainer <!-- hide --> <img src=x> ``` | #1\nnext";
    const body = issueBody(reportWith([signal(hostile)]), undefined);
    const row = body.split("\n").find((line) => line.startsWith("| answer |")) ?? "";
    assert.match(row, /\| ```` @maintainer <!-- hide --> <img src=x> ``` \\\| #1 next ```` \|$/);
    assert.ok(!body.replace(row, "").includes("@maintainer"));
  });

  it("bounds the body by rows and by size, then gives a line for the rest", () => {
    const long = Array.from({ length: 30 }, () => signal("|".repeat(1500)));
    const capped = issueBody(reportWith(long), undefined);
    assert.ok(capped.length < 55_000, `body is ${String(capped.length)} characters`);
    assert.match(capped, /^And \d+ more; the run's JSON lists every one\.$/m);
    const many = Array.from({ length: MAX_ROWS + 25 }, () => signal("|".repeat(300)));
    const body = issueBody(reportWith(many), undefined);
    assert.equal(body.split("\n").filter((line) => line.startsWith("| answer |")).length, MAX_ROWS);
    assert.match(body, /^And 25 more; the run's JSON lists every one\.$/m);
    assert.ok(body.length < 65_536, `body is ${String(body.length)} characters`);
    assert.ok(!signalTable([signal("x")]).includes("more;"));
  });

  it("closes with a comment that gives the counts", () => {
    assert.match(
      closingComment(reportWith([])),
      /watch of 2026-11-09T06:41:00\.000Z saw no signal: 41 of 42 sampled instances answered/,
    );
  });
});

describe("blockscout deprecation: the command line (#198)", () => {
  it("reads --report, --out and --summary, and refuses anything else", () => {
    assert.deepEqual(parseArguments([]), { report: false, out: undefined, summary: undefined });
    assert.deepEqual(parseArguments(["--report", "--out", "o.json", "--summary", "s.md"]), {
      report: true,
      out: "o.json",
      summary: "s.md",
    });
    assert.throws(() => parseArguments(["--nope"]), /unknown flag --nope/);
    assert.throws(() => parseArguments(["--out"]), /--out needs a value/);
    assert.throws(() => parseArguments(["--summary", "--report"]), /--summary needs a value/);
  });
});

describe("blockscout deprecation: the issue on GitHub (#198)", () => {
  let dir = "";
  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), "blockscout-deprecation-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("opens the issue on a Sunset header, updates it on the next run, closes it when none", async () => {
    const state = fake();
    sunsetOnEth(state, "Sat, 01 May 2027 00:00:00 GMT");
    const first = await main(["--report"], environment(state, REPORT_ENV));
    assert.equal(first.code, 0, first.stderr);
    assert.equal(state.issues.length, 1);
    const [issue] = state.issues;
    assert.ok(issue !== undefined);
    assert.equal(issue.title, TITLE);
    assert.deepEqual(issue.labels, LABELS);
    assert.ok(issue.body.startsWith(MARKER));
    assert.match(
      issue.body,
      /^\| header \| ` eth\.blockscout\.com \(chain 1\) ` \| ` sunset: Sat, 01 May 2027 00:00:00 GMT ` \|$/m,
    );
    assert.match(issue.body, /#96/);
    assert.equal(issueLine(first.stdout), "blockscout deprecation: opened issue #1");

    sunsetOnEth(state, "Sun, 02 May 2027 00:00:00 GMT");
    const second = await main(["--report"], environment(state, REPORT_ENV));
    assert.equal(second.code, 0, second.stderr);
    assert.equal(state.issues.length, 1);
    assert.match(issue.body, /Sun, 02 May 2027/);
    assert.equal(issueLine(second.stdout), "blockscout deprecation: updated issue #1");

    const same = await main(["--report"], environment(state, REPORT_ENV));
    assert.equal(
      issueLine(same.stdout),
      "blockscout deprecation: issue #1 already lists these signals",
    );

    state.instance = blockNumber;
    const third = await main(["--report"], environment(state, REPORT_ENV));
    assert.equal(third.code, 0, third.stderr);
    assert.equal(issue.state, "closed");
    assert.equal(issueLine(third.stdout), "blockscout deprecation: no signal; closed issue #1");
    assert.ok(
      state.requests.some(
        (request) => request === `POST https://api.github.com/repos/${REPO}/issues/1/comments`,
      ),
    );
  });

  it("opens no issue when there is no signal", async () => {
    const state = fake();
    const result = await main(["--report"], environment(state, REPORT_ENV));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(state.issues, []);
    assert.equal(issueLine(result.stdout), "blockscout deprecation: no signal; no open issue");
    assert.ok(state.requests.every((request) => !request.startsWith("POST")));
  });

  it("writes the JSON and the summary, and links the run", async () => {
    const state = fake();
    sunsetOnEth(state, "soon");
    const out = path.join(dir, "out.json");
    const summary = path.join(dir, "summary.md");
    const result = await main(
      ["--report", "--out", out, "--summary", summary],
      environment(state, {
        ...REPORT_ENV,
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_RUN_ID: "77",
      }),
    );
    assert.equal(result.code, 0);
    assert.equal(readFileSync(out, "utf8"), result.stdout);
    const text = readFileSync(summary, "utf8");
    assert.match(text, /^## Blockscout deprecation watch, 2026-11-09T06:41:00\.000Z$/m);
    assert.match(
      text,
      new RegExp(
        `^${String(INSTANCES.length)} of ${String(INSTANCES.length)} sampled instances answered\\. ${String(SECTIONS.length)} of ${String(SECTIONS.length)} watched docs sections are unchanged\\.$`,
        "m",
      ),
    );
    assert.match(text, /\| header \|/);
    assert.match(
      state.issues[0]?.body ?? "",
      /^Run: https:\/\/github\.com\/owner\/repo\/actions\/runs\/77$/m,
    );
  });

  it("says no signal in the summary of a quiet run", async () => {
    const summary = path.join(dir, "quiet.md");
    const result = await main(["--summary", summary], environment(fake()));
    assert.equal(result.code, 0);
    assert.match(readFileSync(summary, "utf8"), /^No signal\.$/m);
  });

  it("exits 1 on a signal without --report, and files nothing", async () => {
    const state = fake();
    sunsetOnEth(state, "soon");
    const result = await main([], environment(state));
    assert.equal(result.code, 1);
    assert.ok(state.requests.every((request) => !request.includes("api.github.com")));
  });

  it("exits 1 when GitHub fails, without printing the token", async () => {
    const state = fake();
    const base = fetchOf(state);
    const result = await main(["--report"], {
      ...environment(state, { ...REPORT_ENV, GITHUB_API_URL: "https://api.github.com/" }),
      fetch: (input, init) =>
        urlOf(input).startsWith("https://api.github.com")
          ? Promise.resolve(new Response(TOKEN, { status: 500 }))
          : base(input, init),
    });
    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /^Could not sync the issue: GitHub GET \/issues\?.* answered HTTP 500\n$/,
    );
    assert.ok(!`${result.stdout}${result.stderr}`.includes(TOKEN));
  });

  it("exits 2 on a wrong command line, and on --report without a token or repository", async () => {
    const state = fake();
    const flag = await main(["--nope"], environment(state));
    assert.deepEqual(flag, { code: 2, stdout: "", stderr: "unknown flag --nope\n" });
    const token = await main(["--report"], environment(state, { GITHUB_REPOSITORY: REPO }));
    assert.equal(token.code, 2);
    assert.match(token.stderr, /--report needs GH_TOKEN and GITHUB_REPOSITORY/);
    const repo = await main(["--report"], environment(state, { GH_TOKEN: TOKEN }));
    assert.equal(repo.code, 2);
    assert.deepEqual(state.requests, []);
  });

  it("exits 1 on an unexpected error, with the token removed", async () => {
    const result = await main(["--report"], {
      ...environment(fake(), REPORT_ENV),
      now: () => Number.NaN,
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Invalid time value/);
  });

  it("exits 2 when a data file cannot be read", async () => {
    const base = path.join(dir, "root");
    mkdirSync(path.join(base, path.dirname(TABLE_FILE)), { recursive: true });
    writeFileSync(path.join(base, TABLE_FILE), "{ not json");
    const result = await main([], { ...environment(fake()), root: base });
    assert.equal(result.code, 2);
    assert.match(result.stderr, new RegExp(`^cannot read ${TABLE_FILE}: `));
  });

  it("runs on Node's fetch, clock and timers", async () => {
    const env = nodeEnvironment();
    assert.equal(typeof env.now(), "number");
    await env.wait(0);
    assert.equal(await (await env.fetch("data:text/plain,ok")).text(), "ok");
  });

  it("prints the reason and exits 2 when run with a wrong flag", () => {
    const result = spawnSync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", SCRIPT, "--nope"],
      {
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "unknown flag --nope\n");
  });
});
