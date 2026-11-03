import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertLinear } from "./linear.ts";

const SMALL = 1 << 16;

/** Waits for `ms` milliseconds without yielding, as a slow synchronous call does. */
function busy(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // Spin.
  }
}

let sink = 0;

/**
 * Runs `units` times 50 000 steps of arithmetic. Load from other processes slows it as it slows
 * a regular expression, on both sides of a comparison; a wait would slow only the side it
 * preempts.
 */
function work(units: number): void {
  let acc = sink;
  for (let step = 0; step < units * 50_000; step++) {
    acc = (acc * 31 + step) | 0;
  }
  sink = acc;
}

/** The length of the longest line of `text`. */
function longestLine(text: string): number {
  let longest = 0;
  for (const line of text.split("\n")) {
    longest = Math.max(longest, line.length);
  }
  return longest;
}

/** Planted code whose cost grows with the square of the longest line. */
function quadraticInLine(text: string): void {
  work((longestLine(text) / SMALL) ** 2);
}

/**
 * The message of the first of up to 5 calls of `check` that throws, or `undefined` when none
 * throws. The timing helper errs toward passing when other processes load the machine, so a
 * check of slow code may pass once. A pass costs 3 rounds, a failure 20.
 */
function firstFailure(check: () => void): string | undefined {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      check();
    } catch (error) {
      return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
  }
  return undefined;
}

// Planted code that stands in for a linear or a quadratic pattern. These tests check the timing
// helper that the redaction tests use (R-SEC-1).
describe("assertLinear", () => {
  it("passes code whose cost grows linearly with the input", () => {
    assertLinear(
      "linear",
      (size) => "a".repeat(size),
      (text) => {
        work(text.length / SMALL);
      },
    );
  });

  it("fails code whose cost grows with the square of the input", () => {
    const failure = firstFailure(() => {
      assertLinear(
        "quadratic",
        (size) => "a".repeat(size),
        (text) => {
          work((text.length / SMALL) ** 2);
        },
      );
    });
    assert.match(failure ?? "passed", /^AssertionError: quadratic: /);
  });

  it("fails fully quadratic code on a small input, without running the 1 MB call", () => {
    // At 1 MB this call would take 51 s. The guard stops it after three 64 KB calls of 200 ms.
    // A wait fits here: load can make it longer, never shorter, so the guard always trips.
    const started = performance.now();
    let largest = 0;
    assert.throws(
      () => {
        assertLinear(
          "hang",
          (size) => "a".repeat(size),
          (text) => {
            largest = Math.max(largest, text.length);
            busy((text.length / SMALL) ** 2 * 200);
          },
        );
      },
      { name: "AssertionError", message: /^hang: 65536 characters project to / },
    );
    assert.equal(largest, SMALL);
    assert.ok(performance.now() - started < 30_000);
  });

  it("times each doubled size and fails at the first step that projects past the ceiling", () => {
    // 64 KB projects to 160 ms at 1 MB and passes; 128 KB projects to 2.4 s and fails.
    let largest = 0;
    assert.throws(
      () => {
        assertLinear(
          "step",
          (size) => "a".repeat(size),
          (text) => {
            largest = Math.max(largest, text.length);
            busy(text.length > SMALL ? 300 : 10);
          },
        );
      },
      { name: "AssertionError", message: /^step: 131072 characters project to / },
    );
    assert.equal(largest, 2 * SMALL);
  });

  it("fails code quadratic in the line length on an input that is one long line", () => {
    // Short lines at both sizes hide it.
    assertLinear(
      "short lines",
      (size) => `${"@".repeat(998)}\n`.repeat(size / 999),
      quadraticInLine,
    );
    const failure = firstFailure(() => {
      assertLinear("one line", (size) => "@".repeat(size), quadraticInLine);
    });
    assert.match(failure ?? "passed", /^AssertionError: one line: /);
  });
});
