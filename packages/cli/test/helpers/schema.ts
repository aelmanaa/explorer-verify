// The envelope schema that ships with the core package, compiled once with ajv in strict mode
// (JSON Schema 2020-12). The CLI tests check every stdout envelope against it (R-AX-5).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { Ajv2020 } from "ajv/dist/2020.js";

const require = createRequire(import.meta.url);
const schemaPath = require.resolve("explorer-verify/envelope.schema.json");
const check = new Ajv2020({ strict: true, allErrors: true }).compile(
  JSON.parse(readFileSync(schemaPath, "utf8")),
);

/** Every place where `value` breaks the envelope schema. Empty when it is valid. */
export function envelopeProblems(value: unknown): string[] {
  return check(value)
    ? []
    : (check.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

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
