export * as ProjectAutomations from "./project-automations.ts";

import type {
	AcceptedRun,
	Automation,
	AutomationCurrentSecret,
	AutomationTriggerInput,
	AutomationUpdate,
	ListedAutomationDefinition,
	NewAutomation,
	RestrictableAutomation,
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
	TriggerSetInSettings,
	WebhookDeliveryIdHeaderRejected,
	WebhookRefused,
	WebhookSecretTooShort,
} from "@sugabots/contracts/errors/automations";
import type { InvalidCursor } from "@sugabots/contracts/errors/chat-reads";
import { ApprovalNeeded } from "@sugabots/contracts/errors/proofs";
import { Context, Effect, Layer } from "effect";
import { serviceOperations } from "../../database/database.ts";
import type { Approved } from "../../proofs/approved.ts";
import type { CallsWebhook } from "../../proofs/calls-webhook.ts";
import type { CanRestrictBotsProject } from "../../proofs/can-restrict-bot.ts";
import type { IsMember } from "../../proofs/is-member.ts";
import type {
	CanManageProject,
	CanReadProjectRuns,
	CanRunAutomations,
} from "../../proofs/project-permissions.ts";
import type { Named } from "../../proofs/proof.ts";
import type { ReachesAutomationTrigger } from "../../proofs/reaches-automation-trigger.ts";
import type { ReachesProject } from "../../proofs/reaches-project.ts";
import type {
	CanSwitchOffAutomation,
	ReachesProjectAutomation,
} from "../../proofs/reaches-project-automation.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { ChatStore } from "../store/store.ts";
import { type FenceRefusal, holdTurnOf } from "../turns/turns.ts";
import { findSoleRoutineId, type RoutineInput, type Scope } from "./automation.ts";
import { automationsOf, projectRunsPage, restrictableAutomations } from "./automation-view.ts";
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
	readonly list: <P, J, X>(
		reach: ReachesProject<P, J>,
		approved: Approved<P, X, [J], "automations.list" | "automations.listInChat">,
	) => Effect.Effect<ListedAutomationDefinition[]>;
	/**
	 * Names and states of the automations an admin may pause in a personal
	 * bot's default project.
	 */
	readonly listSetUp: <P, J>(
		canRestrict: CanRestrictBotsProject<P, J>,
	) => Effect.Effect<RestrictableAutomation[]>;
	/**
	 * Defines an automation in the project, as made by the member who manages
	 * it, and by the bot acting for them if one is, returning the secrets made
	 * for its webhook triggers.
	 */
	readonly create: <P, J>(
		canManage: CanManageProject<P, J>,
		member: IsMember<P>,
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
	 * Makes the automation `approved.input` describes, with its routine on the
	 * project's time zone, `timeZone`, which the server reads, not the caller.
	 */
	readonly createWithRoutine: <P, J, X>(
		canManage: CanManageProject<P, J>,
		approved: Approved<P, X, [J], "automations.createWithRoutine">,
		timeZone: string,
	) => Effect.Effect<Automation, AutomationNameTaken | InvalidRoutineSchedule | FenceRefusal>;
	/**
	 * Changes an automation's own settings. Pausing it stops its routines;
	 * enabling it again sets when each runs next from now.
	 */
	readonly update: <P, J, A>(
		canManage: CanManageProject<P, J>,
		automation: Named<A, string>,
		target: ReachesProjectAutomation<P, J, A>,
		member: IsMember<P>,
		input: AutomationUpdate,
	) => Effect.Effect<Defined, AutomationNotFound | AutomationNameTaken | InvalidRoutineSchedule>;
	readonly findSoleRoutineId: <P, J, A>(
		target: ReachesProjectAutomation<P, J, A>,
	) => Effect.Effect<string | null, TriggerSetInSettings>;
	/**
	 * Changes the automation as `approved.input` says, a new routine on the
	 * project's time zone, `timeZone`, which the server reads, not the caller.
	 */
	readonly updateInChat: <P, J, A, X>(
		canManage: CanManageProject<P, J>,
		automation: Named<A, string>,
		target: ReachesProjectAutomation<P, J, A>,
		approved: Approved<P, X, [J, A], "automations.updateInChat">,
		timeZone: string,
	) => Effect.Effect<
		Automation,
		| ApprovalNeeded
		| AutomationNotFound
		| AutomationNameTaken
		| InvalidRoutineSchedule
		| TriggerSetInSettings
		| FenceRefusal
	>;
	/** Pauses an automation of a bot's default project, for an admin who restricts the bot. */
	readonly switchOff: <P, J, A>(
		canRestrict: CanRestrictBotsProject<P, J>,
		automation: Named<A, string>,
		target: CanSwitchOffAutomation<P, J, A>,
	) => Effect.Effect<
		{ automation: RestrictableAutomation; secrets: readonly [] },
		AutomationNotFound | AutomationNameTaken | InvalidRoutineSchedule
	>;
	readonly remove: <P, J, A>(
		canManage: CanManageProject<P, J>,
		automation: Named<A, string>,
		target: ReachesProjectAutomation<P, J, A>,
	) => Effect.Effect<void, AutomationNotFound>;
	/** Adds a trigger to an automation, returning a secret made for a webhook. */
	readonly addTrigger: <P, J, A>(
		canManage: CanManageProject<P, J>,
		automation: Named<A, string>,
		target: ReachesProjectAutomation<P, J, A>,
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
	readonly updateTrigger: <P, J, A, T>(
		canManage: CanManageProject<P, J>,
		trigger: Named<T, string>,
		target: ReachesAutomationTrigger<P, J, A, T>,
		input: AutomationTriggerInput,
	) => Effect.Effect<
		Defined,
		| AutomationNotFound
		| AutomationTriggerNotFound
		| AutomationTriggerKindChanged
		| AutomationTriggerRejected
		| InvalidRoutineSchedule
		| WebhookSecretTooShort
		| WebhookDeliveryIdHeaderRejected
		| AutomationRepositoryNotConnected
	>;
	readonly removeTrigger: <P, J, A, T>(
		canManage: CanManageProject<P, J>,
		trigger: Named<T, string>,
		target: ReachesAutomationTrigger<P, J, A, T>,
	) => Effect.Effect<Automation, AutomationNotFound | AutomationTriggerNotFound>;
	/** A webhook trigger's current secret. */
	readonly currentSecret: <P, J, A, T>(
		canManage: CanManageProject<P, J>,
		trigger: Named<T, string>,
		target: ReachesAutomationTrigger<P, J, A, T>,
	) => Effect.Effect<
		AutomationCurrentSecret,
		AutomationNotFound | AutomationTriggerNotFound | AutomationTriggerRejected
	>;
	/**
	 * Replaces a webhook trigger's secret with `secret`, with a new one when
	 * it is absent, or with none when it is null, and returns it.
	 */
	readonly replaceSecret: <P, J, A, T>(
		canManage: CanManageProject<P, J>,
		trigger: Named<T, string>,
		target: ReachesAutomationTrigger<P, J, A, T>,
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
	readonly run: <P, J, A>(
		canRun: CanRunAutomations<P, J>,
		automation: Named<A, string>,
		target: ReachesProjectAutomation<P, J, A>,
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
		canReadRuns: CanReadProjectRuns<P, J>,
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

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ProjectAutomations");
	const writes = yield* makeAutomationWrites;
	const acceptWebhook = yield* makeAcceptWebhook;

	return Service.of({
		list: (reach) =>
			operation(
				"list",
				automationsOf({ workspaceId: reach.workspace, projectId: reach.project.value }),
			),

		listSetUp: (canRestrict) =>
			operation(
				"listSetUp",
				restrictableAutomations({
					workspaceId: canRestrict.workspace,
					projectId: canRestrict.project.value,
				}),
			),

		create: (canManage, member, input) =>
			operation(
				"create",
				writes.create(
					projectOf(canManage.reach),
					{ createdById: member.member, createdByBotId: null },
					input,
					Effect.void,
				),
			),

		createWithRoutine: (canManage, approved, timeZone) => {
			const { name, instructions, routineExpression } = approved.input;
			return operation(
				"createWithRoutine",
				writes.createWithRoutine(
					projectOf(canManage.reach),
					{
						createdById: canManage.member.actor.memberId,
						createdByBotId: canManage.reach.as.kind === "asker" ? canManage.reach.as.bot : null,
					},
					{ name, instructions },
					cronRoutine(routineExpression, timeZone),
					holdTurnOf(approved.principal.value),
				),
			);
		},

		update: (_canManage, automation, target, _member, input) =>
			operation("update", writes.update(scopeOf(target, automation.value), input, Effect.void)),

		findSoleRoutineId: (target) =>
			operation("findSoleRoutineId", findSoleRoutineId(target.automation.value)),

		updateInChat: (_canManage, automation, target, approved, timeZone) => {
			const { name, instructions, paused, routineExpression } = approved.input;
			const input: AutomationUpdate = {
				name,
				instructions,
				state: paused === undefined ? undefined : paused ? "paused" : "enabled",
			};
			const scope = scopeOf(target, automation.value);
			const fence = holdTurnOf(approved.principal.value);
			return operation(
				"updateInChat",
				Effect.gen(function* () {
					if (routineExpression === undefined) {
						return (yield* writes.update(scope, input, fence)).automation;
					}
					const approvedRoutineId = approved.resolvedTargets?.automationRoutineId;
					if (approvedRoutineId === undefined) return yield* new ApprovalNeeded();
					const routine = cronRoutine(routineExpression, timeZone);
					return (yield* writes.updateWithSoleRoutine(
						scope,
						input,
						routine,
						approvedRoutineId,
						fence,
					)).automation;
				}),
			);
		},

		switchOff: (_canRestrict, automation, target) =>
			operation(
				"switchOff",
				writes.update(scopeOf(target, automation.value), { state: "paused" }, Effect.void).pipe(
					Effect.map(({ automation: { id, name, state } }) => ({
						automation: { id, name, state, restricted: true as const },
						secrets: [] as const,
					})),
				),
			),

		remove: (_canManage, automation, target) =>
			operation("remove", writes.remove(scopeOf(target, automation.value))),

		addTrigger: (_canManage, automation, target, input) =>
			operation("addTrigger", writes.addTrigger(scopeOf(target, automation.value), input)),

		updateTrigger: (_canManage, trigger, target, input) =>
			operation(
				"updateTrigger",
				writes.updateTrigger(scopeOf(target, target.automation.value), trigger.value, input),
			),

		removeTrigger: (_canManage, trigger, target) =>
			operation(
				"removeTrigger",
				writes.removeTrigger(scopeOf(target, target.automation.value), trigger.value),
			),

		currentSecret: (_canManage, trigger, target) =>
			operation(
				"currentSecret",
				writes.currentSecret(scopeOf(target, target.automation.value), trigger.value),
			),

		replaceSecret: (_canManage, trigger, target, secret) =>
			operation(
				"replaceSecret",
				writes.replaceSecret(scopeOf(target, target.automation.value), trigger.value, secret),
			),

		run: (canRun, automation, target, requestId) =>
			operation(
				"run",
				writes.startManualRun(
					scopeOf(target, automation.value),
					canRun.member.actor.memberId,
					requestId,
					canRun.mayResumeAfterFailures,
				),
			),

		projectRuns: ({ reach }, page) =>
			operation("projectRuns", projectRunsPage(reach.workspace, reach.project.value, page)),

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
function scopeOf<J>(
	reach: { workspace: string; project: Named<J, string> },
	automationId: string,
): Scope {
	return { workspaceId: reach.workspace, projectId: reach.project.value, automationId };
}

function projectOf<J>(reach: { workspace: string; project: Named<J, string> }) {
	return { id: reach.project.value, workspaceId: reach.workspace };
}

/** A routine on the cron `expression`, in the time zone `timezone`. */
function cronRoutine(expression: string, timezone: string): RoutineInput {
	return { kind: "routine", schedule: { repeat: "cron", expression }, timezone };
}
