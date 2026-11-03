// Adds each error code of the catalogue that is not listed yet to
// packages/explorer-verify/released-error-codes.json, with the package version, in catalogue
// order (R-AX-10, decision 0015). `pnpm run version-packages` runs it after `changeset version`,
// so the version pull request records every code the release ships. It reads ERROR_CODES from the
// package sources. A path argument names another repository root, which the tests use.
//
// Usage: node scripts/record-released-codes.ts [root]
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { errorCodesOf, packageVersion } from "./agent-docs.ts";
import {
  CORE_SOURCE,
  formatReleased,
  parseReleased,
  recordReleased,
  RELEASED_CODES,
  unreleasedCodes,
} from "./released-codes.ts";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ...process.argv.slice(2),
);
const core: unknown = await import(pathToFileURL(path.join(root, CORE_SOURCE)).href);
const codes = errorCodesOf(core, CORE_SOURCE);
const file = path.join(root, RELEASED_CODES);
const released = parseReleased(readFileSync(file, "utf8"));
const added = unreleasedCodes(released, codes);
writeFileSync(file, formatReleased(recordReleased(released, codes, packageVersion(root))));
process.stdout.write(
  `released codes: added ${added.length} codes to ${RELEASED_CODES}${added.length > 0 ? `: ${added.join(", ")}` : ""}\n`,
);
