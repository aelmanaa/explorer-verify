// The API reference helpers (R-AX-2, R-DX-4, decision 0015): the entry points read from each
// package's `exports`, the generated pages, and the checks on them. The TypeDoc run itself,
// site/api-reference.ts, runs in the CI `site` job.
import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  API_GROUP_ORDER,
  API_LEADING_FUNCTIONS,
  API_OUT,
  API_TITLE,
  apiDescription,
  apiEntryPoints,
  apiPageName,
  apiPages,
  apiProblems,
  apiTitles,
  isApiEntryPage,
  isRepositorySource,
  orderApiMembers,
} from "../site-api.ts";
import { makeFixture, removeFixture, writeFiles } from "./fixture.ts";

let root = "";

beforeEach(() => {
  root = makeFixture();
});

afterEach(() => {
  removeFixture(root);
});

const manifest = (value: unknown): string => JSON.stringify(value);

describe("apiEntryPoints", () => {
  it("lists each export with types, in folder and export order, named as users import it", () => {
    writeFiles(root, {
      // The fixture's core manifest has no `exports`, so it has no API.
      "packages/b-helper/package.json": manifest({
        name: "@scope/helper",
        exports: {
          ".": { types: "./dist/src/index.d.ts", default: "./dist/src/index.js" },
          "./package.json": "./package.json",
        },
      }),
      "packages/b-helper/src/index.ts": "",
      "packages/a-core/package.json": manifest({
        name: "core",
        exports: {
          ".": { types: "./dist/src/index.d.ts", default: "./dist/src/index.js" },
          "./server": { types: "./dist/src/server/handler.d.ts" },
          "./schema.json": "./schema/schema.json",
          "./odd": { types: "./types/odd.ts" },
          "./other": { default: "./dist/src/other.js" },
        },
      }),
      "packages/a-core/src/index.ts": "",
      "packages/a-core/src/server/handler.ts": "",
      "packages/cli/package.json": manifest({ name: "cli", bin: { cli: "./dist/src/bin.js" } }),
      "packages/notes/README.md": "# Not a package\n",
    });
    assert.deepEqual(apiEntryPoints(root), [
      { name: "core", packageName: "core", source: "packages/a-core/src/index.ts" },
      {
        name: "core/server",
        packageName: "core",
        source: "packages/a-core/src/server/handler.ts",
      },
      {
        name: "@scope/helper",
        packageName: "@scope/helper",
        source: "packages/b-helper/src/index.ts",
      },
    ]);
  });

  it("throws when a manifest has no name", () => {
    writeFiles(root, { "packages/x/package.json": manifest({ exports: {} }) });
    assert.throws(() => apiEntryPoints(root), /^Error: packages\/x\/package\.json has no name$/);
  });

  it("throws when the source of a declaration is missing", () => {
    writeFiles(root, {
      "packages/x/package.json": manifest({
        name: "x",
        exports: { ".": { types: "./dist/src/index.d.ts" } },
      }),
    });
    assert.throws(
      () => apiEntryPoints(root),
      /^Error: packages\/x\/package\.json: the export \. has no source packages\/x\/src\/index\.ts$/,
    );
  });
});

describe("apiEntryPoints on this repository", () => {
  it("documents every package export that has types, and nothing else (R-AX-2)", () => {
    const repository = path.resolve(import.meta.dirname, "../..");
    assert.deepEqual(
      apiEntryPoints(repository).map(({ name, source }) => [name, source]),
      [
        ["explorer-verify", "packages/explorer-verify/src/index.ts"],
        ["explorer-verify/handle", "packages/explorer-verify/src/entries/handle.ts"],
        ["explorer-verify/errors", "packages/explorer-verify/src/entries/errors.ts"],
        ["explorer-verify/backends", "packages/explorer-verify/src/entries/backends.ts"],
        ["explorer-verify/envelope", "packages/explorer-verify/src/entries/envelope.ts"],
        ["explorer-verify/server", "packages/explorer-verify/src/server/handler.ts"],
        ["explorer-verify/resolve", "packages/explorer-verify/src/input/resolvers/bytecode.ts"],
        ["explorer-verify/sources", "packages/explorer-verify/src/input/sources.ts"],
        ["explorer-verify/core", "packages/explorer-verify/src/core/index.ts"],
        ["explorer-verify/table", "packages/explorer-verify/src/core/table.ts"],
        ["explorer-verify/clients/sourcify", "packages/explorer-verify/src/clients/sourcify.ts"],
        [
          "explorer-verify/clients/etherscan-v2",
          "packages/explorer-verify/src/clients/etherscan-v2.ts",
        ],
        [
          "explorer-verify/clients/etherscan-compatible",
          "packages/explorer-verify/src/clients/etherscan-compatible.ts",
        ],
        ["explorer-verify/clients/routescan", "packages/explorer-verify/src/clients/routescan.ts"],
        [
          "explorer-verify/clients/blockscout",
          "packages/explorer-verify/src/clients/blockscout.ts",
        ],
        ["@explorer-verify/foundry", "packages/foundry/src/index.ts"],
        ["@explorer-verify/hardhat", "packages/hardhat/src/index.ts"],
      ],
    );
  });
});

describe("apiPages", () => {
  it("lists the index first, then each folder's index before its pages, each with its first heading", () => {
    writeFiles(root, {
      [`${API_OUT}/core-server/index.md`]: "# core/server\n",
      [`${API_OUT}/core/functions/verify.md`]: "[API reference](../../index.md)\n\n# verify\n",
      [`${API_OUT}/core/classes/Error.md`]: "# Error\n",
      [`${API_OUT}/core/index.md`]: "# core\n",
      [`${API_OUT}/index.md`]: `# ${API_TITLE}\n`,
      [`${API_OUT}/b.md`]: "# b\n",
      [`${API_OUT}/untitled.md`]: "No heading.\n",
      [`${API_OUT}/style.css`]: "",
    });
    assert.deepEqual(apiPages(path.join(root, API_OUT)), [
      { page: "index.md", title: API_TITLE },
      { page: "b.md", title: "b" },
      { page: "core/index.md", title: "core" },
      { page: "core/classes/Error.md", title: "Error" },
      { page: "core/functions/verify.md", title: "verify" },
      { page: "core-server/index.md", title: "core/server" },
      { page: "untitled.md", title: "untitled.md" },
    ]);
  });

  it("gives no pages when the folder does not exist", () => {
    assert.deepEqual(apiPages(path.join(root, API_OUT)), []);
  });
});

describe("isApiEntryPage", () => {
  it("is true for the index and the page of an entry point, false for a member's page", () => {
    assert.equal(isApiEntryPage("index.md"), true);
    assert.equal(isApiEntryPage("explorer-verify/index.md"), true);
    assert.equal(isApiEntryPage("explorer-verify/functions/verify.md"), false);
    assert.equal(isApiEntryPage("explorer-verify/functions/index.md"), false);
    assert.equal(isApiEntryPage("explorer-verify.md"), false);
  });
});

/** `list` as `orderApiMembers` orders members of those names. */
function names(list: readonly string[]): string[] {
  return orderApiMembers(list.map((name) => ({ name }))).map(({ name }) => name);
}

describe("orderApiMembers", () => {
  it("puts the flow functions first, in their order, and keeps the others in their order", () => {
    assert.deepEqual(
      names(["buildVerifyInput", "checkStatus", "dryRun", "formatHandle", "linkProxy", "verify"]),
      ["verify", "dryRun", "checkStatus", "linkProxy", "buildVerifyInput", "formatHandle"],
    );
    assert.deepEqual(names(["b", "a"]), ["b", "a"]);
    assert.deepEqual(names(API_LEADING_FUNCTIONS.toReversed()), [...API_LEADING_FUNCTIONS]);
  });

  it("returns a new array", () => {
    const members = [{ name: "dryRun" }, { name: "verify" }];
    assert.notEqual(orderApiMembers(members), members);
    assert.deepEqual(members, [{ name: "dryRun" }, { name: "verify" }]);
  });
});

describe("API_GROUP_ORDER", () => {
  it("lists functions first, then classes, types and constants", () => {
    assert.deepEqual(API_GROUP_ORDER, [
      "Functions",
      "Classes",
      "Interfaces",
      "Type Aliases",
      "Variables",
      "*",
    ]);
  });
});

describe("isRepositorySource", () => {
  it("is true for a file in the repository, false outside it or under node_modules", () => {
    const repository = path.join(root, "repository");
    assert.equal(
      isRepositorySource(repository, path.join(repository, "packages/a/src/x.ts")),
      true,
    );
    assert.equal(isRepositorySource(repository, path.join(root, "other/x.ts")), false);
    assert.equal(isRepositorySource(repository, repository), false);
    assert.equal(
      isRepositorySource(
        repository,
        path.join(repository, "node_modules/typescript/lib/lib.es5.d.ts"),
      ),
      false,
    );
    assert.equal(
      isRepositorySource(repository, path.join(repository, "site/node_modules/@types/node/x.d.ts")),
      false,
    );
  });
});

describe("apiPageName", () => {
  it("drops the scope and turns each slash into a hyphen, so no page is also a folder", () => {
    assert.equal(apiPageName("explorer-verify"), "explorer-verify");
    assert.equal(apiPageName("explorer-verify/server"), "explorer-verify-server");
    assert.equal(apiPageName("@explorer-verify/foundry"), "foundry");
    assert.equal(apiPageName("@scope/pkg/sub/path"), "pkg-sub-path");
  });
});

describe("apiProblems", () => {
  const entryPoints = [
    { name: "core", packageName: "core", source: "packages/core/src/index.ts" },
    { name: "core/server", packageName: "core", source: "packages/core/src/server.ts" },
  ];

  const index = `# ${API_TITLE}

## Modules

| Module | Description |
| ------ | ------ |
| [core](core/index.md) | Verifies contracts. |
| [core/server](core-server/index.md) | The server handler. |
`;

  it("passes an index that describes each entry point, and its pages, with `{{` only in code", () => {
    writeFiles(root, {
      [`${API_OUT}/index.md`]: index,
      [`${API_OUT}/core/index.md`]:
        "# core\n\nA `{{ code }}` span.\n\n```ts\nconst a = { b: {} };\n```\n",
      [`${API_OUT}/core/functions/verify.md`]: "# Function: verify()\n",
      [`${API_OUT}/core-server/index.md`]: "# core/server\n",
    });
    assert.deepEqual(apiProblems(path.join(root, API_OUT), entryPoints), []);
  });

  it("reports a page that shares its name with a folder (R-AX-17)", () => {
    const directory = path.join(root, API_OUT);
    writeFiles(root, {
      [`${API_OUT}/index.md`]: index,
      [`${API_OUT}/core/index.md`]: "# core\n",
      [`${API_OUT}/core/functions.md`]: "# functions\n",
      [`${API_OUT}/core/functions/verify.md`]: "# Function: verify()\n",
      [`${API_OUT}/core-server/index.md`]: "# core/server\n",
    });
    assert.deepEqual(apiProblems(directory, entryPoints), [
      `${directory}/core/functions.md has a folder of the same name; a link to the page would reach the folder (R-AX-17)`,
    ]);
  });

  it("reports an entry point the index lists without a description (R-AX-2)", () => {
    const directory = path.join(root, API_OUT);
    writeFiles(root, {
      [`${API_OUT}/index.md`]: index.replace("The server handler.", "-"),
      [`${API_OUT}/core/index.md`]: "# core\n",
      [`${API_OUT}/core-server/index.md`]: "# core/server\n",
    });
    assert.deepEqual(apiProblems(directory, entryPoints), [
      `${directory}/index.md lists core/server without a description; give its entry point a @packageDocumentation comment (R-AX-2)`,
    ]);
  });

  it("reports a missing index, a missing or misplaced page and `{{` in prose (R-AX-2, R-AX-17)", () => {
    const directory = path.join(root, API_OUT);
    writeFiles(root, {
      [`${API_OUT}/index.md`]: "# Something else\n",
      [`${API_OUT}/core/index.md`]: "# core\n\nSee {{ value }}.\n",
      [`${API_OUT}/core-server.md`]: "# core/server\n",
    });
    assert.deepEqual(apiProblems(directory, entryPoints), [
      `${directory} has no index.md titled "${API_TITLE}" (R-AX-2)`,
      `${directory} has no page core-server/index.md titled core/server (R-AX-2)`,
      `${directory}/core/index.md:3: holds {{ outside code; the docs site would evaluate it as a Vue expression. Put it in a code span or a code block (R-AX-17)`,
    ]);
  });
});

describe("apiDescription (R-AX-17)", () => {
  it("names the member and its entry point, then the summary's sentences that fit", () => {
    assert.equal(
      apiDescription(
        "Function: verify()",
        "explorer-verify/core",
        "Verifies a contract's source, as `verify()` does.\nSee [the guide](../x.md).",
      ),
      "verify() in explorer-verify/core: Verifies a contract's source, as verify() does. See the guide.",
    );
    assert.equal(
      apiDescription("explorer-verify/server", "explorer-verify/server", "A request handler."),
      "explorer-verify/server: A request handler.",
    );
    assert.equal(
      apiDescription("Variable: DEFAULT\\_MAX", "explorer-verify/server", "The limit."),
      "DEFAULT_MAX in explorer-verify/server: The limit.",
    );
  });

  it("stops before a sentence that would pass 160 characters, and cuts a first sentence at a word", () => {
    const long = `${"word ".repeat(40).trim()}.`;
    const kept = apiDescription("Type Alias: X", "e", `Short one. ${long}`);
    assert.equal(kept, "X in e: Short one.");
    const cut = apiDescription("Type Alias: X", "e", long);
    assert.ok(cut.length <= 160, String(cut.length));
    assert.match(cut, /^X in e: word( word)*…$/);
  });
});

describe("apiTitles (R-AX-17)", () => {
  it("adds the entry point to the title of a member two entry points export, and only to it", () => {
    const titles = apiTitles([
      { page: "index.md", title: "API reference" },
      { page: "a/index.md", title: "explorer-verify" },
      { page: "a/functions/verify.md", title: "Function: verify()" },
      { page: "a/functions/only.md", title: "Function: only()" },
      { page: "b/index.md", title: "explorer-verify/core" },
      { page: "b/functions/verify.md", title: "Function: verify()" },
    ]);
    assert.deepEqual(
      [...titles],
      [
        ["a/functions/verify.md", "verify() (explorer-verify)"],
        ["b/functions/verify.md", "verify() (explorer-verify/core)"],
      ],
    );
  });
});
