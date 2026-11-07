// Black-box tests for issue #34: buildVerifyInputFromBytecode from the `explorer-verify/resolve`
// subpath. Written from the issue, the how-to "Verify from deployed bytecode", the error pages
// no-metadata-hash and metadata-unavailable, json-output.md, R-IN-5 and the TSDoc of the exported
// function and options. The implementation was not read.
//
// The package imports itself by name, so `explorer-verify/resolve` and `explorer-verify` load the
// built dist/ (run `pnpm run build` first). Every request goes through a fake `fetch`; nothing
// touches the network. URLs and keys below are dummies.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { ERROR_HINTS, ExplorerVerifyError, validateInput, verify } from "explorer-verify";
import type { LogFields, Logger } from "explorer-verify";
import { ERROR_EXIT_CODES, exitCodeOf, toEnvelope } from "explorer-verify/envelope";
import { buildVerifyInputFromBytecode } from "explorer-verify/resolve";

// --- fixtures ---------------------------------------------------------------------------------

const FIXTURES = new URL("../fixtures/", import.meta.url);

function readJson(path: string): unknown {
  const parsed: unknown = JSON.parse(readFileSync(new URL(path, FIXTURES), "utf8"));
  return parsed;
}

function rec(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), "object");
  return Object.fromEntries(Object.entries(value));
}

function str(value: unknown): string {
  assert.equal(typeof value, "string");
  return String(value);
}

const SOLC = rec(readJson("ipfs/solc-0.8.26-greeter.json"));
const SOLC_SOURCES = Object.fromEntries(
  Object.entries(rec(SOLC.sources)).map(([k, v]) => [k, str(v)]),
);
const GREETER_SRC = str(SOLC_SOURCES["src/Greeter.sol"]);
const BASE_SRC = str(SOLC_SOURCES["src/Base.sol"]);
const LARGE_CONTENT = `${GREETER_SRC}// ${"x".repeat(Number(SOLC.largeFill))}\n`;

interface Build {
  metadata: string;
  runtime: string;
}

function build(name: string): Build {
  assert.ok(Array.isArray(SOLC.results));
  const found = SOLC.results.map(rec).find((r) => r.name === name);
  assert.ok(found);
  const metadata = str(found.metadata);
  return {
    runtime: str(found.runtime),
    metadata:
      name === "large" ? metadata.replace('"<LARGE>"', JSON.stringify(LARGE_CONTENT)) : metadata,
  };
}

const IPFS = build("ipfs");
const NONE = build("none");
const BZZR1 = build("bzzr1");
const NOCBOR = build("nocbor");
const LARGE = build("large");

const LIVE_GETCODE = str(
  rec(rec(rec(readJson("rpc/2026-11-04-eth-getcode-greeter.json")).response).body).result,
);
const LIVE_SOURCIFY = rec(
  rec(rec(readJson("sourcify/2026-11-04-contract-metadata-sources.json")).response).body,
);

const ADDR = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const SEPOLIA = 11155111;
const TARGET = { chainId: SEPOLIA, address: ADDR } as const;

const RPC_SECRET = "dummysecret0123456789";
const RPC_QSECRET = "querysecret987654321";
const RPC_URL = `https://rpc.example/v2/${RPC_SECRET}?key=${RPC_QSECRET}`;
const GW_SECRET = "gwpathsecret0123456";
const GW_QSECRET = "gwtokensecret987654";
const GW = `https://gw.example/${GW_SECRET}?token=${GW_QSECRET}`;
const SECRETS = [RPC_SECRET, RPC_QSECRET, GW_SECRET, GW_QSECRET];
const SOURCIFY = "https://sourcify.dev/server";

// --- IPFS and CBOR helpers --------------------------------------------------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = `${B58[Number(n % 58n)] ?? ""}${out}`;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

function b58decode(encoded: string): Uint8Array {
  let n = 0n;
  for (const c of encoded) n = n * 58n + BigInt(B58.indexOf(c));
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of encoded) {
    if (c !== "1") break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}

function varint(value: number): number[] {
  const out: number[] = [];
  let n = value;
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}

/** CIDv0 of a file of at most 256 KiB, as `ipfs add` (and solc) computes it. */
function cidv0(content: string): string {
  const data = [...Buffer.from(content, "utf8")];
  assert.ok(data.length <= 262144);
  const unixfs = [
    0x08,
    0x02,
    ...(data.length > 0 ? [0x12, ...varint(data.length), ...data] : []),
    0x18,
    ...varint(data.length),
  ];
  const node = Uint8Array.from([0x0a, ...varint(unixfs.length), ...unixfs]);
  const digest = createHash("sha256").update(node).digest();
  return b58encode(Uint8Array.from([0x12, 0x20, ...digest]));
}

function hex(bytes: Iterable<number>): string {
  return Buffer.from([...bytes]).toString("hex");
}

type CborValue = Uint8Array | boolean | string;

function cborItem(value: CborValue): number[] {
  if (typeof value === "boolean") return [value ? 0xf5 : 0xf4];
  const bytes = typeof value === "string" ? [...Buffer.from(value)] : [...value];
  const major = typeof value === "string" ? 0x60 : 0x40;
  if (bytes.length < 24) return [major + bytes.length, ...bytes];
  assert.ok(bytes.length < 256);
  return [major + 24, bytes.length, ...bytes];
}

/** solc's tail: a CBOR map, then its length as two big-endian bytes. */
function cborTail(entries: [string, CborValue][]): string {
  const body = [0xa0 + entries.length];
  for (const [k, v] of entries) body.push(...cborItem(k), ...cborItem(v));
  return hex(body) + body.length.toString(16).padStart(4, "0");
}

const CODE = "0x6080604052348015600f57600080fd5b50fe";
const SOLC_VERSION = Uint8Array.from([0, 8, 26]);

function bytecodeWithCid(cid: string): string {
  return (
    CODE +
    cborTail([
      ["ipfs", b58decode(cid)],
      ["solc", SOLC_VERSION],
    ])
  );
}

function ipfsCidOf(runtime: string): string {
  const marker = "64697066735822";
  const at = runtime.lastIndexOf(marker);
  assert.ok(at > 0);
  return b58encode(Buffer.from(runtime.slice(at + marker.length, at + marker.length + 68), "hex"));
}

// --- the fake network -------------------------------------------------------------------------

interface Seen {
  method: string;
  url: string;
  body: string;
}

type Handler = (req: Seen, signal: AbortSignal | undefined) => Response | Promise<Response>;

interface Net {
  fetch: typeof fetch;
  seen: Seen[];
}

function net(handler: Handler): Net {
  const seen: Seen[] = [];
  const fake: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = typeof init?.body === "string" ? init.body : "";
    const req = { method, url, body };
    seen.push(req);
    const signal = init?.signal ?? undefined;
    if (signal?.aborted === true) throw signal.reason;
    return await handler(req, signal);
  };
  return { fetch: fake, seen };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function text(value: string, status = 200): Response {
  return new Response(value, { status, headers: { "content-type": "text/plain" } });
}

interface Scenario {
  chainIdHex?: string;
  code?: string;
  rpc?: (method: string, id: unknown) => Response;
  allChains?: () => Response;
  contract?: (chainId: string) => Response;
  gateway?: (cid: string) => Response;
  other?: (req: Seen) => Response;
}

function rpcResult(id: unknown, result: unknown): Response {
  return json({ jsonrpc: "2.0", id, result });
}

/** Routes requests to the RPC, Sourcify and the gateway; anything else throws. */
function scenario(s: Scenario): Net {
  return net((req) => {
    const u = new URL(req.url);
    if (u.host === "rpc.example") {
      const parsed = rec(JSON.parse(req.body));
      const method = str(parsed.method);
      if (s.rpc) return s.rpc(method, parsed.id);
      if (method === "eth_chainId") return rpcResult(parsed.id, s.chainIdHex ?? "0xaa36a7");
      if (method === "eth_getCode") return rpcResult(parsed.id, s.code ?? IPFS.runtime);
      return json({ jsonrpc: "2.0", id: parsed.id, error: { code: -32601, message: "no" } });
    }
    if (req.url.startsWith(`${SOURCIFY}/v2/contract/all-chains/`)) {
      return s.allChains ? s.allChains() : json({ results: [] }, 404);
    }
    const m = /^https:\/\/sourcify\.dev\/server\/v2\/contract\/(\d+)\/0x[0-9a-fA-F]{40}/.exec(
      req.url,
    );
    if (m) {
      return s.contract ? s.contract(m[1] ?? "") : json({ match: null }, 404);
    }
    if (u.host === "gw.example") {
      const g = /\/ipfs\/([^/?]+)/.exec(u.pathname);
      if (g && s.gateway) return s.gateway(g[1] ?? "");
      return text("not found", 404);
    }
    if (s.other) return s.other(req);
    throw new TypeError(`unexpected request to ${req.url}`);
  });
}

function sourcifyBody(b: Build, chainId: string, match = "exact_match"): Record<string, unknown> {
  const meta = rec(JSON.parse(b.metadata));
  const sources: Record<string, { content: string }> = {};
  for (const path of Object.keys(rec(meta.sources))) {
    const embedded = rec(rec(meta.sources)[path]).content;
    sources[path] = {
      content: typeof embedded === "string" ? embedded : str(SOLC_SOURCES[path] ?? GREETER_SRC),
    };
  }
  return {
    match,
    creationMatch: match,
    runtimeMatch: match,
    chainId,
    address: ADDR,
    metadata: meta,
    sources,
  };
}

function allChains(...entries: [string, string][]): () => Response {
  return () =>
    json({
      results: entries.map(([chainId, match]) => ({
        match,
        creationMatch: match,
        runtimeMatch: match,
        chainId,
        address: ADDR,
      })),
    });
}

/** Serves the IPFS build's metadata and sources by CID. */
function gatewayFor(
  b: Build,
  overrides: Record<string, () => Response> = {},
): (cid: string) => Response {
  const byCid = new Map<string, string>();
  byCid.set(ipfsCidOf(b.runtime), b.metadata);
  byCid.set(cidv0(GREETER_SRC), GREETER_SRC);
  byCid.set(cidv0(BASE_SRC), BASE_SRC);
  return (cid) => {
    const o = overrides[cid];
    if (o) return o();
    const body = byCid.get(cid);
    return body === undefined ? text("not found", 404) : text(body);
  };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  let rejected = false;
  let reason: unknown;
  try {
    await promise;
  } catch (error) {
    rejected = true;
    reason = error;
  }
  assert.ok(rejected, "expected a rejection");
  return reason;
}

function callUntyped(target: unknown, options: unknown): Promise<unknown> {
  const result: unknown = Reflect.apply(buildVerifyInputFromBytecode, undefined, [target, options]);
  return Promise.resolve(result);
}

async function evError(promise: Promise<unknown>): Promise<ExplorerVerifyError> {
  const error = await caught(promise);
  assert.ok(
    error instanceof ExplorerVerifyError,
    `expected ExplorerVerifyError, got ${String(error)}`,
  );
  return error;
}

function assertNoSecret(error: unknown, extra: string[] = []): void {
  const parts: string[] = [];
  let cur: unknown = error;
  for (let depth = 0; depth < 5 && cur !== undefined && cur !== null; depth += 1) {
    if (cur instanceof Error) {
      parts.push(cur.message, String(cur.stack));
      cur = cur.cause;
    } else {
      parts.push(JSON.stringify(cur));
      cur = undefined;
    }
  }
  if (error instanceof ExplorerVerifyError) {
    parts.push(JSON.stringify(error.details), JSON.stringify(error.toJSON()));
    parts.push(JSON.stringify(toEnvelope(error)), error.hint);
  }
  parts.push(...extra);
  const all = parts.join("\n");
  for (const secret of SECRETS) {
    assert.ok(!all.includes(secret), `secret ${secret.slice(0, 6)}… leaked: ${all.slice(0, 400)}`);
  }
}

function hosts(seen: Seen[]): Set<string> {
  return new Set(seen.map((r) => new URL(r.url).host));
}

function assertHosts(seen: Seen[], allowed: string[]): void {
  for (const h of hosts(seen)) assert.ok(allowed.includes(h), `request to ${h}`);
}

function capture(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const record = (level: string) => (message: string, fields?: LogFields) => {
    lines.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`);
  };
  return {
    lines,
    logger: {
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    },
  };
}

function metadataUnavailable(error: ExplorerVerifyError) {
  assert.equal(error.code, "metadata-unavailable");
  assert.equal(error.details.code, "metadata-unavailable");
  if (error.details.code !== "metadata-unavailable") assert.fail();
  for (const a of error.details.attempts) {
    assert.ok(["rpc", "ipfs", "sourcify"].includes(a.source));
    assert.ok(["not-found", "hash-mismatch", "unavailable"].includes(a.outcome));
    if (a.status !== undefined) assert.ok(Number.isInteger(a.status));
  }
  assert.ok(
    error.details.hash === "" ||
      /^ipfs:Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(error.details.hash) ||
      /^bzzr[01]:[0-9a-f]{64}$/.test(error.details.hash),
    `hash ${error.details.hash}`,
  );
  assert.equal(error.retryable, true);
  assert.equal(ERROR_EXIT_CODES["metadata-unavailable"], 5);
  assert.equal(exitCodeOf(error), 5);
  return error.details;
}

function noMetadataHash(error: ExplorerVerifyError): string {
  assert.equal(error.code, "no-metadata-hash");
  if (error.details.code !== "no-metadata-hash") assert.fail();
  assert.equal(error.retryable, false);
  assert.equal(exitCodeOf(error), 2);
  return error.details.found;
}

// --- bytecode input ---------------------------------------------------------------------------

describe("#34 bytecode given directly", () => {
  it("resolves the IPFS build through the gateway and makes no RPC request", async () => {
    const n = scenario({ gateway: gatewayFor(IPFS) });
    const built = await buildVerifyInputFromBytecode(TARGET, {
      bytecode: IPFS.runtime,
      ipfsGateway: GW,
      allowSourcifyLookup: false,
      fetch: n.fetch,
    });
    assert.equal(built.contractName, "src/Greeter.sol:Greeter");
    assert.equal(built.compiler.kind, "solc");
    assert.equal(built.compiler.version, "0.8.26+commit.8a97fa7a");
    assert.equal(built.compiler.input.sources["src/Greeter.sol"]?.content, GREETER_SRC);
    assert.equal(built.compiler.input.sources["src/Base.sol"]?.content, BASE_SRC);
    assert.deepEqual([...hosts(n.seen)], ["gw.example"]);
    // Guide: "<gateway>/ipfs/<CID>"; "Its query string is kept on every request".
    for (const r of n.seen) {
      assert.equal(r.method, "GET");
      const u = new URL(r.url);
      assert.match(u.pathname, new RegExp(`^/${GW_SECRET}/ipfs/Qm`));
      assert.equal(u.searchParams.get("token"), GW_QSECRET);
    }
    assert.equal(n.seen[0]?.url.includes(ipfsCidOf(IPFS.runtime)), true);
    assert.equal(n.seen.length, 3);
  });

  it("accepts upper-case hex digits in bytecode", async () => {
    const n = scenario({ gateway: gatewayFor(IPFS) });
    const built = await buildVerifyInputFromBytecode(TARGET, {
      bytecode: `0x${IPFS.runtime.slice(2).toUpperCase()}`,
      ipfsGateway: GW,
      allowSourcifyLookup: false,
      fetch: n.fetch,
    });
    assert.equal(built.contractName, "src/Greeter.sol:Greeter");
  });

  it("no-metadata for appendCBOR: false", async () => {
    const n = scenario({});
    const e = await evError(
      buildVerifyInputFromBytecode(TARGET, {
        bytecode: NOCBOR.runtime,
        fetch: n.fetch,
        ipfsGateway: GW,
      }),
    );
    assert.equal(noMetadataHash(e), "no-metadata");
    assert.equal(n.seen.length, 0);
  });

  it("version-only for bytecodeHash: none", async () => {
    const n = scenario({});
    const e = await evError(
      buildVerifyInputFromBytecode(TARGET, {
        bytecode: NONE.runtime,
        fetch: n.fetch,
        ipfsGateway: GW,
      }),
    );
    assert.equal(noMetadataHash(e), "version-only");
    assert.equal(n.seen.length, 0);
  });

  it("no-code for bytecode 0x", async () => {
    const n = scenario({});
    const e = await evError(
      buildVerifyInputFromBytecode(TARGET, { bytecode: "0x", fetch: n.fetch }),
    );
    assert.equal(noMetadataHash(e), "no-code");
  });

  const malformed: [string, string][] = [
    ["CBOR length larger than the bytecode", `${CODE}fffe`],
    ["truncated CBOR (tail cut, length kept)", IPFS.runtime.slice(0, -40) + IPFS.runtime.slice(-4)],
    ["garbage bytes with a valid length", `${CODE}${"ff".repeat(10)}000a`],
    ["CBOR that is not a map", `${CODE}${hex(cborItem("ipfs"))}0005`],
    ["ipfs value too short", CODE + cborTail([["ipfs", Uint8Array.from([0x12, 0x20, 1, 2])]])],
    ["ipfs value is a string", CODE + cborTail([["ipfs", "QmNotBytes"]])],
    ["one byte of code", "0x00"],
    ["length zero", `${CODE}0000`],
  ];
  for (const [name, bytecode] of malformed) {
    it(`malformed metadata, ${name}: a typed error, no request`, async (t) => {
      const n = scenario({ gateway: gatewayFor(IPFS) });
      const e = await evError(
        buildVerifyInputFromBytecode(TARGET, { bytecode, fetch: n.fetch, ipfsGateway: GW }),
      );
      t.diagnostic(`actual: ${e.code} ${JSON.stringify(e.details)} | ${e.message}`);
      // Not specified in detail: the docs list no-metadata for "no CBOR block". We require a typed
      // input-side error and no request.
      assert.ok(
        e.code === "no-metadata-hash" || e.code === "invalid-input",
        `${name}: ${e.code} ${e.message}`,
      );
      if (e.code === "no-metadata-hash") assert.equal(noMetadataHash(e), "no-metadata");
      assert.equal(n.seen.length, 0, `${name}: ${n.seen.map((r) => r.url).join(",")}`);
    });
  }

  it("experimental key and extra keys in the CBOR map still give the IPFS hash", async () => {
    const cid = ipfsCidOf(IPFS.runtime);
    const bytecode =
      CODE +
      cborTail([
        ["ipfs", b58decode(cid)],
        ["experimental", true],
        ["solc", SOLC_VERSION],
      ]);
    const n = scenario({ gateway: gatewayFor(IPFS) });
    const built = await buildVerifyInputFromBytecode(TARGET, {
      bytecode,
      fetch: n.fetch,
      ipfsGateway: GW,
      allowSourcifyLookup: false,
    });
    assert.equal(built.contractName, "src/Greeter.sol:Greeter");
  });

  const badBytecode: [string, string][] = [
    ["no 0x", IPFS.runtime.slice(2)],
    ["odd length", `${IPFS.runtime}0`],
    ["non-hex", `${IPFS.runtime.slice(0, -2)}zz`],
    ["empty string", ""],
  ];
  for (const [name, bytecode] of badBytecode) {
    it(`invalid-input for bytecode ${name}`, async () => {
      const n = scenario({});
      const e = await evError(buildVerifyInputFromBytecode(TARGET, { bytecode, fetch: n.fetch }));
      assert.equal(e.code, "invalid-input", `${name}: ${e.code}`);
      assert.equal(n.seen.length, 0);
    });
  }
});

// --- options and target validation ------------------------------------------------------------

describe("#34 invalid-input", () => {
  const cases: [string, unknown, unknown][] = [
    ["both bytecode and rpcUrl", TARGET, { bytecode: IPFS.runtime, rpcUrl: RPC_URL }],
    ["neither bytecode nor rpcUrl", TARGET, {}],
    ["no options at all", TARGET, undefined],
    ["bad address", { chainId: SEPOLIA, address: "0x1234" }, { bytecode: IPFS.runtime }],
    ["chainId 0", { chainId: 0, address: ADDR }, { bytecode: IPFS.runtime }],
    ["chainId non-integer", { chainId: 1.5, address: ADDR }, { bytecode: IPFS.runtime }],
    ["rpcUrl http on a public host", TARGET, { rpcUrl: "http://rpc.example/v2/x" }],
    ["rpcUrl with user and password", TARGET, { rpcUrl: `https://u:${RPC_SECRET}@rpc.example/` }],
    ["rpcUrl with a fragment", TARGET, { rpcUrl: `https://rpc.example/#${RPC_SECRET}` }],
    ["rpcUrl not a URL", TARGET, { rpcUrl: `not a url ${RPC_SECRET}` }],
    ["rpcUrl ftp", TARGET, { rpcUrl: "ftp://rpc.example/" }],
    [
      "ipfsGateway http public",
      TARGET,
      { bytecode: IPFS.runtime, ipfsGateway: "http://gw.example" },
    ],
    [
      "ipfsGateway with credentials",
      TARGET,
      { bytecode: IPFS.runtime, ipfsGateway: `https://u:${GW_SECRET}@gw.example` },
    ],
    [
      "ipfsGateway with fragment",
      TARGET,
      { bytecode: IPFS.runtime, ipfsGateway: "https://gw.example/#x" },
    ],
    ["timeoutMs negative", TARGET, { bytecode: IPFS.runtime, timeoutMs: -1 }],
    ["timeoutMs NaN", TARGET, { bytecode: IPFS.runtime, timeoutMs: Number.NaN }],
    [
      "allowSourcifyLookup not boolean",
      TARGET,
      { bytecode: IPFS.runtime, allowSourcifyLookup: "no" },
    ],
    ["sources not strings", TARGET, { bytecode: IPFS.runtime, sources: { a: 1 } }],
    ["fetch not a function", TARGET, { bytecode: IPFS.runtime, fetch: "x" }],
  ];
  for (const [name, target, options] of cases) {
    it(name, async () => {
      const seen: string[] = [];
      const guard: typeof fetch = (input) => {
        seen.push(input instanceof Request ? input.url : input.toString());
        return Promise.reject(new TypeError("no network"));
      };
      const opts = options === undefined ? undefined : { fetch: guard, ...rec(options) };
      const e = await evError(
        // Bypasses the types on purpose, as a JavaScript caller can.
        callUntyped(target, opts),
      );
      assert.equal(e.code, "invalid-input", `${name}: ${e.code} ${e.message}`);
      if (e.details.code !== "invalid-input") assert.fail();
      assert.ok(e.details.issues.length > 0);
      for (const issue of e.details.issues) {
        assert.equal(typeof issue.field, "string");
        assert.equal(typeof issue.message, "string");
      }
      assert.equal(e.retryable, false);
      assert.equal(exitCodeOf(e), 2);
      assert.equal(seen.length, 0, `${name}: made a request`);
      assertNoSecret(e);
    });
  }

  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    it(`accepts http on ${host} for rpcUrl and ipfsGateway`, async () => {
      const n = net((req) => {
        if (req.method === "POST") {
          const p = rec(JSON.parse(req.body));
          return rpcResult(p.id, p.method === "eth_chainId" ? "0xaa36a7" : IPFS.runtime);
        }
        const g = /\/ipfs\/([^/?]+)/.exec(new URL(req.url).pathname);
        return gatewayFor(IPFS)(g?.[1] ?? "");
      });
      const built = await buildVerifyInputFromBytecode(TARGET, {
        rpcUrl: `http://${host}:8545`,
        ipfsGateway: `http://${host}:8080`,
        allowSourcifyLookup: false,
        fetch: n.fetch,
      });
      assert.equal(built.contractName, "src/Greeter.sol:Greeter");
    });
  }
});

// --- RPC --------------------------------------------------------------------------------------

describe("#34 bytecode fetched by RPC", () => {
  it("checks eth_chainId, then eth_getCode at latest; secrets stay out of the logs", async () => {
    const n = scenario({ gateway: gatewayFor(IPFS) });
    const { logger, lines } = capture();
    const built = await buildVerifyInputFromBytecode(TARGET, {
      rpcUrl: RPC_URL,
      ipfsGateway: GW,
      allowSourcifyLookup: false,
      fetch: n.fetch,
      logger,
    });
    assert.equal(built.contractName, "src/Greeter.sol:Greeter");
    const rpc = n.seen.filter((r) => r.url === RPC_URL).map((r) => rec(JSON.parse(r.body)));
    assert.deepEqual(
      rpc.map((r) => r.method),
      ["eth_chainId", "eth_getCode"],
    );
    assert.deepEqual(rpc[1]?.params, [ADDR, "latest"]);
    for (const r of n.seen.filter((x) => x.url === RPC_URL)) assert.equal(r.method, "POST");
    assertNoSecret(undefined, lines);
  });

  it("invalid-input when the endpoint serves another chain; no eth_getCode", async () => {
    const n = scenario({ chainIdHex: "0x1" });
    const e = await evError(
      buildVerifyInputFromBytecode(TARGET, { rpcUrl: RPC_URL, fetch: n.fetch }),
    );
    assert.equal(e.code, "invalid-input");
    if (e.details.code !== "invalid-input") assert.fail();
    assert.ok(
      e.details.issues.some((i) => i.field.includes("rpcUrl")),
      JSON.stringify(e.details),
    );
    assert.equal(
      n.seen.some((r) => r.body.includes("eth_getCode")),
      false,
    );
    assertNoSecret(e);
  });

  it("no-metadata-hash no-code when eth_getCode returns 0x", async () => {
    const n = scenario({ code: "0x" });
    const e = await evError(
      buildVerifyInputFromBytecode(TARGET, { rpcUrl: RPC_URL, fetch: n.fetch, ipfsGateway: GW }),
    );
    assert.equal(noMetadataHash(e), "no-code");
    assertHosts(n.seen, ["rpc.example"]);
    assertNoSecret(e);
  });

  const rpcFailures: [string, (method: string, id: unknown) => Response, number | undefined][] = [
    [
      "a JSON-RPC error on eth_getCode",
      (m, id) =>
        m === "eth_chainId"
          ? rpcResult(id, "0xaa36a7")
          : json({ jsonrpc: "2.0", id, error: { code: -32000, message: `bad ${RPC_SECRET}` } }),
      200,
    ],
    [
      "a JSON-RPC error on eth_chainId",
      (_m, id) => json({ jsonrpc: "2.0", id, error: { code: -32000, message: "x" } }),
      200,
    ],
    ["a non-JSON body", () => text("<html>gateway error</html>"), 200],
    ["HTTP 401", () => text("unauthorized", 401), 401],
    ["HTTP 500", () => text("oops", 500), 500],
    [
      "a result that is not a string",
      (m, id) => (m === "eth_chainId" ? rpcResult(id, "0xaa36a7") : rpcResult(id, 42)),
      200,
    ],
    [
      "a result that is not hex",
      (m, id) => (m === "eth_chainId" ? rpcResult(id, "0xaa36a7") : rpcResult(id, "0xzz")),
      200,
    ],
  ];
  for (const [name, rpc, status] of rpcFailures) {
    it(`metadata-unavailable, rpc attempt, for ${name}`, async () => {
      const n = scenario({ rpc });
      const e = await evError(
        buildVerifyInputFromBytecode(TARGET, {
          rpcUrl: RPC_URL,
          fetch: n.fetch,
          ipfsGateway: GW,
          timeoutMs: 20_000,
        }),
      );
      const d = metadataUnavailable(e);
      assert.equal(d.hash, "");
      assert.equal(d.attempts.length, 1, JSON.stringify(d));
      assert.equal(d.attempts[0]?.source, "rpc");
      assert.equal(d.attempts[0]?.outcome, "unavailable");
      if (status !== undefined) assert.equal(d.attempts[0]?.status, status, JSON.stringify(d));
      assertHosts(n.seen, ["rpc.example"]);
      assertNoSecret(e);
    });
  }

  it("metadata-unavailable when fetch rejects with the URL in its message; no secret", async () => {
    const n = net((req) => {
      throw new TypeError(`fetch failed for ${req.url}`);
    });
    const e = await evError(
      // A short budget ends the retries after the first failure, so the test takes no real wait.
      buildVerifyInputFromBytecode(TARGET, { rpcUrl: RPC_URL, fetch: n.fetch, timeoutMs: 100 }),
    );
    const d = metadataUnavailable(e);
    assert.equal(d.attempts[0]?.source, "rpc");
    assert.equal(d.attempts[0]?.status, undefined);
    assertNoSecret(e);
  });

  it("does not follow an RPC redirect", async () => {
    const n = net(
      () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
    );
    const e = await evError(
      buildVerifyInputFromBytecode(TARGET, { rpcUrl: RPC_URL, fetch: n.fetch }),
    );
    metadataUnavailable(e);
    assertHosts(n.seen, ["rpc.example"]);
  });
});

// --- Sourcify ---------------------------------------------------------------------------------

describe("#34 Sourcify", () => {
  it("uses a copy on the call's chain (live recorded getCode and Sourcify body)", async () => {
    const n = scenario({
      code: LIVE_GETCODE,
      allChains: allChains([String(SEPOLIA), "exact_match"]),
      contract: () => json(LIVE_SOURCIFY),
    });
    const built = await buildVerifyInputFromBytecode(TARGET, { rpcUrl: RPC_URL, fetch: n.fetch });
    assert.equal(built.contractName, "contracts/Greeter.sol:Greeter");
    assert.equal(built.compiler.version, "0.8.24+commit.e11b9ed9");
    assertHosts(n.seen, ["rpc.example", "sourcify.dev"]);
    for (const r of n.seen.filter((x) => x.url.startsWith(SOURCIFY))) assert.equal(r.method, "GET");
  });

  it("uses a copy on another chain (CREATE2-style) when its metadata hashes to the bytecode's", async () => {
    const n = scenario({
      allChains: allChains(["84532", "exact_match"]),
      contract: (c) =>
        c === "84532" ? json(sourcifyBody(IPFS, "84532")) : json({ match: null }, 404),
    });
    const built = await buildVerifyInputFromBytecode(TARGET, {
      bytecode: IPFS.runtime,
      fetch: n.fetch,
    });
    assert.equal(built.contractName, "src/Greeter.sol:Greeter");
    assert.ok(n.seen.some((r) => r.url.includes("/v2/contract/84532/")));
  });

  it("uses a partial match whose metadata hashes to the bytecode's", async () => {
    const n = scenario({
      allChains: allChains([String(SEPOLIA), "match"]),
      contract: () => json(sourcifyBody(IPFS, String(SEPOLIA), "match")),
    });
    const built = await buildVerifyInputFromBytecode(TARGET, {
      bytecode: IPFS.runtime,
      fetch: n.fetch,
    });
    assert.equal(built.contractName, "src/Greeter.sol:Greeter");
  });

  it("checks at most three chains: the call's chain first, then exact matches", async () => {
    const n = scenario({
      allChains: allChains(
        ["10", "match"],
        ["1", "exact_match"],
        ["137", "match"],
        [String(SEPOLIA), "match"],
        ["8453", "exact_match"],
        ["42161", "exact_match"],
      ),
      contract: () => json(sourcifyBody(NONE, "1")), // never matches the IPFS hash
    });
    const e = await evError(
      buildVerifyInputFromBytecode(TARGET, { bytecode: IPFS.runtime, fetch: n.fetch }),
    );
    const d = metadataUnavailable(e);
    const chains = n.seen
      .map((r) => /\/v2\/contract\/(\d+)\//.exec(r.url)?.[1])
      .filter((x) => x !== undefined);
    assert.ok(chains.length <= 3, chains.join(","));
    assert.equal(chains[0], String(SEPOLIA));
    for (const c of chains.slice(1))
      assert.ok(["1", "8453", "42161"].includes(c), chains.join(","));
    assert.ok(d.attempts.every((a) => a.source === "sourcify"));
    assert.ok(d.attempts.some((a) => a.outcome === "hash-mismatch"));
    assert.equal(d.hash, `ipfs:${ipfsCidOf(IPFS.runtime)}`);
  });

  it("not found on Sourcify, no gateway: metadata-unavailable with a sourcify not-found attempt", async () => {
    const n = scenario({});
    const e = await evError(
      buildVerifyInputFromBytecode(TARGET, { bytecode: IPFS.runtime, fetch: n.fetch }),
    );
    const d = metadataUnavailable(e);
    assert.equal(d.hash, `ipfs:${ipfsCidOf(IPFS.runtime)}`);
    assert.deepEqual(
      d.attempts.map((a) => [a.source, a.outcome]),
      [["sourcify", "not-found"]],
    );
    assert.equal(d.attempts[0]?.status, 404);
  });

  it("CID mismatch on Sourcify, then the gateway: metadata from the gateway", async () => {
    const n = scenario({
      allChains: allChains([String(SEPOLIA), "exact_match"]),
      contract: () => json(LIVE_SOURCIFY),
      gateway: gatewayFor(IPFS),
    });
    const built = await buildVerifyInputFromBytecode(TARGET, {
      bytecode: IPFS.runtime,
      ipfsGateway: GW,
      fetch: n.fetch,
    });
    assert.equal(built.contractName, "src/Greeter.sol:Greeter");
    const firstGw = n.seen.findIndex((r) => r.url.includes("gw.example"));
    const lastSf = n.seen.map((r) => r.url.startsWith(SOURCIFY)).lastIndexOf(true);
    assert.ok(lastSf < firstGw, "Sourcify is tried before the gateway");
  });

  it("CID mismatch on both: two attempts, hash-mismatch, in order", async () => {
    const n = scenario({
      allChains: allChains([String(SEPOLIA), "exact_match"]),
      contract: () => json(LIVE_SOURCIFY),
      gateway: () => text(NONE.metadata),
    });
    const e = await evError(
      buildVerifyInputFromBytecode(TARGET, {
        bytecode: IPFS.runtime,
        ipfsGateway: GW,
        fetch: n.fetch,
      }),
    );
    const d = metadataUnavailable(e);
    assert.deepEqual(
      d.attempts.map((a) => [a.source, a.outcome]),
      [
        ["sourcify", "hash-mismatch"],
        ["ipfs", "hash-mismatch"],
      ],
    );
    assertNoSecret(e);
  });

  it("allowSourcifyLookup: false makes no Sourcify request", async () => {
    const n = scenario({ gateway: gatewayFor(IPFS) });
    await buildVerifyInputFromBytecode(TARGET, {
      bytecode: IPFS.runtime,
      ipfsGateway: GW,
      allowSourcifyLookup: false,
      fetch: n.fetch,
    });
    assertHosts(n.seen, ["gw.example"]);
  });

  it("allowSourcifyLookup: false and no gateway: metadata-unavailable with no attempts and no request", async (t) => {
    const n = scenario({});
    const e = await evError(
      buildVerifyInputFromBytecode(TARGET, {
        bytecode: IPFS.runtime,
        allowSourcifyLookup: false,
        fetch: n.fetch,
      }),
    );
    t.diagnostic(`actual: ${e.code} ${JSON.stringify(e.details)} | ${e.message}`);
    // Not documented: an empty attempts list (or invalid-input) is the plausible outcome.
    if (e.code === "metadata-unavailable") {
      const d = metadataUnavailable(e);
      assert.deepEqual(d.attempts, []);
    } else {
      assert.equal(e.code, "invalid-input");
    }
    assert.equal(n.seen.length, 0);
  });

  it("Sourcify 500 on all-chains: an unavailable sourcify attempt with status 500", async () => {
    const n = scenario({ allChains: () => text("boom", 500) });
    const e = await evError(
      buildVerifyInputFromBytecode(TARGET, {
        bytecode: IPFS.runtime,
        fetch: n.fetch,
        timeoutMs: 20_000,
      }),
    );
    const d = metadataUnavailable(e);
    assert.deepEqual(
      d.attempts.map((a) => [a.source, a.outcome, a.status]),
      [["sourcify", "unavailable", 500]],
    );
  });

  it("a Sourcify copy with a source that fails its keccak-256: the source is not used", async () => {
    // Decision 0026: such a source is dropped, so the gateway or the caller can supply it; with
    // neither, the builder lists it as missing.
    const body = sourcifyBody(IPFS, String(SEPOLIA));
    const sources = rec(body.sources);
    sources["src/Base.sol"] = { content: `${BASE_SRC}// tampered\n` };
    const n = scenario({
      allChains: allChains([String(SEPOLIA), "exact_match"]),
      contract: () => json({ ...body, sources }),
    });
    const e = await evError(
      buildVerifyInputFromBytecode(TARGET, { bytecode: IPFS.runtime, fetch: n.fetch }),
    );
    assert.equal(e.code, "incomplete-input", `${e.code}: ${e.message}`);
    if (e.details.code !== "incomplete-input") assert.fail();
    assert.deepEqual(e.details.candidates, ["src/Base.sol"]);
    assert.equal(exitCodeOf(e), 2);
  });

  it("Swarm (bzzr1): uses an exact match on the same chain", async () => {
    const n = scenario({
      allChains: allChains([String(SEPOLIA), "exact_match"]),
      contract: () => json(sourcifyBody(BZZR1, String(SEPOLIA))),
    });
    const built = await buildVerifyInputFromBytecode(TARGET, {
      bytecode: BZZR1.runtime,
      fetch: n.fetch,
    });
    assert.equal(built.contractName, "src/Greeter.sol:Greeter");
  });

  it("Swarm: a copy on another chain only is not used", async () => {
    const n = scenario({
      allChains: allChains(["84532", "exact_match"]),
      contract: () => json(sourcifyBody(BZZR1, "84532")),
    });
    const e = await evError(
      buildVerifyInputFromBytecode(TARGET, { bytecode: BZZR1.runtime, fetch: n.fetch }),
    );
    const d = metadataUnavailable(e);
    assert.match(d.hash, /^bzzr1:[0-9a-f]{64}$/);
    assert.ok(BZZR1.runtime.includes(d.hash.slice(6)));
  });

  it("Swarm: a partial match on the same chain is not used", async () => {
    const n = scenario({
      allChains: allChains([String(SEPOLIA), "match"]),
      contract: () => json(sourcifyBody(BZZR1, String(SEPOLIA), "match")),
    });
    const e = await evError(
      buildVerifyInputFromBytecode(TARGET, { bytecode: BZZR1.runtime, fetch: n.fetch }),
    );
    metadataUnavailable(e);
  });

  it("Swarm: never asks the IPFS gateway", async () => {
    const n = scenario({ gateway: gatewayFor(IPFS) });
    const e = await evError(
      buildVerifyInputFromBytecode(TARGET, {
        bytecode: BZZR1.runtime,
        ipfsGateway: GW,
        fetch: n.fetch,
      }),
    );
    const d = metadataUnavailable(e);
    assert.equal(
      n.seen.some((r) => r.url.includes("gw.example")),
      false,
    );
    assert.ok(d.attempts.every((a) => a.source !== "ipfs"));
  });

  it("large metadata (over 256 KiB, chunked CID) from Sourcify", async () => {
    const n = scenario({
      allChains: allChains([String(SEPOLIA), "exact_match"]),
      contract: () => json(sourcifyBody(LARGE, String(SEPOLIA))),
    });
    const built = await buildVerifyInputFromBytecode(TARGET, {
      bytecode: LARGE.runtime,
      fetch: n.fetch,
    });
    assert.equal(built.compiler.input.sources["src/Greeter.sol"]?.content, LARGE_CONTENT);
  });

  it("large metadata from the gateway", async () => {
    const cid = ipfsCidOf(LARGE.runtime);
    const n = scenario({ gateway: (c) => (c === cid ? text(LARGE.metadata) : text("nf", 404)) });
    const built = await buildVerifyInputFromBytecode(TARGET, {
      bytecode: LARGE.runtime,
      ipfsGateway: GW,
      allowSourcifyLookup: false,
      fetch: n.fetch,
    });
    assert.equal(built.compiler.input.sources["src/Greeter.sol"]?.content, LARGE_CONTENT);
  });
});

// --- gateway ----------------------------------------------------------------------------------

describe("#34 IPFS gateway", () => {
  const META_CID = ipfsCidOf(IPFS.runtime);

  it("gateway 404 on the metadata: an ipfs not-found attempt", async () => {
    const n = scenario({ gateway: () => text("nf", 404) });
    const e = await evError(
      buildVerifyInputFromBytecode(TARGET, {
        bytecode: IPFS.runtime,
        ipfsGateway: GW,
        allowSourcifyLookup: false,
        fetch: n.fetch,
      }),
    );
    const d = metadataUnavailable(e);
    assert.deepEqual(
      d.attempts.map((a) => [a.source, a.outcome, a.status]),
      [["ipfs", "not-found", 404]],
    );
    assertNoSecret(e);
  });

  it("gateway 429: an ipfs unavailable attempt with status 429, within the budget", async (t) => {
    const n = scenario({
      // A Retry-After above 30 s ends the retries at once, so the test takes no real wait.
      gateway: () => new Response("slow down", { status: 429, headers: { "retry-after": "900" } }),
    });
    const started = Date.now();
    const e = await evError(
      buildVerifyInputFromBytecode(TARGET, {
        bytecode: IPFS.runtime,
        ipfsGateway: GW,
        allowSourcifyLookup: false,
        fetch: n.fetch,
        timeoutMs: 30_000,
      }),
    );
    t.diagnostic(`actual: ${e.code} ${JSON.stringify(e.details)} | ${e.message}`);
    // Either the retries end, or the budget does; the error must still describe the gateway.
    if (e.code === "metadata-unavailable") {
      const d = metadataUnavailable(e);
      assert.deepEqual(
        d.attempts.map((a) => [a.source, a.outcome, a.status]),
        [["ipfs", "unavailable", 429]],
      );
    } else {
      assert.equal(e.code, "timeout", `${e.code}: ${e.message}`);
    }
    assert.ok(Date.now() - started < 31_000);
    assert.ok(n.seen.length >= 1);
    assertHosts(n.seen, ["gw.example"]);
    assertNoSecret(e);
  });

  it("gateway redirect is not followed", async () => {
    const n = scenario({
      gateway: () =>
        new Response(null, {
          status: 301,
          headers: { location: `https://redirect.example/ipfs/${META_CID}` },
        }),
    });
    const e = await evError(
      buildVerifyInputFromBytecode(TARGET, {
        bytecode: IPFS.runtime,
        ipfsGateway: GW,
        allowSourcifyLookup: false,
        fetch: n.fetch,
      }),
    );
    const d = metadataUnavailable(e);
    assert.equal(d.attempts[0]?.source, "ipfs");
    assert.equal(d.attempts[0]?.outcome, "unavailable");
    assertHosts(n.seen, ["gw.example"]);
  });

  it("passes redirect: manual (or error) to fetch, so a real fetch cannot follow", async () => {
    const modes: string[] = [];
    const fake: typeof fetch = (input, init) => {
      modes.push(String(init?.redirect));
      return Promise.resolve(text("nf", 404));
    };
    await caught(
      buildVerifyInputFromBytecode(TARGET, {
        bytecode: IPFS.runtime,
        ipfsGateway: GW,
        allowSourcifyLookup: false,
        fetch: fake,
      }),
    );
    assert.ok(modes.length > 0);
    for (const m of modes) assert.ok(m === "manual" || m === "error", m);
  });

  it("an oversized metadata body (over 16 MiB, streamed) is refused", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    let pulled = 0;
    const n = scenario({
      gateway: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1;
              if (pulled > 40) controller.close();
              else controller.enqueue(chunk);
            },
          }),
          { status: 200 },
        ),
    });
    const e = await evError(
      buildVerifyInputFromBytecode(TARGET, {
        bytecode: IPFS.runtime,
        ipfsGateway: GW,
        allowSourcifyLookup: false,
        fetch: n.fetch,
      }),
    );
    const d = metadataUnavailable(e);
    assert.equal(d.attempts[0]?.source, "ipfs");
    assert.ok(pulled <= 20, `read ${pulled} MiB`);
  });

  it("an oversized content-length is refused", async () => {
    const n = scenario({
      gateway: () =>
        new Response("{}", {
          status: 200,
          headers: { "content-length": String(17 * 1024 * 1024) },
        }),
    });
    const e = await evError(
      buildVerifyInputFromBytecode(TARGET, {
        bytecode: IPFS.runtime,
        ipfsGateway: GW,
        allowSourcifyLookup: false,
        fetch: n.fetch,
      }),
    );
    metadataUnavailable(e);
  });

  it("wrong content for the metadata CID: hash-mismatch", async () => {
    const n = scenario({ gateway: () => text(IPFS.metadata.replace("Says hello", "Says hullo")) });
    const e = await evError(
      buildVerifyInputFromBytecode(TARGET, {
        bytecode: IPFS.runtime,
        ipfsGateway: GW,
        allowSourcifyLookup: false,
        fetch: n.fetch,
      }),
    );
    const d = metadataUnavailable(e);
    assert.deepEqual(
      d.attempts.map((a) => [a.source, a.outcome]),
      [["ipfs", "hash-mismatch"]],
    );
  });

  it("metadata that is not JSON but has the right CID (crafted bytecode)", async (t) => {
    const body = "not json at all";
    const n = scenario({ gateway: () => text(body) });
    const e = await evError(
      buildVerifyInputFromBytecode(TARGET, {
        bytecode: bytecodeWithCid(cidv0(body)),
        ipfsGateway: GW,
        allowSourcifyLookup: false,
        fetch: n.fetch,
      }),
    );
    t.diagnostic(`actual: ${e.code} ${JSON.stringify(e.details)} | ${e.message}`);
    // Not documented. Must be a typed error, not a crash.
    assert.ok(
      [
        "metadata-unavailable",
        "insufficient-artifact",
        "incomplete-input",
        "invalid-input",
      ].includes(e.code),
      `${e.code}: ${e.message}`,
    );
  });

  it("a source the gateway does not hold (404): incomplete-input listing it", async () => {
    const n = scenario({
      gateway: gatewayFor(IPFS, { [cidv0(BASE_SRC)]: () => text("nf", 404) }),
    });
    const e = await evError(
      buildVerifyInputFromBytecode(TARGET, {
        bytecode: IPFS.runtime,
        ipfsGateway: GW,
        allowSourcifyLookup: false,
        fetch: n.fetch,
      }),
    );
    // Guide table: "The gateway does not hold some source files; details.candidates lists them".
    assert.equal(
      e.code,
      "incomplete-input",
      `${e.code}: ${e.message} ${JSON.stringify(e.details)}`,
    );
    if (e.details.code !== "incomplete-input") assert.fail();
    assert.equal(e.details.field, "sources");
    assert.deepEqual(e.details.candidates, ["src/Base.sol"]);
    assert.equal(exitCodeOf(e), 2);
  });

  it("the missing source passed in options.sources: success", async () => {
    const n = scenario({
      gateway: gatewayFor(IPFS, { [cidv0(BASE_SRC)]: () => text("nf", 404) }),
    });
    const built = await buildVerifyInputFromBytecode(TARGET, {
      bytecode: IPFS.runtime,
      ipfsGateway: GW,
      allowSourcifyLookup: false,
      sources: { "src/Base.sol": BASE_SRC },
      fetch: n.fetch,
    });
    assert.equal(built.compiler.input.sources["src/Base.sol"]?.content, BASE_SRC);
  });

  it("a wrong source in options.sources: source-mismatch", async () => {
    const n = scenario({
      gateway: gatewayFor(IPFS, { [cidv0(BASE_SRC)]: () => text("nf", 404) }),
    });
    const e = await evError(
      buildVerifyInputFromBytecode(TARGET, {
        bytecode: IPFS.runtime,
        ipfsGateway: GW,
        allowSourcifyLookup: false,
        sources: { "src/Base.sol": `${BASE_SRC}\n` },
        fetch: n.fetch,
      }),
    );
    assert.equal(e.code, "source-mismatch");
    if (e.details.code !== "source-mismatch") assert.fail();
    assert.equal(e.details.path, "src/Base.sol");
  });

  it("a source whose gateway content fails its hash: source-mismatch or metadata-unavailable", async (t) => {
    const n = scenario({
      gateway: gatewayFor(IPFS, { [cidv0(BASE_SRC)]: () => text(`${BASE_SRC}// tampered\n`) }),
    });
    const e = await evError(
      buildVerifyInputFromBytecode(TARGET, {
        bytecode: IPFS.runtime,
        ipfsGateway: GW,
        allowSourcifyLookup: false,
        fetch: n.fetch,
      }),
    );
    t.diagnostic(`actual: ${e.code} ${JSON.stringify(e.details)} | ${e.message}`);
    // Issue: "fail with a typed error that names the mismatched file".
    assert.ok(e.code === "source-mismatch" || e.code === "metadata-unavailable", e.code);
    if (e.details.code === "source-mismatch") assert.equal(e.details.path, "src/Base.sol");
    else
      assert.ok(e.message.includes("src/Base.sol"), `message does not name the file: ${e.message}`);
  });

  it("a source gateway 500: metadata-unavailable (gateway failed on a source)", async () => {
    const n = scenario({
      gateway: gatewayFor(IPFS, { [cidv0(BASE_SRC)]: () => text("boom", 500) }),
    });
    const e = await evError(
      buildVerifyInputFromBytecode(TARGET, {
        bytecode: IPFS.runtime,
        ipfsGateway: GW,
        allowSourcifyLookup: false,
        fetch: n.fetch,
        timeoutMs: 30_000,
      }),
    );
    const d = metadataUnavailable(e);
    assert.ok(
      d.attempts.some(
        (a) => a.source === "ipfs" && a.outcome === "unavailable" && a.status === 500,
      ),
      JSON.stringify(d),
    );
    assertNoSecret(e);
  });

  it("gateway with a trailing slash does not double the slash", async () => {
    const n = scenario({ gateway: gatewayFor(IPFS) });
    await buildVerifyInputFromBytecode(TARGET, {
      bytecode: IPFS.runtime,
      ipfsGateway: "https://gw.example/",
      allowSourcifyLookup: false,
      fetch: n.fetch,
    });
    for (const r of n.seen) assert.match(new URL(r.url).pathname, /^\/ipfs\/Qm/);
  });

  it("embedded sources (useLiteralContent) need no source request", async () => {
    const cid = ipfsCidOf(LARGE.runtime);
    const n = scenario({ gateway: (c) => (c === cid ? text(LARGE.metadata) : text("nf", 404)) });
    await buildVerifyInputFromBytecode(TARGET, {
      bytecode: LARGE.runtime,
      ipfsGateway: GW,
      allowSourcifyLookup: false,
      fetch: n.fetch,
    });
    // The large metadata embeds src/Greeter.sol only if useLiteralContent applied to all sources.
    const meta = rec(JSON.parse(LARGE.metadata));
    const withoutContent = Object.values(rec(meta.sources)).filter(
      (s) => !("content" in rec(s)),
    ).length;
    assert.equal(n.seen.length, 1 + withoutContent);
  });
});

// --- abort and timeout ------------------------------------------------------------------------

describe("#34 abort and timeout", () => {
  it("an aborted signal rejects with signal.reason unchanged, before any request", async () => {
    const reason = new Error("stop");
    const n = scenario({});
    const error = await caught(
      buildVerifyInputFromBytecode(TARGET, {
        rpcUrl: RPC_URL,
        fetch: n.fetch,
        signal: AbortSignal.abort(reason),
      }),
    );
    assert.equal(error, reason);
    assert.equal(n.seen.length, 0);
  });

  it("an abort during the gateway request rejects with signal.reason", async () => {
    const controller = new AbortController();
    const reason = { custom: "reason" };
    const n = scenario({
      gateway: () => {
        setTimeout(() => {
          controller.abort(reason);
        }, 10);
        return text("nf", 404);
      },
      other: () => text("x", 500),
    });
    const hang = net((req, signal) => {
      if (req.url.includes("gw.example")) {
        setTimeout(() => {
          controller.abort(reason);
        }, 10);
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(signal.reason);
          });
        });
      }
      return n.fetch(req.url, { method: req.method, body: req.body });
    });
    const error = await caught(
      buildVerifyInputFromBytecode(TARGET, {
        bytecode: IPFS.runtime,
        ipfsGateway: GW,
        fetch: hang.fetch,
        signal: controller.signal,
      }),
    );
    assert.equal(error, reason);
  });

  it("an abort while a fetch ignores the signal still settles promptly", async () => {
    const controller = new AbortController();
    const reason = new Error("user cancelled");
    const n = net(() => {
      setTimeout(() => {
        controller.abort(reason);
      }, 10);
      return new Promise<Response>(() => undefined);
    });
    const started = Date.now();
    const error = await caught(
      buildVerifyInputFromBytecode(TARGET, {
        rpcUrl: RPC_URL,
        fetch: n.fetch,
        signal: controller.signal,
      }),
    );
    assert.equal(error, reason);
    assert.ok(Date.now() - started < 2000);
  });

  it("timeoutMs runs out on a hanging RPC: a typed timeout-like error, promptly, no secret", async (t) => {
    const n = net((_req, signal) => {
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(signal.reason);
        });
      });
    });
    const started = Date.now();
    const e = await evError(
      buildVerifyInputFromBytecode(TARGET, { rpcUrl: RPC_URL, fetch: n.fetch, timeoutMs: 200 }),
    );
    t.diagnostic(`actual: ${e.code} ${JSON.stringify(e.details)} | ${e.message}`);
    assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
    // Not named in the docs. "timeout" or "metadata-unavailable" are both defensible.
    assert.ok(e.code === "timeout" || e.code === "metadata-unavailable", `${e.code}: ${e.message}`);
    assertNoSecret(e);
  });

  it("timeoutMs runs out on a fetch that ignores the signal: still settles", async (t) => {
    const n = net(() => new Promise<Response>(() => undefined));
    const started = Date.now();
    const e = await evError(
      buildVerifyInputFromBytecode(TARGET, {
        bytecode: IPFS.runtime,
        ipfsGateway: GW,
        fetch: n.fetch,
        timeoutMs: 200,
      }),
    );
    t.diagnostic(`actual: ${e.code} ${JSON.stringify(e.details)} | ${e.message}`);
    assert.ok(Date.now() - started < 3000);
    assert.ok(e.code === "timeout" || e.code === "metadata-unavailable", e.code);
  });
});

// --- secrets and hosts ------------------------------------------------------------------------

describe("#34 secrets and hosts", () => {
  it("no secret in a full failure run: logs, error, details, attempts, envelope", async () => {
    const n = scenario({
      allChains: allChains([String(SEPOLIA), "exact_match"]),
      contract: () => text(`err ${RPC_SECRET}`, 500),
      // A 500 is not retried, so the test takes no real backoff wait.
      gateway: () => text(`err ${GW_SECRET} ${GW_QSECRET}`, 500),
    });
    const { logger, lines } = capture();
    const e = await evError(
      buildVerifyInputFromBytecode(TARGET, {
        rpcUrl: RPC_URL,
        ipfsGateway: GW,
        fetch: n.fetch,
        logger,
        timeoutMs: 30_000,
      }),
    );
    metadataUnavailable(e);
    assertNoSecret(e, lines);
    assertHosts(n.seen, ["rpc.example", "sourcify.dev", "gw.example"]);
  });

  it("dweb URLs in the metadata never send a request to another host", async () => {
    const meta = rec(JSON.parse(IPFS.metadata));
    const sources = rec(meta.sources);
    const base = rec(sources["src/Base.sol"]);
    sources["src/Base.sol"] = {
      ...base,
      urls: ["https://evil.example/Base.sol", "bzz-raw://00", `dweb:/ipfs/${cidv0(BASE_SRC)}`],
    };
    const greeter = rec(sources["src/Greeter.sol"]);
    sources["src/Greeter.sol"] = { ...greeter, urls: ["https://evil.example/Greeter.sol"] };
    const metadata = JSON.stringify({ ...meta, sources });
    const cid = cidv0(metadata);
    const n = scenario({
      gateway: (c) =>
        c === cid ? text(metadata) : c === cidv0(BASE_SRC) ? text(BASE_SRC) : text("nf", 404),
      other: () => text("evil", 200),
    });
    const outcome = await caught(
      buildVerifyInputFromBytecode(TARGET, {
        bytecode: bytecodeWithCid(cid),
        ipfsGateway: GW,
        allowSourcifyLookup: false,
        fetch: n.fetch,
      }),
    );
    assertHosts(n.seen, ["gw.example"]);
    // Greeter has no dweb URL, so it is found nowhere.
    assert.ok(outcome instanceof ExplorerVerifyError);
    assert.equal(outcome.code, "incomplete-input");
  });

  it("a dweb URL with a path or odd CID does not escape the gateway path", async () => {
    const meta = rec(JSON.parse(IPFS.metadata));
    const sources = rec(meta.sources);
    sources["src/Base.sol"] = {
      ...rec(sources["src/Base.sol"]),
      urls: ["dweb:/ipfs/../../evil?x=1"],
    };
    sources["src/Greeter.sol"] = {
      ...rec(sources["src/Greeter.sol"]),
      urls: ["dweb:/ipns/evil.example"],
    };
    const metadata = JSON.stringify({ ...meta, sources });
    const cid = cidv0(metadata);
    const n = scenario({ gateway: (c) => (c === cid ? text(metadata) : text("nf", 404)) });
    await caught(
      buildVerifyInputFromBytecode(TARGET, {
        bytecode: bytecodeWithCid(cid),
        ipfsGateway: GW,
        allowSourcifyLookup: false,
        fetch: n.fetch,
      }),
    );
    assertHosts(n.seen, ["gw.example"]);
    for (const r of n.seen) {
      assert.match(new URL(r.url).pathname, new RegExp(`^/${GW_SECRET}/ipfs/[^/]+$`), r.url);
    }
  });
});

// --- verify() ---------------------------------------------------------------------------------

describe("#34 feeding verify()", () => {
  it("the result validates and submits to Sourcify with the rebuilt input", async () => {
    const n = scenario({ gateway: gatewayFor(IPFS) });
    const built = await buildVerifyInputFromBytecode(TARGET, {
      bytecode: IPFS.runtime,
      ipfsGateway: GW,
      allowSourcifyLookup: false,
      fetch: n.fetch,
    });
    const input = { ...TARGET, ...built };
    validateInput(input);

    const posts: Record<string, unknown>[] = [];
    const sf = net((req) => {
      if (req.method === "POST") {
        posts.push(rec(JSON.parse(req.body)));
        return json({ verificationId: "550e8400-e29b-41d4-a716-446655440000" }, 202);
      }
      if (req.url.includes("/v2/verify/")) {
        return json({
          isJobCompleted: true,
          verificationId: "550e8400-e29b-41d4-a716-446655440000",
          contract: { match: "exact_match", chainId: String(SEPOLIA), address: ADDR },
        });
      }
      return json(
        {
          match: null,
          creationMatch: null,
          runtimeMatch: null,
          chainId: String(SEPOLIA),
          address: ADDR,
        },
        404,
      );
    });
    const result = await verify(input, { fetch: sf.fetch, pollIntervalMs: 1_000 });
    assert.equal(result.status, "verified");
    assert.equal(posts.length, 1);
    const body = posts[0] ?? {};
    assert.equal(body.compilerVersion, "0.8.26+commit.8a97fa7a");
    assert.equal(body.contractIdentifier, "src/Greeter.sol:Greeter");
    const std = rec(body.stdJsonInput);
    assert.equal(std.language, "Solidity");
    assert.equal(rec(rec(std.sources)["src/Greeter.sol"]).content, GREETER_SRC);
    const settings = rec(std.settings);
    assert.deepEqual(settings.optimizer, { enabled: true, runs: 200 });
    assert.equal(settings.evmVersion, "paris");
    assert.equal("compilationTarget" in settings, false);
  });

  it("documented exit codes, retryable and docsUrl of both new codes", () => {
    assert.equal(ERROR_EXIT_CODES["no-metadata-hash"], 2);
    assert.equal(ERROR_EXIT_CODES["metadata-unavailable"], 5);
    const a = new ExplorerVerifyError({ code: "no-metadata-hash", found: "no-code" }, "x", {
      hint: ERROR_HINTS["no-metadata-hash"],
      secrets: [],
    });
    const b = new ExplorerVerifyError(
      { code: "metadata-unavailable", hash: "", attempts: [] },
      "x",
      { hint: ERROR_HINTS["metadata-unavailable"], secrets: [] },
    );
    assert.equal(a.retryable, false);
    assert.equal(b.retryable, true);
    const ea = toEnvelope(a);
    const eb = toEnvelope(b);
    assert.equal(ea.ok, false);
    assert.equal(eb.ok, false);
    assert.ok(
      ea.error !== undefined && ea.error.docsUrl.endsWith("/reference/errors/no-metadata-hash"),
    );
    assert.ok(
      eb.error !== undefined && eb.error.docsUrl.endsWith("/reference/errors/metadata-unavailable"),
    );
    assert.ok(
      ea.error !== undefined && ea.error.hint.startsWith("Build the input from the build files"),
    );
    assert.ok(eb.error !== undefined && eb.error.hint.startsWith("Read details.attempts"));
    // json-output.md: the envelope holds the details, redacted.
    assert.ok(eb.error !== undefined);
    assert.deepEqual(eb.error.details, { code: "metadata-unavailable", hash: "", attempts: [] });
  });

  it("TSDoc @examples import the resolver and its types from explorer-verify/resolve", async () => {
    const main: Record<string, unknown> = await import("explorer-verify");
    assert.equal(main.buildVerifyInputFromBytecode, undefined);
    const dts = readFileSync(
      new URL("../../dist/src/input/resolvers/bytecode.d.ts", import.meta.url),
      "utf8",
    );
    for (const name of [
      "buildVerifyInputFromBytecode",
      "BytecodeTarget",
      "BuildFromBytecodeOptions",
    ]) {
      const imports = [...dts.matchAll(/import (?:type )?\{([^}]*)\} from "([^"]+)"/g)].filter(
        ([, names]) => names?.includes(name) === true,
      );
      assert.ok(imports.length > 0, name);
      for (const [, , from] of imports) {
        assert.equal(from, "explorer-verify/resolve", name);
      }
    }
  });
});
