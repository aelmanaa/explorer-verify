// Redirect and gzip tests of the HTTP layer against two HTTP servers on 127.0.0.1, with the real
// fetch and real timers (R-SEC-2, R-FLOW-6). They live apart from the mock-timer tests: the real
// fetch keeps sockets whose timers must never be created while a test mocks setTimeout.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { inspect } from "node:util";
import { gzipSync } from "node:zlib";

import { ExplorerVerifyError } from "../../src/errors.ts";
import { request } from "../../src/http/fetch.ts";
import type { HttpRequest } from "../../src/http/fetch.ts";

// A fake key. Never a real one (R-SEC-1).
const DUMMY_KEY = "DUMMYKEY0123456789ABCDEFGHIJKLMNO";
const MiB = 1024 * 1024;

function get(url: string): HttpRequest {
  return { url, method: "GET", retry: "safe" };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("the promise resolved");
}

async function explorerError(promise: Promise<unknown>): Promise<ExplorerVerifyError> {
  const error = await rejection(promise);
  assert.ok(error instanceof ExplorerVerifyError, String(error));
  return error;
}

/** Every surface of an error as text, to check that a value never appears in it. */
function surfaces(error: ExplorerVerifyError): string {
  return [
    error.message,
    error.hint,
    JSON.stringify(error),
    JSON.stringify(error.details),
    String(error),
    error.stack ?? "",
    inspect(error, { depth: Infinity, showHidden: true }),
  ].join("\n");
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const { port } = address satisfies AddressInfo;
  return { server, origin: `http://127.0.0.1:${String(port)}` };
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

describe("request: redirects are never followed, against local servers (R-SEC-2)", () => {
  for (const status of [301, 302, 303, 307, 308]) {
    for (const retry of ["safe", "submit"] as const) {
      it(`does not follow a ${String(status)} to another server, on retry ${retry} (R-SEC-2)`, async () => {
        let elsewhere = 0;
        const other = await listen((req, res) => {
          elsewhere += 1;
          req.resume();
          res.end("{}");
        });
        let hits = 0;
        const api = await listen((req, res) => {
          hits += 1;
          req.resume();
          res.writeHead(status, { location: `${other.origin}/steal?apikey=${DUMMY_KEY}` });
          res.end();
        });
        try {
          const req: HttpRequest = {
            url: `${api.origin}/v2/api?apikey=${DUMMY_KEY}`,
            method: retry === "submit" ? "POST" : "GET",
            retry,
          };
          const error = await explorerError(
            request({ backend: "sourcify", secrets: [DUMMY_KEY] }, req),
          );
          assert.equal(error.code, "unexpected-response");
          assert.match(error.message, /redirect, which is not followed/);
          assert.equal(hits, 1);
          assert.equal(elsewhere, 0);
          const text = surfaces(error);
          assert.ok(!text.includes(DUMMY_KEY));
          assert.ok(!text.includes("/steal"), "the Location header leaked");
        } finally {
          await close(api.server);
          await close(other.server);
        }
      });
    }
  }
});

describe("request: response body limit, against a local server (R-FLOW-6)", () => {
  it("stops a gzip body whose decoded size is above the limit (R-FLOW-6)", async () => {
    const packed = gzipSync(new Uint8Array(8 * MiB));
    const api = await listen((req, res) => {
      req.resume();
      res.writeHead(200, {
        "content-encoding": "gzip",
        "content-length": String(packed.length),
      });
      res.end(packed);
    });
    try {
      const error = await explorerError(
        request({ backend: "sourcify", secrets: [], maxResponseBytes: MiB }, get(`${api.origin}/`)),
      );
      assert.match(error.message, /larger than 1048576 bytes/);
    } finally {
      await close(api.server);
    }
  });
});
