/**
 * Project mode of `verify` (R-DX-1, R-DX-2): `--foundry <dir>` or `--hardhat <dir>` with
 * `--contract path:Name` finds the contract's build files in the project, so the caller names no
 * hash-named build-info file. The helper package of the build tool loads only when its option is
 * given (decision 0051). Its errors name the library's options, such as `outDir`; the CLI renames
 * them to its own flags.
 */
import { ERROR_HINTS, ExplorerVerifyError } from "explorer-verify";
import type { BuiltVerifyInput, InputIssue } from "explorer-verify";

import type { OptionSpecs, OptionValue } from "./arguments.ts";
import { USAGE_HINT, stringOption } from "./command.ts";

/** The build tools project mode reads. */
type BuildTool = "foundry" | "hardhat";

/** What project mode reads: the build tool and the options of its helper. */
export interface ProjectRequest {
  readonly tool: BuildTool;
  readonly root: string;
  readonly contract: string;
  readonly outDir?: string;
  readonly artifact?: string;
  readonly compilerVersion?: string;
}

/** An example contract of each build tool, for the issue of a missing `--contract`. */
const EXAMPLE_CONTRACT: Readonly<Record<BuildTool, string>> = {
  foundry: "src/Greeter.sol:Greeter",
  hardhat: "contracts/Greeter.sol:Greeter",
};

/** The options of project mode, in help order. */
export const PROJECT_OPTIONS: OptionSpecs = {
  foundry: {
    type: "string",
    value: "<dir>",
    once: true,
    description:
      "Read the build of the Foundry project in this folder: finds the build-info and artifact of --contract. . is the current folder, not the git root that forge uses. Run forge build --build-info first.",
  },
  hardhat: {
    type: "string",
    value: "<dir>",
    once: true,
    description:
      "Read the build of the Hardhat 2 or Hardhat 3 project in this folder, . for the current one: finds the artifact and build-info of --contract. Compile the project first.",
  },
  "out-dir": {
    type: "string",
    value: "<dir>",
    once: true,
    description:
      "With --foundry or --hardhat: the build's output folder, relative to the project folder or absolute, when the config moves it. Default out for Foundry, artifacts for Hardhat.",
  },
  artifact: {
    type: "string",
    value: "<file>",
    once: true,
    description:
      "With --foundry or --hardhat: the contract's artifact file, relative to the project folder or absolute, when the build wrote one for each compiler version or profile. For Hardhat it must be inside the output folder.",
  },
};

/**
 * The project request of the command line, `undefined` when neither `--foundry` nor `--hardhat`
 * is given, or issues for the options that cannot go together.
 *
 * @param values - The checked option values.
 * @param issues - Receives the issues.
 * @returns The request.
 */
export function projectOf(
  values: ReadonlyMap<string, OptionValue>,
  issues: InputIssue[],
): ProjectRequest | undefined {
  const foundry = stringOption(values, "foundry");
  const hardhat = stringOption(values, "hardhat");
  const outDir = stringOption(values, "out-dir");
  const artifact = stringOption(values, "artifact");
  if (foundry !== undefined && hardhat !== undefined) {
    issues.push({
      field: "--hardhat",
      message: "cannot be combined with --foundry: name the build tool of the project",
    });
    return undefined;
  }
  const given: readonly [BuildTool, string] | undefined =
    foundry === undefined
      ? hardhat === undefined
        ? undefined
        : ["hardhat", hardhat]
      : ["foundry", foundry];
  if (given === undefined) {
    const loose: readonly (readonly [string, string | undefined])[] = [
      ["--out-dir", outDir],
      ["--artifact", artifact],
    ];
    for (const [field, value] of loose) {
      if (value !== undefined) {
        issues.push({ field, message: "needs --foundry or --hardhat" });
      }
    }
    return undefined;
  }
  const [tool, root] = given;
  const flag = `--${tool}`;
  if (root === "") {
    issues.push({ field: flag, message: 'must name the project folder, such as "."' });
  }
  if (values.has("input")) {
    issues.push({
      field: "--input",
      message: `cannot be combined with ${flag}: the project gives the build files`,
    });
  }
  const contract = stringOption(values, "contract");
  if (contract === undefined) {
    issues.push({
      field: "--contract",
      message: `is needed with ${flag}: the contract as path:Name, such as ${EXAMPLE_CONTRACT[tool]}, or as Name when one contract has that name`,
    });
    return undefined;
  }
  const compilerVersion = stringOption(values, "compiler-version");
  return {
    tool,
    root,
    contract,
    ...(outDir === undefined ? {} : { outDir }),
    ...(artifact === undefined ? {} : { artifact }),
    ...(compilerVersion === undefined ? {} : { compilerVersion }),
  };
}

/** The default output folder of each build tool, named when `--out-dir` was not given. */
const DEFAULT_OUT: Readonly<Record<BuildTool, string>> = { foundry: "out", hardhat: "artifacts" };

/**
 * The helpers' hints in the CLI's words: its flags in place of the library's option names, and no
 * `details` field, which the envelope does not carry. A test feeds every hint of both helpers
 * through these and checks that no library word is left.
 */
const HINT_WORDS: readonly (readonly [RegExp, string])[] = [
  [/\b(?:options\.)?outDir\b/g, "--out-dir"],
  [/\boptions\.contract\b/g, "--contract"],
  [/\b([Pp]ass) contract as\b/g, "$1 --contract as"],
  [/\b([Pp]ass) artifact with\b/g, "$1 --artifact with"],
  [/\bunder root\b/g, "under the project folder"],
  [/\bproject root\b/g, "project folder"],
  [/\bone entry of details\.candidates\b/g, "one of the paths listed"],
  [/\blisted in details\.candidates\b/g, "listed"],
  [/\bwhat details\.field names\b/g, "what the message names"],
  [/\bcall again\b/g, "run the command again"],
];

/**
 * A helper's hint in the CLI's words. The library's generic `invalid-input` hint, which names
 * `details.issues`, becomes the CLI's usage hint.
 *
 * @param hint - The helper's hint.
 * @returns The hint with the CLI's flags.
 */
export function cliHintOf(hint: string): string {
  if (hint === ERROR_HINTS["invalid-input"]) {
    return USAGE_HINT;
  }
  return HINT_WORDS.reduce((text, [word, flag]) => text.replace(word, flag), hint);
}

/**
 * The error of a helper in the CLI's words: its hint through {@link cliHintOf}, and the issues of
 * `invalid-input` renamed to the CLI's flags and listed in the message, because the envelope has
 * no `details`. A default output folder the caller did not name is reported on the project flag.
 * The candidates of `incomplete-input` join its message. Anything that is not an
 * `ExplorerVerifyError` is returned as it is.
 *
 * @param error - What the helper threw.
 * @param request - The project request: the build tool and the options given.
 * @returns The error to throw.
 */
export function withCliFlags(error: unknown, request: ProjectRequest): unknown {
  if (!(error instanceof ExplorerVerifyError)) {
    return error;
  }
  const { tool } = request;
  const flag = `--${tool}`;
  const hint = cliHintOf(error.hint);
  const { details } = error;
  if (details.code !== "invalid-input") {
    const candidates = details.code === "incomplete-input" ? details.candidates : [];
    const message =
      candidates.length === 0
        ? error.message
        : `${error.message.replace(/\.$/, "")}: ${candidates.join(", ")}.`;
    return new ExplorerVerifyError(details, message, { hint, cause: error, secrets: [] });
  }
  const names = new Map([
    ["root", flag],
    ["contract", "--contract"],
    ["artifact", "--artifact"],
    ["compilerVersion", "--compiler-version"],
  ]);
  const issues = details.issues.map((issue): InputIssue => {
    if (issue.field !== "outDir") {
      return { ...issue, field: names.get(issue.field) ?? issue.field };
    }
    return request.outDir === undefined
      ? {
          field: flag,
          message: `has no ${DEFAULT_OUT[tool]} folder: build the project, or pass --out-dir`,
        }
      : { ...issue, field: "--out-dir" };
  });
  // The envelope carries no details, so the message lists each issue, as a usage error does.
  const list = issues.map((issue) => `${issue.field} ${issue.message}`).join("; ");
  return new ExplorerVerifyError(
    { code: "invalid-input", issues },
    `The input is invalid: ${list.replace(/\.$/, "")}.`,
    { hint, cause: error, secrets: [] },
  );
}

/**
 * Builds the compiler part of the input and the contract name from the project's build, with
 * the helper of its build tool, which loads only now.
 *
 * @param request - The project request.
 * @returns What `buildVerifyInputFromFoundry` or `buildVerifyInputFromHardhat` returns.
 * @throws ExplorerVerifyError what the helper throws, with the CLI's flags in its text.
 */
export async function inputFromProject(request: ProjectRequest): Promise<BuiltVerifyInput> {
  const { tool, ...options } = request;
  try {
    if (tool === "foundry") {
      const { buildVerifyInputFromFoundry } = await import("@explorer-verify/foundry");
      return await buildVerifyInputFromFoundry(options);
    }
    const { buildVerifyInputFromHardhat } = await import("@explorer-verify/hardhat");
    return await buildVerifyInputFromHardhat(options);
  } catch (error) {
    throw withCliFlags(error, request);
  }
}
