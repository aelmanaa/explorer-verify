// Import directives and solc's import path resolution, for buildVerifyInputFromSources (R-IN-7).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { importPaths, parseRemapping, resolveImport } from "../../src/input/imports.ts";
import type { Remapping } from "../../src/input/imports.ts";

function remappings(...list: string[]): Remapping[] {
  return list.map((text) => {
    const parsed = parseRemapping(text);
    assert.ok(parsed, text);
    return parsed;
  });
}

describe("importPaths", () => {
  it("reads the path of each of the four import forms", () => {
    const source = [
      'import "./A.sol";',
      'import "./B.sol" as B;',
      "import * as C from './C.sol';",
      'import {D, E as F} from "@lib/D.sol";',
      "",
    ].join("\n");
    assert.deepEqual(importPaths(source), ["./A.sol", "./B.sol", "./C.sol", "@lib/D.sol"]);
  });

  it("ignores imports in line comments, block comments and string literals", () => {
    const source = [
      '// import "./Line.sol";',
      '/* import "./Block.sol";',
      '   import "./Block2.sol"; */',
      'string constant S = "import \\"./String.sol\\";";',
      "string constant T = 'import \"./Single.sol\";';",
      'import "./Real.sol";',
      "",
    ].join("\n");
    assert.deepEqual(importPaths(source), ["./Real.sol"]);
  });

  it("skips comments inside a directive and reads the path after them", () => {
    assert.deepEqual(
      importPaths('import /* "./No.sol" */ {A} // "./Neither.sol"\n from "./Yes.sol";'),
      ["./Yes.sol"],
    );
  });

  it("reads import only as a whole word", () => {
    assert.deepEqual(
      importPaths('uint importer = 1; string s = "x"; myimport("./No.sol"); import "./Yes.sol";'),
      ["./Yes.sol"],
    );
  });

  it("lists each path once, in the order it first appears", () => {
    assert.deepEqual(
      importPaths('import "./A.sol"; import {X} from "./A.sol"; import "./B.sol";'),
      ["./A.sol", "./B.sol"],
    );
  });

  it("decodes escapes in the path", () => {
    assert.deepEqual(
      importPaths(
        'import "\\x41.sol"; import "\\u0042.sol"; import "\\n\\r\\t\\\\.sol"; import "\\xZZ.sol";',
      ),
      ["A.sol", "B.sol", "\n\r\t\\.sol", "xZZ.sol"],
    );
  });

  it("reads \\x escapes as bytes and decodes the path as UTF-8", () => {
    assert.deepEqual(
      importPaths('import "\\xc3\\xa9.sol"; import "\\u00e9t\\u00e9.sol"; import "\\x4.sol";'),
      ["é.sol", "été.sol", "x4.sol"],
    );
    assert.deepEqual(importPaths('import "é/😀.sol"; import "\\u2603.sol";'), [
      "é/😀.sol",
      "☃.sol",
    ]);
  });

  it("reads a backslash before LF, CR or CRLF as a line continuation", () => {
    assert.deepEqual(
      importPaths('import "a\\\nb.sol"; import "c\\\rd.sol"; import "e\\\r\nf.sol";'),
      ["ab.sol", "cd.sol", "ef.sol"],
    );
  });

  it("ends a line comment at CR as well as at LF", () => {
    assert.deepEqual(importPaths('// note\rimport "./b.sol";'), ["./b.sol"]);
    assert.deepEqual(importPaths('// note\r\nimport "./c.sol";'), ["./c.sol"]);
  });

  it("ends a string at CR", () => {
    assert.deepEqual(importPaths('string s = "open\rimport "./Next.sol";'), ["./Next.sol"]);
  });

  it("gives no path for a directive without a string, and stops at the end of the text", () => {
    assert.deepEqual(importPaths("import {A} from B;"), []);
    assert.deepEqual(importPaths('import "./Open.sol"'), ["./Open.sol"]);
    assert.deepEqual(importPaths("import {A"), []);
  });

  it("ends a string at a line break or the end of the text", () => {
    assert.deepEqual(importPaths('string s = "open\nimport "./Next.sol";'), ["./Next.sol"]);
    assert.deepEqual(importPaths('import "./Cut\n.sol";'), ["./Cut"]);
    assert.deepEqual(importPaths('"never closed'), []);
  });

  it("reads to the end of an unterminated comment", () => {
    assert.deepEqual(importPaths('/* import "./A.sol";'), []);
    assert.deepEqual(importPaths('// import "./A.sol";'), []);
    assert.deepEqual(importPaths('import /* "./A.sol"'), []);
  });
});

describe("parseRemapping", () => {
  it("splits context:prefix=target as solc does", () => {
    assert.deepEqual(parseRemapping("@a/=lib/a/"), {
      context: "",
      prefix: "@a/",
      target: "lib/a/",
    });
    assert.deepEqual(parseRemapping("src/:@a/=lib/a/"), {
      context: "src/",
      prefix: "@a/",
      target: "lib/a/",
    });
    assert.deepEqual(parseRemapping("@a/="), { context: "", prefix: "@a/", target: "" });
  });

  it("refuses a remapping without = or with an empty prefix", () => {
    assert.equal(parseRemapping("@a/"), undefined);
    assert.equal(parseRemapping("=lib/a/"), undefined);
    assert.equal(parseRemapping("src/:=lib/a/"), undefined);
  });
});

describe("resolveImport", () => {
  it("resolves ./ and ../ against the importing file's directory", () => {
    assert.equal(resolveImport("./B.sol", "src/A.sol", []), "src/B.sol");
    assert.equal(resolveImport("../lib/B.sol", "src/a/A.sol", []), "src/lib/B.sol");
    assert.equal(resolveImport("./x/./../B.sol", "src/A.sol", []), "src/B.sol");
    assert.equal(resolveImport(".//B.sol", "src/A.sol", []), "src/B.sol");
    assert.equal(resolveImport("./B.sol", "A.sol", []), "B.sol");
  });

  it("never climbs above the root, as solc", () => {
    assert.equal(resolveImport("../../B.sol", "src/A.sol", []), "B.sol");
  });

  it("drops empty segments of the importer's directory, as solc's Boost paths do", () => {
    assert.equal(resolveImport("../d.sol", "a//b/c.sol", []), "a/d.sol");
    assert.equal(resolveImport("../d.sol", "a/b//c.sol", []), "a/d.sol");
    assert.equal(resolveImport("../../d.sol", "a/b//c.sol", []), "d.sol");
    assert.equal(resolveImport("../d.sol", "a///c.sol", []), "d.sol");
    assert.equal(resolveImport("./c.sol", "a/b/", []), "a/b/c.sol");
    assert.equal(resolveImport("./c.sol", "a/b//", []), "a/b/c.sol");
    assert.equal(resolveImport("../x//../y.sol", "src/A.sol", []), "y.sol");
  });

  it("resolves a relative import inside a remapped file with an empty segment", () => {
    const list = remappings("@x=lib/x/");
    const remapped = resolveImport("@x/b.sol", "src/A.sol", list);
    assert.equal(remapped, "lib/x//b.sol");
    assert.equal(resolveImport("./c.sol", remapped, list), "lib/x/c.sol");
    assert.equal(resolveImport("../c.sol", remapped, list), "lib/c.sol");
  });

  it("keeps a direct import as it is", () => {
    assert.equal(resolveImport("src/B.sol", "lib/A.sol", []), "src/B.sol");
    assert.equal(resolveImport(".hidden/B.sol", "src/A.sol", []), ".hidden/B.sol");
  });

  it("applies the remapping with the longest matching prefix", () => {
    const list = remappings("@a/=lib/a/", "@a/b/=lib/ab/", "@c/=lib/c/");
    assert.equal(resolveImport("@a/b/X.sol", "src/A.sol", list), "lib/ab/X.sol");
    assert.equal(resolveImport("@a/X.sol", "src/A.sol", list), "lib/a/X.sol");
    assert.equal(resolveImport("@d/X.sol", "src/A.sol", list), "@d/X.sol");
  });

  it("remaps the name a relative import resolves to", () => {
    assert.equal(
      resolveImport("./X.sol", "lib/old/A.sol", remappings("lib/old/=lib/new/")),
      "lib/new/X.sol",
    );
  });

  it("applies a remapping only when its context is a prefix of the importing file", () => {
    const list = remappings("lib/a/:@x/=lib/x1/", "@x/=lib/x0/");
    assert.equal(resolveImport("@x/X.sol", "lib/a/A.sol", list), "lib/x1/X.sol");
    assert.equal(resolveImport("@x/X.sol", "src/A.sol", list), "lib/x0/X.sol");
  });

  it("prefers the longest context over the longest prefix", () => {
    const list = remappings("lib/a/:@x/=lib/ctx/", "@x/y/=lib/prefix/");
    assert.equal(resolveImport("@x/y/X.sol", "lib/a/A.sol", list), "lib/ctx/y/X.sol");
    const reversed = remappings("@x/y/=lib/prefix/", "lib/a/:@x/=lib/ctx/");
    assert.equal(resolveImport("@x/y/X.sol", "lib/a/A.sol", reversed), "lib/ctx/y/X.sol");
  });

  it("takes a longer prefix under a longer context even after a shorter one", () => {
    const list = remappings("lib/:@x/y/=lib/one/", "lib/a/:@x/=lib/two/");
    assert.equal(resolveImport("@x/y/X.sol", "lib/a/A.sol", list), "lib/two/y/X.sol");
  });

  it("takes the last of two remappings with the same context and prefix", () => {
    const list = remappings("@x/=lib/first/", "@x/=lib/last/");
    assert.equal(resolveImport("@x/X.sol", "src/A.sol", list), "lib/last/X.sol");
  });

  it("keeps a longer prefix listed before a shorter one", () => {
    const list = remappings("@a/b/=lib/ab/", "@a/=lib/a/");
    assert.equal(resolveImport("@a/b/X.sol", "src/A.sol", list), "lib/ab/X.sol");
    assert.equal(resolveImport("@a/X.sol", "src/A.sol", list), "lib/a/X.sol");
  });
});
