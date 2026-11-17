// The Standard JSON input each client sends for a Vyper input (#421; R-BE-6, R-QA-1, decision
// 0075): `language`, `sources`, `interfaces` when present, and `settings`, in that order, and no
// other key. No backend maps Vyper yet, so the clients are called directly, past the flow's kind
// check. The solc and zksolc forms stay as they were.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BackendName } from "../../src/backend-names.ts";
import type { Backend, Context } from "../../src/backends/backend.ts";
import { blockscout } from "../../src/backends/blockscout.ts";
import { standardJsonFields, standardJsonInput } from "../../src/backends/common.ts";
import { etherscanCompatible } from "../../src/backends/etherscan-compatible.ts";
import { etherscan } from "../../src/backends/etherscan.ts";
import { routescan } from "../../src/backends/routescan.ts";
import { sourcify } from "../../src/backends/sourcify.ts";
import { validateInput } from "../../src/input/validate.ts";
import type {
  Hex,
  SolcCompiler,
  SolidityStandardJsonInput,
  VerifyInput,
  VyperStandardJsonInput,
  ZksolcCompiler,
} from "../../src/types.ts";
import { replay } from "../helpers/fake-fetch.ts";
import type { Call } from "../helpers/fake-fetch.ts";
import { resolveRoute } from "../helpers/route.ts";

const SEPOLIA = 11155111;
const FUJI = 43113;
const ADDRESS: Hex = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const VERSION = "0.4.3+commit.bff19ea2";
// A fake key. Never a real one (R-SEC-1).
const DUMMY_KEY = "DUMMYKEYvyperrequest421";
const JOB = "0f6c2a8e-5b1d-4c3e-9a7f-2d8e1b4c6a90";
const COUNTER = "# pragma version 0.4.3\nimport IToken\ncount: public(uint256)\n";
const SOURCES = { "src/Counter.vy": { content: COUNTER } };
const INTERFACES = {
  "src/IToken.vyi": { content: "@external\ndef total() -> uint256:\n    ...\n" },
  "src/IOld.json": { abi: [{ type: "function", name: "old", inputs: [], outputs: [] }] },
};
const SETTINGS = { evmVersion: "prague", optimize: "gas", outputSelection: {} };

/** A checked Vyper input, with `interfaces` when `withInterfaces` is set. */
function vyperInput(withInterfaces: boolean): VerifyInput {
  return validateInput({
    chainId: SEPOLIA,
    address: ADDRESS,
    contractName: "src/Counter.vy:Counter",
    compiler: {
      kind: "vyper",
      version: VERSION,
      input: {
        // Keys out of order and keys the explorer must not get: only the four are sent.
        settings: SETTINGS,
        integrity: { "src/Counter.vy": "0x00" },
        compiler_version: "v0.4.3",
        ...(withInterfaces ? { interfaces: INTERFACES } : {}),
        sources: SOURCES,
        language: "Vyper",
      },
    },
  });
}

/** The JSON text of the expected input, keys in the order sent. */
function expected(withInterfaces: boolean): string {
  return JSON.stringify({
    language: "Vyper",
    sources: SOURCES,
    ...(withInterfaces ? { interfaces: INTERFACES } : {}),
    settings: SETTINGS,
  });
}

interface Client {
  readonly backend: Backend;
  readonly name: BackendName;
  readonly ctx: (fetch: typeof globalThis.fetch) => Context;
  readonly answer: () => Response;
  /** The Standard JSON input text the call sent. */
  readonly sent: (call: Call | undefined) => string;
}

const formAnswer = (): Response =>
  new Response(JSON.stringify({ status: "1", message: "OK", result: "abc123" }));

/** The `sourceCode` field of a form request. */
const formSent = (call: Call | undefined): string =>
  new URLSearchParams(call?.body).get("sourceCode") ?? "";

const apiKeys = { "etherscan-v2": DUMMY_KEY };

const CLIENTS: readonly Client[] = [
  {
    backend: etherscan,
    name: "etherscan-v2",
    ctx: (fetch) => ({
      route: resolveRoute(SEPOLIA, { backend: "etherscan-v2" }, { apiKeys }),
      apiKeys: () => apiKeys,
      http: { backend: "etherscan-v2", fetch, secrets: [DUMMY_KEY], random: () => 0 },
    }),
    answer: formAnswer,
    sent: formSent,
  },
  {
    backend: routescan,
    name: "routescan",
    ctx: (fetch) => ({
      route: resolveRoute(FUJI, { backend: "routescan" }),
      apiKeys: () => ({}),
      http: { backend: "routescan", fetch, secrets: [], random: () => 0 },
    }),
    answer: formAnswer,
    sent: formSent,
  },
  {
    backend: etherscanCompatible,
    name: "etherscan-compatible",
    ctx: (fetch) => ({
      route: resolveRoute(SEPOLIA, {
        backend: "etherscan-compatible",
        apiUrl: "https://explorer.example.org/api",
      }),
      apiKeys: () => ({}),
      http: { backend: "etherscan-compatible", fetch, secrets: [], random: () => 0 },
    }),
    answer: formAnswer,
    sent: formSent,
  },
  {
    backend: blockscout,
    name: "blockscout",
    ctx: (fetch) => ({
      route: resolveRoute(SEPOLIA, { backend: "blockscout" }),
      http: { backend: "blockscout", fetch, secrets: [], random: () => 0 },
    }),
    answer: formAnswer,
    sent: formSent,
  },
  {
    backend: sourcify,
    name: "sourcify",
    ctx: (fetch) => ({
      route: resolveRoute(SEPOLIA, { backend: "sourcify" }),
      http: { backend: "sourcify", fetch, secrets: [], random: () => 0 },
    }),
    answer: () => new Response(JSON.stringify({ verificationId: JOB }), { status: 202 }),
    sent: (call) => {
      const body: unknown = JSON.parse(call?.body ?? "null");
      assert.ok(typeof body === "object" && body !== null && "stdJsonInput" in body);
      return JSON.stringify(body.stdJsonInput);
    },
  },
];

describe("the Vyper input each client sends (#421, R-BE-6)", () => {
  for (const client of CLIENTS) {
    for (const withInterfaces of [true, false]) {
      it(`${client.name} sends ${withInterfaces ? "the interfaces" : "no interfaces key"}`, async () => {
        const fake = replay(client.answer());
        const outcome = await client.backend.submit(
          vyperInput(withInterfaces),
          client.ctx(fake.fetch),
        );
        assert.equal(outcome.state, "submitted");
        assert.equal(fake.calls.length, 1);
        const sent = client.sent(fake.calls[0]);
        assert.equal(sent, expected(withInterfaces));
        assert.equal(sent.includes('"interfaces"'), withInterfaces);
      });
    }
  }
});

describe("standardJsonInput (#421, R-BE-6, R-QA-1)", () => {
  it("keeps language, sources, interfaces and settings of a Vyper input, in that order", () => {
    const input = vyperInput(true);
    assert.equal(JSON.stringify(standardJsonInput(input.compiler)), expected(true));
    assert.deepEqual(Object.keys(standardJsonInput(input.compiler)), [
      "language",
      "sources",
      "interfaces",
      "settings",
    ]);
  });

  it("gives a Vyper input without interfaces no interfaces key", () => {
    const input = vyperInput(false);
    assert.deepEqual(Object.keys(standardJsonInput(input.compiler)), [
      "language",
      "sources",
      "settings",
    ]);
  });

  it("keeps an empty interfaces object, as Foundry writes it", () => {
    const json: VyperStandardJsonInput = {
      language: "Vyper",
      sources: SOURCES,
      interfaces: {},
      settings: {},
    };
    assert.equal(
      JSON.stringify(standardJsonInput({ kind: "vyper", version: VERSION, input: json })),
      '{"language":"Vyper","sources":{"src/Counter.vy":{"content":' +
        JSON.stringify(COUNTER) +
        '}},"interfaces":{},"settings":{}}',
    );
  });

  it("sends a solc or zksolc input's language, sources and settings only, byte for byte as before", () => {
    // An `interfaces` key on a Solidity input passes validation as an extra key; it is not sent.
    const solidity: SolidityStandardJsonInput = {
      language: "Solidity",
      sources: { "A.sol": { content: "contract A {}" } },
      settings: { optimizer: { enabled: true, runs: 200 } },
    };
    const extras = { interfaces: INTERFACES, integrity: {} };
    const extra: SolidityStandardJsonInput = { ...solidity, ...extras };
    const before =
      '{"language":"Solidity","sources":{"A.sol":{"content":"contract A {}"}},"settings":{"optimizer":{"enabled":true,"runs":200}}}';
    const solc: SolcCompiler = { kind: "solc", version: "0.8.24+commit.e11b9ed9", input: extra };
    const zksolc: ZksolcCompiler = {
      kind: "zksolc",
      version: "1.5.15",
      solcVersion: "0.8.24+commit.e11b9ed9",
      input: extra,
    };
    assert.equal(JSON.stringify(standardJsonInput(solc)), before);
    assert.equal(JSON.stringify(standardJsonInput(zksolc)), before);
    const base = { chainId: SEPOLIA, address: ADDRESS, contractName: "A.sol:A" };
    assert.deepEqual(standardJsonFields({ ...base, compiler: solc }), {
      action: "verifysourcecode",
      codeformat: "solidity-standard-json-input",
      sourceCode: before,
      contractaddress: ADDRESS,
      contractname: "A.sol:A",
      compilerversion: "v0.8.24+commit.e11b9ed9",
    });
    assert.deepEqual(standardJsonFields({ ...base, compiler: zksolc }), {
      action: "verifysourcecode",
      codeformat: "solidity-standard-json-input",
      sourceCode: before,
      contractaddress: ADDRESS,
      contractname: "A.sol:A",
      compilerversion: "v0.8.24+commit.e11b9ed9",
      zksolcVersion: "v1.5.15",
    });
  });
});
