/**
 * The `status` command (R-FLOW-5, R-AX-16): resumes a submitted verification from its handle with
 * `checkStatus()`, which never submits. The handle comes as the one argument, or in the request of
 * `--input-json`.
 */
import { checkStatus } from "explorer-verify";
import type { InputIssue } from "explorer-verify";

import { stringOption, usageError } from "./command.ts";
import type { Command, PrepareContext, Prepared } from "./command.ts";
import { readJsonRequest } from "./request.ts";
import type { JsonRequestSpec } from "./request.ts";
import {
  FALLBACK_OPTION,
  TIMEOUT_OPTION,
  callOptions,
  checkFallback,
  inputJsonOption,
  timeoutOf,
  withCliHint,
} from "./verify.ts";

/** The status request of `--input-json`. A test checks it against `input.schema.json`. */
export const STATUS_REQUEST: JsonRequestSpec = { command: "status", fields: ["handle"] };

/** Reads the handle, from the argument or from `--input-json`, before the keys are read. */
async function prepare(context: PrepareContext): Promise<Prepared> {
  const { values, positionals } = context;
  const issues: InputIssue[] = [];
  const timeoutMs = timeoutOf(values, issues);
  const path = stringOption(values, "input-json");
  let handle: unknown = positionals[0];
  let runValues = values;
  let fieldNames: ReadonlyMap<string, string> = new Map();
  if (path === undefined && handle === undefined) {
    issues.push({ field: "status", message: "needs the handle: ev1:<backend>:<chainId>:..." });
  }
  if (issues.length > 0) {
    throw usageError(issues);
  }
  if (path !== undefined) {
    const request = await readJsonRequest(
      { path, values, positionals, stdin: context.stdin },
      STATUS_REQUEST,
    );
    handle = request.fields.get("handle");
    runValues = request.values;
    fieldNames = request.fieldNames;
    // The handle object and its JSON text are refused, as input.schema.json refuses them.
    if (typeof handle !== "string" || !handle.startsWith("ev1:")) {
      throw usageError([
        {
          field: "handle",
          message:
            "must be the handle in its one-line form ev1:<backend>:<chainId>:<address>:<jobId>",
        },
      ]);
    }
  }
  checkFallback(runValues, fieldNames);
  const line = String(handle);
  return {
    values: runValues,
    fieldNames,
    run: async (run) => await withCliHint(checkStatus(line, callOptions(run, timeoutMs))),
  };
}

const HANDLE =
  "ev1:sourcify:11155111:0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718";

/** The `status` row of the command table. */
export const STATUS: Command = {
  name: "status",
  routed: true,
  summary:
    "Resume a submitted verification from its handle, such as after exit code 4. Never submits.",
  usage: "<handle>",
  examples: [
    {
      args: `status ${HANDLE} --json`,
      description: "Poll the job of a handle until it ends or the time budget runs out.",
    },
  ],
  options: {
    timeout: TIMEOUT_OPTION,
    "allow-sourcify-fallback": FALLBACK_OPTION,
    "input-json": inputJsonOption("status"),
  },
  maxPositionals: 1,
  prepare,
};
