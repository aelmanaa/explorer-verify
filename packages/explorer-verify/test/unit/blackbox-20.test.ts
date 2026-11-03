// Black-box tests for issue #20: buildVerifyInput, written from the issue, R-IN-7 and R-DX-2,
// the how-to "Verify a contract shipped in an npm package", errors.md, json-output.md and the
// public type declarations only. Inputs: the committed Hardhat 2 and 3 fixtures, the committed
// Foundry stub, and a separate two-file Foundry 1.8.1 build (below) of a contract with an
// immutable, a constructor argument and two contracts named Helper in different files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { inspect } from "node:util";

import {
  ERROR_EXIT_CODES,
  ExplorerVerifyError,
  buildVerifyInput,
  exitCodeOf,
  validateInput,
} from "../../src/index.ts";
import type { BuildVerifyInputOptions, BuiltVerifyInput } from "../../src/index.ts";

// --- helpers -----------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rec(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "expected an object");
  return value;
}

function clone(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function fixture(path: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/build-formats/${path}`, import.meta.url), "utf8"),
  );
}

const LONG = "0.8.24+commit.e11b9ed9";
const ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
// A fake Etherscan-style key: 34 upper-case letters and digits. Never a real key.
const KEY = "FAKEKEY0BLACKBOX0TEST0Z9Y8X7W6V5U4";

const hh2 = {
  buildInfo: () => fixture("hardhat-2.29.1/build-info.json"),
  artifact: () => fixture("hardhat-2.29.1/Greeter.json"),
};
const hh3 = {
  buildInfo: () => fixture("hardhat-3.21.2/build-info.json"),
  output: () => fixture("hardhat-3.21.2/build-info.output.json"),
  artifact: () => fixture("hardhat-3.21.2/Greeter.json"),
};
const committedFoundry = {
  buildInfo: () => fixture("foundry-1.8.1/build-info.json"),
  artifact: () => fixture("foundry-1.8.1/Greeter.json"),
  stub: () => fixture("foundry-1.8.1/build-info-stub.json"),
};

// Own Foundry 1.8.1 build, `forge build --build-info`, solc 0.8.24, optimizer 200 runs:
// src/Counter.sol (abstract Counter, contract Helper), src/Vault.sol (Vault is Counter, immutable
// cap set by the constructor), src/extra/Helper.sol (a second contract Helper). Trimmed: build-info
// output keeps abi and metadata per contract, output.sources keeps the id, the artifact drops ast.
// The build directory is replaced by a fake absolute path that must never reach the output.
const FOUNDRY_ROOT = "/home/builder/vault-project";
const FOUNDRY = rec(
  JSON.parse(
    '{"buildInfo":{"id":"d98c32d1665e9b66","source_id_to_path":{"0":"src/Counter.sol","1":"src/Vault.sol","2":"src/extra/Helper.sol"},"language":"Solidity","_format":"ethers-rs-sol-build-info-1","input":{"version":"0.8.24","language":"Solidity","sources":{"src/Counter.sol":{"content":"// SPDX-License-Identifier: MIT\\npragma solidity 0.8.24;\\nabstract contract Counter {\\n    uint256 public count;\\n    function _inc() internal { count += 1; }\\n}\\ncontract Helper { function ping() external pure returns (uint256) { return 1; } }\\n"},"src/Vault.sol":{"content":"// SPDX-License-Identifier: MIT\\npragma solidity 0.8.24;\\nimport {Counter} from \\"./Counter.sol\\";\\ncontract Vault is Counter {\\n    uint256 public immutable cap;\\n    constructor(uint256 cap_) { cap = cap_; }\\n    function bump() external { require(count < cap, \\"cap\\"); _inc(); }\\n}\\n"},"src/extra/Helper.sol":{"content":"// SPDX-License-Identifier: MIT\\npragma solidity 0.8.24;\\ncontract Helper { function pong() external pure returns (uint256) { return 2; } }\\n"}},"settings":{"optimizer":{"enabled":true,"runs":200},"metadata":{"useLiteralContent":false,"bytecodeHash":"ipfs","appendCBOR":true},"outputSelection":{"*":{"":["ast"],"*":["abi","evm.bytecode.object","evm.bytecode.sourceMap","evm.bytecode.linkReferences","evm.deployedBytecode.object","evm.deployedBytecode.sourceMap","evm.deployedBytecode.linkReferences","evm.deployedBytecode.immutableReferences","evm.methodIdentifiers","metadata"]}},"evmVersion":"cancun","viaIR":false,"libraries":{}},"allowPaths":["/home/builder/vault-project"],"basePath":"/home/builder/vault-project","includePaths":["/home/builder/vault-project"]},"output":{"contracts":{"src/Counter.sol":{"Counter":{"abi":[{"type":"function","name":"count","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"}],"metadata":"{\\"compiler\\":{\\"version\\":\\"0.8.24+commit.e11b9ed9\\"},\\"language\\":\\"Solidity\\",\\"output\\":{\\"abi\\":[{\\"inputs\\":[],\\"name\\":\\"count\\",\\"outputs\\":[{\\"internalType\\":\\"uint256\\",\\"name\\":\\"\\",\\"type\\":\\"uint256\\"}],\\"stateMutability\\":\\"view\\",\\"type\\":\\"function\\"}],\\"devdoc\\":{\\"kind\\":\\"dev\\",\\"methods\\":{},\\"version\\":1},\\"userdoc\\":{\\"kind\\":\\"user\\",\\"methods\\":{},\\"version\\":1}},\\"settings\\":{\\"compilationTarget\\":{\\"src/Counter.sol\\":\\"Counter\\"},\\"evmVersion\\":\\"cancun\\",\\"libraries\\":{},\\"metadata\\":{\\"bytecodeHash\\":\\"ipfs\\"},\\"optimizer\\":{\\"enabled\\":true,\\"runs\\":200},\\"remappings\\":[]},\\"sources\\":{\\"src/Counter.sol\\":{\\"keccak256\\":\\"0xcbc02ec742ebb54fd74e5dbc2c423a1ea8945bf6e3446e1f5dc1f10e3d3b6c76\\",\\"license\\":\\"MIT\\",\\"urls\\":[\\"bzz-raw://b9ef219cb4b58007419f9bffc94cc18ef803fb869dfe5c593c2fa95bc8b915e2\\",\\"dweb:/ipfs/QmcMuxKd5E7AkWWL7uup1BvLFaoFHnpwTdiTTqr4qBpGtM\\"]}},\\"version\\":1}"},"Helper":{"abi":[{"type":"function","name":"ping","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"pure"}],"metadata":"{\\"compiler\\":{\\"version\\":\\"0.8.24+commit.e11b9ed9\\"},\\"language\\":\\"Solidity\\",\\"output\\":{\\"abi\\":[{\\"inputs\\":[],\\"name\\":\\"ping\\",\\"outputs\\":[{\\"internalType\\":\\"uint256\\",\\"name\\":\\"\\",\\"type\\":\\"uint256\\"}],\\"stateMutability\\":\\"pure\\",\\"type\\":\\"function\\"}],\\"devdoc\\":{\\"kind\\":\\"dev\\",\\"methods\\":{},\\"version\\":1},\\"userdoc\\":{\\"kind\\":\\"user\\",\\"methods\\":{},\\"version\\":1}},\\"settings\\":{\\"compilationTarget\\":{\\"src/Counter.sol\\":\\"Helper\\"},\\"evmVersion\\":\\"cancun\\",\\"libraries\\":{},\\"metadata\\":{\\"bytecodeHash\\":\\"ipfs\\"},\\"optimizer\\":{\\"enabled\\":true,\\"runs\\":200},\\"remappings\\":[]},\\"sources\\":{\\"src/Counter.sol\\":{\\"keccak256\\":\\"0xcbc02ec742ebb54fd74e5dbc2c423a1ea8945bf6e3446e1f5dc1f10e3d3b6c76\\",\\"license\\":\\"MIT\\",\\"urls\\":[\\"bzz-raw://b9ef219cb4b58007419f9bffc94cc18ef803fb869dfe5c593c2fa95bc8b915e2\\",\\"dweb:/ipfs/QmcMuxKd5E7AkWWL7uup1BvLFaoFHnpwTdiTTqr4qBpGtM\\"]}},\\"version\\":1}"}},"src/Vault.sol":{"Vault":{"abi":[{"type":"constructor","inputs":[{"name":"cap_","type":"uint256","internalType":"uint256"}],"stateMutability":"nonpayable"},{"type":"function","name":"bump","inputs":[],"outputs":[],"stateMutability":"nonpayable"},{"type":"function","name":"cap","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},{"type":"function","name":"count","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"}],"metadata":"{\\"compiler\\":{\\"version\\":\\"0.8.24+commit.e11b9ed9\\"},\\"language\\":\\"Solidity\\",\\"output\\":{\\"abi\\":[{\\"inputs\\":[{\\"internalType\\":\\"uint256\\",\\"name\\":\\"cap_\\",\\"type\\":\\"uint256\\"}],\\"stateMutability\\":\\"nonpayable\\",\\"type\\":\\"constructor\\"},{\\"inputs\\":[],\\"name\\":\\"bump\\",\\"outputs\\":[],\\"stateMutability\\":\\"nonpayable\\",\\"type\\":\\"function\\"},{\\"inputs\\":[],\\"name\\":\\"cap\\",\\"outputs\\":[{\\"internalType\\":\\"uint256\\",\\"name\\":\\"\\",\\"type\\":\\"uint256\\"}],\\"stateMutability\\":\\"view\\",\\"type\\":\\"function\\"},{\\"inputs\\":[],\\"name\\":\\"count\\",\\"outputs\\":[{\\"internalType\\":\\"uint256\\",\\"name\\":\\"\\",\\"type\\":\\"uint256\\"}],\\"stateMutability\\":\\"view\\",\\"type\\":\\"function\\"}],\\"devdoc\\":{\\"kind\\":\\"dev\\",\\"methods\\":{},\\"version\\":1},\\"userdoc\\":{\\"kind\\":\\"user\\",\\"methods\\":{},\\"version\\":1}},\\"settings\\":{\\"compilationTarget\\":{\\"src/Vault.sol\\":\\"Vault\\"},\\"evmVersion\\":\\"cancun\\",\\"libraries\\":{},\\"metadata\\":{\\"bytecodeHash\\":\\"ipfs\\"},\\"optimizer\\":{\\"enabled\\":true,\\"runs\\":200},\\"remappings\\":[]},\\"sources\\":{\\"src/Counter.sol\\":{\\"keccak256\\":\\"0xcbc02ec742ebb54fd74e5dbc2c423a1ea8945bf6e3446e1f5dc1f10e3d3b6c76\\",\\"license\\":\\"MIT\\",\\"urls\\":[\\"bzz-raw://b9ef219cb4b58007419f9bffc94cc18ef803fb869dfe5c593c2fa95bc8b915e2\\",\\"dweb:/ipfs/QmcMuxKd5E7AkWWL7uup1BvLFaoFHnpwTdiTTqr4qBpGtM\\"]},\\"src/Vault.sol\\":{\\"keccak256\\":\\"0xcb99f7bf806830a8f40ec4aadd42a225830de02d3ed0af0aaeca690aad2b1713\\",\\"license\\":\\"MIT\\",\\"urls\\":[\\"bzz-raw://d220026eb3a2b1f1f841911d7c9cd4c4392bf1fc34a243ebddcd31c873a4a599\\",\\"dweb:/ipfs/QmSURdqDM46KS2Mt65SBkCgWeWrAGUUfnr61bYTr3S5JNh\\"]}},\\"version\\":1}"}},"src/extra/Helper.sol":{"Helper":{"abi":[{"type":"function","name":"pong","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"pure"}],"metadata":"{\\"compiler\\":{\\"version\\":\\"0.8.24+commit.e11b9ed9\\"},\\"language\\":\\"Solidity\\",\\"output\\":{\\"abi\\":[{\\"inputs\\":[],\\"name\\":\\"pong\\",\\"outputs\\":[{\\"internalType\\":\\"uint256\\",\\"name\\":\\"\\",\\"type\\":\\"uint256\\"}],\\"stateMutability\\":\\"pure\\",\\"type\\":\\"function\\"}],\\"devdoc\\":{\\"kind\\":\\"dev\\",\\"methods\\":{},\\"version\\":1},\\"userdoc\\":{\\"kind\\":\\"user\\",\\"methods\\":{},\\"version\\":1}},\\"settings\\":{\\"compilationTarget\\":{\\"src/extra/Helper.sol\\":\\"Helper\\"},\\"evmVersion\\":\\"cancun\\",\\"libraries\\":{},\\"metadata\\":{\\"bytecodeHash\\":\\"ipfs\\"},\\"optimizer\\":{\\"enabled\\":true,\\"runs\\":200},\\"remappings\\":[]},\\"sources\\":{\\"src/extra/Helper.sol\\":{\\"keccak256\\":\\"0x8e98f9c8b28ae877ed821dae64d965c50143b3d039bf349473d175097308a1f0\\",\\"license\\":\\"MIT\\",\\"urls\\":[\\"bzz-raw://174050616d7659540b8edaf220d00d15663fc905c3f67cf8902b1b96656de741\\",\\"dweb:/ipfs/QmabonyepXJdfk7GMtx3Bb49NHiJYewddVJLDhMhKXL5Dy\\"]}},\\"version\\":1}"}}},"sources":{"src/Counter.sol":{"id":0},"src/Vault.sol":{"id":1},"src/extra/Helper.sol":{"id":2}}},"solcLongVersion":"0.8.24","solcVersion":"0.8.24"},"artifact":{"abi":[{"type":"constructor","inputs":[{"name":"cap_","type":"uint256","internalType":"uint256"}],"stateMutability":"nonpayable"},{"type":"function","name":"bump","inputs":[],"outputs":[],"stateMutability":"nonpayable"},{"type":"function","name":"cap","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},{"type":"function","name":"count","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"}],"bytecode":{"object":"0x60a060405234801561000f575f80fd5b506040516101cf3803806101cf83398101604081905261002e91610036565b60805261004d565b5f60208284031215610046575f80fd5b5051919050565b60805161016561006a5f395f818160620152609001526101655ff3fe608060405234801561000f575f80fd5b506004361061003f575f3560e01c806306661abd14610043578063355274ea1461005d57806368110b2f14610084575b5f80fd5b61004b5f5481565b60405190815260200160405180910390f35b61004b7f000000000000000000000000000000000000000000000000000000000000000081565b61008c61008e565b005b7f00000000000000000000000000000000000000000000000000000000000000005f54106100e85760405162461bcd60e51b815260206004820152600360248201526206361760ec1b604482015260640160405180910390fd5b6100f06100f2565b565b60015f80828254610103919061010a565b9091555050565b8082018082111561012957634e487b7160e01b5f52601160045260245ffd5b9291505056fea2646970667358221220c9926718cb5335922cda69fec882d0e172b49a977ea15019055181a294f2186264736f6c63430008180033","sourceMap":"95:179:1:-:0;;;161:41;;;;;;;;;;;;;;;;;;;;;;;;;;;;:::i;:::-;189:10;;95:179;;14:184:3;84:6;137:2;125:9;116:7;112:23;108:32;105:52;;;153:1;150;143:12;105:52;-1:-1:-1;176:16:3;;14:184;-1:-1:-1;14:184:3:o;:::-;95:179:1;;;;;;;;;;;;;;;;;","linkReferences":{}},"deployedBytecode":{"object":"0x608060405234801561000f575f80fd5b506004361061003f575f3560e01c806306661abd14610043578063355274ea1461005d57806368110b2f14610084575b5f80fd5b61004b5f5481565b60405190815260200160405180910390f35b61004b7f000000000000000000000000000000000000000000000000000000000000000081565b61008c61008e565b005b7f00000000000000000000000000000000000000000000000000000000000000005f54106100e85760405162461bcd60e51b815260206004820152600360248201526206361760ec1b604482015260640160405180910390fd5b6100f06100f2565b565b60015f80828254610103919061010a565b9091555050565b8082018082111561012957634e487b7160e01b5f52601160045260245ffd5b9291505056fea2646970667358221220c9926718cb5335922cda69fec882d0e172b49a977ea15019055181a294f2186264736f6c63430008180033","sourceMap":"95:179:1:-:0;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;88:20:0;;;;;;;;;160:25:3;;;148:2;133:18;88:20:0;;;;;;;127:28:1;;;;;207:65;;;:::i;:::-;;;250:3;242:5;;:11;234:27;;;;-1:-1:-1;;;234:27:1;;398:2:3;234:27:1;;;380:21:3;437:1;417:18;;;410:29;-1:-1:-1;;;455:18:3;;;448:33;498:18;;234:27:1;;;;;;;;263:6;:4;:6::i;:::-;207:65::o;114:40:0:-;150:1;141:5;;:10;;;;;;;:::i;:::-;;;;-1:-1:-1;;114:40:0:o;527:222:3:-;592:9;;;613:10;;;610:133;;;665:10;660:3;656:20;653:1;646:31;700:4;697:1;690:15;728:4;725:1;718:15;610:133;527:222;;;;:::o","linkReferences":{},"immutableReferences":{"29":[{"start":98,"length":32},{"start":144,"length":32}]}},"methodIdentifiers":{"bump()":"68110b2f","cap()":"355274ea","count()":"06661abd"},"rawMetadata":"{\\"compiler\\":{\\"version\\":\\"0.8.24+commit.e11b9ed9\\"},\\"language\\":\\"Solidity\\",\\"output\\":{\\"abi\\":[{\\"inputs\\":[{\\"internalType\\":\\"uint256\\",\\"name\\":\\"cap_\\",\\"type\\":\\"uint256\\"}],\\"stateMutability\\":\\"nonpayable\\",\\"type\\":\\"constructor\\"},{\\"inputs\\":[],\\"name\\":\\"bump\\",\\"outputs\\":[],\\"stateMutability\\":\\"nonpayable\\",\\"type\\":\\"function\\"},{\\"inputs\\":[],\\"name\\":\\"cap\\",\\"outputs\\":[{\\"internalType\\":\\"uint256\\",\\"name\\":\\"\\",\\"type\\":\\"uint256\\"}],\\"stateMutability\\":\\"view\\",\\"type\\":\\"function\\"},{\\"inputs\\":[],\\"name\\":\\"count\\",\\"outputs\\":[{\\"internalType\\":\\"uint256\\",\\"name\\":\\"\\",\\"type\\":\\"uint256\\"}],\\"stateMutability\\":\\"view\\",\\"type\\":\\"function\\"}],\\"devdoc\\":{\\"kind\\":\\"dev\\",\\"methods\\":{},\\"version\\":1},\\"userdoc\\":{\\"kind\\":\\"user\\",\\"methods\\":{},\\"version\\":1}},\\"settings\\":{\\"compilationTarget\\":{\\"src/Vault.sol\\":\\"Vault\\"},\\"evmVersion\\":\\"cancun\\",\\"libraries\\":{},\\"metadata\\":{\\"bytecodeHash\\":\\"ipfs\\"},\\"optimizer\\":{\\"enabled\\":true,\\"runs\\":200},\\"remappings\\":[]},\\"sources\\":{\\"src/Counter.sol\\":{\\"keccak256\\":\\"0xcbc02ec742ebb54fd74e5dbc2c423a1ea8945bf6e3446e1f5dc1f10e3d3b6c76\\",\\"license\\":\\"MIT\\",\\"urls\\":[\\"bzz-raw://b9ef219cb4b58007419f9bffc94cc18ef803fb869dfe5c593c2fa95bc8b915e2\\",\\"dweb:/ipfs/QmcMuxKd5E7AkWWL7uup1BvLFaoFHnpwTdiTTqr4qBpGtM\\"]},\\"src/Vault.sol\\":{\\"keccak256\\":\\"0xcb99f7bf806830a8f40ec4aadd42a225830de02d3ed0af0aaeca690aad2b1713\\",\\"license\\":\\"MIT\\",\\"urls\\":[\\"bzz-raw://d220026eb3a2b1f1f841911d7c9cd4c4392bf1fc34a243ebddcd31c873a4a599\\",\\"dweb:/ipfs/QmSURdqDM46KS2Mt65SBkCgWeWrAGUUfnr61bYTr3S5JNh\\"]}},\\"version\\":1}","metadata":{"compiler":{"version":"0.8.24+commit.e11b9ed9"},"language":"Solidity","output":{"abi":[{"inputs":[{"internalType":"uint256","name":"cap_","type":"uint256"}],"stateMutability":"nonpayable","type":"constructor"},{"inputs":[],"stateMutability":"nonpayable","type":"function","name":"bump"},{"inputs":[],"stateMutability":"view","type":"function","name":"cap","outputs":[{"internalType":"uint256","name":"","type":"uint256"}]},{"inputs":[],"stateMutability":"view","type":"function","name":"count","outputs":[{"internalType":"uint256","name":"","type":"uint256"}]}],"devdoc":{"kind":"dev","methods":{},"version":1},"userdoc":{"kind":"user","methods":{},"version":1}},"settings":{"remappings":[],"optimizer":{"enabled":true,"runs":200},"metadata":{"bytecodeHash":"ipfs"},"compilationTarget":{"src/Vault.sol":"Vault"},"evmVersion":"cancun","libraries":{}},"sources":{"src/Counter.sol":{"keccak256":"0xcbc02ec742ebb54fd74e5dbc2c423a1ea8945bf6e3446e1f5dc1f10e3d3b6c76","urls":["bzz-raw://b9ef219cb4b58007419f9bffc94cc18ef803fb869dfe5c593c2fa95bc8b915e2","dweb:/ipfs/QmcMuxKd5E7AkWWL7uup1BvLFaoFHnpwTdiTTqr4qBpGtM"],"license":"MIT"},"src/Vault.sol":{"keccak256":"0xcb99f7bf806830a8f40ec4aadd42a225830de02d3ed0af0aaeca690aad2b1713","urls":["bzz-raw://d220026eb3a2b1f1f841911d7c9cd4c4392bf1fc34a243ebddcd31c873a4a599","dweb:/ipfs/QmSURdqDM46KS2Mt65SBkCgWeWrAGUUfnr61bYTr3S5JNh"],"license":"MIT"}},"version":1},"id":1},"stub":{"id":"86b2aeb3e921adf5","source_id_to_path":{"0":"src/Counter.sol","1":"src/Vault.sol","2":"src/extra/Helper.sol"},"language":"Solidity"}}',
  ),
);
const own = {
  buildInfo: () => clone(FOUNDRY["buildInfo"]),
  artifact: () => clone(FOUNDRY["artifact"]),
  stub: () => clone(FOUNDRY["stub"]),
};

function inputOf(doc: unknown): Record<string, unknown> {
  return rec(rec(doc)["input"]);
}

// Drop the contract metadata from a build-info output, so no long version is left in it.
function withoutOutputMetadata(doc: unknown): unknown {
  const copy = rec(clone(doc));
  const contracts = rec(rec(copy["output"])["contracts"]);
  for (const file of Object.values(contracts)) {
    for (const contract of Object.values(rec(file))) {
      delete rec(contract)["metadata"];
    }
  }
  return copy;
}

function catchError(fn: () => unknown): ExplorerVerifyError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught !== undefined, "expected buildVerifyInput to throw");
  assert.ok(
    caught instanceof ExplorerVerifyError,
    `not an ExplorerVerifyError: ${inspect(caught)}`,
  );
  return caught;
}

function fieldOf(error: ExplorerVerifyError): string | undefined {
  const d = error.details;
  if (
    d.code === "incomplete-input" ||
    d.code === "insufficient-artifact" ||
    d.code === "unsupported-compiler"
  ) {
    return d.field;
  }
  return undefined;
}

function issueFields(error: ExplorerVerifyError): string[] {
  const d = error.details;
  return d.code === "invalid-input" ? d.issues.map((i) => i.field) : [];
}

function everyText(error: ExplorerVerifyError): string {
  return [
    error.message,
    error.hint,
    JSON.stringify(error.details),
    JSON.stringify(error.toJSON()),
    inspect(error, { depth: 10 }),
    String(error.stack),
  ].join("\n");
}

// The result must pass validateInput unchanged in its compiler part.
function assertValid(built: BuiltVerifyInput): void {
  const checked = validateInput({ chainId: 11155111, address: ADDRESS, ...built });
  assert.deepEqual(checked.compiler, built.compiler);
  assert.equal(checked.contractName, built.contractName);
}

function assertCleanInput(built: BuiltVerifyInput, original: Record<string, unknown>): void {
  const input = rec(built.compiler.input);
  assert.deepEqual(Object.keys(input).toSorted(), ["language", "settings", "sources"]);
  assert.equal(input["language"], "Solidity");
  assert.deepEqual(input["sources"], original["sources"]);
  assert.deepEqual(input["settings"], original["settings"]);
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  items.forEach((item, i) => {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([item, ...p]);
  });
  return out;
}

function build(documents: readonly unknown[], options?: BuildVerifyInputOptions): BuiltVerifyInput {
  return buildVerifyInput(documents, options);
}

// --- shapes (R-IN-7) ---------------------------------------------------------------------------

describe("buildVerifyInput: each documented shape gives the documented result (R-IN-7)", () => {
  it("own Foundry build-info plus artifact: src/Vault.sol:Vault, long version from metadata", () => {
    const bi = own.buildInfo();
    const built = build([bi, own.artifact()]);
    assert.equal(built.contractName, "src/Vault.sol:Vault");
    assert.equal(built.compiler.kind, "solc");
    assert.equal(built.compiler.version, LONG);
    assertCleanInput(built, inputOf(bi));
    assertValid(built);
  });

  it("own Foundry build-info alone, contract given as path:Name and as a unique bare Name", () => {
    const bi = own.buildInfo();
    for (const contract of ["src/Vault.sol:Vault", "Vault"]) {
      const built = build([bi], { contract });
      assert.equal(built.contractName, "src/Vault.sol:Vault");
      assert.equal(built.compiler.version, LONG);
      assertCleanInput(built, inputOf(bi));
      assertValid(built);
    }
  });

  it("own Foundry build-info alone, path:Name picks one of two contracts named Helper", () => {
    const built = build([own.buildInfo()], { contract: "src/extra/Helper.sol:Helper" });
    assert.equal(built.contractName, "src/extra/Helper.sol:Helper");
    assertValid(built);
  });

  it("committed Foundry build-info plus artifact: src/Greeter.sol:Greeter", () => {
    const bi = committedFoundry.buildInfo();
    const built = build([bi, committedFoundry.artifact()]);
    assert.match(built.contractName, /^[^:]+\/Greeter\.sol:Greeter$/);
    assert.ok(
      Object.keys(rec(inputOf(bi)["sources"])).includes(built.contractName.split(":")[0] ?? ""),
    );
    assert.equal(built.compiler.version, LONG);
    assertCleanInput(built, inputOf(bi));
    assertValid(built);
  });

  it("committed Foundry build-info alone with contract Greeter (version from its output metadata)", () => {
    const built = build([committedFoundry.buildInfo()], { contract: "Greeter" });
    assert.match(built.contractName, /Greeter\.sol:Greeter$/);
    assert.equal(built.compiler.version, LONG);
    assertValid(built);
  });

  it("Hardhat 2 build-info plus artifact: contracts/Greeter.sol:Greeter", () => {
    const bi = hh2.buildInfo();
    const built = build([bi, hh2.artifact()]);
    assert.equal(built.contractName, "contracts/Greeter.sol:Greeter");
    assert.equal(built.compiler.version, LONG);
    assertCleanInput(built, inputOf(bi));
    assertValid(built);
  });

  it("Hardhat 2 build-info alone with contract (path:Name and bare Name)", () => {
    for (const contract of ["contracts/Greeter.sol:Greeter", "Greeter"]) {
      const built = build([hh2.buildInfo()], { contract });
      assert.equal(built.contractName, "contracts/Greeter.sol:Greeter");
      assert.equal(built.compiler.version, LONG);
      assertValid(built);
    }
  });

  it("Hardhat 3 build-info plus artifact: the name uses inputSourceName, not sourceName", () => {
    const bi = hh3.buildInfo();
    const built = build([bi, hh3.artifact()]);
    assert.equal(built.contractName, "project/contracts/Greeter.sol:Greeter");
    assert.equal(built.compiler.version, LONG);
    assertCleanInput(built, inputOf(bi));
    assertValid(built);
  });

  it("Hardhat 3 build-info plus output file, contract as input name, user name or bare Name", () => {
    for (const contract of [
      "project/contracts/Greeter.sol:Greeter",
      "contracts/Greeter.sol:Greeter",
      "Greeter",
    ]) {
      const built = build([hh3.buildInfo(), hh3.output()], { contract });
      assert.equal(built.contractName, "project/contracts/Greeter.sol:Greeter", contract);
      assert.equal(built.compiler.version, LONG);
      assertValid(built);
    }
  });

  it("Hardhat 3 build-info, output file and artifact together: no options needed", () => {
    const built = build([hh3.output(), hh3.artifact(), hh3.buildInfo()]);
    assert.equal(built.contractName, "project/contracts/Greeter.sol:Greeter");
  });

  it("bare Standard JSON with options.contract and options.compilerVersion", () => {
    const standard = inputOf(hh2.buildInfo());
    const built = build([standard], {
      contract: "contracts/Greeter.sol:Greeter",
      compilerVersion: LONG,
    });
    assert.equal(built.contractName, "contracts/Greeter.sol:Greeter");
    assert.equal(built.compiler.version, LONG);
    assertCleanInput(built, standard);
    assertValid(built);
  });

  it("bare Foundry Standard JSON (with basePath and friends) drops the extra keys", () => {
    const standard = inputOf(own.buildInfo());
    const built = build([standard], { contract: "src/Vault.sol:Vault", compilerVersion: LONG });
    assertCleanInput(built, standard);
    assert.ok(!JSON.stringify(built).includes(FOUNDRY_ROOT));
  });

  it("a short version plus options.compilerVersion succeeds", () => {
    const bi = rec(withoutOutputMetadata(hh2.buildInfo()));
    bi["solcLongVersion"] = "0.8.24";
    const built = build([bi], { contract: "Greeter", compilerVersion: LONG });
    assert.equal(built.compiler.version, LONG);
  });

  it("options.compilerVersion equal to the documents' version is accepted", () => {
    const built = build([hh2.buildInfo(), hh2.artifact()], { compilerVersion: LONG });
    assert.equal(built.compiler.version, LONG);
  });
});

// --- order, copies, no leaks --------------------------------------------------------------------

describe("buildVerifyInput: order, copies and local paths (R-IN-7)", () => {
  const sets: [string, () => unknown[], BuildVerifyInputOptions | undefined][] = [
    ["own Foundry", () => [own.buildInfo(), own.artifact()], undefined],
    [
      "committed Foundry",
      () => [committedFoundry.buildInfo(), committedFoundry.artifact()],
      undefined,
    ],
    ["Hardhat 2", () => [hh2.buildInfo(), hh2.artifact()], undefined],
    ["Hardhat 3 artifact", () => [hh3.buildInfo(), hh3.artifact()], undefined],
    ["Hardhat 3 all three", () => [hh3.buildInfo(), hh3.output(), hh3.artifact()], undefined],
    ["Hardhat 3 output", () => [hh3.buildInfo(), hh3.output()], { contract: "Greeter" }],
  ];
  for (const [label, docs, options] of sets) {
    it(`${label}: every order of the documents gives the same result`, () => {
      const reference = build(docs(), options);
      for (const order of permutations(docs())) {
        assert.deepEqual(build(order, options), reference);
      }
    });
  }

  it("Foundry's version, allowPaths, basePath and includePaths never reach the output", () => {
    for (const docs of [
      [own.buildInfo(), own.artifact()],
      [committedFoundry.buildInfo(), committedFoundry.artifact()],
    ]) {
      const built = build(docs);
      const input = rec(built.compiler.input);
      for (const k of ["version", "allowPaths", "basePath", "includePaths"]) {
        assert.ok(!(k in input), k);
      }
      const text = JSON.stringify(built);
      assert.ok(!text.includes(FOUNDRY_ROOT));
      assert.ok(!text.includes("<project-root>"));
    }
  });

  it("an unknown extra top-level input key holding an absolute path is dropped", () => {
    const bi = rec(hh2.buildInfo());
    inputOf(bi)["outputDirectory"] = "/Users/someone/secret/out";
    const built = build([bi, hh2.artifact()]);
    assert.ok(!JSON.stringify(built).includes("/Users/someone"));
  });

  it("the result shares no object with the documents", () => {
    const bi = hh2.buildInfo();
    const before = JSON.stringify(bi);
    const built = build([bi, hh2.artifact()]);
    const input = rec(built.compiler.input);
    rec(input["settings"])["mutated"] = true;
    rec(input["sources"])["x.sol"] = { content: "" };
    assert.equal(JSON.stringify(bi), before);
    assert.notEqual(input["sources"], inputOf(bi)["sources"]);
  });

  it("does not modify the documents passed", () => {
    const docs = [own.buildInfo(), own.artifact()];
    const before = JSON.stringify(docs);
    build(docs);
    assert.equal(JSON.stringify(docs), before);
  });
});

// --- failures (R-IN-7, R-DX-3) ------------------------------------------------------------------

describe("buildVerifyInput: documented failures give the documented code and field", () => {
  it("Foundry stub (committed and own): incomplete-input, field input, hint mentions --build-info", () => {
    for (const stub of [committedFoundry.stub(), own.stub()]) {
      const error = catchError(() => build([stub]));
      assert.equal(error.code, "incomplete-input");
      assert.equal(fieldOf(error), "input");
      assert.match(`${error.message} ${error.hint}`, /--build-info/);
      assert.equal(exitCodeOf(error), 2);
    }
  });

  it("Foundry stub plus its artifact: still incomplete-input, field input", () => {
    const error = catchError(() => build([own.stub(), own.artifact()]));
    assert.equal(error.code, "incomplete-input");
    assert.equal(fieldOf(error), "input");
  });

  it("Hardhat 3 output file alone: incomplete-input, field input", () => {
    const error = catchError(() => build([hh3.output()], { contract: "Greeter" }));
    assert.equal(error.code, "incomplete-input");
    assert.equal(fieldOf(error), "input");
  });

  it("short version without a long one: incomplete-input, field compilerVersion", () => {
    const hh2Short = rec(withoutOutputMetadata(hh2.buildInfo()));
    hh2Short["solcLongVersion"] = "0.8.24";
    const hh3Short = rec(hh3.buildInfo());
    hh3Short["solcLongVersion"] = "0.8.24";
    const cases: [unknown[], BuildVerifyInputOptions | undefined][] = [
      [[withoutOutputMetadata(own.buildInfo())], { contract: "Vault" }],
      [[withoutOutputMetadata(committedFoundry.buildInfo())], { contract: "Greeter" }],
      [[hh2Short, hh2.artifact()], undefined],
      [[hh3Short, hh3.artifact()], undefined],
    ];
    for (const [docs, options] of cases) {
      const error = catchError(() => build(docs, options));
      assert.equal(error.code, "incomplete-input");
      assert.equal(fieldOf(error), "compilerVersion");
      const d = error.details;
      assert.ok(d.code === "incomplete-input" && d.candidates.length === 0);
    }
  });

  it("bare Standard JSON without compilerVersion: incomplete-input, field compilerVersion", () => {
    const error = catchError(() =>
      build([inputOf(hh2.buildInfo())], { contract: "contracts/Greeter.sol:Greeter" }),
    );
    assert.equal(error.code, "incomplete-input");
    assert.equal(fieldOf(error), "compilerVersion");
  });

  it("a short options.compilerVersion is not accepted as the full version", () => {
    const error = catchError(() =>
      build([inputOf(hh2.buildInfo())], { contract: "Greeter", compilerVersion: "0.8.24" }),
    );
    assert.ok(["incomplete-input", "invalid-input"].includes(error.code), error.code);
  });

  it("options.compilerVersion that differs from the documents' version is rejected", () => {
    const error = catchError(() =>
      build([hh2.buildInfo(), hh2.artifact()], { compilerVersion: "0.8.25+commit.b61c2a91" }),
    );
    assert.equal(error.code, "invalid-input");
  });

  it("ambiguous bare name: incomplete-input, field contract, sorted candidates", () => {
    const error = catchError(() => build([own.buildInfo()], { contract: "Helper" }));
    assert.equal(error.code, "incomplete-input");
    assert.equal(fieldOf(error), "contract");
    const d = error.details;
    assert.ok(d.code === "incomplete-input");
    assert.deepEqual(d.candidates, ["src/Counter.sol:Helper", "src/extra/Helper.sol:Helper"]);
  });

  it("several contracts and no choice: incomplete-input, field contract, candidates listed", () => {
    const error = catchError(() => build([own.buildInfo()]));
    assert.equal(error.code, "incomplete-input");
    assert.equal(fieldOf(error), "contract");
    const d = error.details;
    assert.ok(d.code === "incomplete-input");
    const sorted = d.candidates.toSorted();
    assert.deepEqual(d.candidates, sorted);
    for (const name of [
      "src/Vault.sol:Vault",
      "src/Counter.sol:Helper",
      "src/extra/Helper.sol:Helper",
    ]) {
      assert.ok(d.candidates.includes(name), name);
    }
    assert.ok(d.candidates.length <= 20);
  });

  it("Hardhat 2 build-info alone (Base and Greeter): incomplete-input, field contract", () => {
    const error = catchError(() => build([hh2.buildInfo()]));
    assert.equal(error.code, "incomplete-input");
    assert.equal(fieldOf(error), "contract");
  });

  it("bare Standard JSON without contract: incomplete-input, field contract", () => {
    const error = catchError(() => build([inputOf(hh2.buildInfo())], { compilerVersion: LONG }));
    assert.equal(error.code, "incomplete-input");
    assert.equal(fieldOf(error), "contract");
  });

  it("candidates are capped at 20", () => {
    const bi = rec(own.buildInfo());
    const contracts = rec(rec(bi["output"])["contracts"]);
    const sources = rec(inputOf(bi)["sources"]);
    const meta = rec(rec(rec(contracts["src/Vault.sol"])["Vault"]));
    for (let i = 0; i < 25; i++) {
      const path = `src/gen/G${String(i).padStart(2, "0")}.sol`;
      sources[path] = {
        content: "// SPDX-License-Identifier: MIT\npragma solidity 0.8.24;\ncontract Dup {}\n",
      };
      contracts[path] = { Dup: clone(meta) };
    }
    const error = catchError(() => build([bi], { contract: "Dup" }));
    assert.equal(error.code, "incomplete-input");
    const d = error.details;
    assert.ok(d.code === "incomplete-input");
    assert.equal(d.candidates.length, 20);
    assert.deepEqual(d.candidates, d.candidates.toSorted());
  });

  it("path not in the sources: invalid-input naming the contract field", () => {
    for (const docs of [[own.buildInfo()], [hh2.buildInfo()]]) {
      const error = catchError(() => build(docs, { contract: "src/Nope.sol:Vault" }));
      assert.equal(error.code, "invalid-input");
      assert.ok(
        issueFields(error).some((f) => /contract/i.test(f)),
        issueFields(error).join(),
      );
    }
  });

  it("Name not in the documents: an ExplorerVerifyError naming the contract", () => {
    const error = catchError(() => build([hh2.buildInfo()], { contract: "NoSuchContract" }));
    assert.ok(["incomplete-input", "invalid-input"].includes(error.code), error.code);
    const named = fieldOf(error) ?? issueFields(error).join();
    assert.match(named, /contract/i);
  });

  it("non-solc compilerType: unsupported-compiler, field compilerType", () => {
    const bi = rec(hh3.buildInfo());
    bi["compilerType"] = "solx";
    const error = catchError(() => build([bi, hh3.artifact()]));
    assert.equal(error.code, "unsupported-compiler");
    assert.equal(fieldOf(error), "compilerType");
    assert.equal(exitCodeOf(error), 2);
  });

  it("a language other than Solidity: unsupported-compiler, field language", () => {
    const bi = rec(hh2.buildInfo());
    inputOf(bi)["language"] = "Vyper";
    const error = catchError(() => build([bi, hh2.artifact()]));
    assert.equal(error.code, "unsupported-compiler");
    assert.equal(fieldOf(error), "language");
  });

  it("ABI and bytecode only: insufficient-artifact, field input, three routes in the hint", () => {
    for (const docs of [[hh2.artifact()], [hh3.artifact()], [hh2.artifact(), hh3.artifact()]]) {
      const error = catchError(() => build(docs));
      assert.equal(error.code, "insufficient-artifact");
      assert.equal(fieldOf(error), "input");
      assert.equal(exitCodeOf(error), 2);
      const text = `${error.message}\n${error.hint}`;
      assert.match(text, /build-info|metadata/i, "route 1: publisher ships build-info or metadata");
      assert.match(text, /resolver|metadata hash/i, "route 2: bytecode-metadata resolver");
      assert.match(text, /similar/i, "route 3: explorer similar match");
      assert.match(error.message, /compiler input|settings/i);
      assert.match(error.docsUrl, /errors\.md#insufficient-artifact$/);
    }
  });

  it("documents of no known shape: invalid-input", () => {
    for (const docs of [[{}], [null], ["text"], [42], [[]], [{ abi: [] }]]) {
      const error = catchError(() => build(docs));
      assert.equal(error.code, "invalid-input", JSON.stringify(docs));
    }
  });

  it("no documents at all: an ExplorerVerifyError", () => {
    const error = catchError(() => build([]));
    assert.ok(["incomplete-input", "invalid-input"].includes(error.code), error.code);
  });

  it("two builds mixed: invalid-input", () => {
    for (const docs of [
      [hh2.buildInfo(), hh3.buildInfo()],
      [hh2.buildInfo(), own.buildInfo()],
      [own.buildInfo(), committedFoundry.artifact()],
      [hh2.buildInfo(), hh3.artifact()],
    ]) {
      const error = catchError(() => build(docs));
      assert.equal(error.code, "invalid-input");
    }
  });

  it("each new code has its exit code 2, a hint and a docs URL", () => {
    for (const code of [
      "incomplete-input",
      "insufficient-artifact",
      "unsupported-compiler",
    ] as const) {
      assert.equal(ERROR_EXIT_CODES[code], 2);
    }
    const error = catchError(() => build([own.stub()]));
    assert.ok(error.hint.length > 0);
    assert.match(error.docsUrl, /errors\.md#incomplete-input$/);
    assert.equal(error.retryable, false);
  });
});

// --- key redaction (R-SEC-1) --------------------------------------------------------------------

describe("buildVerifyInput: a key planted in any document never appears in an error", () => {
  function plant(doc: unknown): unknown {
    const copy = rec(clone(doc));
    copy["apiKey"] = KEY;
    copy["note"] = `apikey=${KEY}`;
    const input = copy["input"];
    if (isRecord(input)) {
      const settings = rec(input["settings"]);
      settings["apikey"] = KEY;
      const sources = rec(input["sources"]);
      for (const source of Object.values(sources)) {
        const s = rec(source);
        s["content"] = `// ${KEY}\n${String(s["content"])}`;
      }
    }
    return copy;
  }

  const failing: [string, () => unknown[], BuildVerifyInputOptions | undefined][] = [
    ["stub", () => [plant(own.stub())], undefined],
    ["short version", () => [plant(withoutOutputMetadata(own.buildInfo()))], { contract: "Vault" }],
    ["ambiguous", () => [plant(own.buildInfo())], { contract: "Helper" }],
    ["path not in sources", () => [plant(own.buildInfo())], { contract: `src/${KEY}.sol:Vault` }],
    ["name with key", () => [plant(own.buildInfo())], { contract: KEY }],
    [
      "compilerType",
      () => {
        const bi = rec(plant(hh3.buildInfo()));
        bi["compilerType"] = KEY;
        return [bi, plant(hh3.artifact())];
      },
      undefined,
    ],
    [
      "language",
      () => {
        const bi = rec(plant(hh2.buildInfo()));
        inputOf(bi)["language"] = KEY;
        return [bi];
      },
      { contract: "Greeter" },
    ],
    ["abi and bytecode", () => [plant(hh2.artifact())], undefined],
    ["unknown shape", () => [{ token: KEY, secret: KEY }], undefined],
    [
      "version",
      () => {
        const bi = rec(plant(withoutOutputMetadata(hh2.buildInfo())));
        bi["solcLongVersion"] = KEY;
        return [bi];
      },
      { contract: "Greeter" },
    ],
    [
      "compilerVersion option",
      () => [plant(inputOf(hh2.buildInfo()))],
      { contract: "Greeter", compilerVersion: KEY },
    ],
    [
      "absolute source path with key",
      () => {
        const bi = rec(hh2.buildInfo());
        const sources = rec(inputOf(bi)["sources"]);
        sources[`/home/${KEY}/Greeter.sol`] = sources["contracts/Greeter.sol"];
        delete sources["contracts/Greeter.sol"];
        return [plant(bi)];
      },
      { contract: `/home/${KEY}/Greeter.sol:Greeter` },
    ],
    [
      "contract named with key, ambiguous",
      () => {
        const bi = rec(own.buildInfo());
        const contracts = rec(rec(bi["output"])["contracts"]);
        const sources = rec(inputOf(bi)["sources"]);
        const vault = rec(rec(contracts["src/Vault.sol"])["Vault"]);
        sources[`src/${KEY}.sol`] = { content: "contract Vault {}" };
        contracts[`src/${KEY}.sol`] = { Vault: clone(vault) };
        return [plant(bi)];
      },
      { contract: "Vault" },
    ],
  ];

  for (const [label, docs, options] of failing) {
    it(`${label}: the error holds no key`, () => {
      const error = catchError(() => build(docs(), options));
      const text = everyText(error);
      assert.ok(!text.includes(KEY), `${label}: key leaked in ${error.code}`);
      assert.ok(!text.toLowerCase().includes(KEY.toLowerCase()));
    });
  }
});
