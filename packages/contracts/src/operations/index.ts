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
import { notificationsContracts, notificationsExposure } from "./notifications.ts";
import type { OperationContract } from "./operation.ts";
import { projectsContracts, projectsExposure } from "./projects.ts";
import { providersContracts, providersExposure } from "./providers.ts";
import { turnsContracts, turnsExposure } from "./turns.ts";
import { workspaceContracts, workspaceExposure } from "./workspace.ts";

export * from "./exposure.ts";
export { OperationContract } from "./operation.ts";

export const operationContracts = {
	...workspaceContracts,
	...projectsContracts,
	...botsContracts,
	...chatsContracts,
	...chatReadsContracts,
	...automationsContracts,
	...computersContracts,
	...connectorsContracts,
	...providersContracts,
	...approvalsContracts,
	...eventsContracts,
	...turnsContracts,
	...notificationsContracts,
};

export type OperationContracts = typeof operationContracts;

export type OperationName = keyof OperationContracts & string;

export const manifest = defineManifest<OperationContracts>()({
	...workspaceExposure,
	...projectsExposure,
	...botsExposure,
	...chatsExposure,
	...chatReadsExposure,
	...automationsExposure,
	...computersExposure,
	...connectorsExposure,
	...providersExposure,
	...approvalsExposure,
	...eventsExposure,
	...turnsExposure,
	...notificationsExposure,
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
