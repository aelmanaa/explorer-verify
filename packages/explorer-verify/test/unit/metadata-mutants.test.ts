// Tests added after the first mutation run of src/input/metadata.ts, libraries.ts and paths.ts
// (#202; R-IN-4, R-IN-7): each one fails on a code change that the other tests let pass.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExplorerVerifyError, linkLibraries } from "../../src/index.ts";
import type { VerifyInput } from "../../src/index.ts";
import {
  checkSourceHashes,
  parseMetadata,
  rebuildInput,
  sourceFingerprint,
} from "../../src/input/metadata.ts";
import type { SolidityMetadata } from "../../src/input/metadata.ts";
import { isLocalPath } from "../../src/input/paths.ts";
import { keccak256 } from "../../src/internal/keccak.ts";

const VERSION = "0.8.24+commit.e11b9ed9";
const PATH = "src/A.sol";
const SOURCE = "contract A {}";
const HASH = keccak256(new TextEncoder().encode(SOURCE));
const ADDRESS = "0xd0b737fc4e4195144824eb07b2d1bb778525b86b";

function metadataOf(
  settings: Record<string, unknown> = {},
  sources: Record<string, unknown> = { [PATH]: { keccak256: HASH } },
  version = VERSION,
): Record<string, unknown> {
  return {
    language: "Solidity",
    compiler: { version },
    settings: { compilationTarget: { [PATH]: "A" }, ...settings },
    sources,
  };
}

function parsed(value: unknown): SolidityMetadata {
  const metadata = parseMetadata(value);
  assert.ok(metadata !== undefined, "the metadata parses");
  return metadata;
}

/** The settings of the input rebuilt from `metadata`, with `src/A.sol` provided. */
function rebuiltSettings(metadata: Record<string, unknown>): Record<string, unknown> {
  const { input } = rebuildInput(parsed(metadata), new Map([[PATH, SOURCE]]));
  const { settings } = input;
  assert.ok(typeof settings === "object" && settings !== null);
  return { ...settings };
}

function thrown(run: () => unknown): ExplorerVerifyError {
  try {
    run();
  } catch (error: unknown) {
    assert.ok(error instanceof ExplorerVerifyError, "expected an ExplorerVerifyError");
    return error;
  }
  return assert.fail("expected an ExplorerVerifyError");
}

describe("parseMetadata: what a rebuild needs (#202, R-IN-7)", () => {
  it("returns undefined without settings, and for a source entry that is not an object", () => {
    const { settings: _, ...withoutSettings } = metadataOf();
    assert.equal(parseMetadata(withoutSettings), undefined);
    assert.equal(parseMetadata(metadataOf({}, { [PATH]: 5 })), undefined);
  });

  it("keeps only a content that is a string", () => {
    const metadata = parsed(metadataOf({}, { [PATH]: { keccak256: HASH, content: 5 } }));
    assert.equal(metadata.sources[0]?.content, undefined);
  });

  it("tells apart source lists whose paths and hashes would run together", () => {
    const two = parsed(metadataOf({}, { a: { keccak256: "x" }, b: { keccak256: "y" } }));
    const one = parsed(metadataOf({}, { a: { keccak256: 'x"b":y' } }));
    assert.notEqual(sourceFingerprint(two), sourceFingerprint(one));
  });
});

describe("rebuildInput: settings (#202, R-IN-7)", () => {
  it("adds no metadata settings when there are none to keep", () => {
    assert.equal(Object.hasOwn(rebuiltSettings(metadataOf()), "metadata"), false);
    assert.equal(Object.hasOwn(rebuiltSettings(metadataOf({ metadata: {} })), "metadata"), false);
  });

  it("keeps useLiteralContent as the metadata records it", () => {
    const sources = { [PATH]: { keccak256: HASH, content: SOURCE } };
    const settings = rebuiltSettings(
      metadataOf({ metadata: { useLiteralContent: false } }, sources),
    );
    assert.deepEqual(settings["metadata"], { useLiteralContent: false });
  });

  it("sets useLiteralContent when any one source embeds its content", () => {
    const sources = {
      [PATH]: { keccak256: HASH, content: SOURCE },
      "src/B.sol": { keccak256: HASH },
    };
    const { input } = rebuildInput(parsed(metadataOf({}, sources)), new Map());
    assert.deepEqual(Reflect.get(Object(input.settings), "metadata"), { useLiteralContent: true });
  });

  it("changes the optimizer only for an inliner of solc 0.8.2 to 0.8.4", () => {
    const withoutInliner = { enabled: true, runs: 200, details: { yul: true } };
    assert.deepEqual(
      rebuiltSettings(
        metadataOf({ optimizer: withoutInliner }, undefined, "0.8.3+commit.8d00100c"),
      )["optimizer"],
      withoutInliner,
    );
    const withInliner = { enabled: true, runs: 200, details: { inliner: false } };
    assert.deepEqual(
      rebuiltSettings(metadataOf({ optimizer: withInliner }, undefined, "10.8.3+commit.8d00100c"))[
        "optimizer"
      ],
      withInliner,
    );
  });

  it("names libraries that are not an object in the message", () => {
    const error = thrown(() => rebuiltSettings(metadataOf({ libraries: 5 })));
    assert.equal(error.message, "The input is invalid: metadata.settings.libraries.");
    assert.deepEqual(error.details, {
      code: "invalid-input",
      issues: [
        {
          field: "metadata.settings.libraries",
          message: "must be an object of addresses by path:Name",
        },
      ],
    });
  });
});

describe("checkSourceHashes (#202, R-IN-7)", () => {
  it("never redacts the source path in details.path, whatever text it holds (R-SEC-1)", () => {
    // Text a mutant could add to the secrets, so a redaction would show in the path.
    const path = "src/Stryker was here.sol";
    const error = thrown(() => {
      checkSourceHashes([{ path, content: SOURCE, expected: `0x${"0".repeat(64)}` }]);
    });
    assert.ok(error.details.code === "source-mismatch");
    assert.equal(error.details.path, path);
  });

  it("explains a mismatch, and reports a recorded hash only in the full form", () => {
    const hex = HASH.slice(2);
    const cases: [string, string][] = [
      [`0x${"0".repeat(64)}`, `0x${"0".repeat(64)}`],
      [`zz0x${hex}`, "0x"],
      [`0x${hex}ff`, "0x"],
    ];
    for (const [expected, reported] of cases) {
      const error = thrown(() => {
        checkSourceHashes([{ path: PATH, content: `${SOURCE} `, expected }]);
      });
      assert.equal(
        error.message,
        "A source file does not match the keccak-256 hash the metadata records for it.",
      );
      assert.equal(
        error.hint,
        "Pass the source file exactly as it was compiled, byte for byte, line endings included. details.path names the file; details.expected is the hash the metadata records.",
      );
      assert.deepEqual(error.details, {
        code: "source-mismatch",
        path: PATH,
        expected: reported,
        actual: keccak256(new TextEncoder().encode(`${SOURCE} `)),
      });
    }
  });
});

describe("linkLibraries: the error names every field (#202, R-IN-4)", () => {
  it("lists each conflicting library in the message", () => {
    const input: VerifyInput = {
      chainId: 11155111,
      address: `0x${"1".repeat(40)}`,
      compiler: {
        kind: "solc",
        version: VERSION,
        input: {
          language: "Solidity",
          sources: { [PATH]: { content: SOURCE } },
          settings: { libraries: { "": { L: `0x${"2".repeat(40)}`, M: `0x${"2".repeat(40)}` } } },
        },
      },
      contractName: `${PATH}:A`,
      libraries: { [`${PATH}:L`]: ADDRESS, [`${PATH}:M`]: ADDRESS },
    };
    const error = thrown(() => linkLibraries(input));
    assert.equal(error.message, "The input is invalid: libraries.1, libraries.2.");
  });
});

describe("isLocalPath: empty and . segments do not count as a level (#202, R-IN-7)", () => {
  it("finds a climb above the root after ./ or an empty segment", () => {
    assert.equal(isLocalPath("./../x"), true);
    assert.equal(isLocalPath("a//../../x"), true);
    assert.equal(isLocalPath("a/./../x"), false);
  });
});
