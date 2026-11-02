// Checks the agent docs (requirements R-AX-1 to R-AX-3): `llms.txt`, the head of each user page
// (version line and `llms.txt` link), the agent page, and the relative links under `docs/`. The
// rules are in scripts/agent-docs.ts. It also checks that decision records link their research and
// that research notes cite their sources (scripts/decision-sources.ts). `pnpm run check` runs it.
//
// With `--write-versions`, it sets the version line of every user page to the version of the core
// package instead; `pnpm run version-packages` runs that after `changeset version`. A path
// argument names another repository root, which the tests use.
//
// Usage: node scripts/check-agent-docs.ts [--write-versions] [root]
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkAgentDocs, listFiles, USER_DOCS, writeVersions } from "./agent-docs.ts";
import { checkDecisionSources, DECISIONS, RESEARCH } from "./decision-sources.ts";

const args = process.argv.slice(2);
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ...args.filter((arg) => !arg.startsWith("--")),
);

if (args.includes("--write-versions")) {
  const changed = writeVersions(root);
  process.stdout.write(`agent docs: version line updated in ${changed.length} pages\n`);
} else {
  const problems = [...checkAgentDocs(root), ...checkDecisionSources(root)];
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exit(1);
  }
  const pages = listFiles(root, USER_DOCS, ".md").length;
  const docs = listFiles(root, "docs", ".md").length;
  const decisions = listFiles(root, DECISIONS, ".md").length;
  const research = listFiles(root, RESEARCH, ".md").length;
  process.stdout.write(
    `agent docs: llms.txt, ${pages} user pages and the links of ${docs} docs pages pass\n` +
      `sources: ${decisions} decision pages and ${research} research pages pass\n`,
  );
}
