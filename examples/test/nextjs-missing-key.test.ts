// The Next.js example without ETHERSCAN_API_KEY: the route throws `invalid-input` on its first
// request, naming the option and not a value, so a deployment without the secret fails loudly
// and a build without it still succeeds (R-SRV-1, R-SEC-1). A file of its own: the route keeps its
// handler once created, and node --test runs each file in its own process.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExplorerVerifyError } from "explorer-verify";

import { POST } from "../server-nextjs/app/api/verify/route.ts";
import { clientRequest, recorded } from "./network.ts";

const STATUS = recorded("2026-11-03-checkverifystatus-factory-child-02-pass");

describe("examples/server-nextjs without its key", () => {
  it("loads, then throws invalid-input on the first request", async () => {
    delete process.env.ETHERSCAN_API_KEY;
    delete process.env.VERIFY_DEPLOYERS;
    const [url, init] = clientRequest(STATUS.fields);
    const request = new Request(`https://dapp.example/api/verify${new URL(url).search}`, init);
    await assert.rejects(
      POST(request),
      (error: unknown) =>
        error instanceof ExplorerVerifyError &&
        error.code === "invalid-input" &&
        error.message.includes("apiKey"),
    );
  });
});
