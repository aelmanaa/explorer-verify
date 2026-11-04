// Help and the version on the built bin, as an agent runs them (R-AX-11, R-QA-3).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { COMMANDS } from "../../src/commands.ts";
import { helpResult, helpText } from "../../src/help.ts";
import { helpProblems, oneEnvelope, versionProblems } from "../helpers/schema.ts";
import { runBin } from "../helpers/spawn-bin.ts";

describe("the built bin: help and version (R-AX-11)", () => {
  it("prints the help on stdout, nothing on stderr, and exits 0", async () => {
    const result = await runBin(["--help"]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, helpText(helpResult(COMMANDS)));
    assert.equal(result.stderr, "");
  });

  it("prints the help envelope with --json", async () => {
    const result = await runBin(["help", "simulate", "--json"]);
    assert.equal(result.code, 0);
    assert.deepEqual(helpProblems(oneEnvelope(result.stdout)), []);
  });

  it("prints the CLI and core versions, one line each", async () => {
    const result = await runBin(["--version"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /^@explorer-verify\/cli \S+\nexplorer-verify \S+\n$/);
  });

  it("prints the version envelope with --json, with the routing table's date", async () => {
    const result = await runBin(["--version", "--json"]);
    assert.equal(result.code, 0);
    const envelope = oneEnvelope(result.stdout);
    assert.deepEqual(versionProblems(envelope), []);
    assert.match(
      String(Reflect.get(Object(envelope["result"]), "routingTableDate")),
      /^\d{4}-\d{2}-\d{2}$/,
    );
    assert.equal(result.stderr, "");
  });
});
