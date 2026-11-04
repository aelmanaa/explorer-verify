// The closest match for a mistyped command or option (R-AX-10).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { closest, editDistance } from "../../src/suggest.ts";

describe("editDistance", () => {
  it("counts insertions, deletions, substitutions and swaps of neighbours as 1 each", () => {
    assert.equal(editDistance("", ""), 0);
    assert.equal(editDistance("", "abc"), 3);
    assert.equal(editDistance("abc", ""), 3);
    assert.equal(editDistance("verify", "verify"), 0);
    assert.equal(editDistance("verfy", "verify"), 1);
    assert.equal(editDistance("verifyy", "verify"), 1);
    assert.equal(editDistance("varify", "verify"), 1);
    assert.equal(editDistance("vreify", "verify"), 1);
    assert.equal(editDistance("dryrun", "dry-run"), 1);
    assert.equal(editDistance("kitten", "sitting"), 3);
    assert.equal(editDistance("ca", "abc"), 3);
  });

  it("is symmetric", () => {
    for (const [a, b] of [
      ["status", "stats"],
      ["log-format", "logformat"],
      ["json", "jsno"],
    ] as const) {
      assert.equal(editDistance(a, b), editDistance(b, a));
    }
  });
});

describe("closest (R-AX-10)", () => {
  const names = ["verify", "status", "dry-run", "json", "quiet", "verbose", "log-format", "color"];

  it("suggests the single closest name", () => {
    assert.equal(closest("verfy", names), "verify");
    assert.equal(closest("dryrun", names), "dry-run");
    assert.equal(closest("colour", names), "color");
    assert.equal(closest("jsno", names), "json");
    assert.equal(closest("logformat", names), "log-format");
    assert.equal(closest("stauts", names), "status");
  });

  it("suggests nothing when no name is close", () => {
    assert.equal(closest("deploy", names), undefined);
    assert.equal(closest("ABCDEFGHIJKLMNOPQRSTUVWXYZ12345678", names), undefined);
    assert.equal(closest("nope", names), undefined);
  });

  it("allows at most a third of the name's length, and at least 1", () => {
    // `json` has 4 characters, so only 1 may differ.
    assert.equal(closest("jsn", names), "json");
    assert.equal(closest("jxxn", names), undefined);
    // `log-format` has 10 characters, so 3 may differ.
    assert.equal(closest("lg-frmt", names), "log-format");
    assert.equal(closest("lg-fr", names), undefined);
  });

  it("compares no name shorter than three characters, typed or known", () => {
    assert.equal(closest("js", names), undefined);
    assert.equal(closest("qq", ["q", "qq", "qqq"]), undefined);
    assert.equal(closest("abd", ["ab", "abc"]), "abc");
  });

  it("never suggests the name that was typed", () => {
    assert.equal(closest("verify", names), undefined);
  });

  it("skips a name whose length differs by more than its limit, so 1 MB of input is fast", () => {
    const long = "x".repeat(1_000_000);
    const started = performance.now();
    assert.equal(closest(long, names), undefined);
    assert.equal(closest(`--${long}`, names), undefined);
    assert.ok(performance.now() - started < 500, "closest took too long on 1 MB");
    // Within the limit the length check lets the name through.
    assert.equal(closest("verifyxy", names), "verify");
    assert.equal(closest("verifyxyz", names), undefined);
  });

  it("keeps the first of two names at the same distance, in table order", () => {
    assert.equal(closest("stat", ["stay", "star"]), "stay");
    assert.equal(closest("stat", ["star", "stay"]), "star");
    // A nearer name later in the table still wins.
    assert.equal(closest("verifx", ["verbose", "verify"]), "verify");
  });
});
