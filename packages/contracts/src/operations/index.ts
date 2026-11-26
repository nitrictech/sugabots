/**
 * Every operation's contract, each carrying its decisions in the exposure
 * manifest: whether the HTTP API and the bot loop offer it. Each domain keeps
 * its own in `<domain>.ts`; this file only spreads them.
 */

import { approvalsContracts } from "./approvals.ts";
import { automationsContracts } from "./automations.ts";
import { botsContracts } from "./bots.ts";
import { chatReadsContracts } from "./chat-reads.ts";
import { chatsContracts } from "./chats.ts";
import { computersContracts } from "./computers.ts";
import { connectorsContracts } from "./connectors.ts";
import { eventsContracts } from "./events.ts";
import { checkExposure } from "./exposure.ts";
import { filesContracts } from "./files.ts";
import { notificationsContracts } from "./notifications.ts";
import type { OperationContract } from "./operation.ts";
import { projectsContracts } from "./projects.ts";
import { providersContracts } from "./providers.ts";
import { scheduledWorkContracts } from "./scheduled-work.ts";
import { turnsContracts } from "./turns.ts";
import { webContracts } from "./web.ts";
import { workspaceContracts } from "./workspace.ts";

export * from "./exposure.ts";
export { OperationContract } from "./operation.ts";

export const operationContracts = checkExposure({
	...workspaceContracts,
	...projectsContracts,
	...botsContracts,
	...chatsContracts,
	...chatReadsContracts,
	...filesContracts,
	...automationsContracts,
	...computersContracts,
	...connectorsContracts,
	...providersContracts,
	...webContracts,
	...approvalsContracts,
	...eventsContracts,
	...turnsContracts,
	...notificationsContracts,
	...scheduledWorkContracts,
});

export type OperationContracts = typeof operationContracts;

export type OperationName = keyof OperationContracts & string;

/**
 * The operations of the long-running kind: following a stream, and the
 * desktop viewer (see `OperationContract.Kind`).
 */
export type LongRunningOperationName = {
	[Name in OperationName]: OperationContracts[Name]["kind"] extends "longRunning" ? Name : never;
}[OperationName];

/** The operations that run once per call. */
export type RequestOperationName = Exclude<OperationName, LongRunningOperationName>;

/** The decoded input the operation `Name` takes. */
export type InputOf<Name extends OperationName> = OperationContract.Input<OperationContracts[Name]>;

/** What the operation `Name` returns. */
export type OutputOf<Name extends OperationName> = OperationContract.Output<
	OperationContracts[Name]
>;

/** The errors the operation `Name` can fail with. */
export type FailureOf<Name extends OperationName> = OperationContract.Failure<
	OperationContracts[Name]
>;
