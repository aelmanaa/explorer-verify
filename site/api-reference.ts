// Generates the API reference of the docs site from TSDoc (R-AX-2, decision 0015): TypeDoc with
// typedoc-plugin-markdown writes one Markdown page per package entry point into `site/api/`, and
// VitePress builds it with the user docs. `pnpm run site:build` runs it first. The pages are build
// output: they are gitignored, never written to `docs/user/`, and never packed.
//
// TypeDoc reads the TypeScript 6 API. This file sits in the `site` workspace package, whose
// `typescript` is the compatibility package `@typescript/typescript6`; TypeScript 7 stays the type
// checker of the repository.
//
// It fails, before writing anything, on any TypeDoc warning: an export without TSDoc, an
// unresolved `{@link}`, or a type the API uses but no entry point exports. The source links point
// at the version's tag, `v<version>`, as the rest of the site does, and git is never read, so the
// same sources give the same pages on any checkout. A path argument names another output folder,
// which the CI determinism check uses.
//
// Usage: node site/api-reference.ts [outDir]
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Application, ReflectionKind } from "typedoc";
import type { Reflection, TypeDocOptions } from "typedoc";
import { ModuleRouter } from "typedoc-plugin-markdown";
import type { PluginOptions } from "typedoc-plugin-markdown";

import { packageVersion } from "../scripts/agent-docs.ts";
import {
  API_OUT,
  API_TITLE,
  apiEntryPoints,
  apiPageName,
  apiProblems,
} from "../scripts/site-api.ts";
import { GITHUB_BLOB } from "../scripts/site-docs.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.resolve(root, process.argv[2] ?? API_OUT);
const entryPoints = apiEntryPoints(root);
const packageNames = [...new Set(entryPoints.map(({ packageName }) => packageName))];

/** The router this script registers, next to the plugin's own. */
const ROUTER = "explorer-verify-modules";

/**
 * The plugin's module router, one page per entry point, with flat page names: the module router
 * would write `explorer-verify/server.md` next to `explorer-verify.md`, and a link to
 * `api/explorer-verify` would then reach the folder, not the page.
 */
class FlatModuleRouter extends ModuleRouter {
  override getIdealBaseName(reflection: Reflection): string {
    return reflection.kind === ReflectionKind.Module
      ? apiPageName(reflection.name)
      : super.getIdealBaseName(reflection);
  }
}

const options: TypeDocOptions & Partial<PluginOptions> = {
  name: API_TITLE,
  entryPoints: entryPoints.map(({ source }) => path.join(root, source)),
  tsconfig: path.join(root, "site/tsconfig.api.json"),
  plugin: [fileURLToPath(import.meta.resolve("typedoc-plugin-markdown"))],
  readme: "none",
  // Source links: the version's tag, paths from the repository root, and no git lookup.
  disableGit: true,
  gitRevision: `v${packageVersion(root)}`,
  sourceLinkTemplate: `${GITHUB_BLOB}{gitRevision}/{path}#L{line}`,
  displayBasePath: root,
  validation: { invalidLink: true, notExported: true, notDocumented: true },
  // TypeDoc checks the TSDoc of the root package only, unless this lists the packages.
  packagesRequiringDocumentation: packageNames,
  treatWarningsAsErrors: true,
  // typedoc-plugin-markdown: one page per entry point, named by `apiPageName`, and `index.md`.
  router: ROUTER,
  entryFileName: "index",
  excludeScopesInPaths: true,
  hidePageHeader: true,
  hideBreadcrumbs: true,
  useHTMLAnchors: true,
  anchorPrefix: "api-",
  outputs: [{ name: "markdown", path: out }],
};
const app = await Application.bootstrapWithPlugins(options);
app.renderer.defineRouter(ROUTER, FlatModuleRouter);

const project = await app.convert();
if (project === undefined) {
  process.stderr.write("api reference: TypeDoc could not convert the entry points\n");
  process.exit(1);
}

// TypeDoc names a module by its path; the reference names it as users import it.
for (const module of project.getChildrenByKind(ReflectionKind.Module)) {
  const file = module.sources?.[0]?.fullFileName;
  const entryPoint = entryPoints.find(({ source }) => path.join(root, source) === file);
  if (entryPoint === undefined) {
    process.stderr.write(`api reference: no entry point for the module ${module.name}\n`);
    process.exit(1);
  }
  module.name = entryPoint.name;
}

// TypeDoc's export check skips every type outside the project's own package, which here is the
// workspace root. So validation runs once per package, with that package as the project's. The
// first run does every check; the later runs do only the export check, so no other warning prints
// twice.
const workspace = project.packageName;
for (const [index, packageName] of packageNames.entries()) {
  if (index === 1) {
    app.options.setValue("validation", {
      notExported: true,
      invalidLink: false,
      notDocumented: false,
    });
  }
  project.packageName = packageName;
  app.validate(project);
}
if (workspace === undefined) {
  delete project.packageName;
} else {
  project.packageName = workspace;
}
if (app.logger.hasErrors() || app.logger.hasWarnings()) {
  process.stderr.write("api reference: TypeDoc reported the problems above (R-AX-2, R-DX-4)\n");
  process.exit(1);
}
await app.generateOutputs(project);
const problems = app.logger.hasErrors()
  ? ["TypeDoc reported the problems above"]
  : apiProblems(out, entryPoints);
if (problems.length > 0) {
  process.stderr.write(`${problems.map((problem) => `api reference: ${problem}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(
  `api reference: ${entryPoints.length} entry points written to ${path.relative(root, out)}\n`,
);
