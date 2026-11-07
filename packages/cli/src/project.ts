// References: R-DX-1, R-DX-2, decision 0051.
/**
 * Project mode of `verify`: `--foundry <dir>` or `--hardhat <dir>` with
 * `--contract path:Name` finds the contract's build files in the project, so the caller names no
 * hash-named build-info file. The helper package of the build tool loads only when its option is
 * given. Its errors name the library's options, such as `outDir`; the CLI renames
 * them to its own flags.
 */
import { ExplorerVerifyError } from "explorer-verify";
import type { BuiltVerifyInput, InputIssue } from "explorer-verify";

import type { OptionSpecs, OptionValue } from "./arguments.ts";
import { stringOption } from "./command.ts";
import { inCliWords } from "./hints.ts";

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
    description:
      "Read the build of the Foundry project in this folder: finds the build-info and artifact of --contract. . is the current folder, not the git root that forge uses. Run forge build --build-info first.",
  },
  hardhat: {
    type: "string",
    value: "<dir>",
    description:
      "Read the build of the Hardhat 2 or Hardhat 3 project in this folder, . for the current one: finds the artifact and build-info of --contract. Compile the project first.",
  },
  "out-dir": {
    type: "string",
    value: "<dir>",
    description:
      "With --foundry or --hardhat: the build's output folder, relative to the project folder or absolute, when the config moves it. Default out for Foundry, artifacts for Hardhat.",
  },
  artifact: {
    type: "string",
    value: "<file>",
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
 * The error of a helper with the CLI's flags in its `invalid-input` issues: each field the helper
 * names, such as `contract`, becomes the flag that sets it, such as `--contract`, and a default
 * output folder the caller did not name is reported on the project flag. The envelope carries
 * the issues in `details`, and the stderr error block lists them. The hint is left to the CLI's
 * hint layer (`hints.ts`), which rewrites every error's hint in one place. Any other error is
 * returned as it is.
 *
 * @param error - What the helper threw.
 * @param request - The project request: the build tool and the options given.
 * @returns The error to throw.
 */
export function withCliFlags(error: unknown, request: ProjectRequest): unknown {
  if (!(error instanceof ExplorerVerifyError)) {
    return error;
  }
  // The message in the CLI's words too, with the same table as the hints, when every library
  // word in it has a CLI form.
  const message = inCliWords(error.message) ?? error.message;
  const options = { hint: error.hint, cause: error, secrets: [] };
  if (error.details.code !== "invalid-input") {
    return message === error.message
      ? error
      : new ExplorerVerifyError(error.details, message, options);
  }
  const { tool } = request;
  const flag = `--${tool}`;
  const names = new Map([
    ["root", flag],
    ["contract", "--contract"],
    ["artifact", "--artifact"],
    ["compilerVersion", "--compiler-version"],
  ]);
  const issues = error.details.issues.map((issue): InputIssue => {
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
  return new ExplorerVerifyError({ code: "invalid-input", issues }, message, options);
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
