/**
 * Preloaded with `node --import` into each run of a skill example (see `skill.ts`).
 *
 * It replaces `globalThis.fetch` with a fake that answers from the recorded Sourcify fixtures
 * named in the `SKILL_FIXTURES` environment variable, in order. A name with a backend folder in
 * front, such as `etherscan/<name>`, answers from that backend's fixtures. A name that ends in `*` answers
 * every request that matches its recording, and the next request that does not match moves on to
 * the next name. The run fails, with exit code 1 and a message on stderr, when a request differs
 * from its recording in method or URL (a `nocache` query parameter, which the Routescan client
 * makes unique on every request, is left out of the comparison), when a request is sent without `redirect: "manual"`, when a
 * request comes after the last fixture, or when a fixture is left unused.
 *
 * It also speeds up long waits, so the examples run as users copy them, with their real poll
 * interval and time budget, in milliseconds. A `setTimeout` of 1000 ms or more fires after a few
 * milliseconds, and when it fires the clock (`Date.now`) jumps forward to the time it was due.
 * The library measures its budget with `Date.now`, so it sees the time it waited, and a run that
 * polls a pending job until the budget ends takes well under a second. Shorter waits, such as the
 * response race inside a request, keep their real length.
 */
import { loadFixture, responseOf } from "./fake-fetch.ts";
import type { Fixture } from "./fake-fetch.ts";

/** Waits at or above this many milliseconds are sped up. */
const LONG_WAIT_MS = 1000;

const realNow = Date.now.bind(Date);
const realSetTimeout = globalThis.setTimeout;
let skipped = 0;
Date.now = (): number => realNow() + skipped;
Reflect.set(
  globalThis,
  "setTimeout",
  (handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const wait = ms ?? 0;
    if (wait < LONG_WAIT_MS) {
      return realSetTimeout(handler, ms, ...args);
    }
    const due = Date.now() + wait;
    // A longer wait still fires later than a shorter one set at the same time.
    return realSetTimeout(
      () => {
        skipped += Math.max(0, due - Date.now());
        handler(...args);
      },
      2 + wait / 1000,
    );
  },
);

const names: unknown = JSON.parse(process.env.SKILL_FIXTURES ?? "[]");
const steps: { fixture: Fixture; repeat: boolean }[] = Array.isArray(names)
  ? names.map((name: unknown) => {
      const text = String(name);
      const repeat = text.endsWith("*");
      const [backend, file] = text.includes("/") ? text.split("/", 2) : ["sourcify", text];
      const fixture = String(file);
      return {
        fixture: loadFixture(String(backend), repeat ? fixture.slice(0, -1) : fixture),
        repeat,
      };
    })
  : [];
const problems: string[] = [];
let next = 0;
let requests = 0;
let answered = false;

/**
 * `url` without its `nocache` query parameter, lower-cased. A URL that does not parse is compared
 * as it is, so a bad fixture fails with the mismatch message below, not a TypeError.
 */
const comparable = (url: string): string => {
  if (!URL.canParse(url)) {
    return url.toLowerCase();
  }
  const parsed = new URL(url);
  parsed.searchParams.delete("nocache");
  return parsed.href.toLowerCase();
};

const matches = (fixture: Fixture, method: string, url: string): boolean =>
  method === fixture.request.method && comparable(url) === comparable(fixture.request.url);

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? "GET";
  requests += 1;
  let step = steps[next];
  // A repeating step that answered at least once gives way to the next one on a request it does
  // not match.
  if (step?.repeat === true && answered && !matches(step.fixture, method, url)) {
    next += 1;
    answered = false;
    step = steps[next];
  }
  let problem: string | undefined;
  if (step === undefined) {
    problem = `unexpected request ${String(requests)}: ${method} ${url}`;
  } else if (init?.redirect !== "manual") {
    problem = `${method} ${url} was sent without redirect: "manual"`;
  } else if (!matches(step.fixture, method, url)) {
    problem = `request ${String(requests)} is ${method} ${url}, but the fixture recorded ${step.fixture.request.method} ${step.fixture.request.url}`;
  }
  if (step === undefined || problem !== undefined) {
    const message = problem ?? "no fixture";
    problems.push(message);
    throw new Error(`fake fetch: ${message}`);
  }
  if (step.repeat) {
    answered = true;
  } else {
    next += 1;
  }
  return await Promise.resolve(responseOf(step.fixture));
};

process.on("exit", () => {
  const left = steps.length - next - (answered ? 1 : 0);
  if (left > 0) {
    problems.push(`${String(left)} fixtures left unused`);
  }
  if (problems.length > 0) {
    process.stderr.write(`fake fetch: ${problems.join("; ")}\n`);
    process.exitCode = 1;
  }
});
