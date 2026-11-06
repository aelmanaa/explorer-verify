// The API reference helpers (R-AX-2, R-DX-4, decision 0015): the entry points read from each
// package's `exports`, the generated pages, and the checks on them. The TypeDoc run itself,
// site/api-reference.ts, runs in the CI `site` job.
import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  API_OUT,
  API_TITLE,
  apiEntryPoints,
  apiPageName,
  apiPages,
  apiProblems,
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
        ["explorer-verify/server", "packages/explorer-verify/src/server/handler.ts"],
        ["explorer-verify/resolve", "packages/explorer-verify/src/input/resolvers/bytecode.ts"],
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
  it("lists the index first, then the pages in path order, each with its first heading", () => {
    writeFiles(root, {
      [`${API_OUT}/b.md`]: "# b\n",
      [`${API_OUT}/a/server.md`]: "# a/server\n",
      [`${API_OUT}/index.md`]: `# ${API_TITLE}\n`,
      [`${API_OUT}/untitled.md`]: "No heading.\n",
      [`${API_OUT}/style.css`]: "",
    });
    assert.deepEqual(apiPages(path.join(root, API_OUT)), [
      { page: "index.md", title: API_TITLE },
      { page: "a/server.md", title: "a/server" },
      { page: "b.md", title: "b" },
      { page: "untitled.md", title: "untitled.md" },
    ]);
  });

  it("gives no pages when the folder does not exist", () => {
    assert.deepEqual(apiPages(path.join(root, API_OUT)), []);
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

  it("passes an index and a page per entry point, with `{{` only in code", () => {
    writeFiles(root, {
      [`${API_OUT}/index.md`]: `# ${API_TITLE}\n`,
      [`${API_OUT}/core.md`]:
        "# core\n\nA `{{ code }}` span.\n\n```ts\nconst a = { b: {} };\n```\n",
      [`${API_OUT}/core-server.md`]: "# core/server\n",
    });
    assert.deepEqual(apiProblems(path.join(root, API_OUT), entryPoints), []);
  });

  it("reports a page that shares its name with a folder (R-AX-17)", () => {
    const directory = path.join(root, API_OUT);
    writeFiles(root, {
      [`${API_OUT}/index.md`]: `# ${API_TITLE}\n`,
      [`${API_OUT}/core.md`]: "# core\n",
      [`${API_OUT}/core/server.md`]: "# core/server\n",
    });
    assert.deepEqual(apiProblems(directory, entryPoints), [
      `${directory}/core.md has a folder of the same name; a link to the page would reach the folder (R-AX-17)`,
    ]);
  });

  it("reports a missing index, a missing page and `{{` in prose (R-AX-2, R-AX-17)", () => {
    const directory = path.join(root, API_OUT);
    writeFiles(root, {
      [`${API_OUT}/index.md`]: "# Something else\n",
      [`${API_OUT}/core.md`]: "# core\n\nSee {{ value }}.\n",
    });
    assert.deepEqual(apiProblems(directory, entryPoints), [
      `${directory} has no index.md titled "${API_TITLE}" (R-AX-2)`,
      `${directory} has no page for core/server (R-AX-2)`,
      `${directory}/core.md:3: holds {{ outside code; the docs site would evaluate it as a Vue expression. Put it in a code span or a code block (R-AX-17)`,
    ]);
  });
});
