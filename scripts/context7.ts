// The rules for `context7.json` at the repository root, which tells Context7 which folders to index
// (requirement R-AX-1, issue #368). scripts/test/context7.test.ts applies them to the real file.
//
// The rules:
// - The file is a JSON object whose keys are all fields of the Context7 schema
//   (https://context7.com/schema/context7.json, read 2026-11-12). Context7 skips unknown fields,
//   so a misspelled key would go unnoticed.
// - `folders` is a non-empty list of folders that exist, and none of them is or sits under
//   `docs/contributor`.
// - `excludeFolders` lists `docs/contributor`.
// - Each rule is a non-empty string of at most 255 characters. Context7 drops every rule when one
//   is rejected.
// - `description` is the core package's `description`.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** The config file, relative to the repository root. */
export const CONTEXT7_FILE = "context7.json";

/** The folder Context7 must never index. */
export const CONTRIBUTOR_DOCS = "docs/contributor";

/** The top-level fields of the Context7 schema, read 2026-11-12. */
export const SCHEMA_FIELDS: readonly string[] = [
  "$schema",
  "projectTitle",
  "description",
  "branch",
  "folders",
  "excludeFolders",
  "excludeFiles",
  "includeExtensions",
  "rules",
  "disallow",
  "redirect",
  "previousVersions",
  "url",
  "public_key",
];

/** The longest rule the schema accepts. */
export const MAX_RULE_LENGTH = 255;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function underContributorDocs(folder: string): boolean {
  const normal = path.posix.normalize(folder).replace(/\/+$/, "");
  return normal === CONTRIBUTOR_DOCS || normal.startsWith(`${CONTRIBUTOR_DOCS}/`);
}

/**
 * The problems with a `context7.json` text. `isFolder` says whether a repository path is a folder,
 * and `coreDescription` is the core package's `description`.
 */
export function checkContext7(
  text: string,
  isFolder: (folder: string) => boolean,
  coreDescription: string,
): string[] {
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    return [`${CONTEXT7_FILE}: not valid JSON`];
  }
  if (!isRecord(config)) {
    return [`${CONTEXT7_FILE}: not a JSON object`];
  }
  const problems: string[] = [];
  for (const key of Object.keys(config)) {
    if (!SCHEMA_FIELDS.includes(key)) {
      problems.push(`${CONTEXT7_FILE}: "${key}" is not a field of the Context7 schema`);
    }
  }

  const folders = stringList(config.folders);
  if (folders === undefined || folders.length === 0) {
    problems.push(`${CONTEXT7_FILE}: "folders" must list at least one folder`);
  } else {
    for (const folder of folders) {
      if (underContributorDocs(folder)) {
        problems.push(`${CONTEXT7_FILE}: "folders" must not include ${folder}`);
      } else if (!isFolder(folder)) {
        problems.push(`${CONTEXT7_FILE}: "folders" names ${folder}, which is not a folder`);
      }
    }
  }

  const excluded = stringList(config.excludeFolders) ?? [];
  if (!excluded.some((folder) => path.posix.normalize(folder) === CONTRIBUTOR_DOCS)) {
    problems.push(`${CONTEXT7_FILE}: "excludeFolders" must list ${CONTRIBUTOR_DOCS}`);
  }

  if (config.rules !== undefined) {
    const rules = stringList(config.rules);
    if (rules === undefined) {
      problems.push(`${CONTEXT7_FILE}: "rules" must be a list of strings`);
    } else {
      rules.forEach((rule, index) => {
        if (rule.trim() === "" || rule.length > MAX_RULE_LENGTH) {
          problems.push(
            `${CONTEXT7_FILE}: rule ${String(index + 1)} must be 1 to ${String(MAX_RULE_LENGTH)} characters`,
          );
        }
      });
    }
  }

  if (config.description !== coreDescription) {
    problems.push(
      `${CONTEXT7_FILE}: "description" must match the description in packages/explorer-verify/package.json`,
    );
  }
  return problems;
}

/** The problems with `context7.json` in the repository at `root`. */
export function checkContext7File(root: string): string[] {
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(root, "packages/explorer-verify/package.json"), "utf8"),
  );
  const description =
    isRecord(manifest) && typeof manifest.description === "string" ? manifest.description : "";
  const isFolder = (folder: string): boolean => {
    const full = path.join(root, folder);
    return existsSync(full) && statSync(full).isDirectory();
  };
  return checkContext7(readFileSync(path.join(root, CONTEXT7_FILE), "utf8"), isFolder, description);
}
