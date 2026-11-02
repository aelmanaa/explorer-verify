// A small JSON Schema (draft 2020-12) validator for the tests, so the package needs no validation
// dependency. It knows only the keywords listed in KEYWORDS and throws on any other, so a schema
// cannot use a keyword these tests would silently ignore.

const ANNOTATIONS = new Set(["$schema", "$id", "$comment", "title", "description"]);
const KEYWORDS = new Set([
  ...ANNOTATIONS,
  "$defs",
  "$ref",
  "type",
  "const",
  "enum",
  "properties",
  "required",
  "oneOf",
  "not",
  "minLength",
  "pattern",
]);

/** The fields of a JSON object, or `undefined` for any other value. */
export function objectOf(value: unknown): Map<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? new Map<string, unknown>(Object.entries(value))
    : undefined;
}

function typeOf(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return "integer";
  }
  return typeof value;
}

function matchesType(value: unknown, type: unknown): boolean {
  const actual = typeOf(value);
  return actual === type || (type === "number" && actual === "integer");
}

/** Deep equality of two JSON values. */
function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Every place where `value` breaks `schema`, as `path: problem` lines. Empty when it is valid.
 * `root` resolves `$ref`s of the form `#/$defs/<name>`.
 */
export function validate(
  schema: unknown,
  value: unknown,
  root: unknown = schema,
  path: string = "$",
): string[] {
  const keywords = objectOf(schema);
  if (keywords === undefined) {
    throw new Error(`${path}: a schema must be an object`);
  }
  const problems: string[] = [];
  for (const [keyword, argument] of keywords) {
    if (!KEYWORDS.has(keyword)) {
      throw new Error(`${path}: the test validator does not know the keyword ${keyword}`);
    }
    problems.push(...check(keyword, argument, value, root, path));
  }
  return problems;
}

function check(
  keyword: string,
  argument: unknown,
  value: unknown,
  root: unknown,
  path: string,
): string[] {
  switch (keyword) {
    case "$ref": {
      const name = typeof argument === "string" ? argument.replace("#/$defs/", "") : "";
      const target = objectOf(objectOf(root)?.get("$defs"))?.get(name);
      if (target === undefined) {
        throw new Error(`${path}: unresolved $ref ${String(argument)}`);
      }
      return validate(target, value, root, path);
    }
    case "type":
      return matchesType(value, argument) ? [] : [`${path}: is not of type ${String(argument)}`];
    case "const":
      return sameJson(value, argument) ? [] : [`${path}: is not ${JSON.stringify(argument)}`];
    case "enum":
      return Array.isArray(argument) && argument.some((item) => sameJson(value, item))
        ? []
        : [`${path}: is not one of the enum values`];
    case "required": {
      const fields = objectOf(value);
      if (fields === undefined || !Array.isArray(argument)) {
        return [];
      }
      return argument
        .filter((name) => typeof name === "string" && !fields.has(name))
        .map((name) => `${path}: lacks ${String(name)}`);
    }
    case "properties": {
      const fields = objectOf(value);
      const properties = objectOf(argument);
      if (fields === undefined || properties === undefined) {
        return [];
      }
      return [...properties].flatMap(([name, subschema]) =>
        fields.has(name) ? validate(subschema, fields.get(name), root, `${path}.${name}`) : [],
      );
    }
    case "oneOf": {
      if (!Array.isArray(argument)) {
        throw new Error(`${path}: oneOf must be an array`);
      }
      const passing = argument.filter((option) => validate(option, value, root, path).length === 0);
      return passing.length === 1
        ? []
        : [`${path}: matches ${String(passing.length)} of the oneOf schemas, not exactly 1`];
    }
    case "not":
      return validate(argument, value, root, path).length === 0
        ? [`${path}: matches a schema it must not match`]
        : [];
    case "minLength":
      return typeof value !== "string" || value.length >= Number(argument)
        ? []
        : [`${path}: is shorter than ${String(argument)}`];
    case "pattern":
      return typeof value !== "string" || new RegExp(String(argument), "u").test(value)
        ? []
        : [`${path}: does not match ${String(argument)}`];
    default:
      return [];
  }
}
