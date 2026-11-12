// The error reference (R-AX-7, R-AX-10, decision 0015): one page per code in
// docs/user/reference/errors/, and an index with the shared sections. The catalogue in
// src/errors.ts is the one source of truth: each page is written by hand, and these tests check
// its default hint, retry flag and exit code against the catalogue, so a page cannot drift.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { ERROR_EXIT_CODES } from "../../src/envelope.ts";
import { newError } from "../../src/error-hints.ts";
import { ERROR_CODES, hintFor } from "../../src/index.ts";
import type { ErrorCode, ExplorerVerifyError } from "../../src/index.ts";
import { docsFileOf, docsUrlOf } from "../helpers/docs-url.ts";
import { pageDetails, SAMPLE_DETAILS } from "../helpers/sample-details.ts";

const REPOSITORY = new URL("../../../../", import.meta.url);
const PAGES = new URL("docs/user/reference/errors/", REPOSITORY);
const RELEASED = new URL("../../released-error-codes.json", import.meta.url);
// The template of a code page (decision 0064): the H1, a one-sentence summary, then these H2s in
// this order, each holding its labelled lines in this order. The CLI tests check "From the CLI:".
// The fix is the first paragraph under "How to fix", with no label: the heading already says it
// (issue #379).
const SECTIONS: readonly { heading: string; labels: readonly string[] }[] = [
  { heading: "How to fix", labels: ["From the CLI:"] },
  {
    heading: "Facts",
    labels: ["Retryable:", "Exit code:", "Sent to an explorer:", "Default hint:", "For end users:"],
  },
  { heading: "Why", labels: ["Cause:"] },
  { heading: "In code", labels: [] },
];
const LABELS = SECTIONS.flatMap((section) => section.labels);
// The most words between the H1 and the start of the fix (R-AX-10, issue #321).
const FIX_WITHIN_WORDS = 40;

const codes: readonly string[] = ERROR_CODES;

function read(url: URL): string {
  return readFileSync(url, "utf8");
}

function page(code: string): string {
  return read(new URL(`${code}.md`, PAGES));
}

function error(code: ErrorCode): ExplorerVerifyError {
  return newError(SAMPLE_DETAILS[code], "m", { secrets: [] });
}

/** The paragraph that starts with `label`, without the label, with its lines joined. */
function paragraph(text: string, label: string): string | undefined {
  const start = text.search(new RegExp(`^${label} `, "m"));
  if (start === -1) {
    return undefined;
  }
  const end = text.indexOf("\n\n", start);
  return text
    .slice(start + label.length, end === -1 ? undefined : end)
    .replace(/\s+/g, " ")
    .trim();
}

/** The H2 headings of a page, with the offset of each, outside code blocks. */
function headings(text: string): { heading: string; at: number }[] {
  const found: { heading: string; at: number }[] = [];
  let fenced = false;
  let at = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      fenced = !fenced;
    } else if (!fenced && line.startsWith("## ")) {
      found.push({ heading: line.slice(3).trim(), at });
    }
    at += line.length + 1;
  }
  return found;
}

/** The H2 a page offset falls under, or `undefined` before the first H2. */
function sectionAt(text: string, at: number): string | undefined {
  return headings(text).findLast((found) => found.at < at)?.heading;
}

/** The offset of the one line that starts with `label`, or -1. */
function labelAt(text: string, label: string): number {
  return text.search(new RegExp(`^${label} `, "m"));
}

/** The offset of the `## How to fix` heading, or -1. */
function fixAt(text: string): number {
  return headings(text).find((each) => each.heading === "How to fix")?.at ?? -1;
}

/** The first paragraph under `## How to fix`: the fix. */
function fixParagraph(text: string): string {
  const start = fixAt(text);
  return start === -1 ? "" : (text.slice(start).split("\n\n")[1] ?? "");
}

/** The words of a Markdown text, with each link counted as its text. */
function words(text: string): number {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, " $1 ")
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/** The committed list of released codes: each code and the first version that shipped it. */
function released(): Map<string, string> {
  const parsed: unknown = JSON.parse(read(RELEASED));
  assert.ok(
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed),
    "released-error-codes.json must hold an object",
  );
  return new Map(
    Object.entries(parsed).map(([code, version]: [string, unknown]) => {
      assert.equal(typeof version, "string", `${code} must map to a version`);
      return [code, String(version)];
    }),
  );
}

/** The numeric parts of a version, for ordering. */
function parts(version: string): number[] {
  return version
    .replace(/-.*$/, "")
    .split(".")
    .map((part) => Number(part));
}

/** Whether version `a` comes after version `b`, compared on major, minor and patch. */
function later(a: string, b: string): boolean {
  const [x, y] = [parts(a), parts(b)];
  const index = x.findIndex((part, at) => part !== y[at]);
  return index !== -1 && (x[index] ?? 0) > (y[index] ?? 0);
}

describe("error pages (R-AX-10)", () => {
  it("has a page for every code in ERROR_CODES, with the code as its H1", () => {
    for (const code of ERROR_CODES) {
      assert.ok(existsSync(new URL(`${code}.md`, PAGES)), `no page for ${code}`);
      assert.equal(page(code).split("\n")[0], `# ${code}`, code);
    }
  });

  it("gives each page the labelled lines once each, in order", () => {
    for (const code of ERROR_CODES) {
      const text = page(code);
      const positions = LABELS.map((label) => {
        const found = [...text.matchAll(new RegExp(`^${label} `, "gm"))];
        assert.equal(found.length, 1, `${code} has ${String(found.length)} "${label}" lines`);
        return found[0]?.index ?? -1;
      });
      assert.deepEqual(
        positions,
        positions.toSorted((a, b) => a - b),
        `${code}: labels out of order`,
      );
    }
  });

  it("puts the template's H2s in order, with How to fix as the first H2 (decision 0064)", () => {
    const required = SECTIONS.map((section) => section.heading);
    for (const code of ERROR_CODES) {
      const found = headings(page(code)).map((each) => each.heading);
      assert.equal(found[0], "How to fix", `${code}: the first H2`);
      assert.deepEqual(
        found.filter((heading) => required.includes(heading)),
        required,
        `${code}: the template's H2s, once each, in order`,
      );
    }
  });

  it("opens How to fix with the fix itself, without a Fix: label (#379)", () => {
    for (const code of ERROR_CODES) {
      const text = page(code);
      const fix = fixParagraph(text);
      assert.match(fix, /^[A-Z]/u, `${code}: the fix starts with a capital letter`);
      assert.doesNotMatch(fix, /^(Fix|From the CLI):/u, `${code}: the fix has a label`);
      assert.equal(labelAt(text, "Fix:"), -1, `${code}: a Fix: line`);
    }
  });

  it("puts each labelled line in its H2", () => {
    for (const code of ERROR_CODES) {
      const text = page(code);
      for (const section of SECTIONS) {
        for (const label of section.labels) {
          assert.equal(sectionAt(text, labelAt(text, label)), section.heading, `${code}: ${label}`);
        }
      }
    }
  });

  it("opens with a one-sentence summary and starts the fix within 40 words of the H1", () => {
    for (const code of ERROR_CODES) {
      const text = page(code);
      const head = text.slice(text.indexOf("\n"), fixAt(text));
      const count = words(head);
      assert.ok(count <= FIX_WITHIN_WORDS, `${code}: ${String(count)} words before the fix`);
      const summary = head
        .split("\n\n")
        .map((block) => block.trim())
        .filter((block) => block !== "" && !block.startsWith("#"))
        .filter((block) => !/^(Version|Agents): /.test(block));
      assert.equal(summary.length, 1, `${code}: one summary paragraph`);
      const sentence = (summary[0] ?? "").replace(/`[^`]*`/g, "code");
      assert.match(sentence, /^[^.]*\.$/, `${code}: the summary is one sentence`);
    }
  });

  it("shows a check of the error's code under In code", () => {
    for (const code of ERROR_CODES) {
      const text = page(code);
      const start = headings(text).find((each) => each.heading === "In code")?.at ?? -1;
      const block = /```ts[^\n]*\n([\s\S]*?)```/.exec(text.slice(start))?.[1] ?? "";
      assert.ok(block.includes(`"${code}"`), `${code}: no ts block that checks the code`);
    }
  });

  it("states the catalogue's default hint on each page", () => {
    for (const code of ERROR_CODES) {
      assert.equal(paragraph(page(code), "Default hint:"), error(code).hint, code);
    }
  });

  it("states the end-user hint of hintFor on each page (#298)", () => {
    for (const code of ERROR_CODES) {
      const hint = hintFor(newError(pageDetails(code), "m", { secrets: [] }), "user");
      assert.equal(paragraph(page(code), "For end users:"), hint, code);
    }
  });

  it("states the catalogue's retry flag on each page", () => {
    for (const code of ERROR_CODES) {
      const retry = /^Retryable: (yes|no)\b/m.exec(page(code))?.[1];
      assert.equal(retry, error(code).retryable ? "yes" : "no", code);
    }
  });

  it("states the exit code from ERROR_EXIT_CODES on each page (R-AX-7)", () => {
    for (const code of ERROR_CODES) {
      const stated = /^Exit code: (\d+)$/m.exec(page(code))?.[1];
      assert.equal(Number(stated), ERROR_EXIT_CODES[code], code);
    }
  });

  it("links each page back to the index", () => {
    for (const code of ERROR_CODES) {
      assert.match(page(code), /\]\(index\.md\)/, code);
    }
  });

  it("holds nothing but the index and one page per code or released code", () => {
    const allowed = new Set([...codes, ...released().keys()].map((code) => `${code}.md`));
    allowed.add("index.md");
    const entries = readdirSync(PAGES, { withFileTypes: true });
    for (const entry of entries) {
      assert.ok(entry.isFile(), `${entry.name} is not a file`);
      assert.ok(allowed.has(entry.name), `${entry.name} is not a code page`);
    }
    assert.equal(entries.length, allowed.size);
  });
});

describe("docsUrl (R-AX-10)", () => {
  it("is the code's own page, with no fragment and no query", () => {
    for (const code of ERROR_CODES) {
      const url = new URL(error(code).docsUrl);
      assert.equal(url.hash, "", code);
      assert.equal(url.search, "", code);
      assert.equal(error(code).docsUrl, docsUrlOf(code));
    }
  });

  it("maps to a file in the repository", () => {
    for (const code of ERROR_CODES) {
      const path = docsFileOf(error(code).docsUrl);
      assert.equal(path, `docs/user/reference/errors/${code}.md`);
      assert.ok(existsSync(new URL(path, REPOSITORY)), `${path} does not exist`);
    }
  });

  it("is the same in toJSON()", () => {
    for (const code of ERROR_CODES) {
      assert.equal(error(code).toJSON().docsUrl, error(code).docsUrl);
    }
  });
});

describe("released codes (R-AX-10 stub rule)", () => {
  it("maps each code, in the code format, to the version that first shipped it", () => {
    for (const [code, version] of released()) {
      assert.match(code, /^[a-z0-9]+(-[a-z0-9]+)*$/);
      assert.match(version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, code);
    }
  });

  it("has a page for every released code", () => {
    for (const code of released().keys()) {
      assert.ok(existsSync(new URL(`${code}.md`, PAGES)), `released code ${code} has no page`);
    }
  });

  it("says on a removed code's page when it went, after it shipped, and links its replacement", () => {
    for (const [code, first] of released()) {
      if (codes.includes(code)) {
        continue;
      }
      const text = page(code);
      const removed = /Removed in (\d+\.\d+\.\d+)/.exec(text)?.[1];
      assert.ok(removed !== undefined, `${code}: no "Removed in X.Y.Z"`);
      assert.ok(later(removed, first), `${code}: removed in ${removed}, first shipped in ${first}`);
      const replaced = [...text.matchAll(/\]\(([a-z0-9-]+)\.md\)/g)].some((match) =>
        codes.includes(match[1] ?? ""),
      );
      assert.ok(replaced, `${code}: links no current code as its replacement`);
    }
  });

  it("orders versions on major, minor and patch", () => {
    assert.equal(later("0.2.0", "0.1.0"), true);
    assert.equal(later("1.0.0", "0.9.9"), true);
    assert.equal(later("0.1.0", "0.1.0"), false);
    assert.equal(later("0.1.0", "0.2.0-beta.1"), false);
  });
});

describe("error index page (R-AX-7, R-AX-10)", () => {
  const index = read(new URL("index.md", PAGES));

  it("links every code's page once", () => {
    for (const code of ERROR_CODES) {
      const links = index.split(`](${code}.md)`).length - 1;
      assert.equal(links, 1, `index links ${code}.md ${String(links)} times`);
    }
  });

  it("lists each code in the row of its exit code in the exit code table", () => {
    const rows = new Map(
      [...index.matchAll(/^\| (\d+) +\|[^|]*\|([^|]*)\|$/gm)].map((match) => [
        Number(match[1]),
        match[2] ?? "",
      ]),
    );
    assert.deepEqual([...rows.keys()], [0, 1, 2, 3, 4, 5, 6, 130]);
    for (const code of ERROR_CODES) {
      const holding = [...rows].filter(([, cell]) => cell.includes(`\`${code}\``));
      assert.deepEqual(
        holding.map(([exit]) => exit),
        [ERROR_EXIT_CODES[code]],
        `${code} must appear in exactly the row for exit code ${String(ERROR_EXIT_CODES[code])}`,
      );
    }
  });

  it("says the explorer definitively rejected a failed submission", () => {
    assert.match(index, /^\| 1 +\| `failed`: the explorer definitively rejected the submission/m);
  });

  it("states the boundary between unexpected-response and unknown-state", () => {
    assert.match(index, /`unexpected-response` and `unknown-state` differ in who answered/);
  });
});

describe("the error table of the guide for wrapping tools (R-AX-2, R-AX-7)", () => {
  const guide = read(new URL("docs/user/guides/wrap-explorer-verify-in-your-tool.md", REPOSITORY));
  // | [`code`](../reference/errors/code.md) | yes | 4 | `kind` | text |
  const rows = [
    ...guide.matchAll(
      /^\| \[`([a-z-]+)`\]\(\.\.\/reference\/errors\/([a-z-]+)\.md\) +\| (yes|no) +\| (\d+) +\| `([a-z-]+)` +\|/gm,
    ),
  ].map((match) => ({
    code: match[1] ?? "",
    page: match[2] ?? "",
    retryable: match[3] === "yes",
    exit: Number(match[4]),
    kind: match[5] ?? "",
  }));

  it("lists every code in ERROR_CODES once, in catalogue order, linking its page", () => {
    assert.deepEqual(
      rows.map((row) => row.code),
      codes,
    );
    for (const row of rows) {
      assert.equal(row.page, row.code, `${row.code} links another code's page`);
    }
  });

  it("states each code's retry flag and exit code as the catalogue does", () => {
    for (const code of ERROR_CODES) {
      const row = rows.find((found) => found.code === code);
      assert.ok(row, code);
      assert.equal(row.retryable, error(code).retryable, `${code}: retryable`);
      assert.equal(row.exit, ERROR_EXIT_CODES[code], `${code}: exit code`);
    }
  });

  it("gives each code the kind that the example's KIND map gives it", () => {
    const block = /^const KIND: [^\n]*\{\n([\s\S]*?)^\};/m.exec(guide)?.[1] ?? "";
    const kinds = new Map(
      [...block.matchAll(/^ {2}"?([a-z-]+)"?: "([a-z-]+)",$/gm)].map((match) => [
        match[1] ?? "",
        match[2] ?? "",
      ]),
    );
    assert.deepEqual([...kinds.keys()], codes);
    for (const row of rows) {
      assert.equal(row.kind, kinds.get(row.code), `${row.code}: kind`);
    }
  });
});
