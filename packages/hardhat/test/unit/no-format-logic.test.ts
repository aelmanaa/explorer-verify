// R-DX-2: the helper holds no format logic. It locates and reads files; buildVerifyInput from the
// core is the only code that reads the compiler input, the version and the contract name.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

// Every module the package source may import.
const ALLOWED_IMPORTS = new Set(["explorer-verify", "node:fs/promises", "node:path", "./find.ts"]);
// The only fields the helper reads from a document: the links between Hardhat's files.
const ALLOWED_FIELDS = new Set(["buildInfoId", "buildInfo"]);
// Fields of the compiler input, the build-info and the artifact that only the core may read.
// `input` is left out: it is also the `details.field` value of an `incomplete-input` error, and
// the member check below covers it.
const FORMAT_FIELDS = [
  "output",
  "sources",
  "settings",
  "language",
  "solcVersion",
  "solcLongVersion",
  "userSourceNameMap",
  "inputSourceName",
  "sourceName",
  "contractName",
  "metadata",
  "compilerType",
  "_format",
  "abi",
  "bytecode",
  "deployedBytecode",
  "linkReferences",
  "deployedLinkReferences",
  "version",
  "compiler",
  "optimizer",
  "evmVersion",
];

async function sources(): Promise<Map<string, string>> {
  const files = (await readdir(SRC)).filter((file) => file.endsWith(".ts"));
  const texts = new Map<string, string>();
  for (const file of files) {
    texts.set(file, await readFile(path.join(SRC, file), "utf8"));
  }
  return texts;
}

/** `text` without comments, so TSDoc prose is not mistaken for code. */
function code(text: string): string {
  return text.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "");
}

describe("R-DX-2: no format logic in @explorer-verify/hardhat", () => {
  it("imports only the core, node:fs/promises and node:path", async () => {
    for (const [file, text] of await sources()) {
      for (const match of text.matchAll(/^(?:import|export)\b[^;]*?from "([^"]+)";/gms)) {
        assert.ok(ALLOWED_IMPORTS.has(String(match[1])), `${file} imports ${String(match[1])}`);
      }
    }
  });

  it("loads no module at run time and imports no deep path of the core", async () => {
    for (const [file, text] of await sources()) {
      const body = code(text);
      for (const pattern of [/\bimport\s*\(/, /\brequire\s*\(/, /\bcreateRequire\b/]) {
        assert.ok(!pattern.test(body), `${file} matches ${String(pattern)}`);
      }
      assert.ok(!text.includes('"explorer-verify/'), `${file} imports a deep path of the core`);
    }
  });

  it("reads only buildInfoId and buildInfo from the documents", async () => {
    const read = new Set<string>();
    for (const text of (await sources()).values()) {
      for (const match of code(text).matchAll(/\bownField\([^,]+, "([^"]+)"\)/g)) {
        read.add(String(match[1]));
      }
    }
    // The options reader uses the same function on the options object.
    for (const option of ["root", "contract", "outDir", "artifact"]) {
      read.delete(option);
    }
    assert.deepEqual(read, ALLOWED_FIELDS);
  });

  it("names no field of the compiler input, the build-info or the artifact in code", async () => {
    for (const [file, text] of await sources()) {
      const body = code(text);
      for (const name of FORMAT_FIELDS) {
        assert.ok(!body.includes(`"${name}"`), `${file} names "${name}"`);
      }
      for (const name of ["input", ...FORMAT_FIELDS]) {
        // A member read such as `document.output` or `x?.output`; `${id}.output.json` is a file name.
        assert.ok(!new RegExp(`[\\w)\\]]\\??\\.${name}\\b`).test(body), `${file} reads .${name}`);
      }
    }
  });

  it("builds the input only through buildVerifyInput from the core", async () => {
    const texts = await sources();
    const index = texts.get("index.ts") ?? "";
    assert.match(index, /import \{ buildVerifyInput \} from "explorer-verify";/);
    assert.match(code(index), /return buildVerifyInput\(build\.documents, \{/);
  });
});
