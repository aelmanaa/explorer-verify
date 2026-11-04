// The envelope schema that ships with the core package, compiled once with ajv in strict mode
// (JSON Schema 2020-12). The CLI tests check every stdout envelope against it (R-AX-5), and the
// help and version envelopes against the CLI's own schemas, as the package exports them (R-AX-11).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { Ajv2020 } from "ajv/dist/2020.js";

const require = createRequire(import.meta.url);

/** A validator that lists every place where a value breaks the schema in `specifier`. */
function validator(specifier: string): (value: unknown) => string[] {
  const check = new Ajv2020({ strict: true, allErrors: true }).compile(
    JSON.parse(readFileSync(require.resolve(specifier), "utf8")),
  );
  return (value) =>
    check(value)
      ? []
      : (check.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

/** Every place where `value` breaks the envelope schema. Empty when it is valid. */
export const envelopeProblems: (value: unknown) => string[] = validator(
  "explorer-verify/envelope.schema.json",
);

/** Every place where `value` breaks the core's `input.schema.json`. Empty when it is valid. */
export const inputProblems: (value: unknown) => string[] = validator(
  "explorer-verify/input.schema.json",
);

/** Every place where `value` breaks `help.schema.json`. Empty when it is valid. */
export const helpProblems: (value: unknown) => string[] = validator(
  "@explorer-verify/cli/help.schema.json",
);

/** Every place where `value` breaks `version.schema.json`. Empty when it is valid. */
export const versionProblems: (value: unknown) => string[] = validator(
  "@explorer-verify/cli/version.schema.json",
);

/** Parses stdout as exactly one JSON line. Throws when it is anything else. */
export function oneEnvelope(stdout: string): Record<string, unknown> {
  const lines = stdout.split("\n");
  if (lines.length !== 2 || lines[1] !== "") {
    throw new Error(`stdout is not one line: ${JSON.stringify(stdout)}`);
  }
  const parsed: unknown = JSON.parse(lines[0] ?? "");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("stdout is not a JSON object");
  }
  return Object.fromEntries(Object.entries(parsed));
}
