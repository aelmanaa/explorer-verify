import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Inspect the supplied tarball rather than depending on a release-specific filename. */
export function packedPackage(directory, name) {
  const matches = [];
  for (const file of readdirSync(directory).filter((entry) => entry.endsWith(".tgz"))) {
    const path = resolve(join(directory, file));
    const manifest = JSON.parse(
      execFileSync("tar", ["-xOzf", path, "package/package.json"], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
      }),
    );
    if (manifest.name !== name) continue;
    if (typeof manifest.version !== "string") throw new Error(`Missing version for ${name}`);
    const contents = readFileSync(path);
    matches.push({
      path,
      manifest,
      version: manifest.version,
      gitHead: manifest.gitHead ?? null,
      sha256: createHash("sha256").update(contents).digest("hex"),
      integrity: `sha512-${createHash("sha512").update(contents).digest("base64")}`,
    });
  }
  if (matches.length !== 1) throw new Error(`Expected exactly one tarball for ${name}`);
  return matches[0];
}
