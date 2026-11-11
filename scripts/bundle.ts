// Bundles code for a browser with esbuild, the way a dapp's bundler would: ESM, minified, and
// `platform: "browser"`, so an import of a Node built-in fails the build (R-RUN-1). esbuild leaves an
// import it cannot resolve inside try/catch, such as `import("node:crypto")`, in the output without
// an error and marks it external in the metafile; that fails the build here too.
//
// `bundleForBrowser` writes one file: esbuild inlines each dynamic `import()`. `bundleChunks` splits
// code as Rollup, Vite and webpack do by default: each dynamic `import()` gets its own chunk, and code
// two chunks share moves to a shared chunk (decision 0031). The size check (scripts/check-size.ts)
// and the browser smoke test (scripts/browser-smoke.ts) use `bundleChunks`.
import { realpathSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { build } from "esbuild";
import type { BuildOptions, Metafile, OutputFile, Plugin, PluginBuild } from "esbuild";

/** The routing table as the code entries of the size check see it: no rows (R-RUN-3). */
export const EMPTY_TABLE = '{"schemaVersion":3,"checked":"","chains":[]}';

/** How to bundle. */
export interface BundleOptions {
  /**
   * Replace every `routing/table.json` with {@link EMPTY_TABLE}, so the size of the code is
   * measured apart from the size of the routing table's data (R-RUN-3).
   */
  readonly withoutTable?: boolean;
}

/** What to bundle: a file, or a module given as text and resolved from a folder. */
export type BundleSource =
  | { readonly entry: string }
  | { readonly contents: string; readonly resolveDir: string };

/** The folder name esbuild writes into. Nothing is written to disk: paths only. */
const OUT_DIR = "out";
/** The namespace of the module given as text: esbuild splits code only for entry points. */
const TEXT_ENTRY = "explorer-verify-entry";

function buildOptions(
  source: BundleSource,
  options: BundleOptions,
  extra: readonly Plugin[] = [],
  splitting = false,
): BuildOptions & { metafile: true; write: false } {
  const input: BuildOptions =
    "entry" in source
      ? { entryPoints: { entry: source.entry } }
      : { entryPoints: { entry: TEXT_ENTRY } };
  return {
    ...input,
    bundle: true,
    splitting,
    write: false,
    platform: "browser",
    format: "esm",
    minify: true,
    target: "es2023",
    logLevel: "silent",
    metafile: true,
    outdir: OUT_DIR,
    // The bundle must not depend on which tsconfig sits next to the entry, such as the `paths`
    // in packages/explorer-verify/tsconfig.test.json.
    tsconfigRaw: "{}",
    plugins: [
      {
        name: "text-entry",
        setup(plugin) {
          if ("entry" in source) {
            return;
          }
          plugin.onResolve({ filter: new RegExp(`^${TEXT_ENTRY}$`) }, () => ({
            path: "entry.ts",
            namespace: TEXT_ENTRY,
          }));
          plugin.onLoad({ filter: /.*/, namespace: TEXT_ENTRY }, () => ({
            contents: source.contents,
            resolveDir: source.resolveDir,
            loader: "ts",
          }));
        },
      },
      ...(options.withoutTable === true
        ? [
            {
              name: "without-table",
              setup(plugin: PluginBuild) {
                plugin.onLoad({ filter: /[\\/]routing[\\/]table\.json$/ }, () => ({
                  contents: EMPTY_TABLE,
                  loader: "json",
                }));
              },
            },
          ]
        : []),
      ...extra,
    ],
  };
}

/**
 * Throws when any input leaves an import external that is not in `allowed`: esbuild could not
 * resolve it.
 */
function checkResolved(metafile: Metafile, allowed: ReadonlySet<string> = new Set()): void {
  const external = new Set(
    Object.values(metafile.inputs)
      .flatMap(({ imports }) => imports)
      .filter((imported) => imported.external === true && !allowed.has(imported.path))
      .map(({ path: specifier }) => specifier),
  );
  if (external.size > 0) {
    throw new Error(`the bundle leaves imports unresolved: ${[...external].join(", ")}`);
  }
}

/** The JavaScript files of a build, by their path below the output folder. */
function javascript(outputFiles: readonly OutputFile[]): Map<string, string> {
  const files = new Map<string, string>();
  for (const file of outputFiles) {
    const name = path.relative(path.resolve(OUT_DIR), file.path).split(path.sep).join("/");
    if (name.endsWith(".js")) {
      files.set(name, file.text);
    }
  }
  return files;
}

/**
 * Bundles `source` into one minified ESM file for a browser and returns its text. Each dynamic
 * `import()` is inlined. Rejects with esbuild's messages when a module cannot be resolved, which
 * includes every Node built-in, and when the bundle leaves any import external. Every tsconfig file
 * is ignored.
 *
 * @param source - The entry file, or module text and the folder its imports resolve from.
 * @param options - Whether to leave the routing table's rows out.
 * @returns The bundled JavaScript.
 */
export async function bundleForBrowser(
  source: BundleSource,
  options: BundleOptions = {},
): Promise<string> {
  const result = await build(buildOptions(source, options));
  checkResolved(result.metafile);
  // One entry, no splitting, no CSS and no source map: esbuild writes exactly one file.
  return [...javascript(result.outputFiles).values()].join("");
}

/** A bundle split into chunks, as a page loads it. */
export interface Chunks {
  /** Every file, by its path below the output folder, such as `entry.js` or `chunk-AB12CD34.js`. */
  readonly files: ReadonlyMap<string, string>;
  /** The entry file, `entry.js`. */
  readonly entry: string;
  /** The files a page loads to run the entry: the entry and the chunks it imports statically. */
  readonly entryFiles: readonly string[];
  /**
   * Each module that the code loads with a dynamic `import()`, by its file name without the
   * extension, such as `sourcify`: the files that loading it adds to `entryFiles`. Its own chunk
   * comes first.
   */
  readonly dynamic: ReadonlyMap<string, readonly string[]>;
}

/** The output file and every file it imports statically, in load order, without duplicates. */
function staticClosure(start: string, outputs: Metafile["outputs"]): string[] {
  const seen: string[] = [];
  const visit = (file: string): void => {
    if (seen.includes(file)) {
      return;
    }
    seen.push(file);
    for (const imported of outputs[file]?.imports ?? []) {
      if (imported.kind === "import-statement") {
        visit(imported.path);
      }
    }
  };
  visit(start);
  return seen;
}

/**
 * Bundles `source` for a browser with code splitting (decision 0031): each dynamic `import()` gets
 * its own chunk, and code that two chunks share moves to a shared chunk. Rejects as
 * {@link bundleForBrowser} does.
 *
 * @param source - The entry file, or module text and the folder its imports resolve from.
 * @param options - Whether to leave the routing table's rows out.
 * @returns The files, which of them the entry loads, and which each dynamic import adds.
 */
export async function bundleChunks(
  source: BundleSource,
  options: BundleOptions = {},
): Promise<Chunks> {
  const result = await build(buildOptions(source, options, [], true));
  checkResolved(result.metafile);
  const { outputs } = result.metafile;
  const relative = (file: string): string => path.posix.relative(OUT_DIR, file);
  const entryOutput = `${OUT_DIR}/entry.js`;
  const entryFiles = staticClosure(entryOutput, outputs);
  const dynamic = new Map<string, readonly string[]>();
  for (const [file, output] of Object.entries(outputs)) {
    if (file === entryOutput || output.entryPoint === undefined || !file.endsWith(".js")) {
      continue;
    }
    const name = path.basename(output.entryPoint).replace(/\.[cm]?[jt]s$/, "");
    if (dynamic.has(name)) {
      throw new Error(`two dynamically imported modules are named ${name}`);
    }
    const added = staticClosure(file, outputs).filter((chunk) => !entryFiles.includes(chunk));
    dynamic.set(name, added.map(relative));
  }
  return {
    files: javascript(result.outputFiles),
    entry: relative(entryOutput),
    entryFiles: entryFiles.map(relative),
    dynamic,
  };
}

/** An entry measured apart from the modules it loads with a dynamic `import()`. */
export interface Apart {
  /** The entry as one file, without the code behind its dynamic imports. */
  readonly entry: string;
  /**
   * Each module the entry's output loads with a dynamic `import()`, by its file name without the
   * extension, such as `sourcify`: that module and what it imports, as one file, without any
   * module the entry already holds.
   */
  readonly chunks: ReadonlyMap<string, string>;
}

/** Marker of the plugin's own `resolve` call, so it does not handle that call again. */
const OWN_RESOLVE = Symbol("own resolve");

/**
 * The specifier an external import gets in the measured code: the file's path relative to `root`,
 * with `/` separators, such as `./dist/src/error-hints.js`. esbuild writes it into the output as
 * given, so an absolute path would make the size depend on where the repository is checked out
 * (R-RUN-3). A browser bundler replaces the specifier with a chunk file name anyway.
 *
 * @param root - The folder the specifier is relative to.
 * @param file - The absolute path of the file.
 * @returns The specifier.
 */
export function externalSpecifier(root: string, file: string): string {
  const relative = path.relative(root, file).split(path.sep).join("/");
  return relative.startsWith("../") ? relative : `./${relative}`;
}

/**
 * Leaves each dynamic `import()` that resolves external under {@link externalSpecifier}, and
 * records the absolute path of the file by that specifier.
 */
function dynamicExternal(root: string, found: Map<string, string>): Plugin {
  return {
    name: "dynamic-external",
    setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, async (args) => {
        if (args.kind !== "dynamic-import" || args.pluginData === OWN_RESOLVE) {
          return undefined;
        }
        const resolved = await plugin.resolve(args.path, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
          pluginData: OWN_RESOLVE,
        });
        // An import that does not resolve, such as a Node built-in, stays as esbuild leaves it,
        // and the check for unresolved imports fails the build.
        if (resolved.errors.length > 0 || resolved.external) {
          return undefined;
        }
        const specifier = externalSpecifier(root, resolved.path);
        found.set(specifier, resolved.path);
        return { path: specifier, external: true };
      });
    },
  };
}

/**
 * Leaves every import of a file in `held` external under {@link externalSpecifier}: the page
 * already holds it.
 */
function heldExternal(root: string, held: ReadonlySet<string>): Plugin {
  return {
    name: "held-external",
    setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData === OWN_RESOLVE || args.kind === "entry-point") {
          return undefined;
        }
        const resolved = await plugin.resolve(args.path, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
          pluginData: OWN_RESOLVE,
        });
        return held.has(resolved.path)
          ? { path: externalSpecifier(root, resolved.path), external: true }
          : undefined;
      });
    },
  };
}

/** The absolute paths of the files a build includes. */
function inputsOf(metafile: Metafile): Set<string> {
  return new Set(Object.keys(metafile.inputs).map((input) => path.resolve(input)));
}

/**
 * Bundles `source` as {@link bundleForBrowser} does, but measures the code behind each dynamic
 * `import()` apart (decision 0031). The entry is one file in which each dynamic import stays an
 * import. Each module it loads that way is then bundled on its own, with every module the entry
 * holds left out: what loading it adds to a page that runs the entry. A dynamic import that
 * tree-shaking removes from the entry's output is not counted. Rejects as `bundleForBrowser` does,
 * when a dynamically loaded module itself uses a dynamic `import()`, and when the entry also
 * imports a dynamically loaded module statically.
 *
 * @param source - The entry file, or module text and the folder its imports resolve from.
 * @param options - Whether to leave the routing table's rows out.
 * @returns The entry's code and the code of each module it loads with a dynamic `import()`.
 */
export async function bundleApart(
  source: BundleSource,
  options: BundleOptions = {},
): Promise<Apart> {
  // esbuild resolves symbolic links, so the root is resolved too.
  const root = realpathSync(
    "entry" in source ? path.dirname(path.resolve(source.entry)) : source.resolveDir,
  );
  // Each dynamically imported file, by the specifier the entry's output imports it with.
  const found = new Map<string, string>();
  const result = await build(buildOptions(source, options, [dynamicExternal(root, found)]));
  checkResolved(result.metafile, new Set(found.keys()));
  // Only the dynamic imports left in the output: tree-shaking drops those in unused code.
  const loaded = Object.values(result.metafile.outputs)
    .flatMap(({ imports }) => imports)
    .filter((imported) => imported.kind === "dynamic-import")
    .flatMap((imported) => found.get(imported.path) ?? []);
  const held = inputsOf(result.metafile);
  const heldSpecifiers = new Set([...held].map((file) => externalSpecifier(root, file)));
  // A module the entry also imports statically is in the entry already: its import() splits
  // nothing off, and measuring it apart would hide that.
  const both = [...found.values()]
    .filter((file) => held.has(file))
    .map((file) => path.basename(file));
  if (both.length > 0) {
    throw new Error(
      `the entry imports ${both.join(", ")} statically as well as with import(), so no chunk is split off`,
    );
  }
  const chunks = new Map<string, string>();
  for (const file of [...new Set(loaded)].toSorted()) {
    const name = path.basename(file).replace(/\.[cm]?[jt]s$/, "");
    if (chunks.has(name)) {
      throw new Error(`two dynamically imported modules are named ${name}`);
    }
    const nested = new Map<string, string>();
    const chunk = await build(
      buildOptions({ entry: file }, options, [
        dynamicExternal(root, nested),
        heldExternal(root, held),
      ]),
    );
    if (nested.size > 0) {
      throw new Error(`${name} loads more modules with a dynamic import(), which is not measured`);
    }
    checkResolved(chunk.metafile, heldSpecifiers);
    chunks.set(name, [...javascript(chunk.outputFiles).values()].join(""));
  }
  return { entry: [...javascript(result.outputFiles).values()].join(""), chunks };
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

/**
 * The gzipped size of several files, each compressed on its own as a server sends it.
 *
 * @param bundle - The split bundle.
 * @param names - The files to count, by their path in `bundle.files`.
 * @returns The sum of their gzipped sizes, in bytes.
 * @throws Error when a file is not in the bundle.
 */
export function filesSize(bundle: Chunks, names: readonly string[]): number {
  let total = 0;
  for (const name of names) {
    const text = bundle.files.get(name);
    if (text === undefined) {
      throw new Error(`the bundle has no file ${name}`);
    }
    total += gzipSize(text);
  }
  return total;
}
