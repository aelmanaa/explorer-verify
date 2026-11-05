// Tests added when the RPC reader joined mutation testing (#202; R-IN-3, R-SEC-1, decision 0026):
// each one fails on a code change in src/http/rpc.ts that the resolver and derivation tests let
// pass. The functions are pure, so no request is sent.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  endpointSecrets,
  hexQuantity,
  jsonFields,
  rpcRequest,
  rpcResult,
  servesChain,
} from "../../src/http/rpc.ts";

describe("endpointSecrets: the parts of an rpcUrl redacted from logs and errors (R-SEC-1)", () => {
  it("takes each path segment and query value of 8 characters or more, never the host", () => {
    const secrets = endpointSecrets({
      apiBase: "https://rpc-provider-host.example/v2/abcd1234/short",
      search: "?key=qwerty12&tiny=1234567",
    });
    assert.deepEqual(secrets, ["abcd1234", "qwerty12"]);
  });

  it("adds the decoded form of an encoded part, and keeps a part that does not decode", () => {
    assert.deepEqual(
      endpointSecrets({ apiBase: "https://rpc.example/key%2Bone%2Btwo", search: "" }),
      ["key%2Bone%2Btwo", "key+one+two"],
    );
    assert.deepEqual(
      endpointSecrets({ apiBase: "https://rpc.example/bad%E0%A4%Akey", search: "" }),
      ["bad%E0%A4%Akey"],
    );
  });

  it("gives a query value once when its decoded form is the same", () => {
    assert.deepEqual(
      endpointSecrets({ apiBase: "https://rpc.example", search: "?apikey=a%20b%20c%20d1" }),
      ["a b c d1"],
    );
  });

  it("gives nothing for a URL without a path or a query", () => {
    assert.deepEqual(endpointSecrets({ apiBase: "https://rpc.example", search: "" }), []);
  });
});

describe("rpcRequest: one JSON-RPC call (decision 0026)", () => {
  it("posts { jsonrpc, id, method, params } as JSON to the URL with its query, retried as safe", () => {
    const request = rpcRequest(
      { apiBase: "https://rpc.example/v2/path", search: "?x=1" },
      "eth_getCode",
      ["0x01", "latest"],
    );
    assert.deepEqual(request, {
      url: "https://rpc.example/v2/path?x=1",
      method: "POST",
      retry: "safe",
      body: '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["0x01","latest"]}',
      headers: { "content-type": "application/json" },
    });
  });
});

describe("jsonFields and rpcResult: the result of a JSON-RPC answer (R-IN-3)", () => {
  it("reads the fields of a JSON object, and nothing from other JSON or from text", () => {
    assert.deepEqual(
      jsonFields('{"result":"0x1","id":1}'),
      new Map<string, unknown>([
        ["result", "0x1"],
        ["id", 1],
      ]),
    );
    assert.equal(jsonFields("[1]"), undefined);
    assert.equal(jsonFields("null"), undefined);
    assert.equal(jsonFields("not json"), undefined);
  });

  it("gives the result of a 200 answer only, keeps null, and nothing for an error answer", () => {
    assert.equal(rpcResult(200, '{"jsonrpc":"2.0","id":1,"result":"0xaa"}'), "0xaa");
    assert.equal(rpcResult(200, '{"jsonrpc":"2.0","id":1,"result":null}'), null);
    assert.equal(rpcResult(201, '{"jsonrpc":"2.0","id":1,"result":"0xaa"}'), undefined);
    assert.equal(rpcResult(500, '{"result":"0xaa"}'), undefined);
    assert.equal(rpcResult(200, '{"jsonrpc":"2.0","id":1,"error":{"code":-32000}}'), undefined);
    assert.equal(rpcResult(200, "<html>"), undefined);
  });
});

describe("hexQuantity and servesChain: the chain an RPC serves (decision 0026)", () => {
  it("reads 0x and 1 to 16 hex digits in either case, and nothing else", () => {
    assert.equal(hexQuantity("0xaa36a7"), 11155111);
    assert.equal(hexQuantity("0xAA36A7"), 11155111);
    assert.equal(hexQuantity("0x0"), 0);
    assert.equal(hexQuantity("0x1fffffffffffff"), Number.MAX_SAFE_INTEGER);
    assert.equal(hexQuantity("0xffffffffffffffff"), 2 ** 64);
    const rejected: unknown[] = ["0x", "0x1ffffffffffffffff", "aa36a7", " 0x1", "0x1 ", "0x1g"];
    for (const value of [...rejected, "x0x1", 1, null, ["0x1"]]) {
      assert.equal(hexQuantity(value), undefined, String(value));
    }
  });

  it("says whether the answer names the chain of the call", () => {
    assert.equal(servesChain("0xaa36a7", 11155111), true);
    assert.equal(servesChain("0x1", 11155111), false);
    assert.equal(servesChain(undefined, 11155111), false);
    assert.equal(servesChain("11155111", 11155111), false);
  });
});
