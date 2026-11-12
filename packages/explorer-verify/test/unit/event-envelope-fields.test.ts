// The public event and envelope fields settled before schema v1 (#224).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Backend, ProxyLinker } from "../../src/backends/backend.ts";
import { toEnvelope, exitCodeOf } from "../../src/envelope.ts";
import type { Envelope } from "../../src/envelope.ts";
import { newError } from "../../src/error-hints.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import { redactEvent } from "../../src/observe.ts";
import type {
  BackendOutcome,
  Hex,
  LinkProxyResult,
  VerifyEachResult,
  VerifyEvent,
  VerifyInput,
} from "../../src/types.ts";
import { runLinkProxy, runVerifyEach } from "../helpers/defaults.ts";
import { validateEnvelope } from "./envelope-schema.ts";

const ADDRESS: Hex = `0x${"ab".repeat(20)}`;
const IMPLEMENTATION: Hex = `0x${"cd".repeat(20)}`;
const SECRET = "mutation-fields-dummy-secret-224";
const input: VerifyInput = {
  chainId: 1,
  address: ADDRESS,
  contractName: "A.sol:A",
  compiler: {
    kind: "solc",
    version: "0.8.24+commit.e11b9ed9",
    input: {
      language: "Solidity",
      sources: { "A.sol": { content: "contract A {}" } },
      settings: {},
    },
  },
};

describe("settled event fields (R-DX-6, R-RT-4, R-SEC-1)", () => {
  it("distinguishes concurrent entries for the same backend", async () => {
    const events: VerifyEvent[] = [];
    const client: Backend = {
      name: "sourcify",
      takesConstructorArgs: true,
      lookup: async () => ({ match: "exact" }),
      submit: async () => {
        throw new Error("no submit expected");
      },
      poll: async () => {
        throw new Error("no poll expected");
      },
      explorerUrl: () => "https://scan.example/address",
    };
    await runVerifyEach(
      input,
      {
        backends: [
          { backend: "sourcify", apiUrl: "https://one.example/server" },
          { backend: "sourcify", apiUrl: "https://two.example/server" },
        ],
        onEvent: (event) => {
          events.push(event);
        },
      },
      { backends: { sourcify: client } },
    );
    assert.ok(events.length > 0);
    assert.ok(events.every((event) => event.entry === 0 || event.entry === 1));
    for (const entry of [0, 1]) {
      assert.deepEqual(
        events.filter((event) => event.entry === entry).map((event) => event.type),
        ["verify.validated", "verify.routed", "verify.lookup", "verify.result"],
      );
    }
    const result = events.find((event) => event.type === "verify.result");
    assert.ok(result?.type === "verify.result" && result.status !== "failed");
    assert.equal(result.explorerUrl, "https://scan.example/address");
  });

  it("preserves the entry while redacting the result URL", () => {
    const event = redactEvent(
      {
        type: "verify.result",
        backend: "sourcify",
        status: "verified",
        match: "exact",
        explorerUrl: `https://scan.example/${SECRET}`,
        entry: 2,
      },
      [SECRET],
    );
    assert.equal(event.entry, 2);
    assert.ok(!JSON.stringify(event).includes(SECRET));
  });

  it("emits proxy stages for a linked proxy", async () => {
    const events: VerifyEvent[] = [];
    const linker: ProxyLinker = {
      request: async () => ({
        state: "linked",
        implementation: IMPLEMENTATION,
        implementationVerified: true,
      }),
      check: async () => {
        throw new Error("no poll expected");
      },
    };
    await runLinkProxy(
      { chainId: 1, address: ADDRESS },
      {
        route: { backend: "blockscout", apiUrl: "https://scan.example/api" },
        onEvent: (event) => {
          events.push(event);
        },
      },
      { linkers: { blockscout: linker } },
    );
    assert.deepEqual(
      events.map((event) => event.type),
      ["proxy.routed", "proxy.result"],
    );
    assert.ok(events.every((event) => event.entry === undefined));
  });
});

describe("proxy result envelopes (R-AX-5, R-FLOW-8)", () => {
  const results: LinkProxyResult[] = [
    {
      status: "linked",
      backend: "blockscout",
      implementation: IMPLEMENTATION,
      implementationVerified: true,
    },
    {
      status: "linked",
      backend: "blockscout",
      implementation: IMPLEMENTATION,
      implementationVerified: false,
      explorerUrl: `https://scan.example/${SECRET}`,
    },
    { status: "mismatch", backend: "blockscout", expectedImplementation: ADDRESS },
    {
      status: "mismatch",
      backend: "blockscout",
      implementation: IMPLEMENTATION,
      expectedImplementation: ADDRESS,
    },
    { status: "not-linked", backend: "blockscout", reason: `Refused ${SECRET}` },
  ];
  for (const [index, result] of results.entries()) {
    it(`serializes ${result.status} case ${String(index)} with its exit code`, () => {
      const envelope = toEnvelope(result, { secrets: [SECRET] });
      assert.deepEqual(validateEnvelope(envelope), []);
      assert.equal(envelope.ok, result.status === "linked");
      assert.equal(exitCodeOf(result), result.status === "linked" ? 0 : 1);
      assert.ok(!JSON.stringify(envelope).includes(SECRET));
      const expected: unknown = JSON.parse(JSON.stringify(result).replaceAll(SECRET, "[redacted]"));
      assert.deepEqual(envelope, {
        schemaVersion: 1,
        ok: result.status === "linked",
        result: expected,
      });
    });
  }

  it("rejects invalid proxy fields passed by untyped code", () => {
    const linked = results[0];
    assert.ok(linked !== undefined);
    const invalid = [
      { ...linked, backend: "unknown" },
      { ...linked, implementation: "0xab" },
      { ...linked, implementationVerified: undefined },
      { ...linked, explorerUrl: 3 },
      { status: "mismatch", backend: "blockscout", expectedImplementation: "0xab" },
      {
        status: "mismatch",
        backend: "blockscout",
        expectedImplementation: ADDRESS,
        implementation: "bad",
      },
      { status: "not-linked", backend: "blockscout", reason: 3 },
      { status: "not-linked", backend: "unknown", reason: "refused" },
    ];
    for (const value of invalid) {
      assert.throws(
        () => Reflect.apply(toEnvelope, undefined, [value]),
        (error: unknown) => {
          assert.ok(error instanceof ExplorerVerifyError);
          assert.equal(error.code, "invalid-input");
          return true;
        },
      );
    }
  });

  it("normalizes proxy addresses and reports each invalid field", () => {
    const mixed: Hex = `0x${"Ab".repeat(20)}`;
    const linked = {
      status: "linked",
      backend: "blockscout",
      implementation: mixed,
      implementationVerified: false,
    } as const;
    assert.deepEqual(toEnvelope(linked), {
      schemaVersion: 1,
      ok: true,
      result: { ...linked, implementation: mixed.toLowerCase() },
    });
    const mismatch = {
      status: "mismatch",
      backend: "blockscout",
      expectedImplementation: ADDRESS,
    } as const;
    const invalid = [
      {
        value: { status: "not-linked", backend: "blockscout", reason: 1 },
        field: "outcome.reason",
        message: "must be a string",
      },
      {
        value: { ...linked, implementation: "bad" },
        field: "outcome.implementation",
        message: "must be 0x followed by 40 hex digits",
      },
      {
        value: { ...linked, implementationVerified: 1 },
        field: "outcome.implementationVerified",
        message: "must be a boolean",
      },
      {
        value: { ...mismatch, backend: "unknown" },
        field: "outcome.backend",
        message: "must be one of BACKEND_NAMES",
      },
      {
        value: { ...mismatch, expectedImplementation: "bad" },
        field: "outcome.expectedImplementation",
        message: "must be 0x followed by 40 hex digits",
      },
    ];
    for (const { value, field, message } of invalid) {
      assert.throws(
        () => Reflect.apply(toEnvelope, undefined, [value]),
        (error: unknown) => {
          assert.ok(error instanceof ExplorerVerifyError);
          assert.equal(error.details.code, "invalid-input");
          if (error.details.code === "invalid-input")
            assert.deepEqual(error.details.issues, [{ field, message }]);
          return true;
        },
      );
    }
  });

  it("retains the result type in a generic envelope", () => {
    const result = { status: "not-linked", backend: "blockscout", reason: "refused" } as const;
    const envelope: Envelope<typeof result> = toEnvelope(result);
    assert.ok(envelope.error === undefined);
    const status: "not-linked" = envelope.result.status;
    assert.equal(status, "not-linked");
  });
});

describe("multi-backend envelope discrimination (R-AX-5, R-RT-4)", () => {
  const success: BackendOutcome = {
    backend: "sourcify",
    ok: true,
    result: { status: "verified", backend: "sourcify", match: "exact" },
  };
  const failure: BackendOutcome = {
    backend: "sourcify",
    ok: false,
    result: { status: "failed", backend: "sourcify", reason: "rejected", reasonCode: "unknown" },
  };
  const error = newError({ code: "network", backend: "sourcify", attempts: 1 }, "offline", {
    secrets: [],
  });

  it("requires the outer ok to agree with every outcome", () => {
    for (const outcomes of [
      [success],
      [failure],
      [{ backend: "sourcify" as const, ok: false as const, error }],
    ]) {
      const envelope = toEnvelope({ outcomes });
      assert.deepEqual(validateEnvelope(envelope), []);
      assert.notDeepEqual(validateEnvelope({ ...envelope, ok: !envelope.ok }), []);
    }
  });

  it("refuses an outcome carrying both a result and an error", () => {
    assert.throws(
      () => Reflect.apply(toEnvelope, undefined, [{ outcomes: [{ ...failure, error }] }]),
      (thrown: unknown) => {
        assert.ok(thrown instanceof ExplorerVerifyError);
        assert.equal(thrown.code, "invalid-input");
        return true;
      },
    );
  });

  it("narrows successful envelopes and makes opposite members unavailable", () => {
    const envelope: Envelope<VerifyEachResult> = toEnvelope({ outcomes: [success] });
    assert.ok(envelope.ok);
    const absent: undefined = envelope.result.outcomes[0]?.error;
    assert.equal(absent, undefined);
    type Both = {
      backend: "sourcify";
      ok: true;
      result: typeof success.result;
      error: typeof error;
    };
    const assignable: Both extends BackendOutcome ? true : false = false;
    assert.equal(assignable, false);
  });
});
