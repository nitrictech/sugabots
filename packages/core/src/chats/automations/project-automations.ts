export * as ProjectAutomations from "./project-automations.ts";

import type {
	AcceptedRun,
	Automation,
	AutomationCurrentSecret,
	AutomationTriggerInput,
	AutomationUpdate,
	ListedAutomationDefinition,
	NewAutomation,
	RunPage,
	RunPageQuery,
} from "@sugabots/contracts";
import type {
	AutomationDeliveryIdTooLong,
	AutomationNameTaken,
	AutomationNotFound,
	AutomationRepositoryNotConnected,
	AutomationTriggerConflict,
	AutomationTriggerKindChanged,
	AutomationTriggerNotFound,
	AutomationTriggerRejected,
	InvalidRoutineSchedule,
	TooManyAutomationTriggers,
	WebhookDeliveryIdHeaderRejected,
	WebhookRefused,
	WebhookSecretTooShort,
} from "@sugabots/contracts/errors/automations";
import type { InvalidCursor } from "@sugabots/contracts/errors/chat-reads";
import { Context, Effect, Layer } from "effect";
import { serviceOperations } from "../../database/database.ts";
import type { CallsWebhook } from "../../proofs/calls-webhook.ts";
import type { CanRestrictBotsProject } from "../../proofs/can-restrict-bot.ts";
import type { CanManageProject, CanRunAutomations } from "../../proofs/project-permissions.ts";
import type { ReachesProject } from "../../proofs/reaches-project.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { ChatStore } from "../store/store.ts";
import type { Scope } from "./automation.ts";
import { automationsOf, projectRunsPage } from "./automation-view.ts";
import { makeAcceptWebhook, type WebhookAnswer } from "./automation-webhooks.ts";
import { type Defined, makeAutomationWrites } from "./automation-writes.ts";
import { AutomationStore } from "./store.ts";
import type { Delivery } from "./webhook-auth.ts";

/**
 * A project's automations, for operations that have proved what each call
 * needs: defining them, their triggers and webhook secrets, starting a run by
 * hand, accepting a webhook call's run, and listing them and their runs. A
 * bot's own automations are its default project's. Each method takes the
 * workspace and the project from its proofs.
 *
 * The project's lead bot does each run, in a chat of its own in the project;
 * a run is started by its workflow, one at a time per automation, and ended
 * by `AutomationSettlement`. Runs a routine starts are the scheduler's.
 */
export interface Interface {
	/** The project's automations, by name, each with how it stands. */
	readonly list: <P, J>(reach: ReachesProject<P, J>) => Effect.Effect<ListedAutomationDefinition[]>;
	/**
	 * The automations of a bot's default project, by name, as they are set up
	 * but not how they ran, for an admin who restricts the bot without
	 * reaching it.
	 */
	readonly listSetUp: <P, J>(
		canRestrict: CanRestrictBotsProject<P, J>,
	) => Effect.Effect<ListedAutomationDefinition[]>;
	/**
	 * Defines an automation in the project, as made by the member who manages
	 * it, and by the bot acting for them if one is, returning the secrets made
	 * for its webhook triggers.
	 */
	readonly create: <P, J>(
		canManage: CanManageProject<P, J>,
		input: NewAutomation,
	) => Effect.Effect<
		Defined,
		| AutomationNameTaken
		| InvalidRoutineSchedule
		| WebhookSecretTooShort
		| WebhookDeliveryIdHeaderRejected
		| AutomationRepositoryNotConnected
	>;
	/**
	 * Changes an automation's own settings. Pausing it stops its routines;
	 * enabling it again sets when each runs next from now.
	 */
	readonly update: <P, J>(
		canManage: CanManageProject<P, J>,
		automationId: string,
		input: AutomationUpdate,
	) => Effect.Effect<Defined, AutomationNotFound | AutomationNameTaken | InvalidRoutineSchedule>;
	/** Pauses an automation of a bot's default project, for an admin who restricts the bot. */
	readonly switchOff: <P, J>(
		canRestrict: CanRestrictBotsProject<P, J>,
		automationId: string,
	) => Effect.Effect<Defined, AutomationNotFound | AutomationNameTaken | InvalidRoutineSchedule>;
	readonly remove: <P, J>(
		canManage: CanManageProject<P, J>,
		automationId: string,
	) => Effect.Effect<void, AutomationNotFound>;
	/** Adds a trigger to an automation, returning a secret made for a webhook. */
	readonly addTrigger: <P, J>(
		canManage: CanManageProject<P, J>,
		automationId: string,
		input: AutomationTriggerInput,
	) => Effect.Effect<
		Defined,
		| AutomationNotFound
		| TooManyAutomationTriggers
		| InvalidRoutineSchedule
		| WebhookSecretTooShort
		| WebhookDeliveryIdHeaderRejected
		| AutomationRepositoryNotConnected
	>;
	/**
	 * Rewrites one of an automation's triggers, which keeps its kind. A webhook's
	 * secret is kept unless one is brought; one made for it is returned.
	 */
	readonly updateTrigger: <P, J>(
		canManage: CanManageProject<P, J>,
		trigger: OnTrigger,
		input: AutomationTriggerInput,
	) => Effect.Effect<
		Defined,
		| AutomationNotFound
		| AutomationTriggerNotFound
		| AutomationTriggerKindChanged
		| InvalidRoutineSchedule
		| WebhookSecretTooShort
		| WebhookDeliveryIdHeaderRejected
		| AutomationRepositoryNotConnected
	>;
	readonly removeTrigger: <P, J>(
		canManage: CanManageProject<P, J>,
		trigger: OnTrigger,
	) => Effect.Effect<Automation, AutomationNotFound | AutomationTriggerNotFound>;
	/** A webhook trigger's current secret. */
	readonly currentSecret: <P, J>(
		canManage: CanManageProject<P, J>,
		trigger: OnTrigger,
	) => Effect.Effect<
		AutomationCurrentSecret,
		AutomationNotFound | AutomationTriggerNotFound | AutomationTriggerRejected
	>;
	/**
	 * Replaces a webhook trigger's secret with `secret`, with a new one when
	 * it is absent, or with none when it is null, and returns it.
	 */
	readonly replaceSecret: <P, J>(
		canManage: CanManageProject<P, J>,
		trigger: OnTrigger,
		secret: string | null | undefined,
	) => Effect.Effect<
		string | null,
		| AutomationNotFound
		| AutomationTriggerNotFound
		| AutomationTriggerRejected
		| WebhookSecretTooShort
	>;
	/**
	 * Runs the automation now, for the member who may: opens its chat, posts
	 * the trigger, and queues the run. Asking again with the same `requestId`
	 * returns that run again, as a duplicate.
	 */
	readonly run: <P, J>(
		canRun: CanRunAutomations<P, J>,
		automationId: string,
		requestId: string,
	) => Effect.Effect<
		AcceptedRun,
		AutomationNotFound | AutomationTriggerConflict | AutomationTriggerRejected
	>;
	/**
	 * A page of the runs of every automation of the project, newest first,
	 * removed automations' included.
	 */
	readonly projectRuns: <P, J>(
		reach: ReachesProject<P, J>,
		page: RunPageQuery | undefined,
	) => Effect.Effect<RunPage, InvalidCursor>;
	/**
	 * Accepts the run a webhook call asks for. A trigger that is gone, or whose
	 * automation is paused or deleted, refuses it as a bad secret would.
	 */
	readonly acceptWebhook: <P, T>(
		calls: CallsWebhook<P, T>,
		delivery: Pick<Delivery, "headers" | "payload">,
	) => Effect.Effect<
		WebhookAnswer,
		| WebhookRefused
		| AutomationTriggerConflict
		| AutomationTriggerRejected
		| AutomationDeliveryIdTooLong
	>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ProjectAutomations",
) {
	declare readonly [Tier]: "process";
}

/** One of an automation's triggers, by the automation and its own id. */
export interface OnTrigger {
	readonly automationId: string;
	readonly triggerId: string;
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ProjectAutomations");
	const writes = yield* makeAutomationWrites;
	const acceptWebhook = yield* makeAcceptWebhook;

	return Service.of({
		list: (reach) =>
			operation(
				"list",
				automationsOf(
					{ workspaceId: reach.workspace, projectId: reach.project.value },
					{ withStatus: true },
				),
			),

		listSetUp: (canRestrict) =>
			operation(
				"listSetUp",
				automationsOf(
					{ workspaceId: canRestrict.workspace, projectId: canRestrict.project.value },
					{ withStatus: false },
				),
			),

		create: (canManage, input) =>
			operation(
				"create",
				writes.create(
					{ id: canManage.reach.project.value, workspaceId: canManage.reach.workspace },
					{
						createdById: canManage.member.actor.memberId,
						createdByBotId: canManage.reach.as.kind === "asker" ? canManage.reach.as.bot : null,
					},
					input,
				),
			),

		update: (canManage, automationId, input) =>
			operation("update", writes.update(scopeOf(canManage.reach, automationId), input)),

		switchOff: (canRestrict, automationId) =>
			operation(
				"switchOff",
				writes.update(
					{
						workspaceId: canRestrict.workspace,
						projectId: canRestrict.project.value,
						automationId,
					},
					{ state: "paused" },
				),
			),

		remove: (canManage, automationId) =>
			operation("remove", writes.remove(scopeOf(canManage.reach, automationId))),

		addTrigger: (canManage, automationId, input) =>
			operation("addTrigger", writes.addTrigger(scopeOf(canManage.reach, automationId), input)),

		updateTrigger: (canManage, trigger, input) =>
			operation(
				"updateTrigger",
				writes.updateTrigger(
					scopeOf(canManage.reach, trigger.automationId),
					trigger.triggerId,
					input,
				),
			),

		removeTrigger: (canManage, trigger) =>
			operation(
				"removeTrigger",
				writes.removeTrigger(scopeOf(canManage.reach, trigger.automationId), trigger.triggerId),
			),

		currentSecret: (canManage, trigger) =>
			operation(
				"currentSecret",
				writes.currentSecret(scopeOf(canManage.reach, trigger.automationId), trigger.triggerId),
			),

		replaceSecret: (canManage, trigger, secret) =>
			operation(
				"replaceSecret",
				writes.replaceSecret(
					scopeOf(canManage.reach, trigger.automationId),
					trigger.triggerId,
					secret,
				),
			),

		run: (canRun, automationId, requestId) =>
			operation(
				"run",
				writes.startManualRun(
					scopeOf(canRun.reach, automationId),
					canRun.member.actor.memberId,
					requestId,
				),
			),

		projectRuns: (reach, page) =>
			operation("projectRuns", projectRunsPage(reach.project.value, page)),

		acceptWebhook: (calls, delivery) =>
			operation("acceptWebhook", acceptWebhook(calls.trigger.value, delivery)),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

/**
 * Over the event outbox's `ChatEvents` and how runs' workflows are started
 * (`AutomationRuns`), which the chat services' composition provides.
 */
export const layer = layerNoDeps.pipe(Layer.provide([AutomationStore.layer, ChatStore.layer]));

/** The automation `automationId` of the project `reach` was proved for. */
function scopeOf<P, J>(reach: ReachesProject<P, J>, automationId: string): Scope {
	return { workspaceId: reach.workspace, projectId: reach.project.value, automationId };
}
