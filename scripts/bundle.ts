// Bundles code for a browser with esbuild, the way a dapp's bundler would: ESM, minified, and
// `platform: "browser"`, so an import of a Node built-in fails the build (R-RUN-1). esbuild leaves an
// import it cannot resolve inside try/catch, such as `import("node:crypto")`, in the output without
// an error and marks it external in the metafile; that fails the build here too. The size check
// (scripts/check-size.ts) and the browser smoke test (scripts/browser-smoke.ts) both use it.
import { gzipSync } from "node:zlib";

import { build } from "esbuild";

/** What to bundle: a file, or a module given as text and resolved from a folder. */
export type BundleSource =
  | { readonly entry: string }
  | { readonly contents: string; readonly resolveDir: string };

/**
 * Bundles `source` into one minified ESM file for a browser and returns its text. Rejects with
 * esbuild's messages when a module cannot be resolved, which includes every Node built-in, and
 * when the bundle leaves any import external. Every tsconfig file is ignored.
 *
 * @param source - The entry file, or module text and the folder its imports resolve from.
 * @returns The bundled JavaScript.
 */
export async function bundleForBrowser(source: BundleSource): Promise<string> {
  const input =
    "entry" in source
      ? { entryPoints: [source.entry] }
      : {
          stdin: {
            contents: source.contents,
            resolveDir: source.resolveDir,
            loader: "ts" as const,
            sourcefile: "entry.ts",
          },
        };
  const result = await build({
    ...input,
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    minify: true,
    target: "es2023",
    logLevel: "silent",
    metafile: true,
    // The bundle must not depend on which tsconfig sits next to the entry, such as the `paths`
    // in packages/explorer-verify/tsconfig.test.json.
    tsconfigRaw: "{}",
  });
  const external = new Set(
    Object.values(result.metafile.inputs)
      .flatMap(({ imports }) => imports)
      .filter((imported) => imported.external === true)
      .map(({ path: specifier }) => specifier),
  );
  if (external.size > 0) {
    throw new Error(`the bundle leaves imports unresolved: ${[...external].join(", ")}`);
  }
  // One entry, no CSS and no source map: esbuild writes exactly one file.
  return result.outputFiles.map((file) => file.text).join("");
}

/**
 * The size of `code` in bytes after gzip at level 6, zlib's default, as decision 0008 measures it.
 *
 * @param code - The bundled JavaScript.
 * @returns The gzipped size in bytes.
 */
export function gzipSize(code: string): number {
  return gzipSync(code, { level: 6 }).byteLength;
}
