// The shipped envelope schema, compiled once with ajv in strict mode (JSON Schema 2020-12). Strict
// mode refuses an unknown keyword or a keyword that would be ignored, so the schema means what it
// says to every validator. Shared by the envelope tests.
import { readFileSync } from "node:fs";

import { Ajv2020 } from "ajv/dist/2020.js";

const SCHEMA_URL = new URL("../../schema/envelope.schema.json", import.meta.url);

/** The schema as parsed JSON. */
export const envelopeSchema: unknown = JSON.parse(readFileSync(SCHEMA_URL, "utf8"));

/** A fresh strict ajv instance, as a reader of the schema would set it up. */
function strictAjv(): Ajv2020 {
  return new Ajv2020({ strict: true, allErrors: true });
}

/** Compiles `schema` in strict mode. Throws when strict mode refuses it. */
export function compileStrict(schema: unknown): (value: unknown) => string[] {
  if (typeof schema !== "object" || schema === null) {
    throw new TypeError("a schema must be an object");
  }
  const check = strictAjv().compile(schema);
  return (value) =>
    check(value)
      ? []
      : (check.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

/** Every place where `value` breaks the shipped schema. Empty when it is valid. */
export const validateEnvelope: (value: unknown) => string[] = compileStrict(envelopeSchema);

/** The fields of a JSON object, or `undefined` for any other value. */
export function objectOf(value: unknown): Map<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? new Map<string, unknown>(Object.entries(value))
    : undefined;
}
