// The docs check of the guide docs/user/guides/run-the-server-handler.md: it makes each statement
// R-SEC-5 requires, with the link to Etherscan's API terms and the date they were read, and each
// code block titled with an example file's path is that file, unchanged, so the code the guide
// shows is the code CI type-checks and tests (R-SRV-1, R-SRV-5).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const GUIDE = "docs/user/guides/run-the-server-handler.md";
const root = new URL("../../", import.meta.url);
const guide = readFileSync(new URL(GUIDE, root), "utf8");
/** The guide's prose, with lines rejoined, so a statement may wrap. */
const prose = guide.replaceAll(/\s+/g, " ");

/**
 * The example files the guide shows, in the order it shows them, each with the title of its block:
 * the file's path in its example project.
 */
const SHOWN: readonly (readonly [title: string, file: string])[] = [
  ["app/api/verify/route.ts", "examples/server-nextjs/app/api/verify/route.ts"],
  ["wrangler.jsonc", "examples/server-cloudflare/wrangler.jsonc"],
  ["src/index.ts", "examples/server-cloudflare/src/index.ts"],
  ["lib/verify-client.ts", "examples/server-nextjs/lib/verify-client.ts"],
  ["client/verify-client.ts", "examples/server-cloudflare/client/verify-client.ts"],
];
const TITLES: ReadonlySet<string> = new Set(SHOWN.map(([title]) => title));

/** The ts and jsonc blocks of the guide titled with an example file, in order. */
function codeBlocks(text: string): { title: string; code: string }[] {
  return [...text.matchAll(/^```(?:ts|jsonc) \[([^\]\n]+)\]\n([\s\S]*?)^```$/gm)]
    .map((match) => ({ title: match[1] ?? "", code: match[2] ?? "" }))
    .filter(({ title }) => TITLES.has(title));
}

describe(GUIDE, () => {
  it("R-SEC-5: links Etherscan's API terms with the date they were read", () => {
    assert.match(guide, /\[Etherscan's API terms\]\(https:\/\/etherscan\.io\/apiterms\)/);
    assert.match(prose, /This project read them on \d{4}-\d{2}-\d{2}/);
  });

  const statements: readonly [string, RegExp][] = [
    [
      "the operator uses their own key on their own server",
      /You use your own key, on your own server\./,
    ],
    [
      "the handler is part of the application, not a relay for other applications",
      /The handler is part of your application\. Do not offer it as a relay to other applications\./,
    ],
    [
      "the terms forbid a key in client code and a proxy that passes API data to third parties",
      /The terms forbid exposing a key in client code.*"an API proxy, gateway, relay or data feed that passes API Data through to third parties"/,
    ],
    [
      "whether it counts as such a proxy is this project's reading, not legal advice; confirm with Etherscan",
      /this project's reading, not legal advice\. Confirm with Etherscan\./,
    ],
    [
      "it forwards only submit, status and a reduced read-only lookup",
      /forwards only the verify-submit action, `verifysourcecode`, the status action, `checkverifystatus`, and a read-only lookup, `getsourcecode`, whose answer it reduces/,
    ],
  ];
  for (const [what, pattern] of statements) {
    it(`R-SEC-5: says ${what}`, () => {
      assert.match(prose, pattern);
    });
  }

  it("shows each example file unchanged, titled with its path", () => {
    const blocks = codeBlocks(guide);
    assert.deepEqual(
      blocks.map(({ title }) => title),
      SHOWN.map(([title]) => title),
    );
    SHOWN.forEach(([, file], index) => {
      assert.equal(blocks[index]?.code, readFileSync(new URL(file, root), "utf8"), file);
    });
  });
});
