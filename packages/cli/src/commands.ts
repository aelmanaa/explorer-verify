/**
 * The command table. A new command is a new row: the main loop gives it the output contract, the
 * global options and signal handling.
 */
import type { Command } from "./command.ts";
import { SIMULATE } from "./simulate.ts";

/** Every command, in help order. */
export const COMMANDS: readonly Command[] = [SIMULATE];
