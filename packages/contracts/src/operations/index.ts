/**
 * Every operation's contract, and the exposure manifest: one entry per
 * operation deciding whether the HTTP API and the bot loop offer it. Each
 * domain keeps its own in `<domain>.ts`; this file only spreads them.
 */

import { approvalsContracts, approvalsExposure } from "./approvals.ts";
import { automationsContracts, automationsExposure } from "./automations.ts";
import { botsContracts, botsExposure } from "./bots.ts";
import { chatReadsContracts, chatReadsExposure } from "./chat-reads.ts";
import { chatsContracts, chatsExposure } from "./chats.ts";
import { computersContracts, computersExposure } from "./computers.ts";
import { connectorsContracts, connectorsExposure } from "./connectors.ts";
import { eventsContracts, eventsExposure } from "./events.ts";
import { defineManifest } from "./exposure.ts";
import { filesContracts, filesExposure } from "./files.ts";
import { notificationsContracts, notificationsExposure } from "./notifications.ts";
import type { OperationContract } from "./operation.ts";
import { projectsContracts, projectsExposure } from "./projects.ts";
import { providersContracts, providersExposure } from "./providers.ts";
import { scheduledWorkContracts, scheduledWorkExposure } from "./scheduled-work.ts";
import { turnsContracts, turnsExposure } from "./turns.ts";
import { webContracts, webExposure } from "./web.ts";
import { workspaceContracts, workspaceExposure } from "./workspace.ts";

export * from "./exposure.ts";
export { OperationContract } from "./operation.ts";

export const operationContracts = {
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
};

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

export const manifest = defineManifest<OperationContracts>()({
	...workspaceExposure,
	...projectsExposure,
	...botsExposure,
	...chatsExposure,
	...chatReadsExposure,
	...filesExposure,
	...automationsExposure,
	...computersExposure,
	...connectorsExposure,
	...providersExposure,
	...webExposure,
	...approvalsExposure,
	...eventsExposure,
	...turnsExposure,
	...notificationsExposure,
	...scheduledWorkExposure,
});

export type Manifest = typeof manifest;

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
