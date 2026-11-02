// Fails when a tracked file links to a host on the blocklist. The scaffold once linked a third-party
// GitHub mirror in place of github.com, including in package.json `repository`, which npm
// provenance checks. Hosts are built from parts so this file does not match itself.
//
// Usage: node scripts/check-hosts.ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const BLOCKED_HOSTS: readonly string[] = [["gh", "ali360", "cloudns", "ch"].join(".")];

const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter((file) => file !== "");

const findings: string[] = [];
for (const file of files) {
  let text: string;
  try {
    text = readFileSync(path.join(root, file), "utf8");
  } catch {
    continue;
  }
  text.split("\n").forEach((line, index) => {
    for (const host of BLOCKED_HOSTS) {
      if (line.includes(host)) {
        findings.push(`${file}:${String(index + 1)}: links ${host}; use github.com`);
      }
    }
  });
}

if (findings.length > 0) {
  process.stderr.write(`${findings.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`hosts: ${String(files.length)} files checked, no blocked host\n`);
