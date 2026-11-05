// Tests added when the proxy-link code joined mutation testing (#194; R-FLOW-8, R-FLOW-4): each one
// fails on a code change in src/backends/proxy-etherscan.ts that the linkProxy() tests let pass.
// Each test calls the linker directly, with a fake fetch that answers in order.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { LinkStep, LinkTarget, LinkVerdict } from "../../src/backends/backend.ts";
import { compatibleProxyLinker, etherscanProxyLinker } from "../../src/backends/proxy-etherscan.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import type { Logger, RouteOverride } from "../../src/types.ts";
import type { Step } from "../helpers/fake-fetch.ts";
import {
  BOX,
  PROXY,
  SEPOLIA,
  assertUnexpected,
  json,
  rejection,
  setup,
} from "../helpers/proxy-link.ts";
import type { SetupOptions } from "../helpers/proxy-link.ts";

const ETHERSCAN: RouteOverride = { backend: "etherscan-v2" };
const COMPATIBLE: RouteOverride = {
  backend: "etherscan-compatible",
  apiUrl: "https://explorer.example.org/api",
};
const GUID = "wccgmdtjug6bss2mf166jzjtqcs4uchztznlevycg6mbwlxttz";
const MISMATCH =
  "The provided expected results are different than the retrieved implementation address!";
const NO_DELEGATECALL =
  "This contract does not look like it contains any delegatecall opcode sequence.";
const NOT_VERIFIED = `The proxy contract at ${PROXY} does not seem to be verified.`;
const target: LinkTarget = { chainId: SEPOLIA, address: PROXY, expectedImplementation: BOX };
const text = (result: unknown, status: "0" | "1" = "0", http = 200): Response =>
  json({ status, message: status === "1" ? "OK" : "NOTOK", result }, http);
const found = (rest: string): string =>
  `The proxy's (${PROXY}) implementation contract is found at ${BOX} and ${rest}`;
const request = async (route: RouteOverride, steps: Step[]): Promise<LinkStep> => {
  const { ctx } = setup(route, steps);
  const linker = route === COMPATIBLE ? compatibleProxyLinker : etherscanProxyLinker;
  return await linker.request(target, ctx);
};
const check = async (steps: Step[], options: SetupOptions = {}): Promise<LinkVerdict> => {
  const { ctx } = setup(ETHERSCAN, steps, options);
  return await etherscanProxyLinker.check(GUID, target, ctx);
};

/** Etherscan's `getsourcecode` answer with this `result`. */
function record(http: number, result: unknown): Response {
  return json({ status: "1", message: "OK", result }, http);
}

describe("the Etherscan proxy link (R-FLOW-8, R-FLOW-4, R-SEC-1)", () => {
  it("gives submitted only for status 1 with a guid of 50 lowercase letters and digits", async () => {
    assert.deepEqual(await request(ETHERSCAN, [text(GUID, "1")]), {
      state: "submitted",
      jobId: GUID,
    });
    for (const answer of [text(GUID, "0"), text(`-${GUID}`, "1")]) {
      const error = await rejection(request(ETHERSCAN, [answer]));
      assert.equal(error.code, "unexpected-response");
    }
    assert.deepEqual(await request(ETHERSCAN, [text(NO_DELEGATECALL, "1")]), {
      state: "not-linked",
      reason: NO_DELEGATECALL,
    });
  });

  it("names the API and the request in unexpected-response, for each Etherscan-style backend", async () => {
    assertUnexpected(
      await rejection(request(ETHERSCAN, [text(GUID, "1", 201)])),
      "etherscan-v2",
      "Etherscan gave an answer to the proxy link request that this client does not recognise (status 201).",
    );
    assertUnexpected(
      await rejection(request(COMPATIBLE, [text("OK", "1")])),
      "etherscan-compatible",
      "Etherscan-compatible explorer gave an answer to the proxy link request that this client does not recognise (status 200).",
    );
  });

  it("reads a refusal or a mismatch only at the start of the request's result", async () => {
    for (const result of [
      `Note: ${MISMATCH}`,
      `Note: ${NO_DELEGATECALL}`,
      `Note: ${NOT_VERIFIED}`,
    ]) {
      const error = await rejection(request(ETHERSCAN, [text(result)]));
      assert.equal(error.code, "unexpected-response", result);
    }
    assert.deepEqual(await request(ETHERSCAN, [text(NOT_VERIFIED)]), {
      state: "not-linked",
      reason: NOT_VERIFIED,
    });
  });

  it("reads a refusal or a mismatch only at the start of the check's result", async () => {
    for (const result of [
      `Note: ${MISMATCH}`,
      `Note: ${NO_DELEGATECALL}`,
      `Note: ${NOT_VERIFIED}`,
    ]) {
      const error = await rejection(check([text(result)]));
      assert.equal(error.code, "proxy-link-unknown-state", result);
    }
    assert.deepEqual(await check([text(NO_DELEGATECALL)]), {
      state: "not-linked",
      reason: NO_DELEGATECALL,
    });
  });

  it("names the status request in unexpected-response, and refuses a status other than 200", async () => {
    assertUnexpected(
      await rejection(check([text(found("is successfully updated."), "1", 201)])),
      "etherscan-v2",
      "Etherscan gave an answer to the proxy link status request that this client does not recognise (status 201).",
    );
  });

  it("keeps a result that starts with Pending in queue pending", async () => {
    assert.deepEqual(await check([text("Pending in queue, try again later")]), {
      state: "pending",
    });
  });

  it("gives linked with whether the implementation is verified", async () => {
    assert.deepEqual(await check([text(found("is successfully updated."), "1")]), {
      state: "linked",
      implementation: BOX,
      implementationVerified: true,
    });
    assert.deepEqual(
      await check([text(found("implementation saved (unverified - without ABI)."), "1")]),
      { state: "linked", implementation: BOX, implementationVerified: false },
    );
  });

  it("reads the record after a mismatch only from a 200 with a list, and an empty list holds none", async () => {
    const none = { state: "mismatch", implementation: undefined };
    assert.deepEqual(await check([text(MISMATCH), record(201, [{ Implementation: BOX }])]), none);
    assert.deepEqual(await check([text(MISMATCH), record(200, [])]), none);
    assert.deepEqual(await check([text(MISMATCH), record(200, ["text"])]), none);
    assert.deepEqual(await check([text(MISMATCH), record(200, [{ Implementation: BOX }])]), {
      state: "mismatch",
      implementation: BOX,
    });
  });

  it("logs the code of the failed record lookup at warn, a key answer included (R-DX-5)", async () => {
    const lines: [string, unknown][] = [];
    const logger: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (message, fields) => {
        lines.push([message, fields]);
      },
      error: () => undefined,
    };
    const verdict = await check([text(MISMATCH), text("Invalid API Key")], { logger });
    assert.deepEqual(verdict, { state: "mismatch", implementation: undefined });
    assert.deepEqual(lines, [
      [
        "Etherscan refused the link for another implementation; the lookup of the one it holds failed (api-key-rejected)",
        { backend: "etherscan-v2", code: "api-key-rejected" },
      ],
    ]);
  });

  it("gives mismatch without a logger, and with a signal that has not aborted", async () => {
    const controller = new AbortController();
    assert.deepEqual(
      await check([text(MISMATCH), text("Invalid API Key")], { signal: controller.signal }),
      { state: "mismatch", implementation: undefined },
    );
  });

  it("rejects with the abort reason during the record lookup, even when it is an ExplorerVerifyError", async () => {
    const controller = new AbortController();
    const reason = new ExplorerVerifyError({ code: "cancelled" }, "Stopped by the caller.", {
      secrets: [],
    });
    const outcome = await check([text(MISMATCH), text("Invalid API Key")], {
      signal: controller.signal,
      before: (sent) => {
        if (sent === 1) {
          controller.abort(reason);
        }
      },
    }).then(
      (value: unknown) => ({ resolved: value }),
      (error: unknown) => error,
    );
    assert.equal(outcome, reason);
  });
});
