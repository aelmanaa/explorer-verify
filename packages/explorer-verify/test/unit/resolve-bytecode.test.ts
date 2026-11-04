// Tests for the bytecode-metadata resolver (R-IN-5, decision 0026): reading the CBOR block, the
// IPFS hash solc computes, and resolveInputFromBytecode on recorded answers. The Sourcify, JSON-RPC
// and ipfs.io answers were recorded live on 2026-11-04; the solc vectors were compiled with the
// solc npm package 0.8.26 (see the source field of test/fixtures/ipfs/solc-0.8.26-greeter.json).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { ExplorerVerifyError } from "../../src/index.ts";
import type {
  ErrorCode,
  ErrorDetails,
  LogFields,
  Logger,
  MetadataAttempt,
} from "../../src/index.ts";
import { hexBytes, readAuxdata } from "../../src/input/resolvers/auxdata.ts";
import { resolveInputFromBytecode } from "../../src/input/resolvers/bytecode.ts";
import type { ResolveInputOptions } from "../../src/input/resolvers/bytecode.ts";
import { base58, ipfsCid } from "../../src/input/resolvers/ipfs.ts";
import { docsUrlOf } from "../helpers/docs-url.ts";
import { loadFixture, replay, responseOf } from "../helpers/fake-fetch.ts";
import type { Fixture } from "../helpers/fake-fetch.ts";

const ADDRESS = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const SEPOLIA = 11155111;
const TARGET = { chainId: SEPOLIA, address: ADDRESS } as const;
const RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
const GATEWAY = "http://127.0.0.1:8080";
const SOURCIFY = "https://sourcify.dev/server/v2/contract";
// The CID in the Sepolia Greeter's bytecode, which Sourcify verified on 2026-11-02.
const GREETER_CID = "QmQXfzJLPTjPUD1LWY6XQHqnWgqgDYEravjDpAMCtW4Uvb";
// A fake key. Never a real one (R-SEC-1).
const DUMMY_KEY = "DUMMYKEY0123456789ABCDEFGHIJKLMNO";

interface Vector {
  readonly name: string;
  readonly metadata: string;
  readonly runtime: string;
}

interface Vectors {
  readonly sources: Record<string, string>;
  readonly largeFill: number;
  readonly results: Vector[];
}

function readVectors(): Vectors {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL("../fixtures/ipfs/solc-0.8.26-greeter.json", import.meta.url), "utf8"),
  );
  assert.ok(typeof parsed === "object" && parsed !== null);
  assert.ok("sources" in parsed && "largeFill" in parsed && "results" in parsed);
  const { sources, largeFill, results } = parsed;
  assert.ok(typeof sources === "object" && sources !== null && typeof largeFill === "number");
  assert.ok(Array.isArray(results));
  const contents: Record<string, string> = {};
  for (const [path, content] of Object.entries(sources)) {
    assert.ok(typeof content === "string");
    contents[path] = content;
  }
  return {
    sources: contents,
    largeFill,
    results: results.map((entry: unknown) => {
      assert.ok(typeof entry === "object" && entry !== null);
      assert.ok("name" in entry && "metadata" in entry && "runtime" in entry);
      const { name, metadata, runtime } = entry;
      assert.ok(typeof name === "string" && typeof metadata === "string");
      assert.ok(typeof runtime === "string");
      return { name, metadata, runtime };
    }),
  };
}

const VECTORS = readVectors();
const GREETER = VECTORS.sources["src/Greeter.sol"] ?? "";
const BASE = VECTORS.sources["src/Base.sol"] ?? "";
const LARGE_CONTENT = `${GREETER}// ${"x".repeat(VECTORS.largeFill)}\n`;

function vector(name: string): Vector {
  const found = VECTORS.results.find((each) => each.name === name);
  assert.ok(found, name);
  return name === "large"
    ? { ...found, metadata: found.metadata.replace('"<LARGE>"', JSON.stringify(LARGE_CONTENT)) }
    : found;
}

/** The CID in the CBOR block of `runtime`, read with a plain search for the `ipfs` key. */
function cidIn(runtime: string): string {
  const at = runtime.lastIndexOf("6970667358221220");
  return base58(Uint8Array.from(Buffer.from(runtime.slice(at + 12, at + 12 + 68), "hex")));
}

function bytes(text: string): Uint8Array {
  const parsed = hexBytes(text);
  assert.ok(parsed, text);
  return parsed;
}

/** A CBOR block of `cbor` hex, appended to a short code with its two-byte length. */
function withCbor(cbor: string): Uint8Array {
  const length = cbor.length / 2;
  return bytes(`0x6080fe${cbor}${length.toString(16).padStart(4, "0")}`);
}

function sourcifyFixture(name: string): Fixture {
  return loadFixture("sourcify", name);
}

function fixtureWith(name: string, folder: string, body: unknown, status = 200): Response {
  const fixture = loadFixture(folder, name);
  return responseOf({ ...fixture, response: { ...fixture.response, status, body } });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

/** A fake fetch that answers by URL, for requests that may run in any order. */
function router(routes: Record<string, Response | Error>): {
  fetch: typeof fetch;
  urls: string[];
} {
  const urls: string[] = [];
  const fake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    assert.equal(init?.redirect, "manual");
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    const route = routes[url];
    if (route === undefined) {
      return textResponse("not found", 404);
    }
    if (route instanceof Error) {
      throw route;
    }
    return route.clone();
  };
  return { fetch: fake, urls };
}

/** The gateway URL of a CID on the test gateway. */
function ipfs(cid: string): string {
  return `${GATEWAY}/ipfs/${cid}`;
}

/** The `dweb:/ipfs/` CID of each source the metadata lists. */
function sourceCids(metadata: string): Map<string, string> {
  const parsed: unknown = JSON.parse(metadata);
  assert.ok(typeof parsed === "object" && parsed !== null && "sources" in parsed);
  const sources: unknown = parsed.sources;
  assert.ok(typeof sources === "object" && sources !== null);
  const cids = new Map<string, string>();
  for (const [path, entry] of Object.entries(sources)) {
    assert.ok(typeof entry === "object" && entry !== null);
    const urls: unknown = "urls" in entry ? entry.urls : [];
    for (const url of Array.isArray(urls) ? urls : []) {
      if (typeof url === "string" && url.startsWith("dweb:/ipfs/")) {
        cids.set(path, url.slice("dweb:/ipfs/".length));
      }
    }
  }
  return cids;
}

/** A fetch that never answers and rejects when its request is aborted. */
async function neverAnswers(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return await new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(new Error("aborted"));
    });
  });
}

/** A gateway that holds the metadata of `vector` and the Greeter sources. */
function gatewayRoutes(found: Vector): Record<string, Response> {
  const routes: Record<string, Response> = {
    [ipfs(cidIn(found.runtime))]: textResponse(found.metadata),
  };
  const cids = sourceCids(found.metadata);
  for (const [path, content] of Object.entries(VECTORS.sources)) {
    const cid = cids.get(path);
    if (cid !== undefined) {
      routes[ipfs(cid)] = textResponse(content);
    }
  }
  return routes;
}

/** A CBOR text item as hex: the header with its length, then the UTF-8 bytes. */
function cborText(text: string): string {
  const hex = Buffer.from(text).toString("hex");
  const length = hex.length / 2;
  const header =
    length < 24
      ? (0x60 + length).toString(16)
      : length < 256
        ? `78${length.toString(16).padStart(2, "0")}`
        : `79${length.toString(16).padStart(4, "0")}`;
  return header + hex;
}

async function rejection(promise: Promise<unknown>): Promise<ExplorerVerifyError> {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(outcome instanceof ExplorerVerifyError, `expected an error, got ${String(outcome)}`);
  return outcome;
}

function expectCode(error: ExplorerVerifyError, code: ErrorCode): void {
  assert.equal(error.code, code, error.message);
  assert.equal(error.docsUrl, docsUrlOf(code));
}

/** A logger that keeps every line and its fields as text. */
function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const keep =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      lines.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`);
    };
  return {
    logger: { debug: keep("debug"), info: keep("info"), warn: keep("warn"), error: keep("error") },
    lines,
  };
}

describe("readAuxdata (R-IN-5)", () => {
  it("reads the IPFS hash solc wrote, as the CID solc computed for the metadata", () => {
    const found = vector("ipfs");
    const auxdata = readAuxdata(bytes(found.runtime));
    assert.deepEqual(auxdata, { kind: "ipfs", cid: cidIn(found.runtime) });
    assert.equal(cidIn(found.runtime), ipfsCid(new TextEncoder().encode(found.metadata)));
  });

  it("reads a bzzr1 hash, a version-only block and no block", () => {
    const swarm = readAuxdata(bytes(vector("bzzr1").runtime));
    assert.equal(swarm.kind, "swarm");
    assert.ok(swarm.kind === "swarm");
    assert.equal(swarm.key, "bzzr1");
    assert.match(swarm.hex, /^[0-9a-f]{64}$/);
    assert.deepEqual(readAuxdata(bytes(vector("none").runtime)), { kind: "version-only" });
    assert.deepEqual(readAuxdata(bytes(vector("nocbor").runtime)), { kind: "no-metadata" });
    assert.deepEqual(readAuxdata(new Uint8Array()), { kind: "no-code" });
  });

  it("reads a bzzr0 hash, the experimental flag and one- and two-byte lengths", () => {
    const hash = "ab".repeat(32);
    // { "bzzr0": h'..', "experimental": true, "solc": "0.5.17" }
    const cbor = ["a3", cborText("bzzr0"), "5820", hash, cborText("experimental"), "f5"];
    cbor.push(cborText("solc"), cborText("0.5.17"));
    assert.deepEqual(readAuxdata(withCbor(cbor.join(""))), {
      kind: "swarm",
      key: "bzzr0",
      hex: hash,
    });
    // A key of 30 bytes takes a one-byte length; a value of 300 bytes a two-byte length.
    const lengths = [
      "a2",
      cborText("k".repeat(30)),
      "f4",
      cborText("solc"),
      cborText("x".repeat(300)),
    ];
    assert.deepEqual(readAuxdata(withCbor(lengths.join(""))), { kind: "version-only" });
  });

  it("treats anything solc does not write as no metadata", () => {
    const solc = cborText("solc") + "43000818";
    const cases: [string, Uint8Array][] = [
      ["a length longer than the code", bytes("0x00ff")],
      ["a zero length", bytes("0x60800000")],
      ["one byte of code", bytes("0x00")],
      ["not a map", withCbor(`82${solc}`)],
      ["a map of 24 entries or more", withCbor(`b818${solc}`)],
      ["a key that is a number", withCbor("a10143000818")],
      ["a key that is bytes", withCbor("a14100f4")],
      ["an array value", withCbor(`a1${cborText("solc")}80`)],
      ["a four-byte length", withCbor(`a17a00000004${Buffer.from("solc").toString("hex")}f4`)],
      ["a block that ends early", withCbor(`a2${solc}`)],
      ["a value cut short", withCbor(`a1${cborText("solc")}45000818`)],
      ["a byte after the map", withCbor(`a1${solc}00`)],
      ["a map without solc or a hash", withCbor(`a1${cborText("experimental")}f5`)],
      ["an ipfs value of the wrong size", withCbor(`a1${cborText("ipfs")}4112`)],
    ];
    for (const [what, code] of cases) {
      assert.deepEqual(readAuxdata(code), { kind: "no-metadata" }, what);
    }
    // An ipfs value that is not a sha2-256 multihash is not a hash; the block still has solc.
    const otherHash = ["a2", cborText("ipfs"), "5822", "1320", "00".repeat(32), solc];
    assert.deepEqual(readAuxdata(withCbor(otherHash.join(""))), { kind: "version-only" });
    const shortSwarm = ["a2", cborText("bzzr1"), "4100", solc];
    assert.deepEqual(readAuxdata(withCbor(shortSwarm.join(""))), { kind: "version-only" });
  });

  it("reads hex with hexBytes only when it is 0x and an even number of hex digits", () => {
    assert.deepEqual(hexBytes("0x"), new Uint8Array());
    assert.deepEqual(hexBytes("0x00fF"), Uint8Array.from([0, 255]));
    assert.equal(hexBytes("0x0"), undefined);
    assert.equal(hexBytes("00"), undefined);
    assert.equal(hexBytes("0xzz"), undefined);
  });
});

describe("ipfsCid (R-IN-5, decision 0026)", () => {
  it("gives solc's CID for metadata of one chunk and of two chunks", () => {
    for (const name of ["ipfs", "large"]) {
      const found = vector(name);
      assert.equal(ipfsCid(new TextEncoder().encode(found.metadata)), cidIn(found.runtime), name);
    }
    assert.ok(new TextEncoder().encode(vector("large").metadata).byteLength > 262_144);
  });

  it("gives solc's CID for each source, as the metadata's dweb URL records it", () => {
    const cids = sourceCids(vector("ipfs").metadata);
    for (const [path, content] of Object.entries(VECTORS.sources)) {
      assert.equal(ipfsCid(new TextEncoder().encode(content)), cids.get(path), path);
    }
  });

  it("gives the CID of the empty file, and keeps leading zero bytes in base58", () => {
    assert.equal(ipfsCid(new Uint8Array()), "QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH");
    assert.equal(base58(Uint8Array.from([0, 0, 1])), "112");
    assert.equal(base58(new Uint8Array()), "");
  });
});

describe("resolveInputFromBytecode: a verified copy on Sourcify (R-IN-5)", () => {
  it("reads the bytecode over JSON-RPC and copies Sourcify's metadata and sources", async () => {
    const { fetch, calls } = replay(
      loadFixture("rpc", "2026-11-04-eth-chainid-sepolia"),
      loadFixture("rpc", "2026-11-04-eth-getcode-greeter"),
      sourcifyFixture("2026-11-04-all-chains-greeter"),
      sourcifyFixture("2026-11-04-contract-metadata-sources"),
    );
    const { logger, lines } = recordingLogger();
    const built = await resolveInputFromBytecode(TARGET, { rpcUrl: RPC_URL, fetch, logger });
    assert.equal(built.contractName, "contracts/Greeter.sol:Greeter");
    assert.equal(built.compiler.version, "0.8.24+commit.e11b9ed9");
    assert.deepEqual(Object.keys(built.compiler.input.sources).toSorted(), [
      "contracts/Base.sol",
      "contracts/Greeter.sol",
    ]);
    assert.deepEqual(
      calls.map(({ method, url }) => `${method} ${url}`),
      [
        `POST ${RPC_URL}`,
        `POST ${RPC_URL}`,
        `GET ${SOURCIFY}/all-chains/${ADDRESS}`,
        `GET ${SOURCIFY}/${String(SEPOLIA)}/${ADDRESS}?fields=metadata,sources`,
      ],
    );
    assert.deepEqual(JSON.parse(calls[0]?.body ?? ""), {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_chainId",
      params: [],
    });
    assert.deepEqual(JSON.parse(calls[1]?.body ?? "").params, [ADDRESS, "latest"]);
    assert.equal(calls[0]?.headers.get("content-type"), "application/json");
    assert.ok(lines.some((line) => line.includes(GREETER_CID)));
    assert.ok(lines.some((line) => line.startsWith("info sourcify: found a verified copy")));
  });

  it("takes the bytecode from the options and sends no JSON-RPC request", async () => {
    const getCode = loadFixture("rpc", "2026-11-04-eth-getcode-greeter").response.body;
    assert.ok(typeof getCode === "object" && getCode !== null && "result" in getCode);
    assert.ok(typeof getCode.result === "string");
    const { fetch, calls } = replay(
      sourcifyFixture("2026-11-04-all-chains-greeter"),
      sourcifyFixture("2026-11-04-contract-metadata-sources"),
    );
    const built = await resolveInputFromBytecode(
      { chainId: SEPOLIA, address: "0x8275D36F64F047D2D8a1F42c79Bf80Caea39D7cC" },
      { bytecode: getCode.result, fetch },
    );
    assert.equal(built.contractName, "contracts/Greeter.sol:Greeter");
    assert.equal(calls.length, 2);
  });

  it("skips a copy whose metadata has another hash, and takes the next one", async () => {
    const getCode = vector("ipfs");
    const metadata: unknown = JSON.parse(getCode.metadata);
    const routes = {
      [`${SOURCIFY}/all-chains/${ADDRESS}`]: json({
        results: [
          { chainId: "84532", match: "match" },
          { chainId: "421614", match: "exact_match" },
          { chainId: "0x12", match: "exact_match" },
          { chainId: "1", match: null },
          "not an object",
        ],
      }),
      [`${SOURCIFY}/421614/${ADDRESS}?fields=metadata,sources`]: json({
        metadata: { ...(typeof metadata === "object" ? metadata : {}), language: "Vyper" },
        sources: {},
      }),
      [`${SOURCIFY}/84532/${ADDRESS}?fields=metadata,sources`]: json({
        metadata,
        sources: {
          "src/Greeter.sol": { content: GREETER },
          "src/Base.sol": { content: BASE },
          "src/Other.sol": { content: 7 },
        },
      }),
    };
    const { fetch, urls } = router(routes);
    const { logger, lines } = recordingLogger();
    const built = await resolveInputFromBytecode(TARGET, {
      bytecode: getCode.runtime,
      fetch,
      logger,
    });
    assert.equal(built.contractName, "src/Greeter.sol:Greeter");
    // Exact matches on other chains come before partial ones; neither is the call's chain.
    assert.deepEqual(urls.slice(1), [
      `${SOURCIFY}/421614/${ADDRESS}?fields=metadata,sources`,
      `${SOURCIFY}/84532/${ADDRESS}?fields=metadata,sources`,
    ]);
    assert.ok(lines.some((line) => line.startsWith("warn sourcify: a verified copy has other")));
  });

  it("fetches at most three copies, the call's chain first", async () => {
    const results = ["1", "10", "137", String(SEPOLIA), "8453"].map((chainId) => ({
      chainId,
      match: "exact_match",
    }));
    const { fetch, urls } = router({
      [`${SOURCIFY}/all-chains/${ADDRESS}`]: json({ results }),
    });
    const error = await rejection(
      resolveInputFromBytecode(TARGET, { bytecode: vector("ipfs").runtime, fetch }),
    );
    expectCode(error, "metadata-unavailable");
    assert.deepEqual(urls.slice(1), [
      `${SOURCIFY}/${String(SEPOLIA)}/${ADDRESS}?fields=metadata,sources`,
      `${SOURCIFY}/1/${ADDRESS}?fields=metadata,sources`,
      `${SOURCIFY}/10/${ADDRESS}?fields=metadata,sources`,
    ]);
    assert.ok(error.details.code === "metadata-unavailable");
    assert.deepEqual(error.details.attempts, [
      { source: "sourcify", outcome: "not-found", status: 404 },
      { source: "sourcify", outcome: "not-found", status: 404 },
      { source: "sourcify", outcome: "not-found", status: 404 },
    ]);
  });

  it("uses a Swarm hash only through an exact match on the same chain", async () => {
    const swarm = vector("bzzr1");
    const metadata: unknown = JSON.parse(swarm.metadata);
    const copy = json({
      metadata,
      sources: { "src/Greeter.sol": { content: GREETER }, "src/Base.sol": { content: BASE } },
    });
    const same = router({
      [`${SOURCIFY}/all-chains/${ADDRESS}`]: json({
        results: [{ chainId: String(SEPOLIA), match: "exact_match" }],
      }),
      [`${SOURCIFY}/${String(SEPOLIA)}/${ADDRESS}?fields=metadata,sources`]: copy,
    });
    const built = await resolveInputFromBytecode(TARGET, {
      bytecode: swarm.runtime,
      fetch: same.fetch,
    });
    assert.equal(built.contractName, "src/Greeter.sol:Greeter");

    for (const results of [
      [{ chainId: "1", match: "exact_match" }],
      [{ chainId: String(SEPOLIA), match: "match" }],
    ]) {
      const other = router({
        [`${SOURCIFY}/all-chains/${ADDRESS}`]: json({ results }),
        [`${SOURCIFY}/1/${ADDRESS}?fields=metadata,sources`]: copy,
        [`${SOURCIFY}/${String(SEPOLIA)}/${ADDRESS}?fields=metadata,sources`]: copy,
      });
      const error = await rejection(
        resolveInputFromBytecode(TARGET, { bytecode: swarm.runtime, fetch: other.fetch }),
      );
      expectCode(error, "metadata-unavailable");
      assert.ok(error.details.code === "metadata-unavailable");
      assert.match(error.details.hash, /^bzzr1:[0-9a-f]{64}$/);
      assert.deepEqual(error.details.attempts, [
        { source: "sourcify", outcome: "hash-mismatch", status: 200 },
      ]);
    }
  });

  it("reports a contract Sourcify does not hold as not-found, and sends nothing to IPFS without a gateway", async () => {
    const { fetch, calls } = replay(
      fixtureWith("2026-11-04-all-chains-not-verified", "sourcify", { results: [] }, 404),
    );
    const error = await rejection(
      resolveInputFromBytecode(TARGET, { bytecode: vector("ipfs").runtime, fetch }),
    );
    expectCode(error, "metadata-unavailable");
    assert.equal(error.retryable, true);
    assert.ok(error.details.code === "metadata-unavailable");
    assert.equal(error.details.hash, `ipfs:${cidIn(vector("ipfs").runtime)}`);
    assert.deepEqual(error.details.attempts, [
      { source: "sourcify", outcome: "not-found", status: 404 },
    ]);
    assert.equal(calls.length, 1);
  });

  it("reports Sourcify answers it cannot use as unavailable", async () => {
    const cases: [string, Record<string, Response>, { outcome: string; status?: number }[]][] = [
      [
        "a 500 on the list",
        { [`${SOURCIFY}/all-chains/${ADDRESS}`]: json({ error: "x" }, 500) },
        [{ outcome: "unavailable", status: 500 }],
      ],
      [
        "a redirect on the list",
        {
          [`${SOURCIFY}/all-chains/${ADDRESS}`]: new Response(null, {
            status: 302,
            headers: { location: "https://elsewhere.example" },
          }),
        },
        [{ outcome: "unavailable", status: 302 }],
      ],
      [
        "a copy without metadata, then a copy that redirects",
        {
          [`${SOURCIFY}/all-chains/${ADDRESS}`]: json({
            results: [
              { chainId: String(SEPOLIA), match: "exact_match" },
              { chainId: "1", match: "exact_match" },
            ],
          }),
          [`${SOURCIFY}/${String(SEPOLIA)}/${ADDRESS}?fields=metadata,sources`]: json({
            sources: {},
          }),
          [`${SOURCIFY}/1/${ADDRESS}?fields=metadata,sources`]: new Response(null, {
            status: 301,
          }),
        },
        [
          { outcome: "unavailable", status: 200 },
          { outcome: "unavailable", status: 301 },
        ],
      ],
    ];
    for (const [what, routes, attempts] of cases) {
      const { fetch } = router(routes);
      const error = await rejection(
        resolveInputFromBytecode(TARGET, { bytecode: vector("ipfs").runtime, fetch }),
      );
      expectCode(error, "metadata-unavailable");
      assert.ok(error.details.code === "metadata-unavailable");
      assert.deepEqual(
        error.details.attempts,
        attempts.map((each) => ({ source: "sourcify", ...each })),
        what,
      );
    }
  });

  it("reads a list whose results are not an array as no copy, and a copy without sources", async () => {
    const found = vector("ipfs");
    const metadata: unknown = JSON.parse(found.metadata);
    const odd = router({ [`${SOURCIFY}/all-chains/${ADDRESS}`]: json({ results: "none" }) });
    const error = await rejection(
      resolveInputFromBytecode(TARGET, { bytecode: found.runtime, fetch: odd.fetch }),
    );
    assert.ok(error.details.code === "metadata-unavailable");
    assert.deepEqual(error.details.attempts, [
      { source: "sourcify", outcome: "not-found", status: 200 },
    ]);
    const bare = router({
      [`${SOURCIFY}/all-chains/${ADDRESS}`]: json({
        results: [{ chainId: String(SEPOLIA), match: "exact_match" }],
      }),
      [`${SOURCIFY}/${String(SEPOLIA)}/${ADDRESS}?fields=metadata,sources`]: json({
        metadata,
        sources: "none",
      }),
    });
    const built = await resolveInputFromBytecode(TARGET, {
      bytecode: found.runtime,
      sources: VECTORS.sources,
      fetch: bare.fetch,
    });
    assert.equal(built.contractName, "src/Greeter.sol:Greeter");
  });

  it("asks no one but the gateway when sourcify is false", async () => {
    const { fetch, urls } = router({});
    const error = await rejection(
      resolveInputFromBytecode(TARGET, {
        bytecode: vector("ipfs").runtime,
        sourcify: false,
        ipfsGateway: GATEWAY,
        fetch,
      }),
    );
    expectCode(error, "metadata-unavailable");
    assert.deepEqual(urls, [ipfs(cidIn(vector("ipfs").runtime))]);
  });
});

describe("resolveInputFromBytecode: an IPFS gateway (R-IN-5, R-SEC-2)", () => {
  it("fetches the metadata and each source from the gateway, and rebuilds the input", async () => {
    const found = vector("ipfs");
    const routes = gatewayRoutes(found);
    const { fetch, urls } = router(routes);
    const built = await resolveInputFromBytecode(TARGET, {
      bytecode: found.runtime,
      sourcify: false,
      ipfsGateway: `${GATEWAY}/`,
      fetch,
    });
    assert.equal(built.contractName, "src/Greeter.sol:Greeter");
    assert.equal(built.compiler.version, "0.8.26+commit.8a97fa7a");
    const sources = built.compiler.input.sources;
    assert.equal(sources["src/Greeter.sol"]?.content, GREETER);
    assert.equal(sources["src/Base.sol"]?.content, BASE);
    assert.deepEqual(urls.toSorted(), Object.keys(routes).toSorted());
  });

  it("keeps the gateway's query string and redacts the gateway's token from errors", async () => {
    const found = vector("ipfs");
    const { fetch, urls } = router({});
    const error = await rejection(
      resolveInputFromBytecode(TARGET, {
        bytecode: found.runtime,
        sourcify: false,
        ipfsGateway: `https://gw.example/${DUMMY_KEY}?token=${DUMMY_KEY}`,
        fetch,
      }),
    );
    expectCode(error, "metadata-unavailable");
    assert.deepEqual(urls, [
      `https://gw.example/${DUMMY_KEY}/ipfs/${cidIn(found.runtime)}?token=${DUMMY_KEY}`,
    ]);
    assert.ok(error.details.code === "metadata-unavailable");
    assert.deepEqual(error.details.attempts, [
      { source: "ipfs", outcome: "not-found", status: 404 },
    ]);
    assert.doesNotMatch(JSON.stringify([error, error.details, error.message]), /DUMMYKEY/);
  });

  it("rebuilds a two-chunk metadata whose source is embedded", async () => {
    const found = vector("large");
    const routes = gatewayRoutes(found);
    const { fetch } = router(routes);
    const built = await resolveInputFromBytecode(TARGET, {
      bytecode: found.runtime,
      sourcify: false,
      ipfsGateway: GATEWAY,
      fetch,
    });
    assert.equal(built.compiler.input.sources["src/Greeter.sol"]?.content, LARGE_CONTENT);
  });

  it("uses the caller's sources instead of fetching them", async () => {
    const found = vector("ipfs");
    const { fetch, urls } = router({ [ipfs(cidIn(found.runtime))]: textResponse(found.metadata) });
    const built = await resolveInputFromBytecode(TARGET, {
      bytecode: found.runtime,
      sourcify: false,
      ipfsGateway: GATEWAY,
      sources: VECTORS.sources,
      fetch,
    });
    assert.equal(built.contractName, "src/Greeter.sol:Greeter");
    assert.equal(urls.length, 1);
  });

  it("falls back to the gateway when Sourcify does not hold the contract", async () => {
    const found = vector("ipfs");
    const { fetch, urls } = router({
      ...gatewayRoutes(found),
      [`${SOURCIFY}/all-chains/${ADDRESS}`]: json({ results: [] }, 404),
    });
    const built = await resolveInputFromBytecode(TARGET, {
      bytecode: found.runtime,
      ipfsGateway: GATEWAY,
      fetch,
    });
    assert.equal(built.contractName, "src/Greeter.sol:Greeter");
    assert.equal(urls[0], `${SOURCIFY}/all-chains/${ADDRESS}`);
  });

  it("refuses metadata from the gateway whose CID differs from the bytecode's", async () => {
    const found = vector("ipfs");
    const { fetch } = router({
      [ipfs(cidIn(found.runtime))]: textResponse(found.metadata.replace("paris", "shanghai")),
    });
    const { logger, lines } = recordingLogger();
    const error = await rejection(
      resolveInputFromBytecode(TARGET, {
        bytecode: found.runtime,
        sourcify: false,
        ipfsGateway: GATEWAY,
        fetch,
        logger,
      }),
    );
    expectCode(error, "metadata-unavailable");
    assert.ok(error.details.code === "metadata-unavailable");
    assert.deepEqual(error.details.attempts, [
      { source: "ipfs", outcome: "hash-mismatch", status: 200 },
    ]);
    assert.ok(lines.some((line) => line.startsWith("warn ipfs: the gateway answered with other")));
  });

  it("reports the ipfs.io answer recorded on 2026-11-04 as unavailable, with its status", async () => {
    const sunset = loadFixture("ipfs", "2026-11-04-ipfs-io-sunset");
    const { fetch } = router({
      [`https://ipfs.io/ipfs/${GREETER_CID}`]: responseOf(sunset),
      [`${SOURCIFY}/all-chains/${ADDRESS}`]: json({ results: [] }, 404),
    });
    const getCode = loadFixture("rpc", "2026-11-04-eth-getcode-greeter").response.body;
    assert.ok(typeof getCode === "object" && getCode !== null && "result" in getCode);
    assert.ok(typeof getCode.result === "string");
    const error = await rejection(
      resolveInputFromBytecode(TARGET, {
        bytecode: getCode.result,
        ipfsGateway: "https://ipfs.io",
        fetch,
      }),
    );
    expectCode(error, "metadata-unavailable");
    assert.ok(error.details.code === "metadata-unavailable");
    assert.equal(error.details.hash, `ipfs:${GREETER_CID}`);
    assert.deepEqual(error.details.attempts, [
      { source: "sourcify", outcome: "not-found", status: 404 },
      { source: "ipfs", outcome: "unavailable", status: 429 },
    ]);
  });

  it("reports a gateway answer of another status as unavailable", async () => {
    const found = vector("ipfs");
    const { fetch } = router({ [ipfs(cidIn(found.runtime))]: textResponse("bad", 500) });
    const error = await rejection(
      resolveInputFromBytecode(TARGET, {
        bytecode: found.runtime,
        sourcify: false,
        ipfsGateway: GATEWAY,
        fetch,
      }),
    );
    assert.ok(error.details.code === "metadata-unavailable");
    assert.deepEqual(error.details.attempts, [
      { source: "ipfs", outcome: "unavailable", status: 500 },
    ]);
  });

  it("lists a source the gateway does not hold in incomplete-input", async () => {
    const found = vector("ipfs");
    const routes = gatewayRoutes(found);
    const baseCid = sourceCids(found.metadata).get("src/Base.sol") ?? "";
    delete routes[ipfs(baseCid)];
    const { fetch } = router(routes);
    const error = await rejection(
      resolveInputFromBytecode(TARGET, {
        bytecode: found.runtime,
        sourcify: false,
        ipfsGateway: GATEWAY,
        fetch,
      }),
    );
    expectCode(error, "incomplete-input");
    assert.ok(error.details.code === "incomplete-input");
    assert.deepEqual(error.details.candidates, ["src/Base.sol"]);
  });

  it("fails with source-mismatch when the gateway serves another source for a CID", async () => {
    const found = vector("ipfs");
    const routes = gatewayRoutes(found);
    const baseCid = sourceCids(found.metadata).get("src/Base.sol") ?? "";
    routes[ipfs(baseCid)] = textResponse(`${BASE}\n`);
    const { fetch } = router(routes);
    const error = await rejection(
      resolveInputFromBytecode(TARGET, {
        bytecode: found.runtime,
        sourcify: false,
        ipfsGateway: GATEWAY,
        fetch,
      }),
    );
    expectCode(error, "source-mismatch");
    assert.ok(error.details.code === "source-mismatch");
    assert.equal(error.details.path, "src/Base.sol");
  });

  it("ends with metadata-unavailable when the gateway fails on a source", async () => {
    const found = vector("ipfs");
    for (const failure of [textResponse("bad", 500), new Response(null, { status: 307 })]) {
      const routes = gatewayRoutes(found);
      const baseCid = sourceCids(found.metadata).get("src/Base.sol") ?? "";
      routes[ipfs(baseCid)] = failure;
      const { fetch } = router(routes);
      const error = await rejection(
        resolveInputFromBytecode(TARGET, {
          bytecode: found.runtime,
          sourcify: false,
          ipfsGateway: GATEWAY,
          fetch,
        }),
      );
      expectCode(error, "metadata-unavailable");
      assert.ok(error.details.code === "metadata-unavailable");
      assert.deepEqual(error.details.attempts, [
        { source: "ipfs", outcome: "unavailable", status: failure.status },
      ]);
    }
  });

  it("asks for no source whose URL is not a dweb CIDv0, and leaves it to the builder", async () => {
    const found = vector("ipfs");
    const metadata = found.metadata
      .replace(/dweb:\/ipfs\/Qm[1-9A-HJ-NP-Za-km-z]{44}/g, "dweb:/ipfs/../../etc")
      .replace('"urls":["bzz-raw', '"urls":[7,"bzz-raw');
    // The changed metadata has another CID, so the bytecode is changed to carry it.
    const runtime = found.runtime.replace(
      cidHex(found.runtime),
      cidHexOf(ipfsCid(new TextEncoder().encode(metadata))),
    );
    const { fetch, urls } = router({
      [ipfs(ipfsCid(new TextEncoder().encode(metadata)))]: textResponse(metadata),
    });
    const error = await rejection(
      resolveInputFromBytecode(TARGET, {
        bytecode: runtime,
        sourcify: false,
        ipfsGateway: GATEWAY,
        fetch,
      }),
    );
    expectCode(error, "incomplete-input");
    assert.equal(urls.length, 1);
  });

  it("reports a file with the right CID that is not metadata as not-metadata", async () => {
    const found = vector("ipfs");
    for (const file of ['{"note":"not metadata"}', "plain text"]) {
      const cid = ipfsCid(new TextEncoder().encode(file));
      const runtime = found.runtime.replace(cidHex(found.runtime), cidHexOf(cid));
      const { fetch } = router({ [ipfs(cid)]: textResponse(file) });
      const error = await rejection(
        resolveInputFromBytecode(TARGET, {
          bytecode: runtime,
          sourcify: false,
          ipfsGateway: GATEWAY,
          fetch,
        }),
      );
      expectCode(error, "metadata-unavailable");
      assert.ok(error.details.code === "metadata-unavailable");
      assert.deepEqual(error.details.attempts, [
        { source: "ipfs", outcome: "not-metadata", status: 200 },
      ]);
    }
  });

  it("records a timeout and stops when the time budget runs out", async () => {
    const found = vector("ipfs");
    const error = await rejection(
      resolveInputFromBytecode(TARGET, {
        bytecode: found.runtime,
        ipfsGateway: GATEWAY,
        fetch: neverAnswers,
        timeoutMs: 50,
      }),
    );
    expectCode(error, "metadata-unavailable");
    assert.ok(error.details.code === "metadata-unavailable");
    assert.deepEqual(error.details.attempts, [{ source: "sourcify", outcome: "timeout" }]);
    assert.match(error.message, /time budget/);
  });
});

describe("resolveInputFromBytecode: bounded work on large answers (R-FLOW-6)", () => {
  // Block coverage (c8 sets NODE_V8_COVERAGE) slows hashing many times over, so the time bound
  // runs only in the plain test runs, as in keccak.test.ts.
  const timed = process.env["NODE_V8_COVERAGE"] === undefined;
  it(
    "hashes 4 MiB of metadata in well under the default budget, best of three runs",
    {
      skip: timed ? false : "timing is not meaningful under coverage",
    },
    () => {
      const large = new Uint8Array(4 * 1024 * 1024).fill(0x78);
      const times: number[] = [];
      for (let run = 0; run < 3; run++) {
        const start = performance.now();
        ipfsCid(large);
        times.push(performance.now() - start);
      }
      assert.ok(Math.min(...times) < 5_000, `took ${String(Math.min(...times))} ms`);
    },
  );

  it("refuses 16 MiB of bytecode hex before parsing it", async () => {
    const start = performance.now();
    const issues = await issuesOf(TARGET, { bytecode: `0x${"60".repeat(16 * 1024 * 1024)}` });
    assert.equal(issues.length, 1);
    assert.ok(performance.now() - start < 2_000);
  });

  it("refuses eth_getCode above 65536 bytes and a JSON-RPC answer above 1 MiB", async () => {
    const big = replay(
      loadFixture("rpc", "2026-11-04-eth-chainid-sepolia"),
      json({ jsonrpc: "2.0", id: 1, result: `0x${"60".repeat(65_537)}` }),
    );
    const error = await rejection(
      resolveInputFromBytecode(TARGET, { rpcUrl: RPC_URL, fetch: big.fetch }),
    );
    assert.ok(error.details.code === "metadata-unavailable");
    assert.deepEqual(error.details.attempts, [
      { source: "rpc", outcome: "unavailable", status: 200 },
    ]);
    const huge = replay(json({ jsonrpc: "2.0", id: 1, result: "x".repeat(1_048_577) }));
    const refused = await rejection(
      resolveInputFromBytecode(TARGET, { rpcUrl: RPC_URL, fetch: huge.fetch }),
    );
    assert.ok(refused.details.code === "metadata-unavailable");
    assert.deepEqual(refused.details.attempts, [
      { source: "rpc", outcome: "unavailable", status: 200 },
    ]);
  });

  it("skips a Sourcify copy whose metadata is larger than 4 MiB without hashing it", async () => {
    const { fetch } = router({
      [`${SOURCIFY}/all-chains/${ADDRESS}`]: json({
        results: [{ chainId: String(SEPOLIA), match: "exact_match" }],
      }),
      [`${SOURCIFY}/${String(SEPOLIA)}/${ADDRESS}?fields=metadata,sources`]: json({
        metadata: { padding: "x".repeat(4 * 1024 * 1024) },
        sources: {},
      }),
    });
    const error = await rejection(
      resolveInputFromBytecode(TARGET, { bytecode: vector("ipfs").runtime, fetch }),
    );
    assert.ok(error.details.code === "metadata-unavailable");
    assert.deepEqual(error.details.attempts, [
      { source: "sourcify", outcome: "unavailable", status: 200 },
    ]);
  });
});

describe("resolveInputFromBytecode: a Sourcify copy that is not usable as it is (R-IN-5)", () => {
  it("drops a Sourcify source that fails its hash and takes it from the gateway", async () => {
    const found = vector("ipfs");
    const metadata: unknown = JSON.parse(found.metadata);
    const copy = {
      [`${SOURCIFY}/all-chains/${ADDRESS}`]: json({
        results: [{ chainId: String(SEPOLIA), match: "exact_match" }],
      }),
      [`${SOURCIFY}/${String(SEPOLIA)}/${ADDRESS}?fields=metadata,sources`]: json({
        metadata,
        sources: {
          "src/Greeter.sol": { content: GREETER },
          "src/Base.sol": { content: `${BASE}// changed\n` },
        },
      }),
    };
    const withGateway = router({ ...gatewayRoutes(found), ...copy });
    const { logger, lines } = recordingLogger();
    const built = await resolveInputFromBytecode(TARGET, {
      bytecode: found.runtime,
      ipfsGateway: GATEWAY,
      fetch: withGateway.fetch,
      logger,
    });
    assert.equal(built.compiler.input.sources["src/Base.sol"]?.content, BASE);
    assert.ok(lines.some((line) => line.startsWith("warn sourcify: a source does not match")));

    const without = router(copy);
    const error = await rejection(
      resolveInputFromBytecode(TARGET, { bytecode: found.runtime, fetch: without.fetch }),
    );
    expectCode(error, "incomplete-input");
    assert.ok(error.details.code === "incomplete-input");
    assert.deepEqual(error.details.candidates, ["src/Base.sol"]);
  });

  it("reports a copy with the right CID that is not metadata as not-metadata", async () => {
    const found = vector("ipfs");
    const metadata = { note: "not metadata" };
    const cid = ipfsCid(new TextEncoder().encode(JSON.stringify(metadata)));
    const runtime = found.runtime.replace(cidHex(found.runtime), cidHexOf(cid));
    const { fetch } = router({
      [`${SOURCIFY}/all-chains/${ADDRESS}`]: json({
        results: [{ chainId: String(SEPOLIA), match: "exact_match" }],
      }),
      [`${SOURCIFY}/${String(SEPOLIA)}/${ADDRESS}?fields=metadata,sources`]: json({
        metadata,
        sources: {},
      }),
    });
    const error = await rejection(resolveInputFromBytecode(TARGET, { bytecode: runtime, fetch }));
    assert.ok(error.details.code === "metadata-unavailable");
    assert.deepEqual(error.details.attempts, [
      { source: "sourcify", outcome: "not-metadata", status: 200 },
    ]);
  });
});

/** The 34-byte multihash of the CID in `runtime`, as hex. */
function cidHex(runtime: string): string {
  const at = runtime.lastIndexOf("6970667358221220");
  return runtime.slice(at + 12, at + 12 + 68);
}

/** The multihash of a CIDv0, as hex: base58 decoded. */
function cidHexOf(cid: string): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (const char of cid) {
    value = value * 58n + BigInt(alphabet.indexOf(char));
  }
  return value.toString(16).padStart(68, "0");
}

describe("resolveInputFromBytecode: the JSON-RPC endpoint (R-IN-5)", () => {
  it("throws no-metadata-hash with no-code when nothing is deployed", async () => {
    const { fetch } = replay(
      loadFixture("rpc", "2026-11-04-eth-chainid-sepolia"),
      loadFixture("rpc", "2026-11-04-eth-getcode-no-code"),
    );
    const error = await rejection(resolveInputFromBytecode(TARGET, { rpcUrl: RPC_URL, fetch }));
    expectCode(error, "no-metadata-hash");
    assert.equal(error.retryable, false);
    assert.deepEqual(error.details, { code: "no-metadata-hash", found: "no-code" });
    assert.match(error.message, /No bytecode/);
  });

  it("refuses an endpoint of another chain, and redacts its key from the error", async () => {
    const { fetch } = replay(
      fixtureWith("2026-11-04-eth-chainid-sepolia", "rpc", {
        jsonrpc: "2.0",
        id: 1,
        result: "0x1",
      }),
    );
    const error = await rejection(
      resolveInputFromBytecode(TARGET, {
        rpcUrl: `https://rpc.example/v2/${DUMMY_KEY}`,
        fetch,
      }),
    );
    expectCode(error, "invalid-input");
    assert.ok(error.details.code === "invalid-input");
    assert.deepEqual(error.details.issues, [
      { field: "rpcUrl", message: "serves another chain than chainId" },
    ]);
    for (const result of ["0x", 7, "0x1234567890abcdef01"]) {
      const again = replay(
        fixtureWith("2026-11-04-eth-chainid-sepolia", "rpc", { jsonrpc: "2.0", id: 1, result }),
      );
      expectCode(
        await rejection(resolveInputFromBytecode(TARGET, { rpcUrl: RPC_URL, fetch: again.fetch })),
        "invalid-input",
      );
    }
  });

  it("reports an endpoint that gives no result as metadata-unavailable with an empty hash", async () => {
    const answers: [string, Response, { status?: number }][] = [
      [
        "a JSON-RPC error",
        json({ jsonrpc: "2.0", id: 1, error: { code: -32000 } }),
        { status: 200 },
      ],
      ["a 500", json({}, 500), { status: 500 }],
      ["a body that is not JSON", textResponse("<html>"), { status: 200 }],
      ["a redirect", new Response(null, { status: 308 }), { status: 308 }],
    ];
    for (const [what, response, extra] of answers) {
      const { fetch } = replay(response);
      const error = await rejection(resolveInputFromBytecode(TARGET, { rpcUrl: RPC_URL, fetch }));
      expectCode(error, "metadata-unavailable");
      assert.ok(error.details.code === "metadata-unavailable");
      assert.equal(error.details.hash, "");
      assert.deepEqual(
        error.details.attempts,
        [{ source: "rpc", outcome: "unavailable", ...extra }],
        what,
      );
    }
  });

  it("reports eth_getCode without hex bytecode as metadata-unavailable", async () => {
    for (const result of ["0xabc", 42]) {
      const { fetch } = replay(
        loadFixture("rpc", "2026-11-04-eth-chainid-sepolia"),
        json({ jsonrpc: "2.0", id: 1, result }),
      );
      const error = await rejection(resolveInputFromBytecode(TARGET, { rpcUrl: RPC_URL, fetch }));
      expectCode(error, "metadata-unavailable");
      assert.ok(error.details.code === "metadata-unavailable");
      assert.deepEqual(error.details.attempts, [
        { source: "rpc", outcome: "unavailable", status: 200 },
      ]);
    }
  });

  it("reports a network failure, after the budget ends the retries, without a status", async () => {
    const { fetch } = replay(new TypeError("fetch failed"));
    const error = await rejection(
      resolveInputFromBytecode(TARGET, { rpcUrl: RPC_URL, fetch, timeoutMs: 100 }),
    );
    expectCode(error, "metadata-unavailable");
    assert.ok(error.details.code === "metadata-unavailable");
    assert.deepEqual(error.details.attempts, [{ source: "rpc", outcome: "unavailable" }]);
  });

  it("reports a 429 that asks for a long wait with its status", async () => {
    const { fetch } = replay(
      new Response("slow down", { status: 429, headers: { "retry-after": "900" } }),
    );
    const error = await rejection(resolveInputFromBytecode(TARGET, { rpcUrl: RPC_URL, fetch }));
    assert.ok(error.details.code === "metadata-unavailable");
    assert.deepEqual(error.details.attempts, [
      { source: "rpc", outcome: "unavailable", status: 429 },
    ]);
  });
});

describe("resolveInputFromBytecode: bytecode without a hash (R-IN-5)", () => {
  it("throws no-metadata-hash for a version-only block and for no block, and sends nothing", async () => {
    const cases: [string, "version-only" | "no-metadata"][] = [
      ["none", "version-only"],
      ["nocbor", "no-metadata"],
    ];
    for (const [name, found] of cases) {
      const { fetch, calls } = replay();
      const error = await rejection(
        resolveInputFromBytecode(TARGET, { bytecode: vector(name).runtime, fetch }),
      );
      expectCode(error, "no-metadata-hash");
      assert.deepEqual(error.details, { code: "no-metadata-hash", found });
      assert.match(error.message, /no metadata hash/);
      assert.equal(calls.length, 0);
    }
  });
});

/** Calls the resolver with arguments of any type, as a JavaScript caller may. No cast is needed. */
async function issuesOf(target: unknown, options: unknown): Promise<string[]> {
  const pending: unknown = Reflect.apply(resolveInputFromBytecode, undefined, [target, options]);
  const error = await rejection(Promise.resolve(pending));
  expectCode(error, "invalid-input");
  assert.ok(error.details.code === "invalid-input");
  return error.details.issues.map(({ field, message }) => `${field}: ${message}`);
}

/** Options with `name` set to `value` next to a valid bytecode. */
function optionsWith(name: string, value: unknown): ResolveInputOptions {
  const options: ResolveInputOptions = { bytecode: vector("ipfs").runtime };
  Reflect.set(options, name, value);
  return options;
}

describe("resolveInputFromBytecode: input checks (R-IN-6, R-SEC-2)", () => {
  it("names each bad field of the target and the options, before any request", async () => {
    assert.deepEqual(await issuesOf({ chainId: 0, address: "0x12" }, { bytecode: "0x" }), [
      "chainId: must be a positive integer",
      "address: must be 0x followed by 40 hex digits",
    ]);
    assert.deepEqual(await issuesOf(null, "options"), [
      "chainId: must be a positive integer",
      "address: must be 0x followed by 40 hex digits",
      "options: must be a readable object",
    ]);
    assert.deepEqual(await issuesOf(TARGET, undefined), [
      "rpcUrl: must be passed exactly when bytecode is absent",
    ]);
    assert.deepEqual(await issuesOf(TARGET, { bytecode: "0x00", rpcUrl: RPC_URL }), [
      "rpcUrl: must be passed exactly when bytecode is absent",
    ]);
    const bytecodeIssue =
      "bytecode: must be 0x followed by an even number of hex digits, at most 65536 bytes";
    assert.deepEqual(await issuesOf(TARGET, { bytecode: "60806040" }), [bytecodeIssue]);
    assert.deepEqual(await issuesOf(TARGET, { bytecode: `0x${"00".repeat(65_537)}` }), [
      bytecodeIssue,
    ]);
    assert.deepEqual(await issuesOf(TARGET, { bytecode: "0x00", sourcify: false }), [
      "ipfsGateway: is required when sourcify is false",
    ]);
    assert.deepEqual(
      await issuesOf(TARGET, {
        rpcUrl: "http://rpc.example",
        ipfsGateway: "https://user:pass@gw.example",
      }),
      [
        "rpcUrl: must use https, or http on localhost, 127.0.0.1 or [::1]",
        "ipfsGateway: must not contain a user name or password",
      ],
    );
  });

  const kinds: [string, unknown, string][] = [
    ["sourcify", "yes", "must be a boolean"],
    ["sources", { "src/A.sol": 1 }, "must be an object of source contents by path"],
    ["sources", "src/A.sol", "must be an object of source contents by path"],
    ["fetch", "https://example.org", "must be a function"],
    ["signal", { aborted: false }, "must be an AbortSignal"],
    ["timeoutMs", 0, "must be a positive finite number of milliseconds"],
    ["timeoutMs", "100", "must be a positive finite number of milliseconds"],
    ["logger", null, "must be an object"],
    ["logger", "console", "must be an object"],
  ];
  for (const [name, value, message] of kinds) {
    it(`throws invalid-input for ${name} set to ${JSON.stringify(value)}`, async () => {
      assert.deepEqual(await issuesOf(TARGET, optionsWith(name, value)), [`${name}: ${message}`]);
    });
  }

  it("throws invalid-input for options whose getter throws, without its message", async () => {
    const options = {};
    Object.defineProperty(options, "bytecode", {
      enumerable: true,
      get(): never {
        throw new Error(`boom ${DUMMY_KEY}`);
      },
    });
    assert.deepEqual(await issuesOf(TARGET, options), ["options: must be a readable object"]);
  });

  it("ignores inherited options and keeps a source path named __proto__ as a path", async () => {
    const found = vector("ipfs");
    const inherited: ResolveInputOptions = { bytecode: "0x" };
    Object.setPrototypeOf(inherited, { rpcUrl: RPC_URL });
    const error = await rejection(resolveInputFromBytecode(TARGET, inherited));
    expectCode(error, "no-metadata-hash");
    const sources: Record<string, string> = { ...VECTORS.sources };
    Object.defineProperty(sources, "__proto__", { value: "x", enumerable: true });
    const { fetch, urls } = router({ [ipfs(cidIn(found.runtime))]: textResponse(found.metadata) });
    const built = await resolveInputFromBytecode(TARGET, {
      bytecode: found.runtime,
      sourcify: false,
      ipfsGateway: GATEWAY,
      sources,
      fetch,
    });
    // The extra path is not in the metadata, so the build leaves it out.
    assert.deepEqual(Object.keys(built.compiler.input.sources).toSorted(), [
      "src/Base.sol",
      "src/Greeter.sol",
    ]);
    assert.equal(urls.length, 1);
  });

  it("clamps a huge timeoutMs and keeps the default fetch as a plain function call", async () => {
    const found = vector("ipfs");
    const original = globalThis.fetch;
    const { fetch, urls } = router(gatewayRoutes(found));
    globalThis.fetch = fetch;
    try {
      const built = await resolveInputFromBytecode(TARGET, {
        bytecode: found.runtime,
        sourcify: false,
        ipfsGateway: GATEWAY,
        timeoutMs: Number.MAX_SAFE_INTEGER,
      });
      assert.equal(built.contractName, "src/Greeter.sol:Greeter");
      assert.equal(urls.length, 3);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("the details of no-metadata-hash and metadata-unavailable (R-SEC-1)", () => {
  it("keeps only the declared fields and values, whatever code that bypasses the types passes", () => {
    const missing: ErrorDetails = { code: "no-metadata-hash", found: "no-code" };
    Reflect.set(missing, "found", `other ${DUMMY_KEY}`);
    Reflect.set(missing, "extra", DUMMY_KEY);
    assert.deepEqual(new ExplorerVerifyError(missing, "m", { secrets: [] }).details, {
      code: "no-metadata-hash",
      found: "no-metadata",
    });

    const attempt: MetadataAttempt = { source: "ipfs", outcome: "not-found" };
    Reflect.set(attempt, "source", "ftp");
    Reflect.set(attempt, "outcome", DUMMY_KEY);
    Reflect.set(attempt, "status", "404");
    Reflect.set(attempt, "url", `https://gw.example/?key=${DUMMY_KEY}`);
    const unavailable: ErrorDetails = {
      code: "metadata-unavailable",
      hash: `ipfs:${DUMMY_KEY}`,
      attempts: [attempt, { source: "rpc", outcome: "hash-mismatch" }],
    };
    Reflect.set(unavailable.attempts, 2, "not an object");
    const copy = new ExplorerVerifyError(unavailable, "m", { secrets: [DUMMY_KEY] }).details;
    assert.deepEqual(copy, {
      code: "metadata-unavailable",
      hash: "ipfs:[redacted]",
      attempts: [
        { source: "rpc", outcome: "unavailable", status: Number.NaN },
        { source: "rpc", outcome: "hash-mismatch" },
        { source: "rpc", outcome: "unavailable" },
      ],
    });

    const notArray: ErrorDetails = { code: "metadata-unavailable", hash: "", attempts: [] };
    Reflect.set(notArray, "attempts", "sourcify");
    const empty = new ExplorerVerifyError(notArray, "m", { secrets: [] }).details;
    assert.ok(empty.code === "metadata-unavailable");
    assert.deepEqual(empty.attempts, []);
  });
});

describe("resolveInputFromBytecode: abort and secrets (R-FLOW-6, R-SEC-1)", () => {
  it("rejects with the signal's reason, unchanged, before and during a request", async () => {
    const before = new AbortController();
    const reason = new Error("stop");
    before.abort(reason);
    const { fetch, calls } = replay();
    await assert.rejects(
      resolveInputFromBytecode(TARGET, { rpcUrl: RPC_URL, fetch, signal: before.signal }),
      (error: unknown) => error === reason,
    );
    assert.equal(calls.length, 0);

    const during = new AbortController();
    const hanging = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      during.abort(reason);
      return await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason);
        });
      });
    };
    await assert.rejects(
      resolveInputFromBytecode(TARGET, { rpcUrl: RPC_URL, fetch: hanging, signal: during.signal }),
      (error: unknown) => error === reason,
    );
  });

  it("rethrows an error that is not a library error, such as an abort reason set later", async () => {
    const controller = new AbortController();
    const reason = new Error("late");
    const fetch = async (): Promise<Response> => {
      controller.abort(reason);
      return await Promise.resolve(json({}, 500));
    };
    await assert.rejects(
      resolveInputFromBytecode(TARGET, { rpcUrl: RPC_URL, fetch, signal: controller.signal }),
      (error: unknown) => error === reason,
    );
  });

  it("logs no path segment or query value of the configured URLs", async () => {
    const found = vector("ipfs");
    const { logger, lines } = recordingLogger();
    const encoded = encodeURIComponent(`${DUMMY_KEY}/x`);
    // A segment that does not decode is redacted as written.
    const gateway = `https://gw.example/${encoded}/%zz${DUMMY_KEY}?token=${DUMMY_KEY}`;
    const routes: Record<string, Response> = {
      [`${SOURCIFY}/all-chains/${ADDRESS}`]: textResponse("busy", 503),
    };
    const { fetch } = router(routes);
    const error = await rejection(
      resolveInputFromBytecode(TARGET, {
        bytecode: found.runtime,
        ipfsGateway: gateway,
        fetch,
        logger,
        timeoutMs: 100,
      }),
    );
    expectCode(error, "metadata-unavailable");
    assert.ok(lines.length > 0);
    assert.doesNotMatch(lines.join("\n"), /DUMMYKEY/);
    assert.doesNotMatch(JSON.stringify(error.details), /DUMMYKEY/);
  });
});
