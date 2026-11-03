// Temporary git repositories for the release script tests. Each repository has its own config,
// so the tests never read the caller's git or gpg settings.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

/** The environment for git in a test: no global or system config, a fixed author and date. */
export function gitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    // The caller's environment keeps PATH and, under c8, NODE_V8_COVERAGE for the scripts the
    // tests start; the rest pins git to no user config and a fixed author and date.
    ...process.env,
    HOME: tmpdir(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_AUTHOR_DATE: "2026-11-03T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-11-03T00:00:00Z",
    ...extra,
  };
}

/** Runs git in a repository and returns its trimmed output; throws when git fails. */
export function git(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = gitEnv(),
): string {
  return execFileSync("git", [...args], { cwd, env, encoding: "utf8" }).trim();
}

/** Writes files, relative to `root`, creating folders as needed. */
export function writeFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
}

/** A package manifest. */
export function manifest(name: string, version: string, isPrivate = false): string {
  return `${JSON.stringify({ name, version, ...(isPrivate ? { private: true } : {}) })}\n`;
}

/** Creates a repository with one commit of `files`, and returns its folder. */
export function makeRepo(prefix: string, files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  git(root, ["init", "--quiet", "--initial-branch=main"]);
  commit(root, files, "initial");
  return root;
}

/** Writes `files` and commits them; returns the new commit. */
export function commit(
  root: string,
  files: Readonly<Record<string, string>>,
  message: string,
): string {
  writeFiles(root, files);
  git(root, ["add", "--all"]);
  git(root, ["-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

/** Runs a script with Node in `cwd`. */
export function runScript(
  script: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Removes a temporary folder. */
export function remove(root: string): void {
  rmSync(root, { recursive: true, force: true });
}
