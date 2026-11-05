// The one-issue-per-signal pattern the weekly workflows share (#171, #198). A workflow keeps at
// most one open issue per watch, found again by a hidden marker at the start of its body among the
// open issues the workflow's own token opened, so a changed title or label never opens a second
// one. {@link syncIssue} opens, updates or closes that issue; {@link gitHubApi} makes the REST
// calls; {@link codeCell} puts outside text in an issue safely.

/** The login GitHub gives the workflow's own token. */
export const BOT = "github-actions[bot]";

/** An open issue: its number and body. */
export interface Issue {
  readonly number: number;
  readonly body: string;
}

/** The GitHub calls a sync makes. The tests pass a fake. */
export interface IssueApi {
  /** The open issue with the marker at the start of its body, if any. */
  findOpen(): Promise<Issue | undefined>;
  /** Opens an issue and returns its number. */
  create(title: string, body: string, labels: readonly string[]): Promise<number>;
  /** Replaces the body of an issue. */
  update(issue: number, body: string): Promise<void>;
  /** Comments on an issue, then closes it as completed. */
  close(issue: number, comment: string): Promise<void>;
}

/** Where the GitHub calls go and how they authenticate. */
export interface GitHubOptions {
  /** `owner/name`. */
  readonly repository: string;
  readonly token: string;
  /** The REST API root, `https://api.github.com` on github.com. */
  readonly apiUrl: string;
  readonly fetch: typeof globalThis.fetch;
}

/** What one watch's issue looks like, and the words of the line {@link syncIssue} returns. */
export interface IssueSpec {
  readonly title: string;
  readonly labels: readonly string[];
  /** The start of each returned line, such as `routing table`. */
  readonly subject: string;
  /** Said when there is nothing to report, such as `no differences`. */
  readonly quiet: string;
  /** Said when the open issue already has the body, such as `already lists these differences`. */
  readonly same: string;
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Reflect.get(value, key)
    : undefined;
}

/**
 * Opens, updates or closes the watch's issue.
 *
 * - A body and no open issue: it opens one.
 * - A body and an open issue: it replaces the issue's body when the body changed.
 * - No body and an open issue: it comments `closing` and closes the issue.
 * - No body and no open issue: it does nothing.
 *
 * @param api - The GitHub calls.
 * @param spec - The issue's title, labels and the words of the returned line.
 * @param body - The issue body, starting with the marker, or `undefined` when nothing is reported.
 * @param closing - The comment left when the issue is closed.
 * @returns One line that says what it did.
 */
export async function syncIssue(
  api: IssueApi,
  spec: IssueSpec,
  body: string | undefined,
  closing: string,
): Promise<string> {
  const open = await api.findOpen();
  if (body === undefined) {
    if (open === undefined) {
      return `${spec.subject}: ${spec.quiet}; no open issue`;
    }
    await api.close(open.number, closing);
    return `${spec.subject}: ${spec.quiet}; closed issue #${String(open.number)}`;
  }
  if (open === undefined) {
    const created = await api.create(spec.title, body, spec.labels);
    return `${spec.subject}: opened issue #${String(created)}`;
  }
  if (open.body === body) {
    return `${spec.subject}: issue #${String(open.number)} ${spec.same}`;
  }
  await api.update(open.number, body);
  return `${spec.subject}: updated issue #${String(open.number)}`;
}

/**
 * The GitHub REST calls behind {@link IssueApi}. A status other than 2xx throws an error that
 * names the method, path and status, never the token.
 *
 * @param options - The repository, token, API root and fetch.
 * @param marker - The hidden line at the start of the watch's issue body.
 * @returns The calls.
 */
export function gitHubApi(options: GitHubOptions, marker: string): IssueApi {
  const base = `${options.apiUrl.replace(/\/+$/, "")}/repos/${options.repository}`;
  async function call(method: string, route: string, body?: unknown): Promise<unknown> {
    const response = await options.fetch(`${base}${route}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new Error(`GitHub ${method} ${route} answered HTTP ${String(response.status)}`);
    }
    const parsed: unknown = response.status === 204 ? undefined : await response.json();
    return parsed;
  }
  return {
    async findOpen() {
      const query = new URLSearchParams({ state: "open", creator: BOT, per_page: "100" });
      const answer = await call("GET", `/issues?${query.toString()}`);
      const issues: unknown[] = Array.isArray(answer) ? answer : [];
      for (const issue of issues) {
        const number = field(issue, "number");
        const body = field(issue, "body");
        if (
          typeof number === "number" &&
          typeof body === "string" &&
          field(issue, "pull_request") === undefined &&
          body.startsWith(marker)
        ) {
          return { number, body };
        }
      }
      return undefined;
    },
    async create(title, body, labels) {
      const answer = await call("POST", "/issues", { title, body, labels });
      const number = field(answer, "number");
      if (typeof number !== "number") {
        throw new TypeError("GitHub POST /issues answered without an issue number");
      }
      return number;
    },
    async update(issue, body) {
      await call("PATCH", `/issues/${String(issue)}`, { body });
    },
    async close(issue, comment) {
      await call("POST", `/issues/${String(issue)}/comments`, { body: comment });
      await call("PATCH", `/issues/${String(issue)}`, {
        state: "closed",
        state_reason: "completed",
      });
    },
  };
}

/**
 * A table cell that shows `value` as code: one line, `|` escaped, in a code span whose backtick
 * fence is longer than any backtick run in the text. Inside a code span, GitHub renders no
 * mention, reference, HTML or comment, so an explorer's answer cannot notify anyone or hide text.
 * @param value Any text, such as an explorer's answer.
 * @returns The cell, or an empty string for empty text.
 */
export function codeCell(value: string): string {
  const line = value.replaceAll(/\r\n|\r|\n/g, " ").replaceAll("|", "\\|");
  if (line.trim() === "") {
    return "";
  }
  const longest = Math.max(0, ...[...line.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence} ${line} ${fence}`;
}
