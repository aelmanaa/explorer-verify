// buildVerifyInput refuses zksolc (EraVM) build documents with unsupported-compiler (R-IN-7).
// zksolc writes the same shapes as solc, so each test takes a solc fixture and adds the one field
// that foundry-zksync or hardhat-zksync writes, as their sources name it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { inspect } from "node:util";

import { ERROR_EXIT_CODES } from "../../src/envelope.ts";
import { buildVerifyInput, ExplorerVerifyError } from "../../src/index.ts";

const FIXTURES = new URL("../fixtures/build-formats/", import.meta.url);
// A local path as foundry-zksync writes it in `input.zksolc_path`; it must never reach an error.
const LOCAL_PATH = "/home/builder/.zksync/zksolc-linux-amd64-musl-v1.5.15";
const ZKSOLC_VERSION = "1.5.15";

type Json = Record<string, unknown>;

/** A fresh parse of one fixture file, so a test may change it. */
function fixture(path: string): Json {
  const parsed: unknown = JSON.parse(readFileSync(new URL(path, FIXTURES), "utf8"));
  assert.ok(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
  return { ...parsed };
}

/** The object at `key` of `value`, copied. */
function child(value: Json, key: string): Json {
  const found: unknown = value[key];
  assert.ok(typeof found === "object" && found !== null && !Array.isArray(found));
  return { ...found };
}

/** A Hardhat 2 build-info whose Greeter contract output carries `metadata`. */
function hardhatWithContractMetadata(metadata: Json): Json {
  const buildInfo = fixture("hardhat-2.29.1/build-info.json");
  const output = child(buildInfo, "output");
  const contracts = child(output, "contracts");
  const file = child(contracts, "contracts/Greeter.sol");
  file.Greeter = { ...child(file, "Greeter"), metadata };
  contracts["contracts/Greeter.sol"] = file;
  return { ...buildInfo, output: { ...output, contracts } };
}

/** foundry-zksync: the build-info input is a ZkSolcVersionedInput. */
function foundryZksyncBuildInfo(): Json {
  const buildInfo = fixture("foundry-1.8.1/build-info.json");
  const input = child(buildInfo, "input");
  return {
    ...buildInfo,
    input: {
      language: input.language,
      sources: input.sources,
      settings: input.settings,
      solc_version: "0.8.24",
      cli_settings: {},
      zksolc_version: ZKSOLC_VERSION,
      zksolc_path: LOCAL_PATH,
    },
  };
}

/** hardhat-zksync: the build-info output holds zksolc's own `zk_version`. */
function hardhatZksyncBuildInfo(): Json {
  const buildInfo = fixture("hardhat-2.29.1/build-info.json");
  return {
    ...buildInfo,
    output: {
      ...child(buildInfo, "output"),
      version: "0.8.24",
      long_version: "0.8.24+commit.e11b9ed9",
      zk_version: ZKSOLC_VERSION,
    },
  };
}

/** hardhat-zksync artifact: ABI, bytecode and factory dependencies, with its own `_format`. */
function hardhatZksyncArtifact(): Json {
  return {
    ...fixture("hardhat-2.29.1/Greeter.json"),
    _format: "hh-zksolc-artifact-1",
    linkReferences: {},
    deployedLinkReferences: {},
    factoryDeps: {},
  };
}

/** The error buildVerifyInput throws for `documents`. */
function rejection(documents: readonly unknown[]): ExplorerVerifyError {
  try {
    buildVerifyInput(documents);
  } catch (error) {
    assert.ok(error instanceof ExplorerVerifyError, "not an ExplorerVerifyError");
    return error;
  }
  return assert.fail("buildVerifyInput did not throw");
}

/** Asserts unsupported-compiler naming `field`, with the zksolc hint and no local path. */
function assertZksolc(documents: readonly unknown[], field: string): void {
  const error = rejection(documents);
  assert.equal(error.code, "unsupported-compiler");
  assert.ok(error.details.code === "unsupported-compiler");
  assert.equal(error.details.field, field);
  assert.equal(ERROR_EXIT_CODES[error.code], 2);
  assert.equal(error.retryable, false);
  assert.match(error.message, /other than solc/);
  assert.match(error.hint, /zksolc \(EraVM\) builds are not supported/);
  assert.match(error.hint, /plain solc/);
  const shown = [
    error.message,
    error.hint,
    error.stack ?? "",
    JSON.stringify(error.toJSON()),
    inspect(error, { depth: Infinity }),
  ];
  for (const place of shown) {
    assert.ok(!place.includes(LOCAL_PATH), place.slice(0, 120));
    assert.ok(!place.includes(ZKSOLC_VERSION), place.slice(0, 120));
  }
}

describe("buildVerifyInput refuses zksolc build documents (R-IN-7)", () => {
  it("names input.zksolc_version for a foundry-zksync build-info", () => {
    assertZksolc([foundryZksyncBuildInfo()], "input.zksolc_version");
  });

  it("names output.zk_version for a hardhat-zksync build-info", () => {
    assertZksolc([hardhatZksyncBuildInfo()], "output.zk_version");
  });

  it("names output.metadata.zksolcVersion for the output metadata foundry-zksync keeps", () => {
    const buildInfo = fixture("hardhat-2.29.1/build-info.json");
    const output = {
      ...child(buildInfo, "output"),
      metadata: { solcVersion: "0.8.24", zksolcVersion: ZKSOLC_VERSION },
    };
    assertZksolc([{ ...buildInfo, output }], "output.metadata.zksolcVersion");
  });

  it("names metadata.zk_version for a contract whose zksolc metadata holds it", () => {
    const metadata = { solc_metadata: "{}", zk_version: ZKSOLC_VERSION, optimizer_settings: {} };
    assertZksolc([hardhatWithContractMetadata(metadata)], "metadata.zk_version");
  });

  it("names metadata.zksolcVersion for a contract whose zksolc metadata holds it", () => {
    const metadata = { solc_metadata: "{}", zksolcVersion: ZKSOLC_VERSION };
    assertZksolc([hardhatWithContractMetadata(metadata)], "metadata.zksolcVersion");
  });

  it("reads contract metadata given as a JSON string", () => {
    const metadata = JSON.stringify({ zk_version: ZKSOLC_VERSION });
    const buildInfo = hardhatWithContractMetadata({});
    const output = child(buildInfo, "output");
    const contracts = child(output, "contracts");
    const file = child(contracts, "contracts/Greeter.sol");
    file.Greeter = { ...child(file, "Greeter"), metadata };
    contracts["contracts/Greeter.sol"] = file;
    assertZksolc([{ ...buildInfo, output: { ...output, contracts } }], "metadata.zk_version");
  });

  it("names metadata.zk_version for an artifact whose own metadata holds it", () => {
    const artifact = {
      ...fixture("foundry-1.8.1/Greeter.json"),
      metadata: { zk_version: "1.5.15" },
    };
    assertZksolc([artifact], "metadata.zk_version");
  });

  it("names solcVersion for a zkVM solc version", () => {
    const buildInfo = fixture("hardhat-2.29.1/build-info.json");
    buildInfo.solcVersion = "zkVM-0.8.24-1.0.2";
    assertZksolc([buildInfo], "solcVersion");
  });

  it("names solcLongVersion for a zkVM long version", () => {
    const buildInfo = fixture("hardhat-2.29.1/build-info.json");
    buildInfo.solcLongVersion = "zkVM-0.8.24-1.0.2";
    assertZksolc([buildInfo], "solcLongVersion");
  });

  it("names _format for a hardhat-zksync artifact", () => {
    assertZksolc([hardhatZksyncArtifact()], "_format");
  });

  it("refuses a solc build-info passed with a hardhat-zksync artifact", () => {
    assertZksolc([fixture("hardhat-2.29.1/build-info.json"), hardhatZksyncArtifact()], "_format");
  });

  it("names the same field whatever the order of the documents", () => {
    const documents = [hardhatZksyncBuildInfo(), hardhatZksyncArtifact()];
    assertZksolc(documents, "_format");
    assertZksolc(documents.toReversed(), "_format");
  });

  it("names the zksolc field before a compilerType other than solc", () => {
    const solx = { ...fixture("hardhat-3.21.2/build-info.json"), compilerType: "solx" };
    assertZksolc([solx, hardhatZksyncArtifact()], "_format");
    assertZksolc([hardhatZksyncArtifact(), solx], "_format");
  });

  it("still reads the solc fixtures as solc", () => {
    const hardhat = buildVerifyInput([
      fixture("hardhat-2.29.1/build-info.json"),
      fixture("hardhat-2.29.1/Greeter.json"),
    ]);
    assert.equal(hardhat.compiler.kind, "solc");
    const foundry = buildVerifyInput([
      fixture("foundry-1.8.1/build-info.json"),
      fixture("foundry-1.8.1/Greeter.json"),
    ]);
    assert.equal(foundry.compiler.kind, "solc");
  });

  it("leaves a solc version that only contains zkVM alone", () => {
    const buildInfo = fixture("hardhat-2.29.1/build-info.json");
    buildInfo.solcVersion = "0.8.24-zkVM";
    const built = buildVerifyInput([buildInfo], { contract: "contracts/Greeter.sol:Greeter" });
    assert.equal(built.compiler.kind, "solc");
  });
});
