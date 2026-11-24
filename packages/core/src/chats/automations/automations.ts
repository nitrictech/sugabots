export type { Defined } from "./automation-writes.ts";
export * as Automations from "./automations.ts";

import type {
	AcceptedRun,
	AutomationUpdate,
	ListedAutomationDefinition,
	NewAutomation,
} from "@sugabots/contracts";
import type {
	AutomationNameTaken,
	AutomationNotFound,
	AutomationRepositoryNotConnected,
	InvalidRoutineSchedule,
	WebhookDeliveryIdHeaderRejected,
	WebhookSecretTooShort,
} from "@sugabots/contracts/errors/automations";
import { Context, Effect, Layer } from "effect";
import type { AuthorizationDenied } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import type { CurrentActor } from "../../authorization/current-actor.ts";
import { serviceOperations, transaction } from "../../database/database.ts";
import type { RepositoryActivity } from "../../providers/connectors/github/github-events.ts";
import { ChatStore } from "../store/store.ts";
import {
	type InProject,
	type RoutineInput,
	scopeOf,
	type TriggerSetInSettings,
} from "./automation.ts";
import { makeView } from "./automation-view.ts";
import { type Defined, makeAutomationWrites } from "./automation-writes.ts";
import { makeConnectorEvents } from "./connector-events.ts";
import { AutomationStore } from "./store.ts";

/**
 * What the automation tools (`BotAutomations`) do with a project's
 * automations for the member a bot answers, as the current actor: list them,
 * define one, and change one's settings and its sole routine. It exists only
 * because those tools still call services directly; it goes when tools
 * become operations, called in the bot loop like any other entrypoint's.
 * Everything else, and the HTTP API, goes through the automations operations
 * and `ProjectAutomations`, which demands proofs.
 */
export interface Interface {
	/**
	 * Defines an automation in a project, as made by the principal or, with
	 * `madeByBotId`, by that bot, working in the project, at the principal's
	 * request, returning the secrets made for its webhook triggers.
	 */
	readonly create: (
		project: { projectId: string; madeByBotId?: string },
		input: NewAutomation,
	) => Effect.Effect<
		Defined,
		| AuthorizationDenied
		| AutomationNameTaken
		| InvalidRoutineSchedule
		| WebhookSecretTooShort
		| WebhookDeliveryIdHeaderRejected
		| AutomationRepositoryNotConnected,
		CurrentActor.Service
	>;
	/**
	 * Changes an automation's own settings. Pausing it stops its routines;
	 * enabling it again sets when each runs next from now.
	 */
	readonly update: (
		automation: InProject,
		input: AutomationUpdate,
	) => Effect.Effect<
		Defined,
		AuthorizationDenied | AutomationNotFound | AutomationNameTaken | InvalidRoutineSchedule,
		CurrentActor.Service
	>;
	/**
	 * Changes an automation's own settings, as `update` does, and makes the
	 * routine all that starts it, in one transaction: rewrites its one routine,
	 * or adds it when nothing starts the automation yet. Refused, changing
	 * nothing, when it has another routine or a trigger.
	 */
	readonly updateWithSoleRoutine: (
		automation: InProject,
		input: AutomationUpdate,
		routine: RoutineInput,
	) => Effect.Effect<
		Defined,
		| AuthorizationDenied
		| AutomationNotFound
		| AutomationNameTaken
		| InvalidRoutineSchedule
		| TriggerSetInSettings,
		CurrentActor.Service
	>;
	/**
	 * The project's automations, by name, each with how it stands for
	 * whoever may read its runs.
	 */
	readonly list: (project: {
		projectId: string;
	}) => Effect.Effect<ListedAutomationDefinition[], AuthorizationDenied, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Automations") {}

/**
 * Runs connector automations for what happened at their connectors' services.
 * The service's signature on the delivery is what admits it, checked before
 * this is asked, so this asks for no principal.
 */
export interface ConnectorEventsInterface {
	/**
	 * Accepts a run of each enabled automation `activity` runs through
	 * `connectorId`, while the connector has the repository. A delivery
	 * GitHub sends again starts no new runs.
	 */
	readonly accept: (input: {
		workspaceId: string;
		connectorId: string;
		deliveryId: string;
		activity: RepositoryActivity;
	}) => Effect.Effect<AcceptedRun[]>;
}

export class ConnectorEvents extends Context.Service<ConnectorEvents, ConnectorEventsInterface>()(
	"@sugabots/core/Automations/ConnectorEvents",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Automations");
	const authorization = yield* Authorization.Service;
	const writes = yield* makeAutomationWrites;
	const view = yield* makeView;

	return Service.of({
		...view,
		create: ({ projectId, madeByBotId }, input) =>
			operation(
				"create",
				transaction(
					Effect.gen(function* () {
						const { project, actor } = yield* authorization.project(projectId, "automation.manage");
						return yield* writes.create(
							project,
							{ createdById: actor.memberId, createdByBotId: madeByBotId ?? null },
							input,
						);
					}),
				),
			),

		update: (addressed, input) =>
			operation(
				"update",
				transaction(
					Effect.gen(function* () {
						const scope = yield* scopeOf(authorization, addressed, "automation.manage");
						return yield* writes.update(scope, input);
					}),
				),
			),

		updateWithSoleRoutine: (addressed, input, routine) =>
			operation(
				"updateWithSoleRoutine",
				transaction(
					Effect.gen(function* () {
						const scope = yield* scopeOf(authorization, addressed, "automation.manage");
						return yield* writes.updateWithSoleRoutine(scope, input, routine);
					}),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([Authorization.layer, AutomationStore.layer, ChatStore.layer]),
);

export const connectorEventsLayer = Layer.effect(ConnectorEvents, makeConnectorEvents).pipe(
	Layer.provide([AutomationStore.layer, ChatStore.layer]),
);

/** Accepts the runs of automations' routines as they fall due. */
export { layer as schedulerLayer } from "./scheduler.ts";
/** The automation workflow's steps. */
export { automationStepsLayer as stepsLayer } from "./steps.ts";
