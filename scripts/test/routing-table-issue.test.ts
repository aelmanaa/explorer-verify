// Tests for the weekly routing-table issue (#171, R-RT-1). A fake IssueApi and a fake fetch stand in
// for GitHub: no network call. The token is a dummy.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BOT,
  LABELS,
  MARKER,
  TITLE,
  closingComment,
  gitHubApi,
  issueBody,
  main,
  parseReport,
  sync,
} from "../routing-table-issue.ts";
import type { Issue, IssueApi, Report } from "../routing-table-issue.ts";

const TOKEN = "dummy-token-for-tests";

const REPORT: Report = {
  checked: "2026-11-04",
  notes: ["table checked 2026-11-04; 2 rows", "routescan: not compared"],
  differences: [
    { chainId: 1, list: "Etherscan chainlist", text: "etherscan: chain 1 now needs a paid plan" },
    {
      chainId: 999,
      list: "Sourcify chain list",
      text: "table: chain 999 lists sourcify, which no longer supports it",
    },
  ],
};
const CLEAN: Report = { ...REPORT, differences: [] };

/** An IssueApi that records each call and answers with `open`. */
function fakeApi(open: Issue | undefined): { api: IssueApi; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    api: {
      findOpen: () => Promise.resolve(open),
      create: (title, body, labels) => {
        calls.push(`create ${title} [${labels.join(",")}] ${String(body.length)}`);
        return Promise.resolve(42);
      },
      update: (issue, body) => {
        calls.push(`update #${String(issue)} ${String(body.length)}`);
        return Promise.resolve();
      },
      close: (issue, comment) => {
        calls.push(`close #${String(issue)} ${comment}`);
        return Promise.resolve();
      },
    },
  };
}

describe("routing-table issue: the report (R-RT-1, #171)", () => {
  it("reads the JSON compare-routing-table.ts --json prints", () => {
    assert.deepEqual(parseReport(JSON.parse(JSON.stringify(REPORT))), REPORT);
  });

  it("reads a difference in Routescan's list (#168)", () => {
    const routescan: Report = {
      ...CLEAN,
      differences: [
        {
          chainId: 68414,
          list: "Routescan chain list",
          text: "routescan: chain 68414 (Henesys) left the mainnet list; probe its API",
        },
      ],
    };
    assert.deepEqual(parseReport(JSON.parse(JSON.stringify(routescan))), routescan);
  });

  it("refuses a report of another shape", () => {
    const cases: [unknown, RegExp][] = [
      [null, /checked is not a string/],
      [{ checked: "d" }, /differences is not an array/],
      [{ checked: "d", differences: [{ chainId: 1.5 }] }, /no integer chainId/],
      [{ checked: "d", differences: [{ chainId: "1" }] }, /no integer chainId/],
      [{ checked: "d", differences: [{ chainId: 1, list: "Routescan" }] }, /unknown list/],
      [
        { checked: "d", differences: [{ chainId: 1, list: "Sourcify chain list" }] },
        /chain 1 has no text/,
      ],
      [{ checked: "d", differences: [] }, /notes is not an array/],
      [{ checked: "d", differences: [], notes: [1] }, /notes has an entry that is not a string/],
    ];
    for (const [value, message] of cases) {
      assert.throws(() => parseReport(value), message);
    }
  });
});

describe("routing-table issue: the body (R-RT-1, #171)", () => {
  it("names each chain and the list it changed in, then the notes", () => {
    const body = issueBody(REPORT);
    assert.ok(body.startsWith(`${MARKER}\n`));
    assert.match(body, /found 2 differences between the routing table \(checked 2026-11-04\)/);
    assert.match(
      body,
      /^\| 1 \| Etherscan chainlist \| etherscan: chain 1 now needs a paid plan \|$/m,
    );
    assert.match(
      body,
      /^\| 999 \| Sourcify chain list \| table: chain 999 lists sourcify, which no longer supports it \|$/m,
    );
    assert.match(body, /^- routescan: not compared$/m);
  });

  it("says difference for one, and escapes a pipe or line break in a cell", () => {
    const body = issueBody({
      ...REPORT,
      differences: [{ chainId: 5, list: "Etherscan chainlist", text: "a | b\nc" }],
    });
    assert.match(body, /found 1 difference between/);
    assert.match(body, /^\| 5 \| Etherscan chainlist \| a \\\| b c \|$/m);
  });
});

describe("routing-table issue: sync (R-RT-1, #171)", () => {
  it("opens one issue on a difference when none is open", async () => {
    const { api, calls } = fakeApi(undefined);
    assert.equal(await sync(REPORT, api), "routing table: opened issue #42");
    assert.deepEqual(calls, [
      `create ${TITLE} [${LABELS.join(",")}] ${String(issueBody(REPORT).length)}`,
    ]);
  });

  it("replaces the body of the open issue when the differences changed", async () => {
    const { api, calls } = fakeApi({ number: 7, body: `${MARKER}\nolder` });
    assert.equal(await sync(REPORT, api), "routing table: updated issue #7");
    assert.deepEqual(calls, [`update #7 ${String(issueBody(REPORT).length)}`]);
  });

  it("leaves the open issue alone when it already lists the differences", async () => {
    const { api, calls } = fakeApi({ number: 7, body: issueBody(REPORT) });
    assert.equal(
      await sync(REPORT, api),
      "routing table: issue #7 already lists these differences",
    );
    assert.deepEqual(calls, []);
  });

  it("opens no issue when there is no difference", async () => {
    const { api, calls } = fakeApi(undefined);
    assert.equal(await sync(CLEAN, api), "routing table: no differences; no open issue");
    assert.deepEqual(calls, []);
  });

  it("comments and closes the open issue when no difference remains", async () => {
    const { api, calls } = fakeApi({ number: 7, body: issueBody(REPORT) });
    assert.equal(await sync(CLEAN, api), "routing table: no differences; closed issue #7");
    assert.deepEqual(calls, [`close #7 ${closingComment(CLEAN)}`]);
    assert.match(closingComment(CLEAN), /found no difference .*checked 2026-11-04/);
  });
});

interface Request {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that records each request and answers with the next of `answers`. */
function fakeFetch(answers: Response[], requests: Request[]): typeof globalThis.fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    const body = init?.body;
    requests.push({
      method: init?.method ?? "GET",
      url: input instanceof Request ? input.url : String(input),
      headers: Object.fromEntries(headers),
      body: typeof body === "string" ? JSON.parse(body) : undefined,
    });
    const answer = answers.shift();
    return answer === undefined
      ? Promise.reject(new Error("unexpected request"))
      : Promise.resolve(answer);
  };
}

const OPTIONS = { repository: "owner/repo", token: TOKEN, apiUrl: "https://api.example/" };

describe("routing-table issue: the GitHub calls (R-RT-1, #171)", () => {
  it("finds the open issue the workflow opened by its marker, skipping pull requests", async () => {
    const requests: Request[] = [];
    const api = gitHubApi({
      ...OPTIONS,
      fetch: fakeFetch(
        [
          Response.json([
            { number: 1, body: "Broken links in the docs" },
            { number: 2, body: `${MARKER}\npr`, pull_request: {} },
            { number: 3, body: null },
            { number: 4, body: `${MARKER}\nthe one` },
          ]),
        ],
        requests,
      ),
    });
    assert.deepEqual(await api.findOpen(), { number: 4, body: `${MARKER}\nthe one` });
    const [request] = requests;
    assert.ok(request !== undefined);
    assert.equal(request.method, "GET");
    const url = new URL(request.url);
    assert.equal(url.origin + url.pathname, "https://api.example/repos/owner/repo/issues");
    assert.equal(url.searchParams.get("state"), "open");
    assert.equal(url.searchParams.get("creator"), BOT);
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(request.headers.accept, "application/vnd.github+json");
    assert.equal(request.headers["x-github-api-version"], "2022-11-28");
  });

  it("finds nothing when no open issue has the marker, or the answer is not a list", async () => {
    const api = gitHubApi({
      ...OPTIONS,
      fetch: fakeFetch([Response.json([{ number: 1, body: "other" }]), Response.json({})], []),
    });
    assert.equal(await api.findOpen(), undefined);
    assert.equal(await api.findOpen(), undefined);
  });

  it("opens, updates, comments and closes", async () => {
    const requests: Request[] = [];
    const api = gitHubApi({
      ...OPTIONS,
      fetch: fakeFetch(
        [
          Response.json({ number: 9 }, { status: 201 }),
          Response.json({ number: 9 }),
          Response.json({ id: 1 }, { status: 201 }),
          Response.json({ number: 9 }),
        ],
        requests,
      ),
    });
    assert.equal(await api.create("t", "b", ["l"]), 9);
    await api.update(9, "new");
    await api.close(9, "done");
    assert.deepEqual(
      requests.map(({ method, url, body }) => [method, url, body]),
      [
        [
          "POST",
          "https://api.example/repos/owner/repo/issues",
          { title: "t", body: "b", labels: ["l"] },
        ],
        ["PATCH", "https://api.example/repos/owner/repo/issues/9", { body: "new" }],
        ["POST", "https://api.example/repos/owner/repo/issues/9/comments", { body: "done" }],
        [
          "PATCH",
          "https://api.example/repos/owner/repo/issues/9",
          { state: "closed", state_reason: "completed" },
        ],
      ],
    );
  });

  it("accepts an answer with no content", async () => {
    const api = gitHubApi({
      ...OPTIONS,
      fetch: fakeFetch([new Response(null, { status: 204 })], []),
    });
    await api.update(9, "new");
  });

  it("fails on an error status without printing the token, and on an answer without a number", async () => {
    const api = gitHubApi({
      ...OPTIONS,
      fetch: fakeFetch(
        [new Response("no", { status: 403 }), Response.json({}, { status: 201 })],
        [],
      ),
    });
    await assert.rejects(api.update(9, "b"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "GitHub PATCH /issues/9 answered HTTP 403");
      assert.ok(!error.message.includes(TOKEN));
      return true;
    });
    await assert.rejects(api.create("t", "b", []), /answered without an issue number/);
  });
});

describe("routing-table issue: the command (R-RT-1, #171)", () => {
  let dir = "";
  let file = "";
  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), "routing-table-issue-"));
    file = path.join(dir, "report.json");
    writeFileSync(file, JSON.stringify(REPORT));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the report and opens the issue in GITHUB_REPOSITORY with GH_TOKEN", async () => {
    const requests: Request[] = [];
    const line = await main(
      [file],
      { GH_TOKEN: TOKEN, GITHUB_REPOSITORY: "owner/repo" },
      fakeFetch([Response.json([]), Response.json({ number: 11 }, { status: 201 })], requests),
    );
    assert.equal(line, "routing table: opened issue #11");
    assert.deepEqual(
      requests.map(({ method, url }) => `${method} ${new URL(url).origin}${new URL(url).pathname}`),
      [
        "GET https://api.github.com/repos/owner/repo/issues",
        "POST https://api.github.com/repos/owner/repo/issues",
      ],
    );
  });

  it("takes GITHUB_API_URL when set", async () => {
    const requests: Request[] = [];
    await main(
      [file],
      { GH_TOKEN: TOKEN, GITHUB_REPOSITORY: "o/r", GITHUB_API_URL: "https://ghe.example/api/v3" },
      fakeFetch([Response.json([{ number: 3, body: issueBody(REPORT) }])], requests),
    );
    assert.match(requests[0]?.url ?? "", /^https:\/\/ghe\.example\/api\/v3\/repos\/o\/r\/issues\?/);
  });

  it("refuses a missing argument, token or repository", async () => {
    const fetch = fakeFetch([], []);
    await assert.rejects(main([], {}, fetch), /usage: node scripts\/routing-table-issue\.ts/);
    await assert.rejects(main([file, file], {}, fetch), /usage:/);
    await assert.rejects(main([file], { GITHUB_REPOSITORY: "o/r" }, fetch), /GH_TOKEN and/);
    await assert.rejects(main([file], { GH_TOKEN: TOKEN }, fetch), /GITHUB_REPOSITORY must/);
  });

  it("prints the reason and exits 1 when run with no report", () => {
    const script = fileURLToPath(new URL("../routing-table-issue.ts", import.meta.url));
    const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", script], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^usage: node scripts\/routing-table-issue\.ts <report\.json>\n$/);
  });
});
