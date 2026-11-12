// Generates the API reference of the docs site from TSDoc (R-AX-2, decision 0015): TypeDoc with
// typedoc-plugin-markdown writes a page per package entry point and a page per exported member
// into `site/api/`, and VitePress builds them with the user docs. `pnpm run site:build` runs it
// first. The pages are build output: they are gitignored, never written to `docs/user/`, and
// never packed. Each page stays under ten desktop screens: the options and the theme below keep
// the longest ones short.
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
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  Application,
  ArrayType,
  ConditionalType,
  LiteralType,
  PageEvent,
  PredicateType,
  ReferenceType,
  ReflectionKind,
  ReflectionType,
  UnionType,
} from "typedoc";
import type {
  DeclarationReflection,
  ProjectReflection,
  Reflection,
  SomeType,
  TypeDocOptions,
} from "typedoc";
import { MarkdownTheme, MarkdownThemeContext, MemberRouter } from "typedoc-plugin-markdown";
import type { MarkdownPageEvent, PluginOptions } from "typedoc-plugin-markdown";

import { ERROR_CODES } from "../packages/explorer-verify/src/errors.ts";
import { packageVersion } from "../scripts/agent-docs.ts";
import {
  API_DESCRIPTIONS,
  API_GROUP_ORDER,
  API_INDEX_DESCRIPTION,
  API_OUT,
  API_TITLE,
  apiDescription,
  apiEntryPoints,
  apiPageName,
  apiPages,
  apiProblems,
  isRepositorySource,
  orderApiMembers,
} from "../scripts/site-api.ts";
import { GITHUB_BLOB } from "../scripts/site-docs.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.resolve(root, process.argv[2] ?? API_OUT);
const entryPoints = apiEntryPoints(root);
const packageNames = [...new Set(entryPoints.map(({ packageName }) => packageName))];

/** The router this script registers, next to the plugin's own. */
const ROUTER = "explorer-verify-modules";
/** The theme this script registers, next to the plugin's own. */
const THEME = "explorer-verify-api";

/**
 * The plugin's member router, one page per exported member, with one folder per entry point: the
 * entry point's page is `<page name>/index.md` and lists its members, and each member's page is in
 * a folder of its kind, such as `explorer-verify/functions/verify.md`. The folder names come from
 * `apiPageName`, so `explorer-verify/server` is `explorer-verify-server/`, not a folder inside
 * `explorer-verify/`.
 */
class EntryPointRouter extends MemberRouter {
  override getIdealBaseName(reflection: Reflection): string {
    return reflection.kind === ReflectionKind.Module
      ? `${apiPageName(reflection.name)}/index`
      : super.getIdealBaseName(reflection);
  }
}

/**
 * The plugin's theme context, with one change: a union whose members are all object types, such
 * as the 26 members of `ErrorDetails`, lists each member as its table of properties alone. The
 * plugin puts a "Type Literal" heading and the member's type, which the table repeats, above each
 * table, and the page grows past ten screens.
 */
class ApiThemeContext extends MarkdownThemeContext {
  constructor(...args: ConstructorParameters<typeof MarkdownThemeContext>) {
    super(...args);
    const partials = this.partials;
    this.partials = {
      ...partials,
      typeDeclarationUnionContainer: (model, opts) => {
        const types = model.type instanceof UnionType ? model.type.types : [];
        const members = types.flatMap((type) =>
          type instanceof ReflectionType &&
          type.declaration.signatures === undefined &&
          this.helpers.hasUsefulTypeDetails(type)
            ? [type.declaration]
            : [],
        );
        if (members.length === 0 || members.length !== types.length) {
          return partials.typeDeclarationUnionContainer(model, opts);
        }
        return members
          .map((declaration: DeclarationReflection) =>
            partials.typeDeclarationContainer(model, declaration, {
              headingLevel: opts.headingLevel + 1,
            }),
          )
          .join("\n\n***\n\n");
      },
    };
  }
}

/** The plugin's theme with the context above. */
class ApiTheme extends MarkdownTheme {
  override getRenderContext(page: MarkdownPageEvent<Reflection>): MarkdownThemeContext {
    return new ApiThemeContext(this, page, this.application.options);
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
  // typedoc-plugin-markdown: a folder per entry point, named by `apiPageName`, with an `index.md`
  // that lists the members in tables with their first paragraph, and a page per member under it.
  // The breadcrumbs lead from a member's page back to its entry point and the index.
  router: ROUTER,
  entryFileName: "index",
  excludeScopesInPaths: true,
  hidePageHeader: true,
  hideBreadcrumbs: false,
  indexFormat: "table",
  // The members of a union, such as the 26 of `ErrorDetails`, parameters and class properties as
  // tables, without the source column: the page's own "Defined in" names the file. Interface
  // properties stay as sections: several hold a code example, which a table cell cannot.
  typeDeclarationFormat: "table",
  parametersFormat: "table",
  classPropertiesFormat: "table",
  tableColumnSettings: { hideSources: true },
  groupOrder: [...API_GROUP_ORDER],
  useHTMLAnchors: true,
  anchorPrefix: "api-",
  theme: THEME,
  outputs: [{ name: "markdown", path: out }],
};
const app = await Application.bootstrapWithPlugins(options);
app.renderer.defineRouter(ROUTER, EntryPointRouter);
app.renderer.defineTheme(THEME, ApiTheme);

// The entry point and the first paragraph of the TSDoc summary of each page, by its path under the
// output folder. The docs site makes them the page's meta description (R-AX-17).
const summaries = new Map<string, { entry: string; summary: string }>();
app.renderer.on(PageEvent.END, (page) => {
  if (!page.isReflectionEvent()) {
    return;
  }
  let module: Reflection | undefined = page.model;
  while (module !== undefined && module.kind !== ReflectionKind.Module) {
    module = module.parent;
  }
  const model = page.model;
  const comment = model.isDeclaration()
    ? (model.comment ?? model.signatures?.[0]?.comment)
    : model.comment;
  if (module !== undefined) {
    summaries.set(page.url, {
      entry: module.name,
      summary: (comment?.getShortSummary(true) ?? []).map((part) => part.text).join(""),
    });
  }
});

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
  // Functions first (`groupOrder`), and the verification flow first among them.
  for (const group of module.groups ?? []) {
    group.children = orderApiMembers(group.children);
  }
}

// A member declared outside the repository has no source link: the link would point into
// `node_modules`, which the tag does not hold. One inherited from such a type, such as
// `captureStackTrace` from `Error`, is left out: its text is Node.js's or TypeScript's, not this
// library's, and the page names the base type under "Extends".
for (const reflection of Object.values(project.reflections)) {
  if (!reflection.isDeclaration() && !reflection.isSignature()) {
    continue;
  }
  const sources = (reflection.sources ?? []).filter(({ fullFileName }) =>
    isRepositorySource(root, fullFileName),
  );
  if (
    reflection.isDeclaration() &&
    reflection.inheritedFrom !== undefined &&
    sources.length === 0
  ) {
    project.removeReflection(reflection);
    // TypeDoc removes the member from its parent's children, not from the parent's groups,
    // which the pages are rendered from.
    const parent = reflection.parent;
    if (parent !== undefined && parent.isDeclaration() && parent.groups !== undefined) {
      for (const group of parent.groups) {
        group.children = group.children.filter((child) => child !== reflection);
      }
      parent.groups = parent.groups.filter((group) => group.children.length > 0);
    }
  } else if (sources.length === 0) {
    delete reflection.sources;
  } else {
    reflection.sources = sources;
  }
}

// TypeDoc writes the type of a type predicate out in full, so `value is AnyExplorerVerifyError`
// shows 26 `ExplorerVerifyError<"...">` members, and the error class page grows past ten screens.
// This puts back the names the source uses: a union of every error code is `ErrorCode`, and a
// union of `ExplorerVerifyError` of each code is `AnyExplorerVerifyError`.
collapseErrorUnions(project);

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
// Each page's meta description, from its summary, in a file next to the pages, which the site
// config reads. The index has its own.
const descriptions: Record<string, string> = {};
const undescribed: string[] = [];
for (const { page, title } of apiPages(out)) {
  const found = summaries.get(page);
  if (page === "index.md") {
    descriptions[page] = API_INDEX_DESCRIPTION;
  } else if (found === undefined) {
    undescribed.push(`${page} has no TSDoc summary for its description (R-AX-17)`);
  } else {
    descriptions[page] = apiDescription(title, found.entry, found.summary);
  }
}
writeFileSync(path.join(out, API_DESCRIPTIONS), `${JSON.stringify(descriptions, null, 2)}\n`);
const problems = app.logger.hasErrors()
  ? ["TypeDoc reported the problems above"]
  : [...apiProblems(out, entryPoints), ...undescribed];
if (problems.length > 0) {
  process.stderr.write(`${problems.map((problem) => `api reference: ${problem}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(
  `api reference: ${entryPoints.length} entry points written to ${path.relative(root, out)}\n`,
);

/**
 * Replaces, in the type of every member, parameter and signature, each union of all the error
 * codes with a reference to `ErrorCode`, and each union of `ExplorerVerifyError` of every code with
 * a reference to `AnyExplorerVerifyError`. The codes are `ERROR_CODES`, read from the source.
 * Does nothing when the project has neither alias.
 */
function collapseErrorUnions(converted: ProjectReflection): void {
  const aliases = converted.getReflectionsByKind(ReflectionKind.TypeAlias);
  const errorCode = aliases.find((alias) => alias.name === "ErrorCode");
  const anyError = aliases.find((alias) => alias.name === "AnyExplorerVerifyError");
  if (errorCode === undefined || anyError === undefined) {
    return;
  }
  const codes: readonly string[] = ERROR_CODES;
  const coversEveryCode = (found: readonly (string | undefined)[]): boolean =>
    found.length === codes.length && codes.every((code) => found.includes(code));
  const collapse = (type: SomeType): SomeType => {
    if (type instanceof UnionType) {
      type.types = type.types.map(collapse);
      if (coversEveryCode(type.types.map(literalCode))) {
        return ReferenceType.createResolvedReference(errorCode.name, errorCode, converted);
      }
      const errorCodes = type.types.map((member) =>
        member instanceof ReferenceType &&
        member.name === "ExplorerVerifyError" &&
        member.typeArguments?.length === 1
          ? literalCode(member.typeArguments[0])
          : undefined,
      );
      return coversEveryCode(errorCodes)
        ? ReferenceType.createResolvedReference(anyError.name, anyError, converted)
        : type;
    }
    if (type instanceof ReferenceType && type.typeArguments !== undefined) {
      type.typeArguments = type.typeArguments.map(collapse);
    } else if (type instanceof PredicateType && type.targetType !== undefined) {
      type.targetType = collapse(type.targetType);
    } else if (type instanceof ConditionalType) {
      type.checkType = collapse(type.checkType);
      type.extendsType = collapse(type.extendsType);
      type.trueType = collapse(type.trueType);
      type.falseType = collapse(type.falseType);
    } else if (type instanceof ArrayType) {
      type.elementType = collapse(type.elementType);
    }
    return type;
  };
  for (const reflection of Object.values(converted.reflections)) {
    if (
      reflection !== errorCode &&
      (reflection.isDeclaration() || reflection.isSignature() || reflection.isParameter()) &&
      reflection.type !== undefined
    ) {
      reflection.type = collapse(reflection.type);
    }
  }
}

/** The value of a string literal type, or undefined. */
function literalCode(type: SomeType | undefined): string | undefined {
  return type instanceof LiteralType && typeof type.value === "string" ? type.value : undefined;
}
