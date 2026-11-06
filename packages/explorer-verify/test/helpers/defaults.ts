/**
 * The engine's `run*` functions with the default entry's loaders filled in. Since decision 0052
 * the engine has no fallback for the routing table, the constructor argument derivation or the
 * `handlerUrl` code: the default entry passes them in `DEFAULT_DEPENDENCIES`, and
 * `explorer-verify/core` passes what its caller gave. A test that passes only clients or linkers
 * gets the default entry's other loaders here, as the engine gave them before. A key the test
 * sets, even to `undefined`, stays as the test set it.
 */
import {
  DEFAULT_DEPENDENCIES,
  DEFAULT_LINK_DEPENDENCIES,
  VERIFY_DEPENDENCIES,
} from "../../src/flow/defaults.ts";
import { runDryRun as dryRun } from "../../src/flow/dry-run.ts";
import { runLinkProxy as linkProxy } from "../../src/flow/link-proxy.ts";
import type { LinkDependencies } from "../../src/flow/link-proxy.ts";
import { runCheckStatus as checkStatus } from "../../src/flow/status.ts";
import { runVerifyEach as verifyEach } from "../../src/flow/verify-each.ts";
import { runVerify as verify } from "../../src/flow/verify.ts";
import type { FlowDependencies } from "../../src/flow/verify.ts";

/** `dependencies` with the default entry's table, derivation and handler loaders where unset. */
function withDefaults(dependencies: FlowDependencies): FlowDependencies {
  return {
    table: DEFAULT_DEPENDENCIES.table,
    derivation: VERIFY_DEPENDENCIES.derivation,
    handler: DEFAULT_DEPENDENCIES.handler,
    ...dependencies,
  };
}

/** `dependencies` with the default entry's table and handler loaders where unset. */
function withLinkDefaults(dependencies: LinkDependencies): LinkDependencies {
  return {
    table: DEFAULT_LINK_DEPENDENCIES.table,
    handler: DEFAULT_LINK_DEPENDENCIES.handler,
    ...dependencies,
  };
}

export async function runVerify(
  ...[input, options, dependencies]: Parameters<typeof verify>
): ReturnType<typeof verify> {
  return await verify(input, options, withDefaults(dependencies));
}

export async function runDryRun(
  ...[input, options, dependencies]: Parameters<typeof dryRun>
): ReturnType<typeof dryRun> {
  return await dryRun(input, options, withDefaults(dependencies));
}

export async function runCheckStatus(
  ...[handle, options, dependencies]: Parameters<typeof checkStatus>
): ReturnType<typeof checkStatus> {
  return await checkStatus(handle, options, withDefaults(dependencies));
}

export async function runVerifyEach(
  ...[input, options, dependencies]: Parameters<typeof verifyEach>
): ReturnType<typeof verifyEach> {
  return await verifyEach(input, options, withDefaults(dependencies));
}

export async function runLinkProxy(
  ...[target, options, dependencies]: Parameters<typeof linkProxy>
): ReturnType<typeof linkProxy> {
  return await linkProxy(target, options, withLinkDefaults(dependencies));
}
