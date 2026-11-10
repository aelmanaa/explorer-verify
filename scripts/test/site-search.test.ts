// The ranking functions of the docs site's local search (scripts/site-search.ts). VitePress sends
// each to the browser as its source text, so the tests also run the copy rebuilt from that text,
// in a context of its own where nothing of this module is in scope.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

import { boostDocument, processTerm } from "../site-search.ts";

/**
 * The function VitePress rebuilds in the browser from `fn`'s source text, or `fn` itself when the
 * text gives no function, which each test then reports.
 */
function rebuilt<F extends (...args: never[]) => unknown>(fn: F): F {
  const copy: unknown = runInNewContext(`(${fn.toString()})`);
  return isFunction(copy, fn) ? copy : fn;
}

/** Whether `value` is a function, read with the signature of `like`. */
function isFunction<F extends (...args: never[]) => unknown>(value: unknown, like: F): value is F {
  return typeof value === "function" && value !== like;
}

describe("processTerm", () => {
  it("lowers the case and drops the plural s of a word longer than three letters", () => {
    assert.equal(processTerm("Keys"), "key");
    assert.equal(processTerm("handlers"), "handler");
    assert.equal(processTerm("address"), "address");
    assert.equal(processTerm("ABIs"), "abi");
    assert.equal(processTerm("Bus"), "bus");
  });

  it("works from its source text alone", () => {
    const copy = rebuilt(processTerm);
    assert.notEqual(copy, processTerm);
    assert.equal(copy("Keys"), "key");
  });
});

/** The fields VitePress stores for a section of the page titled `title`. */
function page(title: string): Record<string, unknown> {
  return { titles: [title], title: "Section" };
}

describe("boostDocument", () => {
  it("triples a section whose page title holds the term as a whole word", () => {
    assert.equal(boostDocument("/reference/api-keys#a", "key", page("API keys")), 3);
    assert.equal(boostDocument("/guides/verify#a", "verify", page("Verify from Node.js")), 3);
  });

  it("does not boost a page whose title holds the term only inside a longer word", () => {
    assert.equal(boostDocument("/reference/server-handler#a", "handle", page("Server handler")), 1);
    assert.equal(
      boostDocument("/reference/errors/handler-refused#a", "handle", page("handler-refused")),
      1,
    );
    assert.equal(boostDocument("/reference/handles#a", "handle", page("Handles")), 3);
  });

  it("reads the section's own title when it has no page title", () => {
    assert.equal(boostDocument("/index#a", "verify", { titles: [], title: "Verify" }), 3);
    assert.equal(boostDocument("/index#a", "verify", { title: "Overview" }), 1);
    assert.equal(boostDocument("/index#a", "verify"), 1);
    assert.equal(boostDocument("/index#a", "verify", { titles: [42] }), 1);
  });

  it("halves a page of the generated API reference", () => {
    assert.equal(boostDocument("/api/explorer-verify/#a", "verify", page("explorer-verify")), 1.5);
    assert.equal(boostDocument("/api/explorer-verify/#a", "handle", page("explorer-verify")), 0.5);
  });

  it("works from its source text alone", () => {
    const copy = rebuilt(boostDocument);
    assert.notEqual(copy, boostDocument);
    assert.equal(copy("/reference/server-handler#a", "handle", page("Server handler")), 1);
    assert.equal(copy("/reference/api-keys#a", "key", page("API keys")), 3);
  });
});
