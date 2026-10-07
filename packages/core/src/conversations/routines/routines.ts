export * as Routines from "./routines.ts";

import type {
	AcceptedRoutineExecution,
	NewRoutine,
	Routine,
	RoutineExecutionPage,
	RoutineExecutionPageQuery,
	RoutineExecutionTrigger,
	RoutineUpdate,
	WorkspaceRoutine,
} from "@sugabots/contracts";
import { Context, DateTime, Effect, Layer, type Redacted } from "effect";
import type { AuthorizationDenied } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import type { CurrentActor } from "../../authorization/current-actor.ts";
import { Visibility } from "../../authorization/visibility.ts";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { routine } from "../../database/schema.ts";
import { ThreadRepository } from "../threads/repository.ts";
import { lockTriggers, makeAcceptTrigger } from "./acceptance.ts";
import { RoutineRepository } from "./repository.ts";
import {
	inScope,
	type OnAgent,
	RoutineNotFound,
	type RoutineTriggerConflict,
	RoutineTriggerRejected,
	scopeOf,
	toRoutine,
} from "./routine.ts";
import { type InvalidRoutineExecutionCursor, makeView } from "./routine-view.ts";
import { generateSecret, hashSecret, makeWebhooks } from "./routine-webhooks.ts";
import { type InvalidRoutineSchedule, nextOccurrence, upcomingOccurrences } from "./schedule.ts";

/**
 * The routines people define on a crew agent, and running one when asked,
 * as the current actor with the permission its agent's pod gives them. Each
 * run is in its own thread in the agent's chat.
 *
 * Runs nobody asks for, on a webhook or a schedule, are `Webhooks` and the
 * scheduler; a run is started by its workflow, one at a time per
 * routine, and ended by `RoutineSettlement`.
 */
export interface Interface {
	/**
	 * Defines a routine on a crew agent, as made by the actor or, with
	 * `madeByAgent`, by the agent at the actor's request. A webhook routine's
	 * secret is returned once, here, and never again.
	 */
	readonly create: (
		owner: { agentId: string; madeByAgent?: boolean },
		input: NewRoutine,
	) => Effect.Effect<
		Defined,
		AuthorizationDenied | RoutineRepository.RoutineNameTaken | InvalidRoutineSchedule,
		CurrentActor.Service
	>;
	/** Changes a routine. Switching it to a webhook returns its new secret. */
	readonly update: (
		routine: OnAgent,
		input: RoutineUpdate,
	) => Effect.Effect<
		Defined,
		| AuthorizationDenied
		| RoutineNotFound
		| RoutineRepository.RoutineNameTaken
		| InvalidRoutineSchedule,
		CurrentActor.Service
	>;
	readonly remove: (
		routine: OnAgent,
	) => Effect.Effect<void, AuthorizationDenied | RoutineNotFound, CurrentActor.Service>;
	/** A new secret for a webhook routine, replacing the old one. */
	readonly rotateSecret: (
		routine: OnAgent,
	) => Effect.Effect<
		string,
		AuthorizationDenied | RoutineNotFound | RoutineTriggerRejected,
		CurrentActor.Service
	>;
	/**
	 * When a schedule would run next, for somebody choosing one for the
	 * agent's routines.
	 */
	readonly previewSchedule: (input: {
		agentId: string;
		expression: string;
		timezone: string;
	}) => Effect.Effect<Date[], AuthorizationDenied | InvalidRoutineSchedule, CurrentActor.Service>;
	/**
	 * Runs the routine now, for the actor: opens its thread, posts the
	 * trigger, and queues the run. Asking again with the same `requestId`
	 * returns that run again, as a duplicate.
	 */
	readonly run: (
		routine: OnAgent & { requestId: string },
	) => Effect.Effect<
		AcceptedRoutineExecution,
		AuthorizationDenied | RoutineNotFound | RoutineTriggerConflict | RoutineTriggerRejected,
		CurrentActor.Service
	>;
	/**
	 * Every routine on a crew agent in a pod the actor reaches, in a workspace
	 * named by its id or its slug, by name, with its agent and pod.
	 */
	readonly listInWorkspace: (
		workspace: string,
	) => Effect.Effect<WorkspaceRoutine[], AuthorizationDenied, CurrentActor.Service>;
	/** The agent's routines, by name. */
	readonly list: (owner: {
		agentId: string;
	}) => Effect.Effect<Routine[], AuthorizationDenied, CurrentActor.Service>;
	readonly get: (
		routine: OnAgent,
	) => Effect.Effect<Routine, AuthorizationDenied | RoutineNotFound, CurrentActor.Service>;
	/**
	 * A page of the routine's runs, newest first. A removed routine keeps its
	 * history, so this finds it as long as it was ever defined.
	 */
	readonly listExecutions: (
		routine: OnAgent,
		page?: RoutineExecutionPageQuery,
	) => Effect.Effect<
		RoutineExecutionPage,
		AuthorizationDenied | RoutineNotFound | InvalidRoutineExecutionCursor,
		CurrentActor.Service
	>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Routines") {}

/**
 * Runs a webhook routine's caller asks for. Nobody signs in to call one: the
 * secret the routine was given is what admits the run, so this asks for no
 * actor, and is the one routine operation a route calls without one.
 */
export interface WebhooksInterface {
	/**
	 * Accepts a webhook's run, if `secret` is the routine's. `undefined` when
	 * it is not, or there is no such enabled webhook routine: the caller is
	 * told the same either way.
	 */
	readonly accept: (delivery: {
		routineId: string;
		secret: Redacted.Redacted<string>;
		trigger: Extract<RoutineExecutionTrigger, { kind: "webhook" }>;
	}) => Effect.Effect<
		AcceptedRoutineExecution | undefined,
		RoutineTriggerConflict | RoutineTriggerRejected
	>;
}

export class Webhooks extends Context.Service<Webhooks, WebhooksInterface>()(
	"@sugabots/core/Routines/Webhooks",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Routines");
	const authorization = yield* Authorization.Service;
	const repository = yield* RoutineRepository.Service;
	const acceptTrigger = yield* makeAcceptTrigger;
	const view = yield* makeView;

	return Service.of({
		...view,
		create: ({ agentId, madeByAgent = false }, input) =>
			operation(
				"create",
				Effect.gen(function* () {
					const { agent: owner, actor } = yield* authorization.agent(agentId, "routine.manage");
					const state = input.state ?? "enabled";
					const schedule =
						input.trigger.kind === "cron" && state === "enabled"
							? yield* nextOccurrence(
									input.trigger.expression,
									input.trigger.timezone,
									yield* DateTime.nowAsDate,
								)
							: null;
					const secret = input.trigger.kind === "webhook" ? generateSecret() : null;
					const digest = secret ? yield* hashSecret(secret) : null;
					const row = yield* repository.create({
						workspaceId: owner.workspaceId,
						agentId: owner.id,
						createdById: actor.userId,
						createdByAgentId: madeByAgent ? owner.id : null,
						name: input.name,
						instructions: input.instructions,
						triggerKind: input.trigger.kind,
						cronExpression: input.trigger.kind === "cron" ? input.trigger.expression : null,
						cronTimezone: input.trigger.kind === "cron" ? input.trigger.timezone : null,
						nextScheduledAt: schedule,
						webhookSecretDigest: digest,
						state,
						results: input.results ?? "keep_in_run",
					});
					return { routine: toRoutine(row), secret };
				}),
			),

		update: (addressed, input) =>
			operation(
				"update",
				transaction(
					Effect.gen(function* () {
						const scope = yield* scopeOf(authorization, addressed, "routine.manage");
						// Held until the change is written, so an edit made meanwhile, or a
						// secret replaced meanwhile, is read here rather than written over.
						yield* lockTriggers(scope.routineId);
						const [current] = yield* query((db) =>
							db.select().from(routine).where(inScope(scope)).limit(1).for("update"),
						);
						if (!current) return yield* new RoutineNotFound();
						const trigger = input.trigger ?? toRoutine(current).trigger;
						const state = input.state ?? current.state;
						const scheduleChanged = input.trigger?.kind === "cron";
						const reenabled = input.state === "enabled" && current.state === "paused";
						const schedule =
							trigger.kind !== "cron" || state === "paused"
								? null
								: scheduleChanged || reenabled
									? yield* nextOccurrence(
											trigger.expression,
											trigger.timezone,
											yield* DateTime.nowAsDate,
										)
									: current.nextScheduledAt;
						const switchedToWebhook =
							input.trigger?.kind === "webhook" && current.triggerKind !== "webhook";
						const secret = switchedToWebhook ? generateSecret() : null;
						const row = yield* repository.update(scope, {
							name: input.name ?? current.name,
							instructions: input.instructions ?? current.instructions,
							state,
							results: input.results ?? current.results,
							triggerKind: trigger.kind,
							cronExpression: trigger.kind === "cron" ? trigger.expression : null,
							cronTimezone: trigger.kind === "cron" ? trigger.timezone : null,
							nextScheduledAt: schedule,
							webhookSecretDigest:
								trigger.kind !== "webhook"
									? null
									: secret
										? yield* hashSecret(secret)
										: current.webhookSecretDigest,
						});
						if (!row) return yield* new RoutineNotFound();
						return { routine: toRoutine(row), secret };
					}),
				),
			),

		remove: (addressed) =>
			operation(
				"remove",
				transaction(
					Effect.gen(function* () {
						const scope = yield* scopeOf(authorization, addressed, "routine.manage");
						yield* lockTriggers(scope.routineId);
						if (!(yield* repository.remove(scope))) return yield* new RoutineNotFound();
					}),
				),
			),

		rotateSecret: (addressed) =>
			operation(
				"rotateSecret",
				transaction(
					Effect.gen(function* () {
						const scope = yield* scopeOf(authorization, addressed, "routine.manage");
						const secret = generateSecret();
						const digest = yield* hashSecret(secret);
						yield* lockTriggers(scope.routineId);
						if (yield* repository.replaceWebhookSecret(scope, digest)) return secret;
						const [exists] = yield* query((db) =>
							db.select({ id: routine.id }).from(routine).where(inScope(scope)),
						);
						if (!exists) return yield* new RoutineNotFound();
						return yield* new RoutineTriggerRejected();
					}),
				),
			),

		previewSchedule: ({ agentId, expression, timezone }) =>
			operation(
				"previewSchedule",
				Effect.andThen(
					authorization.agent(agentId, "routine.manage"),
					Effect.flatMap(DateTime.nowAsDate, (now) =>
						upcomingOccurrences(expression, timezone, now),
					),
				),
			),

		run: ({ agentId, routineId, requestId }) =>
			operation(
				"run",
				Effect.gen(function* () {
					const { agent: owner, actor } = yield* authorization.agent(agentId, "routine.run");
					return yield* acceptTrigger({
						workspaceId: owner.workspaceId,
						agentId: owner.id,
						routineId,
						triggerIdentity: requestId,
						trigger: {
							kind: "manual",
							requestId,
							requestedAt: DateTime.formatIso(yield* DateTime.now),
							requestedByUserId: actor.userId,
						},
					});
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([
		Authorization.layer,
		Visibility.layer,
		RoutineRepository.layer,
		ThreadRepository.layer,
	]),
);

export const webhooksLayer = Layer.effect(Webhooks, makeWebhooks).pipe(
	Layer.provide([RoutineRepository.layer, ThreadRepository.layer]),
);

export { routineExecutionIdOf, toRoutineExecution } from "./execution.ts";
export { InvalidRoutineExecutionCursor } from "./routine-view.ts";
/** Accepts the runs of cron routines as they fall due. */
export { layer as schedulerLayer } from "./scheduler.ts";
/** The routine workflow's steps. */
export { routineStepsLayer as stepsLayer } from "./steps.ts";

/** A routine as defined, with the webhook secret made for it, if one was. */
export interface Defined {
	routine: Routine;
	secret: string | null;
}
