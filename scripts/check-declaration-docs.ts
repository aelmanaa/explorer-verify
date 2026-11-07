// Checks every built package after pkg:check builds it (#226, R-DX-4).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listFiles } from "./agent-docs.ts";
import { declarationDocProblems } from "./declaration-docs.ts";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ...process.argv.slice(2),
);
const files = readdirSync(path.join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => listFiles(root, `packages/${entry.name}/dist`, ".d.ts"));
const problems = files.flatMap((file) =>
  declarationDocProblems(file, readFileSync(path.join(root, file), "utf8")),
);
if (files.length === 0) problems.push("No built declarations found. Run pnpm run build first.");
if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `declaration docs: ${String(files.length)} files contain no contributor IDs\n`,
  );
}
