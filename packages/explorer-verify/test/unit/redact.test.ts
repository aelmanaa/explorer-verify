import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Logger } from "../../src/index.ts";
import { REDACTED, redact, redactingLogger } from "../../src/redact.ts";

// A fake key. Never a real one (R-SEC-1).
const DUMMY_KEY = "DUMMYKEY0123456789ABCDEFGHIJKLMNO";
const R = REDACTED;

describe("redact (R-SEC-1, R-AX-9)", () => {
  it("replaces a known key in a URL query string", () => {
    assert.equal(
      redact(`https://api.example.org/v2/api?chainid=1&apikey=${DUMMY_KEY}&module=contract`, [
        DUMMY_KEY,
      ]),
      `https://api.example.org/v2/api?chainid=1&apikey=${R}&module=contract`,
    );
  });

  it("replaces a key in a form body", () => {
    assert.equal(
      redact(`module=contract&action=verifysourcecode&apikey=${DUMMY_KEY}&codeformat=solidity`),
      `module=contract&action=verifysourcecode&apikey=${R}&codeformat=solidity`,
    );
    assert.equal(redact(`apikey=${DUMMY_KEY}`), `apikey=${R}`);
  });

  it("replaces a key followed by a trailing quote character, and keeps the quote", () => {
    assert.equal(
      redact(`{"url":"https://x.example/api?apikey=${DUMMY_KEY}"}`),
      `{"url":"https://x.example/api?apikey=${R}"}`,
    );
    assert.equal(redact(`'?apikey=${DUMMY_KEY}'`), `'?apikey=${R}'`);
    assert.equal(redact(`"${DUMMY_KEY}"`, [DUMMY_KEY]), `"${R}"`);
  });

  it("replaces an apikey value it was not told about, in any case", () => {
    for (const name of ["apikey", "APIKEY", "ApiKey", "api_key", "api-key", "API_KEY"]) {
      assert.equal(redact(`GET /api?${name}=unknownvalue42`), `GET /api?${name}=${R}`, name);
    }
  });

  it("replaces other key-like parameters: key, token, access_token, auth, secret, password", () => {
    for (const name of [
      "key",
      "token",
      "access_token",
      "access-token",
      "auth",
      "secret",
      "password",
    ]) {
      assert.equal(
        redact(`https://x.example/?a=1&${name}=v4lue`),
        `https://x.example/?a=1&${name}=${R}`,
        name,
      );
    }
  });

  it("replaces a key in a URL fragment", () => {
    assert.equal(
      redact(`https://x.example/page#apikey=${DUMMY_KEY}`),
      `https://x.example/page#apikey=${R}`,
    );
    assert.equal(redact(`https://x.example/#a=1&token=abc`), `https://x.example/#a=1&token=${R}`);
  });

  it("replaces the user name and password of a URL", () => {
    assert.equal(
      redact(`fetch https://user:${DUMMY_KEY}@api.example.org/v2/api failed`),
      `fetch https://${R}@api.example.org/v2/api failed`,
    );
    assert.equal(redact("HTTP://only-user@host.example/"), `HTTP://${R}@host.example/`);
  });

  it("replaces a percent-encoded apikey parameter inside another URL", () => {
    assert.equal(
      redact(`https://proxy.example/?target=https%3A%2F%2Fx%2F%3Fapikey%3D${DUMMY_KEY}`),
      `https://proxy.example/?target=https%3A%2F%2Fx%2F%3Fapikey%3D${R}`,
    );
  });

  it("replaces a bearer token", () => {
    assert.equal(redact(`Authorization: Bearer ${DUMMY_KEY}`), `Authorization: Bearer ${R}`);
  });

  it("replaces a known key anywhere, such as a URL path, and in its URL-encoded form", () => {
    assert.equal(
      redact(`https://rpc.example/v2/${DUMMY_KEY}/x`, [DUMMY_KEY]),
      `https://rpc.example/v2/${R}/x`,
    );
    const spaced = "my key+/=";
    assert.equal(redact(`a ${spaced} b ${encodeURIComponent(spaced)}`, [spaced]), `a ${R} b ${R}`);
  });

  it("leaves parameters whose names only end in a key-like word alone", () => {
    const text = "https://x.example/?monkey=1&tokenizer=2&passkey=3&keyword=4";
    assert.equal(redact(text), text);
  });

  it("ignores empty secrets and leaves text without secrets unchanged", () => {
    assert.equal(redact("nothing to hide", [""]), "nothing to hide");
    assert.equal(redact("nothing to hide"), "nothing to hide");
  });

  it("replaces a secret that cannot be URL-encoded (a lone surrogate) without throwing", () => {
    const lone = "abc\uD800def";
    assert.equal(redact(`x ${lone} y`, [lone]), `x ${R} y`);
  });
});

describe("redactingLogger (R-SEC-1)", () => {
  it("redacts every message before it reaches each of the four methods", () => {
    const seen: string[] = [];
    const logger: Logger = {
      debug: (message) => seen.push(`debug ${message}`),
      info: (message) => seen.push(`info ${message}`),
      warn: (message) => seen.push(`warn ${message}`),
      error: (message) => seen.push(`error ${message}`),
    };
    const log = redactingLogger(logger, [DUMMY_KEY]);
    log.debug(`GET https://x.example/api?apikey=${DUMMY_KEY}`);
    log.info(`key ${DUMMY_KEY}`);
    log.warn(`retry token=abc`);
    log.error(`https://u:${DUMMY_KEY}@x.example/`);
    assert.deepEqual(seen, [
      `debug GET https://x.example/api?apikey=${R}`,
      `info key ${R}`,
      `warn retry token=${R}`,
      `error https://${R}@x.example/`,
    ]);
    assert.ok(!seen.join("\n").includes(DUMMY_KEY));
  });

  it("redacts unknown apikey values with no secrets given", () => {
    const seen: string[] = [];
    const log = redactingLogger({
      debug: (message) => seen.push(message),
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });
    log.debug("?apikey=zzz");
    assert.deepEqual(seen, [`?apikey=${R}`]);
  });
});
