// Reading the JSON of --input and --input-json (R-AX-16): limits, stdin chunks and read errors.
// No issue repeats a path or the text read.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { MAX_JSON_BYTES, readJsonFile, readJsonStdin } from "../../src/request.ts";
import { fakeStdin } from "../helpers/fake-io.ts";

const DIR = mkdtempSync(join(tmpdir(), "explorer-verify-request-"));
after(() => {
  rmSync(DIR, { recursive: true, force: true });
});

describe("readJsonFile", () => {
  it("reads a file within the limit, and refuses a larger one without reading it", async () => {
    const path = join(DIR, "big.json");
    writeFileSync(path, JSON.stringify({ text: "x".repeat(64) }));
    assert.deepEqual(await readJsonFile(path, "--input[1]"), { value: { text: "x".repeat(64) } });
    assert.deepEqual(await readJsonFile(path, "--input[1]", 16), {
      issue: {
        field: "--input[1]",
        message: `must be at most ${String(MAX_JSON_BYTES / 1024 / 1024)} MiB`,
      },
    });
  });
});

describe("readJsonStdin", () => {
  it("reads text and byte chunks", async () => {
    const bytes = new TextEncoder().encode('{"handle":');
    const read = await readJsonStdin(() => fakeStdin([bytes, '"ev1:x"}']), "--input-json");
    assert.deepEqual(read, { value: { handle: "ev1:x" } });
  });

  it("refuses more than the limit", async () => {
    const read = await readJsonStdin(() => fakeStdin(["[1,", "2]"]), "--input-json", 3);
    assert.ok("issue" in read);
    assert.match(read.issue.message, /must be at most/);
  });

  it("refuses a chunk that is neither text nor bytes, and a read that fails", async () => {
    const odd = await readJsonStdin(() => fakeStdin([42]), "--input-json");
    assert.deepEqual(odd, {
      issue: { field: "--input-json", message: "could not be read from stdin" },
    });
    const failed = Object.assign(new Error("secret text"), { code: "EIO" });
    const broken = await readJsonStdin(() => fakeStdin([], false, failed), "--input-json");
    assert.deepEqual(broken, {
      issue: { field: "--input-json", message: "could not be read from stdin (EIO)" },
    });
  });
});
