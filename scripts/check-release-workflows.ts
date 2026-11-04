// Checks the order the release workflows enforce (R-AX-10, R-AX-17, R-SEC-4, decision 0015):
//
// - promote.yml and release.yml set `permissions: {}` at the top, so only a job's own
//   `permissions` grant anything.
// - promote.yml: the `docs` job calls docs.yml with the version input. Every other job that runs
//   `npm dist-tag` or takes an OIDC token can move `latest`: it lists `docs` in `needs`, runs in
//   the `npm-latest` environment, and has no `if` that would let it run after a failed job.
// - release.yml: every job that takes an OIDC token runs in the `npm-publish` environment.
// - Only the `docs` job of promote.yml deploys the docs: no other job of promote.yml or release.yml
//   calls docs.yml, has `pages: write` or runs actions/deploy-pages.
// - docs.yml: it starts only from a dispatch or a call, its smoke job needs the deploy job, which
//   needs the build job, and no job or step has an `if` or `continue-on-error`. Either could let
//   the workflow pass without the deploy or the smoke check, and the promote would go on.
// A job with `permissions: write-all` counts as taking an OIDC token and `pages: write`.
//
// The workflows are read with a YAML parser, so every YAML spelling of `needs` is read the same way.
//
// Usage: node scripts/check-release-workflows.ts [root]
// `pnpm run check` runs it. Prints each problem and exits 1 when there is one.
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { errorMessage, isMainModule } from "./release-packages.ts";

/** The workflows this check reads, relative to the repository root. */
export const WORKFLOWS = {
  promote: ".github/workflows/promote.yml",
  release: ".github/workflows/release.yml",
  docs: ".github/workflows/docs.yml",
} as const;

/** The job of promote.yml that deploys and checks the docs. */
export const DOCS_JOB = "docs";
/** The reusable workflow the docs job calls. */
export const DOCS_WORKFLOW = "./.github/workflows/docs.yml";

/** The text of each workflow the check reads. */
export interface WorkflowTexts {
  promote: string;
  release: string;
  docs: string;
}

/** One job of a workflow, with the fields the check reads. */
interface Job {
  name: string;
  needs: string[];
  condition: string;
  environment: string;
  uses: string;
  version: string;
  idToken: boolean;
  pages: boolean;
  runs: string;
  /** The `uses` of each step. */
  actions: string[];
  /** Where the job or a step has `if` or `continue-on-error`, as `job` or `step N`, with the key. */
  conditions: string[];
}

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

const text = (value: unknown): string => (typeof value === "string" ? value : "");

function list(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  return Array.isArray(value) ? value.map(text) : [];
}

const grants = (permissions: unknown, scope: string): boolean =>
  permissions === "write-all" || field(permissions, scope) === "write";

const CONDITION_KEYS = ["if", "continue-on-error"] as const;

function conditionsOf(where: string, value: unknown): string[] {
  return CONDITION_KEYS.filter((key) => field(value, key) !== undefined).map(
    (key) => `${where} has ${key}`,
  );
}

function readJob(name: string, value: unknown): Job {
  const environment = field(value, "environment");
  const permissions = field(value, "permissions");
  const rawSteps = field(value, "steps");
  const steps: unknown[] = Array.isArray(rawSteps) ? rawSteps : [];
  return {
    name,
    needs: list(field(value, "needs")),
    condition: text(field(value, "if")),
    environment: typeof environment === "string" ? environment : text(field(environment, "name")),
    uses: text(field(value, "uses")),
    version: text(field(field(value, "with"), "version")),
    idToken: grants(permissions, "id-token"),
    pages: grants(permissions, "pages"),
    runs: steps.map((step) => text(field(step, "run"))).join("\n"),
    actions: steps.map((step) => text(field(step, "uses"))),
    conditions: [
      ...conditionsOf("job", value),
      ...steps.flatMap((step, index) => conditionsOf(`step ${index + 1}`, step)),
    ],
  };
}

/** One workflow, with the fields the check reads. */
interface Workflow {
  /** The top-level `permissions`, or undefined when the key is absent. */
  permissions: unknown;
  /** The names of the events that start it. */
  triggers: string[];
  jobs: Job[];
}

/**
 * Reads a workflow.
 * @param file The workflow's path, for the messages.
 * @param source The workflow's text.
 * @returns The top-level permissions, the triggers and each job, in file order.
 * @throws When the text is not YAML or has no `jobs` mapping.
 */
export function readWorkflow(file: string, source: string): Workflow {
  const workflow: unknown = parse(source);
  const jobs = field(workflow, "jobs");
  if (typeof jobs !== "object" || jobs === null || Array.isArray(jobs)) {
    throw new Error(`${file}: has no jobs mapping`);
  }
  const on = field(workflow, "on");
  return {
    permissions: field(workflow, "permissions"),
    triggers:
      typeof on === "object" && on !== null && !Array.isArray(on) ? Object.keys(on) : list(on),
    jobs: Object.entries(jobs).map(([name, value]) => readJob(name, value)),
  };
}

// A status function in `if` replaces the implicit success() check, so the job could run after the
// docs job failed or was cancelled.
const STATUS_FUNCTION = /\b(?:always|failure|cancelled)\s*\(/;

const DEPLOY_PAGES = /^actions\/deploy-pages(?:@|$)/;

function noTopPermissions(file: string, workflow: Workflow): string[] {
  const permissions = workflow.permissions;
  const empty =
    typeof permissions === "object" &&
    permissions !== null &&
    !Array.isArray(permissions) &&
    Object.keys(permissions).length === 0;
  return empty
    ? []
    : [`${file}: must set permissions: {} at the top, so each job grants only its own (R-SEC-4)`];
}

function pagesProblems(file: string, jobs: readonly Job[]): string[] {
  return jobs.flatMap((job) => {
    if (job.uses === DOCS_WORKFLOW) {
      return [`${file}: job ${job.name} deploys the docs; only the promote does (decision 0015)`];
    }
    if (job.pages || job.actions.some((action) => DEPLOY_PAGES.test(action))) {
      return [
        `${file}: job ${job.name} can deploy to GitHub Pages; only docs.yml, called by the ${DOCS_JOB} job of ${WORKFLOWS.promote}, may (decision 0015)`,
      ];
    }
    return [];
  });
}

function promoteProblems(workflow: Workflow): string[] {
  const file = WORKFLOWS.promote;
  const jobs = workflow.jobs;
  const problems = noTopPermissions(file, workflow);
  const docs = jobs.find((job) => job.name === DOCS_JOB);
  if (docs === undefined) {
    problems.push(`${file}: has no ${DOCS_JOB} job; the promote must deploy the docs (R-AX-17)`);
  } else {
    if (docs.uses !== DOCS_WORKFLOW) {
      problems.push(`${file}: job ${DOCS_JOB} must call ${DOCS_WORKFLOW} (decision 0015)`);
    }
    if (docs.version.replaceAll(" ", "") !== "${{inputs.version}}") {
      problems.push(`${file}: job ${DOCS_JOB} must pass version: \${{ inputs.version }}`);
    }
  }
  const others = jobs.filter((job) => job.name !== DOCS_JOB);
  problems.push(...pagesProblems(file, others));
  // The docs job takes an OIDC token for Pages and must call docs.yml, checked above. Any other
  // job with a token, a call to another workflow among them, could move latest.
  const movers = others.filter((job) => job.idToken || /\bnpm\s+dist-tag\b/.test(job.runs));
  if (movers.length === 0) {
    problems.push(`${file}: no job moves latest; expected one that runs npm dist-tag`);
  }
  for (const job of movers) {
    if (!job.needs.includes(DOCS_JOB)) {
      problems.push(
        `${file}: job ${job.name} moves latest but does not list ${DOCS_JOB} in needs (R-AX-10, decision 0015)`,
      );
    }
    if (STATUS_FUNCTION.test(job.condition)) {
      problems.push(
        `${file}: job ${job.name} has if: ${job.condition}, which lets it run after a failed ${DOCS_JOB} job`,
      );
    }
    if (job.environment !== "npm-latest") {
      problems.push(
        `${file}: job ${job.name} moves latest outside the npm-latest environment (R-SEC-4)`,
      );
    }
  }
  return problems;
}

function releaseProblems(workflow: Workflow): string[] {
  const file = WORKFLOWS.release;
  const problems = noTopPermissions(file, workflow);
  for (const job of workflow.jobs) {
    if (job.idToken && job.environment !== "npm-publish") {
      problems.push(
        `${file}: job ${job.name} takes an OIDC token outside the npm-publish environment (R-SEC-4)`,
      );
    }
  }
  problems.push(...pagesProblems(file, workflow.jobs));
  return problems;
}

function docsProblems(workflow: Workflow): string[] {
  const file = WORKFLOWS.docs;
  const problems: string[] = [];
  const { triggers, jobs } = workflow;
  const extra = triggers.filter(
    (trigger) => trigger !== "workflow_dispatch" && trigger !== "workflow_call",
  );
  if (!triggers.includes("workflow_call")) {
    problems.push(`${file}: has no workflow_call trigger, so the promote cannot call it`);
  }
  if (extra.length > 0) {
    problems.push(
      `${file}: starts on ${extra.join(", ")}; only workflow_dispatch and workflow_call may start it`,
    );
  }
  const order: readonly (readonly [string, string])[] = [
    ["deploy", "build"],
    ["smoke", "deploy"],
  ];
  for (const [name, needed] of order) {
    const job = jobs.find((entry) => entry.name === name);
    if (job === undefined || !job.needs.includes(needed)) {
      problems.push(`${file}: job ${name} must exist and list ${needed} in needs`);
    }
  }
  for (const job of jobs) {
    for (const where of job.conditions) {
      problems.push(
        `${file}: job ${job.name}: ${where}, which can let the workflow pass without the deploy or the smoke check (decision 0015)`,
      );
    }
  }
  return problems;
}

/**
 * Lists the problems of the three workflows.
 * @param texts The text of each workflow.
 * @returns One message per problem; empty when the workflows keep the order.
 * @throws When a workflow is not YAML or has no `jobs` mapping.
 */
export function workflowProblems(texts: WorkflowTexts): string[] {
  return [
    ...promoteProblems(readWorkflow(WORKFLOWS.promote, texts.promote)),
    ...releaseProblems(readWorkflow(WORKFLOWS.release, texts.release)),
    ...docsProblems(readWorkflow(WORKFLOWS.docs, texts.docs)),
  ];
}

/** The line printed when the check passes. */
export const PASSED =
  "release workflows: latest waits for the docs deploy and smoke check; only the promote deploys the docs";

/**
 * Runs the command line.
 * @param argv The arguments after the script name: an optional root, relative to the default.
 * @param scriptDirectory The directory of this script; the default root is its parent.
 * @returns The problems; empty when the check passes.
 */
export function main(argv: readonly string[], scriptDirectory: string): string[] {
  const root = path.resolve(scriptDirectory, "..", ...argv);
  const read = (file: string): string => readFileSync(path.join(root, file), "utf8");
  try {
    return workflowProblems({
      promote: read(WORKFLOWS.promote),
      release: read(WORKFLOWS.release),
      docs: read(WORKFLOWS.docs),
    });
  } catch (error: unknown) {
    return [errorMessage(error).split("\n", 1).join("")];
  }
}

if (isMainModule(import.meta.url)) {
  const problems = main(process.argv.slice(2), path.dirname(fileURLToPath(import.meta.url)));
  for (const problem of problems) {
    process.stderr.write(`${problem}\n`);
  }
  if (problems.length > 0) {
    process.exitCode = 1;
  } else {
    process.stdout.write(`${PASSED}\n`);
  }
}
