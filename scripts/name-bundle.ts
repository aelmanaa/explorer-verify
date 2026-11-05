// Bundles one exported name the way real bundlers ship it (R-RUN-3): esbuild with code splitting,
// esbuild as one file, and Rollup with each chunk minified by esbuild, as Vite builds for
// production. Each build counts the initial load: the entry file and every file it imports
// statically, each gzipped on its own, plus the number of files emitted. scripts/check-names.ts
// runs it for every name; scripts/bundle.ts holds the size-budget.json model.
import { builtinModules } from "node:module";
import path from "node:path";

import { build, transform } from "esbuild";
import type { Metafile } from "esbuild";
import { rollup } from "rollup";
import type { Plugin, RollupCache } from "rollup";

import { gzipSize } from "./bundle.ts";
import { exportTarget } from "./name-size.ts";
import type { Measure, Platform } from "./name-size.ts";

/** One name to measure. */
export interface NameTarget {
  /** The folder of the package that exports the name. */
  readonly packageDir: string;
  /** The package name. */
  readonly packageName: string;
  /** The package's `exports` field, which resolves the specifier in the Rollup build. */
  readonly exports: unknown;
  /** Whether the package declares `"sideEffects": false`. */
  readonly sideEffectFree: boolean;
  /** The specifier, such as `explorer-verify/server`. */
  readonly specifier: string;
  /** The exported name. */
  readonly name: string;
  readonly platform: Platform;
  /**
   * Packages left out of the bundle, such as a peer dependency: the user installs and measures
   * them on their own.
   */
  readonly external: readonly string[];
}

/**
 * The entry module of a build: it re-exports the one name, so the bundler keeps it and drops the
 * rest.
 *
 * @param target - The name.
 * @returns The module text.
 */
export function entryCode(target: Pick<NameTarget, "specifier" | "name">): string {
  return `export { ${target.name} } from ${JSON.stringify(target.specifier)};\n`;
}

/**
 * The entry files and every file they import statically, without duplicates.
 *
 * @param starts - The entry files.
 * @param imports - The files each file imports statically.
 * @returns The files, entries first.
 */
export function staticClosure(
  starts: readonly string[],
  imports: ReadonlyMap<string, readonly string[]>,
): string[] {
  const seen: string[] = [];
  const visit = (file: string): void => {
    if (seen.includes(file)) {
      return;
    }
    seen.push(file);
    for (const next of imports.get(file) ?? []) {
      visit(next);
    }
  };
  for (const start of starts) {
    visit(start);
  }
  return seen;
}

/**
 * Sums a build: the initial files minified and gzipped, and the number of files.
 *
 * @param files - Every JavaScript file of the build, by name.
 * @param initial - The files the entry loads before any call.
 * @returns The measure.
 * @throws Error when an initial file is not in the build.
 */
export function measureFiles(
  files: ReadonlyMap<string, string>,
  initial: readonly string[],
): Measure {
  let minBytes = 0;
  let gzipBytes = 0;
  for (const name of initial) {
    const code = files.get(name);
    if (code === undefined) {
      throw new Error(`the build has no file ${name}`);
    }
    minBytes += Buffer.byteLength(code);
    gzipBytes += gzipSize(code);
  }
  return { minBytes, gzipBytes, files: files.size };
}

function isExternal(target: NameTarget, specifier: string): boolean {
  return target.external.some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

/**
 * Builds the name with esbuild, minified ESM, as a browser or Node build of a user's code would.
 *
 * @param target - The name.
 * @param splitting - Whether to split code at each dynamic `import()`.
 * @returns The measure of the build.
 */
export async function measureEsbuild(target: NameTarget, splitting: boolean): Promise<Measure> {
  const result = await build({
    stdin: {
      contents: entryCode(target),
      resolveDir: target.packageDir,
      sourcefile: "entry.js",
      loader: "js",
    },
    bundle: true,
    splitting,
    minify: true,
    format: "esm",
    platform: target.platform,
    target: "es2023",
    outdir: "out",
    write: false,
    metafile: true,
    logLevel: "silent",
    tsconfigRaw: "{}",
    external: target.external.flatMap((name) => [name, `${name}/*`]),
  });
  const files = new Map<string, string>();
  for (const file of result.outputFiles) {
    if (file.path.endsWith(".js")) {
      files.set(path.relative(path.resolve("out"), file.path).split(path.sep).join("/"), file.text);
    }
  }
  const imports = new Map<string, string[]>();
  const outputs: Metafile["outputs"] = result.metafile.outputs;
  for (const [file, output] of Object.entries(outputs)) {
    imports.set(
      path.posix.relative("out", file),
      output.imports
        .filter(({ kind, external }) => kind === "import-statement" && external !== true)
        .map(({ path: imported }) => path.posix.relative("out", imported)),
    );
  }
  return measureFiles(files, staticClosure(["stdin.js"], imports));
}

const ENTRY_ID = "\0name-entry";

/** Resolves the package's own specifiers through its `exports`, and leaves externals out. */
function resolver(target: NameTarget): Plugin {
  const builtins = new Set(builtinModules);
  return {
    name: "name-resolve",
    resolveId(source) {
      if (source === ENTRY_ID) {
        return ENTRY_ID;
      }
      if (source === target.packageName || source.startsWith(`${target.packageName}/`)) {
        const subpath = `.${source.slice(target.packageName.length)}`;
        const file = exportTarget(Reflect.get(Object(target.exports), subpath));
        if (file === undefined) {
          throw new Error(`${target.packageName} does not export ${subpath}`);
        }
        return path.resolve(target.packageDir, file);
      }
      if (
        isExternal(target, source) ||
        (target.platform === "node" && (source.startsWith("node:") || builtins.has(source)))
      ) {
        return { id: source, external: true };
      }
      if (!source.startsWith(".") && !path.isAbsolute(source)) {
        throw new Error(`cannot resolve ${source} in the Rollup build of ${target.name}`);
      }
      return null;
    },
    load(id) {
      return id === ENTRY_ID ? entryCode(target) : null;
    },
    // A JSON module is its value as the default export, as Vite and @rollup/plugin-json load it.
    transform(code, id) {
      return id.endsWith(".json") ? `export default ${code.trim()};\n` : null;
    },
  };
}

/** A Rollup cache shared by builds of the same package, so each module is parsed once. */
export interface RollupState {
  cache?: RollupCache | undefined;
}

/**
 * Builds the name with Rollup, splitting code at each dynamic `import()`, and minifies each chunk
 * with esbuild, as Vite's production build does. A package with `"sideEffects": false` has its
 * modules treated as free of side effects, as Vite's resolver does.
 *
 * @param target - The name.
 * @param state - The cache to reuse and update.
 * @returns The measure of the build.
 */
export async function measureRollup(target: NameTarget, state: RollupState = {}): Promise<Measure> {
  const packageDir = `${path.resolve(target.packageDir)}${path.sep}`;
  const bundle = await rollup({
    input: ENTRY_ID,
    plugins: [resolver(target)],
    ...(state.cache === undefined ? {} : { cache: state.cache }),
    treeshake: {
      moduleSideEffects: (id, external) =>
        external || !(target.sideEffectFree && id.startsWith(packageDir)),
    },
    // Circular imports and similar notes are not size findings.
    logLevel: "silent",
  });
  state.cache = bundle.cache;
  const { output } = await bundle.generate({ format: "es" });
  await bundle.close();
  const chunks = output.flatMap((item) => (item.type === "chunk" ? [item] : []));
  const names = new Set(chunks.map(({ fileName }) => fileName));
  const files = new Map<string, string>();
  const imports = new Map<string, readonly string[]>();
  for (const chunk of chunks) {
    const minified = await transform(chunk.code, {
      loader: "js",
      minify: true,
      format: "esm",
      target: "es2023",
    });
    files.set(chunk.fileName, minified.code);
    // External packages are in `imports` too; they are not files of this build.
    imports.set(
      chunk.fileName,
      chunk.imports.filter((name) => names.has(name)),
    );
  }
  const entries = chunks.filter(({ isEntry }) => isEntry).map(({ fileName }) => fileName);
  return measureFiles(files, staticClosure(entries, imports));
}
